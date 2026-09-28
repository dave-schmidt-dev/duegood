//! Private content-addressed storage for validated browser-capture file bodies.
//!
//! These bytes remain source-unverified. Promotion verifies bounded size, SHA-256, and the
//! existing MIME-prefix policy; it does not establish Canvas provenance or open files.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::browser_bundle::ValidatedCaptureBundle;
use crate::browser_resources_io::{
    self as resource_io, ensure_private_child, is_hash, ARCHIVE_NAME, BLOBS_NAME,
};
use serde_json::Value;

#[path = "browser_legacy_resources.rs"]
pub mod legacy;

#[cfg(test)]
use crate::browser_resources_io::CHUNK_BYTES;

const MAX_BLOB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CAPTURE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024 * 1024;

/// Content-free resource archive errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceArchiveError {
    InvalidBundle,
    UnsafeDirectory,
    UnsafeFile,
    MissingSource,
    InvalidReceipt,
    BlobTooLarge,
    CaptureTooLarge,
    ArchiveLimitExceeded,
    BlobMismatch,
    UnsupportedMedia,
    Io,
}

/// Counts returned after every referenced body was verified and promoted or reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromotionResult {
    pub promoted_blobs: u64,
    pub reused_blobs: u64,
    pub bytes_verified: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BlobRef {
    pub(super) file_id: u64,
    pub(super) byte_count: u64,
    pub(super) sha256: String,
    pub(super) content_type: String,
}

#[derive(Clone, Copy)]
struct Limits {
    per_blob: u64,
    per_capture: u64,
    archive: u64,
}

const LIMITS: Limits = Limits {
    per_blob: MAX_BLOB_BYTES,
    per_capture: MAX_CAPTURE_BYTES,
    archive: MAX_ARCHIVE_BYTES,
};

/// Verifies and copies every archived file body into the native private resource archive.
///
/// Progress reports cumulative verified bytes and the bounded total. The caller holds the shared
/// capture guard for the full operation; this function does not provide a second-writer lock.
pub fn promote_capture_blobs<F>(
    data_root: &Path,
    bundle: &ValidatedCaptureBundle,
    mut progress: F,
) -> Result<PromotionResult, ResourceArchiveError>
where
    F: FnMut(u64, u64),
{
    promote_with_limits(data_root, bundle, &mut progress, LIMITS)
}

fn promote_with_limits<F>(
    data_root: &Path,
    bundle: &ValidatedCaptureBundle,
    progress: &mut F,
    limits: Limits,
) -> Result<PromotionResult, ResourceArchiveError>
where
    F: FnMut(u64, u64),
{
    let refs = validated_blob_refs(bundle, limits)?;
    let unique_refs = unique_blob_refs(&refs)?;
    let total = unique_refs
        .iter()
        .try_fold(0_u64, |sum, (reference, _)| {
            sum.checked_add(reference.byte_count)
        })
        .ok_or(ResourceArchiveError::CaptureTooLarge)?;
    let data_identity = resource_io::verify_private_directory(data_root)?;
    let archive = ensure_private_child(data_root, ARCHIVE_NAME)?;
    let archive_identity = resource_io::verify_private_directory(&archive)?;
    let blobs = ensure_private_child(&archive, BLOBS_NAME)?;
    let blobs_identity = resource_io::verify_private_directory(&blobs)?;
    resource_io::verify_directory_identity(data_root, data_identity)?;

    let existing = resource_io::inventory_blobs(&blobs, limits.per_blob)?;
    let existing_bytes = existing
        .values()
        .try_fold(0_u64, |sum, size| sum.checked_add(*size))
        .ok_or(ResourceArchiveError::ArchiveLimitExceeded)?;
    let required_new = unique_refs
        .iter()
        .filter(|(reference, _)| !existing.contains_key(&reference.sha256))
        .try_fold(0_u64, |sum, (reference, _)| {
            sum.checked_add(reference.byte_count)
        })
        .ok_or(ResourceArchiveError::ArchiveLimitExceeded)?;
    if existing_bytes
        .checked_add(required_new)
        .is_none_or(|size| size > limits.archive)
    {
        return Err(ResourceArchiveError::ArchiveLimitExceeded);
    }

    let source_directory = resource_io::verify_private_directory(&bundle.blob_directory)?;
    let mut result = PromotionResult {
        promoted_blobs: 0,
        reused_blobs: 0,
        bytes_verified: 0,
    };
    for (reference, content_types) in unique_refs {
        resource_io::verify_directory_identity(&bundle.blob_directory, source_directory)?;
        resource_io::verify_directory_identity(data_root, data_identity)?;
        resource_io::verify_directory_identity(&archive, archive_identity)?;
        resource_io::verify_directory_identity(&blobs, blobs_identity)?;
        let destination = blobs.join(&reference.sha256);
        if existing.contains_key(&reference.sha256) {
            resource_io::verify_blob_file(
                &destination,
                &reference.sha256,
                reference.byte_count,
                &content_types,
                limits.per_blob,
                result.bytes_verified,
                total,
                progress,
            )?;
            result.reused_blobs += 1;
        } else {
            let source = bundle
                .blob_directory
                .join(format!("{}.blob", reference.sha256));
            resource_io::copy_verified_blob(
                &source,
                &bundle.blob_directory,
                source_directory,
                &blobs,
                blobs_identity,
                &destination,
                &reference,
                &content_types,
                limits.per_blob,
                result.bytes_verified,
                total,
                progress,
            )?;
            result.promoted_blobs += 1;
        }
        result.bytes_verified = result
            .bytes_verified
            .checked_add(reference.byte_count)
            .ok_or(ResourceArchiveError::CaptureTooLarge)?;
    }
    resource_io::sync_directory(&blobs)?;
    Ok(result)
}

