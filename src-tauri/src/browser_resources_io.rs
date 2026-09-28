//! Owner-only filesystem and streaming hash operations for browser resource blobs.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::browser_resources::{BlobRef, ResourceArchiveError};
use crate::capture_media::{verify_content_type, MediaError};

pub(super) const ARCHIVE_NAME: &str = "canvas-resource-archive";
pub(super) const BLOBS_NAME: &str = "blobs";
pub(super) const CHUNK_BYTES: usize = 1024 * 1024;
const PREFIX_BYTES: usize = 8 * 1024;
const MAX_PENDING_ENTRIES: usize = 128;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct DirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    uid: u32,
}

pub(super) fn inventory_blobs(
    directory: &Path,
    per_blob: u64,
) -> Result<BTreeMap<String, u64>, ResourceArchiveError> {
    let mut entries = BTreeMap::new();
    let mut pending_count = 0_usize;
    let mut removed_pending = false;
    for entry in fs::read_dir(directory).map_err(|_| ResourceArchiveError::Io)? {
        let entry = entry.map_err(|_| ResourceArchiveError::Io)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| ResourceArchiveError::UnsafeFile)?;
        if is_pending_name(&name) {
            pending_count += 1;
            if pending_count > MAX_PENDING_ENTRIES {
                return Err(ResourceArchiveError::UnsafeFile);
            }
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| ResourceArchiveError::Io)?;
            verify_private_file_metadata(&metadata, per_blob)?;
            fs::remove_file(entry.path()).map_err(|_| ResourceArchiveError::Io)?;
            removed_pending = true;
            continue;
        }
        if !is_hash(&name) {
            return Err(ResourceArchiveError::UnsafeFile);
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| ResourceArchiveError::Io)?;
        verify_private_file_metadata(&metadata, per_blob)?;
        entries.insert(name, metadata.len());
    }
    if removed_pending {
        sync_directory(directory)?;
    }
    Ok(entries)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn copy_verified_blob<F>(
    source: &Path,
    source_directory: &Path,
    source_identity: DirectoryIdentity,
    blobs_directory: &Path,
    blobs_identity: DirectoryIdentity,
    destination: &Path,
    reference: &BlobRef,
    content_types: &[String],
    per_blob: u64,
    bytes_before: u64,
    total: u64,
    progress: &mut F,
) -> Result<(), ResourceArchiveError>
where
    F: FnMut(u64, u64),
{
    verify_directory_identity(source_directory, source_identity)?;
    let source_before =
        fs::symlink_metadata(source).map_err(|_| ResourceArchiveError::MissingSource)?;
    verify_private_file_metadata(&source_before, per_blob)?;
    if source_before.len() != reference.byte_count {
        return Err(ResourceArchiveError::BlobMismatch);
    }
    let mut input = open_readonly_nofollow(source)?;
    let input_metadata = input.metadata().map_err(|_| ResourceArchiveError::Io)?;
    verify_private_file_metadata(&input_metadata, per_blob)?;
    if !same_file(&source_before, &input_metadata) {
        return Err(ResourceArchiveError::UnsafeFile);
    }

    let pending = blobs_directory.join(format!(".pending-{}.tmp", Uuid::new_v4().simple()));
    let mut staged = PendingBlob::create(&pending)?;
    let mut digest = Sha256::new();
    let mut prefix = Vec::with_capacity(PREFIX_BYTES);
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    let mut count = 0_u64;
    loop {
        verify_directory_identity(blobs_directory, blobs_identity)?;
        let read = input
            .read(&mut buffer)
            .map_err(|_| ResourceArchiveError::Io)?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read as u64)
            .ok_or(ResourceArchiveError::BlobTooLarge)?;
        if count > reference.byte_count || count > per_blob {
            return Err(ResourceArchiveError::BlobMismatch);
        }
        let chunk = &buffer[..read];
        if prefix.len() < PREFIX_BYTES {
            let take = (PREFIX_BYTES - prefix.len()).min(read);
            prefix.extend_from_slice(&chunk[..take]);
        }
        digest.update(chunk);
        staged
            .file_mut()?
            .write_all(chunk)
            .map_err(|_| ResourceArchiveError::Io)?;
        progress(bytes_before.saturating_add(count).min(total), total);
    }
    if count != reference.byte_count || hex_digest(digest.finalize().as_slice()) != reference.sha256
    {
        return Err(ResourceArchiveError::BlobMismatch);
    }
    validate_media_types(content_types, &prefix)?;
    let source_after =
        fs::symlink_metadata(source).map_err(|_| ResourceArchiveError::MissingSource)?;
    if !same_file(&input_metadata, &source_after) || source_after.len() != reference.byte_count {
        return Err(ResourceArchiveError::UnsafeFile);
    }
    verify_directory_identity(source_directory, source_identity)?;
    staged
        .file_mut()?
        .sync_all()
        .map_err(|_| ResourceArchiveError::Io)?;
    staged.verify_private(per_blob)?;
    verify_directory_identity(blobs_directory, blobs_identity)?;
    match fs::symlink_metadata(destination) {
        Ok(_) => return Err(ResourceArchiveError::BlobMismatch),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(ResourceArchiveError::Io),
    }
    fs::rename(&pending, destination).map_err(|_| ResourceArchiveError::Io)?;
    staged.mark_renamed();
    sync_directory(blobs_directory)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn verify_blob_file<F>(
    path: &Path,
    expected_hash: &str,
    expected_size: u64,
    content_types: &[String],
    per_blob: u64,
    bytes_before: u64,
    total: u64,
    progress: &mut F,
) -> Result<(), ResourceArchiveError>
where
    F: FnMut(u64, u64),
{
    let before = fs::symlink_metadata(path).map_err(|_| ResourceArchiveError::MissingSource)?;
    verify_private_file_metadata(&before, per_blob)?;
    if before.len() != expected_size {
        return Err(ResourceArchiveError::BlobMismatch);
    }
    let mut file = open_readonly_nofollow(path)?;
    let opened = file.metadata().map_err(|_| ResourceArchiveError::Io)?;
    verify_private_file_metadata(&opened, per_blob)?;
    if !same_file(&before, &opened) {
        return Err(ResourceArchiveError::UnsafeFile);
    }
    let mut digest = Sha256::new();
    let mut prefix = Vec::with_capacity(PREFIX_BYTES);
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    let mut count = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| ResourceArchiveError::Io)?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read as u64)
            .ok_or(ResourceArchiveError::BlobTooLarge)?;
        if count > expected_size || count > per_blob {
            return Err(ResourceArchiveError::BlobMismatch);
        }
        let chunk = &buffer[..read];
        if prefix.len() < PREFIX_BYTES {
            let take = (PREFIX_BYTES - prefix.len()).min(read);
            prefix.extend_from_slice(&chunk[..take]);
        }
        digest.update(chunk);
        progress(bytes_before.saturating_add(count).min(total), total);
    }
    if count != expected_size || hex_digest(digest.finalize().as_slice()) != expected_hash {
        return Err(ResourceArchiveError::BlobMismatch);
    }
    validate_media_types(content_types, &prefix)?;
    let after = fs::symlink_metadata(path).map_err(|_| ResourceArchiveError::MissingSource)?;
    if !same_file(&opened, &after) || after.len() != expected_size {
        return Err(ResourceArchiveError::UnsafeFile);
    }
    Ok(())
}

