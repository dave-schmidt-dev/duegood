//! Private staging for verified Canvas download bytes.
//!
//! This module only stages one downloaded blob. Durable archive promotion happens later, after a
//! complete capture manifest has been validated.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use uuid::Uuid;

pub use crate::capture_media::{verify_content_type, MediaError};

/// Content-free staging failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagingError {
    UnsafeDirectory,
    CreateFailed,
    WriteFailed,
}

/// A private directory supplied by the local collector for this capture's temporary blobs.
pub struct StagingDirectory {
    path: PathBuf,
    identity: DirectoryIdentity,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct DirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    uid: u32,
}

/// Metadata for a completed staging blob. The basename is an opaque generated identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedBlob {
    pub basename: String,
    pub byte_count: u64,
    pub sha256: String,
}

/// A not-yet-published staging file, removed automatically unless committed.
pub struct StagedFile {
    directory: PathBuf,
    identity: DirectoryIdentity,
    temporary_path: PathBuf,
    final_path: PathBuf,
    final_basename: String,
    file: Option<File>,
    committed: bool,
}

/// An owner-only `.part` file created by the authenticated browser transfer helper.
pub(crate) struct BrowserStagedSource {
    path: PathBuf,
    file: File,
    identity: BrowserFileIdentity,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct BrowserFileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    uid: u32,
    length: u64,
    #[cfg(unix)]
    modified_seconds: i64,
    #[cfg(unix)]
    modified_nanoseconds: i64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

impl StagingDirectory {
    /// Opens an existing owner-only `0700` directory and records its filesystem identity.
    pub fn open(path: &Path) -> Result<Self, StagingError> {
        if !path.is_absolute() {
            return Err(StagingError::UnsafeDirectory);
        }
        let supplied = fs::symlink_metadata(path).map_err(|_| StagingError::UnsafeDirectory)?;
        if supplied.file_type().is_symlink() || !supplied.is_dir() {
            return Err(StagingError::UnsafeDirectory);
        }
        let canonical = fs::canonicalize(path).map_err(|_| StagingError::UnsafeDirectory)?;
        let metadata = fs::metadata(&canonical).map_err(|_| StagingError::UnsafeDirectory)?;
        let identity = checked_identity(&metadata)?;
        Ok(Self {
            path: canonical,
            identity,
        })
    }

    /// Creates a private temporary file and reserves an opaque final basename.
    pub fn create_file(&self) -> Result<StagedFile, StagingError> {
        self.verify_identity()?;
        let id = Uuid::new_v4().simple().to_string();
        let temporary_path = self.path.join(format!(".duegood-{id}.part"));
        let final_basename = format!("{id}.blob");
        let final_path = self.path.join(&final_basename);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&temporary_path)
            .map_err(|_| StagingError::CreateFailed)?;
        Ok(StagedFile {
            directory: self.path.clone(),
            identity: self.identity,
            temporary_path,
            final_path,
            final_basename,
            file: Some(file),
            committed: false,
        })
    }

    /// Opens the exact owner-only browser staging file shape inside this staging directory.
    /// The source is opened without following symlinks and its path/inode/metadata are checked
    /// again after copying before it can be removed.
    pub(crate) fn open_browser_source(
        &self,
        path: &Path,
    ) -> Result<BrowserStagedSource, StagingError> {
        self.verify_identity()?;
        if !path.is_absolute() || !is_browser_stage_name(path.file_name()) {
            return Err(StagingError::UnsafeDirectory);
        }
        let parent = path.parent().ok_or(StagingError::UnsafeDirectory)?;
        if fs::canonicalize(parent).map_err(|_| StagingError::UnsafeDirectory)? != self.path {
            return Err(StagingError::UnsafeDirectory);
        }
        let canonical_path = self
            .path
            .join(path.file_name().ok_or(StagingError::UnsafeDirectory)?);
        let before =
            fs::symlink_metadata(&canonical_path).map_err(|_| StagingError::UnsafeDirectory)?;
        let before_identity = browser_file_identity(&before)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options
            .open(&canonical_path)
            .map_err(|_| StagingError::UnsafeDirectory)?;
        let opened = file.metadata().map_err(|_| StagingError::UnsafeDirectory)?;
        let opened_identity = browser_file_identity(&opened)?;
        if opened_identity != before_identity {
            return Err(StagingError::UnsafeDirectory);
        }
        self.verify_identity()?;
        Ok(BrowserStagedSource {
            path: canonical_path,
            file,
            identity: opened_identity,
        })
    }

