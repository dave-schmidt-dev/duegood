//! Private Canvas capture-state helper.
//!
//! CLI contract: `begin` allocates a monotonic run ID and records `running`; `fail <run-id>`
//! marks that current attempt `failed`; `status` prints only `run=<number> status=<code>`. The
//! helper accepts no data-root argument. Production always uses Due Good's fixed app-data root;
//! only `test-overrides` builds accept the explicit `.test` root configured by `config.rs`.
//! Crash recovery belongs to collector integration: after proving its lifecycle/profile lock is
//! free, startup must call `fail` for a prior running attempt before allocating the next run ID.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use duegood_desktop::{capture_state_paths, refresh_helper_store_root};

const STATE_FORMAT: &str = "duegood-canvas-capture-state";
const STATE_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Begin,
    Fail(u64),
    Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AttemptStatus {
    Running,
    Failed,
}

impl AttemptStatus {
    fn code(self) -> &'static str {
        match self {
            AttemptStatus::Running => "running",
            AttemptStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunCounter {
    format: String,
    version: u32,
    last_run_id: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AttemptReceipt {
    format: String,
    version: u32,
    run_id: u64,
    status: AttemptStatus,
}

struct StateLock {
    file: File,
}

impl StateLock {
    fn acquire(data_root: &Path) -> io::Result<Self> {
        let path = capture_state_paths(data_root).2;
        reject_non_regular_or_symlink_if_present(&path)?;

        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(path)?;
        file.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => {
                io::Error::new(io::ErrorKind::WouldBlock, "capture state is busy")
            }
            fs::TryLockError::Error(error) => error,
        })?;
        set_private_file_mode(&file)?;
        Ok(Self { file })
    }
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn parse_command(args: &[std::ffi::OsString]) -> Result<Command, ()> {
    match args {
        [verb] if verb == "begin" => Ok(Command::Begin),
        [verb] if verb == "status" => Ok(Command::Status),
        [verb, run_id] if verb == "fail" => {
            let value = run_id.to_str().ok_or(())?;
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(());
            }
            let run_id = value.parse::<u64>().map_err(|_| ())?;
            if run_id == 0 {
                return Err(());
            }
            Ok(Command::Fail(run_id))
        }
        _ => Err(()),
    }
}

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let result = parse_command(&args).map_err(|_| ()).and_then(|command| {
        let data_root = refresh_helper_store_root().map_err(|_| ())?;
        run_command(command, &data_root).map_err(|_| ())
    });
    match result {
        Ok(line) => println!("{line}"),
        Err(()) => {
            eprintln!("Capture state operation failed.");
            std::process::exit(1);
        }
    }
}

fn run_command(command: Command, data_root: &Path) -> io::Result<String> {
    match command {
        Command::Begin => begin_at(data_root),
        Command::Fail(run_id) => fail_at(data_root, run_id),
        Command::Status => status_at(data_root),
    }
}

fn begin_at(data_root: &Path) -> io::Result<String> {
    ensure_private_root(data_root)?;
    let _lock = StateLock::acquire(data_root)?;
    let (counter_path, attempt_path, _) = capture_state_paths(data_root);
    let counter = read_counter(&counter_path)?;
    let prior_attempt = read_attempt(&attempt_path)?;
    let previous_id = counter.as_ref().map(|value| value.last_run_id).unwrap_or(0);
    if prior_attempt
        .as_ref()
        .is_some_and(|attempt| attempt.run_id > previous_id)
    {
        return Err(invalid_data("capture state is inconsistent"));
    }
    let run_id = previous_id
        .checked_add(1)
        .ok_or_else(|| invalid_data("run counter is exhausted"))?;

    // Persist the monotonic ID first. If the following receipt write is interrupted, the next
    // begin skips this ID rather than reusing it; collection cannot start until both writes land.
    atomic_write(
        &counter_path,
        &state_json(&RunCounter {
            format: STATE_FORMAT.into(),
            version: STATE_VERSION,
            last_run_id: run_id,
        })?,
    )?;
    let receipt = AttemptReceipt {
        format: STATE_FORMAT.into(),
        version: STATE_VERSION,
        run_id,
        status: AttemptStatus::Running,
    };
    atomic_write(&attempt_path, &state_json(&receipt)?)?;
    Ok(status_line(run_id, AttemptStatus::Running.code()))
}

