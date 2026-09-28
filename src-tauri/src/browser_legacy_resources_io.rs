//! No-follow reads, content hashing, and reuse of the native private blob archive.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    gap_reference_fields, normalized_folder, positive_id, safe_basename, safe_display_name,
    safe_key, LegacyReference, LegacyResourceError, PendingFile, ResourceArchiveError,
    VerifiedFile, GAP_LIMIT, GAP_MISSING, GAP_SIZE, GAP_UNSAFE, MAX_BLOB_BYTES, MAX_CAPTURE_BYTES,
    MAX_COURSES, MAX_JSON_BYTES, MAX_MANIFEST_ENTRIES,
};
use crate::browser_resources::{BlobRef, BLOBS_NAME, MAX_ARCHIVE_BYTES};
use crate::browser_resources_io as resource_io;
use crate::browser_resources_io::CHUNK_BYTES;
use crate::capture_media::{verify_content_type, MediaError};
use crate::store::hex;

const PREFIX_BYTES: usize = 8 * 1024;

pub(super) fn collect_pending_files(
    store_root: &Path,
    coursework: &Value,
    inventory: &mut BTreeMap<(String, u64), LegacyReference>,
) -> Result<Vec<PendingFile>, LegacyResourceError> {
    let courses = coursework
        .get("courses")
        .and_then(Value::as_array)
        .filter(|items| items.len() <= MAX_COURSES)
        .ok_or(LegacyResourceError::InvalidCoursework)?;
    let mut keys = BTreeSet::new();
    let mut folders = BTreeSet::new();
    let mut pending = Vec::new();
    let mut manifest_count = 0_usize;
    for course in courses {
        let key = course
            .get("key")
            .and_then(Value::as_str)
            .filter(|value| safe_key(value))
            .ok_or(LegacyResourceError::InvalidCoursework)?
            .to_owned();
        if !keys.insert(key.clone()) {
            return Err(LegacyResourceError::InvalidCoursework);
        }
        let Some(folder_value) = course.get("folder") else {
            continue;
        };
        if folder_value.is_null() {
            continue;
        }
        let folder = folder_value
            .as_str()
            .and_then(normalized_folder)
            .ok_or(LegacyResourceError::InvalidCoursework)?;
        if !folders.insert(folder.clone()) {
            return Err(LegacyResourceError::InvalidCoursework);
        }
        let manifest_relative = PathBuf::from("classes")
            .join(&folder)
            .join("canvas-export/download-manifest.json");
        let Some(bytes) = read_json_file(store_root, &manifest_relative, MAX_JSON_BYTES)? else {
            continue;
        };
        let manifest: Value =
            serde_json::from_slice(&bytes).map_err(|_| LegacyResourceError::InvalidManifest)?;
        let entries = manifest
            .as_array()
            .filter(|items| items.len() <= MAX_MANIFEST_ENTRIES)
            .ok_or(LegacyResourceError::InvalidManifest)?;
        manifest_count = manifest_count
            .checked_add(entries.len())
            .filter(|count| *count <= MAX_MANIFEST_ENTRIES)
            .ok_or(LegacyResourceError::LimitExceeded)?;
        let materials_relative = PathBuf::from("classes").join(&folder).join("materials");
        let materials = store_root.join(&materials_relative);
        let materials_lstat = optional_lstat(&materials)?;
        let (materials_identity, directory_gap) = match materials_lstat {
            None => (None, GAP_MISSING),
            Some(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                match resource_io::verify_private_directory(&materials) {
                    Ok(identity) => (Some(identity), GAP_UNSAFE),
                    Err(_) => (None, GAP_UNSAFE),
                }
            }
            Some(_) => (None, GAP_UNSAFE),
        };
        let mut seen_ids = BTreeSet::new();
        for entry in entries {
            if !matches!(
                entry.get("status").and_then(Value::as_str),
                Some("downloaded" | "reused")
            ) {
                continue;
            }
            let file_id =
                positive_id(entry.get("id")).ok_or(LegacyResourceError::InvalidManifest)?;
            if !seen_ids.insert(file_id) {
                return Err(LegacyResourceError::InvalidManifest);
            }
            let map_key = (key.clone(), file_id);
            let filename = entry.get("filename").and_then(Value::as_str);
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| safe_display_name(value))
                .map(str::to_owned)
                .or_else(|| {
                    filename
                        .filter(|value| safe_display_name(value))
                        .map(str::to_owned)
                });
            let Some(filename) = filename.filter(|value| safe_basename(value)) else {
                inventory
                    .entry(map_key)
                    .or_insert_with(|| gap_reference_fields(&key, file_id, name, GAP_UNSAFE));
                continue;
            };
            let Some(size) = entry
                .get("size")
                .and_then(Value::as_u64)
                .filter(|size| *size > 0)
            else {
                inventory
                    .entry(map_key)
                    .or_insert_with(|| gap_reference_fields(&key, file_id, name, GAP_SIZE));
                continue;
            };
            if size > MAX_BLOB_BYTES {
                inventory
                    .entry(map_key)
                    .or_insert_with(|| gap_reference_fields(&key, file_id, name, GAP_LIMIT));
                continue;
            }
            let Some(source_identity) = materials_identity else {
                inventory
                    .entry(map_key)
                    .or_insert_with(|| gap_reference_fields(&key, file_id, name, directory_gap));
                continue;
            };
            let source = materials.join(filename);
            let metadata = match fs::symlink_metadata(&source) {
                Ok(metadata) if safe_file_metadata(&metadata, MAX_BLOB_BYTES) => metadata,
                Ok(_) => {
                    inventory
                        .entry(map_key)
                        .or_insert_with(|| gap_reference_fields(&key, file_id, name, GAP_UNSAFE));
                    continue;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    inventory
                        .entry(map_key)
                        .or_insert_with(|| gap_reference_fields(&key, file_id, name, GAP_MISSING));
                    continue;
                }
                Err(_) => return Err(LegacyResourceError::Io),
            };
            if metadata.len() != size {
                inventory
                    .entry(map_key)
                    .or_insert_with(|| gap_reference_fields(&key, file_id, name, GAP_SIZE));
                continue;
            }
            pending.push(PendingFile {
                course_key: key.clone(),
                file_id,
                name,
                filename: filename.to_owned(),
                relative_path: materials_relative.join(filename),
                source,
                source_directory: materials.clone(),
                source_identity,
                byte_count: size,
            });
        }
    }
    Ok(pending)
}

