//! Locks.
//!
//! Six independent locks exist and are never merged:
//! - [`InstanceLock`]: an OS file lock held for the app lifetime, so a second instance is denied.
//! - [`WriteLock`]: a short OS file lock held around every store document write.
//! - [`RefreshLock`]: an OS file lock held for an entire refresh, including helper network work.
//! - [`ReadLock`]: a shared OS file lock held around each complete multi-document read operation.
//! - [`SnapshotLock`]: serializes snapshot catalog changes without blocking ordinary store reads.
//! - [`LegacyLock`]: the legacy Node writer's adjacent `${coursework.json}.duegood-lock` directory
//!   lock, reproduced exactly so the importer and the browser app's writer exclude each other.
//!
//! OS file locks (`flock` on Unix, `LockFileEx` on Windows) are released by the kernel when the
//! holding process dies, which is the crash/reboot recovery path for the first two.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::config::{INSTANCE_LOCK_FILE, LEGACY_LOCK_DIR, WRITE_LOCK_FILE};

/// Node's `LOCK_STALE_AFTER_MS`: a lock directory without valid owner metadata is stale after 30 s.
const LEGACY_LOCK_STALE_AFTER: Duration = Duration::from_secs(30);
/// Node's poll interval between acquisition attempts.
const LEGACY_LOCK_POLL: Duration = Duration::from_millis(25);
const WRITE_LOCK_POLL: Duration = Duration::from_millis(10);
const OWNER_FILE: &str = "owner.json";
const REFRESH_LOCK_FILE: &str = "duegood.refresh.lock";
const SNAPSHOT_LOCK_FILE: &str = "duegood.snapshot.lock";

/// Lock acquisition failure.
#[derive(Debug)]
pub enum LockError {
    /// Another Due Good process holds the instance lock.
    AnotherInstance,
    /// The lock stayed held past the timeout.
    Busy,
    Io(io::Error),
}

impl fmt::Display for LockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LockError::AnotherInstance => write!(f, "another Due Good window is already open"),
            LockError::Busy => write!(f, "coursework document is busy"),
            LockError::Io(error) => write!(f, "lock unavailable ({})", error.kind()),
        }
    }
}

impl From<io::Error> for LockError {
    fn from(error: io::Error) -> Self {
        LockError::Io(error)
    }
}

/// Opens a lock file, creating a missing one with mode `0600`. An existing file's permissions are
/// left alone here: a process that is then denied the lock must not change private-store
/// metadata, so only the holder tightens them ([`tighten_held_lock_file`]).
fn open_lock_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Sets a lock file this process now holds to `0600`.
fn tighten_held_lock_file(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

/// Held for the whole app lifetime. Dropping it (or process death) releases it.
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    /// Acquires the single-instance lock in `data_root`, failing immediately if it is held.
    pub fn acquire(data_root: &Path) -> Result<Self, LockError> {
        let file = open_lock_file(&data_root.join(INSTANCE_LOCK_FILE))?;
        match file.try_lock() {
            Ok(()) => {
                tighten_held_lock_file(&file)?;
                Ok(InstanceLock { _file: file })
            }
            Err(fs::TryLockError::WouldBlock) => Err(LockError::AnotherInstance),
            Err(fs::TryLockError::Error(error)) => Err(LockError::Io(error)),
        }
    }
}

/// Short exclusive lock around one store write. Dropping it releases it.
#[derive(Debug)]
pub struct WriteLock {
    _file: File,
}

impl WriteLock {
    /// Acquires the write lock in `data_root`, polling until `timeout`.
    pub fn acquire(data_root: &Path, timeout: Duration) -> Result<Self, LockError> {
        let file = open_lock_file(&data_root.join(WRITE_LOCK_FILE))?;
        let deadline = Instant::now() + timeout;
        loop {
            match file.try_lock() {
                Ok(()) => {
                    tighten_held_lock_file(&file)?;
                    return Ok(WriteLock { _file: file });
                }
                Err(fs::TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return Err(LockError::Busy);
                    }
                    thread::sleep(WRITE_LOCK_POLL);
                }
                Err(fs::TryLockError::Error(error)) => return Err(LockError::Io(error)),
            }
        }
    }
}

/// Shared OS lock held across one complete multi-document read operation. It uses the same
/// lockfile as [`WriteLock`], so a generation swap cannot become visible halfway through a read.
#[derive(Debug)]
pub struct ReadLock {
    _file: File,
}

