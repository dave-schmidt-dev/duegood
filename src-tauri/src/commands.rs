//! The webview's entire command surface. Every command is narrow and takes no path: the store
//! location is fixed, the legacy root comes from the native folder picker and is held only in
//! memory, and document reads use fixed names. Results and errors are content-free except the
//! dashboard documents themselves.

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{Runtime, State};

use crate::config::{
    canvas_refresh_setting_path, display_folder, ImportLimits, ReadLimits, LEGACY_LOCK_TIMEOUT,
    WRITE_LOCK_TIMEOUT,
};
use crate::documents::{
    read_avatar_bytes as read_avatar, read_dashboard_documents as read_documents, AvatarBytes,
    DashboardDocuments, DocumentsError,
};
use crate::import::{
    self, DryRunReport, ImportError, ImportOptions, ImportProgress, ImportSummary,
};
use crate::locking::LockError;
use crate::store::{atomic_write, node_json_bytes, read_capped, Store, StoreCondition, StoreError};
use crate::store::{ManualGradeResult, MutationResult, PendingLinkResult};
use crate::{clipboard, export, resources, snapshots};

/// Every command the webview may invoke; `capabilities/default.json` grants exactly these and
/// `build.rs` generates one permission per name (tests assert all three agree).
#[cfg(test)]
pub const COMMAND_NAMES: [&str; 22] = [
    "store_status",
    "choose_legacy_root",
    "dry_run_import",
    "import_legacy_root",
    "read_dashboard_documents",
    "set_item_completion",
    "set_discussion_field",
    "resolve_pending_source_link",
    "set_manual_grade",
    "read_avatar_bytes",
    "open_library_resource",
    "copy_assignment_text",
    "list_snapshots",
    "restore_snapshot",
    "export_legacy_folder",
    "set_canvas_refresh_enabled",
    "start_canvas_refresh",
    "start_ical_refresh",
    "prepare_store_promotion",
    "confirm_store_promotion",
    "demote_store_for_rollback",
    "export_frozen_for_rollback",
];

/// Native folder selection. The production picker is the OS dialog run from Rust, so the webview
/// needs no dialog permission and never handles a path.
pub trait FolderPicker: Send + Sync + 'static {
    fn pick_folder(&self) -> Option<PathBuf>;
    fn pick_promotion_backup(&self) -> Option<PathBuf> {
        self.pick_folder()
    }
    fn pick_export_folder(&self) -> Option<PathBuf> {
        self.pick_folder()
    }
    fn confirm_promotion(&self, _files: u64, _bytes: u64) -> bool {
        false
    }
    fn confirm_demotion(&self) -> bool {
        false
    }
}

/// OS folder dialog through `tauri-plugin-dialog`, called from Rust only.
pub struct DialogPicker<R: Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: Runtime> DialogPicker<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        DialogPicker { app }
    }
}

impl<R: Runtime> FolderPicker for DialogPicker<R> {
    fn pick_folder(&self) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        self.app
            .dialog()
            .file()
            .set_title("Choose the folder that holds coursework.json")
            .set_can_create_directories(false)
            .blocking_pick_folder()?
            .into_path()
            .ok()
    }
    fn pick_export_folder(&self) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        self.app
            .dialog()
            .file()
            .set_title("Choose a folder for the rollback export")
            .set_can_create_directories(false)
            .blocking_pick_folder()?
            .into_path()
            .ok()
    }
    fn pick_promotion_backup(&self) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        self.app
            .dialog()
            .file()
            .set_title("Choose the frozen backup to match against the preview store")
            .set_can_create_directories(false)
            .blocking_pick_folder()?
            .into_path()
            .ok()
    }
    fn confirm_promotion(&self, files: u64, bytes: u64) -> bool {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        self.app
            .dialog()
            .message(format!(
                "The selected frozen backup matches all {files} files ({bytes} bytes) in the current preview store. Promote this store to authoritative and allow owner-requested Canvas refresh?"
            ))
            .title("Promote Due Good store")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
    }
    fn confirm_demotion(&self) -> bool {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        self.app
            .dialog()
            .message(
                "Disable Canvas refresh, retain a private recovery copy, and return the authoritative store to preview state before rollback export?",
            )
            .title("Demote Due Good store for rollback")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
    }
}

/// Limits and waits. Production values are fixed; tests pass tighter ones.
#[derive(Debug, Clone, Copy)]
pub struct Settings {
    pub import_limits: ImportLimits,
    pub read_limits: ReadLimits,
    pub legacy_lock_timeout: Duration,
    pub write_lock_timeout: Duration,
}

impl Settings {
    pub const PRODUCTION: Settings = Settings {
        import_limits: ImportLimits::PRODUCTION,
        read_limits: ReadLimits::PRODUCTION,
        legacy_lock_timeout: LEGACY_LOCK_TIMEOUT,
        write_lock_timeout: WRITE_LOCK_TIMEOUT,
    };
}

/// Structured, content-free command error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusals: Option<BTreeMap<&'static str, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_types: Option<BTreeMap<&'static str, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_value: Option<bool>,
}

impl CommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        CommandError {
            code,
            message: message.into(),
            refusals: None,
            unsupported_types: None,
            current_value: None,
        }
    }
}

impl From<ImportError> for CommandError {
    fn from(error: ImportError) -> Self {
        let message = error.to_string();
        match error {
            ImportError::Refused {
                refusals,
                unsupported_types,
            } => CommandError {
                code: "refused",
                message,
                refusals: Some(refusals),
                unsupported_types: Some(unsupported_types),
                current_value: None,
            },
            ImportError::Store(StoreError::Lock(LockError::Busy)) => {
                CommandError::new("store-busy", message)
            }
            other => CommandError::new(other.code(), message),
        }
    }
}

impl From<StoreError> for CommandError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::ItemConflict(current) => CommandError {
                current_value: Some(current),
                ..CommandError::new(
                    "item-conflict",
                    "This item changed elsewhere. Latest state reloaded; try again.",
                )
            },
            StoreError::Lock(LockError::Busy) => {
                CommandError::new("store-busy", "The store is busy; try again.")
            }
            StoreError::Conflict => CommandError::new(
                "document-conflict",
                "This comparison changed elsewhere. Latest state reloaded; review it again.",
            ),
            other => CommandError::new("store-error", other.to_string()),
        }
    }
}

