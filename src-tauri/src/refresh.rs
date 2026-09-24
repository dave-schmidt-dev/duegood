//! Transactional publication of a complete Canvas capture.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::{ImportLimits, ReadLimits, COURSEWORK_FILE, MANIFEST_FILE, STAGING_PREFIX};
use crate::export::ExportProgress;
use crate::history::{self, HISTORY_FILE};
use crate::import::{is_course_folder_name, is_plain_basename};
use crate::snapshots::{self, SnapshotInfo};
use crate::store::{
    atomic_write, create_private_dir, fsync_dir, node_json_bytes, read_capped, utc_stamp, Store,
    StoreCondition, StoreError, StoreState,
};

const CONVERSATIONS_FILE: &str = "canvas-conversations.json";
const DOWNLOAD_MANIFEST: &str = "download-manifest.json";

/// Allowlisted progress stages. The serialized `phase` is always one of these fixed strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefreshPhase {
    Starting,
    Snapshot,
    Fetch,
    Reconcile,
    Stage,
    Publish,
    Complete,
}

impl RefreshPhase {
    /// Parses only the fixed progress values accepted by the helper protocol.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "starting" => Self::Starting,
            "snapshot" => Self::Snapshot,
            "fetch" => Self::Fetch,
            "reconcile" => Self::Reconcile,
            "stage" => Self::Stage,
            "publish" => Self::Publish,
            "complete" => Self::Complete,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    is_directory: bool,
    len: u64,
    modified: SystemTime,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64, u32),
}

/// Records path and metadata identity for the snapshot generation, excluding only coursework
/// bytes so personal mutations can proceed while staging. Store-owned writes replace files
/// atomically, which changes their inode and modification time without reading large materials
/// under the final commit lock.
fn generation_fingerprint(root: &Path) -> Result<BTreeMap<PathBuf, FileFingerprint>, StoreError> {
    fn visit(
        root: &Path,
        directory: &Path,
        output: &mut BTreeMap<PathBuf, FileFingerprint>,
    ) -> Result<(), StoreError> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| StoreError::Invalid("store generation path is invalid"))?;
            let metadata = fs::symlink_metadata(&path)?;
            let file_type = metadata.file_type();
            if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
                return Err(StoreError::Invalid("store contains an unsupported file"));
            }
            if relative == Path::new(COURSEWORK_FILE) {
                if !file_type.is_file() {
                    return Err(StoreError::Invalid("coursework document is not a file"));
                }
                continue;
            }
            let fingerprint = FileFingerprint {
                is_directory: file_type.is_dir(),
                len: metadata.len(),
                modified: metadata.modified()?,
                #[cfg(unix)]
                identity: {
                    use std::os::unix::fs::MetadataExt;
                    (
                        metadata.dev(),
                        metadata.ino(),
                        metadata.ctime(),
                        metadata.ctime_nsec(),
                        metadata.mode(),
                    )
                },
            };
            output.insert(relative.to_path_buf(), fingerprint);
            if file_type.is_dir() {
                visit(root, &path, output)?;
            }
        }
        Ok(())
    }

    let mut output = BTreeMap::new();
    visit(root, root, &mut output)?;
    Ok(output)
}

/// Content-free helper progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshProgress {
    pub phase: RefreshPhase,
    pub completed: u64,
    pub total: Option<u64>,
    pub bytes_done: Option<u64>,
}

impl RefreshProgress {
    pub fn new(
        phase: RefreshPhase,
        completed: u64,
        total: Option<u64>,
        bytes_done: Option<u64>,
    ) -> Self {
        Self {
            phase,
            completed,
            total,
            bytes_done,
        }
    }
}

/// Content-free status returned only after a complete generation is published.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub status: String,
    pub updated_at: Option<String>,
}

/// A complete, sanitized result assembled by the capture/reconciliation lane.
#[derive(Debug)]
pub struct RefreshCapture {
    pub coursework: Value,
    /// Fixed store-relative names and exact bytes; no manifest, coursework, or history replacement.
    pub documents: BTreeMap<String, Vec<u8>>,
    pub captured_at: SystemTime,
    /// False when a bounded Inbox detail read was incomplete; publication then retains omitted
    /// coursework and marks the Activity event incomplete.
    pub source_complete: bool,
}

/// Read-only prior download information for one course folder.
#[derive(Debug, Clone, Default)]
pub struct PriorCourseDownloads {
    pub manifest: Option<Value>,
    pub material_sizes: BTreeMap<String, u64>,
}

/// Private immutable input from the pre-refresh snapshot. Material reads are restricted to
/// files named by a valid prior download manifest and verified as regular files under that
/// snapshot's matching course materials folder.
#[derive(Debug)]
pub struct RefreshPrior {
    /// Exact parsed coursework captured by the transaction's initial snapshot.
    pub coursework: Value,
    /// Optional configured course scopes from that same snapshot.
    pub course_scopes: Option<Value>,
    /// Canvas course IDs read from each fixed per-course `course.json` in that snapshot.
    pub course_ids_by_folder: BTreeMap<String, u64>,
    pub conversations: Option<Value>,
    pub courses: BTreeMap<String, PriorCourseDownloads>,
    snapshot_root: PathBuf,
    allowed_materials: BTreeMap<String, BTreeSet<String>>,
}

impl RefreshPrior {
    pub fn download_manifest_for(&self, course_folder: &str) -> Option<&Value> {
        self.courses.get(course_folder)?.manifest.as_ref()
    }

    pub fn material_size_for(&self, course_folder: &str, filename: &str) -> Option<u64> {
        self.courses
            .get(course_folder)?
            .material_sizes
            .get(filename)
            .copied()
    }

