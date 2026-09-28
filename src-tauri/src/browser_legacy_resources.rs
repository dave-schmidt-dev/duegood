//! Private, opt-in migration of pre-browser-import Canvas material bytes.
//!
//! This module is registered as `browser_resources::legacy`. Callers must already hold the
//! capture lease, snapshot lock, and store write lock in that order. It never acquires native
//! locks or changes the store tree; callers publish `document` with their staged generation and
//! remove only returned `removable_material_paths` from that copied stage.

#[cfg(test)]
#[path = "browser_legacy_resources_tests.rs"]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[path = "browser_legacy_resources_io.rs"]
mod legacy_io;

use super::{BlobRef, ResourceArchiveError};
use crate::browser_resources_io as resource_io;
use crate::store::{node_json_bytes, Store};

pub const LEGACY_RESOURCE_ARCHIVE_DOCUMENT: &str = "browser-legacy-resource-archive.json";
const LEGACY_ARCHIVE_FORMAT: &str = "duegood-browser-legacy-resources";
const LEGACY_ARCHIVE_VERSION: u64 = 1;
const MAX_JSON_BYTES: u64 = 32 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES: usize = 20_000;
const MAX_COURSES: usize = 500;
const MAX_BLOB_BYTES: u64 = super::MAX_BLOB_BYTES;
const MAX_CAPTURE_BYTES: u64 = super::MAX_CAPTURE_BYTES;
const GAP_MISSING: &str = "missing";
const GAP_UNSAFE: &str = "unsafe";
const GAP_SIZE: &str = "size_mismatch";
const GAP_LIMIT: &str = "size_limit";
const GAP_UNSUPPORTED: &str = "unsupported_media";

/// Fixed, content-free failures for legacy material migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyResourceError {
    InvalidStore,
    InvalidCoursework,
    InvalidManifest,
    InvalidArchive,
    UnsafeDirectory,
    UnsafeFile,
    SourceChanged,
    ResourceArchive(ResourceArchiveError),
    LimitExceeded,
    ConflictingReference,
    Cancelled,
    Io,
}

impl LegacyResourceError {
    /// Returns a stable code without paths, Canvas metadata, or file contents.
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidStore => "LEGACY_STORE_INVALID",
            Self::InvalidCoursework => "LEGACY_COURSEWORK_INVALID",
            Self::InvalidManifest => "LEGACY_DOWNLOAD_MANIFEST_INVALID",
            Self::InvalidArchive => "LEGACY_RESOURCE_ARCHIVE_INVALID",
            Self::UnsafeDirectory => "LEGACY_RESOURCE_DIRECTORY_UNSAFE",
            Self::UnsafeFile => "LEGACY_RESOURCE_FILE_UNSAFE",
            Self::SourceChanged => "LEGACY_RESOURCE_CHANGED",
            Self::ResourceArchive(_) => "LEGACY_RESOURCE_ARCHIVE_FAILED",
            Self::LimitExceeded => "LEGACY_RESOURCE_LIMIT_EXCEEDED",
            Self::ConflictingReference => "LEGACY_RESOURCE_REFERENCE_CONFLICT",
            Self::Cancelled => "LEGACY_RESOURCE_MIGRATION_CANCELLED",
            Self::Io => "LEGACY_RESOURCE_IO_FAILED",
        }
    }
}

impl std::fmt::Display for LegacyResourceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for LegacyResourceError {}