/// Resolves one native content hash only after rechecking ownership, size, bytes, and MIME prefix.
pub fn verified_blob(
    data_root: &Path,
    sha256: &str,
    expected_size: u64,
    content_type: &str,
) -> Result<PathBuf, ResourceArchiveError> {
    if !is_hash(sha256) || expected_size == 0 || expected_size > MAX_BLOB_BYTES {
        return Err(ResourceArchiveError::InvalidReceipt);
    }
    let data_identity = resource_io::verify_private_directory(data_root)?;
    let archive = data_root.join(ARCHIVE_NAME);
    let archive_identity = resource_io::verify_private_directory(&archive)?;
    let blobs = archive.join(BLOBS_NAME);
    let blobs_identity = resource_io::verify_private_directory(&blobs)?;
    let path = blobs.join(sha256);
    resource_io::verify_blob_file(
        &path,
        sha256,
        expected_size,
        &[content_type.to_owned()],
        MAX_BLOB_BYTES,
        0,
        expected_size,
        &mut |_, _| {},
    )?;
    resource_io::verify_directory_identity(data_root, data_identity)?;
    resource_io::verify_directory_identity(&archive, archive_identity)?;
    resource_io::verify_directory_identity(&blobs, blobs_identity)?;
    Ok(path)
}

fn validated_blob_refs(
    bundle: &ValidatedCaptureBundle,
    limits: Limits,
) -> Result<Vec<BlobRef>, ResourceArchiveError> {
    let manifest = bundle
        .manifest
        .get("blobs")
        .and_then(Value::as_array)
        .ok_or(ResourceArchiveError::InvalidBundle)?;
    let mut resources_by_id = BTreeMap::new();
    let resource_list = bundle
        .snapshot
        .get("resources")
        .and_then(Value::as_array)
        .ok_or(ResourceArchiveError::InvalidBundle)?;
    for resource in resource_list {
        if resource.get("endpoint").and_then(Value::as_str) != Some("fileBodies") {
            continue;
        }
        let items = resource
            .get("items")
            .and_then(Value::as_array)
            .ok_or(ResourceArchiveError::InvalidBundle)?;
        for item in items {
            if item.get("status").and_then(Value::as_str) != Some("archived") {
                continue;
            }
            let reference = parse_snapshot_ref(item, limits)?;
            if resources_by_id
                .insert(reference.file_id, reference)
                .is_some()
            {
                return Err(ResourceArchiveError::InvalidBundle);
            }
        }
    }

    let mut refs = Vec::with_capacity(manifest.len());
    let mut manifest_ids = BTreeSet::new();
    for value in manifest {
        let reference = parse_manifest_ref(value, limits)?;
        if !manifest_ids.insert(reference.file_id) {
            return Err(ResourceArchiveError::InvalidBundle);
        }
        let snapshot_ref = resources_by_id
            .remove(&reference.file_id)
            .ok_or(ResourceArchiveError::InvalidBundle)?;
        if snapshot_ref.byte_count != reference.byte_count
            || snapshot_ref.sha256 != reference.sha256
            || snapshot_ref.content_type != reference.content_type
        {
            return Err(ResourceArchiveError::InvalidBundle);
        }
        refs.push(reference);
    }
    if !resources_by_id.is_empty() {
        return Err(ResourceArchiveError::InvalidBundle);
    }
    let declared_total = refs.iter().try_fold(0_u64, |sum, reference| {
        sum.checked_add(reference.byte_count)
    });
    if declared_total.is_none_or(|total| total > limits.per_capture) {
        return Err(ResourceArchiveError::CaptureTooLarge);
    }
    Ok(refs)
}

