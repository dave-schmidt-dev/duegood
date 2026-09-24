//! Bounded, read-only Canvas capture and privacy projection.
//!
//! This module never accesses the filesystem. It returns sanitized relative-path bytes for the
//! refresh transaction to stage atomically.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::canvas::{ApiResponse, CanvasApi};
use crate::downloads::DownloadClient;
use crate::reconcile::{reconcile_coursework, CourseAssignments};
use crate::refresh::{RefreshCapture, RefreshPhase, RefreshPrior, RefreshProgress};

const MAX_COURSES: usize = 500;
const MAX_PAGES: usize = 100;
const MAX_ITEMS: usize = 10_000;
const MAX_FILES: usize = 100;
const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 512 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 32 * 1024 * 1024;
const MAX_AVATAR_BYTES: usize = 5 * 1024 * 1024;
const MAX_INBOX_PAGES: usize = 10;
const MAX_CONVERSATIONS: usize = 500;
const MAX_MESSAGES: usize = 2_000;
const MAX_ATTACHMENTS: usize = 25;
const MAX_MESSAGE_BYTES: usize = 1_000_000;
const MAX_INBOX_BYTES: usize = 32 * 1024 * 1024;

const ENDPOINTS: [&str; 9] = [
    "tabs",
    "pages",
    "modules",
    "assignment_groups",
    "assignments",
    "discussions",
    "announcements",
    "files",
    "folders",
];
const COURSE_FIELDS: &[&str] = &["id", "name", "course_code", "syllabus_body", "term"];
const TAB_FIELDS: &[&str] = &["id", "label", "position", "visibility", "hidden"];
const PAGE_FIELDS: &[&str] = &["page_id", "title", "url", "updated_at", "body"];
const MODULE_FIELDS: &[&str] = &["id", "name", "items_count", "items"];
const MODULE_ITEM_FIELDS: &[&str] = &["id", "type", "title", "content_id", "html_url"];
const GROUP_FIELDS: &[&str] = &["id", "name", "group_weight"];
const ASSIGNMENT_FIELDS: &[&str] = &[
    "id",
    "name",
    "due_at",
    "points_possible",
    "assignment_group_id",
    "html_url",
    "submission_types",
    "submission",
];
const SUBMISSION_FIELDS: &[&str] = &[
    "workflow_state",
    "submitted_at",
    "graded_at",
    "grade",
    "score",
    "excused",
    "missing",
    "late",
];
const DISCUSSION_FIELDS: &[&str] = &[
    "id",
    "title",
    "discussion_type",
    "posted_at",
    "due_at",
    "html_url",
    "assignment_id",
    "is_announcement",
];
const ANNOUNCEMENT_FIELDS: &[&str] = &[
    "id",
    "title",
    "posted_at",
    "message",
    "html_url",
    "context_code",
];
const FILE_FIELDS: &[&str] = &[
    "id",
    "display_name",
    "filename",
    "size",
    "updated_at",
    "url",
];
const FOLDER_FIELDS: &[&str] = &[
    "id",
    "name",
    "parent_folder_id",
    "full_name",
    "files_count",
    "folders_count",
];

/// Course identity from stored coursework plus its prior per-course course.json.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CourseScope {
    pub key: String,
    pub folder: String,
    pub canvas_course_id: u64,
}

/// Content-free failure. Display text never includes Canvas content, URLs, IDs, or local paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureError {
    InvalidScope,
    TooManyCourses,
    CanvasRequest,
    InvalidCanvasResponse,
    ResponseLimit,
    Download,
    Reconcile,
    OutputLimit,
}

impl fmt::Display for CaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidScope => "Canvas capture scope is invalid",
            Self::TooManyCourses => "Canvas capture exceeds the course limit",
            Self::CanvasRequest => "Canvas capture request failed",
            Self::InvalidCanvasResponse => "Canvas returned an invalid capture response",
            Self::ResponseLimit => "Canvas capture exceeded a response limit",
            Self::Download => "Canvas material download failed",
            Self::Reconcile => "Canvas coursework reconciliation failed",
            Self::OutputLimit => "Canvas capture exceeded an output limit",
        })
    }
}
impl std::error::Error for CaptureError {}

/// Captures Canvas and returns sanitized relative-path bytes without writing to disk.
pub fn capture_all(
    api: &CanvasApi,
    downloads: &DownloadClient,
    base_coursework: &Value,
    prior: &RefreshPrior,
    course_scopes: &[CourseScope],
    progress: &mut dyn FnMut(RefreshProgress),
) -> Result<RefreshCapture, CaptureError> {
    if course_scopes.len() > MAX_COURSES {
        return Err(CaptureError::TooManyCourses);
    }
    for scope in course_scopes {
        validate_scope(scope)?;
    }

    let timestamp = timestamp(SystemTime::now());
    let mut count = 0u64;
    let mut bytes = 0usize;
    let mut documents = BTreeMap::new();
    let mut course_assignments = Vec::with_capacity(course_scopes.len());
    progress(RefreshProgress::new(
        RefreshPhase::Starting,
        0,
        Some(course_scopes.len() as u64),
        None,
    ));

    for (index, scope) in course_scopes.iter().enumerate() {
        let captured = capture_course(
            api,
            downloads,
            prior,
            scope,
            &timestamp,
            &mut documents,
            &mut bytes,
            progress,
            &mut count,
        )?;
        course_assignments.push(CourseAssignments {
            key: scope.key.clone(),
            groups: captured.groups,
            assignments: captured.assignments,
        });
        progress(RefreshProgress::new(
            RefreshPhase::Fetch,
            (index + 1) as u64,
            Some(course_scopes.len() as u64),
            Some(bytes as u64),
        ));
    }

    let conversations = capture_inbox(
        api,
        prior.conversations.as_ref(),
        progress,
        &mut count,
        bytes,
    )?;
    let source_complete = conversations.get("complete").and_then(Value::as_bool) == Some(true);
    put_json(
        &mut documents,
        "canvas-conversations.json",
        &conversations,
        &mut bytes,
    )?;
    capture_profile(
        api,
        downloads,
        &mut documents,
        &mut bytes,
        progress,
        &mut count,
    )?;
    // This single post-fetch instant is both the refresh finish time and the Canvas observation
    // time passed to reconciliation. It lets a fresh API due fact supersede a stale linked iCal
    // fact without inventing a timestamp during a no-op repeat capture.
    let captured_at = SystemTime::now();

    progress(RefreshProgress::new(
        RefreshPhase::Reconcile,
        0,
        Some(course_assignments.len() as u64),
        Some(bytes as u64),
    ));
    let coursework = reconcile_coursework(base_coursework, &course_assignments, captured_at)
        .map_err(|_| CaptureError::Reconcile)?;
    progress(RefreshProgress::new(
        RefreshPhase::Reconcile,
        course_assignments.len() as u64,
        Some(course_assignments.len() as u64),
        Some(bytes as u64),
    ));
    Ok(RefreshCapture {
        coursework,
        documents,
        captured_at,
        source_complete,
    })
}

struct CapturedCourse {
    groups: Vec<Value>,
    assignments: Vec<Value>,
}

