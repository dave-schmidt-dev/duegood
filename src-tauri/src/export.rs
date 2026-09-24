//! Private, byte-for-byte copies of the legacy layout for rollback and snapshots.
//! No document is parsed or rewritten. A copy refuses symlinks and special files.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::config::{ImportLimits, LEGACY_LOCK_DIR, MANIFEST_FILE, STAGING_PREFIX};
use crate::locking::WriteLock;
use crate::store::{
    create_private_dir, create_private_file, fsync_dir, utc_stamp, Store, StoreCondition,
    StoreError,
};

/// Bounded, content-free copy progress.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub files_done: u64,
    pub bytes_done: u64,
}

/// Content-free exact description of the legacy layout, including empty directories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutSnapshot {
    pub files: u64,
    pub bytes: u64,
    entries: BTreeMap<String, LayoutEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LayoutEntry {
    Directory,
    File { bytes: u64, sha256: String },
}

/// Hashes every layout entry without loading file contents into memory.
///
/// The app manifest and the store's private bookkeeping are excluded with the same rules as
/// `copy_tree(..., false)`, so equality describes only the portable Due Good coursework layout.
#[cfg(test)]
pub fn snapshot_layout(root: &Path, include_manifest: bool) -> Result<LayoutSnapshot, StoreError> {
    snapshot_layout_with_progress(root, include_manifest, &mut |_| {})
}

/// Progress-reporting form of [`snapshot_layout`] for owner-visible long operations.
pub fn snapshot_layout_with_progress(
    root: &Path,
    include_manifest: bool,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<LayoutSnapshot, StoreError> {
    let root_metadata = fs::symlink_metadata(root)?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(StoreError::Invalid("a tree root is not a plain folder"));
    }
    let root = fs::canonicalize(root)?;
    let mut entries = BTreeMap::new();
    let mut totals = ExportProgress::default();
    let mut last_reported = ExportProgress::default();
    snapshot_entry(
        &root,
        &root,
        include_manifest,
        0,
        &mut entries,
        &mut totals,
        progress,
        &mut last_reported,
    )?;
    if totals != last_reported {
        progress(totals);
    }
    Ok(LayoutSnapshot {
        files: totals.files_done,
        bytes: totals.bytes_done,
        entries,
    })
}

