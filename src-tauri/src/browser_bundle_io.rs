//! Filesystem boundary for the read-only browser bundle validator.

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    required_hash, required_u64, BundleError, BundleValidationProgress, MAX_BLOBS, MAX_BLOB_BYTES,
    MAX_GENERATION_BYTES,
};

pub(super) fn checked_directory(path: &Path) -> Result<PathBuf, BundleError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| BundleError::UnsafeDirectory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || !private_owner(&metadata) {
        return Err(BundleError::UnsafeDirectory);
    }
    let canonical = fs::canonicalize(path).map_err(|_| BundleError::UnsafeDirectory)?;
    if canonical != path {
        return Err(BundleError::UnsafeDirectory);
    }
    Ok(canonical)
}

pub(super) fn check_generation_entries(path: &Path) -> Result<(), BundleError> {
    let entries = fs::read_dir(path).map_err(|_| BundleError::UnsafeDirectory)?;
    let names = entries
        .map(|entry| entry.map(|value| value.file_name().to_string_lossy().into_owned()))
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|_| BundleError::UnsafeDirectory)?;
    if names != BTreeSet::from([String::from("manifest.json"), String::from("snapshot.json")]) {
        return Err(BundleError::InvalidManifest);
    }
    Ok(())
}

pub(super) fn read_private_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, BundleError> {
    let before = checked_file_metadata(path, max_bytes)?;
    let file = open_private_file(path)?;
    let opened = file.metadata().map_err(|_| BundleError::UnsafeFile)?;
    verify_same_file(&before, &opened)?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| BundleError::UnsafeFile)?;
    if bytes.len() as u64 > max_bytes {
        return Err(BundleError::BudgetExceeded);
    }
    let after = checked_file_metadata(path, max_bytes)?;
    verify_same_file(&opened, &after)?;
    Ok(bytes)
}

pub(super) fn verify_blob<F>(
    path: &Path,
    expected_hash: &str,
    expected_size: u64,
    verified: &mut BundleValidationProgress,
    progress: &mut F,
) -> Result<(), BundleError>
where
    F: FnMut(BundleValidationProgress),
{
    let before = checked_file_metadata(path, MAX_BLOB_BYTES)?;
    let mut file = open_private_file(path)?;
    let opened = file.metadata().map_err(|_| BundleError::UnsafeFile)?;
    verify_same_file(&before, &opened)?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut last_report_bytes = 0_u64;
    let mut last_report_time = std::time::Instant::now();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| BundleError::UnsafeFile)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or(BundleError::BudgetExceeded)?;
        if total > MAX_BLOB_BYTES {
            return Err(BundleError::BudgetExceeded);
        }
        hasher.update(&buffer[..count]);
        let now = std::time::Instant::now();
        if total.saturating_sub(last_report_bytes) >= 4 * 1024 * 1024
            || now.duration_since(last_report_time) >= std::time::Duration::from_millis(100)
        {
            progress(BundleValidationProgress {
                bytes_verified: verified.bytes_verified.saturating_add(total),
                ..*verified
            });
            last_report_bytes = total;
            last_report_time = now;
        }
    }
    let actual = format!("{:x}", hasher.finalize());
    let after = checked_file_metadata(path, MAX_BLOB_BYTES)?;
    verify_same_file(&opened, &after)?;
    if total != before.len() || total != expected_size || actual != expected_hash {
        return Err(BundleError::BlobMismatch);
    }
    verified.bytes_verified = verified.bytes_verified.saturating_add(total);
    verified.files_verified += 1;
    Ok(())
}

