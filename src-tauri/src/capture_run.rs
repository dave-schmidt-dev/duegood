//! Shared lock and durable status for browser capture and native import.
//!
//! The guard uses one OS file lock for the whole capture/import transaction. Its unlocked status
//! reader is intended only for bounded UI freshness observations; errors mean "not current".

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{capture_state_paths, config};

#[path = "capture_run_archive.rs"]
mod archive;
pub(crate) use archive::PublishedGenerationSummary;
#[path = "capture_run_lease.rs"]
mod lease;
pub use lease::run_lease;

const STATE_FORMAT: &str = "duegood-canvas-capture-state";
const STATE_VERSION: u32 = 2;
const MAX_STATE_BYTES: u64 = 4096;
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureAttemptStatus {
    Running,
    Failed,
    Captured,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureAttempt {
    pub run_id: u64,
    pub status: CaptureAttemptStatus,
    pub generation_id: Option<String>,
    pub snapshot_sha256: Option<String>,
    pub user_id: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunCounter {
    format: String,
    version: u32,
    #[serde(alias = "last_run_id")]
    last_run_id: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttemptFile {
    format: String,
    version: u32,
    #[serde(alias = "run_id")]
    run_id: u64,
    status: CaptureAttemptStatus,
    #[serde(default)]
    generation_id: Option<String>,
    #[serde(default)]
    snapshot_sha256: Option<String>,
    #[serde(default)]
    user_id: Option<u64>,
}

/// An exclusive capture/import transaction lock.
pub struct CaptureRunGuard {
    data_root: PathBuf,
    lock_file: File,
}

impl CaptureRunGuard {
    /// Acquires the common state lock and keeps it until the guard is dropped.
    pub fn acquire(data_root: &Path) -> io::Result<Self> {
        ensure_private_root(data_root)?;
        let lock_path = capture_state_paths(data_root).2;
        reject_non_regular_or_symlink_if_present(&lock_path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let lock_file = options.open(lock_path)?;
        lock_file.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => io::Error::new(
                io::ErrorKind::WouldBlock,
                "capture or import transaction is busy",
            ),
            fs::TryLockError::Error(error) => error,
        })?;
        set_private_file_mode(&lock_file)?;
        Ok(Self {
            data_root: data_root.to_path_buf(),
            lock_file,
        })
    }

    /// Reads the current attempt while this guard excludes capture and import writers.
    pub fn attempt(&self) -> io::Result<Option<CaptureAttempt>> {
        read_attempt_consistent(&self.data_root)
    }

    /// Allocates the next monotonic run and marks it running.
    pub fn begin(&self) -> io::Result<CaptureAttempt> {
        let (counter_path, attempt_path, _) = capture_state_paths(&self.data_root);
        let counter = read_counter(&counter_path)?;
        let prior = read_attempt_file(&attempt_path)?;
        let previous = counter.as_ref().map(|value| value.last_run_id).unwrap_or(0);
        if let Some(mut prior) = prior {
            if prior.run_id > previous {
                return Err(invalid_data("capture state is inconsistent"));
            }
            if prior.run_id == previous && prior.status == CaptureAttemptStatus::Running {
                prior.status = CaptureAttemptStatus::Failed;
                let attempt = CaptureAttempt {
                    run_id: prior.run_id,
                    status: prior.status,
                    generation_id: prior.generation_id,
                    snapshot_sha256: prior.snapshot_sha256,
                    user_id: prior.user_id,
                };
                write_attempt(&attempt_path, &attempt)?;
            }
        }
        let run_id = previous
            .checked_add(1)
            .ok_or_else(|| invalid_data("run counter is exhausted"))?;
        atomic_write(
            &counter_path,
            &state_json(&RunCounter {
                format: STATE_FORMAT.into(),
                version: STATE_VERSION,
                last_run_id: run_id,
            })?,
        )?;
        let attempt = CaptureAttempt {
            run_id,
            status: CaptureAttemptStatus::Running,
            generation_id: None,
            snapshot_sha256: None,
            user_id: None,
        };
        write_attempt(&attempt_path, &attempt)?;
        Ok(attempt)
    }

    /// Marks only the current run failed; repeating the operation is idempotent.
    pub fn fail(&self, run_id: u64) -> io::Result<CaptureAttempt> {
        let (counter_path, attempt_path, _) = capture_state_paths(&self.data_root);
        let counter = read_counter(&counter_path)?;
        let mut attempt = read_attempt_consistent(&self.data_root)?
            .ok_or_else(|| invalid_data("capture attempt does not exist"))?;
        if run_id == 0
            || attempt.run_id != run_id
            || counter
                .as_ref()
                .is_none_or(|value| value.last_run_id != run_id)
        {
            return Err(invalid_data("run ID does not match the current attempt"));
        }
        if attempt.status == CaptureAttemptStatus::Running {
            attempt.status = CaptureAttemptStatus::Failed;
            write_attempt(&attempt_path, &attempt)?;
        }
        Ok(attempt)
    }

    /// Validates the current v2 archive pointer, manifest, and snapshot before recording success.
    pub fn complete(
        &self,
        run_id: u64,
        generation_id: &str,
        snapshot_sha256: &str,
        user_id: u64,
    ) -> io::Result<CaptureAttempt> {
        let current = self
            .attempt()?
            .ok_or_else(|| invalid_data("capture attempt does not exist"))?;
        if current.status != CaptureAttemptStatus::Running || current.run_id != run_id {
            return Err(invalid_data("run ID does not match the running attempt"));
        }
        archive::validate_published_generation(
            &config::canvas_capture_archive_root(&self.data_root)
                .map_err(|_| invalid_data("fixed capture archive is unavailable"))?,
            run_id,
            generation_id,
            snapshot_sha256,
            user_id,
        )?;
        let attempt = CaptureAttempt {
            run_id,
            status: CaptureAttemptStatus::Captured,
            generation_id: Some(generation_id.to_string()),
            snapshot_sha256: Some(snapshot_sha256.to_string()),
            user_id: Some(user_id),
        };
        write_attempt(&capture_state_paths(&self.data_root).1, &attempt)?;
        Ok(attempt)
    }
}

impl Drop for CaptureRunGuard {
    fn drop(&mut self) {
        let _ = self.lock_file.unlock();
    }
}

/// Reads and validates the current attempt without waiting for an active capture/import lock.
/// Callers should treat `WouldBlock`-equivalent state errors as not current.
pub fn read_attempt_unlocked(data_root: &Path) -> io::Result<Option<CaptureAttempt>> {
    read_attempt_consistent(data_root)
}

/// Returns the current attempt under the common transaction lock.
pub fn read_attempt(data_root: &Path) -> io::Result<Option<CaptureAttempt>> {
    let guard = CaptureRunGuard::acquire(data_root)?;
    guard.attempt()
}

/// Revalidates the current fixed archive receipt and returns only content-free counts.
/// Captured account identity remains native-only and is consumed by the freshness projector.
pub(crate) fn summarize_current_capture(
    data_root: &Path,
    attempt: &CaptureAttempt,
) -> io::Result<PublishedGenerationSummary> {
    if attempt.status != CaptureAttemptStatus::Captured {
        return Err(invalid_data("capture attempt is not captured"));
    }
    let generation_id = attempt
        .generation_id
        .as_deref()
        .ok_or_else(|| invalid_data("capture generation is missing"))?;
    let snapshot_sha256 = attempt
        .snapshot_sha256
        .as_deref()
        .ok_or_else(|| invalid_data("capture snapshot hash is missing"))?;
    let user_id = attempt
        .user_id
        .ok_or_else(|| invalid_data("capture user is missing"))?;
    let archive_root = config::canvas_capture_archive_root(data_root)
        .map_err(|_| invalid_data("fixed capture archive is unavailable"))?;
    archive::summarize_published_generation(
        &archive_root,
        attempt.run_id,
        generation_id,
        snapshot_sha256,
        user_id,
    )
}

fn read_attempt_consistent(data_root: &Path) -> io::Result<Option<CaptureAttempt>> {
    let (counter_path, attempt_path, _) = capture_state_paths(data_root);
    let counter = read_counter(&counter_path)?;
    let attempt = read_attempt_file(&attempt_path)?;
    match (counter, attempt) {
        (None, None) => Ok(None),
        (Some(counter), Some(attempt)) if counter.last_run_id == attempt.run_id => {
            Ok(Some(CaptureAttempt {
                run_id: attempt.run_id,
                status: attempt.status,
                generation_id: attempt.generation_id,
                snapshot_sha256: attempt.snapshot_sha256,
                user_id: attempt.user_id,
            }))
        }
        _ => Err(invalid_data("capture counter and attempt are inconsistent")),
    }
}

fn read_counter(path: &Path) -> io::Result<Option<RunCounter>> {
    let Some(counter) = read_json_optional(path)? else {
        return Ok(None);
    };
    let counter: RunCounter =
        serde_json::from_value(counter).map_err(|_| invalid_data("capture counter is invalid"))?;
    if counter.format != STATE_FORMAT || !matches!(counter.version, 1 | STATE_VERSION) {
        return Err(invalid_data("unsupported capture counter format"));
    }
    Ok(Some(counter))
}

fn read_attempt_file(path: &Path) -> io::Result<Option<AttemptFile>> {
    let Some(value) = read_json_optional(path)? else {
        return Ok(None);
    };
    let attempt: AttemptFile =
        serde_json::from_value(value).map_err(|_| invalid_data("capture attempt is invalid"))?;
    if attempt.format != STATE_FORMAT
        || !matches!(attempt.version, 1 | STATE_VERSION)
        || attempt.run_id == 0
        || (attempt.status == CaptureAttemptStatus::Captured
            && (attempt.version < STATE_VERSION
                || attempt
                    .generation_id
                    .as_deref()
                    .is_none_or(|id| !valid_generation_id(id))
                || attempt
                    .snapshot_sha256
                    .as_deref()
                    .is_none_or(|hash| !valid_hash(hash))
                || attempt.user_id.is_none_or(|id| id == 0)))
    {
        return Err(invalid_data("unsupported capture attempt format"));
    }
    Ok(Some(attempt))
}

fn write_attempt(path: &Path, attempt: &CaptureAttempt) -> io::Result<()> {
    atomic_write(
        path,
        &state_json(&AttemptFile {
            format: STATE_FORMAT.into(),
            version: STATE_VERSION,
            run_id: attempt.run_id,
            status: attempt.status,
            generation_id: attempt.generation_id.clone(),
            snapshot_sha256: attempt.snapshot_sha256.clone(),
            user_id: attempt.user_id,
        })?,
    )
}

fn read_json_optional(path: &Path) -> io::Result<Option<Value>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(invalid_data("capture state is not a regular file"));
        }
        Ok(_) => {}
    }
    read_json_file(path, MAX_STATE_BYTES).map(Some)
}

fn read_json_file(path: &Path, max_bytes: u64) -> io::Result<Value> {
    let bytes = read_file_bounded(path, max_bytes)?;
    serde_json::from_slice(&bytes).map_err(|_| invalid_data("capture JSON is invalid"))
}

fn read_file_bounded(path: &Path, max_bytes: u64) -> io::Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    if before.file_type().is_symlink() || !before.is_file() || before.len() > max_bytes {
        return Err(invalid_data("capture file is unsafe or too large"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    let opened = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(invalid_data("capture file changed while opening"));
        }
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(invalid_data("capture file exceeds its size limit"));
    }
    Ok(bytes)
}

fn state_json<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| invalid_data("capture state cannot be encoded"))
}

fn ensure_private_root(root: &Path) -> io::Result<()> {
    fs::create_dir_all(root)?;
    let metadata = fs::symlink_metadata(root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_data("capture data root is not a directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn reject_non_regular_or_symlink_if_present(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(invalid_data("capture lock is not a regular file"))
        }
        Ok(_) => Ok(()),
    }
}

fn set_private_file_mode(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid_data("capture state path has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| invalid_data("capture state path has no name"))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn valid_generation_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
#[path = "capture_run_tests.rs"]
mod tests;