fn fail_at(data_root: &Path, run_id: u64) -> io::Result<String> {
    if run_id == 0 {
        return Err(invalid_data("run ID must be positive"));
    }
    ensure_private_root(data_root)?;
    let _lock = StateLock::acquire(data_root)?;
    let (counter_path, attempt_path, _) = capture_state_paths(data_root);
    let counter = read_counter(&counter_path)?;
    let mut attempt = read_attempt(&attempt_path)?
        .ok_or_else(|| invalid_data("capture attempt does not exist"))?;
    if counter
        .as_ref()
        .is_none_or(|value| value.last_run_id < attempt.run_id)
        || attempt.run_id != run_id
    {
        return Err(invalid_data("run ID does not match the current attempt"));
    }
    if attempt.status == AttemptStatus::Running {
        attempt.status = AttemptStatus::Failed;
        atomic_write(&attempt_path, &state_json(&attempt)?)?;
    }
    Ok(status_line(run_id, attempt.status.code()))
}

fn status_at(data_root: &Path) -> io::Result<String> {
    ensure_private_root(data_root)?;
    let _lock = StateLock::acquire(data_root)?;
    let (counter_path, attempt_path, _) = capture_state_paths(data_root);
    let counter = read_counter(&counter_path)?;
    let attempt = read_attempt(&attempt_path)?;
    if let Some(attempt) = attempt {
        if counter
            .as_ref()
            .is_none_or(|value| value.last_run_id < attempt.run_id)
        {
            return Err(invalid_data("capture state is inconsistent"));
        }
        Ok(status_line(attempt.run_id, attempt.status.code()))
    } else {
        Ok(status_line(
            counter.map(|value| value.last_run_id).unwrap_or(0),
            "none",
        ))
    }
}

fn status_line(run_id: u64, status: &str) -> String {
    format!("run={run_id} status={status}")
}

fn read_counter(path: &Path) -> io::Result<Option<RunCounter>> {
    let Some(counter) = read_json::<RunCounter>(path)? else {
        return Ok(None);
    };
    if counter.format != STATE_FORMAT || counter.version != STATE_VERSION {
        return Err(invalid_data("unsupported counter format"));
    }
    Ok(Some(counter))
}

fn read_attempt(path: &Path) -> io::Result<Option<AttemptReceipt>> {
    let Some(attempt) = read_json::<AttemptReceipt>(path)? else {
        return Ok(None);
    };
    if attempt.format != STATE_FORMAT || attempt.version != STATE_VERSION || attempt.run_id == 0 {
        return Err(invalid_data("unsupported attempt format"));
    }
    Ok(Some(attempt))
}

fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(invalid_data("capture state is not a regular file"));
        }
        Ok(_) => {}
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(invalid_data("capture state exceeds its size limit"));
    }
    let value =
        serde_json::from_slice(&bytes).map_err(|_| invalid_data("capture state is invalid"))?;
    Ok(Some(value))
}

fn state_json<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| invalid_data("capture state cannot be encoded"))
}

