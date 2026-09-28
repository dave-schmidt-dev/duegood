//! Exact native-course mapping and inactive archive records for browser import.

use std::collections::BTreeSet;
use std::path::{Component, Path};

use serde_json::{json, Map, Value};

use crate::browser_bundle::ValidatedCaptureBundle;
use crate::browser_projection::BrowserCourseScope;
use crate::config::ImportLimits;
use crate::store::{read_capped, Store};

use super::{BrowserImportError, MAX_COURSES};

pub(super) fn validate_native_inventory(
    coursework: &Value,
    course_map: &Value,
    store: &Store,
    bundle: &ValidatedCaptureBundle,
) -> Result<Vec<BrowserCourseScope>, BrowserImportError> {
    let configured = course_map
        .get("courses")
        .and_then(Value::as_array)
        .filter(|courses| !courses.is_empty() && courses.len() <= MAX_COURSES)
        .ok_or(BrowserImportError::InvalidInventory)?;
    let local_courses = coursework
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(BrowserImportError::InvalidInventory)?;
    let mut active_coverage = std::collections::BTreeMap::new();
    let required = ["course", "assignments", "assignmentGroups", "submissions"]
        .into_iter()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    for record in &bundle.active_courses {
        if !record.complete || record.required_endpoints != required {
            return Err(BrowserImportError::IncompleteCoverage);
        }
        if active_coverage.insert(record.course_id, ()).is_some() {
            return Err(BrowserImportError::InvalidInventory);
        }
    }
    let completed_ids = bundle
        .snapshot
        .get("resources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|resource| {
            resource.get("endpoint").and_then(Value::as_str) == Some("coursesCompleted")
                && resource.get("courseId").is_some_and(Value::is_null)
        })
        .flat_map(|resource| {
            resource
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|course| positive_id(course.get("id")))
        .collect::<BTreeSet<_>>();
    let mut seen_keys = BTreeSet::new();
    let mut seen_ids = BTreeSet::new();
    let mut seen_folders = BTreeSet::new();
    let mut scopes = Vec::with_capacity(configured.len());
    for config in configured {
        let key =
            bounded_text(config.get("key"), 160).ok_or(BrowserImportError::InvalidInventory)?;
        let canvas_course_id =
            positive_id(config.get("canvasId")).ok_or(BrowserImportError::InvalidInventory)?;
        if !seen_keys.insert(key.clone()) || !seen_ids.insert(canvas_course_id) {
            return Err(BrowserImportError::IncompleteCoverage);
        }
        if !active_coverage.contains_key(&canvas_course_id)
            && (!completed_ids.contains(&canvas_course_id)
                || !completed_course_coverage(bundle, canvas_course_id))
        {
            return Err(BrowserImportError::IncompleteCoverage);
        }
        let matches = local_courses
            .iter()
            .filter(|course| course.get("key").and_then(Value::as_str) == Some(key.as_str()))
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(BrowserImportError::InvalidInventory);
        }
        let local = matches[0];
        let local_id = positive_id(local.get("canvasCourseId"));
        if local_id.is_some_and(|id| id != canvas_course_id) {
            return Err(BrowserImportError::InvalidInventory);
        }
        let folder = local
            .get("folder")
            .and_then(Value::as_str)
            .and_then(normalized_folder)
            .unwrap_or_else(|| format!("canvas-{canvas_course_id}"));
        if !crate::import::is_course_folder_name(&folder) || !seen_folders.insert(folder.clone()) {
            return Err(BrowserImportError::InvalidInventory);
        }
        let prior_id = course_metadata_id(store, &folder)?;
        if prior_id.is_some_and(|id| id != canvas_course_id)
            || (local_id.is_none() && prior_id.is_none())
        {
            return Err(BrowserImportError::InvalidInventory);
        }
        scopes.push(BrowserCourseScope {
            key,
            folder: format!("classes/{folder}"),
            canvas_course_id,
        });
    }
    if scopes.is_empty() {
        return Err(BrowserImportError::IncompleteCoverage);
    }
    Ok(scopes)
}

fn completed_course_coverage(bundle: &ValidatedCaptureBundle, course_id: u64) -> bool {
    let required = ["course", "assignments", "assignmentGroups", "submissions"];
    required.iter().all(|endpoint| {
        bundle
            .coverage
            .iter()
            .filter(|row| {
                row.course_id == Some(course_id)
                    && row.endpoint == *endpoint
                    && row.status == "complete"
            })
            .count()
            == 1
            && bundle
                .snapshot
                .get("resources")
                .and_then(Value::as_array)
                .is_some_and(|resources| {
                    resources
                        .iter()
                        .filter(|resource| {
                            resource.get("courseId").and_then(Value::as_u64) == Some(course_id)
                                && resource.get("endpoint").and_then(Value::as_str)
                                    == Some(*endpoint)
                        })
                        .count()
                        == 1
                })
    })
}