    /// Reads one validated prior material file, returning no bytes if the file was absent or
    /// outside the declared single-file cap.
    pub fn read_material_bytes(
        &self,
        course_folder: &str,
        filename: &str,
    ) -> Result<Option<Vec<u8>>, RefreshError> {
        let allowed = self
            .allowed_materials
            .get(course_folder)
            .is_some_and(|names| names.contains(filename));
        if !allowed || !is_course_folder_name(course_folder) || !is_plain_basename(filename) {
            return Ok(None);
        }
        let path = self
            .snapshot_root
            .join("classes")
            .join(course_folder)
            .join("materials")
            .join(filename);
        match read_capped(&path, ImportLimits::PRODUCTION.max_file_bytes) {
            Ok(Some(bytes))
                if self.material_size_for(course_folder, filename) == Some(bytes.len() as u64) =>
            {
                Ok(Some(bytes))
            }
            Ok(Some(_)) | Ok(None) | Err(StoreError::TooLarge) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
}

/// Refresh failures never expose paths, response details, course data, or filenames.
pub enum RefreshError {
    Store(StoreError),
    FetchFailed,
    InvalidCapture,
}

impl fmt::Debug for RefreshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => {
                let _ = std::mem::discriminant(error);
                f.write_str("RefreshError::Store(<redacted>)")
            }
            Self::FetchFailed => f.write_str("RefreshError::FetchFailed"),
            Self::InvalidCapture => f.write_str("RefreshError::InvalidCapture"),
        }
    }
}

impl fmt::Display for RefreshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(_) | Self::FetchFailed | Self::InvalidCapture => {
                write!(f, "refresh could not be completed")
            }
        }
    }
}

impl std::error::Error for RefreshError {}

impl From<StoreError> for RefreshError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// Confirms that an installed helper can attach to the expected authoritative app-data store.
/// This read-only check never launches Canvas or touches credentials.
pub fn validate_helper_store(data_root: &Path) -> Result<(), RefreshError> {
    let expected_name = expected_data_root_name();
    if data_root.file_name().and_then(|name| name.to_str()) != Some(expected_name) {
        return Err(RefreshError::InvalidCapture);
    }
    let store = Store::open_helper(data_root, Duration::from_secs(5))?;
    let _read_lock = store.read_lock()?;
    match store.condition()? {
        StoreCondition::Ready(summary) if summary.state == StoreState::Authoritative => Ok(()),
        _ => Err(RefreshError::InvalidCapture),
    }
}

fn expected_data_root_name() -> &'static str {
    #[cfg(any(test, feature = "test-overrides"))]
    {
        crate::config::TEST_BUNDLE_IDENTIFIER
    }
    #[cfg(not(any(test, feature = "test-overrides")))]
    {
        crate::config::PRODUCTION_BUNDLE_IDENTIFIER
    }
}