pub(super) fn read_json_file(
    store_root: &Path,
    relative: &Path,
    cap: u64,
) -> Result<Option<Vec<u8>>, LegacyResourceError> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(LegacyResourceError::InvalidStore);
    }
    let path = store_root.join(relative);
    verify_parent_directories(store_root, relative)?;
    let Some(metadata) = optional_lstat(&path)? else {
        return Ok(None);
    };
    if !safe_file_metadata(&metadata, cap) {
        return Err(LegacyResourceError::UnsafeFile);
    }
    let mut file = open_nofollow(&path)?;
    let opened = file.metadata().map_err(|_| LegacyResourceError::Io)?;
    if !same_file(&metadata, &opened) || !safe_file_metadata(&opened, cap) {
        return Err(LegacyResourceError::UnsafeFile);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| LegacyResourceError::Io)?;
    let after = fs::symlink_metadata(&path).map_err(|_| LegacyResourceError::UnsafeFile)?;
    if bytes.len() as u64 > cap {
        return Err(LegacyResourceError::LimitExceeded);
    }
    if !same_file(&opened, &after) {
        return Err(LegacyResourceError::SourceChanged);
    }
    Ok(Some(bytes))
}

fn verify_parent_directories(root: &Path, relative: &Path) -> Result<(), LegacyResourceError> {
    let mut current = root.to_path_buf();
    for component in relative.parent().into_iter().flat_map(Path::components) {
        let std::path::Component::Normal(name) = component else {
            return Err(LegacyResourceError::InvalidStore);
        };
        current.push(name);
        match resource_io::verify_private_directory(&current) {
            Ok(_) => {}
            Err(ResourceArchiveError::UnsafeDirectory) if !current.exists() => return Ok(()),
            Err(error) => return Err(super::map_archive_error(error)),
        }
    }
    Ok(())
}