fn validate_media(content_type: &str, prefix: &[u8]) -> Result<(), ResourceArchiveError> {
    verify_content_type(Some(content_type), prefix)
        .map(|_| ())
        .map_err(|error| match error {
            MediaError::SignInResponse | MediaError::MimeSignatureMismatch => {
                ResourceArchiveError::UnsupportedMedia
            }
        })
}

fn validate_media_types(
    content_types: &[String],
    prefix: &[u8],
) -> Result<(), ResourceArchiveError> {
    if content_types.is_empty() {
        return Err(ResourceArchiveError::InvalidReceipt);
    }
    for content_type in content_types {
        validate_media(content_type, prefix)?;
    }
    Ok(())
}

struct PendingBlob {
    path: PathBuf,
    file: Option<File>,
    renamed: bool,
}

impl PendingBlob {
    fn create(path: &Path) -> Result<Self, ResourceArchiveError> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options.open(path).map_err(|_| ResourceArchiveError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| ResourceArchiveError::Io)?;
        }
        Ok(Self {
            path: path.to_path_buf(),
            file: Some(file),
            renamed: false,
        })
    }

    fn file_mut(&mut self) -> Result<&mut File, ResourceArchiveError> {
        self.file.as_mut().ok_or(ResourceArchiveError::Io)
    }

    fn verify_private(&self, limit: u64) -> Result<(), ResourceArchiveError> {
        let file = self.file.as_ref().ok_or(ResourceArchiveError::Io)?;
        let metadata = file.metadata().map_err(|_| ResourceArchiveError::Io)?;
        verify_private_file_metadata(&metadata, limit)
    }

    fn mark_renamed(&mut self) {
        self.renamed = true;
        self.file.take();
    }
}

