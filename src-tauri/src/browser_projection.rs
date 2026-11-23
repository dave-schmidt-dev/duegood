//! Pure projection of a validated private browser capture into the native coursework shape.
//!
//! The caller owns capture-version, account, coverage, freshness, and transaction checks. This
//! module maps only explicitly supplied active course scopes and never reads files or downloads
//! file bodies.

#[cfg(test)]
#[path = "browser_projection_tests.rs"]
mod tests;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

use serde_json::{json, Map, Value};

use crate::reconcile::CourseAssignments;

#[path = "browser_projection_calendar.rs"]
mod calendar;
#[path = "browser_projection_content.rs"]
mod content;
#[path = "browser_projection_documents.rs"]
mod documents;
#[path = "browser_projection_group_discussions.rs"]
mod group_discussions;
#[path = "browser_projection_sanitize.rs"]
pub(crate) mod sanitize;

use content::{
    document_item_id, index_detail_records, project_assignments, project_course_files,
    project_document_item_with_detail, project_linked_file_names, project_standalone_discussions,
};
use documents::{project_course, project_file_receipts, put_json};
use sanitize::{project_fields, sanitize_value};

const REQUIRED_ENDPOINTS: [&str; 4] = ["course", "assignments", "assignmentGroups", "submissions"];
const COURSE_DOCS: [(&str, &str); 11] = [
    ("courseTabs", "tabs"),
    ("pages", "pages"),
    ("modules", "modules"),
    ("assignmentGroups", "assignment_groups"),
    ("assignments", "assignments"),
    ("discussions", "discussions"),
    ("announcements", "announcements"),
    ("quizzes", "quizzes"),
    ("courseFiles", "files"),
    ("folders", "folders"),
    ("course", "course"),
];

/// A caller-validated mapping from a Canvas course to its stable native course folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserCourseScope {
    pub key: String,
    pub folder: String,
    pub canvas_course_id: u64,
}

/// Sanitized reconciliation input and fixed-path JSON documents for the native refresh stage.
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserProjection {
    pub coursework: Vec<CourseAssignments>,
    pub documents: BTreeMap<String, Vec<u8>>,
}

/// Content-free projection failure. `code()` is safe for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionError {
    InvalidSnapshot,
    InvalidScope,
    DuplicateScope,
    DuplicateResource,
    MissingEndpoint,
    InvalidResource,
    IdentityMismatch,
    UnsafeContent,
    Serialization,
}

impl ProjectionError {
    /// Returns a stable error code that contains no Canvas data or paths.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidSnapshot => "INVALID_SNAPSHOT",
            Self::InvalidScope => "INVALID_SCOPE",
            Self::DuplicateScope => "DUPLICATE_SCOPE",
            Self::DuplicateResource => "DUPLICATE_RESOURCE",
            Self::MissingEndpoint => "MISSING_ENDPOINT",
            Self::InvalidResource => "INVALID_RESOURCE",
            Self::IdentityMismatch => "IDENTITY_MISMATCH",
            Self::UnsafeContent => "UNSAFE_CONTENT",
            Self::Serialization => "SERIALIZATION_FAILED",
        }
    }
}

impl fmt::Display for ProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ProjectionError {}