pub(super) fn optional_lstat(path: &Path) -> Result<Option<fs::Metadata>, LegacyResourceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(LegacyResourceError::Io),
    }
}

pub(super) fn safe_file_metadata(metadata: &fs::Metadata, cap: u64) -> bool {
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > cap {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o7777 == 0o600
            && metadata.nlink() == 1
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn open_nofollow(path: &Path) -> Result<File, LegacyResourceError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options
        .open(path)
        .map_err(|_| LegacyResourceError::UnsafeFile)
}

fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino() && left.uid() == right.uid()
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right);
        false
    }
}

pub(super) fn hash_legacy_file<F>(
    file: &PendingFile,
    progress: &mut F,
) -> Result<Option<BlobRef>, LegacyResourceError>
where
    F: FnMut(u64) -> bool,
{
    resource_io::verify_directory_identity(&file.source_directory, file.source_identity)
        .map_err(super::map_archive_error)?;
    let before = match fs::symlink_metadata(&file.source) {
        Ok(metadata) if safe_file_metadata(&metadata, MAX_BLOB_BYTES) => metadata,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(LegacyResourceError::Io),
    };
    if before.len() != file.byte_count {
        return Ok(None);
    }
    let mut input = open_nofollow(&file.source)?;
    let opened = input.metadata().map_err(|_| LegacyResourceError::Io)?;
    if !same_file(&before, &opened) || !safe_file_metadata(&opened, MAX_BLOB_BYTES) {
        return Ok(None);
    }
    let mut digest = Sha256::new();
    let mut prefix = Vec::with_capacity(PREFIX_BYTES);
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    let mut count = 0_u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|_| LegacyResourceError::Io)?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read as u64)
            .ok_or(LegacyResourceError::LimitExceeded)?;
        if count > file.byte_count || count > MAX_BLOB_BYTES {
            return Err(LegacyResourceError::SourceChanged);
        }
        let chunk = &buffer[..read];
        if prefix.len() < PREFIX_BYTES {
            let take = (PREFIX_BYTES - prefix.len()).min(read);
            prefix.extend_from_slice(&chunk[..take]);
        }
        digest.update(chunk);
        if !progress(read as u64) {
            return Err(LegacyResourceError::Cancelled);
        }
    }
    let after =
        fs::symlink_metadata(&file.source).map_err(|_| LegacyResourceError::SourceChanged)?;
    resource_io::verify_directory_identity(&file.source_directory, file.source_identity)
        .map_err(super::map_archive_error)?;
    if !same_file(&opened, &after) || count != file.byte_count {
        return Err(LegacyResourceError::SourceChanged);
    }
    let content_type = match verify_content_type(Some("application/octet-stream"), &prefix) {
        Ok(value) => value,
        Err(MediaError::SignInResponse | MediaError::MimeSignatureMismatch) => return Ok(None),
    };
    Ok(Some(BlobRef {
        file_id: file.file_id,
        byte_count: count,
        sha256: hex(&digest.finalize()),
        content_type: content_type.to_owned(),
    }))
}

