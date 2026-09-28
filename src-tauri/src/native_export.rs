//! Owner-selected backup export for the full native coursework store.

use std::fs;
use std::path::Path;

use crate::store::{create_private_dir, utc_stamp, Store, StoreCondition, StoreError};

use super::ExportProgress;

/// Exports an exact native backup without the legacy-refresh compatibility restriction.
pub(super) fn export_native_store(
    store: &Store,
    parent: &Path,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<ExportProgress, StoreError> {
    let _lock = store.read_lock()?;
    if !matches!(store.condition()?, StoreCondition::Ready(_)) {
        return Err(StoreError::Invalid("the app store is not ready for export"));
    }
    validate_export_parent(
        parent,
        store.data_root(),
        "the export destination is not a folder",
        "the export destination is inside app data",
    )?;
    let output = new_export_path(parent, "duegood-native-backup");
    create_private_dir(&output, false)?;
    let owned_root = fs::symlink_metadata(&output)?;
    let result = (|| {
        let copied =
            super::copy_tree_into_private_root(&store.store_dir(), &output, false, progress)?;
        crate::browser_export::export_referenced_blobs_from_root(
            store, &output, &output, copied, progress,
        )
    })();
    if result.is_err() {
        remove_if_still_owned(&output, &owned_root);
    }
    result
}

pub(super) fn copy_store_with_referenced_blobs(
    store: &Store,
    reference_root: &Path,
    output: &Path,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<ExportProgress, StoreError> {
    let copied = super::copy_tree(&store.store_dir(), output, false, progress)?;
    crate::browser_export::export_referenced_blobs_from_root(
        store,
        reference_root,
        output,
        copied,
        progress,
    )
}

pub(super) fn validate_export_parent(
    parent: &Path,
    excluded_root: &Path,
    invalid_parent: &'static str,
    excluded_parent: &'static str,
) -> Result<(), StoreError> {
    let metadata = fs::symlink_metadata(parent)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(StoreError::Invalid(invalid_parent));
    }
    let canonical_parent = fs::canonicalize(parent)?;
    let canonical_excluded = fs::canonicalize(excluded_root)?;
    if canonical_parent.starts_with(&canonical_excluded) {
        return Err(StoreError::Invalid(excluded_parent));
    }
    Ok(())
}

fn new_export_path(parent: &Path, prefix: &str) -> std::path::PathBuf {
    parent.join(format!(
        "{prefix}-{}-{}",
        utc_stamp(std::time::SystemTime::now()).compact,
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ))
}

fn remove_if_still_owned(path: &Path, owned: &fs::Metadata) {
    if fs::symlink_metadata(path).is_ok_and(|current| super::same_node(owned, &current)) {
        let _ = fs::remove_dir_all(path);
    }
}