fn capture_course(
    api: &CanvasApi,
    downloads: &DownloadClient,
    prior: &RefreshPrior,
    scope: &CourseScope,
    captured_at: &str,
    documents: &mut BTreeMap<String, Vec<u8>>,
    total_bytes: &mut usize,
    progress: &mut dyn FnMut(RefreshProgress),
    request_count: &mut u64,
) -> Result<CapturedCourse, CaptureError> {
    let id = scope.canvas_course_id;
    let mut requests = Map::new();

    before_request(progress, *request_count, *total_bytes);
    let response_result = api.get_json(&format!(
        "/api/v1/courses/{id}?include[]=syllabus_body&include[]=term"
    ));
    *request_count += 1;
    after_request(progress, *request_count, *total_bytes);
    let response = response_result.map_err(|_| CaptureError::CanvasRequest)?;
    ensure_success(&response)?;
    let course = project_object(&response.body, COURSE_FIELDS)?;
    if id_of(course.get("id")) != Some(id) {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    let source_url = course_url(&response.safe_url, id)?;
    requests.insert(
        "course".into(),
        Value::Array(vec![request_record(&response)?]),
    );

    let mut exports: BTreeMap<String, Value> = BTreeMap::new();
    exports.insert("course".to_owned(), Value::Object(course.clone()));
    let mut groups = Vec::new();
    let mut assignments = Vec::new();
    let mut raw_files = Vec::new();
    for endpoint in ENDPOINTS {
        let pages = get_pages_with_progress(
            api,
            &endpoint_path(id, endpoint),
            progress,
            request_count,
            *total_bytes,
        )?;
        if pages.len() > MAX_PAGES {
            return Err(CaptureError::ResponseLimit);
        }
        let mut records = Vec::new();
        let mut request_records = Vec::with_capacity(pages.len());
        for page in &pages {
            ensure_success(page)?;
            request_records.push(request_record(page)?);
            let rows = page
                .body
                .as_array()
                .ok_or(CaptureError::InvalidCanvasResponse)?;
            if records.len().saturating_add(rows.len()) > MAX_ITEMS {
                return Err(CaptureError::ResponseLimit);
            }
            for row in rows {
                if endpoint == "files" {
                    raw_files.push(row.clone());
                }
                let projected = project_endpoint(endpoint, row)?;
                if endpoint == "assignment_groups" {
                    groups.push(projected.clone());
                } else if endpoint == "assignments" {
                    assignments.push(projected.clone());
                }
                records.push(projected);
            }
        }
        requests.insert(endpoint.into(), Value::Array(request_records));
        exports.insert(endpoint.into(), Value::Array(records));
    }

    let files = exports
        .get("files")
        .and_then(Value::as_array)
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    if files.len() > MAX_FILES || raw_files.len() != files.len() {
        return Err(CaptureError::ResponseLimit);
    }
    let mut download_manifest = Vec::new();
    for (index, raw_file) in raw_files.iter().enumerate() {
        let file = files
            .get(index)
            .ok_or(CaptureError::InvalidCanvasResponse)?;
        let file_id = id_of(file.get("id")).ok_or(CaptureError::InvalidCanvasResponse)?;
        let file_name = file
            .get("display_name")
            .or_else(|| file.get("filename"))
            .and_then(Value::as_str)
            .map(|s| clean(s, 240))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("canvas-file-{file_id}"));
        let size64 = file
            .get("size")
            .and_then(Value::as_u64)
            .ok_or(CaptureError::InvalidCanvasResponse)?;
        let size = usize::try_from(size64).map_err(|_| CaptureError::ResponseLimit)?;
        if size > MAX_FILE_BYTES {
            return Err(CaptureError::ResponseLimit);
        }
        let updated_at = file.get("updated_at").cloned().unwrap_or(Value::Null);
        let url = raw_file_download_url(raw_file).ok_or(CaptureError::InvalidCanvasResponse)?;
        if let Some((filename, material)) =
            reusable(prior, scope, file_id, &file_name, size, &updated_at)?
        {
            if total_bytes.saturating_add(material.len()) > MAX_TOTAL_BYTES {
                return Err(CaptureError::OutputLimit);
            }
            *total_bytes += material.len();
            documents.insert(format!("{}/materials/{filename}", scope.folder), material);
            download_manifest.push(json!({
                "id":file_id,"name":file_name,"filename":filename,"size":size,
                "updated_at":updated_at,"status":"reused"
            }));
            continue;
        }

        before_request(progress, *request_count, *total_bytes);
        let result = downloads.download_file(url);
        *request_count += 1;
        after_request(progress, *request_count, *total_bytes);
        let body = result.map_err(|_| CaptureError::Download)?;
        if body.status != 200 {
            return Err(CaptureError::Download);
        }
        if body.bytes.len() > MAX_FILE_BYTES
            || total_bytes.saturating_add(body.bytes.len()) > MAX_TOTAL_BYTES
            || body.bytes.len() != size
        {
            return Err(CaptureError::ResponseLimit);
        }
        let reported_name = disposition_name(body.content_disposition.as_deref())
            .or_else(|| {
                file.get("filename")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| file_name.clone());
        let filename = material_name(file_id, &reported_name)?;
        *total_bytes += body.bytes.len();
        documents.insert(format!("{}/materials/{filename}", scope.folder), body.bytes);
        download_manifest.push(json!({
            "id":file_id,"name":file_name,"filename":filename,"size":size,
            "updated_at":updated_at,"status":"downloaded"
        }));
    }

    let export_dir = format!("{}/canvas-export", scope.folder);
    for endpoint in [
        "course",
        "tabs",
        "pages",
        "modules",
        "assignment_groups",
        "assignments",
        "discussions",
        "announcements",
        "files",
        "folders",
    ] {
        put_json(
            documents,
            &format!("{export_dir}/api/{endpoint}.json"),
            exports
                .get(endpoint)
                .ok_or(CaptureError::InvalidCanvasResponse)?,
            total_bytes,
        )?;
    }
    put_json(
        documents,
        &format!("{export_dir}/download-manifest.json"),
        &Value::Array(download_manifest.clone()),
        total_bytes,
    )?;
    put_json(
        documents,
        &format!("{export_dir}/request-manifest.json"),
        &Value::Object(requests),
        total_bytes,
    )?;
    let mut inventory = Map::new();
    inventory.insert("capturedAt".into(), Value::from(captured_at));
    for endpoint in [
        "course",
        "tabs",
        "pages",
        "modules",
        "assignment_groups",
        "assignments",
        "discussions",
        "announcements",
        "files",
        "folders",
    ] {
        inventory.insert(
            endpoint.into(),
            exports
                .get(endpoint)
                .cloned()
                .ok_or(CaptureError::InvalidCanvasResponse)?,
        );
    }
    put_json(
        documents,
        &format!("{export_dir}/course-inventory.json"),
        &Value::Object(inventory),
        total_bytes,
    )?;
    let report = report(
        &course,
        &source_url,
        captured_at,
        &exports,
        &download_manifest,
    );
    put_text(
        documents,
        &format!("{}/canvas-course-report.md", scope.folder),
        report.as_bytes(),
        total_bytes,
    )?;

    Ok(CapturedCourse {
        groups,
        assignments,
    })
}

fn endpoint_path(course_id: u64, endpoint: &str) -> String {
    match endpoint {
        "announcements" => format!("/api/v1/announcements?context_codes[]=course_{course_id}&per_page=100"),
        "pages" => format!("/api/v1/courses/{course_id}/pages?include[]=body&per_page=100"),
        "modules" => format!("/api/v1/courses/{course_id}/modules?include[]=items&include[]=content_details&per_page=100"),
        "assignments" => format!("/api/v1/courses/{course_id}/assignments?include[]=submission&per_page=100"),
        "tabs" => format!("/api/v1/courses/{course_id}/tabs?per_page=100"),
        "assignment_groups" => format!("/api/v1/courses/{course_id}/assignment_groups?per_page=100"),
        "discussions" => format!("/api/v1/courses/{course_id}/discussion_topics?per_page=100"),
        "files" => format!("/api/v1/courses/{course_id}/files?per_page=100"),
        "folders" => format!("/api/v1/courses/{course_id}/folders?per_page=100"),
        _ => String::new(),
    }
}

fn project_endpoint(endpoint: &str, value: &Value) -> Result<Value, CaptureError> {
    let fields = match endpoint {
        "tabs" => TAB_FIELDS,
        "pages" => PAGE_FIELDS,
        "modules" => MODULE_FIELDS,
        "assignment_groups" => GROUP_FIELDS,
        "assignments" => ASSIGNMENT_FIELDS,
        "discussions" => DISCUSSION_FIELDS,
        "announcements" => ANNOUNCEMENT_FIELDS,
        "files" => FILE_FIELDS,
        "folders" => FOLDER_FIELDS,
        _ => return Err(CaptureError::InvalidCanvasResponse),
    };
    let mut projected = project_object(value, fields)?;
    if endpoint == "modules" {
        if let Some(items) = value.get("items").and_then(Value::as_array) {
            let items = items
                .iter()
                .map(|item| project_object(item, MODULE_ITEM_FIELDS).map(Value::Object))
                .collect::<Result<Vec<_>, _>>()?;
            projected.insert("items".into(), Value::Array(items));
        }
    } else if endpoint == "assignments" {
        if let Some(submission) = value.get("submission") {
            projected.insert(
                "submission".into(),
                if submission.is_null() {
                    Value::Null
                } else {
                    Value::Object(project_object(submission, SUBMISSION_FIELDS)?)
                },
            );
        }
    }
    Ok(Value::Object(projected))
}

/// Returns the in-memory-only URL Canvas supplied for a file download.
///
/// The caller must never persist this value: signed verifier query parameters are required for
/// the unauthenticated download, but the projected export stores only a query-stripped URL.
fn raw_file_download_url(value: &Value) -> Option<&str> {
    value
        .get("url")
        .or_else(|| value.get("download_url"))
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
}

fn project_object(value: &Value, fields: &[&str]) -> Result<Map<String, Value>, CaptureError> {
    let object = value
        .as_object()
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    let mut projected = Map::new();
    for key in fields {
        if let Some(value) = object.get(*key) {
            projected.insert((*key).into(), sanitize_value(value, key));
        }
    }
    if fields == COURSE_FIELDS {
        if let Some(term) = object.get("term") {
            projected.insert(
                "term".into(),
                if term.is_null() {
                    Value::Null
                } else {
                    Value::Object(project_object(term, &["id", "name"])?)
                },
            );
        }
    }
    Ok(projected)
}

fn sanitize_value(value: &Value, field: &str) -> Value {
    match value {
        Value::String(text) => {
            let safe = redact(text);
            if field.ends_with("_url") || field == "url" || field == "avatar" {
                Value::from(strip_query(&safe))
            } else {
                Value::from(safe)
            }
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(|v| sanitize_value(v, field)).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), sanitize_value(value, key)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn request_record(response: &ApiResponse) -> Result<Value, CaptureError> {
    let url = strip_query(&response.safe_url);
    if !allowed_canvas_url(&url) {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    Ok(json!({ "url": url, "status": response.status }))
}

fn allowed_canvas_url(url: &str) -> bool {
    if let Some(authority) = url
        .strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
    {
        return !authority.is_empty() && !authority.contains('@');
    }
    #[cfg(feature = "test-overrides")]
    if let Some(authority) = url
        .strip_prefix("http://")
        .and_then(|rest| rest.split('/').next())
    {
        return authority
            .parse::<std::net::SocketAddr>()
            .is_ok_and(|address| address.ip().is_loopback() && address.port() != 0);
    }
    false
}

fn course_url(api_url: &str, id: u64) -> Result<String, CaptureError> {
    let clean = strip_query(api_url);
    let (origin, _) = clean
        .split_once("/api/v1/")
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    if !allowed_canvas_url(origin) {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    Ok(format!("{origin}/courses/{id}"))
}

fn ensure_success(response: &ApiResponse) -> Result<(), CaptureError> {
    if (200..300).contains(&response.status) {
        Ok(())
    } else {
        Err(CaptureError::CanvasRequest)
    }
}

fn id_of(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    let id = value.as_u64().or_else(|| value.as_str()?.parse().ok())?;
    (id > 0).then_some(id)
}

fn validate_scope(scope: &CourseScope) -> Result<(), CaptureError> {
    if scope.canvas_course_id == 0
        || !safe_component(&scope.key)
        || !scope.folder.starts_with("classes/")
        || scope.folder.len() > 512
    {
        return Err(CaptureError::InvalidScope);
    }
    let parts: Vec<&str> = scope.folder.split('/').collect();
    if parts.len() < 2
        || parts[0] != "classes"
        || parts[1..].iter().any(|part| !safe_component(part))
        || parts.last().copied() != Some(scope.key.as_str())
    {
        return Err(CaptureError::InvalidScope);
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

fn strip_query(value: &str) -> String {
    value[..value.find(['?', '#']).unwrap_or(value.len())].to_string()
}

fn redact(input: &str) -> String {
    const KEYS: [&str; 8] = [
        "access_token",
        "access-token",
        "authorization",
        "bearer",
        "token",
        "password",
        "secret",
        "auth",
    ];
    let lower = input.to_ascii_lowercase();
    let mut cursor = 0usize;
    let mut output = String::with_capacity(input.len());
    while cursor < input.len() {
        let mut matched_end = None;
        for key in KEYS {
            if lower[cursor..].starts_with(key) {
                let end = cursor + key.len();
                let before_ok = cursor == 0
                    || (!lower.as_bytes()[cursor - 1].is_ascii_alphanumeric()
                        && lower.as_bytes()[cursor - 1] != b'_');
                let after_ok = end == lower.len()
                    || (!lower.as_bytes()[end].is_ascii_alphanumeric()
                        && lower.as_bytes()[end] != b'_');
                if before_ok && after_ok {
                    matched_end = Some(end);
                    break;
                }
            }
        }
        let Some(key_end) = matched_end else {
            let ch = input[cursor..].chars().next().expect("valid cursor");
            output.push(ch);
            cursor += ch.len_utf8();
            continue;
        };
        output.push_str(&input[cursor..key_end]);
        let mut start = key_end;
        while start < input.len() && input.as_bytes()[start].is_ascii_whitespace() {
            start += 1;
        }
        if start >= input.len() || !matches!(input.as_bytes()[start], b'=' | b':') {
            cursor = key_end;
            continue;
        }
        output.push('=');
        start += 1;
        while start < input.len() && input.as_bytes()[start].is_ascii_whitespace() {
            start += 1;
        }
        output.push_str("[redacted]");
        cursor = start;
        while cursor < input.len() {
            let ch = input[cursor..].chars().next().expect("valid cursor");
            if ch.is_whitespace() || matches!(ch, ',' | ';' | '&' | '#' | '<' | '>') {
                break;
            }
            cursor += ch.len_utf8();
        }
    }
    output
}

fn reusable(
    prior: &RefreshPrior,
    scope: &CourseScope,
    file_id: u64,
    name: &str,
    size: usize,
    updated_at: &Value,
) -> Result<Option<(String, Vec<u8>)>, CaptureError> {
    let folder = scope
        .folder
        .strip_prefix("classes/")
        .ok_or(CaptureError::InvalidScope)?;
    let Some(manifest) = prior.download_manifest_for(folder) else {
        return Ok(None);
    };
    let Some(entries) = manifest.as_array() else {
        return Ok(None);
    };
    for entry in entries {
        if id_of(entry.get("id")) != Some(file_id)
            || entry.get("name").and_then(Value::as_str) != Some(name)
            || entry.get("size").and_then(Value::as_u64) != Some(size as u64)
            || entry.get("updated_at").unwrap_or(&Value::Null) != updated_at
            || !matches!(
                entry.get("status").and_then(Value::as_str),
                Some("downloaded" | "reused")
            )
        {
            continue;
        }
        let Some(filename) = entry.get("filename").and_then(Value::as_str) else {
            continue;
        };
        if !filename.starts_with(&format!("{file_id}-")) || !safe_filename(filename) {
            continue;
        }
        if prior.material_size_for(folder, filename) != Some(size as u64) {
            continue;
        }
        let bytes = prior
            .read_material_bytes(folder, filename)
            .map_err(|_| CaptureError::Download)?;
        let Some(bytes) = bytes else { continue };
        if bytes.len() == size {
            return Ok(Some((filename.to_owned(), bytes)));
        }
    }
    Ok(None)
}

fn safe_filename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

fn material_name(id: u64, source: &str) -> Result<String, CaptureError> {
    let name = source.rsplit(['/', '\\']).next().unwrap_or(source).trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(':')
        || name.chars().any(char::is_control)
    {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    let prefix = format!("{id}-");
    let name: String = name
        .chars()
        .take(240usize.saturating_sub(prefix.len()))
        .collect();
    let name = name.trim();
    if name.is_empty() {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    Ok(format!("{prefix}{name}"))
}

fn disposition_name(value: Option<&str>) -> Option<String> {
    for part in value?.split(';').skip(1) {
        let Some((key, raw)) = part.trim().split_once('=') else {
            continue;
        };
        if key.eq_ignore_ascii_case("filename*") {
            let raw = raw.trim().trim_matches('"');
            let value = raw.split_once("''").map(|(_, tail)| tail).unwrap_or(raw);
            if let Some(decoded) = percent_decode(value) {
                return Some(decoded);
            }
        } else if key.eq_ignore_ascii_case("filename") {
            return Some(raw.trim().trim_matches('"').replace("\\\"", "\""));
        }
    }
    None
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            output.push(digit(*bytes.get(index + 1)?)? * 16 + digit(*bytes.get(index + 2)?)?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn report(
    course: &Map<String, Value>,
    source: &str,
    captured_at: &str,
    exports: &BTreeMap<String, Value>,
    manifest: &[Value],
) -> String {
    let name = course
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Canvas course");
    let name = name
        .replace('|', "\\|")
        .replace('\n', " ")
        .replace('\r', " ");
    let count = |key: &str| {
        exports
            .get(key)
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    let available = manifest
        .iter()
        .filter(|v| {
            matches!(
                v.get("status").and_then(Value::as_str),
                Some("downloaded" | "reused")
            )
        })
        .count();
    let downloaded = manifest
        .iter()
        .filter(|v| v.get("status").and_then(Value::as_str) == Some("downloaded"))
        .count();
    let reused = manifest
        .iter()
        .filter(|v| v.get("status").and_then(Value::as_str) == Some("reused"))
        .count();
    format!(
        "# {name}\n\nCaptured: {captured_at}\nSource: {source}\n\n## Inventory\n\n- Pages: {}\n- Modules: {}\n- Assignment groups: {}\n- Assignments: {}\n- Discussions: {}\n- Announcements: {}\n- Course files: {}\n- Material files available: {available}/{}\n- Downloaded this refresh: {downloaded}\n- Reused unchanged files: {reused}\n",
        count("pages"), count("modules"), count("assignment_groups"), count("assignments"),
        count("discussions"), count("announcements"), count("files"), count("files")
    )
}

fn capture_inbox(
    api: &CanvasApi,
    previous: Option<&Value>,
    progress: &mut dyn FnMut(RefreshProgress),
    count: &mut u64,
    bytes_done: usize,
) -> Result<Value, CaptureError> {
    let pages = get_pages_with_progress(
        api,
        "/api/v1/conversations?scope=inbox&per_page=100",
        progress,
        count,
        bytes_done,
    )?;
    if pages.len() > MAX_INBOX_PAGES {
        return Err(CaptureError::ResponseLimit);
    }
    let mut summaries = Vec::new();
    for page in pages {
        ensure_success(&page)?;
        let rows = page
            .body
            .as_array()
            .ok_or(CaptureError::InvalidCanvasResponse)?;
        if summaries.len().saturating_add(rows.len()) > MAX_CONVERSATIONS {
            return Err(CaptureError::ResponseLimit);
        }
        summaries.extend(rows.iter().cloned());
    }

    capture_inbox_from_summaries(summaries, previous, |id| {
        before_request(progress, *count, bytes_done);
        let result = api.get_json(&format!(
            "/api/v1/conversations/{id}?auto_mark_as_read=false"
        ));
        *count += 1;
        after_request(progress, *count, bytes_done);
        let response = result.map_err(|_| CaptureError::CanvasRequest)?;
        ensure_success(&response)?;
        Ok(response.body)
    })
}

fn capture_inbox_from_summaries(
    summaries: Vec<Value>,
    previous: Option<&Value>,
    mut fetch_detail: impl FnMut(&str) -> Result<Value, CaptureError>,
) -> Result<Value, CaptureError> {
    let previous_items = previous
        .and_then(|v| v.get("conversations"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_stored_conversation)
                .take(MAX_CONVERSATIONS)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let prior_by_id: BTreeMap<String, &Value> = previous_items
        .iter()
        .filter_map(|item| string_conversation_id(item).map(|id| (id, item)))
        .collect();

    let mut current = Vec::new();
    let mut body_bytes = 0usize;
    let mut rejected = 0usize;
    let mut seen_ids = BTreeSet::new();
    for summary in summaries {
        let id = conversation_id(summary.get("id")).ok_or(CaptureError::InvalidCanvasResponse)?;
        if !seen_ids.insert(id.clone()) {
            return Err(CaptureError::InvalidCanvasResponse);
        }
        let detail = fetch_detail(&id)
            .ok()
            .and_then(|body| normalize_conversation(&body));
        let detail = detail.filter(|conversation| {
            let next_bytes = conversation_body_bytes(conversation);
            if body_bytes.saturating_add(next_bytes) > MAX_INBOX_BYTES {
                false
            } else {
                body_bytes += next_bytes;
                true
            }
        });
        let conversation = match detail {
            Some(conversation) => conversation,
            None => {
                rejected += 1;
                incomplete_conversation(&summary, prior_by_id.get(&id).copied())
                    .ok_or(CaptureError::InvalidCanvasResponse)?
            }
        };
        current.push(conversation);
    }
    if rejected > 0 {
        let current_ids: BTreeSet<String> =
            current.iter().filter_map(string_conversation_id).collect();
        for prior in &previous_items {
            let Some(id) = string_conversation_id(prior) else {
                continue;
            };
            if !current_ids.contains(&id) {
                let mut preserved = prior.clone();
                if let Some(fields) = preserved.as_object_mut() {
                    fields.insert("historyComplete".into(), Value::Bool(false));
                    fields.insert("detailCaptureIncomplete".into(), Value::Bool(true));
                }
                current.push(preserved);
            }
        }
    }
    current.sort_by(latest_first);

    let current_by_id: BTreeMap<String, &Value> = current
        .iter()
        .filter_map(|v| string_conversation_id(v).map(|id| (id, v)))
        .collect();
    let old_by_id: BTreeMap<String, &Value> = previous_items
        .iter()
        .filter_map(|v| string_conversation_id(v).map(|id| (id, v)))
        .collect();

    let mut added = Vec::new();
    let mut changed = Vec::new();
    for (id, value) in &current_by_id {
        match old_by_id.get(id) {
            None => added.push(Value::from(id.clone())),
            Some(old) if *old != *value => changed.push(Value::from(id.clone())),
            Some(_) => {}
        }
    }
    let removed: Vec<Value> = if rejected == 0 {
        old_by_id
            .keys()
            .filter(|id| !current_by_id.contains_key(*id))
            .map(|id| Value::from(id.clone()))
            .collect()
    } else {
        Vec::new()
    };

    Ok(json!({
        "schema": 1,
        "generatedAt": timestamp(SystemTime::now()),
        "complete": rejected == 0,
        "rejected": rejected,
        "conversations": current,
        "changes": { "added": added, "changed": changed, "removed": removed }
    }))
}

fn conversation_body_bytes(conversation: &Value) -> usize {
    conversation
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| message.get("body").and_then(Value::as_str))
        .map(str::len)
        .sum()
}

fn incomplete_conversation(summary: &Value, prior: Option<&Value>) -> Option<Value> {
    let id = conversation_id(summary.get("id"))?;
    let preserved = prior.cloned().unwrap_or(Value::Null);
    let subject = summary
        .get("subject")
        .and_then(Value::as_str)
        .map(|value| redact(&clean(value, 240)))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            preserved
                .get("subject")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "(No subject)".into());
    let context = summary
        .get("context_name")
        .and_then(Value::as_str)
        .map(|value| redact(&clean(value, 160)))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            preserved
                .get("contextLabel")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let state = summary
        .get("workflow_state")
        .and_then(Value::as_str)
        .filter(|state| matches!(*state, "read" | "unread" | "archived"));
    let unread = state
        .map(|state| state == "unread")
        .or_else(|| preserved.get("unread").and_then(Value::as_bool))
        .unwrap_or(false);
    let (preview, preview_truncated) = summary
        .get("last_message")
        .and_then(Value::as_str)
        .map(clean_message)
        .filter(|(value, _)| !value.is_empty())
        .or_else(|| {
            preserved
                .get("latestMessagePreview")
                .and_then(Value::as_str)
                .map(|value| (value.to_owned(), false))
        })
        .unwrap_or((String::new(), false));
    let latest_at = normalize_time(summary.get("last_message_at").and_then(Value::as_str));
    let participants = preserved
        .get("participants")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let messages = preserved
        .get("messages")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let attachments = preserved
        .get("attachments")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let reported_message_count = summary
        .get("message_count")
        .and_then(Value::as_u64)
        .or_else(|| preserved.get("messageCount").and_then(Value::as_u64))
        .unwrap_or(messages.as_array().map_or(0, |items| items.len() as u64));
    const MAX_REPORTED_MESSAGE_COUNT: u64 = 100_000;
    let message_count = reported_message_count.min(MAX_REPORTED_MESSAGE_COUNT);
    let safety_truncated = preview_truncated
        || reported_message_count > MAX_REPORTED_MESSAGE_COUNT
        || preserved.get("safetyTruncated").and_then(Value::as_bool) == Some(true);
    Some(json!({
        "canvasConversationId":id,
        "contextLabel":context,
        "subject":subject,
        "participants":participants,
        "latestMessagePreview":if preview.is_empty() { Value::Null } else { Value::from(preview.chars().take(280).collect::<String>()) },
        "latestMessageAt":latest_at.or_else(|| preserved.get("latestMessageAt").cloned().and_then(|value| value.as_str().map(str::to_owned))),
        "unread":unread,
        "starred":summary.get("starred").and_then(Value::as_bool).or_else(|| preserved.get("starred").and_then(Value::as_bool)).unwrap_or(false),
        "messageCount":message_count,
        "messages":messages,
        "historyComplete":false,
        "safetyTruncated":safety_truncated,
        "detailCaptureIncomplete":true,
        "attachments":attachments
    }))
}

fn latest_first(left: &Value, right: &Value) -> std::cmp::Ordering {
    right
        .get("latestMessageAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .cmp(
            left.get("latestMessageAt")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
}

fn string_conversation_id(value: &Value) -> Option<String> {
    value
        .get("canvasConversationId")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn conversation_id(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let text = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => return None,
    };
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(text)
}

fn normalize_stored_conversation(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut raw = Map::new();
    raw.insert("id".into(), object.get("canvasConversationId")?.clone());
    raw.insert(
        "context_name".into(),
        object.get("contextLabel").cloned().unwrap_or(Value::Null),
    );
    raw.insert(
        "subject".into(),
        object.get("subject").cloned().unwrap_or(Value::Null),
    );
    raw.insert(
        "last_message".into(),
        object
            .get("latestMessagePreview")
            .cloned()
            .unwrap_or(Value::Null),
    );
    raw.insert(
        "last_message_at".into(),
        object
            .get("latestMessageAt")
            .cloned()
            .unwrap_or(Value::Null),
    );
    raw.insert(
        "workflow_state".into(),
        Value::from(
            if object.get("unread").and_then(Value::as_bool) == Some(true) {
                "unread"
            } else {
                "read"
            },
        ),
    );
    raw.insert(
        "starred".into(),
        object.get("starred").cloned().unwrap_or(Value::Bool(false)),
    );
    raw.insert(
        "message_count".into(),
        object
            .get("messageCount")
            .cloned()
            .unwrap_or(Value::from(0)),
    );
    let participants = object
        .get("participants")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(json!({
                        "id": item.get("canvasUserId")?, "name": item.get("name")?
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    raw.insert("participants".into(), Value::Array(participants));
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().map(|item| json!({
            "id": item.get("canvasMessageId").cloned().unwrap_or(Value::Null),
            "author_id": item.get("authorId").cloned().unwrap_or(Value::Null),
            "author_name": item.get("author").cloned().unwrap_or(Value::Null),
            "created_at": item.get("createdAt").cloned().unwrap_or(Value::Null),
            "body": item.get("body").cloned().unwrap_or(Value::Null),
            "attachments": item.get("attachments").and_then(Value::as_array).map(|entries| {
                entries.iter().map(|entry| json!({
                    "display_name": entry.get("name").cloned().unwrap_or(Value::Null),
                    "content-type": entry.get("contentType").cloned().unwrap_or(Value::Null),
                    "size": entry.get("sizeBytes").cloned().unwrap_or(Value::Null)
                })).collect::<Vec<_>>()
            }).unwrap_or_default()
        })).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    raw.insert("messages".into(), Value::Array(messages));
    let mut normalized = normalize_conversation_inner(&Value::Object(raw), false)?;
    let was_incomplete = object.get("historyComplete").and_then(Value::as_bool) == Some(false)
        || object
            .get("detailCaptureIncomplete")
            .and_then(Value::as_bool)
            == Some(true);
    if was_incomplete {
        let fields = normalized.as_object_mut()?;
        fields.insert("historyComplete".into(), Value::Bool(false));
        fields.insert("detailCaptureIncomplete".into(), Value::Bool(true));
        if object.get("safetyTruncated").and_then(Value::as_bool) == Some(true) {
            fields.insert("safetyTruncated".into(), Value::Bool(true));
        }
    }
    Some(normalized)
}

fn normalize_conversation(value: &Value) -> Option<Value> {
    normalize_conversation_inner(value, true)
}

fn normalize_conversation_inner(value: &Value, require_complete: bool) -> Option<Value> {
    let object = value.as_object()?;
    let id = conversation_id(object.get("id"))?;
    let subject = object
        .get("subject")
        .and_then(Value::as_str)
        .map(|s| clean(s, 240))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(No subject)".into());
    let context = object
        .get("context_name")
        .and_then(Value::as_str)
        .map(|s| clean(s, 160))
        .filter(|s| !s.is_empty());
    let state = object
        .get("workflow_state")
        .and_then(Value::as_str)
        .unwrap_or("read");
    if !matches!(state, "read" | "unread" | "archived") {
        return None;
    }
    let starred = object
        .get("starred")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let raw_messages = object.get("messages").and_then(Value::as_array);
    let message_count = object
        .get("message_count")
        .and_then(Value::as_u64)
        .or_else(|| raw_messages.map(|items| items.len() as u64))
        .unwrap_or(0);
    if message_count > 100_000 {
        return None;
    }

    let raw_participants = object.get("participants").and_then(Value::as_array);
    if raw_participants.is_some_and(|items| items.len() > 100) {
        return None;
    }
    let mut participants = Vec::new();
    let mut seen = BTreeSet::new();
    for raw in raw_participants.into_iter().flatten() {
        let participant = raw.as_object()?;
        let id = text_id(
            participant
                .get("id")
                .or_else(|| participant.get("canvasUserId")),
            128,
        )?;
        let name = participant
            .get("name")
            .or_else(|| participant.get("display_name"))
            .and_then(Value::as_str)
            .map(|s| clean(s, 120))?;
        if name.is_empty() {
            return None;
        }
        if seen.insert(id.clone()) {
            participants.push(json!({"canvasUserId":id,"name":name}));
        }
    }

    let mut messages = Vec::new();
    let mut all_attachments = Vec::new();
    let too_many_messages = raw_messages.is_some_and(|items| items.len() > MAX_MESSAGES);
    let mut safety_truncated = too_many_messages;
    for raw in raw_messages.into_iter().flatten().take(MAX_MESSAGES) {
        let message = raw.as_object()?;
        let input_body = message
            .get("body")
            .or_else(|| message.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let (body, body_truncated) = clean_message(input_body);
        safety_truncated |= body_truncated;
        let raw_attachments = message.get("attachments").and_then(Value::as_array);
        if raw_attachments.is_some_and(|items| items.len() > MAX_ATTACHMENTS) {
            return None;
        }
        let mut attachments = Vec::new();
        for raw_attachment in raw_attachments.into_iter().flatten() {
            let attachment = raw_attachment.as_object()?;
            let name = attachment
                .get("display_name")
                .or_else(|| attachment.get("filename"))
                .or_else(|| attachment.get("name"))
                .and_then(Value::as_str)
                .map(|s| clean(s, 240))?;
            if name.is_empty() {
                return None;
            }
            let content_type = attachment
                .get("content-type")
                .or_else(|| attachment.get("content_type"))
                .and_then(Value::as_str)
                .map(|s| clean(s, 120));
            let size = attachment.get("size").and_then(Value::as_u64);
            let projected = json!({"name":name,"contentType":content_type,"sizeBytes":size});
            attachments.push(projected.clone());
            all_attachments.push(projected);
        }
        let author = message
            .get("author_name")
            .or_else(|| message.get("sender_name"))
            .or_else(|| message.get("author").and_then(|v| v.get("name")))
            .and_then(Value::as_str)
            .map(|s| clean(s, 120))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Canvas participant".into());
        let author_id = text_id(
            message
                .get("author_id")
                .or_else(|| message.get("sender_id"))
                .or_else(|| message.get("author").and_then(|v| v.get("id"))),
            128,
        );
        let created_at = normalize_time(
            message
                .get("created_at")
                .or_else(|| message.get("createdAt"))
                .and_then(Value::as_str),
        );
        let message_id = text_id(
            message.get("id").or_else(|| message.get("canvasMessageId")),
            128,
        );
        messages.push(json!({
            "canvasMessageId":message_id,"authorId":author_id,"author":author,
            "createdAt":created_at,"body":body,"bodyTruncated":body_truncated,
            "attachments":attachments
        }));
    }
    let body_total: usize = messages
        .iter()
        .filter_map(|v| v.get("body").and_then(Value::as_str))
        .map(str::len)
        .sum();
    if body_total > MAX_INBOX_BYTES {
        return None;
    }

    let latest_at = messages
        .iter()
        .filter_map(|v| v.get("createdAt").and_then(Value::as_str))
        .max()
        .map(str::to_owned)
        .or_else(|| {
            normalize_time(
                object
                    .get("last_message_at")
                    .or_else(|| object.get("latestMessageAt"))
                    .and_then(Value::as_str),
            )
        });
    let preview = object
        .get("last_message")
        .or_else(|| object.get("lastMessage"))
        .and_then(Value::as_str)
        .map(|s| clean_message(s).0)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            messages.iter().find_map(|v| {
                v.get("body")
                    .and_then(Value::as_str)
                    .map(|s| s.chars().take(280).collect())
            })
        });
    if messages.is_empty() {
        if let Some(preview) = &preview {
            messages.push(json!({
                "canvasMessageId":Value::Null,"authorId":Value::Null,"author":"Canvas participant",
                "createdAt":latest_at,"body":preview,"bodyTruncated":false,"attachments":[]
            }));
        }
    }
    let history_complete = raw_messages.is_some()
        && !too_many_messages
        && !safety_truncated
        && message_count <= messages.len() as u64;
    if require_complete && !history_complete {
        return None;
    }
    Some(json!({
        "canvasConversationId":id,"contextLabel":context,"subject":subject,
        "participants":participants,
        "latestMessagePreview":preview.map(|s|s.chars().take(280).collect::<String>()),
        "latestMessageAt":latest_at,"unread":state=="unread","starred":starred,
        "messageCount":message_count,"messages":messages,"historyComplete":history_complete,
        "safetyTruncated":safety_truncated,"attachments":all_attachments
    }))
}

fn text_id(value: Option<&Value>, max: usize) -> Option<String> {
    let text = match value? {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() || text.len() > max {
        None
    } else {
        Some(text.into())
    }
}

fn clean_message(input: &str) -> (String, bool) {
    let stripped = strip_active(input);
    let stripped = strip_tags(&stripped);
    let decoded = stripped
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    let normalized = whitespace(&redact(&decoded));
    if normalized.len() <= MAX_MESSAGE_BYTES {
        return (normalized, false);
    }
    let mut end = MAX_MESSAGE_BYTES - 3;
    while !normalized.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &normalized[..end]), true)
}

fn strip_active(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    while cursor < input.len() {
        let script = lower[cursor..].find("<script");
        let style = lower[cursor..].find("<style");
        let next = match (script, style) {
            (Some(a), Some(b)) => Some((a.min(b), if a <= b { "script" } else { "style" })),
            (Some(a), None) => Some((a, "script")),
            (None, Some(b)) => Some((b, "style")),
            _ => None,
        };
        let Some((offset, tag)) = next else {
            out.push_str(&input[cursor..]);
            break;
        };
        let start = cursor + offset;
        out.push_str(&input[cursor..start]);
        let end_tag = format!("</{tag}");
        let Some(close) = lower[start..].find(&end_tag) else {
            break;
        };
        let Some(end) = lower[start + close..]
            .find('>')
            .map(|n| start + close + n + 1)
        else {
            break;
        };
        cursor = end;
    }
    out
}

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut inside = false;
    for ch in input.chars() {
        match ch {
            '<' => inside = true,
            '>' if inside => inside = false,
            _ if !inside => out.push(ch),
            _ => {}
        }
    }
    out
}

fn whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut space = false;
    let mut newlines = 0;
    for ch in input.chars() {
        if ch == '\r' || ch == '\n' {
            if !out.is_empty() && newlines < 2 {
                out.push('\n');
            }
            newlines += 1;
            space = false;
        } else if ch.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
            newlines = 0;
        } else if !ch.is_control() {
            out.push(ch);
            space = false;
            newlines = 0;
        }
    }
    out.trim().into()
}

fn clean(input: &str, max: usize) -> String {
    input
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn capture_profile(
    api: &CanvasApi,
    downloads: &DownloadClient,
    docs: &mut BTreeMap<String, Vec<u8>>,
    total: &mut usize,
    progress: &mut dyn FnMut(RefreshProgress),
    count: &mut u64,
) -> Result<(), CaptureError> {
    before_request(progress, *count, *total);
    let result = api.get_json("/api/v1/users/self/profile");
    *count += 1;
    after_request(progress, *count, *total);
    let response = result.map_err(|_| CaptureError::CanvasRequest)?;
    ensure_success(&response)?;
    let profile = response
        .body
        .as_object()
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    let name = profile
        .get("name")
        .and_then(Value::as_str)
        .map(|s| redact(&clean(s, 200)));
    let short_name = profile
        .get("short_name")
        .and_then(Value::as_str)
        .map(|s| redact(&clean(s, 120)));
    let avatar_url = profile
        .get("avatar_url")
        .or_else(|| profile.get("avatar"))
        .and_then(Value::as_str);

    let avatar = if let Some(url) = avatar_url.filter(|s| !s.is_empty()) {
        before_request(progress, *count, *total);
        let result = downloads.download_avatar(url);
        *count += 1;
        after_request(progress, *count, *total);
        let body = result.map_err(|_| CaptureError::Download)?;
        let content_type =
            image_type(body.content_type.as_deref()).ok_or(CaptureError::InvalidCanvasResponse)?;
        if body.status != 200
            || body.bytes.is_empty()
            || body.bytes.len() > MAX_AVATAR_BYTES
            || !image_signature(&body.bytes, content_type)
        {
            return Err(CaptureError::InvalidCanvasResponse);
        }
        let size = body.bytes.len();
        put_document(docs, "canvas-profile-avatar", body.bytes, total)?;
        json!({"path":"canvas-profile-avatar","contentType":content_type,"bytes":size})
    } else {
        Value::Null
    };
    put_json(
        docs,
        "canvas-profile.json",
        &json!({"name":name,"short_name":short_name,"avatar":avatar}),
        total,
    )?;
    Ok(())
}

fn image_type(value: Option<&str>) -> Option<&'static str> {
    match value?
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/jpeg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        _ => None,
    }
}

fn image_signature(bytes: &[u8], content_type: &str) -> bool {
    match content_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn before_request(progress: &mut dyn FnMut(RefreshProgress), count: u64, bytes: usize) {
    progress(RefreshProgress::new(
        RefreshPhase::Fetch,
        count,
        None,
        Some(bytes as u64),
    ));
}

fn get_pages_with_progress(
    api: &CanvasApi,
    path: &str,
    progress: &mut dyn FnMut(RefreshProgress),
    count: &mut u64,
    bytes: usize,
) -> Result<Vec<ApiResponse>, CaptureError> {
    let mut seen_pages = 0u64;
    let result = api.get_pages_with_progress(path, &mut |completed_pages| {
        if completed_pages == 0 {
            before_request(progress, *count, bytes);
        } else {
            while seen_pages < completed_pages {
                seen_pages += 1;
                *count += 1;
                after_request(progress, *count, bytes);
            }
        }
    });
    if seen_pages == 0 {
        *count += 1;
    }
    after_request(progress, *count, bytes);
    result.map_err(|_| CaptureError::CanvasRequest)
}

fn after_request(progress: &mut dyn FnMut(RefreshProgress), count: u64, bytes: usize) {
    progress(RefreshProgress::new(
        RefreshPhase::Fetch,
        count,
        None,
        Some(bytes as u64),
    ));
}

fn put_json(
    docs: &mut BTreeMap<String, Vec<u8>>,
    path: &str,
    value: &Value,
    total: &mut usize,
) -> Result<(), CaptureError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| CaptureError::InvalidCanvasResponse)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_JSON_BYTES {
        return Err(CaptureError::ResponseLimit);
    }
    put_document(docs, path, bytes, total)
}

fn put_text(
    docs: &mut BTreeMap<String, Vec<u8>>,
    path: &str,
    value: &[u8],
    total: &mut usize,
) -> Result<(), CaptureError> {
    if value.len() > MAX_JSON_BYTES {
        return Err(CaptureError::ResponseLimit);
    }
    put_document(docs, path, value.to_vec(), total)
}

fn put_document(
    docs: &mut BTreeMap<String, Vec<u8>>,
    path: &str,
    bytes: Vec<u8>,
    total: &mut usize,
) -> Result<(), CaptureError> {
    if path.starts_with('/')
        || path.len() > 1024
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(CaptureError::InvalidScope);
    }
    let old = docs.get(path).map_or(0, Vec::len);
    let combined = total.saturating_sub(old).saturating_add(bytes.len());
    if combined > MAX_TOTAL_BYTES {
        return Err(CaptureError::OutputLimit);
    }
    *total = combined;
    docs.insert(path.to_owned(), bytes);
    Ok(())
}

fn timestamp(time: SystemTime) -> String {
    let elapsed = time.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    let seconds = elapsed.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date(days);
    let hour = day_seconds / 3600;
    let minute = day_seconds % 3600 / 60;
    let second = day_seconds % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        elapsed.subsec_millis()
    )
}

fn normalize_time(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.len() > 64 {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10).copied(), Some(b'T' | b't' | b' '))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year = value.get(0..4)?.parse::<i64>().ok()?;
    let month = value.get(5..7)?.parse::<i64>().ok()?;
    let day = value.get(8..10)?.parse::<i64>().ok()?;
    let hour = value.get(11..13)?.parse::<i64>().ok()?;
    let minute = value.get(14..16)?.parse::<i64>().ok()?;
    let second = value.get(17..19)?.parse::<i64>().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut index = 19;
    let mut millis = 0u32;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(|byte| byte.is_ascii_digit()) {
            index += 1;
        }
        let fraction = value.get(start..index)?;
        let mut digits: String = fraction.chars().take(3).collect();
        while digits.len() < 3 {
            digits.push('0');
        }
        millis = digits.parse().ok()?;
    }
    let offset = match bytes.get(index).copied() {
        Some(b'Z' | b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let direction = if sign == b'+' { 1 } else { -1 };
            let hours = value.get(index + 1..index + 3)?.parse::<i64>().ok()?;
            let mins = value.get(index + 4..index + 6)?.parse::<i64>().ok()?;
            direction * (hours * 3600 + mins * 60)
        }
        _ => return None,
    };
    let seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset;
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date(days);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    ))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * adjusted_month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_date(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_redaction_and_url_query_removal() {
        assert_eq!(
            redact("token=secret access_token=also-secret"),
            "token=[redacted] access_token=[redacted]"
        );
        assert_eq!(
            strip_query("https://example.invalid/path?token=secret#frag"),
            "https://example.invalid/path"
        );
    }

    #[test]
    fn signed_download_query_is_used_in_memory_but_never_projected() {
        #[cfg(feature = "test-overrides")]
        let (origin, listener) = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock");
            let origin = format!("http://{}", listener.local_addr().expect("mock address"));
            (origin, listener)
        };
        #[cfg(feature = "test-overrides")]
        let download_url = format!("{origin}/files/501/download?verifier=synthetic-secret");
        #[cfg(not(feature = "test-overrides"))]
        let download_url =
            "https://canvas.example.invalid/files/501/download?verifier=synthetic-secret";
        let raw = json!({
            "id": 501,
            "display_name": "notes.pdf",
            "filename": "notes.pdf",
            "size": 4,
            "url": download_url
        });
        assert!(raw_file_download_url(&raw).is_some_and(|url| url.contains("?verifier=")));
        let projected = project_endpoint("files", &raw).expect("safe file projection");
        assert!(projected
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|url| !url.contains('?')));
        assert!(
            !serde_json::to_string(&projected)
                .expect("serialize projection")
                .contains("synthetic-secret"),
            "projection retained a verifier"
        );

        #[cfg(feature = "test-overrides")]
        {
            use std::io::{BufRead, BufReader, Write};

            let (tx, rx) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept download");
                let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).expect("read request");
                    request.push_str(&line);
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                tx.send(request).expect("send captured request");
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfile",
                    )
                    .expect("write response");
            });

            let client = DownloadClient::with_test_origin(&origin).expect("download client");
            let response = client
                .download_file(raw_file_download_url(&raw).expect("raw download URL"))
                .expect("download file");
            assert_eq!(response.bytes, b"file");
            let request = rx.recv().expect("download request");
            assert!(
                request.starts_with("GET /files/501/download?verifier=synthetic-secret HTTP/1.1"),
                "signed verifier missing from GET"
            );
            server.join().expect("mock server");
        }
    }

    #[test]
    fn canvas_url_scheme_is_correct_for_build() {
        #[cfg(feature = "test-overrides")]
        {
            assert!(allowed_canvas_url("http://127.0.0.1:3030/api/v1/courses"));
            assert!(!allowed_canvas_url(
                "http://example.invalid:3030/api/v1/courses"
            ));
            assert!(!allowed_canvas_url("http://127.0.0.1/api/v1/courses"));
            assert!(!allowed_canvas_url(
                "http://user@127.0.0.1:3030/api/v1/courses"
            ));
        }
        #[cfg(not(feature = "test-overrides"))]
        {
            assert!(!allowed_canvas_url("http://127.0.0.1:3030/api/v1/courses"));
            assert!(allowed_canvas_url(
                "https://canvas.example.invalid/api/v1/courses"
            ));
        }
    }

    #[test]
    fn inbox_rejects_truncated_message_histories() {
        let too_many = json!({
            "id": 77001,
            "subject": "Synthetic thread",
            "workflow_state": "read",
            "message_count": (MAX_MESSAGES + 1),
            "participants": [],
            "messages": vec![json!({"body":"complete"}); MAX_MESSAGES + 1]
        });
        assert!(normalize_conversation(&too_many).is_none());

        let oversized = json!({
            "id": 77002,
            "subject": "Synthetic thread",
            "workflow_state": "read",
            "message_count": 1,
            "participants": [],
            "messages": [{"body":"x".repeat(MAX_MESSAGE_BYTES + 1)}]
        });
        assert!(normalize_conversation(&oversized).is_none());
    }

    #[test]
    fn inbox_detail_failures_fall_back_and_do_not_remove_prior_threads() {
        fn detail(id: &str) -> Value {
            json!({
                "id": id,
                "subject": "Current detail",
                "context_name": "Demo course",
                "workflow_state": "read",
                "starred": false,
                "message_count": 1,
                "participants": [],
                "messages": [{
                    "id": format!("{id}-message"),
                    "author_id": "9500",
                    "author_name": "Synthetic instructor",
                    "created_at": "2026-11-25T16:30:00Z",
                    "body": "Full later-thread detail",
                    "attachments": []
                }]
            })
        }

        let previous = json!({
            "conversations": [
                {
                    "canvasConversationId": "77001",
                    "contextLabel": "Demo course",
                    "subject": "Prior thread",
                    "latestMessagePreview": "Prior preview",
                    "latestMessageAt": "2026-11-25T15:00:00.000Z",
                    "unread": true,
                    "starred": false,
                    "messageCount": 2,
                    "participants": [{"canvasUserId":"9500","name":"Synthetic instructor"}],
                    "messages": [{
                        "canvasMessageId":"77001-prior",
                        "authorId":"9500",
                        "author":"Synthetic instructor",
                        "createdAt":"2026-11-25T15:00:00.000Z",
                        "body":"Preserved prior detail",
                        "bodyTruncated":false,
                        "attachments":[]
                    }],
                    "historyComplete":true,
                    "safetyTruncated":false,
                    "attachments":[]
                },
                {
                    "canvasConversationId":"77999",
                    "contextLabel":"Demo course",
                    "subject":"Prior removed candidate",
                    "latestMessagePreview":"Old",
                    "latestMessageAt":"2026-11-20T15:00:00.000Z",
                    "unread":false,
                    "starred":false,
                    "messageCount":0,
                    "participants":[],
                    "messages":[],
                    "historyComplete":true,
                    "safetyTruncated":false,
                    "attachments":[]
                }
            ]
        });
        let summaries = vec![
            json!({
                "id":"77001","subject":"Current summary","context_name":"Demo course",
                "last_message":"<p>Summary access_token=synthetic-private</p>",
                "last_message_at":"2026-11-26T15:00:00Z","workflow_state":"unread",
                "starred":true,"message_count":2
            }),
            json!({
                "id":"77002","subject":"Later thread","context_name":"Demo course",
                "last_message":"Later preview","last_message_at":"2026-11-25T14:00:00Z",
                "workflow_state":"read","starred":false,"message_count":1
            }),
            json!({
                "id":"77003","subject":"Oversized thread","context_name":"Demo course",
                "last_message":"Oversized preview","last_message_at":"2026-11-24T14:00:00Z",
                "workflow_state":"read","starred":false,"message_count":1
            }),
            json!({
                "id":"77004","subject":"Truncated thread","context_name":"Demo course",
                "last_message":"Truncated preview","last_message_at":"2026-11-23T14:00:00Z",
                "workflow_state":"read","starred":false,"message_count":MAX_MESSAGES + 1
            }),
        ];
        let mut fetched = Vec::new();
        let inbox = capture_inbox_from_summaries(summaries, Some(&previous), |id| {
            fetched.push(id.to_owned());
            match id {
                "77001" => Err(CaptureError::CanvasRequest),
                "77002" => Ok(detail(id)),
                "77003" => Ok(json!({
                    "id":id,"subject":"Oversized thread","workflow_state":"read",
                    "message_count":1,"participants":[],
                    "messages":[{"body":"x".repeat(MAX_MESSAGE_BYTES + 1)}]
                })),
                "77004" => Ok(json!({
                    "id":id,"subject":"Truncated thread","workflow_state":"read",
                    "message_count":MAX_MESSAGES + 1,"participants":[],
                    "messages":vec![json!({"body":"partial"}); MAX_MESSAGES + 1]
                })),
                _ => Err(CaptureError::InvalidCanvasResponse),
            }
        })
        .expect("partial inbox is represented, not aborted");

        assert_eq!(fetched, ["77001", "77002", "77003", "77004"]);
        assert_eq!(inbox.get("complete").and_then(Value::as_bool), Some(false));
        assert_eq!(inbox.get("rejected").and_then(Value::as_u64), Some(3));
        assert_eq!(
            inbox
                .pointer("/changes/removed")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        let rows = inbox
            .get("conversations")
            .and_then(Value::as_array)
            .unwrap();
        let row = |id: &str| {
            rows.iter()
                .find(|item| item.get("canvasConversationId").and_then(Value::as_str) == Some(id))
                .expect("conversation row")
        };
        let failed = row("77001");
        assert_eq!(
            failed.get("historyComplete").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            failed
                .get("detailCaptureIncomplete")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            failed.pointer("/messages/0/body").and_then(Value::as_str),
            Some("Preserved prior detail")
        );
        assert_eq!(
            failed.get("latestMessagePreview").and_then(Value::as_str),
            Some("Summary access_token=[redacted]")
        );
        assert_eq!(
            row("77002").get("historyComplete").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            row("77003")
                .get("messages")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        assert_eq!(
            row("77004")
                .get("messages")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        let absent_from_list = row("77999");
        assert_eq!(
            absent_from_list
                .get("historyComplete")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            absent_from_list
                .get("detailCaptureIncomplete")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(!serde_json::to_string(&inbox)
            .expect("serialize partial inbox")
            .contains("synthetic-private"));
    }

    #[test]
    fn message_body_removes_active_markup_and_redacts_tokens() {
        let (body, truncated) =
            clean_message("<p>Hello<script>alert(1)</script> world</p> access_token=secret");
        assert_eq!(body, "Hello world access_token=[redacted]");
        assert!(!truncated);
    }

    #[test]
    fn course_and_material_paths_are_bounded() {
        let scope = CourseScope {
            key: "demo-alpha".into(),
            folder: "classes/demo-alpha".into(),
            canvas_course_id: 9101,
        };
        assert!(validate_scope(&scope).is_ok());
        assert!(validate_scope(&CourseScope {
            key: "../bad".into(),
            folder: "classes/../bad".into(),
            canvas_course_id: 1,
        })
        .is_err());
        assert_eq!(material_name(501, "../notes.pdf").unwrap(), "501-notes.pdf");
    }

    #[test]
    fn avatar_requires_matching_magic_bytes() {
        assert!(image_signature(
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
            "image/png"
        ));
        assert!(!image_signature(b"bad", "image/png"));
    }

    #[test]
    fn timestamps_normalize_offsets_to_utc() {
        assert_eq!(
            normalize_time(Some("2026-11-25T16:30:00Z")).as_deref(),
            Some("2026-11-25T16:30:00.000Z")
        );
        assert_eq!(
            normalize_time(Some("2026-11-25T11:30:00-05:00")).as_deref(),
            Some("2026-11-25T16:30:00.000Z")
        );
    }

    #[test]
    fn capture_error_is_content_free() {
        let display = CaptureError::InvalidCanvasResponse.to_string();
        assert!(!display.contains("do-not-leak-this"));
        assert!(!display.contains("9101"));
    }
}
