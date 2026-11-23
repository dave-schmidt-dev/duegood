//! Anchored, no-follow filesystem operations for Canvas Markdown exports.

use super::{same_node, CourseFolder, MARKER, MAX_EXPORT_BYTES};
#[cfg(unix)]
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path};
pub(super) enum ItemWrite {
    Written,
    Unchanged,
    OwnerFile,
    Failed,
}

#[cfg(unix)]
pub(super) fn write_item_file(
    folder: &CourseFolder,
    relative_directory: &Path,
    content: &str,
) -> ItemWrite {
    write_item_file_with_hook(folder, relative_directory, content, || {})
}

#[cfg(unix)]
pub(super) fn write_item_file_with_hook<F>(
    folder: &CourseFolder,
    relative_directory: &Path,
    content: &str,
    before_replace: F,
) -> ItemWrite
where
    F: FnOnce(),
{
    let Some(root) = open_export_root(folder) else {
        return ItemWrite::Failed;
    };
    let Some(directory) = ensure_owned_directory(&root, relative_directory) else {
        return ItemWrite::Failed;
    };
    let Some(name) = c_string(std::ffi::OsStr::new("README.md")) else {
        return ItemWrite::Failed;
    };
    let current = match read_existing_at(&directory, &name) {
        Ok(Some((bytes, _identity))) if !has_marker(&bytes) => return ItemWrite::OwnerFile,
        Ok(Some((bytes, identity))) => Some((bytes, identity)),
        Ok(None) => None,
        Err(()) => return ItemWrite::Failed,
    };
    if current
        .as_ref()
        .is_some_and(|(bytes, _)| bytes == content.as_bytes())
    {
        return ItemWrite::Unchanged;
    }

    let temporary_text = format!(".README-{}.tmp", uuid::Uuid::new_v4().simple());
    let Some(temporary) = c_string(std::ffi::OsStr::new(&temporary_text)) else {
        return ItemWrite::Failed;
    };
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return ItemWrite::Failed;
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let temporary_identity = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return ItemWrite::Failed,
    };
    let temporary_stat = match metadata_stat(&file) {
        Ok(stat) => stat,
        Err(_) => return ItemWrite::Failed,
    };
    let wrote = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all());
    if wrote.is_err() {
        drop(file);
        unlink_if_same_stat(&directory, &temporary, &temporary_stat);
        return ItemWrite::Failed;
    }
    drop(file);

    if let Some((_bytes, expected)) = current {
        let rechecked = match read_existing_at(&directory, &name) {
            Ok(Some((bytes, identity)))
                if has_marker(&bytes) && same_node(&expected, &identity) =>
            {
                true
            }
            _ => false,
        };
        if !rechecked {
            unlink_if_same_stat(&directory, &temporary, &temporary_stat);
            return ItemWrite::Failed;
        }
        before_replace();
        if !exchange_at(&directory, &name, &temporary) {
            unlink_if_same_stat(&directory, &temporary, &temporary_stat);
            return ItemWrite::Failed;
        }

        let displaced_stat = stat_at(&directory, &temporary).ok();
        let displaced = read_existing_at(&directory, &temporary);
        let displaced_is_expected = matches!(
            &displaced,
            Ok(Some((bytes, identity)))
                if has_marker(bytes) && same_node(&expected, identity)
        );
        if displaced_is_expected {
            if !unlink_if_same_metadata(&directory, &temporary, &expected) {
                return ItemWrite::Failed;
            }
        } else {
            let verified_owner = matches!(
                &displaced,
                Ok(Some((bytes, identity)))
                    if !has_marker(bytes)
                        && displaced_stat.as_ref().is_some_and(|stat| {
                            stat_matches_metadata(stat, identity)
                        })
            );
            let restored = if let Some(displaced_stat) = displaced_stat {
                restore_displaced_entry(
                    &directory,
                    &name,
                    &temporary,
                    &displaced_stat,
                    &temporary_stat,
                )
            } else {
                false
            };
            return if verified_owner && restored {
                ItemWrite::OwnerFile
            } else {
                ItemWrite::Failed
            };
        }
    } else {
        // linkat publishes a new file only if the path is still absent.
        let result = unsafe {
            libc::linkat(
                directory.as_raw_fd(),
                temporary.as_ptr(),
                directory.as_raw_fd(),
                name.as_ptr(),
                0,
            )
        };
        if result != 0 {
            unlink_if_same_stat(&directory, &temporary, &temporary_stat);
            return ItemWrite::Failed;
        }
        if !unlink_if_same_stat(&directory, &temporary, &temporary_stat) {
            return ItemWrite::Failed;
        }
    }
    let installed = match read_existing_at(&directory, &name) {
        Ok(Some((_bytes, identity))) => same_node(&temporary_identity, &identity),
        _ => false,
    };
    if !installed || directory.sync_all().is_err() {
        return ItemWrite::Failed;
    }
    ItemWrite::Written
}

#[cfg(unix)]
fn exchange_at(parent: &File, left: &CString, right: &CString) -> bool {
    let result = unsafe {
        #[cfg(target_os = "macos")]
        {
            libc::renameatx_np(
                parent.as_raw_fd(),
                left.as_ptr(),
                parent.as_raw_fd(),
                right.as_ptr(),
                libc::RENAME_SWAP,
            )
        }
        #[cfg(target_os = "linux")]
        {
            libc::renameat2(
                parent.as_raw_fd(),
                left.as_ptr(),
                parent.as_raw_fd(),
                right.as_ptr(),
                libc::RENAME_EXCHANGE,
            )
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            -1
        }
    };
    result == 0
}