/// Coordinates snapshot, complete capture, CAS/rebase, history, and one whole-store generation
/// swap. Network work runs with no store lock; every failure before publication keeps the prior
/// authoritative generation intact.
pub fn refresh(
    store: &Store,
    fetch: impl FnOnce(
        RefreshPrior,
        &mut dyn FnMut(RefreshProgress),
    ) -> Result<RefreshCapture, RefreshError>,
    report: &mut dyn FnMut(RefreshProgress),
) -> Result<RefreshResult, RefreshError> {
    let started = SystemTime::now();
    let started_at = utc_stamp(started).iso;
    report(RefreshProgress::new(RefreshPhase::Starting, 0, None, None));
    let _refresh_lease = store.refresh_lock()?;
    report(RefreshProgress::new(RefreshPhase::Snapshot, 0, None, None));

    let (baseline, prior, generation, source_generation) = {
        let _snapshot_lock = store.snapshot_lock()?;
        {
            let _write_lock = store.write_lock()?;
            store.recover_refresh_locked()?;
        }
        let (baseline, snapshot, generation) = {
            let _read_lock = store.read_lock()?;
            let baseline = read_authoritative_coursework(store)?;
            let snapshot = {
                let mut progress = |copied: ExportProgress| {
                    report(RefreshProgress::new(
                        RefreshPhase::Snapshot,
                        copied.files_done,
                        None,
                        Some(copied.bytes_done),
                    ));
                };
                snapshots::snapshot_before_refresh_locked_with_progress(
                    store,
                    "canvas-refresh",
                    &mut progress,
                )?
            };
            report(RefreshProgress::new(
                RefreshPhase::Snapshot,
                1,
                Some(1),
                None,
            ));
            let generation = generation_fingerprint(&store.store_dir())?;
            (baseline, snapshot, generation)
        };
        let source_generation = snapshot_root(store, &snapshot)?;
        let prior = load_prior(&source_generation)?;
        (baseline, prior, generation, source_generation)
    };

    report(RefreshProgress::new(RefreshPhase::Fetch, 0, None, None));
    let capture = {
        let mut fetch_report = |progress| report(progress);
        fetch(prior, &mut fetch_report)?
    };
    validate_capture(&capture)?;
    report(RefreshProgress::new(RefreshPhase::Stage, 0, None, None));

    let finished = capture.captured_at;
    let finished_at = utc_stamp(finished).iso;
    let preserve_missing_items = !capture.source_complete;
    let candidate = merge_personal_state(&baseline, &capture.coursework, preserve_missing_items)?;
    let diff = history::diff_coursework(&baseline, &candidate)?;
    let event = history::event_value(&diff, &started_at, &finished_at, finished);
    let generation_id = uuid::Uuid::new_v4().simple().to_string();
    let staging = store
        .data_root()
        .join(format!("{STAGING_PREFIX}refresh-{generation_id}"));
    let staged = {
        let mut progress = |copied: ExportProgress| {
            report(RefreshProgress::new(
                RefreshPhase::Stage,
                copied.files_done,
                None,
                Some(copied.bytes_done),
            ));
        };
        stage_generation(
            &source_generation,
            &staging,
            &capture,
            &candidate,
            &baseline,
            event,
            started,
            &mut progress,
        )
    };
    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&staging);
        return Err(error.into());
    }
    report(RefreshProgress::new(RefreshPhase::Stage, 1, Some(1), None));
    let result = (|| -> Result<RefreshResult, RefreshError> {
        let _write_lock = store.write_lock()?;
        store.recover_refresh_locked()?;
        let current = read_authoritative_coursework(store)?;
        if coursework_without_personal_state(&baseline)
            != coursework_without_personal_state(&current)
            || generation_fingerprint(&store.store_dir())? != generation
        {
            return Err(StoreError::StoreChanged.into());
        }
        let personal_reapplied = personal_state_changed(&baseline, &current);
        let coursework =
            merge_personal_state(&current, &capture.coursework, preserve_missing_items)?;
        write_staged_document(&staging, COURSEWORK_FILE, &node_json_bytes(&coursework))?;
        update_staged_activity(
            &staging.join(HISTORY_FILE),
            capture.source_complete,
            personal_reapplied,
        )?;
        let manifest_before = read_capped(&store.store_dir().join(MANIFEST_FILE), 1024 * 1024)?
            .ok_or(StoreError::Invalid("store manifest is missing"))?;
        let manifest_after = read_capped(&staging.join(MANIFEST_FILE), 1024 * 1024)?
            .ok_or(StoreError::Invalid("staged manifest is missing"))?;
        if manifest_before != manifest_after {
            let _ = fs::remove_dir_all(&staging);
            return Err(StoreError::Invalid("refresh changed the store manifest").into());
        }
        report(RefreshProgress::new(RefreshPhase::Publish, 0, None, None));
        store.publish_refresh_generation(&staging, &generation_id)?;
        Ok(RefreshResult {
            status: if capture.source_complete {
                "complete".to_owned()
            } else {
                "incomplete".to_owned()
            },
            updated_at: Some(utc_stamp(SystemTime::now()).iso),
        })
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    let result = result?;
    report(RefreshProgress::new(
        RefreshPhase::Complete,
        1,
        Some(1),
        None,
    ));
    Ok(result)
}

/// Reads the authoritative coursework bytes and parses a separate value for conflict checks.
fn read_authoritative_coursework(store: &Store) -> Result<Value, RefreshError> {
    match store.condition()? {
        StoreCondition::Ready(summary) if summary.state == StoreState::Authoritative => {}
        StoreCondition::Ready(_) => return Err(RefreshError::InvalidCapture),
        _ => return Err(RefreshError::InvalidCapture),
    }
    let document = store
        .read_document(COURSEWORK_FILE, ReadLimits::PRODUCTION.max_document_bytes)?
        .ok_or(StoreError::Invalid("coursework document is missing"))?;
    let value = serde_json::from_slice(&document.bytes)
        .map_err(|_| StoreError::Invalid("coursework document is malformed"))?;
    Ok(value)
}

fn snapshot_root(store: &Store, snapshot: &SnapshotInfo) -> Result<PathBuf, RefreshError> {
    let root = store.data_root().join("snapshots").join(&snapshot.id);
    match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(root),
        _ => Err(RefreshError::InvalidCapture),
    }
}

fn normalized_course_folder(value: &str) -> Option<String> {
    let folder = value.strip_prefix("classes/").unwrap_or(value);
    is_course_folder_name(folder).then(|| folder.to_owned())
}

fn course_id_from_file(snapshot_root: &Path, relative: &str) -> Result<Option<u64>, RefreshError> {
    let Some(bytes) = read_capped(
        &snapshot_root.join(relative),
        ReadLimits::PRODUCTION.max_document_bytes,
    )?
    else {
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| StoreError::Invalid("prior course metadata is malformed"))?;
    value
        .get("id")
        .and_then(Value::as_u64)
        .map(Some)
        .ok_or_else(|| StoreError::Invalid("prior course ID is malformed").into())
}