fn snapshot_entry(
    root: &Path,
    path: &Path,
    include_manifest: bool,
    depth: u64,
    entries: &mut BTreeMap<String, LayoutEntry>,
    totals: &mut ExportProgress,
    progress: &mut dyn FnMut(ExportProgress),
    last_reported: &mut ExportProgress,
) -> Result<(), StoreError> {
    if depth > 64 || entries.len() as u64 >= ImportLimits::PRODUCTION.max_entries {
        return Err(StoreError::TooLarge);
    }
    let before = fs::symlink_metadata(path)?;
    if before.file_type().is_symlink() {
        return Err(StoreError::Invalid("a store copy contains a symlink"));
    }
    if before.is_dir() {
        let mut children = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let name = child.file_name();
            if path == root {
                let text = name
                    .to_str()
                    .ok_or(StoreError::Invalid("a tree contains a non-text file name"))?;
                if (!include_manifest && text == MANIFEST_FILE)
                    || text == LEGACY_LOCK_DIR
                    || matches!(text, "snapshots" | "backups")
                    || text.starts_with(STAGING_PREFIX)
                {
                    continue;
                }
            }
            let child_path = child.path();
            let relative = child_path
                .strip_prefix(root)
                .map_err(|_| StoreError::Invalid("a tree entry escaped its root"))?;
            let key = relative
                .components()
                .map(|component| {
                    component
                        .as_os_str()
                        .to_str()
                        .ok_or(StoreError::Invalid("a tree contains a non-text file name"))
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            if entries.len() as u64 >= ImportLimits::PRODUCTION.max_entries {
                return Err(StoreError::TooLarge);
            }
            let child_metadata = fs::symlink_metadata(&child_path)?;
            if child_metadata.file_type().is_symlink() {
                return Err(StoreError::Invalid("a store copy contains a symlink"));
            }
            if child_metadata.is_dir() {
                entries.insert(key, LayoutEntry::Directory);
                snapshot_entry(
                    root,
                    &child_path,
                    include_manifest,
                    depth + 1,
                    entries,
                    totals,
                    progress,
                    last_reported,
                )?;
            } else if child_metadata.is_file() {
                let (length, digest) = hash_regular_file(&child_path, &child_metadata)?;
                totals.files_done = totals
                    .files_done
                    .checked_add(1)
                    .ok_or(StoreError::TooLarge)?;
                totals.bytes_done = totals
                    .bytes_done
                    .checked_add(length)
                    .ok_or(StoreError::TooLarge)?;
                if length > ImportLimits::PRODUCTION.max_file_bytes
                    || totals.bytes_done > ImportLimits::PRODUCTION.max_total_bytes
                {
                    return Err(StoreError::TooLarge);
                }
                entries.insert(
                    key,
                    LayoutEntry::File {
                        bytes: length,
                        sha256: digest,
                    },
                );
                if totals.files_done == 1
                    || totals.files_done.saturating_sub(last_reported.files_done) >= 64
                    || totals.bytes_done.saturating_sub(last_reported.bytes_done)
                        >= 16 * 1024 * 1024
                {
                    progress(*totals);
                    *last_reported = *totals;
                }
            } else {
                return Err(StoreError::Invalid("a store copy contains a special file"));
            }
        }
        ensure_unchanged_node(path, &before)?;
    } else {
        return Err(StoreError::Invalid("a tree root is not a plain folder"));
    }
    Ok(())
}

fn hash_regular_file(path: &Path, observed: &fs::Metadata) -> Result<(u64, String), StoreError> {
    if observed.len() > ImportLimits::PRODUCTION.max_file_bytes {
        return Err(StoreError::TooLarge);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || !same_node(observed, &opened) {
        return Err(StoreError::Invalid(
            "a tree entry changed while it was read",
        ));
    }
    let mut hasher = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = [0_u8; 256 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        length = length
            .checked_add(count as u64)
            .ok_or(StoreError::TooLarge)?;
        if length > ImportLimits::PRODUCTION.max_file_bytes {
            return Err(StoreError::TooLarge);
        }
        hasher.update(&buffer[..count]);
    }
    let after_open = file.metadata()?;
    let after_path = fs::symlink_metadata(path)?;
    if length != observed.len()
        || !same_node(observed, &after_open)
        || !same_node(observed, &after_path)
        || modified(observed) != modified(&after_open)
        || modified(observed) != modified(&after_path)
    {
        return Err(StoreError::Invalid(
            "a tree entry changed while it was read",
        ));
    }
    Ok((length, format!("{:x}", hasher.finalize())))
}

fn ensure_unchanged_node(path: &Path, before: &fs::Metadata) -> Result<(), StoreError> {
    let after = fs::symlink_metadata(path)?;
    if !same_node(before, &after)
        || modified(before) != modified(&after)
        || before.len() != after.len()
    {
        return Err(StoreError::Invalid("a tree changed while it was read"));
    }
    Ok(())
}

#[cfg(unix)]
fn same_node(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino() && left.file_type() == right.file_type()
}

#[cfg(not(unix))]
fn same_node(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.file_type() == right.file_type() && left.len() == right.len()
}

fn modified(metadata: &fs::Metadata) -> Option<std::time::SystemTime> {
    metadata.modified().ok()
}

fn copy_entry(
    source: &Path,
    destination: &Path,
    include_manifest: bool,
    at_root: bool,
    progress: &mut dyn FnMut(ExportProgress),
    totals: &mut ExportProgress,
) -> Result<(), StoreError> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(StoreError::Invalid("a store copy contains a symlink"));
    }
    if metadata.is_dir() {
        create_private_dir(destination, false)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let name = entry.file_name();
            if !include_manifest && at_root && name == MANIFEST_FILE {
                continue;
            }
            let text = name.to_string_lossy();
            if at_root
                && (text == LEGACY_LOCK_DIR
                    || matches!(text.as_ref(), "snapshots" | "backups")
                    || text.starts_with(STAGING_PREFIX))
            {
                continue;
            }
            copy_entry(
                &entry.path(),
                &destination.join(name),
                include_manifest,
                false,
                progress,
                totals,
            )?;
        }
        fsync_dir(destination)?;
    } else if metadata.is_file() {
        let mut input = File::open(source)?;
        let mut output = create_private_file(destination)?;
        let mut buffer = [0_u8; 256 * 1024];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            totals.bytes_done = totals
                .bytes_done
                .checked_add(count as u64)
                .ok_or(StoreError::TooLarge)?;
        }
        output.sync_all()?;
        totals.files_done += 1;
        progress(*totals);
    } else {
        return Err(StoreError::Invalid("a store copy contains a special file"));
    }
    Ok(())
}