    /// Removes one opaque blob previously committed by this staging directory.
    pub(crate) fn remove_committed_blob(&self, basename: &str) -> Result<(), StagingError> {
        self.verify_identity()?;
        if !is_opaque_blob_name(basename) {
            return Err(StagingError::UnsafeDirectory);
        }
        let path = self.path.join(basename);
        let metadata = fs::symlink_metadata(&path).map_err(|_| StagingError::UnsafeDirectory)?;
        let _ = browser_file_identity(&metadata)?;
        fs::remove_file(path).map_err(|_| StagingError::WriteFailed)?;
        sync_directory(&self.path).map_err(|_| StagingError::WriteFailed)
    }

    fn verify_identity(&self) -> Result<(), StagingError> {
        let metadata =
            fs::symlink_metadata(&self.path).map_err(|_| StagingError::UnsafeDirectory)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(StagingError::UnsafeDirectory);
        }
        if checked_identity(&metadata)? != self.identity {
            return Err(StagingError::UnsafeDirectory);
        }
        Ok(())
    }
}

impl BrowserStagedSource {
    pub(crate) fn file_mut(&mut self) -> &mut File {
        &mut self.file
    }

    /// Confirms the open file and named entry still identify the same unchanged source bytes.
    pub(crate) fn verify_unchanged(&self, staging: &StagingDirectory) -> Result<(), StagingError> {
        staging.verify_identity()?;
        let opened = self
            .file
            .metadata()
            .map_err(|_| StagingError::UnsafeDirectory)?;
        let named = fs::symlink_metadata(&self.path).map_err(|_| StagingError::UnsafeDirectory)?;
        if browser_file_identity(&opened)? != self.identity
            || browser_file_identity(&named)? != self.identity
        {
            return Err(StagingError::UnsafeDirectory);
        }
        Ok(())
    }

    /// Removes the temporary browser source only after the native staged copy has been committed.
    pub(crate) fn remove(self, staging: &StagingDirectory) -> Result<(), StagingError> {
        self.verify_unchanged(staging)?;
        fs::remove_file(&self.path).map_err(|_| StagingError::WriteFailed)?;
        sync_directory(&staging.path).map_err(|_| StagingError::WriteFailed)
    }
}

fn is_browser_stage_name(name: Option<&std::ffi::OsStr>) -> bool {
    let Some(name) = name.and_then(|value| value.to_str()) else {
        return false;
    };
    let Some(id) = name
        .strip_prefix(".duegood-browser-")
        .and_then(|value| value.strip_suffix(".part"))
    else {
        return false;
    };
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
}

fn is_opaque_blob_name(name: &str) -> bool {
    let Some(id) = name.strip_suffix(".blob") else {
        return false;
    };
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.simple().to_string() == id)
}

fn browser_file_identity(metadata: &fs::Metadata) -> Result<BrowserFileIdentity, StagingError> {
    if !metadata.is_file() {
        return Err(StagingError::UnsafeDirectory);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
        {
            return Err(StagingError::UnsafeDirectory);
        }
        Ok(BrowserFileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
            length: metadata.len(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Err(StagingError::UnsafeDirectory)
    }
}

impl StagedFile {
    /// Returns the open file so the downloader can stream bounded chunks into it.
    pub fn file_mut(&mut self) -> Result<&mut File, StagingError> {
        self.file.as_mut().ok_or(StagingError::WriteFailed)
    }

    /// Flushes and atomically publishes the completed file under its opaque basename.
    pub fn commit(mut self, byte_count: u64, sha256: String) -> Result<StagedBlob, StagingError> {
        let metadata =
            fs::symlink_metadata(&self.directory).map_err(|_| StagingError::UnsafeDirectory)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || checked_identity(&metadata)? != self.identity
        {
            return Err(StagingError::UnsafeDirectory);
        }

        let file = self.file.take().ok_or(StagingError::WriteFailed)?;
        file.sync_all().map_err(|_| StagingError::WriteFailed)?;
        drop(file);
        fs::hard_link(&self.temporary_path, &self.final_path)
            .map_err(|_| StagingError::WriteFailed)?;
        if fs::remove_file(&self.temporary_path).is_err() {
            let _ = fs::remove_file(&self.final_path);
            return Err(StagingError::WriteFailed);
        }
        self.committed = true;
        if sync_directory(&self.directory).is_err() {
            let _ = fs::remove_file(&self.final_path);
            self.committed = false;
            return Err(StagingError::WriteFailed);
        }
        Ok(StagedBlob {
            basename: self.final_basename.clone(),
            byte_count,
            sha256,
        })
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.temporary_path);
        }
    }
}