fn load_prior(snapshot_root: &Path) -> Result<RefreshPrior, RefreshError> {
    let coursework_bytes = read_capped(
        &snapshot_root.join(COURSEWORK_FILE),
        ReadLimits::PRODUCTION.max_document_bytes,
    )?
    .ok_or(StoreError::Invalid("snapshot coursework is missing"))?;
    let coursework: Value = serde_json::from_slice(&coursework_bytes)
        .map_err(|_| StoreError::Invalid("snapshot coursework is malformed"))?;
    let course_scopes = match read_capped(
        &snapshot_root.join("courses.json"),
        ReadLimits::PRODUCTION.max_document_bytes,
    )? {
        Some(bytes) => Some(
            serde_json::from_slice(&bytes)
                .map_err(|_| StoreError::Invalid("prior course scopes are malformed"))?,
        ),
        None => None,
    };
    let conversations = match read_capped(
        &snapshot_root.join(CONVERSATIONS_FILE),
        ReadLimits::PRODUCTION.max_document_bytes,
    )? {
        Some(bytes) => Some(
            serde_json::from_slice(&bytes)
                .map_err(|_| StoreError::Invalid("prior conversations are malformed"))?,
        ),
        None => None,
    };
    let mut courses = BTreeMap::new();
    let mut allowed_materials = BTreeMap::new();
    let mut course_ids_by_folder = BTreeMap::new();
    for course in coursework
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(StoreError::Invalid("coursework courses are malformed"))?
    {
        let Some(folder) = course
            .get("folder")
            .and_then(Value::as_str)
            .and_then(normalized_course_folder)
        else {
            continue;
        };
        if courses.contains_key(&folder) {
            return Err(RefreshError::InvalidCapture);
        }
        let primary_path = format!("classes/{folder}/canvas-export/api/course.json");
        let legacy_path = format!("classes/{folder}/canvas-export/course.json");
        let primary_id = course_id_from_file(snapshot_root, &primary_path)?;
        let legacy_id = course_id_from_file(snapshot_root, &legacy_path)?;
        let course_id = match (primary_id, legacy_id) {
            (Some(primary), Some(alias)) if primary == alias => primary,
            (Some(_), Some(_)) => return Err(RefreshError::InvalidCapture),
            (Some(primary), None) => primary,
            (None, Some(alias)) => alias,
            (None, None) => return Err(RefreshError::InvalidCapture),
        };
        course_ids_by_folder.insert(folder.clone(), course_id);
        let manifest_path = snapshot_root
            .join("classes")
            .join(&folder)
            .join("canvas-export")
            .join(DOWNLOAD_MANIFEST);
        let parsed_manifest =
            read_capped(&manifest_path, ReadLimits::PRODUCTION.max_document_bytes)?
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .filter(Value::is_array);
        let mut safe_manifest = Vec::new();
        let mut material_sizes = BTreeMap::new();
        let mut duplicate_names = BTreeSet::new();
        if let Some(entries) = parsed_manifest.as_ref().and_then(Value::as_array) {
            for entry in entries {
                let Some(filename) = entry
                    .get("filename")
                    .and_then(Value::as_str)
                    .filter(|name| is_plain_basename(name))
                else {
                    continue;
                };
                let status = entry.get("status").and_then(Value::as_str);
                if !matches!(status, Some("downloaded" | "reused")) {
                    continue;
                }
                let material_path = snapshot_root
                    .join("classes")
                    .join(&folder)
                    .join("materials")
                    .join(filename);
                let metadata = match fs::symlink_metadata(&material_path) {
                    Ok(metadata)
                        if metadata.file_type().is_file()
                            && metadata.len() <= ImportLimits::PRODUCTION.max_file_bytes =>
                    {
                        metadata
                    }
                    _ => continue,
                };
                if !duplicate_names.insert(filename.to_owned()) {
                    material_sizes.remove(filename);
                    continue;
                }
                material_sizes.insert(filename.to_owned(), metadata.len());
                let mut safe_entry = Map::new();
                for key in ["id", "name", "filename", "size", "updated_at", "status"] {
                    if let Some(value) = entry.get(key) {
                        safe_entry.insert(key.to_owned(), value.clone());
                    }
                }
                safe_manifest.push(Value::Object(safe_entry));
            }
        }
        let names = material_sizes.keys().cloned().collect();
        courses.insert(
            folder.clone(),
            PriorCourseDownloads {
                manifest: Some(Value::Array(safe_manifest)),
                material_sizes,
            },
        );
        allowed_materials.insert(folder, names);
    }
    Ok(RefreshPrior {
        coursework,
        course_scopes,
        course_ids_by_folder,
        conversations,
        courses,
        snapshot_root: snapshot_root.to_path_buf(),
        allowed_materials,
    })
}

fn coursework_without_personal_state(value: &Value) -> Value {
    let mut copy = value.clone();
    for list_name in ["items", "archivedForecastItems"] {
        if let Some(items) = copy.get_mut(list_name).and_then(Value::as_array_mut) {
            for item in items {
                if let Some(object) = item.as_object_mut() {
                    for field in [
                        "done",
                        "doneAt",
                        "discussionPostDone",
                        "discussionRepliesDone",
                    ] {
                        object.remove(field);
                    }
                }
            }
        }
    }
    copy
}

fn validate_capture(capture: &RefreshCapture) -> Result<(), RefreshError> {
    if !capture.coursework.is_object()
        || !capture
            .coursework
            .get("courses")
            .is_some_and(Value::is_array)
        || !capture.coursework.get("items").is_some_and(Value::is_array)
    {
        return Err(RefreshError::InvalidCapture);
    }
    let mut total = 0_u64;
    let mut entries = 1_u64;
    let coursework_bytes = node_json_bytes(&capture.coursework);
    if coursework_bytes.len() as u64 > ImportLimits::PRODUCTION.max_json_bytes {
        return Err(RefreshError::InvalidCapture);
    }
    total = total.saturating_add(coursework_bytes.len() as u64);
    let course_folders = capture_course_folders(&capture.coursework)?;
    for (name, bytes) in &capture.documents {
        if !allowed_capture_path(name, &course_folders)
            || matches!(
                name.as_str(),
                COURSEWORK_FILE | HISTORY_FILE | MANIFEST_FILE
            )
            || name.starts_with(&format!("{HISTORY_FILE}."))
            || name == "replace-journal.json"
            || name == "refresh-journal.json"
            || name.starts_with("snapshots/")
            || name.starts_with("backups/")
            || name.starts_with(STAGING_PREFIX)
        {
            return Err(RefreshError::InvalidCapture);
        }
        if bytes.len() as u64 > ImportLimits::PRODUCTION.max_file_bytes {
            return Err(RefreshError::InvalidCapture);
        }
        total = total.saturating_add(bytes.len() as u64);
        entries = entries.saturating_add(1);
        if total > ImportLimits::PRODUCTION.max_total_bytes
            || entries > ImportLimits::PRODUCTION.max_entries
        {
            return Err(RefreshError::InvalidCapture);
        }
    }
    Ok(())
}