/// One publish-ready legacy inventory plus paths safe to remove from the staged store copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyMigration {
    pub document: Vec<u8>,
    pub removable_material_paths: Vec<PathBuf>,
    pub migrated_files: u64,
    pub reused_blobs: u64,
    pub gap_files: u64,
    pub bytes_verified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyArchiveDocument {
    format: String,
    version: u64,
    files: Vec<LegacyReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyReference {
    course_key: String,
    file_id: u64,
    status: LegacyStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    byte_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    source: String,
    source_authenticity: String,
    observed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gap_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LegacyStatus {
    Saved,
    Gap,
}

#[derive(Clone)]
struct PendingFile {
    course_key: String,
    file_id: u64,
    name: Option<String>,
    filename: String,
    relative_path: PathBuf,
    source: PathBuf,
    source_directory: PathBuf,
    source_identity: resource_io::DirectoryIdentity,
    byte_count: u64,
}

#[derive(Clone)]
struct VerifiedFile {
    pending: PendingFile,
    blob: BlobRef,
}

/// Hashes legacy materials into the same private content-addressed blob tree used by browser
/// captures. `progress(done, total) == false` requests cancellation; a blob copy already in flight
/// may finish and remain as an unreferenced private blob, while the caller publishes nothing.
/// Unsupported or unsafe entries become explicit gaps and keep their source bytes in the stage.
pub fn migrate_legacy_resources<F>(
    store: &Store,
    mut progress: F,
) -> Result<LegacyMigration, LegacyResourceError>
where
    F: FnMut(u64, u64) -> bool,
{
    let store_root = store.store_dir();
    let data_identity =
        resource_io::verify_private_directory(store.data_root()).map_err(map_archive_error)?;
    let store_identity =
        resource_io::verify_private_directory(&store_root).map_err(map_archive_error)?;
    let coursework =
        legacy_io::read_json_file(&store_root, Path::new("coursework.json"), MAX_JSON_BYTES)?
            .ok_or(LegacyResourceError::InvalidCoursework)?;
    let coursework: Value =
        serde_json::from_slice(&coursework).map_err(|_| LegacyResourceError::InvalidCoursework)?;
    let mut inventory = read_existing_inventory(&store_root, store.data_root())?;
    let mut pending = legacy_io::collect_pending_files(&store_root, &coursework, &mut inventory)?;
    pending.sort_by(|left, right| {
        (&left.course_key, left.file_id, &left.filename).cmp(&(
            &right.course_key,
            right.file_id,
            &right.filename,
        ))
    });

    let scan_total = pending
        .iter()
        .try_fold(0_u64, |sum, file| sum.checked_add(file.byte_count))
        .ok_or(LegacyResourceError::LimitExceeded)?;
    if scan_total > MAX_CAPTURE_BYTES {
        return Err(LegacyResourceError::LimitExceeded);
    }
    let mut scan_done = 0_u64;
    let mut verified = Vec::new();
    let mut removable = BTreeSet::new();
    for file in pending {
        if !progress(scan_done, scan_total.saturating_mul(2)) {
            return Err(LegacyResourceError::Cancelled);
        }
        match legacy_io::hash_legacy_file(&file, &mut |count| {
            scan_done = scan_done.saturating_add(count);
            progress(scan_done, scan_total.saturating_mul(2))
        })? {
            Some(blob) => {
                let reference = make_reference(&file, &blob);
                let key = (file.course_key.clone(), file.file_id);
                match inventory.get(&key) {
                    Some(prior) if prior.status == LegacyStatus::Saved => {
                        if prior.sha256 != reference.sha256
                            || prior.byte_count != reference.byte_count
                            || prior.content_type != reference.content_type
                        {
                            return Err(LegacyResourceError::ConflictingReference);
                        }
                    }
                    Some(_) | None => {
                        inventory.insert(key, reference);
                    }
                }
                removable.insert(file.relative_path.clone());
                verified.push(VerifiedFile {
                    pending: file,
                    blob,
                });
            }
            None => {
                inventory
                    .entry((file.course_key.clone(), file.file_id))
                    .or_insert_with(|| gap_reference(&file, GAP_UNSUPPORTED));
            }
        }
    }
    resource_io::verify_directory_identity(&store_root, store_identity)
        .map_err(map_archive_error)?;
    if !progress(scan_done, scan_total.saturating_mul(2)) {
        return Err(LegacyResourceError::Cancelled);
    }

    let (reused_blobs, bytes_verified) = legacy_io::promote_verified(
        store.data_root(),
        &verified,
        scan_done,
        scan_total.saturating_mul(2),
        &mut progress,
    )?;
    resource_io::verify_directory_identity(store.data_root(), data_identity)
        .map_err(map_archive_error)?;
    let files: Vec<LegacyReference> = inventory.into_values().collect();
    let gap_files = files
        .iter()
        .filter(|file| file.status == LegacyStatus::Gap)
        .count() as u64;
    let document = LegacyArchiveDocument {
        format: LEGACY_ARCHIVE_FORMAT.to_owned(),
        version: LEGACY_ARCHIVE_VERSION,
        files,
    };
    Ok(LegacyMigration {
        document: node_json_bytes(
            &serde_json::to_value(document).map_err(|_| LegacyResourceError::InvalidArchive)?,
        ),
        removable_material_paths: removable.into_iter().collect(),
        migrated_files: verified.len() as u64,
        reused_blobs,
        gap_files,
        bytes_verified,
    })
}

fn read_existing_inventory(
    store_root: &Path,
    data_root: &Path,
) -> Result<BTreeMap<(String, u64), LegacyReference>, LegacyResourceError> {
    let Some(bytes) = legacy_io::read_json_file(
        store_root,
        Path::new(LEGACY_RESOURCE_ARCHIVE_DOCUMENT),
        MAX_JSON_BYTES,
    )?
    else {
        return Ok(BTreeMap::new());
    };
    let document: LegacyArchiveDocument =
        serde_json::from_slice(&bytes).map_err(|_| LegacyResourceError::InvalidArchive)?;
    if document.format != LEGACY_ARCHIVE_FORMAT
        || document.version != LEGACY_ARCHIVE_VERSION
        || document.files.len() > MAX_MANIFEST_ENTRIES
    {
        return Err(LegacyResourceError::InvalidArchive);
    }
    let mut inventory = BTreeMap::new();
    for file in document.files {
        validate_reference(&file, data_root)?;
        let key = (file.course_key.clone(), file.file_id);
        if inventory.insert(key, file).is_some() {
            return Err(LegacyResourceError::InvalidArchive);
        }
    }
    Ok(inventory)
}

fn validate_reference(file: &LegacyReference, data_root: &Path) -> Result<(), LegacyResourceError> {
    if !safe_key(&file.course_key)
        || file.file_id == 0
        || file.source != "legacy"
        || file.source_authenticity != "unverified"
        || file.observed_at.is_some()
        || file
            .name
            .as_deref()
            .is_some_and(|name| !safe_display_name(name))
    {
        return Err(LegacyResourceError::InvalidArchive);
    }
    match file.status {
        LegacyStatus::Gap => {
            if file.sha256.is_some()
                || file.byte_count.is_some()
                || file.content_type.is_some()
                || !matches!(
                    file.gap_reason.as_deref(),
                    Some(GAP_MISSING | GAP_UNSAFE | GAP_SIZE | GAP_LIMIT | GAP_UNSUPPORTED)
                )
            {
                return Err(LegacyResourceError::InvalidArchive);
            }
        }
        LegacyStatus::Saved => {
            if file.gap_reason.is_some() {
                return Err(LegacyResourceError::InvalidArchive);
            }
            let hash = file
                .sha256
                .as_deref()
                .ok_or(LegacyResourceError::InvalidArchive)?;
            let size = file.byte_count.ok_or(LegacyResourceError::InvalidArchive)?;
            let content_type = file
                .content_type
                .as_deref()
                .ok_or(LegacyResourceError::InvalidArchive)?;
            if !resource_io::is_hash(hash) || size == 0 || size > MAX_BLOB_BYTES {
                return Err(LegacyResourceError::InvalidArchive);
            }
            super::verified_blob(data_root, hash, size, content_type).map_err(map_archive_error)?;
        }
    }
    Ok(())
}

fn make_reference(file: &PendingFile, blob: &BlobRef) -> LegacyReference {
    LegacyReference {
        course_key: file.course_key.clone(),
        file_id: file.file_id,
        status: LegacyStatus::Saved,
        sha256: Some(blob.sha256.clone()),
        byte_count: Some(blob.byte_count),
        content_type: Some(blob.content_type.clone()),
        name: file.name.clone(),
        source: "legacy".to_owned(),
        source_authenticity: "unverified".to_owned(),
        observed_at: None,
        gap_reason: None,
    }
}

fn gap_reference(file: &PendingFile, reason: &str) -> LegacyReference {
    gap_reference_fields(&file.course_key, file.file_id, file.name.clone(), reason)
}

fn gap_reference_fields(
    course_key: &str,
    file_id: u64,
    name: Option<String>,
    reason: &str,
) -> LegacyReference {
    LegacyReference {
        course_key: course_key.to_owned(),
        file_id,
        status: LegacyStatus::Gap,
        sha256: None,
        byte_count: None,
        content_type: None,
        name,
        source: "legacy".to_owned(),
        source_authenticity: "unverified".to_owned(),
        observed_at: None,
        gap_reason: Some(reason.to_owned()),
    }
}

fn normalized_folder(value: &str) -> Option<String> {
    let folder = value.strip_prefix("classes/").unwrap_or(value);
    safe_key(folder).then(|| folder.to_owned())
}

fn safe_key(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn safe_basename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

fn safe_display_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 240 && !value.chars().any(char::is_control)
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.parse::<u64>().ok())
        })
        .filter(|id| *id > 0)
}

fn map_archive_error(error: ResourceArchiveError) -> LegacyResourceError {
    match error {
        ResourceArchiveError::UnsafeDirectory => LegacyResourceError::UnsafeDirectory,
        ResourceArchiveError::UnsafeFile => LegacyResourceError::UnsafeFile,
        ResourceArchiveError::BlobTooLarge
        | ResourceArchiveError::CaptureTooLarge
        | ResourceArchiveError::ArchiveLimitExceeded => LegacyResourceError::LimitExceeded,
        ResourceArchiveError::BlobMismatch | ResourceArchiveError::MissingSource => {
            LegacyResourceError::SourceChanged
        }
        other => LegacyResourceError::ResourceArchive(other),
    }
}