fn checked_identity(metadata: &fs::Metadata) -> Result<DirectoryIdentity, StagingError> {
    if !metadata.is_dir() {
        return Err(StagingError::UnsafeDirectory);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        // The helper is local and macOS-only in production; fail closed on a directory that is
        // shared with another user or group.
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o7777 != 0o700
        {
            return Err(StagingError::UnsafeDirectory);
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
        Err(StagingError::UnsafeDirectory)
    }
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_opaque_private_file_and_cleans_uncommitted_bytes() {
        let root = crate::testutil::TempRoot::new("capture-archive");
        let directory = StagingDirectory::open(root.path()).expect("private directory");
        let mut file = directory.create_file().expect("staging file");
        use std::io::Write;
        file.file_mut()
            .expect("open file")
            .write_all(b"synthetic")
            .expect("write bytes");
        assert!(root.path().read_dir().unwrap().next().is_some());
        drop(file);
        assert_eq!(root.path().read_dir().unwrap().count(), 0);
    }

    #[test]
    fn rejects_shared_and_symlink_staging_directories() {
        let root = crate::testutil::TempRoot::new("capture-archive-mode");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                StagingDirectory::open(root.path()).err(),
                Some(StagingError::UnsafeDirectory)
            );
            fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();

            let alias = root.path().with_extension("alias");
            std::os::unix::fs::symlink(root.path(), &alias).unwrap();
            assert_eq!(
                StagingDirectory::open(&alias).err(),
                Some(StagingError::UnsafeDirectory)
            );
            fs::remove_file(alias).unwrap();
        }
    }

    #[test]
    fn committed_blob_has_opaque_name_and_private_mode() {
        let root = crate::testutil::TempRoot::new("capture-archive-commit");
        let directory = StagingDirectory::open(root.path()).expect("private directory");
        let mut file = directory.create_file().expect("staging file");
        use std::io::Write;
        file.file_mut()
            .expect("open file")
            .write_all(b"synthetic")
            .expect("write bytes");
        let blob = file
            .commit(9, "abc".to_owned())
            .expect("publish staging file");
        assert!(blob.basename.ends_with(".blob"));
        assert!(!blob.basename.contains("synthetic"));
        assert_eq!(
            fs::read(root.path().join(&blob.basename)).unwrap(),
            b"synthetic"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.path().join(blob.basename))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}

#[cfg(all(test, feature = "test-overrides"))]
mod downloader_tests {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread;

    use sha2::{Digest, Sha256};

    use super::*;
    use crate::downloads::{DownloadClient, DownloadError, MAX_CAPTURE_FILE_BYTES, MAX_FILE_BYTES};

