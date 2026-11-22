//! Bounded, read-only Canvas capture and privacy projection.
//!
//! This module never accesses the filesystem. It returns sanitized relative-path bytes for the
//! refresh transaction to stage atomically.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::canvas::{ApiResponse, CanvasApi, CanvasError};
use crate::downloads::{DownloadClient, DownloadError};
use crate::reconcile::{reconcile_coursework, CourseAssignments};
use crate::refresh::{RefreshCapture, RefreshPhase, RefreshPrior, RefreshProgress};

#[path = "capture_course_metadata.rs"]
mod capture_course_metadata;

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
    "content_type",
    "content-type",
    "locked",
    "locked_for_user",
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

    let mut course_sources_complete = true;
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
        course_sources_complete &= captured.source_complete;
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
    let source_complete = conversations.get("complete").and_then(Value::as_bool) == Some(true)
        && course_sources_complete;
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
    let mut coursework = reconcile_coursework(base_coursework, &course_assignments, captured_at)
        .map_err(|_| CaptureError::Reconcile)?;
    capture_course_metadata::apply(&mut coursework, &documents, course_scopes)
        .map_err(|_| CaptureError::InvalidCanvasResponse)?;
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

include!("capture_linked_files.rs");

include!("capture_course.rs");

include!("capture_inbox.rs");

include!("capture_support.rs");

#[cfg(test)]
#[path = "capture_tests.rs"]
mod tests;