/// Copies a complete store layout into a new directory. The destination must not exist.
pub fn copy_tree(
    source: &Path,
    destination: &Path,
    include_manifest: bool,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<ExportProgress, StoreError> {
    let mut totals = ExportProgress::default();
    let mut last_reported = ExportProgress::default();
    copy_entry(
        source,
        destination,
        include_manifest,
        true,
        &mut |current| {
            if current.files_done == 1
                || current.files_done.saturating_sub(last_reported.files_done) >= 64
                || current.bytes_done.saturating_sub(last_reported.bytes_done) >= 16 * 1024 * 1024
            {
                progress(current);
                last_reported = current;
            }
        },
        &mut totals,
    )?;
    if totals != last_reported {
        progress(totals);
    }
    Ok(totals)
}

/// Exports an open store to a new timestamped subfolder of an owner-picked parent folder.
/// The whole copy holds a shared store lock; files are always new and private.
pub fn export_legacy(
    store: &Store,
    parent: &Path,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<ExportProgress, StoreError> {
    let _lock = store.read_lock()?;
    if !matches!(store.condition()?, StoreCondition::Ready(_)) {
        return Err(StoreError::Invalid("the app store is not ready for export"));
    }
    let metadata = fs::symlink_metadata(parent)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(StoreError::Invalid(
            "the export destination is not a folder",
        ));
    }
    let canonical_parent = fs::canonicalize(parent)?;
    let canonical_store = fs::canonicalize(store.store_dir())?;
    if canonical_parent.starts_with(&canonical_store) {
        return Err(StoreError::Invalid(
            "the export destination is inside the app store",
        ));
    }
    let name = format!(
        "duegood-export-{}-{}",
        utc_stamp(std::time::SystemTime::now()).compact,
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let output = parent.join(name);
    let result = copy_tree(&store.store_dir(), &output, false, progress);
    if result.is_err() {
        let _ = fs::remove_dir_all(&output);
    }
    result
}

/// Copies a demoted store while the caller holds its exclusive OS write lock.
///
/// The source is snapshotted before and after the copy, and the private export is compared as an
/// exact layout tree before success is reported. This keeps concurrent personal writes from
/// racing the rollback export and fails closed on any byte or path mismatch.
pub fn export_legacy_frozen(
    store: &Store,
    _write_lock: &WriteLock,
    parent: &Path,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<ExportProgress, StoreError> {
    match store.condition()? {
        StoreCondition::Ready(summary) if summary.state == crate::store::StoreState::Preview => {}
        _ => {
            return Err(StoreError::Invalid(
                "the app store is not a demoted preview",
            ))
        }
    }
    let metadata = fs::symlink_metadata(parent)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(StoreError::Invalid(
            "the export destination is not a folder",
        ));
    }
    let canonical_parent = fs::canonicalize(parent)?;
    let canonical_data_root = fs::canonicalize(store.data_root())?;
    if canonical_parent.starts_with(&canonical_data_root) {
        return Err(StoreError::Invalid(
            "the export destination is inside app data",
        ));
    }

    let source = store.store_dir();
    let name = format!(
        "duegood-rollback-{}-{}",
        utc_stamp(std::time::SystemTime::now()).compact,
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let output = parent.join(name);
    let result = (|| {
        let frozen_before = snapshot_layout_with_progress(&source, false, progress)?;
        let copied = copy_tree(&source, &output, false, progress)?;
        fsync_dir(parent)?;
        let source_after = snapshot_layout_with_progress(&source, false, progress)?;
        let exported = snapshot_layout_with_progress(&output, true, progress)?;
        if source_after != frozen_before || exported != frozen_before {
            return Err(StoreError::StoreChanged);
        }
        Ok(copied)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&output);
        let _ = fsync_dir(parent);
    }
    result
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use crate::testutil::TempRoot;

    #[test]
    fn tree_copy_progress_is_coalesced_and_ends_with_final_counts() {
        let root = TempRoot::new("copy-progress");
        let source = root.path().join("source");
        let destination = root.path().join("destination");
        create_private_dir(&source, false).unwrap();
        for index in 0..130 {
            fs::write(source.join(format!("file-{index:03}.txt")), b"synthetic").unwrap();
        }
        let mut events = Vec::new();

        let totals = copy_tree(&source, &destination, true, &mut |progress| {
            events.push(progress);
        })
        .unwrap();

        assert!(events.len() <= 4, "progress should be coalesced");
        assert_eq!(events.last(), Some(&totals));
        assert_eq!(totals.files_done, 130);
    }

    #[test]
    fn layout_snapshot_compares_file_bytes_and_empty_directories() {
        let root = TempRoot::new("layout-snapshot");
        let left = root.path().join("left");
        let right = root.path().join("right");
        create_private_dir(&left, false).unwrap();
        create_private_dir(&right, false).unwrap();
        fs::create_dir_all(left.join("classes/syn-101/materials/empty")).unwrap();
        fs::create_dir_all(right.join("classes/syn-101/materials/empty")).unwrap();
        fs::write(left.join("coursework.json"), b"synthetic exact bytes\n").unwrap();
        fs::write(right.join("coursework.json"), b"synthetic exact bytes\n").unwrap();
        fs::write(
            left.join("classes/syn-101/materials/file.bin"),
            b"synthetic material",
        )
        .unwrap();
        fs::write(
            right.join("classes/syn-101/materials/file.bin"),
            b"synthetic material",
        )
        .unwrap();
        assert_eq!(
            snapshot_layout(&left, false).unwrap(),
            snapshot_layout(&right, false).unwrap()
        );
        fs::remove_dir_all(right.join("classes/syn-101/materials/empty")).unwrap();
        assert_ne!(
            snapshot_layout(&left, false).unwrap(),
            snapshot_layout(&right, false).unwrap()
        );
    }
}

#[cfg(all(test, feature = "test-overrides"))]
mod tests {
    use super::*;
    use crate::config::{ImportLimits, TEST_BUNDLE_IDENTIFIER};
    use crate::import::{import_legacy_root, ImportOptions};
    use crate::testutil::{materialize_fixture, snapshot_tree, TempRoot};
    use std::time::Duration;

    #[test]
    fn exported_import_matches_source_layout() {
        let root = TempRoot::new("export");
        let source = materialize_fixture(&root.path().join("legacy"));
        fs::write(
            source.join("classes/syn-101/materials/synthetic.tmp"),
            b"legitimate material",
        )
        .unwrap();
        let store = Store::open(
            &root.path().join(TEST_BUNDLE_IDENTIFIER),
            Duration::from_millis(200),
        )
        .unwrap();
        let options = ImportOptions {
            limits: ImportLimits::PRODUCTION,
            legacy_lock_timeout: Duration::from_millis(200),
            replace_preview: false,
        };
        import_legacy_root(&store, &source, &options, &mut |_| {}).unwrap();
        fs::write(
            store.store_dir().join(".import-staging-orphan"),
            b"not coursework",
        )
        .unwrap();
        let output = root.path().join("output");
        create_private_dir(&output, false).unwrap();
        let progress = export_legacy(&store, &output, &mut |_| {}).unwrap();
        assert!(progress.files_done > 0);
        let folder = fs::read_dir(&output)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read(folder.join("classes/syn-101/materials/synthetic.tmp")).unwrap(),
            b"legitimate material"
        );
        assert_eq!(
            snapshot_tree(&folder),
            snapshot_tree(&store.store_dir())
                .into_iter()
                .filter(|(name, _)| name != MANIFEST_FILE && name != ".import-staging-orphan")
                .collect()
        );
        assert!(!folder.join(".import-staging-orphan").exists());
        crate::testutil::assert_private_tree(&folder);
    }

    /// Child helper for the TypeScript parity test; explicit temporary roots only.
    #[test]
    #[ignore]
    fn export_fixture_helper() {
        let source = std::env::var_os("DUEGOOD_EXPORT_TEST_SOURCE").expect("source");
        let destination = std::env::var_os("DUEGOOD_EXPORT_TEST_DESTINATION").expect("destination");
        let source = Path::new(&source);
        let destination = Path::new(&destination);
        assert!(source.is_absolute() && destination.is_absolute());
        assert!(
            source.starts_with(std::env::temp_dir())
                && destination.starts_with(std::env::temp_dir())
        );
        let store_root = destination.join(TEST_BUNDLE_IDENTIFIER);
        let store = Store::open(&store_root, Duration::from_millis(200)).unwrap();
        let options = ImportOptions {
            limits: ImportLimits::PRODUCTION,
            legacy_lock_timeout: Duration::from_millis(200),
            replace_preview: false,
        };
        import_legacy_root(&store, source, &options, &mut |_| {}).unwrap();
        create_private_dir(&destination.join("exports"), false).unwrap();
        export_legacy(&store, &destination.join("exports"), &mut |_| {}).unwrap();
    }
}