fn parse_snapshot_ref(value: &Value, limits: Limits) -> Result<BlobRef, ResourceArchiveError> {
    if value.get("sourceAuthenticity").and_then(Value::as_str) != Some("unverified") {
        return Err(ResourceArchiveError::InvalidReceipt);
    }
    parse_ref_fields(value, limits, false)
}

fn parse_manifest_ref(value: &Value, limits: Limits) -> Result<BlobRef, ResourceArchiveError> {
    if value.get("sourceAuthenticity").and_then(Value::as_str) != Some("unverified") {
        return Err(ResourceArchiveError::InvalidReceipt);
    }
    parse_ref_fields(value, limits, true)
}

fn parse_ref_fields(
    value: &Value,
    limits: Limits,
    require_mime: bool,
) -> Result<BlobRef, ResourceArchiveError> {
    let file_id = value
        .get("fileId")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or(ResourceArchiveError::InvalidReceipt)?;
    let byte_count = value
        .get("byteCount")
        .and_then(Value::as_u64)
        .filter(|count| *count > 0)
        .ok_or(ResourceArchiveError::InvalidReceipt)?;
    if byte_count > limits.per_blob {
        return Err(ResourceArchiveError::BlobTooLarge);
    }
    let sha256 = value
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|hash| is_hash(hash))
        .ok_or(ResourceArchiveError::InvalidReceipt)?
        .to_owned();
    let content_type = value
        .get("contentType")
        .and_then(Value::as_str)
        .filter(|mime| !mime.is_empty() && mime.len() <= 128)
        .or_else(|| (!require_mime).then_some("application/octet-stream"))
        .ok_or(ResourceArchiveError::InvalidReceipt)?
        .to_owned();
    Ok(BlobRef {
        file_id,
        byte_count,
        sha256,
        content_type,
    })
}

fn unique_blob_refs(refs: &[BlobRef]) -> Result<Vec<(BlobRef, Vec<String>)>, ResourceArchiveError> {
    let mut by_hash: BTreeMap<String, (BlobRef, BTreeSet<String>)> = BTreeMap::new();
    for reference in refs {
        match by_hash.get_mut(&reference.sha256) {
            Some((prior, content_types)) => {
                if prior.byte_count != reference.byte_count {
                    return Err(ResourceArchiveError::InvalidBundle);
                }
                content_types.insert(reference.content_type.clone());
            }
            None => {
                let mut content_types = BTreeSet::new();
                content_types.insert(reference.content_type.clone());
                by_hash.insert(reference.sha256.clone(), (reference.clone(), content_types));
            }
        }
    }
    Ok(by_hash
        .into_values()
        .map(|(reference, content_types)| (reference, content_types.into_iter().collect()))
        .collect())
}

#[cfg(test)]
#[path = "browser_resources_tests.rs"]
mod tests;
