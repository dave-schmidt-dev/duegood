//! Durable receipt validation and safe filesystem operations for browser import.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::browser_bundle::{CaptureCoverage, ValidatedCaptureBundle};
use crate::browser_projection::BrowserCourseScope;
use crate::browser_resources::PromotionResult;
use crate::config::{ReadLimits, COURSEWORK_FILE};
use crate::store::{
    atomic_write, create_private_dir, node_json_bytes, read_capped, Store, StoreCondition,
    StoreState,
};

use super::{BrowserImportError, MAX_JSON_BYTES, STATUS_FILE, STATUS_FORMAT, STATUS_VERSION};

pub(super) struct NativeView {
    pub coursework: Value,
    pub course_map: Value,
    pub status: Option<Value>,
}

pub(super) fn read_native_view(store: &Store) -> Result<NativeView, BrowserImportError> {
    match store.condition()? {
        StoreCondition::Ready(manifest) if manifest.state == StoreState::Authoritative => {}
        _ => return Err(BrowserImportError::InvalidStore),
    }
    let coursework = read_json_document(
        store,
        COURSEWORK_FILE,
        ReadLimits::PRODUCTION.max_document_bytes,
    )?
    .ok_or(BrowserImportError::InvalidStore)?;
    let course_map = read_json_document(store, "courses.json", MAX_JSON_BYTES)?
        .ok_or(BrowserImportError::InvalidInventory)?;
    let status = read_json_document(store, STATUS_FILE, 1024 * 1024)?;
    Ok(NativeView {
        coursework,
        course_map,
        status,
    })
}

fn read_json_document(
    store: &Store,
    relative: &str,
    cap: u64,
) -> Result<Option<Value>, BrowserImportError> {
    let path = store.store_dir().join(relative);
    let Some(bytes) = read_plain_file_under(&store.store_dir(), &path, cap)? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| BrowserImportError::InvalidStore)
}

fn read_plain_file_under(
    root: &Path,
    path: &Path,
    cap: u64,
) -> Result<Option<Vec<u8>>, BrowserImportError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| BrowserImportError::InvalidStore)?;
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(BrowserImportError::InvalidStore);
    }
    let mut current = root.to_path_buf();
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(BrowserImportError::InvalidStore);
        };
        current.push(name);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(BrowserImportError::InvalidStore),
        };
        let is_leaf = index + 1 == components.len();
        if is_leaf {
            if !metadata.file_type().is_file() || metadata.len() > cap {
                return Err(BrowserImportError::InvalidStore);
            }
        } else if !metadata.file_type().is_dir() {
            return Err(BrowserImportError::InvalidStore);
        }
    }
    read_capped(path, cap).map_err(BrowserImportError::Store)
}

pub(super) fn check_prior_receipt(
    previous: Option<&Value>,
    run_id: u64,
    generation_id: &str,
    user_id: u64,
    confirmation: Option<u64>,
) -> Result<bool, BrowserImportError> {
    if confirmation.is_some_and(|confirmed| confirmed != user_id) {
        return Err(BrowserImportError::AccountMismatch);
    }
    let Some(previous) = previous else {
        return if confirmation == Some(user_id) {
            Ok(false)
        } else {
            Err(BrowserImportError::ConfirmationRequired)
        };
    };
    if previous.get("format").and_then(Value::as_str) != Some(STATUS_FORMAT)
        || previous.get("version").and_then(Value::as_u64) != Some(STATUS_VERSION)
    {
        return Err(BrowserImportError::InvalidStore);
    }
    let prior_user = positive_id(previous.get("userId")).ok_or(BrowserImportError::InvalidStore)?;
    let prior_run = positive_id(previous.get("runId")).ok_or(BrowserImportError::InvalidStore)?;
    let prior_generation = previous
        .get("generationId")
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 32
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
        .ok_or(BrowserImportError::InvalidStore)?;
    if prior_user != user_id {
        return Err(BrowserImportError::AccountMismatch);
    }
    if prior_run > run_id {
        return Err(BrowserImportError::OlderCapture);
    }
    if prior_run == run_id {
        return if prior_generation == generation_id {
            Ok(true)
        } else {
            Err(BrowserImportError::InvalidStore)
        };
    }
    Ok(false)
}