pub(super) fn validate_blobs<F>(
    manifest: &Value,
    snapshot: &Value,
    blobs: &Path,
    progress: &mut F,
) -> Result<(), BundleError>
where
    F: FnMut(BundleValidationProgress),
{
    let receipts = manifest
        .get("blobs")
        .and_then(Value::as_array)
        .ok_or(BundleError::InvalidManifest)?;
    if receipts.len() > MAX_BLOBS {
        return Err(BundleError::BudgetExceeded);
    }
    if required_u64(manifest, "blobCount", BundleError::InvalidManifest)? != receipts.len() as u64 {
        return Err(BundleError::IntegrityMismatch);
    }
    let mut receipt_by_file = HashMap::new();
    let mut hashes = HashMap::new();
    let mut total_bytes = 0_u64;
    for receipt in receipts {
        let file_id = required_u64(receipt, "fileId", BundleError::InvalidManifest)?;
        let byte_count = required_u64(receipt, "byteCount", BundleError::InvalidManifest)?;
        let digest = required_hash(receipt, "sha256", BundleError::InvalidManifest)?;
        if file_id == 0
            || byte_count == 0
            || byte_count > MAX_BLOB_BYTES
            || receipt.get("sourceAuthenticity").and_then(Value::as_str) != Some("unverified")
            || receipt
                .get("contentType")
                .and_then(Value::as_str)
                .is_none_or(|value| !valid_content_type(value))
            || receipt_by_file.insert(file_id, receipt).is_some()
        {
            return Err(BundleError::InvalidManifest);
        }
        total_bytes = total_bytes
            .checked_add(byte_count)
            .ok_or(BundleError::BudgetExceeded)?;
        if total_bytes > MAX_GENERATION_BYTES {
            return Err(BundleError::BudgetExceeded);
        }
        if hashes
            .insert(digest, byte_count)
            .is_some_and(|previous| previous != byte_count)
        {
            return Err(BundleError::InvalidManifest);
        }
    }
    if required_u64(manifest, "blobBytes", BundleError::InvalidManifest)? != total_bytes {
        return Err(BundleError::IntegrityMismatch);
    }

    let mut archived_files = HashMap::new();
    for resource in snapshot["resources"]
        .as_array()
        .ok_or(BundleError::InvalidSnapshot)?
        .iter()
        .filter(|resource| resource["endpoint"] == "fileBodies")
    {
        for item in resource["items"]
            .as_array()
            .ok_or(BundleError::InvalidSnapshot)?
        {
            match item.get("status").and_then(Value::as_str) {
                Some("archived") => {
                    let file_id = required_u64(item, "fileId", BundleError::InvalidSnapshot)?;
                    if item.get("stagedFile").is_some()
                        || archived_files.insert(file_id, item).is_some()
                    {
                        return Err(BundleError::InvalidSnapshot);
                    }
                }
                Some("staged") => return Err(BundleError::InvalidSnapshot),
                _ => {}
            }
        }
    }
    if archived_files.len() != receipt_by_file.len() {
        return Err(BundleError::IntegrityMismatch);
    }
    for (file_id, item) in archived_files {
        let receipt = receipt_by_file
            .get(&file_id)
            .ok_or(BundleError::IntegrityMismatch)?;
        if item.get("byteCount").and_then(Value::as_u64)
            != receipt.get("byteCount").and_then(Value::as_u64)
            || item.get("sha256").and_then(Value::as_str)
                != receipt.get("sha256").and_then(Value::as_str)
            || item.get("contentType").and_then(Value::as_str)
                != receipt.get("contentType").and_then(Value::as_str)
            || item.get("sourceAuthenticity").and_then(Value::as_str) != Some("unverified")
        {
            return Err(BundleError::IntegrityMismatch);
        }
    }
    let total_unique_bytes = hashes
        .values()
        .try_fold(0_u64, |sum, value| sum.checked_add(*value))
        .ok_or(BundleError::BudgetExceeded)?;
    let mut verified = BundleValidationProgress {
        bytes_verified: 0,
        total_blob_bytes: total_unique_bytes,
        files_verified: 0,
        total_blob_files: hashes.len(),
    };
    for (hash, byte_count) in hashes {
        verify_blob(
            &blobs.join(format!("{hash}.blob")),
            &hash,
            byte_count,
            &mut verified,
            progress,
        )?;
    }
    progress(verified);
    Ok(())
}

fn valid_content_type(value: &str) -> bool {
    let Some((major, minor)) = value.split_once('/') else {
        return false;
    };
    [major, minor].iter().all(|part| {
        !part.is_empty()
            && part.len() <= 64
            && part.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-.+".contains(&byte)
            })
    })
}

pub(super) fn has_private_value(value: &Value, depth: usize) -> Result<bool, BundleError> {
    if depth > 40 {
        return Err(BundleError::BudgetExceeded);
    }
    match value {
        Value::Array(items) => {
            for item in items {
                if has_private_value(item, depth + 1)? {
                    return Ok(true);
                }
            }
        }
        Value::Object(map) => {
            for (key, child) in map {
                let folded = key.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "accesstoken",
                    "verifier",
                    "signature",
                    "privateurl",
                    "credential",
                    "password",
                ]
                .iter()
                .any(|needle| folded.contains(needle))
                    || (folded.contains("calendar")
                        && (folded.contains("feed") || folded.contains("ics")))
                {
                    return Ok(true);
                }
                if has_private_value(child, depth + 1)? {
                    return Ok(true);
                }
            }
        }
        Value::String(text) => {
            let folded = text.to_ascii_lowercase();
            if [
                "access_token=",
                "token=",
                "verifier=",
                "signature=",
                "x-amz-",
                "download_frd=",
            ]
            .iter()
            .any(|needle| folded.contains(needle))
            {
                return Ok(true);
            }
        }
        _ => {}
    }
    Ok(false)
}

fn checked_file_metadata(path: &Path, max_bytes: u64) -> Result<Metadata, BundleError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| BundleError::UnsafeFile)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || !private_owner(&metadata)
        || metadata.len() > max_bytes
    {
        return Err(BundleError::UnsafeFile);
    }
    Ok(metadata)
}

fn open_private_file(path: &Path) -> Result<File, BundleError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options.open(path).map_err(|_| BundleError::UnsafeFile)
}

#[cfg(unix)]
fn private_owner(metadata: &Metadata) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let mode = metadata.permissions().mode() & 0o7777;
    let uid = unsafe { libc::geteuid() };
    metadata.uid() == uid
        && if metadata.is_dir() {
            mode == 0o700
        } else {
            mode == 0o600 && metadata.nlink() == 1
        }
}

#[cfg(not(unix))]
fn private_owner(_: &Metadata) -> bool {
    false
}

#[cfg(unix)]
fn verify_same_file(left: &Metadata, right: &Metadata) -> Result<(), BundleError> {
    use std::os::unix::fs::MetadataExt;
    if left.dev() != right.dev()
        || left.ino() != right.ino()
        || left.len() != right.len()
        || !left.is_file()
        || !right.is_file()
        || !private_owner(left)
        || !private_owner(right)
    {
        return Err(BundleError::UnsafeFile);
    }
    Ok(())
}

#[cfg(not(unix))]
fn verify_same_file(_: &Metadata, _: &Metadata) -> Result<(), BundleError> {
    Ok(())
}