#[cfg(unix)]
fn restore_displaced_entry(
    parent: &File,
    target: &CString,
    temporary: &CString,
    displaced_stat: &libc::stat,
    temporary_stat: &libc::stat,
) -> bool {
    let target_unchanged =
        stat_at(parent, target).is_ok_and(|stat| same_stat(&stat, temporary_stat));
    let displaced_unchanged =
        stat_at(parent, temporary).is_ok_and(|stat| same_stat(&stat, displaced_stat));
    if !target_unchanged || !displaced_unchanged || !exchange_at(parent, target, temporary) {
        return false;
    }
    let target_restored =
        stat_at(parent, target).is_ok_and(|stat| same_stat(&stat, displaced_stat));
    let temporary_is_ours =
        stat_at(parent, temporary).is_ok_and(|stat| same_stat(&stat, temporary_stat));
    target_restored && temporary_is_ours && unlink_if_same_stat(parent, temporary, temporary_stat)
}

#[cfg(unix)]
fn unlink_if_same_metadata(parent: &File, name: &CString, expected: &fs::Metadata) -> bool {
    match stat_at(parent, name) {
        Ok(stat) if stat_matches_metadata(&stat, expected) => unsafe {
            libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) == 0
        },
        _ => false,
    }
}

#[cfg(unix)]
fn stat_matches_metadata(stat: &libc::stat, metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    stat.st_dev as u64 == metadata.dev()
        && stat.st_ino == metadata.ino()
        && stat.st_mode & libc::S_IFMT == metadata.mode() as libc::mode_t & libc::S_IFMT
}

#[cfg(unix)]
fn unlink_if_same_stat(parent: &File, name: &CString, expected: &libc::stat) -> bool {
    match stat_at(parent, name) {
        Ok(stat) if same_stat(&stat, expected) => unsafe {
            libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) == 0
        },
        _ => false,
    }
}

#[cfg(not(unix))]
pub(super) fn write_item_file(
    _folder: &CourseFolder,
    _relative_directory: &Path,
    _content: &str,
) -> ItemWrite {
    ItemWrite::Failed
}

#[cfg(unix)]
fn open_export_root(folder: &CourseFolder) -> Option<File> {
    let before = fs::symlink_metadata(&folder.canonical).ok()?;
    if !before.is_dir() || before.file_type().is_symlink() {
        return None;
    }
    let opened = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&folder.canonical)
        .ok()?;
    let after = fs::symlink_metadata(&folder.canonical).ok()?;
    (same_node(&before, &opened.metadata().ok()?) && same_node(&before, &after)).then_some(opened)
}

#[cfg(unix)]
fn ensure_owned_directory(root: &File, relative: &Path) -> Option<File> {
    if !relative.is_relative() {
        return None;
    }
    let mut parent = root.try_clone().ok()?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        let name = c_string(name)?;
        let before = stat_at(&parent, &name).ok();
        if before.is_none() {
            let created = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
            if created != 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return None;
            }
        }
        let opened = open_directory_at(&parent, &name).ok()?;
        let after = stat_at(&parent, &name).ok()?;
        if let Some(before) = before {
            if !same_stat(&before, &after) || !same_stat(&after, &metadata_stat(&opened).ok()?) {
                return None;
            }
        } else if !same_stat(&after, &metadata_stat(&opened).ok()?) {
            return None;
        }
        parent = opened;
    }
    Some(parent)
}

#[cfg(unix)]
fn c_string(name: &std::ffi::OsStr) -> Option<CString> {
    CString::new(name.as_bytes()).ok()
}

#[cfg(unix)]
fn open_directory_at(parent: &File, name: &CString) -> std::io::Result<File> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn stat_at(parent: &File, name: &CString) -> std::io::Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { stat.assume_init() })
}

#[cfg(unix)]
fn metadata_stat(file: &File) -> std::io::Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { stat.assume_init() })
}

#[cfg(unix)]
fn same_stat(left: &libc::stat, right: &libc::stat) -> bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino && left.st_mode == right.st_mode
}

#[cfg(unix)]
fn read_existing_at(parent: &File, name: &CString) -> Result<Option<(Vec<u8>, fs::Metadata)>, ()> {
    let before = match stat_at(parent, name) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    if before.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(());
    }
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let opened = file.metadata().map_err(|_| ())?;
    if !opened.is_file() {
        return Err(());
    }
    let opened_stat = metadata_stat(&file).map_err(|_| ())?;
    let after = stat_at(parent, name).map_err(|_| ())?;
    if !same_stat(&before, &opened_stat) || !same_stat(&before, &after) {
        return Err(());
    }
    let mut prefix = Vec::with_capacity(MARKER.len() + 1);
    (&mut file)
        .take((MARKER.len() + 1) as u64)
        .read_to_end(&mut prefix)
        .map_err(|_| ())?;
    if !has_marker(&prefix) {
        let after_prefix = stat_at(parent, name).map_err(|_| ())?;
        return if same_stat(&before, &after_prefix) {
            Ok(Some((prefix, opened)))
        } else {
            Err(())
        };
    }
    let opened = file.metadata().map_err(|_| ())?;
    if opened.len() > MAX_EXPORT_BYTES as u64 {
        return Err(());
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| ())?;
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(MAX_EXPORT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err(());
    }
    Ok(Some((bytes, opened)))
}

fn has_marker(bytes: &[u8]) -> bool {
    bytes.split(|byte| *byte == b'\n').next() == Some(MARKER.as_bytes())
}