impl ReadLock {
    /// Acquires a shared lock in `data_root`, polling until `timeout`.
    pub fn acquire(data_root: &Path, timeout: Duration) -> Result<Self, LockError> {
        let file = open_lock_file(&data_root.join(WRITE_LOCK_FILE))?;
        let deadline = Instant::now() + timeout;
        loop {
            match file.try_lock_shared() {
                Ok(()) => {
                    tighten_held_lock_file(&file)?;
                    return Ok(ReadLock { _file: file });
                }
                Err(fs::TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return Err(LockError::Busy);
                    }
                    thread::sleep(WRITE_LOCK_POLL);
                }
                Err(fs::TryLockError::Error(error)) => return Err(LockError::Io(error)),
            }
        }
    }
}

/// Cross-process lease held from refresh start through commit or failure. Unlike the ordinary
/// write lock it is never shared, and acquisition fails immediately while another refresh runs.
#[derive(Debug)]
pub struct RefreshLock {
    _file: File,
}

impl RefreshLock {
    /// Acquires the single-refresh lease in `data_root` without waiting for another refresh.
    pub fn acquire(data_root: &Path) -> Result<Self, LockError> {
        let file = open_lock_file(&data_root.join(REFRESH_LOCK_FILE))?;
        match file.try_lock() {
            Ok(()) => {
                tighten_held_lock_file(&file)?;
                Ok(RefreshLock { _file: file })
            }
            Err(fs::TryLockError::WouldBlock) => Err(LockError::Busy),
            Err(fs::TryLockError::Error(error)) => Err(LockError::Io(error)),
        }
    }
}

/// Serializes snapshot creation, rotation, and listing. It is separate from the store lock so
/// readers can continue while a daily snapshot copies a stable generation.
#[derive(Debug)]
pub struct SnapshotLock {
    _file: File,
}

impl SnapshotLock {
    /// Acquires the snapshot catalog lock, polling until `timeout`.
    pub fn acquire(data_root: &Path, timeout: Duration) -> Result<Self, LockError> {
        let file = open_lock_file(&data_root.join(SNAPSHOT_LOCK_FILE))?;
        let deadline = Instant::now() + timeout;
        loop {
            match file.try_lock() {
                Ok(()) => {
                    tighten_held_lock_file(&file)?;
                    return Ok(SnapshotLock { _file: file });
                }
                Err(fs::TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return Err(LockError::Busy);
                    }
                    thread::sleep(WRITE_LOCK_POLL);
                }
                Err(fs::TryLockError::Error(error)) => return Err(LockError::Io(error)),
            }
        }
    }
}

/// Mirrors Node's `processAlive`: a positive integer PID that answers signal 0, or refuses it
/// with `EPERM`, is alive.
pub fn process_alive(pid: &serde_json::Number) -> bool {
    let Some(pid) = pid.as_i64().or_else(|| {
        pid.as_f64()
            .filter(|value| value.fract() == 0.0 && value.abs() < 9.0e15)
            .map(|value| value as i64)
    }) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    platform_process_alive(pid)
}

