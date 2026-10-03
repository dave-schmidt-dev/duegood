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
#[path = "browser_projection_documents.rs"]
mod documents;
#[path = "browser_projection_sanitize.rs"]
mod sanitize;

use documents::{project_course, project_document_item, project_file_receipts, put_json};
use sanitize::{project_fields, sanitize_value};

const REQUIRED_ENDPOINTS: [&str; 4] = ["course", "assignments", "assignmentGroups", "submissions"];
const COURSE_DOCS: [(&str, &str); 10] = [
    ("courseTabs", "tabs"),
    ("pages", "pages"),
    ("modules", "modules"),
    ("assignmentGroups", "assignment_groups"),
    ("assignments", "assignments"),
    ("discussions", "discussions"),
    ("announcements", "announcements"),
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

    let supported: HashSet<&str> = COURSE_DOCS
        .iter()
        .map(|(endpoint, _)| *endpoint)
        .chain(REQUIRED_ENDPOINTS)
        .collect();
    let mut by_course: HashMap<(u64, String), &Value> = HashMap::new();
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
        let groups = project_groups(groups_raw, scope.canvas_course_id)?;
        let assignments = project_assignments(
            assignments_raw,
            submissions_raw,
            scope.canvas_course_id,
            snapshot
                .get("identity")
                .and_then(|identity| identity.get("userId"))
                .and_then(positive_id),
            &groups,
        )?;
        coursework.push(CourseAssignments {
            key: scope.key.clone(),
            groups: groups.clone(),
            assignments: assignments.clone(),
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
        for (endpoint, document_name) in COURSE_DOCS {
            let value = if endpoint == "course" {
                Value::Object(project_course(&course[0])?)
            } else if endpoint == "assignmentGroups" {
                Value::Array(groups.clone())
            } else if endpoint == "assignments" {
                Value::Array(assignments.clone())
            } else if let Some(resource) = by_course
                .get(&(scope.canvas_course_id, endpoint.to_owned()))
                .copied()
            {
                let raw_items = items(resource)?;
                Value::Array(
                    raw_items
                        .iter()
                        .map(|item| {
                            validate_course_identity(item, scope.canvas_course_id)?;
                            project_document_item(endpoint, item)
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                )
            } else {
                Value::Array(Vec::new())
            };
            inventory.insert(document_name.into(), value.clone());
            put_json(
                &mut documents,
                &format!("{export_root}/api/{document_name}.json"),
                &value,
            )?;
        }
        put_json(
            &mut documents,
            &format!("{export_root}/course-inventory.json"),
            &Value::Object(inventory),
        )?;
        let download_manifest = project_file_receipts(
            file_receipts,
            by_course
                .get(&(scope.canvas_course_id, "courseFiles".to_owned()))
                .copied(),
        )?;
        put_json(
            &mut documents,
            &format!("{export_root}/download-manifest.json"),
            &Value::Array(download_manifest),
        )?;
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

fn positive_id(value: &Value) -> Option<u64> {
    let id = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))?;
    (id > 0).then_some(id)
}

fn items(resource: &Value) -> Result<&[Value], ProjectionError> {
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

fn project_assignments(
    assignments: &[Value],
    submissions: &[Value],
    course_id: u64,
    expected_user_id: Option<u64>,
    groups: &[Value],
) -> Result<Vec<Value>, ProjectionError> {
    let mut group_ids = HashSet::new();
    for group in groups {
        if let Some(id) = group.get("id").and_then(positive_id) {
            group_ids.insert(id);
        }
    }
    let mut submission_by_assignment = HashMap::<u64, Map<String, Value>>::new();
    for submission in submissions {
        validate_course_identity(submission, course_id)?;
        if let (Some(expected), Some(actual)) = (
            expected_user_id,
            submission.get("user_id").and_then(positive_id),
        ) {
            if expected != actual {
                return Err(ProjectionError::IdentityMismatch);
            }
        }
        let assignment_id = submission
            .get("assignment_id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        let projected = project_fields(
            submission,
            &[
                "workflow_state",
                "submitted_at",
                "graded_at",
                "grade",
                "score",
                "excused",
                "missing",
                "late",
            ],
        )?;
        if submission_by_assignment
            .insert(assignment_id, projected)
            .is_some()
        {
            return Err(ProjectionError::InvalidResource);
        }
    }

    let mut seen = HashSet::new();
    let mut output = Vec::with_capacity(assignments.len());
    for assignment in assignments {
        validate_course_identity(assignment, course_id)?;
        let id = assignment
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if assignment.get("name").and_then(Value::as_str).is_none() {
            return Err(ProjectionError::InvalidResource);
        }
        if !seen.insert(id) {
            return Err(ProjectionError::InvalidResource);
        }
        if let Some(group) = assignment.get("assignment_group_id") {
            if !group.is_null() {
                let group_id = positive_id(group).ok_or(ProjectionError::InvalidResource)?;
                if !group_ids.contains(&group_id) {
                    return Err(ProjectionError::IdentityMismatch);
                }
            }
        }
        let mut projected = project_fields(
            assignment,
            &[
                "id",
                "name",
                "due_at",
                "points_possible",
                "assignment_group_id",
                "html_url",
                "submission_types",
                "links",
            ],
        )?;
        if let Some(nested) = assignment.get("submission") {
            projected.insert(
                "submission".into(),
                if nested.is_null() {
                    Value::Null
                } else {
                    Value::Object(project_fields(
                        nested,
                        &[
                            "workflow_state",
                            "submitted_at",
                            "graded_at",
                            "grade",
                            "score",
                            "excused",
                            "missing",
                            "late",
                        ],
                    )?)
                },
            );
        }
        if let Some(submission) = submission_by_assignment.remove(&id) {
            projected.insert("submission".into(), Value::Object(submission));
        }
        output.push(Value::Object(projected));
    }
    if !submission_by_assignment.is_empty() {
        return Err(ProjectionError::IdentityMismatch);
    }
    Ok(output)
}

fn validate_course_identity(item: &Value, expected: u64) -> Result<(), ProjectionError> {
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