fn capture_course_folders(coursework: &Value) -> Result<BTreeSet<String>, RefreshError> {
    let courses = coursework
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(RefreshError::InvalidCapture)?;
    Ok(courses
        .iter()
        .filter_map(|course| {
            course
                .get("folder")
                .and_then(Value::as_str)
                .and_then(normalized_course_folder)
        })
        .collect())
}

fn allowed_capture_path(name: &str, courses: &BTreeSet<String>) -> bool {
    if !safe_relative_name(name) {
        return false;
    }
    if matches!(
        name,
        CONVERSATIONS_FILE | "canvas-profile.json" | "canvas-profile-avatar"
    ) {
        return true;
    }
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() < 3 || parts[0] != "classes" || !courses.contains(parts[1]) {
        return false;
    }
    match parts.as_slice() {
        ["classes", _, "coursework.md"] | ["classes", _, "canvas-course-report.md"] => true,
        ["classes", _, "materials", filename] => is_plain_basename(filename),
        ["classes", _, "canvas-export", filename]
            if matches!(
                *filename,
                "download-manifest.json"
                    | "request-manifest.json"
                    | "course-inventory.json"
                    | "canvas-course-report.md"
            ) =>
        {
            true
        }
        ["classes", _, "canvas-export", "api", filename] => matches!(
            *filename,
            "course.json"
                | "tabs.json"
                | "pages.json"
                | "modules.json"
                | "assignment_groups.json"
                | "assignments.json"
                | "discussions.json"
                | "announcements.json"
                | "files.json"
                | "folders.json"
        ),
        _ => false,
    }
}

fn safe_relative_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('\\')
        && !name.contains('\0')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(name)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn personal_key(item: &Value) -> Option<String> {
    let id = item.get("id").and_then(Value::as_str)?;
    if item.get("source").and_then(Value::as_str) == Some("canvas") {
        if let Some(canvas_id) = item.get("canvasId") {
            let course = item.get("course").and_then(Value::as_str).unwrap_or("");
            return Some(format!("canvas:{course}:{}", value_id(canvas_id)?));
        }
    }
    Some(format!("id:{id}"))
}

fn value_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn copy_personal_fields(source: &Value, target: &mut Map<String, Value>) {
    for field in [
        "done",
        "doneAt",
        "discussionPostDone",
        "discussionRepliesDone",
    ] {
        if let Some(value) = source.get(field) {
            target.insert(field.to_owned(), value.clone());
        }
    }
}

fn merge_personal_state(
    current: &Value,
    fresh: &Value,
    preserve_missing_items: bool,
) -> Result<Value, RefreshError> {
    let old_items = current
        .get("items")
        .and_then(Value::as_array)
        .ok_or(RefreshError::InvalidCapture)?;
    let mut result = fresh.clone();
    let fresh_archived_keys: BTreeSet<String> = result
        .get("archivedForecastItems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(personal_key)
        .collect();
    let fresh_items = result
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or(RefreshError::InvalidCapture)?;
    let old_by_key: BTreeMap<String, Value> = old_items
        .iter()
        .filter_map(|item| personal_key(item).map(|key| (key, item.clone())))
        .collect();
    let mut fresh_keys = BTreeSet::new();
    let mut preserved_item_keys = BTreeSet::new();
    for item in fresh_items.iter_mut() {
        let Some(key) = personal_key(item) else {
            continue;
        };
        fresh_keys.insert(key.clone());
        if let (Some(previous), Some(target)) = (old_by_key.get(&key), item.as_object_mut()) {
            copy_personal_fields(previous, target);
        }
    }
    for item in old_items {
        let Some(key) = personal_key(item) else {
            continue;
        };
        if !fresh_keys.contains(&key) {
            if preserve_missing_items {
                fresh_keys.insert(key.clone());
                preserved_item_keys.insert(key);
                fresh_items.push(item.clone());
            } else if item.get("source").and_then(Value::as_str) != Some("canvas")
                && !fresh_archived_keys.contains(&key)
            {
                fresh_keys.insert(key);
                fresh_items.push(item.clone());
            }
        }
    }

    let current_archived = current
        .get("archivedForecastItems")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let target = result.as_object_mut().ok_or(RefreshError::InvalidCapture)?;
    let archived = target
        .entry("archivedForecastItems")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or(RefreshError::InvalidCapture)?;
    if !preserved_item_keys.is_empty() {
        archived.retain(|item| {
            personal_key(item).map_or(true, |key| !preserved_item_keys.contains(&key))
        });
    }
    let mut archived_keys: BTreeSet<String> = archived.iter().filter_map(personal_key).collect();
    for item in archived.iter_mut() {
        if let Some(key) = personal_key(item) {
            if let (Some(previous), Some(object)) = (old_by_key.get(&key), item.as_object_mut()) {
                copy_personal_fields(previous, object);
            }
        }
    }
    for item in old_items
        .iter()
        .filter(|item| item.get("source").and_then(Value::as_str) == Some("canvas"))
    {
        if let Some(key) = personal_key(item) {
            if !fresh_keys.contains(&key) && archived_keys.insert(key) {
                archived.push(item.clone());
            }
        }
    }
    for item in current_archived {
        if let Some(key) = personal_key(&item) {
            if !fresh_keys.contains(&key) && archived_keys.insert(key) {
                archived.push(item);
            }
        } else if !archived.contains(&item) {
            archived.push(item);
        }
    }
    Ok(result)
}

fn personal_state_changed(before: &Value, after: &Value) -> bool {
    const PERSONAL_FIELDS: [&str; 4] = [
        "done",
        "doneAt",
        "discussionPostDone",
        "discussionRepliesDone",
    ];

    fn index(value: &Value) -> BTreeMap<String, Value> {
        let mut indexed = BTreeMap::new();
        for list_name in ["items", "archivedForecastItems"] {
            for item in value
                .get(list_name)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(key) = personal_key(item) {
                    indexed.insert(key, item.clone());
                }
            }
        }
        indexed
    }

    let before = index(before);
    let after = index(after);
    before.iter().any(|(key, old)| {
        after.get(key).is_some_and(|new| {
            PERSONAL_FIELDS
                .iter()
                .any(|field| old.get(*field) != new.get(*field))
        })
    })
}

