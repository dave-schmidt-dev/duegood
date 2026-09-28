//! Race-resistant copying and quarantine for native archive downloads.

use std::fs::{self, File};
use std::io;
use std::path::Path;

#[cfg(unix)]
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::io::{Read, Write};

use crate::store::StoreError;

#[cfg(unix)]
const MAX_ARCHIVED_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;
#[cfg(unix)]
const ARCHIVE_COPY_CHUNK_BYTES: usize = 1024 * 1024;

pub(super) struct ArchivedReceipt {
    pub(super) sha256: String,
    pub(super) byte_count: u64,
}

#[cfg(unix)]
pub(super) fn copy_verified_archive_file(
    path: &Path,
    receipt: &ArchivedReceipt,
    target: &mut File,
) -> Result<(), StoreError> {
    if receipt.sha256.len() != 64
        || !receipt
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || receipt.byte_count == 0
        || receipt.byte_count > MAX_ARCHIVED_RESOURCE_BYTES
    {
        return Err(StoreError::Invalid("invalid archived library receipt"));
    }

    let path_before = fs::symlink_metadata(path)?;
    verify_private_archive_file(&path_before, receipt.byte_count)?;
    let mut options = OpenOptions::new();
    options.read(true);
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut source = options.open(path)?;
    let source_metadata = source.metadata()?;
    verify_private_archive_file(&source_metadata, receipt.byte_count)?;
    if !same_file_identity(&path_before, &source_metadata) {
        return Err(StoreError::Invalid("archived library file changed"));
    }

    let mut digest = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; ARCHIVE_COPY_CHUNK_BYTES];
    while copied < receipt.byte_count {
        let remaining = receipt.byte_count - copied;
        let limit = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| StoreError::Invalid("archived library file is too large"))?;
        let read = source.read(&mut buffer[..limit])?;
        if read == 0 {
            return Err(StoreError::Invalid("archived library file changed"));
        }
        target.write_all(&buffer[..read])?;
        digest.update(&buffer[..read]);
        copied = copied
            .checked_add(read as u64)
            .ok_or(StoreError::Invalid("archived library file is too large"))?;
    }
    let mut extra = [0_u8; 1];
    if source.read(&mut extra)? != 0 {
        return Err(StoreError::Invalid("archived library file changed"));
    }
    if format!("{:x}", digest.finalize()) != receipt.sha256 {
        return Err(StoreError::Invalid(
            "archived library file failed verification",
        ));
    }

    let path_after = fs::symlink_metadata(path)?;
    verify_private_archive_file(&path_after, receipt.byte_count)?;
    if !same_file_identity(&source_metadata, &path_after) {
        return Err(StoreError::Invalid("archived library file changed"));
    }
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn copy_verified_archive_file(
    _path: &Path,
    _receipt: &ArchivedReceipt,
    _target: &mut File,
) -> Result<(), StoreError> {
    Err(StoreError::Invalid(
        "archived resource cannot be opened safely",
    ))
}

fn verify_private_archive_file(
    metadata: &fs::Metadata,
    expected_size: u64,
) -> Result<(), StoreError> {
    if !metadata.file_type().is_file() || metadata.len() != expected_size {
        return Err(StoreError::Invalid("archived library file is unsafe"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
        {
            return Err(StoreError::Invalid("archived library file is unsafe"));
        }
    }
    Ok(())
}

pub(super) fn ensure_destination_is_open_file(path: &Path, file: &File) -> Result<(), StoreError> {
    let opened = file.metadata()?;
    verify_private_archive_file(&opened, opened.len())?;
    let named = fs::symlink_metadata(path)?;
    verify_private_archive_file(&named, opened.len())?;
    if !same_file_identity(&opened, &named) {
        return Err(StoreError::Invalid("saved library file changed"));
    }
    Ok(())
}

fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right);
        false
    }
}

pub(super) fn remove_destination_if_same_file(path: &Path, created: &fs::Metadata) {
    if fs::symlink_metadata(path)
        .ok()
        .is_some_and(|named| same_file_identity(created, &named))
    {
        let _ = fs::remove_file(path);
    }
}

pub(super) fn quarantine_saved_copy(file: &File) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let attribute = b"com.apple.quarantine\0";
        let value = b"0083;00000000;DueGood;";
        let result = unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                attribute.as_ptr().cast(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = file;
    }
    Ok(())
}