fn course_metadata_id(store: &Store, folder: &str) -> Result<Option<u64>, BrowserImportError> {
    let root = store.store_dir();
    let mut found = None;
    for relative in [
        format!("classes/{folder}/canvas-export/api/course.json"),
        format!("classes/{folder}/canvas-export/course.json"),
    ] {
        let path = root.join(&relative);
        let Some(bytes) = read_existing_under(&root, &path)? else {
            continue;
        };
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| BrowserImportError::InvalidInventory)?;
        let id = positive_id(value.get("id")).ok_or(BrowserImportError::InvalidInventory)?;
        if found.is_some_and(|prior| prior != id) {
            return Err(BrowserImportError::InvalidInventory);
        }
        found = Some(id);
    }
    Ok(found)
}

fn read_existing_under(root: &Path, path: &Path) -> Result<Option<Vec<u8>>, BrowserImportError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| BrowserImportError::InvalidInventory)?;
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(BrowserImportError::InvalidInventory);
    }
    let mut current = root.to_path_buf();
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(BrowserImportError::InvalidInventory);
        };
        current.push(name);
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(BrowserImportError::InvalidInventory),
        };
        if index + 1 == components.len() {
            if !metadata.file_type().is_file()
                || metadata.len() > ImportLimits::PRODUCTION.max_json_bytes
            {
                return Err(BrowserImportError::InvalidInventory);
            }
        } else if !metadata.file_type().is_dir() {
            return Err(BrowserImportError::InvalidInventory);
        }
    }
    read_capped(path, ImportLimits::PRODUCTION.max_json_bytes)
        .map_err(|_| BrowserImportError::InvalidInventory)
}

pub(super) fn apply_promoted_folders(
    coursework: &mut Value,
    scopes: &[BrowserCourseScope],
) -> Result<(), BrowserImportError> {
    let courses = coursework
        .get_mut("courses")
        .and_then(Value::as_array_mut)
        .ok_or(BrowserImportError::InvalidInventory)?;
    for scope in scopes {
        let course = courses
            .iter_mut()
            .find(|course| course.get("key").and_then(Value::as_str) == Some(scope.key.as_str()))
            .ok_or(BrowserImportError::InvalidInventory)?;
        let object = course
            .as_object_mut()
            .ok_or(BrowserImportError::InvalidInventory)?;
        object.insert("folder".into(), Value::String(scope.folder.clone()));
        object
            .entry("canvasCourseId")
            .or_insert(Value::from(scope.canvas_course_id));
    }
    Ok(())
}

pub(super) fn inactive_course_archive(
    bundle: &ValidatedCaptureBundle,
    scopes: &[BrowserCourseScope],
) -> Result<Value, BrowserImportError> {
    let selected = scopes
        .iter()
        .map(|scope| scope.canvas_course_id)
        .collect::<BTreeSet<_>>();
    let mut courses = std::collections::BTreeMap::<u64, Value>::new();
    let resources = bundle
        .snapshot
        .get("resources")
        .and_then(Value::as_array)
        .ok_or(BrowserImportError::InvalidInventory)?;
    for (endpoint, classification) in [
        ("coursesActive", "current-unselected"),
        ("coursesCompleted", "historical"),
    ] {
        for resource in resources.iter().filter(|resource| {
            resource.get("endpoint").and_then(Value::as_str) == Some(endpoint)
                && resource.get("courseId").is_some_and(Value::is_null)
        }) {
            for item in resource
                .get("items")
                .and_then(Value::as_array)
                .ok_or(BrowserImportError::InvalidInventory)?
            {
                let id = positive_id(item.get("id")).ok_or(BrowserImportError::InvalidInventory)?;
                if selected.contains(&id) {
                    continue;
                }
                let mut summary = Map::new();
                for field in ["id", "name", "course_code", "term"] {
                    if let Some(value) = item.get(field) {
                        summary.insert(field.into(), value.clone());
                    }
                }
                courses.entry(id).or_insert_with(|| json!({
                    "canvasCourseId": id, "key": format!("canvas-{id}"), "folder": format!("canvas-{id}"),
                    "active": false, "classification": classification, "course": Value::Object(summary)
                }));
            }
        }
    }
    Ok(
        json!({ "format": "duegood-browser-course-archive", "version": 1, "courses": courses.into_values().collect::<Vec<_>>() }),
    )
}

fn normalized_folder(value: &str) -> Option<String> {
    let name = value.strip_prefix("classes/").unwrap_or(value);
    crate::import::is_course_folder_name(name).then(|| name.to_owned())
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    let id = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))?;
    (id > 0).then_some(id)
}

fn bounded_text(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.len() <= max)
        .map(str::to_owned)
}