fn update_staged_activity(
    path: &Path,
    source_complete: bool,
    personal_reapplied: bool,
) -> Result<(), StoreError> {
    let bytes = read_capped(path, ReadLimits::PRODUCTION.max_document_bytes)?
        .ok_or(StoreError::Invalid("refresh history is missing"))?;
    let mut history: Value = serde_json::from_slice(&bytes)
        .map_err(|_| StoreError::Invalid("refresh history is malformed"))?;
    let events = history
        .get_mut("events")
        .and_then(Value::as_array_mut)
        .ok_or(StoreError::Invalid("refresh history is malformed"))?;
    let event = events
        .last_mut()
        .and_then(Value::as_object_mut)
        .ok_or(StoreError::Invalid("refresh history event is missing"))?;
    event.insert("sourceComplete".to_owned(), Value::Bool(source_complete));
    event.insert(
        "personalStateReapplied".to_owned(),
        Value::Bool(personal_reapplied),
    );
    if personal_reapplied {
        event.insert(
            "notice".to_owned(),
            Value::String("personal_state_reapplied".to_owned()),
        );
    } else {
        event.remove("notice");
    }
    if !source_complete {
        event.insert("status".to_owned(), Value::String("incomplete".to_owned()));
    }
    let changes = event
        .get_mut("changes")
        .and_then(Value::as_array_mut)
        .ok_or(StoreError::Invalid("refresh history changes are malformed"))?;
    if personal_reapplied {
        changes.insert(
            0,
            serde_json::json!({
                "kind": "notice",
                "title": "Personal progress kept",
                "detail": "Changes made during this refresh were preserved."
            }),
        );
    }
    if !source_complete {
        changes.retain(|change| change.get("kind").and_then(Value::as_str) != Some("removed"));
        event
            .get_mut("summary")
            .and_then(Value::as_object_mut)
            .ok_or(StoreError::Invalid("refresh history summary is malformed"))?
            .insert("removed".to_owned(), Value::from(0));
    }
    atomic_write(path, &node_json_bytes(&history))?;
    Ok(())
}

