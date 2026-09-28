//! Bounded private-file operations for browser resource exports.

use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::export::ExportProgress;
use crate::store::StoreError;

const MAX_BLOB_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct DirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    uid: u32,
}

pub(super) struct ExportedFile {
    path: PathBuf,
    file: Option<File>,
    complete: bool,
}

impl ExportedFile {
    pub(super) fn new(path: PathBuf, file: File) -> Self {
        Self {
            path,
            file: Some(file),
            complete: false,
        }
    }

    pub(super) fn file_mut(&mut self) -> Result<&mut File, StoreError> {
        self.file
            .as_mut()
            .ok_or(StoreError::Invalid("browser export file is unavailable"))
    }

    pub(super) fn mark_complete(&mut self) {
        self.complete = true;
        self.file.take();
    }
}

impl Drop for ExportedFile {
    fn drop(&mut self) {
        self.file.take();
        if !self.complete {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(super) struct ProgressReporter<'a> {
    totals: ExportProgress,
    last_reported_bytes: u64,
    last_reported_at: Instant,
    byte_cap: u64,
    byte_interval: u64,
    progress: &'a mut dyn FnMut(ExportProgress),
}

impl<'a> ProgressReporter<'a> {
    pub(super) fn new(
        totals: ExportProgress,
        progress: &'a mut dyn FnMut(ExportProgress),
        byte_cap: u64,
        byte_interval: u64,
    ) -> Self {
        Self {
            totals,
            last_reported_bytes: totals.bytes_done,
            last_reported_at: Instant::now(),
            byte_cap,
            byte_interval,
            progress,
        }
    }

    pub(super) fn add_bytes(&mut self, count: u64) -> Result<(), StoreError> {
        self.totals.bytes_done = self
            .totals
            .bytes_done
            .checked_add(count)
            .filter(|value| *value <= self.byte_cap)
            .ok_or(StoreError::TooLarge)?;
        if self
            .totals
            .bytes_done
            .saturating_sub(self.last_reported_bytes)
            >= self.byte_interval
            || self.last_reported_at.elapsed().as_millis() >= 100
        {
            self.report();
        }
        Ok(())
    }

    pub(super) fn add_file(&mut self) -> Result<(), StoreError> {
        self.totals.files_done = self
            .totals
            .files_done
            .checked_add(1)
            .ok_or(StoreError::TooLarge)?;
        Ok(())
    }

    pub(super) fn finish(&mut self) {
        if self.totals.bytes_done != self.last_reported_bytes
            || self.last_reported_at.elapsed().as_millis() >= 100
        {
            self.report();
        }
    }

    pub(super) fn totals(&self) -> ExportProgress {
        self.totals
    }

    fn report(&mut self) {
        (self.progress)(self.totals);
        self.last_reported_bytes = self.totals.bytes_done;
        self.last_reported_at = Instant::now();
    }
}

/// Reads a fixed relative document from a private root without following its final symlink.
pub(super) fn read_private_document(
    root: &Path,
    relative: &str,
    parents: &[PathBuf],
    cap: u64,
) -> Result<Option<Vec<u8>>, StoreError> {
    if !root.is_absolute() || !is_plain_relative(relative) {
        return Err(invalid("browser export document path is unsafe"));
    }
    let mut parent_ids = Vec::with_capacity(parents.len());
    for parent in parents {
        match verify_private_directory(parent) {
            Ok(identity) => parent_ids.push((parent.clone(), identity)),
            Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        }
    }
    let path = root.join(relative);
    let before = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    verify_private_document_metadata(&before, cap)?;
    let file = open_source_nofollow(&path)?;
    let opened = file.metadata()?;
    verify_private_document_metadata(&opened, cap)?;
    if !same_file(&before, &opened) {
        return Err(StoreError::StoreChanged);
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.take(cap.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > cap {
        return Err(StoreError::TooLarge);
    }
    let after = fs::symlink_metadata(&path)?;
    verify_private_document_metadata(&after, cap)?;
    if !same_file(&opened, &after) || after.len() != bytes.len() as u64 {
        return Err(StoreError::StoreChanged);
    }
    for (parent, identity) in parent_ids {
        verify_directory_identity(&parent, identity)?;
    }
    Ok(Some(bytes))
}

fn is_plain_relative(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && !value.is_empty()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn verify_private_document_metadata(metadata: &fs::Metadata, cap: u64) -> Result<(), StoreError> {
    if !metadata.is_file() || metadata.len() > cap {
        return Err(invalid("browser export document is unsafe"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
        {
            return Err(invalid("browser export document is not private"));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(invalid(
            "browser export document ownership cannot be verified",
        ))
    }
}

pub(super) fn verify_private_directory(path: &Path) -> Result<DirectoryIdentity, StoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid("browser export directory is unsafe"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o7777 != 0o700
        {
            return Err(invalid("browser export directory is not private"));
        }
        Ok(DirectoryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
        })
    }
    #[cfg(not(unix))]
    {
        Err(invalid(
            "browser export directory ownership cannot be verified",
        ))
    }
}

pub(super) fn verify_directory_identity(
    path: &Path,
    expected: DirectoryIdentity,
) -> Result<(), StoreError> {
    if verify_private_directory(path)? != expected {
        return Err(invalid("browser export directory changed during copy"));
    }
    Ok(())
}

pub(super) fn verify_private_file(
    metadata: &fs::Metadata,
    expected_size: u64,
) -> Result<(), StoreError> {
    if !metadata.is_file() || metadata.len() != expected_size || expected_size > MAX_BLOB_BYTES {
        return Err(invalid("browser resource blob is unsafe"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
        {
            return Err(invalid("browser resource blob is not private"));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(invalid("browser resource ownership cannot be verified"))
    }
}

pub(super) fn open_source_nofollow(path: &Path) -> Result<File, StoreError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options.open(path).map_err(StoreError::from)
}

pub(super) fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
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

pub(super) fn create_private_directory(path: &Path) -> Result<(), StoreError> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    verify_private_directory(path)?;
    Ok(())
}

pub(super) fn sync_directory(path: &Path) -> Result<(), StoreError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

pub(super) fn hex_digest(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn invalid(message: &'static str) -> StoreError {
    StoreError::Invalid(message)
}