pub(super) fn promote_verified<F>(
    data_root: &Path,
    verified: &[VerifiedFile],
    scan_done: u64,
    work_total: u64,
    progress: &mut F,
) -> Result<(u64, u64), LegacyResourceError>
where
    F: FnMut(u64, u64) -> bool,
{
    if verified.is_empty() {
        return Ok((0, 0));
    }
    let mut unique = BTreeMap::<String, (&VerifiedFile, BTreeSet<String>)>::new();
    for file in verified {
        unique
            .entry(file.blob.sha256.clone())
            .or_insert_with(|| (file, BTreeSet::new()))
            .1
            .insert(file.blob.content_type.clone());
    }
    let unique_bytes = unique
        .values()
        .try_fold(0_u64, |sum, (file, _)| {
            sum.checked_add(file.blob.byte_count)
        })
        .ok_or(LegacyResourceError::LimitExceeded)?;
    if unique_bytes > MAX_CAPTURE_BYTES {
        return Err(LegacyResourceError::LimitExceeded);
    }
    let data_identity =
        resource_io::verify_private_directory(data_root).map_err(super::map_archive_error)?;
    let archive = resource_io::ensure_private_child(data_root, resource_io::ARCHIVE_NAME)
        .map_err(super::map_archive_error)?;
    let archive_identity =
        resource_io::verify_private_directory(&archive).map_err(super::map_archive_error)?;
    let blobs = resource_io::ensure_private_child(&archive, BLOBS_NAME)
        .map_err(super::map_archive_error)?;
    let blobs_identity =
        resource_io::verify_private_directory(&blobs).map_err(super::map_archive_error)?;
    let existing =
        resource_io::inventory_blobs(&blobs, MAX_BLOB_BYTES).map_err(super::map_archive_error)?;
    let existing_bytes = existing
        .values()
        .try_fold(0_u64, |sum, size| sum.checked_add(*size))
        .ok_or(LegacyResourceError::LimitExceeded)?;
    let required_new = unique
        .iter()
        .filter(|(hash, _)| !existing.contains_key(*hash))
        .try_fold(0_u64, |sum, (_, (file, _))| {
            sum.checked_add(file.blob.byte_count)
        })
        .ok_or(LegacyResourceError::LimitExceeded)?;
    if existing_bytes
        .checked_add(required_new)
        .is_none_or(|size| size > MAX_ARCHIVE_BYTES)
    {
        return Err(LegacyResourceError::LimitExceeded);
    }

    let mut reused = 0_u64;
    let mut bytes_verified = 0_u64;
    let mut archive_done = 0_u64;
    for (hash, (file, content_types)) in unique {
        if !progress(scan_done.saturating_add(archive_done), work_total) {
            return Err(LegacyResourceError::Cancelled);
        }
        resource_io::verify_directory_identity(data_root, data_identity)
            .map_err(super::map_archive_error)?;
        resource_io::verify_directory_identity(&archive, archive_identity)
            .map_err(super::map_archive_error)?;
        resource_io::verify_directory_identity(&blobs, blobs_identity)
            .map_err(super::map_archive_error)?;
        let accepted_types: Vec<String> = content_types.into_iter().collect();
        let destination = blobs.join(&hash);
        let mut cancelled = false;
        let mut report_progress = |done: u64, total: u64| {
            if !progress(scan_done.saturating_add(done), work_total) {
                cancelled = true;
            }
            let _ = (done, total);
        };
        if existing.contains_key(&hash) {
            resource_io::verify_blob_file(
                &destination,
                &hash,
                file.blob.byte_count,
                &accepted_types,
                MAX_BLOB_BYTES,
                archive_done,
                unique_bytes,
                &mut report_progress,
            )
            .map_err(super::map_archive_error)?;
            reused += 1;
        } else {
            resource_io::copy_verified_blob(
                &file.pending.source,
                &file.pending.source_directory,
                file.pending.source_identity,
                &blobs,
                blobs_identity,
                &destination,
                &file.blob,
                &accepted_types,
                MAX_BLOB_BYTES,
                archive_done,
                unique_bytes,
                &mut report_progress,
            )
            .map_err(super::map_archive_error)?;
        }
        if cancelled {
            return Err(LegacyResourceError::Cancelled);
        }
        archive_done = archive_done.saturating_add(file.blob.byte_count);
        bytes_verified = bytes_verified.saturating_add(file.blob.byte_count);
        if !progress(scan_done.saturating_add(archive_done), work_total) {
            return Err(LegacyResourceError::Cancelled);
        }
    }
    resource_io::sync_directory(&blobs).map_err(super::map_archive_error)?;
    Ok((reused, bytes_verified))
}