impl From<DocumentsError> for CommandError {
    fn from(error: DocumentsError) -> Self {
        match error {
            DocumentsError::NoStore => {
                CommandError::new("no-store", "No coursework has been imported yet.")
            }
            DocumentsError::Damaged(reason) => CommandError::new(
                "store-needs-recovery",
                format!("The app store needs recovery: {reason}."),
            ),
            DocumentsError::OverCap => CommandError::new(
                "over-cap",
                "A stored document exceeds its declared size cap; nothing was truncated.",
            ),
            DocumentsError::Store(error) => CommandError::new("store-error", error.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcalRefreshProgress {
    pub phase: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcalRefreshResult {
    pub status: &'static str,
    pub updated_at: String,
    pub added: u64,
    pub updated: u64,
    pub held: u64,
    pub removed: u64,
}

/// Store availability and state for the first-run and recovery screens. No legacy path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    /// `ready`, `another-instance`, or `unavailable`.
    pub availability: &'static str,
    /// `empty`, `preview`, `authoritative`, `damaged`, or `unknown`.
    pub state: &'static str,
    /// The fixed app-data folder, with the home prefix shown as `~`.
    pub data_folder: String,
    pub legacy_root_selected: bool,
    pub imported_at: Option<String>,
    pub files: Option<u64>,
    pub bytes: Option<u64>,
    /// True only when the store is authoritative, owner setting is on, and the bundled helper
    /// plus local store self-check are viable. This does not check BWS consumer or credentials.
    pub refresh_available: bool,
    /// Fixed BWS iCal helper, authoritative store, and free loopback receiver are available.
    pub ical_refresh_available: bool,
    /// Explicit owner preference, persisted separately from imported coursework. Defaults false.
    pub canvas_refresh_enabled: bool,
    /// A private daily recovery snapshot is currently being written in the background.
    pub snapshot_in_progress: bool,
    /// Content-free file and byte counts copied so far.
    pub snapshot_progress: Option<export::ExportProgress>,
    /// Content-free explanation when unavailable or damaged, or a non-blocking snapshot warning.
    pub problem: Option<String>,
}

const SNAPSHOT_WARNING: &str =
    "A daily snapshot could not be saved. Coursework remains available; check storage before relying on recovery.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderChoice {
    pub selected: bool,
}

/// Persisted owner refresh preference and whether the local app/helper prerequisites pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasRefreshSetting {
    pub canvas_refresh_enabled: bool,
    pub refresh_available: bool,
}

/// Readiness produced only after an exact synthetic or owner-selected backup match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionReadiness {
    pub proof_id: String,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionResult {
    pub state: &'static str,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemotionResult {
    pub state: &'static str,
    pub recovery_files: u64,
    pub recovery_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenExportResult {
    pub files: u64,
    pub bytes: u64,
    pub equal: bool,
}

struct PromotionProof {
    id: String,
    backup_root: PathBuf,
    backup_tree: export::LayoutSnapshot,
    store_tree: export::LayoutSnapshot,
    manifest_digest: String,
}

enum StoreSlot {
    Open(Store),
    AnotherInstance,
    Unavailable(String),
}

struct Inner {
    store: StoreSlot,
    data_folder: String,
    selected_root: Mutex<Option<PathBuf>>,
    import_running: Mutex<()>,
    promotion_proof: Mutex<Option<PromotionProof>>,
    picker: Box<dyn FolderPicker>,
    clipboard: Box<dyn clipboard::Clipboard>,
    resource_handler: Option<Box<dyn resources::ResourceHandler>>,
    snapshot_warning: Mutex<Option<String>>,
    snapshot_state: Mutex<SnapshotState>,
    snapshot_idle: Condvar,
    snapshot_gate: Mutex<()>,
    canvas_refresh_enabled: Mutex<bool>,
    refresh_running: Mutex<()>,
    refresh_child: Mutex<Option<Child>>,
    refresh_cancelled: AtomicBool,
    refresh_shutting_down: AtomicBool,
    settings: Settings,
}

#[derive(Default)]
struct SnapshotState {
    jobs: usize,
    progress: Option<export::ExportProgress>,
}

/// Managed state behind every command.
#[derive(Clone)]
pub struct AppState {
    shared: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn read_canvas_refresh_enabled(data_root: &Path) -> bool {
    let path = canvas_refresh_setting_path(data_root);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            return false;
        };
        if !metadata.file_type().is_file() || metadata.permissions().mode() & 0o777 != 0o600 {
            return false;
        }
    }
    let Ok(Some(bytes)) = read_capped(&path, 1024) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| value.get("canvasRefreshEnabled")?.as_bool())
        .unwrap_or(false)
}

fn persist_canvas_refresh_enabled(data_root: &Path, enabled: bool) -> Result<(), CommandError> {
    let path = canvas_refresh_setting_path(data_root);
    let bytes = node_json_bytes(&serde_json::json!({
        "canvasRefreshEnabled": enabled,
    }));
    atomic_write(&path, &bytes)
        .map_err(|_| CommandError::new("setting-write", "The refresh setting could not be saved."))
}

fn helper_is_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        let Ok(app_executable) = std::env::current_exe() else {
            return false;
        };
        let Some(helper) = crate::config::refresh_helper_path(&app_executable) else {
            return false;
        };
        let Some(broker) = crate::config::bws_secret_exec_path() else {
            return false;
        };
        is_executable_file(&helper) && is_executable_file(&broker)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Entrypoint used only by the bundled `duegood-refresh` binary. Production is broker-launched;
/// `test-overrides` builds may be run directly against the local synthetic Canvas server.
pub(crate) fn run_refresh_helper() -> Result<(), String> {
    if std::env::args_os().len() != 1 {
        return Err("refresh helper accepts no arguments".into());
    }
    #[cfg(all(not(target_os = "macos"), not(feature = "test-overrides")))]
    return Err("Canvas refresh is available only on macOS".into());

    let data_root = crate::config::resolve_helper_data_root()
        .map_err(|_| "the refresh data folder is unavailable".to_owned())?;
    let store = Store::open_helper(&data_root, WRITE_LOCK_TIMEOUT)
        .map_err(|_| "the authoritative store is unavailable".to_owned())?;
    crate::refresh::validate_helper_store(&data_root)
        .map_err(|_| "the authoritative store is unavailable".to_owned())?;
    let token = std::env::var("CANVAS_API_TOKEN")
        .map_err(|_| "refresh credentials are unavailable".to_owned())?;

    #[cfg(feature = "test-overrides")]
    let api = crate::canvas::CanvasApi::from_test_environment(&token)
        .map_err(|_| "the refresh API client is unavailable".to_owned())?;
    #[cfg(not(feature = "test-overrides"))]
    let api = crate::canvas::CanvasApi::new(&token)
        .map_err(|_| "the refresh API client is unavailable".to_owned())?;

    #[cfg(feature = "test-overrides")]
    let downloads = crate::downloads::DownloadClient::from_test_environment()
        .map_err(|_| "the refresh download client is unavailable".to_owned())?;
    #[cfg(not(feature = "test-overrides"))]
    let downloads = crate::downloads::DownloadClient::new()
        .map_err(|_| "the refresh download client is unavailable".to_owned())?;

    let stdout = std::io::stdout();
    let mut writer = std::io::BufWriter::new(stdout.lock());
    let mut report = |event: crate::refresh::RefreshProgress| {
        if write_helper_event(&mut writer, "progress", &event).is_err() {
            // Continuing after losing the parent channel could publish without visible progress.
            // Exiting here prevents every pre-publication failure from reaching commit.
            std::process::exit(1);
        }
    };
    let result = crate::refresh::refresh(
        &store,
        |prior, capture_progress| {
            let scopes = course_scopes_from_prior(&prior)?;
            crate::capture::capture_all(
                &api,
                &downloads,
                &prior.coursework,
                &prior,
                &scopes,
                capture_progress,
            )
            .map_err(|_| crate::refresh::RefreshError::FetchFailed)
        },
        &mut report,
    );
    drop(report);
    let result = result.map_err(|_| "Canvas refresh did not complete".to_owned())?;
    write_helper_event(&mut writer, "result", &result)
        .map_err(|_| "refresh result could not be delivered".to_owned())
}

fn course_scopes_from_prior(
    prior: &crate::refresh::RefreshPrior,
) -> Result<Vec<crate::capture::CourseScope>, crate::refresh::RefreshError> {
    course_scopes_from_documents(
        &prior.coursework,
        prior.course_scopes.as_ref(),
        &prior.course_ids_by_folder,
    )
}

fn course_scopes_from_documents(
    coursework: &serde_json::Value,
    root_scopes: Option<&serde_json::Value>,
    course_ids_by_folder: &BTreeMap<String, u64>,
) -> Result<Vec<crate::capture::CourseScope>, crate::refresh::RefreshError> {
    use std::collections::{BTreeMap, BTreeSet};

    let invalid = || crate::refresh::RefreshError::InvalidCapture;
    let root_scopes = root_scopes.ok_or_else(invalid)?;
    let configured = root_scopes
        .get("courses")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(invalid)?;
    let local_courses = coursework
        .get("courses")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(invalid)?;

    let mut local_by_key = BTreeMap::new();
    for local in local_courses {
        let Some(key) = local.get("key").and_then(serde_json::Value::as_str) else {
            return Err(invalid());
        };
        if key.is_empty() || local_by_key.contains_key(key) {
            return Err(invalid());
        }
        let folder = local
            .get("folder")
            .and_then(serde_json::Value::as_str)
            .and_then(normalized_refresh_folder);
        local_by_key.insert(key, folder);
    }

    let mut scopes = Vec::with_capacity(configured.len());
    let mut keys = BTreeSet::new();
    let mut folders = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for course in configured {
        let Some(key) = course.get("key").and_then(serde_json::Value::as_str) else {
            return Err(invalid());
        };
        let Some(canvas_course_id) = course
            .get("canvasId")
            .and_then(serde_json::Value::as_u64)
            .filter(|id| *id > 0)
        else {
            return Err(invalid());
        };
        if key.is_empty() || !keys.insert(key.to_owned()) || !ids.insert(canvas_course_id) {
            return Err(invalid());
        }
        let Some(Some(folder)) = local_by_key.get(key) else {
            return Err(invalid());
        };
        if !folders.insert(folder.clone())
            || course_ids_by_folder.get(folder) != Some(&canvas_course_id)
        {
            return Err(invalid());
        }
        scopes.push(crate::capture::CourseScope {
            key: key.to_owned(),
            folder: format!("classes/{folder}"),
            canvas_course_id,
        });
    }

    if scopes.len() != course_ids_by_folder.len()
        || course_ids_by_folder
            .keys()
            .any(|folder| !folders.contains(folder))
    {
        return Err(invalid());
    }
    Ok(scopes)
}

fn normalized_refresh_folder(value: &str) -> Option<String> {
    let folder = value.strip_prefix("classes/").unwrap_or(value);
    crate::import::is_course_folder_name(folder).then(|| folder.to_owned())
}

fn write_helper_event(
    writer: &mut impl std::io::Write,
    event_type: &str,
    value: &impl Serialize,
) -> io::Result<()> {
    let mut value = serde_json::to_value(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "helper event serialization failed",
        )
    })?;
    let Some(object) = value.as_object_mut() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "helper event was not an object",
        ));
    };
    object.insert(
        "type".to_owned(),
        serde_json::Value::String(event_type.to_owned()),
    );
    serde_json::to_writer(&mut *writer, &value)
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "helper event write failed"))?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    metadata.file_type().is_file() && metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable_file(_path: &Path) -> bool {
    false
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RefreshHelperMessage {
    Progress {
        phase: String,
        completed: u64,
        total: Option<u64>,
        bytes_done: Option<u64>,
    },
    Result {
        status: String,
        updated_at: Option<String>,
    },
}

fn safe_refresh_timestamp(value: Option<String>) -> Option<String> {
    let value = value?;
    if value.len() <= 40
        && value.contains('T')
        && value.bytes().all(|byte| {
            byte.is_ascii_digit() || matches!(byte, b'T' | b'Z' | b'-' | b':' | b'.' | b'+')
        })
    {
        Some(value)
    } else {
        None
    }
}

fn read_bounded_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::with_capacity(256);
    let mut too_long = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if line.is_empty() && !too_long {
                return Ok(None);
            }
            return if too_long {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "oversized helper line",
                ))
            } else {
                Ok(Some(line))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if !too_long {
            if line.len().saturating_add(consumed) > limit {
                line.clear();
                too_long = true;
            } else {
                line.extend_from_slice(&available[..consumed]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            if too_long {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "oversized helper line",
                ));
            }
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

fn terminate_process_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = -(child.id() as i32);
        // SAFETY: sending signals to the process group does not dereference pointers.
        unsafe {
            libc::kill(process_group, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        // Also terminate any descendants left in the helper's process group.
        unsafe {
            libc::kill(process_group, libc::SIGKILL);
        }
        let _ = child.wait();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl AppState {
    /// Stops an active refresh process group; called from Tauri's application-exit hook.
    pub fn terminate_canvas_refresh(&self) {
        self.shared.shutdown_refresh_process();
    }

    /// Opens the fixed store. A second instance or an unusable folder is reported, not fatal.
    pub fn open(
        data_root: Result<PathBuf, String>,
        home: Option<&Path>,
        picker: Box<dyn FolderPicker>,
        settings: Settings,
    ) -> Self {
        Self::open_with_handlers(
            data_root,
            home,
            picker,
            Box::new(clipboard::SystemClipboard),
            None,
            settings,
        )
    }

    /// Opens with native action handlers. Tests supply doubles; production supplies Rust-only OS
    /// implementations. No handler object crosses the webview boundary.
    pub fn open_with_handlers(
        data_root: Result<PathBuf, String>,
        home: Option<&Path>,
        picker: Box<dyn FolderPicker>,
        clipboard: Box<dyn clipboard::Clipboard>,
        resource_handler: Option<Box<dyn resources::ResourceHandler>>,
        settings: Settings,
    ) -> Self {
        let (store, data_folder) = match data_root {
            Ok(root) => {
                let folder = display_folder(&root, home);
                let store = match Store::open(&root, settings.write_lock_timeout) {
                    Ok(store) => StoreSlot::Open(store),
                    Err(StoreError::Lock(LockError::AnotherInstance)) => StoreSlot::AnotherInstance,
                    Err(error) => StoreSlot::Unavailable(error.to_string()),
                };
                (store, folder)
            }
            Err(reason) => (StoreSlot::Unavailable(reason), String::new()),
        };
        let should_snapshot = matches!(&store, StoreSlot::Open(opened) if opened.read_lock().ok().is_some_and(|_read_lock| matches!(opened.condition(), Ok(StoreCondition::Ready(_)))));
        let canvas_refresh_enabled = match &store {
            StoreSlot::Open(opened) => read_canvas_refresh_enabled(opened.data_root()),
            StoreSlot::AnotherInstance | StoreSlot::Unavailable(_) => false,
        };
        let app = AppState {
            shared: Arc::new(Inner {
                store,
                data_folder,
                selected_root: Mutex::new(None),
                import_running: Mutex::new(()),
                promotion_proof: Mutex::new(None),
                picker,
                clipboard,
                resource_handler,
                snapshot_warning: Mutex::new(None),
                snapshot_state: Mutex::new(SnapshotState::default()),
                snapshot_idle: Condvar::new(),
                snapshot_gate: Mutex::new(()),
                canvas_refresh_enabled: Mutex::new(canvas_refresh_enabled),
                refresh_running: Mutex::new(()),
                refresh_child: Mutex::new(None),
                refresh_cancelled: AtomicBool::new(false),
                refresh_shutting_down: AtomicBool::new(false),
                settings,
            }),
        };
        if should_snapshot {
            if let Err(error) = spawn_daily_snapshot(Arc::clone(&app.shared), |store, report| {
                snapshots::snapshot_daily_with_progress(store, std::time::SystemTime::now(), report)
                    .map(|_| ())
            }) {
                eprintln!(
                    "A private daily snapshot could not be started ({:?}).",
                    error.kind()
                );
                *lock(&app.shared.snapshot_warning) = Some(SNAPSHOT_WARNING.to_owned());
            }
        }
        app
    }
}

/// Runs a daily snapshot away from Tauri setup so a large private store cannot block first paint.
/// The store's existing write lock protects the copied tree from concurrent mutations or import.
fn spawn_daily_snapshot(
    inner: Arc<Inner>,
    snapshot: impl FnOnce(&Store, &mut dyn FnMut(export::ExportProgress)) -> Result<(), StoreError>
        + Send
        + 'static,
) -> std::io::Result<JoinHandle<()>> {
    {
        let mut state = lock(&inner.snapshot_state);
        state.jobs += 1;
        if state.progress.is_none() {
            state.progress = Some(export::ExportProgress::default());
        }
    }
    let worker_inner = Arc::clone(&inner);
    let result = thread::Builder::new()
        .name("duegood-daily-snapshot".into())
        .spawn(move || {
            let _gate = lock(&worker_inner.snapshot_gate);
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                match &worker_inner.store {
                    StoreSlot::Open(store) => snapshot(store, &mut |progress| {
                        lock(&worker_inner.snapshot_state).progress = Some(progress);
                    }),
                    StoreSlot::AnotherInstance | StoreSlot::Unavailable(_) => Ok(()),
                }
            }));
            match outcome {
                Ok(Ok(())) => *lock(&worker_inner.snapshot_warning) = None,
                Ok(Err(_)) | Err(_) => {
                    eprintln!("A private daily snapshot could not be saved.");
                    *lock(&worker_inner.snapshot_warning) = Some(SNAPSHOT_WARNING.to_owned());
                }
            }
            let mut state = lock(&worker_inner.snapshot_state);
            state.jobs = state.jobs.saturating_sub(1);
            state.progress = if state.jobs == 0 {
                None
            } else {
                Some(export::ExportProgress::default())
            };
            worker_inner.snapshot_idle.notify_all();
        });
    if result.is_err() {
        let mut state = lock(&inner.snapshot_state);
        state.jobs = state.jobs.saturating_sub(1);
        state.progress = if state.jobs == 0 {
            None
        } else {
            Some(export::ExportProgress::default())
        };
        inner.snapshot_idle.notify_all();
        *lock(&inner.snapshot_warning) = Some(SNAPSHOT_WARNING.to_owned());
    }
    result
}

impl Inner {
    fn store(&self) -> Result<&Store, CommandError> {
        match &self.store {
            StoreSlot::Open(store) => Ok(store),
            StoreSlot::AnotherInstance => Err(CommandError::new(
                "another-instance",
                "Due Good is already open in another window. Use that window; this one changes nothing.",
            )),
            StoreSlot::Unavailable(reason) => {
                Err(CommandError::new("store-unavailable", format!("The app data folder is unavailable: {reason}.")))
            }
        }
    }

    fn status(&self) -> StoreStatus {
        let legacy_root_selected = lock(&self.selected_root).is_some();
        let (snapshot_in_progress, snapshot_progress) = {
            let snapshot = lock(&self.snapshot_state);
            (snapshot.jobs > 0, snapshot.progress)
        };
        let mut status = StoreStatus {
            availability: "ready",
            state: "unknown",
            data_folder: self.data_folder.clone(),
            legacy_root_selected,
            imported_at: None,
            files: None,
            bytes: None,
            refresh_available: false,
            ical_refresh_available: false,
            canvas_refresh_enabled: *lock(&self.canvas_refresh_enabled),
            snapshot_in_progress,
            snapshot_progress,
            problem: lock(&self.snapshot_warning).clone(),
        };
        match &self.store {
            StoreSlot::AnotherInstance => status.availability = "another-instance",
            StoreSlot::Unavailable(reason) => {
                status.availability = "unavailable";
                status.problem = Some(reason.clone());
            }
            StoreSlot::Open(store) => {
                let condition = {
                    match store.read_lock() {
                        Ok(_read_lock) => store.condition(),
                        Err(error) => Err(error),
                    }
                };
                match condition {
                    Ok(StoreCondition::Empty) => status.state = "empty",
                    Ok(StoreCondition::Ready(summary)) => {
                        status.state = summary.state.as_str();
                        status.imported_at = summary.imported_at;
                        status.files = summary.files;
                        status.bytes = summary.bytes;
                    }
                    Ok(StoreCondition::Damaged(reason)) => {
                        status.state = "damaged";
                        status.problem = Some(reason.to_owned());
                    }
                    Err(error) => {
                        status.availability = "unavailable";
                        status.problem = Some(error.to_string());
                    }
                }
                status.refresh_available = self.refresh_available(store);
                status.ical_refresh_available = self.ical_refresh_available(store);
            }
        }
        status
    }

    fn set_canvas_refresh_enabled(
        &self,
        enabled: bool,
    ) -> Result<CanvasRefreshSetting, CommandError> {
        let _refresh = self
            .refresh_running
            .try_lock()
            .map_err(|_| CommandError::new("refresh-running", "A refresh is already running."))?;
        let store = self.store()?;
        persist_canvas_refresh_enabled(store.data_root(), enabled)?;
        *lock(&self.canvas_refresh_enabled) = enabled;
        Ok(CanvasRefreshSetting {
            canvas_refresh_enabled: enabled,
            refresh_available: self.refresh_available(store),
        })
    }

    fn refresh_available(&self, store: &Store) -> bool {
        if !*lock(&self.canvas_refresh_enabled) {
            return false;
        }
        #[cfg(target_os = "macos")]
        {
            helper_is_installed()
                && crate::refresh::validate_helper_store(store.data_root()).is_ok()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    fn ical_refresh_available(&self, store: &Store) -> bool {
        #[cfg(target_os = "macos")]
        {
            let scope_ready = match store.condition() {
                Ok(StoreCondition::Empty) => true,
                Ok(StoreCondition::Ready(summary))
                    if summary.state == crate::store::StoreState::Authoritative =>
                {
                    crate::ical_apply::normalization_options(store).is_ok()
                }
                _ => false,
            };
            let broker =
                crate::config::bws_secret_exec_path().is_some_and(|path| is_executable_file(&path));
            let receiver_free = std::net::TcpListener::bind(("127.0.0.1", 2137)).is_ok();
            scope_ready && broker && receiver_free
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = store;
            false
        }
    }

    fn refresh_ical(
        &self,
        on_progress: &mut dyn FnMut(IcalRefreshProgress) -> bool,
    ) -> Result<IcalRefreshResult, CommandError> {
        if self.refresh_shutting_down.load(Ordering::SeqCst) {
            return Err(CommandError::new(
                "refresh-cancelled",
                "Calendar refresh is stopping with the app.",
            ));
        }
        let _running = self
            .refresh_running
            .try_lock()
            .map_err(|_| CommandError::new("refresh-running", "A refresh is already running."))?;
        let store = self.store()?;
        let options = match store.condition()? {
            StoreCondition::Empty => None,
            StoreCondition::Ready(summary) if summary.state == crate::store::StoreState::Authoritative =>
                Some(crate::ical_apply::normalization_options(store).map_err(|_| {
                    CommandError::new("calendar-scope", "The native course or institution scope needs review before calendar refresh.")
                })?),
            _ => return Err(CommandError::new("setup-required", "Calendar setup requires an empty or authoritative app store.")),
        };
        let progress_lost = AtomicBool::new(false);
        let mut failure = None;
        let mut outcome = None;
        let received = crate::ical_receiver::run_ical_import(
            |phase| {
                let label = match phase {
                    crate::ical_receiver::IcalImportPhase::BrokerStarting => "broker-starting",
                    crate::ical_receiver::IcalImportPhase::WaitingForCalendar => {
                        "waiting-for-calendar"
                    }
                    crate::ical_receiver::IcalImportPhase::Importing => "importing",
                    crate::ical_receiver::IcalImportPhase::Completed => "complete",
                };
                if !on_progress(IcalRefreshProgress { phase: label }) {
                    progress_lost.store(true, Ordering::SeqCst);
                }
            },
            |bytes| {
                if progress_lost.load(Ordering::SeqCst) {
                    failure = Some("progress-lost");
                    return Err(());
                }
                let scope = match options.as_ref() {
                    Some(scope) => scope.clone(),
                    None => match crate::ical::bootstrap_options(bytes) {
                        Ok(scope) => scope,
                        Err(_) => {
                            failure = Some("invalid-calendar");
                            return Err(());
                        }
                    },
                };
                let normalized = match crate::ical::normalize_canvas_ical(bytes, &scope) {
                    Ok(value) => value,
                    Err(_) => {
                        failure = Some("invalid-calendar");
                        return Err(());
                    }
                };
                let finished_at = crate::store::utc_stamp(std::time::SystemTime::now()).iso;
                let applied = if options.is_some() {
                    crate::ical_apply::apply_normalization(store, &scope, &finished_at, &normalized)
                } else {
                    crate::ical_apply::bootstrap_normalization(
                        store,
                        &scope,
                        &finished_at,
                        &normalized,
                    )
                };
                match applied {
                    Ok(value) => {
                        outcome = Some((value, finished_at));
                        Ok(())
                    }
                    Err(_) => {
                        failure = Some("store-changed");
                        Err(())
                    }
                }
            },
        );
        if let Some(reason) = failure {
            return Err(CommandError::new(
                reason,
                "Calendar refresh could not be applied; existing coursework was kept.",
            ));
        }
        received.map_err(|error| {
            let code = match error {
                crate::ical_receiver::IcalReceiverError::AlreadyRunning => "receiver-in-use",
                crate::ical_receiver::IcalReceiverError::BrokerUnavailable => "broker-unavailable",
                crate::ical_receiver::IcalReceiverError::TimedOut => "calendar-timeout",
                crate::ical_receiver::IcalReceiverError::HelperFailed => "calendar-fetch-failed",
                crate::ical_receiver::IcalReceiverError::RequestRejected => {
                    "calendar-request-rejected"
                }
                crate::ical_receiver::IcalReceiverError::ImportRejected => {
                    "calendar-import-rejected"
                }
            };
            CommandError::new(
                code,
                "Calendar refresh did not complete; existing coursework was kept.",
            )
        })?;
        let (applied, updated_at) = outcome.ok_or_else(|| {
            CommandError::new(
                "calendar-import-rejected",
                "Calendar refresh returned no import result.",
            )
        })?;
        Ok(IcalRefreshResult {
            status: "complete",
            updated_at,
            added: applied.added as u64,
            updated: applied.updated as u64,
            held: (applied.held + applied.parser_held) as u64,
            removed: applied.removed as u64,
        })
    }

    fn refresh(
        &self,
        progress: &mut dyn FnMut(crate::refresh::RefreshProgress),
    ) -> Result<crate::refresh::RefreshResult, CommandError> {
        if self.refresh_shutting_down.load(Ordering::SeqCst) {
            return Err(CommandError::new(
                "refresh-cancelled",
                "Canvas refresh is stopping with the app.",
            ));
        }
        let _running = self
            .refresh_running
            .try_lock()
            .map_err(|_| CommandError::new("refresh-running", "A refresh is already running."))?;
        self.refresh_cancelled.store(false, Ordering::SeqCst);
        let store = self.store()?;
        let condition = {
            let _read_lock = store.read_lock().map_err(|_| {
                CommandError::new(
                    "store-unavailable",
                    "Canvas refresh is unavailable because the store needs recovery.",
                )
            })?;
            store.condition()
        };
        match condition {
            Ok(StoreCondition::Ready(summary))
                if summary.state == crate::store::StoreState::Authoritative => {}
            Ok(StoreCondition::Ready(_)) => {
                return Err(CommandError::new(
                    "preview-refresh",
                    "A preview copy cannot refresh from Canvas.",
                ));
            }
            Ok(StoreCondition::Empty) => {
                return Err(CommandError::new(
                    "no-store",
                    "Import a store before refreshing.",
                ));
            }
            Ok(StoreCondition::Damaged(_)) | Err(_) => {
                return Err(CommandError::new(
                    "store-unavailable",
                    "Canvas refresh is unavailable because the store needs recovery.",
                ));
            }
        }
        if !*lock(&self.canvas_refresh_enabled) {
            return Err(CommandError::new(
                "refresh-disabled",
                "Canvas refresh is unavailable until it is enabled in settings.",
            ));
        }
        if !self.refresh_available(store) {
            return Err(CommandError::new(
                "refresh-unavailable",
                "Canvas refresh is unavailable on this installation.",
            ));
        }
        #[cfg(target_os = "macos")]
        {
            self.run_broker_refresh(progress)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = progress;
            Err(CommandError::new(
                "refresh-unavailable",
                "Canvas refresh is available only on macOS.",
            ))
        }
    }

    fn terminate_refresh_process(&self) {
        self.refresh_cancelled.store(true, Ordering::SeqCst);
        if let Some(mut child) = lock(&self.refresh_child).take() {
            terminate_process_group(&mut child);
        }
    }

    fn shutdown_refresh_process(&self) {
        self.refresh_shutting_down.store(true, Ordering::SeqCst);
        self.terminate_refresh_process();
    }

    #[cfg(target_os = "macos")]
    fn run_broker_refresh(
        &self,
        report: &mut dyn FnMut(crate::refresh::RefreshProgress),
    ) -> Result<crate::refresh::RefreshResult, CommandError> {
        const MAX_RUNTIME: Duration = Duration::from_secs(30 * 60);
        const MAX_LINE_BYTES: usize = 64 * 1024;
        let broker = crate::config::bws_secret_exec_path().ok_or_else(|| {
            CommandError::new(
                "refresh-unavailable",
                "Canvas refresh is unavailable on this installation.",
            )
        })?;
        if !is_executable_file(&broker) {
            return Err(CommandError::new(
                "refresh-unavailable",
                "Canvas refresh is unavailable on this installation.",
            ));
        }

        let mut command = Command::new(broker);
        command
            .args(["duegood-desktop-refresh", "--"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|_| {
            CommandError::new(
                "refresh-unavailable",
                "The refresh broker could not be started.",
            )
        })?;
        let Some(stdout) = child.stdout.take() else {
            terminate_process_group(&mut child);
            return Err(CommandError::new(
                "refresh-unavailable",
                "The refresh helper did not start correctly.",
            ));
        };
        {
            let mut active = lock(&self.refresh_child);
            if self.refresh_shutting_down.load(Ordering::SeqCst) {
                terminate_process_group(&mut child);
                return Err(CommandError::new(
                    "refresh-cancelled",
                    "Canvas refresh is stopping with the app.",
                ));
            }
            if active.is_some() {
                terminate_process_group(&mut child);
                return Err(CommandError::new(
                    "refresh-running",
                    "A refresh is already running.",
                ));
            }
            *active = Some(child);
        }

        let (sender, receiver) = mpsc::sync_channel::<Result<Vec<u8>, ()>>(16);
        if thread::Builder::new()
            .name("duegood-refresh-output".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    match read_bounded_line(&mut reader, MAX_LINE_BYTES) {
                        Ok(Some(line)) => {
                            if sender.send(Ok(line)).is_err() {
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(_) => {
                            let _ = sender.send(Err(()));
                            break;
                        }
                    }
                }
            })
            .is_err()
        {
            self.terminate_refresh_process();
            return Err(CommandError::new(
                "refresh-output",
                "The refresh helper output could not be read.",
            ));
        }

        let deadline = Instant::now() + MAX_RUNTIME;
        let mut child_status = None;
        let mut reader_closed = false;
        let mut result = None;
        let mut protocol_failed = false;
        while child_status.is_none() || !reader_closed {
            if self.refresh_cancelled.load(Ordering::SeqCst) {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                self.terminate_refresh_process();
                return Err(CommandError::new(
                    "refresh-timeout",
                    "Canvas refresh timed out; no success was recorded.",
                ));
            }
            match receiver.recv_timeout((deadline - now).min(Duration::from_millis(100))) {
                Ok(Ok(line)) => match serde_json::from_slice::<RefreshHelperMessage>(&line) {
                    Ok(RefreshHelperMessage::Progress {
                        phase,
                        completed,
                        total,
                        bytes_done,
                    }) => {
                        if result.is_some() {
                            protocol_failed = true;
                            break;
                        }
                        let Some(phase) = crate::refresh::RefreshPhase::parse(&phase) else {
                            protocol_failed = true;
                            break;
                        };
                        report(crate::refresh::RefreshProgress::new(
                            phase, completed, total, bytes_done,
                        ));
                    }
                    Ok(RefreshHelperMessage::Result { status, updated_at }) => {
                        if result.is_some() || !matches!(status.as_str(), "complete" | "incomplete")
                        {
                            protocol_failed = true;
                            break;
                        }
                        result = Some(crate::refresh::RefreshResult {
                            status,
                            updated_at: safe_refresh_timestamp(updated_at),
                        });
                    }
                    Err(_) => {
                        protocol_failed = true;
                        break;
                    }
                },
                Ok(Err(())) => {
                    protocol_failed = true;
                    break;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => reader_closed = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            if child_status.is_none() {
                let mut active = lock(&self.refresh_child);
                if let Some(child) = active.as_mut() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            child_status = Some(status);
                        }
                        Ok(None) => {}
                        Err(_) => {
                            protocol_failed = true;
                            break;
                        }
                    }
                } else if self.refresh_cancelled.load(Ordering::SeqCst) {
                    break;
                }
            }
        }

        if protocol_failed {
            self.terminate_refresh_process();
            return Err(CommandError::new(
                "refresh-output",
                "The refresh helper returned an invalid response.",
            ));
        }
        if self.refresh_cancelled.load(Ordering::SeqCst) {
            return Err(CommandError::new(
                "refresh-cancelled",
                "Canvas refresh was stopped before it completed.",
            ));
        }
        // Keep the process-group handle until stdout reaches EOF too. A descendant that inherited
        // stdout remains in the group and is still terminable if the app exits or the timeout hits.
        lock(&self.refresh_child).take();
        let Some(status) = child_status else {
            self.terminate_refresh_process();
            return Err(CommandError::new(
                "refresh-failed",
                "Canvas refresh did not complete.",
            ));
        };
        if !status.success() {
            return Err(CommandError::new(
                "refresh-failed",
                "Canvas refresh failed or is unavailable. Check the local refresh setup.",
            ));
        }
        result.ok_or_else(|| {
            CommandError::new(
                "refresh-output",
                "The refresh helper did not report a completed result.",
            )
        })
    }

    fn choose(&self) -> FolderChoice {
        if let Some(root) = self.picker.pick_folder() {
            *lock(&self.selected_root) = Some(root);
        }
        FolderChoice {
            selected: lock(&self.selected_root).is_some(),
        }
    }

    fn selected_root(&self) -> Result<PathBuf, CommandError> {
        lock(&self.selected_root)
            .clone()
            .ok_or_else(|| CommandError::new("no-legacy-root", "Choose the legacy folder first."))
    }

    fn dry_run(&self) -> Result<DryRunReport, CommandError> {
        let root = self.selected_root()?;
        Ok(import::dry_run(&root, &self.settings.import_limits)?)
    }

    /// Runs one import. The selection is cleared after a successful import and kept after a
    /// failure so the owner can retry; it is never persisted.
    fn import(
        self: &Arc<Self>,
        replace_preview: bool,
        progress: &mut dyn FnMut(ImportProgress),
    ) -> Result<ImportSummary, CommandError> {
        let store = self.store()?;
        let root = self.selected_root()?;
        let _running = self
            .import_running
            .try_lock()
            .map_err(|_| CommandError::new("import-running", "An import is already running."))?;
        let options = ImportOptions {
            limits: self.settings.import_limits,
            legacy_lock_timeout: self.settings.legacy_lock_timeout,
            replace_preview,
        };
        let summary = import::import_legacy_root(store, &root, &options, progress)?;
        if let Err(error) = spawn_daily_snapshot(Arc::clone(self), |store, report| {
            snapshots::snapshot_daily_with_progress(store, std::time::SystemTime::now(), report)
                .map(|_| ())
        }) {
            eprintln!(
                "A private snapshot could not be started after import ({:?}).",
                error.kind()
            );
            *lock(&self.snapshot_warning) = Some(SNAPSHOT_WARNING.to_owned());
        }
        *lock(&self.selected_root) = None;
        Ok(summary)
    }

    #[cfg(test)]
    fn wait_for_snapshots(&self) {
        let mut state = lock(&self.snapshot_state);
        while state.jobs > 0 {
            state = self
                .snapshot_idle
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn documents(&self) -> Result<DashboardDocuments, CommandError> {
        Ok(read_documents(self.store()?, &self.settings.read_limits)?)
    }

    fn mutate(
        &self,
        item_id: &str,
        field: &str,
        expected: bool,
        value: bool,
    ) -> Result<MutationResult, CommandError> {
        Ok(self.store()?.mutate_item(item_id, field, expected, value)?)
    }

    fn avatar(&self) -> Result<Option<AvatarBytes>, CommandError> {
        Ok(read_avatar(self.store()?)?)
    }

    fn resource(&self, id: &str) -> Result<resources::ResourceAction, CommandError> {
        let handler = self.resource_handler.as_deref().ok_or_else(|| {
            CommandError::new("unavailable", "The native resource handler is unavailable.")
        })?;
        Ok(resources::open_resource(self.store()?, id, handler)?)
    }

    fn copy(&self, text: &str) -> Result<(), CommandError> {
        clipboard::copy_text(self.clipboard.as_ref(), text)
            .map_err(|_| CommandError::new("clipboard", "The assignment could not be copied."))
    }

    fn snapshots(&self) -> Result<Vec<snapshots::SnapshotInfo>, CommandError> {
        Ok(snapshots::list_snapshots(self.store()?)?)
    }

    fn restore(&self, id: &str) -> Result<(), CommandError> {
        Ok(snapshots::restore_snapshot(self.store()?, id)?)
    }

    fn export(
        &self,
        progress: &mut dyn FnMut(export::ExportProgress),
    ) -> Result<export::ExportProgress, CommandError> {
        let store = self.store()?;
        let parent = self
            .picker
            .pick_export_folder()
            .ok_or_else(|| CommandError::new("cancelled", "No export folder was selected."))?;
        export::ensure_legacy_refreshable_export_compatible(store).map_err(|_| {
            CommandError::new(
                "legacy-compatibility-gated",
                "Legacy refresh compatibility is unconfirmed; use the frozen rollback export.",
            )
        })?;
        Ok(export::export_legacy(store, &parent, progress)?)
    }

    fn prepare_store_promotion(
        &self,
        progress: &mut dyn FnMut(export::ExportProgress),
    ) -> Result<PromotionReadiness, CommandError> {
        let backup = self
            .picker
            .pick_promotion_backup()
            .ok_or_else(|| CommandError::new("cancelled", "No frozen backup was selected."))?;
        let store = self.store()?;
        let _import = self
            .import_running
            .try_lock()
            .map_err(|_| CommandError::new("import-running", "An import is already running."))?;
        let _refresh = self
            .refresh_running
            .try_lock()
            .map_err(|_| CommandError::new("refresh-running", "A refresh is already running."))?;
        let _refresh_lease = store.refresh_lock()?;
        let write = store.write_lock()?;

        let StoreCondition::Ready(manifest) = store.condition()? else {
            return Err(CommandError::new(
                "store-state",
                "Promotion requires a ready preview store.",
            ));
        };
        if manifest.state != crate::store::StoreState::Preview {
            return Err(CommandError::new(
                "store-state",
                "Promotion requires a ready preview store.",
            ));
        }
        let backup_metadata = std::fs::symlink_metadata(&backup).map_err(|_| {
            CommandError::new("backup-invalid", "The selected backup is unavailable.")
        })?;
        if !backup_metadata.is_dir() || backup_metadata.file_type().is_symlink() {
            return Err(CommandError::new(
                "backup-invalid",
                "The selected backup must be a plain folder.",
            ));
        }
        let backup_root = std::fs::canonicalize(&backup).map_err(|_| {
            CommandError::new("backup-invalid", "The selected backup is unavailable.")
        })?;
        let data_root = std::fs::canonicalize(store.data_root()).map_err(StoreError::from)?;
        if backup_root.starts_with(&data_root) || data_root.starts_with(&backup_root) {
            return Err(CommandError::new(
                "backup-invalid",
                "Choose a frozen backup folder outside the app data folder.",
            ));
        }
        let backup_tree = export::snapshot_layout_with_progress(&backup_root, false, progress)?;
        let store_tree =
            export::snapshot_layout_with_progress(&store.store_dir(), false, progress)?;
        if backup_tree != store_tree {
            return Err(CommandError::new(
                "backup-mismatch",
                "The selected backup does not exactly match the preview store; nothing changed.",
            ));
        }
        let proof_id = uuid::Uuid::new_v4().simple().to_string();
        *lock(&self.promotion_proof) = Some(PromotionProof {
            id: proof_id.clone(),
            backup_root,
            backup_tree: backup_tree.clone(),
            store_tree: store_tree.clone(),
            manifest_digest: manifest.digest,
        });
        drop(write);
        Ok(PromotionReadiness {
            proof_id,
            files: store_tree.files,
            bytes: store_tree.bytes,
        })
    }

    fn confirm_store_promotion(
        &self,
        proof_id: &str,
        progress: &mut dyn FnMut(export::ExportProgress),
    ) -> Result<PromotionResult, CommandError> {
        let proof = {
            let mut pending = lock(&self.promotion_proof);
            if pending.as_ref().map(|proof| proof.id.as_str()) != Some(proof_id) {
                return Err(CommandError::new(
                    "promotion-proof",
                    "This promotion readiness proof is missing, expired, or already used.",
                ));
            }
            pending.take().expect("proof identity was checked")
        };
        if !self
            .picker
            .confirm_promotion(proof.store_tree.files, proof.store_tree.bytes)
        {
            return Err(CommandError::new(
                "cancelled",
                "Promotion was cancelled; the store did not change.",
            ));
        }
        let store = self.store()?;
        let _import = self
            .import_running
            .try_lock()
            .map_err(|_| CommandError::new("import-running", "An import is already running."))?;
        let _refresh = self
            .refresh_running
            .try_lock()
            .map_err(|_| CommandError::new("refresh-running", "A refresh is already running."))?;
        let _refresh_lease = store.refresh_lock()?;
        let write = store.write_lock()?;
        let StoreCondition::Ready(manifest) = store.condition()? else {
            return Err(CommandError::new(
                "store-state",
                "The store is no longer a ready preview; promotion did not occur.",
            ));
        };
        if manifest.state != crate::store::StoreState::Preview
            || manifest.digest != proof.manifest_digest
        {
            return Err(CommandError::new(
                "store-changed",
                "The store changed after readiness was prepared; promotion did not occur.",
            ));
        }
        let backup_root = std::fs::canonicalize(&proof.backup_root).map_err(|_| {
            CommandError::new(
                "store-changed",
                "The frozen backup changed after readiness was prepared.",
            )
        })?;
        if backup_root != proof.backup_root {
            return Err(CommandError::new(
                "store-changed",
                "The frozen backup changed after readiness was prepared; promotion did not occur.",
            ));
        }
        let backup_tree =
            export::snapshot_layout_with_progress(&proof.backup_root, false, progress)?;
        let store_tree =
            export::snapshot_layout_with_progress(&store.store_dir(), false, progress)?;
        if backup_tree != proof.backup_tree
            || store_tree != proof.store_tree
            || backup_tree != store_tree
        {
            return Err(CommandError::new(
                "store-changed",
                "The backup or preview store changed after readiness was prepared; promotion did not occur.",
            ));
        }
        store.set_state_locked(
            &write,
            crate::store::StoreState::Preview,
            &proof.manifest_digest,
            crate::store::StoreState::Authoritative,
        )?;
        Ok(PromotionResult {
            state: "authoritative",
            files: store_tree.files,
            bytes: store_tree.bytes,
        })
    }

    fn demote_store_for_rollback(
        &self,
        progress: &mut dyn FnMut(export::ExportProgress),
    ) -> Result<DemotionResult, CommandError> {
        if !self.picker.confirm_demotion() {
            return Err(CommandError::new(
                "cancelled",
                "Store demotion was cancelled; no state changed.",
            ));
        }
        let store = self.store()?;
        let _import = self
            .import_running
            .try_lock()
            .map_err(|_| CommandError::new("import-running", "An import is already running."))?;
        let _refresh = self
            .refresh_running
            .try_lock()
            .map_err(|_| CommandError::new("refresh-running", "A refresh is already running."))?;
        let _refresh_lease = store.refresh_lock()?;
        let _snapshot = store.snapshot_lock()?;
        let write = store.write_lock()?;
        let StoreCondition::Ready(manifest) = store.condition()? else {
            return Err(CommandError::new(
                "store-state",
                "Demotion requires a ready authoritative store.",
            ));
        };
        if manifest.state != crate::store::StoreState::Authoritative {
            return Err(CommandError::new(
                "store-state",
                "Demotion requires a ready authoritative store.",
            ));
        }
        let source = store.store_dir();
        let recovery_before = export::snapshot_layout_with_progress(&source, true, progress)?;
        let backups = store.backups_dir();
        ensure_plain_private_dir(&backups)?;
        let recovery_name = format!(
            "state-recovery-{}-{}",
            crate::store::utc_stamp(std::time::SystemTime::now()).compact,
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        let recovery = backups.join(recovery_name);
        let copy_result = export::copy_tree(&source, &recovery, true, progress);
        let recovery_copy = match copy_result {
            Ok(copied) => export::snapshot_layout_with_progress(&recovery, true, progress)
                .map(|snapshot| (copied, snapshot)),
            Err(error) => Err(error),
        };
        let (copied, _recovery_after) = match recovery_copy {
            Ok(result) if result.1 == recovery_before => result,
            Ok(_) => {
                let _ = std::fs::remove_dir_all(&recovery);
                return Err(CommandError::new(
                    "store-changed",
                    "The recovery copy did not match the authoritative store; demotion stopped.",
                ));
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&recovery);
                return Err(error.into());
            }
        };
        crate::store::fsync_dir(&backups).map_err(StoreError::from)?;
        persist_canvas_refresh_enabled(store.data_root(), false)?;
        *lock(&self.canvas_refresh_enabled) = false;
        store.set_state_locked(
            &write,
            crate::store::StoreState::Authoritative,
            &manifest.digest,
            crate::store::StoreState::Preview,
        )?;
        *lock(&self.promotion_proof) = None;
        Ok(DemotionResult {
            state: "preview",
            recovery_files: copied.files_done,
            recovery_bytes: copied.bytes_done,
        })
    }

    fn export_frozen_for_rollback(
        &self,
        progress: &mut dyn FnMut(export::ExportProgress),
    ) -> Result<FrozenExportResult, CommandError> {
        let parent = self
            .picker
            .pick_export_folder()
            .ok_or_else(|| CommandError::new("cancelled", "No export folder was selected."))?;
        let store = self.store()?;
        let _import = self
            .import_running
            .try_lock()
            .map_err(|_| CommandError::new("import-running", "An import is already running."))?;
        let _refresh = self
            .refresh_running
            .try_lock()
            .map_err(|_| CommandError::new("refresh-running", "A refresh is already running."))?;
        let _refresh_lease = store.refresh_lock()?;
        let write = store.write_lock()?;
        let result = export::export_legacy_frozen(store, &write, &parent, progress)?;
        Ok(FrozenExportResult {
            files: result.files_done,
            bytes: result.bytes_done,
            equal: true,
        })
    }
}

fn ensure_plain_private_dir(path: &Path) -> Result<(), StoreError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            crate::store::set_private_dir_mode(path)?;
            Ok(())
        }
        Ok(_) => Err(StoreError::Invalid(
            "the recovery folder is not a plain directory",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            crate::store::create_private_dir(path, false)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

async fn blocking<T: Send + 'static>(
    state: &AppState,
    work: impl FnOnce(&Inner) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    let inner = Arc::clone(&state.shared);
    tauri::async_runtime::spawn_blocking(move || work(&inner))
        .await
        .map_err(|_| CommandError::new("internal", "The operation stopped unexpectedly."))?
}

async fn blocking_arc<T: Send + 'static>(
    state: &AppState,
    work: impl FnOnce(Arc<Inner>) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    let inner = Arc::clone(&state.shared);
    tauri::async_runtime::spawn_blocking(move || work(inner))
        .await
        .map_err(|_| CommandError::new("internal", "The operation stopped unexpectedly."))?
}

#[tauri::command]
fn store_status(state: State<'_, AppState>) -> StoreStatus {
    state.shared.status()
}

#[tauri::command]
async fn choose_legacy_root(state: State<'_, AppState>) -> Result<FolderChoice, CommandError> {
    blocking(state.inner(), |inner| Ok(inner.choose())).await
}

#[tauri::command]
async fn dry_run_import(state: State<'_, AppState>) -> Result<DryRunReport, CommandError> {
    blocking(state.inner(), Inner::dry_run).await
}

#[tauri::command]
async fn import_legacy_root(
    state: State<'_, AppState>,
    replace_preview: bool,
    on_progress: Channel<ImportProgress>,
) -> Result<ImportSummary, CommandError> {
    blocking_arc(state.inner(), move |inner| {
        inner.import(replace_preview, &mut |event| {
            // Progress is advisory; a closed channel never fails the import.
            let _ = on_progress.send(event);
        })
    })
    .await
}

#[tauri::command]
async fn read_dashboard_documents(
    state: State<'_, AppState>,
) -> Result<DashboardDocuments, CommandError> {
    blocking(state.inner(), Inner::documents).await
}

#[tauri::command]
async fn set_item_completion(
    state: State<'_, AppState>,
    item_id: String,
    expected: bool,
    value: bool,
) -> Result<MutationResult, CommandError> {
    blocking(state.inner(), move |inner| {
        inner.mutate(&item_id, "done", expected, value)
    })
    .await
}

#[tauri::command]
async fn set_discussion_field(
    state: State<'_, AppState>,
    item_id: String,
    field: String,
    expected: bool,
    value: bool,
) -> Result<MutationResult, CommandError> {
    let field = match field.as_str() {
        "post" => "discussionPostDone",
        "replies" => "discussionRepliesDone",
        _ => {
            return Err(CommandError::new(
                "invalid-field",
                "Unknown discussion field.",
            ))
        }
    };
    blocking(state.inner(), move |inner| {
        inner.mutate(&item_id, field, expected, value)
    })
    .await
}

#[tauri::command]
async fn resolve_pending_source_link(
    state: State<'_, AppState>,
    pending_id: String,
    local_item_id: String,
    decision: String,
    expected_version: String,
) -> Result<PendingLinkResult, CommandError> {
    blocking(state.inner(), move |inner| {
        let store = inner.store()?;
        Ok(store.resolve_pending_source_link(
            &pending_id,
            &local_item_id,
            &decision,
            &expected_version,
        )?)
    })
    .await
}

#[tauri::command]
async fn set_manual_grade(
    state: State<'_, AppState>,
    item_id: String,
    value: Option<String>,
    expected_version: String,
) -> Result<ManualGradeResult, CommandError> {
    blocking(state.inner(), move |inner| {
        let store = inner.store()?;
        Ok(store.set_manual_grade(&item_id, value.as_deref(), &expected_version)?)
    })
    .await
}

#[tauri::command]
async fn read_avatar_bytes(
    state: State<'_, AppState>,
) -> Result<Option<AvatarBytes>, CommandError> {
    blocking(state.inner(), Inner::avatar).await
}

#[tauri::command]
async fn open_library_resource(
    state: State<'_, AppState>,
    id: String,
) -> Result<resources::ResourceAction, CommandError> {
    blocking(state.inner(), move |inner| inner.resource(&id)).await
}

#[tauri::command]
async fn copy_assignment_text(
    state: State<'_, AppState>,
    text: String,
) -> Result<(), CommandError> {
    blocking(state.inner(), move |inner| inner.copy(&text)).await
}

#[tauri::command]
async fn list_snapshots(
    state: State<'_, AppState>,
) -> Result<Vec<snapshots::SnapshotInfo>, CommandError> {
    blocking(state.inner(), Inner::snapshots).await
}

#[tauri::command]
async fn restore_snapshot(state: State<'_, AppState>, id: String) -> Result<(), CommandError> {
    blocking(state.inner(), move |inner| inner.restore(&id)).await
}

#[tauri::command]
async fn export_legacy_folder(
    state: State<'_, AppState>,
    on_progress: Channel<export::ExportProgress>,
) -> Result<export::ExportProgress, CommandError> {
    blocking(state.inner(), move |inner| {
        inner.export(&mut |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

#[tauri::command]
async fn prepare_store_promotion(
    state: State<'_, AppState>,
    on_progress: Channel<export::ExportProgress>,
) -> Result<PromotionReadiness, CommandError> {
    blocking_arc(state.inner(), move |inner| {
        inner.prepare_store_promotion(&mut |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

#[tauri::command]
async fn confirm_store_promotion(
    state: State<'_, AppState>,
    proof_id: String,
    on_progress: Channel<export::ExportProgress>,
) -> Result<PromotionResult, CommandError> {
    blocking_arc(state.inner(), move |inner| {
        inner.confirm_store_promotion(&proof_id, &mut |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

#[tauri::command]
async fn demote_store_for_rollback(
    state: State<'_, AppState>,
    on_progress: Channel<export::ExportProgress>,
) -> Result<DemotionResult, CommandError> {
    blocking_arc(state.inner(), move |inner| {
        inner.demote_store_for_rollback(&mut |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

#[tauri::command]
async fn export_frozen_for_rollback(
    state: State<'_, AppState>,
    on_progress: Channel<export::ExportProgress>,
) -> Result<FrozenExportResult, CommandError> {
    blocking_arc(state.inner(), move |inner| {
        inner.export_frozen_for_rollback(&mut |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

#[tauri::command]
async fn set_canvas_refresh_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<CanvasRefreshSetting, CommandError> {
    blocking(state.inner(), move |inner| {
        inner.set_canvas_refresh_enabled(enabled)
    })
    .await
}

#[tauri::command]
async fn start_canvas_refresh(
    state: State<'_, AppState>,
    on_progress: Channel<crate::refresh::RefreshProgress>,
) -> Result<crate::refresh::RefreshResult, CommandError> {
    blocking_arc(state.inner(), move |inner| {
        inner.refresh(&mut |progress| {
            if on_progress.send(progress).is_err() {
                inner.terminate_refresh_process();
            }
        })
    })
    .await
}

#[tauri::command]
async fn start_ical_refresh(
    state: State<'_, AppState>,
    on_progress: Channel<IcalRefreshProgress>,
) -> Result<IcalRefreshResult, CommandError> {
    blocking_arc(state.inner(), move |inner| {
        inner.refresh_ical(&mut |progress| on_progress.send(progress).is_ok())
    })
    .await
}

/// Registers exactly the commands in [`COMMAND_NAMES`]. The caller manages an [`AppState`].
pub fn register_handlers<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        store_status,
        choose_legacy_root,
        dry_run_import,
        import_legacy_root,
        read_dashboard_documents,
        set_item_completion,
        set_discussion_field,
        resolve_pending_source_link,
        set_manual_grade,
        read_avatar_bytes,
        open_library_resource,
        copy_assignment_text,
        list_snapshots,
        restore_snapshot,
        export_legacy_folder,
        set_canvas_refresh_enabled,
        start_canvas_refresh,
        start_ical_refresh,
        prepare_store_promotion,
        confirm_store_promotion,
        demote_store_for_rollback,
        export_frozen_for_rollback,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TEST_BUNDLE_IDENTIFIER;
    use crate::testutil::{materialize_fixture, snapshot_tree, TempRoot};
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::Manager;

    struct FixedPicker(Mutex<Option<PathBuf>>);

    impl FolderPicker for FixedPicker {
        fn pick_folder(&self) -> Option<PathBuf> {
            lock(&self.0).clone()
        }
    }

    struct WorkflowPicker {
        backup: Option<PathBuf>,
        export_parent: Option<PathBuf>,
        promote: bool,
        demote: bool,
        promotion_prompts: Arc<std::sync::atomic::AtomicUsize>,
        demotion_prompts: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl FolderPicker for WorkflowPicker {
        fn pick_folder(&self) -> Option<PathBuf> {
            None
        }
        fn pick_promotion_backup(&self) -> Option<PathBuf> {
            self.backup.clone()
        }
        fn pick_export_folder(&self) -> Option<PathBuf> {
            self.export_parent.clone()
        }
        fn confirm_promotion(&self, _files: u64, _bytes: u64) -> bool {
            self.promotion_prompts.fetch_add(1, Ordering::SeqCst);
            self.promote
        }
        fn confirm_demotion(&self) -> bool {
            self.demotion_prompts.fetch_add(1, Ordering::SeqCst);
            self.demote
        }
    }

    fn workflow_state(
        label: &str,
        promote: bool,
        demote: bool,
    ) -> (
        TempRoot,
        AppState,
        PathBuf,
        PathBuf,
        Arc<std::sync::atomic::AtomicUsize>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let root = TempRoot::new(label);
        let legacy_source = materialize_fixture(&root.path().join("legacy-source"));
        let backup = root.path().join("frozen-backup");
        let export_parent = root.path().join("rollback-output");
        crate::store::create_private_dir(&export_parent, false).unwrap();
        let data_root = root.path().join(TEST_BUNDLE_IDENTIFIER);
        let settings = settings();
        let store = Store::open(&data_root, settings.write_lock_timeout).unwrap();
        import::import_legacy_root(
            &store,
            &legacy_source,
            &ImportOptions {
                limits: settings.import_limits,
                legacy_lock_timeout: settings.legacy_lock_timeout,
                replace_preview: false,
            },
            &mut |_| {},
        )
        .unwrap();
        let manifest_path = store.store_dir().join(crate::config::MANIFEST_FILE);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["futureManifestField"] = serde_json::json!({ "kept": "synthetic" });
        atomic_write(&manifest_path, &node_json_bytes(&manifest)).unwrap();
        export::copy_tree(&store.store_dir(), &backup, false, &mut |_| {}).unwrap();
        drop(store);
        let promotion_prompts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let demotion_prompts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let picker = WorkflowPicker {
            backup: Some(backup.clone()),
            export_parent: Some(export_parent.clone()),
            promote,
            demote,
            promotion_prompts: Arc::clone(&promotion_prompts),
            demotion_prompts: Arc::clone(&demotion_prompts),
        };
        let app = AppState::open_with_handlers(
            Ok(data_root),
            Some(root.path()),
            Box::new(picker),
            Box::new(clipboard::SystemClipboard),
            None,
            settings,
        );
        app.shared.wait_for_snapshots();
        (
            root,
            app,
            backup,
            export_parent,
            promotion_prompts,
            demotion_prompts,
        )
    }

    fn settings() -> Settings {
        Settings {
            legacy_lock_timeout: Duration::from_millis(150),
            write_lock_timeout: Duration::from_millis(150),
            ..Settings::PRODUCTION
        }
    }

    #[test]
    fn refresh_owner_setting_defaults_off_and_is_written_private() {
        let root = TempRoot::new("refresh-setting");
        assert!(!read_canvas_refresh_enabled(root.path()));
        persist_canvas_refresh_enabled(root.path(), true).expect("persist setting");
        assert!(read_canvas_refresh_enabled(root.path()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = canvas_refresh_setting_path(root.path());
            assert_eq!(
                std::fs::metadata(path)
                    .expect("setting metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        persist_canvas_refresh_enabled(root.path(), false).expect("disable setting");
        assert!(!read_canvas_refresh_enabled(root.path()));
    }

    #[test]
    fn refresh_timestamp_output_rejects_non_timestamp_content() {
        assert_eq!(
            safe_refresh_timestamp(Some("2026-09-23T08:30:00Z".into())),
            Some("2026-09-23T08:30:00Z".into())
        );
        assert_eq!(
            safe_refresh_timestamp(Some("Private course name".into())),
            None
        );
    }

    #[test]
    fn refresh_progress_phase_parser_rejects_unlisted_text() {
        assert_eq!(
            crate::refresh::RefreshPhase::parse("fetch"),
            Some(crate::refresh::RefreshPhase::Fetch)
        );
        assert_eq!(
            crate::refresh::RefreshPhase::parse("private-course-title"),
            None
        );
    }

    #[test]
    fn course_scope_join_preserves_the_capture_root_and_fails_on_id_mismatch() {
        let coursework = serde_json::json!({
            "courses": [{"key":"demo-alpha", "folder":"classes/demo-alpha"}]
        });
        let root_scopes = serde_json::json!({
            "courses": [{"key":"demo-alpha", "canvasId":9101}]
        });
        let ids = BTreeMap::from([("demo-alpha".to_owned(), 9101)]);
        let scopes = course_scopes_from_documents(&coursework, Some(&root_scopes), &ids)
            .expect("snapshot identity triple joins");
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].folder, "classes/demo-alpha");
        assert_eq!(scopes[0].canvas_course_id, 9101);

        let mismatched_scopes = serde_json::json!({
            "courses": [{"key":"demo-alpha", "canvasId":9102}]
        });
        assert!(course_scopes_from_documents(&coursework, Some(&mismatched_scopes), &ids).is_err());
    }

    #[test]
    fn helper_progress_writer_surfaces_a_closed_pipe() {
        struct ClosedPipe;
        impl std::io::Write for ClosedPipe {
            fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
        }

        let progress = crate::refresh::RefreshProgress::new(
            crate::refresh::RefreshPhase::Fetch,
            0,
            None,
            None,
        );
        let error = write_helper_event(&mut ClosedPipe, "progress", &progress)
            .expect_err("closed parent pipe must be reported");
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn canvas_refresh_refuses_preview_store_before_launching_helper() {
        let temp = TempRoot::new("refresh-preview");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let app = state(&temp, Some(source));
        app.shared.choose();
        app.shared
            .import(false, &mut |_| {})
            .expect("preview import");
        app.shared.wait_for_snapshots();
        app.shared
            .set_canvas_refresh_enabled(true)
            .expect("owner setting");

        let error = app
            .shared
            .refresh(&mut |_| {})
            .expect_err("preview refresh must be refused");
        assert_eq!(error.code, "preview-refresh");
    }

    fn state(temp: &TempRoot, pick: Option<PathBuf>) -> AppState {
        AppState::open(
            Ok(temp.path().join(TEST_BUNDLE_IDENTIFIER)),
            Some(temp.path()),
            Box::new(FixedPicker(Mutex::new(pick))),
            settings(),
        )
    }

    fn invoke<W: AsRef<tauri::Webview<tauri::test::MockRuntime>>>(
        webview: &W,
        cmd: &str,
        url: &str,
        body: Value,
    ) -> Result<Value, Value> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().expect("url"),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("json response"))
    }

    const LOCAL: &str = "tauri://localhost";

    #[test]
    fn snapshot_failure_warns_without_blocking_import_or_reopen() {
        let temp = TempRoot::new("snapshot-warning");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let app = state(&temp, Some(source));
        std::fs::write(
            app.shared.store().unwrap().data_root().join("snapshots"),
            b"blocked",
        )
        .unwrap();
        app.shared.choose();
        app.shared.import(false, &mut |_| {}).unwrap();
        app.shared.wait_for_snapshots();
        let status = app.shared.status();
        assert_eq!(status.availability, "ready");
        assert_eq!(status.state, "preview");
        assert_eq!(status.problem.as_deref(), Some(SNAPSHOT_WARNING));
        assert!(app.shared.documents().is_ok());
        drop(app);

        let reopened = state(&temp, None);
        reopened.shared.wait_for_snapshots();
        let status = reopened.shared.status();
        assert_eq!(status.availability, "ready");
        assert_eq!(status.state, "preview");
        assert_eq!(status.problem.as_deref(), Some(SNAPSHOT_WARNING));
        assert!(reopened.shared.documents().is_ok());
    }

    #[test]
    fn daily_snapshot_runs_in_background_and_reports_only_copy_counts() {
        use std::sync::mpsc;

        let temp = TempRoot::new("snapshot-progress");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let app = state(&temp, Some(source));
        app.shared.choose();
        app.shared.import(false, &mut |_| {}).unwrap();
        app.shared.wait_for_snapshots();

        let (started_tx, started_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let worker = spawn_daily_snapshot(Arc::clone(&app.shared), move |store, report| {
            let mut paused = false;
            snapshots::snapshot_daily_with_progress(store, std::time::UNIX_EPOCH, &mut |progress| {
                report(progress);
                if !paused {
                    paused = true;
                    started_tx.send(progress).expect("test receiver is open");
                    continue_rx.recv().expect("test releases snapshot");
                }
            })
            .map(|_| ())
        })
        .expect("snapshot worker starts");

        let copied = started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("snapshot reaches first copied file");
        assert!(copied.files_done > 0);
        assert!(copied.bytes_done > 0);
        let status = app.shared.status();
        assert!(status.snapshot_in_progress);
        assert_eq!(status.snapshot_progress, Some(copied));
        assert!(app.shared.documents().is_ok());

        continue_tx.send(()).expect("worker remains parked");
        worker.join().expect("snapshot worker completes");
        let status = app.shared.status();
        assert!(!status.snapshot_in_progress);
        assert_eq!(status.snapshot_progress, None);
        assert_eq!(status.problem, None);
        assert!(app.shared.documents().is_ok());
    }

    #[test]
    fn ipc_runs_only_granted_commands_from_the_local_app() {
        let temp = TempRoot::new("commands-ipc");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let app = register_handlers(mock_builder().plugin(tauri_plugin_dialog::init()))
            .manage(state(&temp, Some(source.clone())))
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let webview = match app.get_webview_window("main") {
            Some(window) => window,
            None => tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .expect("window"),
        };

        let status = invoke(&webview, "store_status", LOCAL, json!({})).expect("status");
        assert_eq!(status["availability"], "ready");
        assert_eq!(status["state"], "empty");
        assert_eq!(status["legacyRootSelected"], false);
        assert_eq!(status["refreshAvailable"], false);
        assert_eq!(status["dataFolder"], format!("~/{TEST_BUNDLE_IDENTIFIER}"));

        let error =
            invoke(&webview, "dry_run_import", LOCAL, json!({})).expect_err("no folder yet");
        assert_eq!(error["code"], "no-legacy-root");
        assert_eq!(
            invoke(&webview, "choose_legacy_root", LOCAL, json!({})).expect("choose"),
            json!({"selected": true})
        );
        let report = invoke(&webview, "dry_run_import", LOCAL, json!({})).expect("dry run");
        assert_eq!(report["wouldImport"], true);

        let summary = invoke(
            &webview,
            "import_legacy_root",
            LOCAL,
            json!({"replacePreview": false, "onProgress": "__CHANNEL__:7"}),
        )
        .expect("import");
        assert_eq!(summary["state"], "preview");
        let status = invoke(&webview, "store_status", LOCAL, json!({})).expect("status");
        assert_eq!(status["state"], "preview");
        assert_eq!(
            status["legacyRootSelected"], false,
            "selection cleared after a successful import"
        );
        let documents =
            invoke(&webview, "read_dashboard_documents", LOCAL, json!({})).expect("documents");
        assert_eq!(documents["storeState"], "preview");
        assert!(documents["coursework"]["version"]
            .as_str()
            .is_some_and(|value| value.len() == 64));

        // Nothing outside the granted commands is reachable, and nothing from a remote origin.
        // The dialog plugin is registered (Rust uses it) but no permission reaches the webview.
        for denied in [
            "plugin:dialog|open",
            "plugin:fs|read_text_file",
            "plugin:shell|execute",
            "plugin:event|listen",
            "not_a_command",
        ] {
            let error = invoke(&webview, denied, LOCAL, json!({})).expect_err("denied");
            assert!(
                error
                    .as_str()
                    .is_some_and(|text| text.contains("not allowed")),
                "{denied}: {error}"
            );
        }
        let error = invoke(
            &webview,
            "store_status",
            "https://remote.invalid",
            json!({}),
        )
        .expect_err("remote origins are denied");
        assert!(
            error
                .as_str()
                .is_some_and(|text| text.contains("not allowed")),
            "remote: {error}"
        );

        let status_text = serde_json::to_string(&status).expect("text");
        assert!(
            !status_text.contains(&*source.to_string_lossy()),
            "status never reveals the legacy path"
        );
    }

    #[test]
    fn a_second_instance_is_denied_and_changes_nothing() {
        let temp = TempRoot::new("commands-second");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let first = state(&temp, Some(source.clone()));
        let before = snapshot_tree(&temp.path().join(TEST_BUNDLE_IDENTIFIER));
        let second = state(&temp, Some(source));
        let status = second.shared.status();
        assert_eq!(status.availability, "another-instance");
        second.shared.choose();
        assert_eq!(
            second
                .shared
                .import(false, &mut |_| {})
                .expect_err("denied")
                .code,
            "another-instance"
        );
        assert_eq!(
            second.shared.documents().expect_err("denied").code,
            "another-instance"
        );
        assert_eq!(
            snapshot_tree(&temp.path().join(TEST_BUNDLE_IDENTIFIER)),
            before
        );
        assert_eq!(first.shared.status().availability, "ready");
    }

    #[test]
    fn failed_imports_keep_the_selection_and_report_named_refusals() {
        let temp = TempRoot::new("commands-refusal");
        let source = materialize_fixture(&temp.path().join("legacy"));
        std::fs::write(source.join("launcher.sh"), b"#!/bin/sh\n").expect("unsupported");
        let app = state(&temp, Some(source.clone()));
        app.shared.choose();
        let error = app.shared.import(false, &mut |_| {}).expect_err("refused");
        assert_eq!(error.code, "refused");
        assert_eq!(
            error.refusals.as_ref().expect("refusals")["unsupportedRootEntries"],
            1
        );
        assert!(!error.message.contains(&*source.to_string_lossy()));
        assert!(app.shared.status().legacy_root_selected, "kept for a retry");

        std::fs::remove_file(source.join("launcher.sh")).expect("fix");
        let running = app.shared.import_running.lock().expect("hold");
        assert_eq!(
            app.shared
                .import(false, &mut |_| {})
                .expect_err("busy")
                .code,
            "import-running"
        );
        drop(running);
        app.shared.import(false, &mut |_| {}).expect("import");
        assert_eq!(
            app.shared
                .import(false, &mut |_| {})
                .expect_err("no selection")
                .code,
            "no-legacy-root"
        );
    }

    #[test]
    fn an_unavailable_data_root_is_reported() {
        let status = AppState::open(
            Err("application data folder is unavailable".into()),
            None,
            Box::new(FixedPicker(Mutex::new(None))),
            settings(),
        )
        .shared
        .status();
        assert_eq!(status.availability, "unavailable");
        assert_eq!(
            status.problem.as_deref(),
            Some("application data folder is unavailable")
        );
    }

    #[test]
    fn promotion_requires_owner_confirmation_and_consumes_its_proof() {
        let (_root, app, _backup, _export_parent, prompts, _demote_prompts) =
            workflow_state("promotion-proof", true, true);
        let ready = app
            .shared
            .prepare_store_promotion(&mut |_| {})
            .expect("exact backup match");
        assert!(ready.files > 0);
        let result = app
            .shared
            .confirm_store_promotion(&ready.proof_id, &mut |_| {})
            .expect("owner-confirmed promotion");
        assert_eq!(result.state, "authoritative");
        assert_eq!(prompts.load(Ordering::SeqCst), 1);
        assert_eq!(app.shared.status().state, "authoritative");
        let store = app.shared.store().unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(store.store_dir().join(crate::config::MANIFEST_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest["futureManifestField"],
            serde_json::json!({ "kept": "synthetic" })
        );
        assert_eq!(
            app.shared
                .confirm_store_promotion(&ready.proof_id, &mut |_| {})
                .expect_err("proof is one-use")
                .code,
            "promotion-proof"
        );
    }

    #[test]
    fn backup_mismatch_and_cancelled_promotion_leave_preview_unchanged() {
        let (_root, app, backup, _export_parent, prompts, _demote_prompts) =
            workflow_state("promotion-cancel", false, true);
        std::fs::write(backup.join("unmatched.synthetic"), b"different tree").unwrap();
        assert_eq!(
            app.shared
                .prepare_store_promotion(&mut |_| {})
                .expect_err("mismatch refused")
                .code,
            "backup-mismatch"
        );
        std::fs::remove_file(backup.join("unmatched.synthetic")).unwrap();
        let ready = app
            .shared
            .prepare_store_promotion(&mut |_| {})
            .expect("match restored");
        assert_eq!(
            app.shared
                .confirm_store_promotion(&ready.proof_id, &mut |_| {})
                .expect_err("native confirmation declined")
                .code,
            "cancelled"
        );
        assert_eq!(prompts.load(Ordering::SeqCst), 1);
        assert_eq!(app.shared.status().state, "preview");
        assert_eq!(
            app.shared
                .confirm_store_promotion(&ready.proof_id, &mut |_| {})
                .expect_err("cancelled proof was consumed")
                .code,
            "promotion-proof"
        );
    }

    #[test]
    fn a_backup_changed_after_preparation_cannot_be_promoted() {
        let (_root, app, backup, _export_parent, _prompts, _demote_prompts) =
            workflow_state("promotion-stale", true, true);
        let ready = app
            .shared
            .prepare_store_promotion(&mut |_| {})
            .expect("exact backup match");
        std::fs::write(backup.join("coursework.json"), b"changed synthetic bytes\n").unwrap();
        assert_eq!(
            app.shared
                .confirm_store_promotion(&ready.proof_id, &mut |_| {})
                .expect_err("stale proof refused")
                .code,
            "store-changed"
        );
        assert_eq!(app.shared.status().state, "preview");
    }

    #[test]
    fn promotion_refuses_an_active_refresh_guard() {
        let (_root, app, _backup, _export_parent, _prompts, _demote_prompts) =
            workflow_state("promotion-refresh-lock", true, true);
        let _refresh = lock(&app.shared.refresh_running);
        assert_eq!(
            app.shared
                .prepare_store_promotion(&mut |_| {})
                .expect_err("active refresh excluded")
                .code,
            "refresh-running"
        );
        assert_eq!(app.shared.status().state, "preview");
    }

    #[test]
    fn demotion_retains_recovery_and_frozen_export_is_exact() {
        let (_root, app, _backup, export_parent, _prompts, demote_prompts) =
            workflow_state("demotion-export", true, true);
        let ready = app
            .shared
            .prepare_store_promotion(&mut |_| {})
            .expect("exact backup match");
        app.shared
            .confirm_store_promotion(&ready.proof_id, &mut |_| {})
            .expect("promotion");
        app.shared
            .set_canvas_refresh_enabled(true)
            .expect("owner setting enabled for the test");
        let store = app.shared.store().unwrap();
        let authoritative = export::snapshot_layout(&store.store_dir(), true).unwrap();
        let demoted = app
            .shared
            .demote_store_for_rollback(&mut |_| {})
            .expect("demotion");
        assert_eq!(demoted.state, "preview");
        assert_eq!(demote_prompts.load(Ordering::SeqCst), 1);
        assert_eq!(app.shared.status().state, "preview");
        assert!(!app.shared.status().canvas_refresh_enabled);
        assert!(!app.shared.status().refresh_available);
        let backups = store.backups_dir();
        let recovery = std::fs::read_dir(backups)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("state-recovery-"))
            })
            .expect("retained recovery copy");
        assert_eq!(
            export::snapshot_layout(&recovery, true).unwrap(),
            authoritative
        );
        let exported = app
            .shared
            .export_frozen_for_rollback(&mut |_| {})
            .expect("write-frozen export");
        assert!(exported.equal);
        let export_tree = std::fs::read_dir(export_parent)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            export::snapshot_layout(&store.store_dir(), false).unwrap(),
            export::snapshot_layout(&export_tree, true).unwrap()
        );
    }

    #[test]
    fn enriched_legacy_export_is_gated_and_frozen_restore_rehearsal_changes_a_disposable_copy() {
        let (root, app, _backup, export_parent, _prompts, _demote_prompts) =
            workflow_state("enriched-rollback-rehearsal", true, true);
        let ready = app
            .shared
            .prepare_store_promotion(&mut |_| {})
            .expect("exact backup match");
        app.shared
            .confirm_store_promotion(&ready.proof_id, &mut |_| {})
            .expect("promotion");
        let store = app.shared.store().unwrap();
        let coursework = store.store_dir().join(crate::config::COURSEWORK_FILE);
        let mut document: Value =
            serde_json::from_slice(&std::fs::read(&coursework).unwrap()).unwrap();
        document["items"][0]["fieldObservations"] = json!({"title":{"owner":{
            "institution":"synthetic.invalid", "course":"course-a", "source":"ical", "id":"override"
        },"value":"synthetic"}});
        document["items"][0]["manualGradeObservation"] =
            json!({"version":1,"value":"synthetic","source":"manual"});
        atomic_write(&coursework, &node_json_bytes(&document)).unwrap();
        let before_refusal = snapshot_tree(&export_parent);

        assert_eq!(
            app.shared
                .export(&mut |_| {})
                .expect_err("unconfirmed enriched export is refused")
                .code,
            "legacy-compatibility-gated"
        );
        assert_eq!(
            snapshot_tree(&export_parent),
            before_refusal,
            "the rejected refreshable export creates no folder"
        );

        app.shared
            .demote_store_for_rollback(&mut |_| {})
            .expect("demotion keeps an exact recovery copy");
        app.shared
            .export_frozen_for_rollback(&mut |_| {})
            .expect("frozen enriched export");
        let frozen = std::fs::read_dir(&export_parent)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let restored = root.path().join("restored-legacy-layout");
        export::copy_tree(&frozen, &restored, true, &mut |_| {}).expect("write disposable restore");
        assert_eq!(
            export::snapshot_layout(&frozen, true).unwrap(),
            export::snapshot_layout(&restored, true).unwrap(),
            "the restore operation produced the exported bytes"
        );
        assert_eq!(
            std::fs::read(restored.join(crate::config::COURSEWORK_FILE)).unwrap(),
            std::fs::read(frozen.join(crate::config::COURSEWORK_FILE)).unwrap(),
            "the assertion observes the restore side effect, not only its reported state"
        );
    }

    #[test]
    fn frozen_export_refuses_a_held_write_lock() {
        let (_root, app, _backup, _export_parent, _prompts, _demote_prompts) =
            workflow_state("frozen-export-lock", true, true);
        let ready = app
            .shared
            .prepare_store_promotion(&mut |_| {})
            .expect("exact backup match");
        app.shared
            .confirm_store_promotion(&ready.proof_id, &mut |_| {})
            .expect("promotion");
        app.shared
            .demote_store_for_rollback(&mut |_| {})
            .expect("demotion");
        let store = app.shared.store().unwrap();
        let _held = store.write_lock().unwrap();
        assert_eq!(
            app.shared
                .export_frozen_for_rollback(&mut |_| {})
                .expect_err("exclusive lock timeout refuses the export")
                .code,
            "store-busy"
        );
    }
}