pub(super) fn import_status(
    bundle: &ValidatedCaptureBundle,
    promoted: &PromotionResult,
) -> Result<Value, BrowserImportError> {
    const ACCOUNT_ENDPOINTS: &[&str] = &[
        "profile",
        "coursesActive",
        "personalFiles",
        "personalFolders",
        "personalFile",
        "inbox",
        "inboxAll",
        "conversationsSent",
        "conversationsArchived",
        "conversation",
    ];
    const COURSE_ENDPOINTS: &[&str] = &[
        "course",
        "syllabus",
        "courseTabs",
        "assignments",
        "assignmentGroups",
        "submissions",
        "submission",
        "pages",
        "page",
        "modules",
        "moduleItems",
        "discussions",
        "discussionEntries",
        "discussionReplies",
        "announcements",
        "quizzes",
        "quiz",
        "courseFiles",
        "folders",
        "file",
    ];
    let active_course_ids = bundle
        .active_courses
        .iter()
        .map(|course| course.course_id)
        .collect::<std::collections::BTreeSet<_>>();
    let account_calendar_rows = bundle
        .coverage
        .iter()
        .filter(|record| {
            record.endpoint == "calendarEvents"
                && record.course_id.is_none()
                && record.group_id.is_none()
                && record.context_code.is_none()
        })
        .count();
    let mut rows = std::collections::BTreeMap::<(Option<u64>, String), String>::new();
    for record in &bundle.coverage {
        if record.group_id.is_some() || record.context_code.is_some() {
            continue;
        }
        let supported = match record.endpoint.as_str() {
            "calendarEvents" => record.course_id.is_none() && account_calendar_rows == 1,
            endpoint if ACCOUNT_ENDPOINTS.contains(&endpoint) => record.course_id.is_none(),
            endpoint if COURSE_ENDPOINTS.contains(&endpoint) => record
                .course_id
                .is_some_and(|course_id| active_course_ids.contains(&course_id)),
            _ => false,
        };
        if !supported {
            continue;
        }
        let key = (record.course_id, record.endpoint.clone());
        let status = allowed_coverage_status(record)?;
        rows.entry(key)
            .and_modify(|prior| {
                if coverage_severity(&status) > coverage_severity(prior) {
                    *prior = status.clone();
                }
            })
            .or_insert(status);
    }
    let sections = rows.into_iter().map(|((course_id, endpoint), status)| json!({ "courseId": course_id, "endpoint": endpoint, "status": status })).collect::<Vec<_>>();
    Ok(json!({
        "format": STATUS_FORMAT, "version": STATUS_VERSION,
        "runId": bundle.run_id, "generationId": bundle.generation_id, "userId": bundle.user_id,
        "observedAt": bundle.captured_at, "sections": sections,
        "files": { "available": promoted.promoted_blobs + promoted.reused_blobs > 0,
            "promotionVerified": true, "promotedBlobs": promoted.promoted_blobs,
            "reusedBlobs": promoted.reused_blobs, "bytesVerified": promoted.bytes_verified }
    }))
}

fn allowed_coverage_status(row: &CaptureCoverage) -> Result<String, BrowserImportError> {
    match row.status.as_str() {
        "complete" | "incomplete" | "gap" => Ok(row.status.clone()),
        _ => Err(BrowserImportError::InvalidInventory),
    }
}

fn coverage_severity(status: &str) -> u8 {
    match status {
        "complete" => 0,
        "incomplete" => 1,
        _ => 2,
    }
}

pub(super) fn write_projected_document(
    stage: &Path,
    relative: &str,
    bytes: &[u8],
    scopes: &[BrowserCourseScope],
) -> Result<(), BrowserImportError> {
    if relative.is_empty()
        || relative.len() > 1024
        || Path::new(relative).is_absolute()
        || relative.contains('\\')
        || relative
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
        || !Path::new(relative)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        || !(matches!(
            relative,
            "canvas-profile.json" | "canvas-conversations.json"
        ) || scopes
            .iter()
            .any(|scope| relative.starts_with(&format!("{}/canvas-export/", scope.folder))))
    {
        return Err(BrowserImportError::Stage);
    }
    let path = stage.join(relative);
    let parent = path.parent().ok_or(BrowserImportError::Stage)?;
    create_private_dir_all(stage, parent)?;
    atomic_write(&path, bytes).map_err(|_| BrowserImportError::Stage)
}