#[cfg(unix)]
fn platform_process_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: kill with signal 0 performs only the existence and permission check.
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn platform_process_alive(_pid: i64) -> bool {
    // Conservative: without a liveness probe, an owned lock is never treated as abandoned.
    true
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Node's `staleLock`: valid owner metadata decides by PID liveness; otherwise the directory is
/// stale once its mtime is at least 30 s old, or when it has disappeared.
fn legacy_lock_is_stale(lock_dir: &Path) -> bool {
    let metadata = fs::read_to_string(lock_dir.join(OWNER_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| {
            let object = value.as_object()?;
            let pid = object.get("pid")?.as_number()?.clone();
            object.get("token")?.as_str()?;
            object.get("createdAt")?.as_number()?;
            Some(pid)
        });
    if let Some(pid) = metadata {
        return !process_alive(&pid);
    }
    match fs::metadata(lock_dir) {
        Ok(details) => details
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= LEGACY_LOCK_STALE_AFTER),
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    }
}

fn create_private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn write_owner(lock_dir: &Path, token: &str) -> io::Result<()> {
    let owner = serde_json::json!({
        "pid": std::process::id(),
        "token": token,
        "createdAt": now_millis(),
    });
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(lock_dir.join(OWNER_FILE))?;
    file.write_all(format!("{owner}\n").as_bytes())
}

/// The legacy writer's adjacent directory lock, held by this process.
#[derive(Debug)]
pub struct LegacyLock {
    dir: PathBuf,
    token: String,
    released: bool,
}

impl LegacyLock {
    /// Acquires `<legacy_root>/coursework.json.duegood-lock` with the Node writer's protocol:
    /// `mkdir` (0700), then `owner.json` (`wx`, 0600) holding `{pid, token, createdAt}`; stale
    /// locks are renamed aside and removed; attempts repeat every 25 ms until `timeout`.
    pub fn acquire(legacy_root: &Path, timeout: Duration) -> Result<Self, LockError> {
        let dir = legacy_root.join(LEGACY_LOCK_DIR);
        let deadline = Instant::now() + timeout;
        let token = uuid::Uuid::new_v4().to_string();
        loop {
            match create_private_dir(&dir) {
                Ok(()) => {
                    if let Err(error) = write_owner(&dir, &token) {
                        let _ = fs::remove_dir_all(&dir);
                        return Err(LockError::Io(error));
                    }
                    return Ok(LegacyLock {
                        dir,
                        token,
                        released: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(LockError::Io(error)),
            }
            if legacy_lock_is_stale(&dir) {
                let abandoned =
                    legacy_root.join(format!("{LEGACY_LOCK_DIR}.{}.stale", uuid::Uuid::new_v4()));
                let recovered =
                    fs::rename(&dir, &abandoned).and_then(|()| fs::remove_dir_all(&abandoned));
                match recovered {
                    Ok(()) => continue,
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::NotFound | io::ErrorKind::AlreadyExists
                        ) => {}
                    Err(error) => return Err(LockError::Io(error)),
                }
            }
            if Instant::now() >= deadline {
                return Err(LockError::Busy);
            }
            thread::sleep(LEGACY_LOCK_POLL);
        }
    }

    /// Releases the lock only if `owner.json` still carries this holder's token.
    pub fn release(mut self) -> io::Result<()> {
        self.released = true;
        release_legacy(&self.dir, &self.token)
    }
}

fn release_legacy(dir: &Path, token: &str) -> io::Result<()> {
    let owner = dir.join(OWNER_FILE);
    let mut text = String::new();
    match File::open(&owner).and_then(|mut file| file.read_to_string(&mut text)) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let parsed: Option<serde_json::Value> = serde_json::from_str(&text).ok();
    if parsed
        .as_ref()
        .and_then(|value| value.get("token"))
        .and_then(|value| value.as_str())
        != Some(token)
    {
        return Ok(());
    }
    match fs::remove_file(&owner) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    match fs::remove_dir(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

impl Drop for LegacyLock {
    fn drop(&mut self) {
        if !self.released {
            let _ = release_legacy(&self.dir, &self.token);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::testutil::TempRoot;
    use std::process::{Command, Stdio};

    const CHILD_ROOT_ENV: &str = "DUEGOOD_LOCK_CHILD_ROOT";

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).expect("metadata").permissions().mode() & 0o777
    }

    #[test]
    fn legacy_lock_matches_node_protocol() {
        let root = TempRoot::new("legacy-lock");
        let lock = LegacyLock::acquire(root.path(), Duration::from_millis(200)).expect("acquire");
        let dir = root.path().join(LEGACY_LOCK_DIR);
        let owner_text = fs::read_to_string(dir.join(OWNER_FILE)).expect("owner");
        assert!(owner_text.ends_with('\n') && !owner_text.ends_with("\n\n"));
        let owner: serde_json::Value = serde_json::from_str(&owner_text).expect("owner json");
        let keys: Vec<&str> = owner
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["pid", "token", "createdAt"],
            "JSON.stringify({{pid, token, createdAt}}) order"
        );
        assert_eq!(owner["pid"], std::process::id());
        let token = owner["token"].as_str().expect("token");
        assert_eq!(
            uuid::Uuid::parse_str(token)
                .expect("uuid")
                .get_version_num(),
            4
        );
        assert!(owner["createdAt"].as_u64().expect("millis") > 1_600_000_000_000);
        #[cfg(unix)]
        {
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&dir.join(OWNER_FILE)), 0o600);
        }
        lock.release().expect("release");
        assert!(!dir.exists());
    }

    #[test]
    fn legacy_lock_held_by_live_owner_is_busy_and_untouched() {
        let root = TempRoot::new("legacy-busy");
        let dir = root.path().join(LEGACY_LOCK_DIR);
        fs::create_dir(&dir).expect("lock dir");
        let owner = format!(
            "{{\"pid\":{},\"token\":\"other-holder\",\"createdAt\":1}}\n",
            std::process::id()
        );
        fs::write(dir.join(OWNER_FILE), &owner).expect("owner");
        let started = Instant::now();
        let error = LegacyLock::acquire(root.path(), Duration::from_millis(150)).expect_err("busy");
        assert!(matches!(error, LockError::Busy));
        assert_eq!(error.to_string(), "coursework document is busy");
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert_eq!(
            fs::read_to_string(dir.join(OWNER_FILE)).expect("owner"),
            owner
        );
    }

    #[test]
    fn legacy_lock_recovers_from_dead_owner() {
        let root = TempRoot::new("legacy-dead");
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .spawn()
            .expect("child");
        let dead_pid = child.id();
        child.wait().expect("wait");
        let dir = root.path().join(LEGACY_LOCK_DIR);
        fs::create_dir(&dir).expect("lock dir");
        fs::write(
            dir.join(OWNER_FILE),
            format!("{{\"pid\":{dead_pid},\"token\":\"crashed\",\"createdAt\":1}}\n"),
        )
        .expect("owner");
        let lock = LegacyLock::acquire(root.path(), Duration::from_millis(500))
            .expect("stale lock recovered");
        let owner: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(OWNER_FILE)).expect("owner"))
                .expect("json");
        assert_eq!(owner["pid"], std::process::id());
        lock.release().expect("release");
        let leftovers: Vec<_> = fs::read_dir(root.path()).expect("list").collect();
        assert!(
            leftovers.is_empty(),
            "stale lock was renamed aside and removed"
        );
    }

    #[test]
    fn legacy_lock_without_metadata_is_stale_only_after_thirty_seconds() {
        let root = TempRoot::new("legacy-mtime");
        let dir = root.path().join(LEGACY_LOCK_DIR);
        fs::create_dir(&dir).expect("lock dir");
        // A fresh directory without owner.json is a writer mid-acquire: not stale.
        assert!(matches!(
            LegacyLock::acquire(root.path(), Duration::from_millis(80)),
            Err(LockError::Busy)
        ));
        // Simulate a crash long ago (reboot): the directory mtime is 31 s old.
        let old = SystemTime::now() - Duration::from_secs(31);
        File::open(&dir)
            .expect("open dir")
            .set_modified(old)
            .expect("set mtime");
        let lock = LegacyLock::acquire(root.path(), Duration::from_millis(500)).expect("recovered");
        lock.release().expect("release");
    }

    #[test]
    fn legacy_release_ignores_a_foreign_token() {
        let root = TempRoot::new("legacy-foreign");
        let lock = LegacyLock::acquire(root.path(), Duration::from_millis(200)).expect("acquire");
        let dir = root.path().join(LEGACY_LOCK_DIR);
        fs::write(
            dir.join(OWNER_FILE),
            "{\"pid\":1,\"token\":\"someone-else\",\"createdAt\":1}\n",
        )
        .expect("replace owner");
        lock.release().expect("release");
        assert!(
            dir.join(OWNER_FILE).exists(),
            "another holder's lock is never removed"
        );
    }

    #[test]
    fn process_alive_follows_node_rules() {
        assert!(process_alive(&serde_json::Number::from(std::process::id())));
        assert!(!process_alive(&serde_json::Number::from(0)));
        assert!(!process_alive(&serde_json::Number::from(-5)));
        assert!(!process_alive(
            &serde_json::Number::from_f64(1.5).expect("float")
        ));
        assert!(!process_alive(&serde_json::Number::from(
            i64::from(i32::MAX) + 10
        )));
    }

    #[test]
    fn second_instance_in_process_is_denied_and_modes_are_private() {
        let root = TempRoot::new("instance");
        let first = InstanceLock::acquire(root.path()).expect("first");
        assert!(matches!(
            InstanceLock::acquire(root.path()),
            Err(LockError::AnotherInstance)
        ));
        #[cfg(unix)]
        assert_eq!(mode(&root.path().join(INSTANCE_LOCK_FILE)), 0o600);
        drop(first);
        InstanceLock::acquire(root.path()).expect("released on drop");
    }

    #[test]
    fn refresh_lease_is_exclusive_and_released_on_drop() {
        let root = TempRoot::new("refresh-lease");
        let first = RefreshLock::acquire(root.path()).expect("first lease");
        assert!(matches!(
            RefreshLock::acquire(root.path()),
            Err(LockError::Busy)
        ));
        drop(first);
        RefreshLock::acquire(root.path()).expect("lease released");
    }

    /// A timed-out or denied attempt leaves a loosened lock file as it found it; only the next
    /// holder tightens it.
    #[test]
    fn write_lock_times_out_while_held_and_denials_change_no_modes() {
        let root = TempRoot::new("write-lock");
        let instance = InstanceLock::acquire(root.path()).expect("first instance");
        let held = WriteLock::acquire(root.path(), Duration::from_millis(50)).expect("first");
        #[cfg(unix)]
        for name in [INSTANCE_LOCK_FILE, WRITE_LOCK_FILE] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.path().join(name), fs::Permissions::from_mode(0o644))
                .expect("loosen");
        }
        assert!(matches!(
            WriteLock::acquire(root.path(), Duration::from_millis(60)),
            Err(LockError::Busy)
        ));
        assert!(matches!(
            InstanceLock::acquire(root.path()),
            Err(LockError::AnotherInstance)
        ));
        #[cfg(unix)]
        for name in [INSTANCE_LOCK_FILE, WRITE_LOCK_FILE] {
            assert_eq!(
                mode(&root.path().join(name)),
                0o644,
                "denied attempt: {name}"
            );
        }
        drop((instance, held));
        let _instance = InstanceLock::acquire(root.path()).expect("instance released");
        let _write = WriteLock::acquire(root.path(), Duration::from_millis(50)).expect("released");
        #[cfg(unix)]
        for name in [INSTANCE_LOCK_FILE, WRITE_LOCK_FILE] {
            assert_eq!(
                mode(&root.path().join(name)),
                0o600,
                "holder tightened: {name}"
            );
        }
    }

    #[test]
    fn shared_readers_coexist_and_exclude_the_writer() {
        let root = TempRoot::new("read-lock");
        let first = ReadLock::acquire(root.path(), Duration::from_millis(100)).expect("first");
        let second = ReadLock::acquire(root.path(), Duration::from_millis(100)).expect("second");
        assert!(matches!(
            WriteLock::acquire(root.path(), Duration::from_millis(40)),
            Err(LockError::Busy)
        ));
        drop((first, second));
        let writer = WriteLock::acquire(root.path(), Duration::from_millis(100)).expect("writer");
        assert!(matches!(
            ReadLock::acquire(root.path(), Duration::from_millis(40)),
            Err(LockError::Busy)
        ));
        drop(writer);
        ReadLock::acquire(root.path(), Duration::from_millis(100)).expect("released");
    }

    /// Re-executed as a child by [`locks_are_released_when_the_holder_crashes`]; a no-op otherwise.
    #[test]
    #[ignore = "child process helper; run only by the crash-recovery test"]
    fn child_holds_instance_and_write_locks() {
        let Some(root) = std::env::var_os(CHILD_ROOT_ENV) else {
            return;
        };
        let root = PathBuf::from(root);
        let _instance = InstanceLock::acquire(&root).expect("child instance lock");
        let _write =
            WriteLock::acquire(&root, Duration::from_millis(500)).expect("child write lock");
        fs::write(root.join("child-ready"), b"ready").expect("ready marker");
        loop {
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn locks_are_released_when_the_holder_crashes() {
        let root = TempRoot::new("crash");
        let mut child = Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "locking::tests::child_holds_instance_and_write_locks",
                "--ignored",
                "--test-threads=1",
            ])
            .env(CHILD_ROOT_ENV, root.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn child");
        let ready = root.path().join("child-ready");
        let deadline = Instant::now() + Duration::from_secs(20);
        while !ready.exists() {
            assert!(Instant::now() < deadline, "child never took the locks");
            thread::sleep(Duration::from_millis(20));
        }
        assert!(matches!(
            InstanceLock::acquire(root.path()),
            Err(LockError::AnotherInstance)
        ));
        assert!(matches!(
            WriteLock::acquire(root.path(), Duration::from_millis(50)),
            Err(LockError::Busy)
        ));
        child.kill().expect("SIGKILL the holder");
        child.wait().expect("reap");
        InstanceLock::acquire(root.path()).expect("instance lock recovered after crash");
        WriteLock::acquire(root.path(), Duration::from_millis(500))
            .expect("write lock recovered after crash");
    }
}