    fn server_response(
        status: &str,
        headers: &str,
        body: &[u8],
        declared_length: Option<u64>,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let body = body.to_vec();
        let status = status.to_owned();
        let headers = headers.to_owned();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                request.push_str(&line);
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            write!(
                stream,
                "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                declared_length.unwrap_or(body.len() as u64)
            )
            .unwrap();
            stream.write_all(&body).unwrap();
            request
        });
        (origin, server)
    }

    #[test]
    fn streams_and_hashes_synthetic_pdf_into_opaque_staging() {
        let body = b"%PDF-1.7\nsynthetic fixture bytes";
        let (origin, server) =
            server_response("200 OK", "Content-Type: application/pdf\r\n", body, None);
        let root = crate::testutil::TempRoot::new("capture-download-success");
        let staging = StagingDirectory::open(root.path()).unwrap();
        let client = DownloadClient::with_test_origin(&origin).unwrap();
        let result = client
            .download_file_to_staging(
                &format!("{origin}/files/41/download?download_frd=1&verifier=synthetic"),
                41,
                Some(body.len() as u64),
                &staging,
            )
            .unwrap();
        assert!(!server
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
        assert_eq!(result.file_id, 41);
        assert_eq!(result.content_type, "application/pdf");
        assert_eq!(result.blob.byte_count, body.len() as u64);
        assert_eq!(result.blob.sha256, format!("{:x}", Sha256::digest(body)));
        assert_eq!(
            fs::read(root.path().join(&result.blob.basename)).unwrap(),
            body
        );
        assert_eq!(root.path().read_dir().unwrap().count(), 1);
        assert!(!result.blob.basename.contains("Canvas"));
    }

    #[test]
    fn rejects_declared_oversize_before_creating_a_staged_entry() {
        let (origin, server) = server_response(
            "200 OK",
            "Content-Type: application/pdf\r\n",
            b"",
            Some(MAX_CAPTURE_FILE_BYTES + 1),
        );
        let root = crate::testutil::TempRoot::new("capture-download-oversize");
        let staging = StagingDirectory::open(root.path()).unwrap();
        let client = DownloadClient::with_test_origin(&origin).unwrap();
        assert_eq!(
            client
                .download_file_to_staging(
                    &format!("{origin}/files/42/download?verifier=synthetic"),
                    42,
                    None,
                    &staging,
                )
                .err(),
            Some(DownloadError::ResponseTooLarge)
        );
        assert!(!server
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
        assert_eq!(root.path().read_dir().unwrap().count(), 0);
    }

    #[test]
    fn refuses_unreviewed_redirect_before_following_or_publishing() {
        let (origin, server) = server_response(
            "302 Found",
            "Location: https://evil.invalid/file\r\n",
            b"",
            None,
        );
        let root = crate::testutil::TempRoot::new("capture-download-redirect");
        let staging = StagingDirectory::open(root.path()).unwrap();
        let client = DownloadClient::with_test_origin(&origin).unwrap();
        assert_eq!(
            client
                .download_file_to_staging(
                    &format!("{origin}/files/43/download?verifier=synthetic"),
                    43,
                    None,
                    &staging,
                )
                .err(),
            Some(DownloadError::InvalidUrl)
        );
        assert!(!server
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
        assert_eq!(root.path().read_dir().unwrap().count(), 0);
    }

    #[test]
    fn rejects_html_interstitial_and_mime_mismatch_without_archive_entry() {
        for (label, content_type, body, expected) in [
            (
                "html",
                "application/octet-stream",
                &b"<!doctype html><title>Sign in</title>"[..],
                DownloadError::SignInResponse,
            ),
            (
                "mime",
                "application/pdf",
                &b"not a pdf"[..],
                DownloadError::MimeSignatureMismatch,
            ),
        ] {
            let (origin, server) = server_response(
                "200 OK",
                &format!("Content-Type: {content_type}\r\n"),
                body,
                None,
            );
            let root = crate::testutil::TempRoot::new(&format!("capture-download-{label}"));
            let staging = StagingDirectory::open(root.path()).unwrap();
            let client = DownloadClient::with_test_origin(&origin).unwrap();
            assert_eq!(
                client
                    .download_file_to_staging(
                        &format!("{origin}/files/44/download?verifier=synthetic"),
                        44,
                        Some(body.len() as u64),
                        &staging,
                    )
                    .err(),
                Some(expected)
            );
            assert!(!server
                .join()
                .unwrap()
                .to_ascii_lowercase()
                .contains("authorization:"));
            assert_eq!(root.path().read_dir().unwrap().count(), 0);
        }
    }

    #[test]
    fn streamed_capture_has_a_larger_cap_than_buffered_downloads() {
        assert!(MAX_CAPTURE_FILE_BYTES > MAX_FILE_BYTES);
        let body_size = usize::try_from(MAX_FILE_BYTES + 1).unwrap();
        let mut body = Vec::with_capacity(body_size);
        body.extend_from_slice(b"%PDF-1.7\n");
        body.resize(body_size, b'x');

        let (origin, server) = server_response(
            "200 OK",
            "Content-Type: application/pdf\r\n",
            b"",
            Some(body_size as u64),
        );
        let buffered = DownloadClient::with_test_origin(&origin).unwrap();
        assert_eq!(
            buffered
                .download_file(&format!("{origin}/files/45/download?download_frd=1"))
                .err(),
            Some(DownloadError::ResponseTooLarge)
        );
        assert!(!server
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));

        let (origin, server) =
            server_response("200 OK", "Content-Type: application/pdf\r\n", &body, None);
        let root = crate::testutil::TempRoot::new("capture-download-large");
        let staging = StagingDirectory::open(root.path()).unwrap();
        let streaming = DownloadClient::with_test_origin(&origin).unwrap();
        let result = streaming
            .download_file_to_staging(
                &format!("{origin}/files/46/download?download_frd=1&verifier=synthetic"),
                46,
                Some(body_size as u64),
                &staging,
            )
            .unwrap();
        assert!(!server
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
        assert_eq!(result.blob.byte_count, body_size as u64);
        assert_eq!(result.blob.sha256, format!("{:x}", Sha256::digest(&body)));
    }

    #[test]
    fn metadata_size_mismatch_leaves_no_staged_entry() {
        let body = b"%PDF-1.7\nsynthetic fixture";
        let (origin, server) =
            server_response("200 OK", "Content-Type: application/pdf\r\n", body, None);
        let root = crate::testutil::TempRoot::new("capture-download-size-mismatch");
        let staging = StagingDirectory::open(root.path()).unwrap();
        let client = DownloadClient::with_test_origin(&origin).unwrap();
        assert_eq!(
            client
                .download_file_to_staging(
                    &format!("{origin}/files/47/download?verifier=synthetic"),
                    47,
                    Some(body.len() as u64 + 1),
                    &staging,
                )
                .err(),
            Some(DownloadError::SizeMismatch)
        );
        assert!(!server
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
        assert_eq!(root.path().read_dir().unwrap().count(), 0);
    }
}