fn write_staged_document(root: &Path, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
    let relative = Path::new(name);
    let mut parent = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(StoreError::InvalidName);
        };
        parent.push(name);
        if components.peek().is_some() {
            match fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                Ok(_) => return Err(StoreError::Invalid("staged parent is not a directory")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    create_private_dir(&parent, false)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    atomic_write(&parent, bytes)?;
    Ok(())
}

fn stage_generation(
    source_generation: &Path,
    staging: &Path,
    capture: &RefreshCapture,
    coursework: &Value,
    baseline: &Value,
    event: Value,
    now: SystemTime,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<(), StoreError> {
    crate::export::copy_tree(source_generation, staging, true, progress)?;
    if let Some(recovered) =
        history::recover_missed_grade_history(&staging.join(HISTORY_FILE), baseline, now)?
    {
        history::append_event(&staging.join(HISTORY_FILE), recovered, now)?;
    }
    for (name, bytes) in &capture.documents {
        write_staged_document(staging, name, bytes)?;
    }
    write_staged_document(staging, COURSEWORK_FILE, &node_json_bytes(coursework))?;
    history::append_event(&staging.join(HISTORY_FILE), event, now)?;
    fsync_dir(staging)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ImportLimits, TEST_BUNDLE_IDENTIFIER};
    use crate::import::{import_legacy_root, ImportOptions};
    use crate::testutil::{materialize_fixture, snapshot_tree, TempRoot};

    fn authoritative_store(root: &TempRoot) -> Store {
        let data_root = root.path().join(TEST_BUNDLE_IDENTIFIER);
        let store = Store::open(&data_root, Duration::from_millis(500)).expect("store");
        let legacy = materialize_fixture(&root.path().join("legacy"));
        atomic_write(
            &legacy.join("classes/syn-202/canvas-export/api/course.json"),
            br#"{"id":1002,"name":"Applied Synthesis"}
"#,
        )
        .expect("complete synthetic course metadata");
        let options = ImportOptions {
            limits: ImportLimits::PRODUCTION,
            legacy_lock_timeout: Duration::from_millis(200),
            replace_preview: false,
        };
        import_legacy_root(&store, &legacy, &options, &mut |_| {}).expect("import");
        let mut manifest: Value = serde_json::from_slice(
            &fs::read(store.store_dir().join(MANIFEST_FILE)).expect("manifest"),
        )
        .expect("manifest JSON");
        manifest["state"] = Value::String(StoreState::Authoritative.as_str().to_owned());
        atomic_write(
            &store.store_dir().join(MANIFEST_FILE),
            &node_json_bytes(&manifest),
        )
        .expect("authoritative manifest");
        store
    }

    fn capture_from(current: &Value) -> RefreshCapture {
        let mut coursework = current.clone();
        coursework["items"][0]["title"] = Value::String("Canvas title update".to_owned());
        RefreshCapture {
            coursework,
            documents: BTreeMap::from([(
                "canvas-conversations.json".to_owned(),
                b"{\"complete\":true}\n".to_vec(),
            )]),
            captured_at: SystemTime::now(),
            source_complete: true,
        }
    }

    fn current_coursework(store: &Store) -> Value {
        serde_json::from_slice(
            &fs::read(store.store_dir().join(COURSEWORK_FILE)).expect("coursework"),
        )
        .expect("coursework JSON")
    }

    #[test]
    fn personal_merge_does_not_restore_reconciled_syllabus_forecast() {
        let current = serde_json::json!({
            "items": [
                {"id":"forecast-1","course":"course-1","source":"syllabus","done":false},
                {"id":"manual-1","course":"course-1","source":"manual","done":true}
            ],
            "archivedForecastItems": []
        });
        let fresh = serde_json::json!({
            "items": [],
            "archivedForecastItems": [
                {"id":"forecast-1","course":"course-1","source":"syllabus","done":false}
            ]
        });

        let merged = merge_personal_state(&current, &fresh, false).expect("personal merge");

        assert!(merged["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| { item.get("id").and_then(Value::as_str) != Some("forecast-1") }));
        assert_eq!(merged["items"].as_array().unwrap().len(), 1);
        assert_eq!(merged["items"][0]["id"], "manual-1");
        assert_eq!(merged["archivedForecastItems"].as_array().unwrap().len(), 1);
        assert_eq!(merged["archivedForecastItems"][0]["id"], "forecast-1");
    }

    #[test]
    fn incomplete_refresh_keeps_omitted_syllabus_forecast_active() {
        let current = serde_json::json!({
            "items": [
                {"id":"forecast-1","course":"course-1","source":"syllabus","done":true}
            ],
            "archivedForecastItems": []
        });
        let fresh = serde_json::json!({
            "items": [],
            "archivedForecastItems": [
                {"id":"forecast-1","course":"course-1","source":"syllabus","done":false}
            ]
        });

        let merged = merge_personal_state(&current, &fresh, true).expect("partial personal merge");

        assert_eq!(merged["items"].as_array().unwrap().len(), 1);
        assert_eq!(merged["items"][0]["id"], "forecast-1");
        assert_eq!(merged["items"][0]["done"], true);
        assert!(merged["archivedForecastItems"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn complete_refresh_preserves_personal_state_and_manifest() {
        let root = TempRoot::new("refresh-commit");
        let store = authoritative_store(&root);
        let mut current = current_coursework(&store);
        current["items"][0]["done"] = Value::Bool(true);
        current["items"][0]["doneAt"] = Value::String("student-time".into());
        atomic_write(
            &store.store_dir().join(COURSEWORK_FILE),
            &node_json_bytes(&current),
        )
        .unwrap();
        let manifest = fs::read(store.store_dir().join(MANIFEST_FILE)).unwrap();
        let baseline = current.clone();
        let capture = capture_from(&baseline);
        let result =
            refresh(&store, move |_, _| Ok(capture), &mut |_| {}).expect("complete refresh");
        assert_eq!(result.status, "complete");
        let published = current_coursework(&store);
        assert_eq!(published["items"][0]["title"], "Canvas title update");
        assert_eq!(published["items"][0]["done"], true);
        assert_eq!(published["items"][0]["doneAt"], "student-time");
        assert_eq!(
            fs::read(store.store_dir().join(MANIFEST_FILE)).unwrap(),
            manifest
        );
        assert!(store.store_dir().join(CONVERSATIONS_FILE).is_file());
        let history: Value =
            serde_json::from_slice(&fs::read(store.store_dir().join(HISTORY_FILE)).unwrap())
                .unwrap();
        let event = history["events"].as_array().unwrap().last().unwrap();
        assert_eq!(event["status"], "succeeded");
        assert_eq!(event["personalStateReapplied"], false);
    }

    #[test]
    fn partial_refresh_preserves_omitted_canvas_items_and_prior_materials() {
        let root = TempRoot::new("refresh-partial-capture");
        let store = authoritative_store(&root);
        let baseline = current_coursework(&store);
        let retained_material = store
            .store_dir()
            .join("classes/syn-101/materials/refresh-retained-synthetic.bin");
        atomic_write(&retained_material, b"synthetic prior material").unwrap();

        let mut capture = capture_from(&baseline);
        capture.source_complete = false;
        capture.documents.insert(
            CONVERSATIONS_FILE.to_owned(),
            b"{\"complete\":false}\n".to_vec(),
        );
        let items = capture.coursework["items"].as_array_mut().unwrap();
        let omitted_index = items
            .iter()
            .position(|item| item.get("source").and_then(Value::as_str) == Some("canvas"))
            .expect("synthetic Canvas coursework item");
        let omitted = items.remove(omitted_index);
        let omitted_key = personal_key(&omitted).expect("stable item key");
        capture
            .coursework
            .as_object_mut()
            .unwrap()
            .entry("archivedForecastItems".to_owned())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("archive list")
            .push(omitted);

        let result = refresh(&store, move |_, _| Ok(capture), &mut |_| {})
            .expect("partial capture publishes as incomplete");

        assert_eq!(result.status, "incomplete");
        let published = current_coursework(&store);
        let active_matches = published["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| personal_key(item).as_deref() == Some(omitted_key.as_str()))
            .count();
        let archived_matches = published["archivedForecastItems"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| personal_key(item).as_deref() == Some(omitted_key.as_str()))
            .count();
        assert_eq!(active_matches, 1, "omitted Canvas item remains active");
        assert_eq!(archived_matches, 0, "partial capture does not archive it");
        assert_eq!(
            fs::read(retained_material).unwrap(),
            b"synthetic prior material"
        );
        let history: Value =
            serde_json::from_slice(&fs::read(store.store_dir().join(HISTORY_FILE)).unwrap())
                .unwrap();
        let event = history["events"].as_array().unwrap().last().unwrap();
        assert_eq!(event["status"], "incomplete");
        assert_eq!(event["sourceComplete"], false);
        assert_eq!(event["summary"]["removed"], 0);
        assert!(event["changes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|change| change["kind"] != "removed"));
    }

    #[test]
    fn failed_capture_leaves_authoritative_store_bytes_intact() {
        let root = TempRoot::new("refresh-failure");
        let store = authoritative_store(&root);
        let before = snapshot_tree(&store.store_dir());
        let error = refresh(&store, |_, _| Err(RefreshError::FetchFailed), &mut |_| {})
            .expect_err("failed capture");
        assert_eq!(error.to_string(), "refresh could not be completed");
        assert_eq!(snapshot_tree(&store.store_dir()), before);
    }

    #[test]
    fn personal_mutation_completes_during_staging_and_is_reapplied() {
        let root = TempRoot::new("refresh-personal-during-stage");
        let store = authoritative_store(&root);
        let before = current_coursework(&store);
        let item_id = before["items"][0]["id"].as_str().expect("string item ID");
        assert_eq!(before["items"][0]["done"], false);
        let capture = capture_from(&before);
        let mut mutation_succeeded = false;
        let mut report = |progress: RefreshProgress| {
            if !mutation_succeeded
                && progress.phase == RefreshPhase::Stage
                && progress.completed > 0
            {
                store
                    .mutate_item(item_id, "done", false, true)
                    .expect("personal mutation is not blocked by staging");
                mutation_succeeded = true;
            }
        };

        refresh(&store, move |_, _| Ok(capture), &mut report).expect("complete refresh");

        assert!(mutation_succeeded);
        let published = current_coursework(&store);
        assert_eq!(published["items"][0]["title"], "Canvas title update");
        assert_eq!(published["items"][0]["done"], true);
        assert!(published["items"][0]["doneAt"].is_string());
        let history: Value =
            serde_json::from_slice(&fs::read(store.store_dir().join(HISTORY_FILE)).unwrap())
                .unwrap();
        let event = history["events"].as_array().unwrap().last().unwrap();
        assert_eq!(event["personalStateReapplied"], true);
        assert_eq!(event["notice"], "personal_state_reapplied");
        assert_eq!(
            event["changes"][0],
            serde_json::json!({
                "kind": "notice",
                "title": "Personal progress kept",
                "detail": "Changes made during this refresh were preserved."
            })
        );
    }

    #[test]
    fn non_coursework_change_during_staging_aborts_and_cleans_staging() {
        let root = TempRoot::new("refresh-generation-conflict");
        let store = authoritative_store(&root);
        let before = snapshot_tree(&store.store_dir());
        let capture = capture_from(&current_coursework(&store));
        let mut changed = false;
        let mut report = |progress: RefreshProgress| {
            if !changed && progress.phase == RefreshPhase::Stage && progress.completed > 0 {
                let _write_lock = store.write_lock().expect("write lock");
                atomic_write(&store.store_dir().join("new-owner-file.txt"), b"synthetic")
                    .expect("external document update");
                changed = true;
            }
        };

        let error = refresh(&store, move |_, _| Ok(capture), &mut report)
            .expect_err("changed store generation must fail closed");

        assert!(changed);
        assert_eq!(error.to_string(), "refresh could not be completed");
        let mut after = snapshot_tree(&store.store_dir());
        assert_eq!(
            after.remove("new-owner-file.txt"),
            Some(crate::testutil::Entry::File(b"synthetic".to_vec()))
        );
        assert_eq!(after, before);
        assert!(!fs::read_dir(store.data_root())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGING_PREFIX)));
    }

    #[test]
    fn staging_failure_leaves_authoritative_store_bytes_intact() {
        let root = TempRoot::new("refresh-stage-failure");
        let store = authoritative_store(&root);
        let coursework = current_coursework(&store);
        let blocked_target = store.store_dir().join("canvas-profile.json");
        if blocked_target.exists() {
            fs::remove_file(&blocked_target).expect("remove existing profile file");
        }
        create_private_dir(&blocked_target, false).expect("block profile target");
        let before = snapshot_tree(&store.store_dir());
        let mut capture = capture_from(&coursework);
        capture.documents.insert(
            "canvas-profile.json".to_owned(),
            b"{\"profile\":true}\n".to_vec(),
        );

        let error = refresh(&store, move |_, _| Ok(capture), &mut |_| {})
            .expect_err("stage cannot replace a directory with a file");

        assert_eq!(error.to_string(), "refresh could not be completed");
        assert_eq!(snapshot_tree(&store.store_dir()), before);
    }

    #[test]
    fn helper_attaches_without_instance_lock_or_recovery_side_effects() {
        let root = TempRoot::new("refresh-helper-open");
        let store = authoritative_store(&root);
        let staging = store
            .data_root()
            .join(format!("{STAGING_PREFIX}refresh-orphan"));
        create_private_dir(&staging, false).unwrap();
        let helper = Store::open_helper(store.data_root(), Duration::from_millis(100)).unwrap();
        assert!(staging.is_dir(), "helper attachment does not run cleanup");
        assert!(helper.read_lock().is_ok());
        assert!(store
            .data_root()
            .join(crate::config::INSTANCE_LOCK_FILE)
            .exists());
    }

    #[test]
    fn capture_rejects_store_control_paths_before_mutating_anything() {
        let capture = RefreshCapture {
            coursework: serde_json::json!({"courses":[],"items":[]}),
            documents: BTreeMap::from([("../escape.txt".to_owned(), b"unsafe".to_vec())]),
            captured_at: SystemTime::now(),
            source_complete: true,
        };
        assert!(matches!(
            validate_capture(&capture),
            Err(RefreshError::InvalidCapture)
        ));
    }
}
