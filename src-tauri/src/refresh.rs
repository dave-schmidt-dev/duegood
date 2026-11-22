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
        if coursework_without_declared_local_state(&baseline)?
            != coursework_without_declared_local_state(&current)?
            || generation_fingerprint(&store.store_dir())? != generation
        {
            return Err(StoreError::StoreChanged.into());
        }
        let personal_reapplied = personal_state_changed(&baseline, &current)?;
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
                for key in [
                    "id",
                    "name",
                    "filename",
                    "size",
                    "updated_at",
                    "status",
                    "contentType",
                    "sha256",
                    "sourceAuthenticity",
                ] {
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

include!("refresh_generation.rs");

#[cfg(test)]
#[path = "refresh_tests.rs"]
mod tests;