pub(super) fn write_stage_json(
    stage: &Path,
    relative: &str,
    value: &Value,
) -> Result<(), BrowserImportError> {
    atomic_write(&stage.join(relative), &node_json_bytes(value))
        .map_err(|_| BrowserImportError::Stage)
}

pub(super) fn write_verified_legacy_archive(
    stage: &Path,
    document: &[u8],
) -> Result<(), BrowserImportError> {
    let value: Value = serde_json::from_slice(document).map_err(|_| BrowserImportError::Stage)?;
    if document.len() as u64 > MAX_JSON_BYTES
        || value.get("format").and_then(Value::as_str) != Some("duegood-browser-legacy-resources")
        || value.get("version").and_then(Value::as_u64) != Some(1)
        || value.get("files").and_then(Value::as_array).is_none()
    {
        return Err(BrowserImportError::Stage);
    }
    let path = stage.join("browser-legacy-resource-archive.json");
    atomic_write(&path, document).map_err(|_| BrowserImportError::Stage)?;
    if read_plain_file_under(stage, &path, MAX_JSON_BYTES)?.as_deref() != Some(document) {
        return Err(BrowserImportError::Stage);
    }
    Ok(())
}

pub(super) fn remove_verified_legacy_materials(
    stage: &Path,
    paths: &[PathBuf],
) -> Result<(), BrowserImportError> {
    let mut validated = Vec::with_capacity(paths.len());
    let mut unique = std::collections::BTreeSet::new();
    for relative in paths {
        let components = safe_legacy_material_components(relative)?;
        if !unique.insert(relative.clone()) {
            return Err(BrowserImportError::Stage);
        }
        let mut current = stage.to_path_buf();
        for component in &components[..components.len() - 1] {
            current.push(component);
            let metadata = fs::symlink_metadata(&current).map_err(|_| BrowserImportError::Stage)?;
            if !metadata.file_type().is_dir() {
                return Err(BrowserImportError::Stage);
            }
        }
        let leaf = components.last().ok_or(BrowserImportError::Stage)?;
        current.push(leaf);
        let metadata = fs::symlink_metadata(&current).map_err(|_| BrowserImportError::Stage)?;
        if !metadata.file_type().is_file() {
            return Err(BrowserImportError::Stage);
        }
        validated.push(current);
    }
    for path in validated {
        fs::remove_file(path).map_err(|_| BrowserImportError::Stage)?;
    }
    Ok(())
}

fn safe_legacy_material_components(relative: &Path) -> Result<Vec<String>, BrowserImportError> {
    if relative.is_absolute() || relative.to_str().is_none_or(|value| value.contains('\\')) {
        return Err(BrowserImportError::Stage);
    }
    let components = relative
        .components()
        .map(|component| match component {
            Component::Normal(name) => name.to_str().map(str::to_owned),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or(BrowserImportError::Stage)?;
    if components.len() != 4
        || components[0] != "classes"
        || components[2] != "materials"
        || !safe_legacy_component(&components[1], 120)
        || !safe_legacy_component(&components[3], 255)
    {
        return Err(BrowserImportError::Stage);
    }
    Ok(components)
}

fn safe_legacy_component(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn create_private_dir_all(root: &Path, target: &Path) -> Result<(), BrowserImportError> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| BrowserImportError::Stage)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(BrowserImportError::Stage);
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err(BrowserImportError::Stage),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_private_dir(&current, false).map_err(|_| BrowserImportError::Stage)?
            }
            Err(_) => return Err(BrowserImportError::Stage),
        }
    }
    Ok(())
}

pub(super) fn read_plain_file(path: &Path, cap: u64) -> Result<Vec<u8>, BrowserImportError> {
    match fs::symlink_metadata(path) {
        Err(_) => return Err(BrowserImportError::InvalidStore),
        Ok(metadata) if !metadata.file_type().is_file() || metadata.len() > cap => {
            return Err(BrowserImportError::InvalidStore)
        }
        Ok(_) => {}
    }
    read_capped(path, cap)
        .map_err(BrowserImportError::Store)?
        .ok_or(BrowserImportError::InvalidStore)
}

pub(super) struct StageCleanup(pub PathBuf);

impl Drop for StageCleanup {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    let id = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))?;
    (id > 0).then_some(id)
}