fn ensure_private_root(data_root: &Path) -> io::Result<()> {
    fs::create_dir_all(data_root)?;
    let metadata = fs::symlink_metadata(data_root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_data("capture data root is not a directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(data_root, fs::Permissions::from_mode(0o700))?;
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

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::path::PathBuf;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!(
                    "duegood-capture-state-{}",
                    uuid::Uuid::new_v4().simple()
                ))
                .join("com.zerodelta.duegood.test");
            fs::create_dir_all(&path).expect("create synthetic test root");
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            if let Some(parent) = self.0.parent() {
                let _ = fs::remove_dir_all(parent);
            }
        }
    }

    #[test]
    fn begin_allocates_monotonic_ids_and_persists_running_before_return() {
        let root = TestRoot::new();
        assert_eq!(
            begin_at(&root.0).expect("first begin"),
            "run=1 status=running"
        );
        assert_eq!(status_at(&root.0).expect("status"), "run=1 status=running");
        assert_eq!(
            begin_at(&root.0).expect("second begin"),
            "run=2 status=running"
        );
        let (counter_path, attempt_path, _) = capture_state_paths(&root.0);
        let counter = read_counter(&counter_path)
            .expect("read counter")
            .expect("counter exists");
        assert_eq!(counter.last_run_id, 2);
        let attempt = read_attempt(&attempt_path)
            .expect("read attempt")
            .expect("attempt exists");
        assert_eq!(attempt.run_id, 2);
        assert_eq!(attempt.status, AttemptStatus::Running);
    }

    #[test]
    fn fail_marks_only_the_current_attempt_and_is_idempotent() {
        let root = TestRoot::new();
        begin_at(&root.0).expect("begin");
        assert!(fail_at(&root.0, 2).is_err());
        assert_eq!(
            status_at(&root.0).expect("unchanged status"),
            "run=1 status=running"
        );
        assert_eq!(fail_at(&root.0, 1).expect("fail"), "run=1 status=failed");
        assert_eq!(
            fail_at(&root.0, 1).expect("repeat fail"),
            "run=1 status=failed"
        );
        assert_eq!(status_at(&root.0).expect("status"), "run=1 status=failed");
    }

    #[test]
    fn a_crashed_running_attempt_is_not_reused_on_the_next_begin() {
        let root = TestRoot::new();
        begin_at(&root.0).expect("begin before simulated crash");
        // Releasing the helper's short state lock models its process ending during collection.
        assert_eq!(
            begin_at(&root.0).expect("continue after crash"),
            "run=2 status=running"
        );
        assert_eq!(
            status_at(&root.0).expect("current attempt"),
            "run=2 status=running"
        );
    }

    #[test]
    fn corrupt_state_fails_closed_without_resetting_the_counter() {
        let root = TestRoot::new();
        let counter_path = capture_state_paths(&root.0).0;
        atomic_write(
            &counter_path,
            br#"{"format":"other","version":1,"last_run_id":41}"#,
        )
        .expect("write synthetic corrupt counter");
        assert!(begin_at(&root.0).is_err());
        assert_eq!(
            fs::read(counter_path).expect("counter remains"),
            br#"{"format":"other","version":1,"last_run_id":41}"#
        );
    }

    #[test]
    fn attempt_ahead_of_counter_fails_closed() {
        let root = TestRoot::new();
        let (counter_path, attempt_path, _) = capture_state_paths(&root.0);
        atomic_write(
            &counter_path,
            &state_json(&RunCounter {
                format: STATE_FORMAT.into(),
                version: STATE_VERSION,
                last_run_id: 1,
            })
            .unwrap(),
        )
        .unwrap();
        atomic_write(
            &attempt_path,
            &state_json(&AttemptReceipt {
                format: STATE_FORMAT.into(),
                version: STATE_VERSION,
                run_id: 2,
                status: AttemptStatus::Running,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(begin_at(&root.0).is_err());
        assert_eq!(read_counter(&counter_path).unwrap().unwrap().last_run_id, 1);
    }

    #[test]
    fn cli_contract_rejects_extra_arguments_and_nonpositive_run_ids() {
        let args = |parts: &[&str]| parts.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(parse_command(&args(&["begin"])), Ok(Command::Begin));
        assert_eq!(parse_command(&args(&["status"])), Ok(Command::Status));
        assert_eq!(parse_command(&args(&["fail", "12"])), Ok(Command::Fail(12)));
        assert!(parse_command(&args(&["begin", "extra"])).is_err());
        assert!(parse_command(&args(&["fail", "0"])).is_err());
        assert!(parse_command(&args(&["fail", "-1"])).is_err());
        assert!(parse_command(&args(&["fail", "1x"])).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn state_root_and_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = TestRoot::new();
        begin_at(&root.0).expect("begin");
        assert_eq!(
            fs::metadata(&root.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for path in [
            capture_state_paths(&root.0).0,
            capture_state_paths(&root.0).1,
            capture_state_paths(&root.0).2,
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
