//! Export only content-addressed browser resources referenced by saved course manifests.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::browser_export_io::{
    create_private_directory, hex_digest, open_source_nofollow, same_file, sync_directory,
    verify_directory_identity, verify_private_directory, verify_private_file, DirectoryIdentity,
    ExportedFile, ProgressReporter,
};
#[path = "browser_export_references.rs"]
mod references;
use crate::capture_media::verify_content_type;
use crate::export::ExportProgress;
use crate::store::{create_private_file, Store, StoreError};
use references::{collect_references, BlobRef};

const RESOURCE_ARCHIVE: &str = "canvas-resource-archive";
const BLOBS_DIR: &str = "blobs";
const MAX_BLOB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_REFERENCES: u64 = 100_000;
const COPY_BUFFER_BYTES: usize = 256 * 1024;
const MIME_PREFIX_BYTES: usize = 8 * 1024;
const PROGRESS_BYTES: u64 = 4 * 1024 * 1024;

/// Copies the verified blobs referenced by native course download manifests into a new export.
///
/// The caller holds the store lock and owns cleanup of `output_root` if this returns an error.
/// Only saved manifest entries are exported; archive blobs without a course reference are ignored.
pub fn export_referenced_blobs(
    store: &Store,
    output_root: &Path,
    prior_totals: ExportProgress,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<ExportProgress, StoreError> {
    export_referenced_blobs_from_root(
        store,
        &store.store_dir(),
        output_root,
        prior_totals,
        progress,
    )
}

/// Copies blobs referenced by documents in an explicit private snapshot root.
///
/// This supports frozen owner exports: references come from the frozen document tree while blob
/// bodies are verified against the current content-addressed native archive. The caller holds the
/// store lock and owns cleanup of `output_root` if this returns an error.
pub fn export_referenced_blobs_from_root(
    store: &Store,
    document_root: &Path,
    output_root: &Path,
    prior_totals: ExportProgress,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<ExportProgress, StoreError> {
    if !document_root.is_absolute() {
        return Err(invalid("browser export document root is unsafe"));
    }
    let document_root_identity = verify_private_directory(document_root)?;
    let (mut refs, reference_count) = collect_references(document_root)?;
    if reference_count > MAX_REFERENCES {
        return Err(invalid("too many browser resource references"));
    }
    if refs.is_empty() {
        return Ok(prior_totals);
    }
    let total_bytes = refs
        .values()
        .try_fold(0_u64, |sum, reference| {
            sum.checked_add(reference.byte_count)
        })
        .ok_or(StoreError::TooLarge)?;
    if prior_totals
        .bytes_done
        .checked_add(total_bytes)
        .is_none_or(|total| total > MAX_TOTAL_BYTES)
    {
        return Err(StoreError::TooLarge);
    }

    let root_identity = verify_output_root(store, output_root)?;
    let archive = output_root.join(RESOURCE_ARCHIVE);
    create_private_directory(&archive)?;
    let archive_identity = verify_private_directory(&archive)?;
    let blobs = archive.join(BLOBS_DIR);
    create_private_directory(&blobs)?;
    let blobs_identity = verify_private_directory(&blobs)?;

    let mut reporter =
        ProgressReporter::new(prior_totals, progress, MAX_TOTAL_BYTES, PROGRESS_BYTES);
    for (hash, reference) in std::mem::take(&mut refs) {
        verify_directory_identity(output_root, root_identity)?;
        verify_directory_identity(&archive, archive_identity)?;
        verify_directory_identity(&blobs, blobs_identity)?;
        export_one_blob(
            store,
            output_root,
            root_identity,
            &archive,
            archive_identity,
            &blobs,
            blobs_identity,
            &hash,
            &reference,
            &mut reporter,
        )?;
    }
    verify_directory_identity(output_root, root_identity)?;
    verify_directory_identity(&archive, archive_identity)?;
    verify_directory_identity(&blobs, blobs_identity)?;
    sync_directory(&blobs)?;
    sync_directory(&archive)?;
    sync_directory(output_root)?;
    verify_directory_identity(document_root, document_root_identity)?;
    reporter.finish();
    Ok(reporter.totals())
}

fn export_one_blob(
    store: &Store,
    output_root: &Path,
    root_identity: DirectoryIdentity,
    archive_dir: &Path,
    archive_identity: DirectoryIdentity,
    blobs_dir: &Path,
    blobs_identity: DirectoryIdentity,
    hash: &str,
    reference: &BlobRef,
    progress: &mut ProgressReporter<'_>,
) -> Result<(), StoreError> {
    let first_type = reference
        .content_types
        .iter()
        .next()
        .ok_or(invalid("saved browser file type is missing"))?;
    let source = crate::browser_resources::verified_blob(
        store.data_root(),
        hash,
        reference.byte_count,
        first_type,
    )
    .map_err(|_| invalid("browser resource blob is missing or unverified"))?;
    let source_dirs = verify_native_blob_directories(store.data_root())?;
    let before = fs::symlink_metadata(&source)?;
    verify_private_file(&before, reference.byte_count)?;
    let mut input = open_source_nofollow(&source)?;
    let opened = input.metadata()?;
    verify_private_file(&opened, reference.byte_count)?;
    if !same_file(&before, &opened) {
        return Err(invalid("browser resource blob changed during export"));
    }

    let destination = blobs_dir.join(hash);
    let file = create_private_file(&destination)?;
    let mut pending = ExportedFile::new(destination, file);
    let mut digest = Sha256::new();
    let mut prefix = Vec::with_capacity(MIME_PREFIX_BYTES);
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut copied = 0_u64;
    loop {
        verify_directory_identity(output_root, root_identity)?;
        verify_directory_identity(archive_dir, archive_identity)?;
        verify_directory_identity(blobs_dir, blobs_identity)?;
        for (path, identity) in &source_dirs {
            verify_directory_identity(path, *identity)?;
        }
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(count as u64)
            .ok_or(StoreError::TooLarge)?;
        if copied > reference.byte_count || copied > MAX_BLOB_BYTES {
            return Err(invalid("browser resource blob exceeds its declared size"));
        }
        let chunk = &buffer[..count];
        if prefix.len() < MIME_PREFIX_BYTES {
            let take = (MIME_PREFIX_BYTES - prefix.len()).min(count);
            prefix.extend_from_slice(&chunk[..take]);
        }
        digest.update(chunk);
        pending.file_mut()?.write_all(chunk)?;
        progress.add_bytes(count as u64)?;
    }
    if copied != reference.byte_count || hex_digest(digest.finalize().as_slice()) != hash {
        return Err(invalid("browser resource blob failed export verification"));
    }
    for content_type in &reference.content_types {
        verify_content_type(Some(content_type), &prefix)
            .map_err(|_| invalid("browser resource type failed export verification"))?;
    }
    let after = fs::symlink_metadata(&source)?;
    verify_private_file(&after, reference.byte_count)?;
    if !same_file(&opened, &after) || after.len() != reference.byte_count {
        return Err(invalid("browser resource blob changed during export"));
    }
    for (path, identity) in &source_dirs {
        verify_directory_identity(path, *identity)?;
    }
    verify_directory_identity(output_root, root_identity)?;
    verify_directory_identity(archive_dir, archive_identity)?;
    verify_directory_identity(blobs_dir, blobs_identity)?;
    pending.file_mut()?.sync_all()?;
    verify_private_file(&pending.file_mut()?.metadata()?, reference.byte_count)?;
    pending.mark_complete();
    progress.add_file()?;
    Ok(())
}

fn verify_output_root(store: &Store, path: &Path) -> Result<DirectoryIdentity, StoreError> {
    if !path.is_absolute() {
        return Err(invalid("browser export root is unsafe"));
    }
    let identity = verify_private_directory(path)?;
    let canonical_output = fs::canonicalize(path)?;
    let canonical_data = fs::canonicalize(store.data_root())?;
    if canonical_output.starts_with(canonical_data) {
        return Err(invalid("browser export root is inside app data"));
    }
    Ok(identity)
}

fn verify_native_blob_directories(
    data_root: &Path,
) -> Result<Vec<(PathBuf, DirectoryIdentity)>, StoreError> {
    let paths = [
        data_root.to_path_buf(),
        data_root.join(RESOURCE_ARCHIVE),
        data_root.join(RESOURCE_ARCHIVE).join(BLOBS_DIR),
    ];
    paths
        .into_iter()
        .map(|path| Ok((path.clone(), verify_private_directory(&path)?)))
        .collect()
}

fn invalid(message: &'static str) -> StoreError {
    StoreError::Invalid(message)
}

#[cfg(test)]
#[path = "browser_export_tests.rs"]
mod tests;