impl Drop for PendingBlob {
    fn drop(&mut self) {
        self.file.take();
        if !self.renamed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(super) fn ensure_private_child(
    parent: &Path,
    name: &str,
) -> Result<PathBuf, ResourceArchiveError> {
    let path = parent.join(name);
    match fs::create_dir(&path) {
        Ok(()) => set_private_directory_mode(&path)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(ResourceArchiveError::Io),
    }
    verify_private_directory(&path)?;
    Ok(path)
}

pub(super) fn verify_private_directory(
    path: &Path,
) -> Result<DirectoryIdentity, ResourceArchiveError> {
    if !path.is_absolute() {
        return Err(ResourceArchiveError::UnsafeDirectory);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| ResourceArchiveError::UnsafeDirectory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ResourceArchiveError::UnsafeDirectory);
    }
    let canonical = fs::canonicalize(path).map_err(|_| ResourceArchiveError::UnsafeDirectory)?;
    if canonical.as_path() != path {
        return Err(ResourceArchiveError::UnsafeDirectory);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o7777 != 0o700
        {
            return Err(ResourceArchiveError::UnsafeDirectory);
        }
        Ok(DirectoryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Err(ResourceArchiveError::UnsafeDirectory)
    }
}

pub(super) fn verify_directory_identity(
    path: &Path,
    identity: DirectoryIdentity,
) -> Result<(), ResourceArchiveError> {
    if verify_private_directory(path)? != identity {
        return Err(ResourceArchiveError::UnsafeDirectory);
    }
    Ok(())
}

fn set_private_directory_mode(path: &Path) -> Result<(), ResourceArchiveError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| ResourceArchiveError::Io)?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        return Err(ResourceArchiveError::UnsafeDirectory);
    }
    Ok(())
}

fn verify_private_file_metadata(
    metadata: &fs::Metadata,
    maximum: u64,
) -> Result<(), ResourceArchiveError> {
    if !metadata.is_file() || metadata.len() > maximum {
        return Err(ResourceArchiveError::UnsafeFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
        {
            return Err(ResourceArchiveError::UnsafeFile);
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Err(ResourceArchiveError::UnsafeFile)
    }
}

fn open_readonly_nofollow(path: &Path) -> Result<File, ResourceArchiveError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options
        .open(path)
        .map_err(|_| ResourceArchiveError::UnsafeFile)
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

pub(super) fn sync_directory(path: &Path) -> Result<(), ResourceArchiveError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ResourceArchiveError::Io)
}

pub(super) fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_pending_name(value: &str) -> bool {
    let Some(id) = value
        .strip_prefix(".pending-")
        .and_then(|name| name.strip_suffix(".tmp"))
    else {
        return false;
    };
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex_digest(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}