/// Projects the required active-course resources and any supported optional course documents.
///
/// `snapshot.complete` is deliberately ignored: the importer must independently validate the
/// complete active inventory and required endpoint coverage before calling or accepting this
/// projection. The required endpoint arrays may be empty when Canvas returned an empty list.
pub fn project_snapshot(
    snapshot: &Value,
    scopes: &[BrowserCourseScope],
) -> Result<BrowserProjection, ProjectionError> {
    let resources = snapshot
        .get("resources")
        .and_then(Value::as_array)
        .ok_or(ProjectionError::InvalidSnapshot)?;
    if snapshot.get("source").and_then(Value::as_str) != Some("canvas-browser") {
        return Err(ProjectionError::InvalidSnapshot);
    }

    let mut scope_by_id = HashMap::new();
    let mut scope_keys = HashSet::new();
    for scope in scopes {
        validate_scope(scope)?;
        if scope_by_id.insert(scope.canvas_course_id, scope).is_some()
            || !scope_keys.insert(scope.key.as_str())
        {
            return Err(ProjectionError::DuplicateScope);
        }
    }
    let active_course_ids: HashSet<u64> = scope_by_id.keys().copied().collect();
    let group_topic_rows = group_discussions::group_discussion_rows(resources, &active_course_ids)?;

    let supported: HashSet<&str> = COURSE_DOCS
        .iter()
        .map(|(endpoint, _)| *endpoint)
        .chain(REQUIRED_ENDPOINTS)
        .chain(["page", "quiz"])
        .collect();
    let mut by_course: HashMap<(u64, String), &Value> = HashMap::new();
    let mut linked_file_resources: HashMap<u64, Vec<&Value>> = HashMap::new();
    let mut page_detail_resources: HashMap<u64, Vec<&Value>> = HashMap::new();
    let mut quiz_detail_resources: HashMap<u64, Vec<&Value>> = HashMap::new();
    let mut file_receipts: Option<&Value> = None;
    for resource in resources {
        let endpoint = resource
            .get("endpoint")
            .and_then(Value::as_str)
            .ok_or(ProjectionError::InvalidResource)?;
        let course_id_value = resource
            .get("courseId")
            .ok_or(ProjectionError::InvalidResource)?;
        if endpoint == "fileBodies" && course_id_value.is_null() {
            if file_receipts.replace(resource).is_some() {
                return Err(ProjectionError::DuplicateResource);
            }
            continue;
        }
        if endpoint == "file" {
            if let Some(course_id) = positive_id(course_id_value) {
                if scope_by_id.contains_key(&course_id) {
                    linked_file_resources
                        .entry(course_id)
                        .or_default()
                        .push(resource);
                }
            } else if !course_id_value.is_null() {
                return Err(ProjectionError::InvalidResource);
            }
            continue;
        }
        if matches!(endpoint, "page" | "quiz") {
            let Some(course_id) = positive_id(course_id_value) else {
                if course_id_value.is_null() {
                    continue;
                }
                return Err(ProjectionError::InvalidResource);
            };
            if scope_by_id.contains_key(&course_id) {
                let details = if endpoint == "page" {
                    &mut page_detail_resources
                } else {
                    &mut quiz_detail_resources
                };
                details.entry(course_id).or_default().push(resource);
            }
            continue;
        }
        if !supported.contains(endpoint) {
            continue;
        }
        let Some(course_id) = positive_id(course_id_value) else {
            if course_id_value.is_null() {
                continue;
            }
            return Err(ProjectionError::InvalidResource);
        };
        if !scope_by_id.contains_key(&course_id) {
            continue;
        }
        if by_course
            .insert((course_id, endpoint.to_owned()), resource)
            .is_some()
        {
            return Err(ProjectionError::DuplicateResource);
        }
    }

    let mut coursework = Vec::with_capacity(scopes.len());
    let mut documents = BTreeMap::new();
    for scope in scopes {
        let mut endpoint_resources = HashMap::new();
        for endpoint in REQUIRED_ENDPOINTS {
            let resource = by_course
                .get(&(scope.canvas_course_id, endpoint.to_owned()))
                .copied()
                .ok_or(ProjectionError::MissingEndpoint)?;
            endpoint_resources.insert(endpoint, resource);
        }
        let course = items(endpoint_resources["course"])?;
        if course.len() != 1 || positive_id(&course[0]["id"]) != Some(scope.canvas_course_id) {
            return Err(ProjectionError::IdentityMismatch);
        }

        let assignments_raw = items(endpoint_resources["assignments"])?;
        let groups_raw = items(endpoint_resources["assignmentGroups"])?;
        let submissions_raw = items(endpoint_resources["submissions"])?;
        let linked_file_names = project_linked_file_names(
            linked_file_resources.get(&scope.canvas_course_id),
            scope.canvas_course_id,
        )?;
        let mut discussions_raw = by_course
            .get(&(scope.canvas_course_id, "discussions".to_owned()))
            .copied()
            .map(items)
            .transpose()?
            .unwrap_or_default()
            .to_vec();
        content::merge_group_discussions(
            &mut discussions_raw,
            &group_topic_rows,
            scope.canvas_course_id,
        )?;
        let announcements_raw = by_course
            .get(&(scope.canvas_course_id, "announcements".to_owned()))
            .copied()
            .map(items)
            .transpose()?
            .unwrap_or_default()
            .to_vec();
        let course_topics = content::merge_course_announcements(
            &discussions_raw,
            &announcements_raw,
            scope.canvas_course_id,
        )?;
        let page_details = index_detail_records(
            page_detail_resources.get(&scope.canvas_course_id),
            "page",
            scope.canvas_course_id,
        )?;
        let quiz_details = index_detail_records(
            quiz_detail_resources.get(&scope.canvas_course_id),
            "quiz",
            scope.canvas_course_id,
        )?;
        let groups = project_groups(groups_raw, scope.canvas_course_id)?;
        let assignments = project_assignments(
            assignments_raw,
            submissions_raw,
            &course_topics,
            scope.canvas_course_id,
            snapshot
                .get("identity")
                .and_then(|identity| identity.get("userId"))
                .and_then(positive_id),
            &groups,
            &linked_file_names,
        )?;
        let standalone_discussions = project_standalone_discussions(
            &course_topics,
            &assignments,
            scope.canvas_course_id,
            &linked_file_names,
        )?;
        coursework.push(CourseAssignments {
            key: scope.key.clone(),
            groups: groups.clone(),
            assignments: assignments.clone(),
            discussions: standalone_discussions,
        });

        let mut inventory = Map::new();
        if let Some(captured_at) = snapshot.get("capturedAt") {
            inventory.insert(
                "capturedAt".into(),
                sanitize_value(captured_at, "capturedAt")?,
            );
        }
        inventory.insert(
            "captureGaps".into(),
            Value::Array(capture_truncation_gaps(scope, &by_course)?),
        );
        let export_root = format!("{}/canvas-export", scope.folder);
        let listed_files = by_course
            .get(&(scope.canvas_course_id, "courseFiles".to_owned()))
            .copied();
        let linked_files = linked_file_resources.get(&scope.canvas_course_id);
        let projected_files = project_course_files(
            listed_files,
            linked_files,
            scope.canvas_course_id,
            snapshot.get("runId").and_then(positive_id),
        )?;
        for (endpoint, document_name) in COURSE_DOCS {
            let value = if endpoint == "course" {
                Value::Object(project_course(&course[0])?)
            } else if endpoint == "assignmentGroups" {
                Value::Array(groups.clone())
            } else if endpoint == "assignments" {
                Value::Array(assignments.clone())
            } else if endpoint == "courseFiles" {
                let Some(files) = projected_files.as_ref() else {
                    continue;
                };
                Value::Array(files.clone())
            } else if let Some(resource) = by_course
                .get(&(scope.canvas_course_id, endpoint.to_owned()))
                .copied()
            {
                let raw_items = items(resource)?;
                let details = match endpoint {
                    "pages" => Some(&page_details),
                    "quizzes" => Some(&quiz_details),
                    _ => None,
                };
                Value::Array(
                    raw_items
                        .iter()
                        .map(|item| {
                            validate_course_identity(item, scope.canvas_course_id)?;
                            project_document_item_with_detail(
                                endpoint,
                                item,
                                details.and_then(|records| {
                                    document_item_id(endpoint, item).and_then(|id| records.get(&id))
                                }),
                                &linked_file_names,
                            )
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                )
            } else {
                // INV-4: an optional endpoint that was not read this run is a gap, not an empty
                // list. Emit no document so the staged copy of the live store keeps its record.
                continue;
            };
            inventory.insert(document_name.into(), value.clone());
            put_json(
                &mut documents,
                &format!("{export_root}/api/{document_name}.json"),
                &value,
            )?;
        }
        // The inventory only mirrors the documents read this run; the api documents above stay
        // authoritative, so an unread endpoint is absent here rather than recorded as empty.
        put_json(
            &mut documents,
            &format!("{export_root}/course-inventory.json"),
            &Value::Object(inventory),
        )?;
        if let Some(files) = projected_files {
            let has_listing = listed_files.is_some();
            let has_details = linked_files.is_some_and(|resources| !resources.is_empty());
            if has_listing || has_details {
                let download_manifest = project_file_receipts(file_receipts, &files)?;
                put_json(
                    &mut documents,
                    &format!("{export_root}/download-manifest.json"),
                    &Value::Array(download_manifest),
                )?;
            }
        }
        put_json(
            &mut documents,
            &format!("{export_root}/api/calendar-event-identities.json"),
            &calendar::project_event_identities(snapshot, scope),
        )?;
    }

    Ok(BrowserProjection {
        coursework,
        documents,
    })
}

fn capture_truncation_gaps(
    scope: &BrowserCourseScope,
    resources: &HashMap<(u64, String), &Value>,
) -> Result<Vec<Value>, ProjectionError> {
    let mut gaps = Vec::new();
    for (endpoint, _) in COURSE_DOCS {
        let Some(resource) = resources
            .get(&(scope.canvas_course_id, endpoint.to_owned()))
            .copied()
        else {
            continue;
        };
        for item in items(resource)? {
            if item.get("_canvasLinksTruncated").and_then(Value::as_bool) == Some(true) {
                gaps.push(json!({"endpoint": endpoint, "reason": "links-truncated"}));
            }
            if item.get("_canvasTextTruncated").and_then(Value::as_bool) == Some(true) {
                gaps.push(json!({"endpoint": endpoint, "reason": "text-truncated"}));
            }
        }
    }
    Ok(gaps)
}

fn validate_scope(scope: &BrowserCourseScope) -> Result<(), ProjectionError> {
    if scope.canvas_course_id == 0 || scope.folder.len() > 512 || !safe_component(&scope.key) {
        return Err(ProjectionError::InvalidScope);
    }
    let components: Vec<&str> = scope.folder.split('/').collect();
    if components.len() != 2 || components[0] != "classes" || !safe_component(components[1]) {
        return Err(ProjectionError::InvalidScope);
    }
    Ok(())
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub(super) fn positive_id(value: &Value) -> Option<u64> {
    let id = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))?;
    (id > 0).then_some(id)
}

pub(super) fn items(resource: &Value) -> Result<&[Value], ProjectionError> {
    resource
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or(ProjectionError::InvalidResource)
}

fn project_groups(groups: &[Value], course_id: u64) -> Result<Vec<Value>, ProjectionError> {
    let mut seen = HashSet::new();
    groups
        .iter()
        .map(|group| {
            validate_course_identity(group, course_id)?;
            let id = group
                .get("id")
                .and_then(positive_id)
                .ok_or(ProjectionError::InvalidResource)?;
            if !seen.insert(id) {
                return Err(ProjectionError::InvalidResource);
            }
            Ok(Value::Object(project_fields(
                group,
                &["id", "name", "group_weight", "links"],
            )?))
        })
        .collect()
}

pub(super) fn validate_course_identity(item: &Value, expected: u64) -> Result<(), ProjectionError> {
    let object = item.as_object().ok_or(ProjectionError::InvalidResource)?;
    for field in ["course_id", "courseId"] {
        if let Some(value) = object.get(field) {
            if positive_id(value) != Some(expected) {
                return Err(ProjectionError::IdentityMismatch);
            }
        }
    }
    if let Some(context) = object.get("context_code").and_then(Value::as_str) {
        if context != format!("course_{expected}") {
            return Err(ProjectionError::IdentityMismatch);
        }
    }
    Ok(())
}
