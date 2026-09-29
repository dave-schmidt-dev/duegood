//! Capture-bound syllabus class sessions, merged without touching student-owned fields.

use std::collections::{HashMap, HashSet};
use std::fmt;

use chrono::{NaiveDate, NaiveTime, SecondsFormat, TimeZone};
use chrono_tz::Tz;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::browser_projection::BrowserCourseScope;

const MAX_COURSES: usize = 500;
const MAX_SESSIONS: usize = 1_000;
const REASONS: [&str; 6] = [
    "NO_SYLLABUS",
    "NO_SUPPORTED_SCHEDULE",
    "AMBIGUOUS_SCHEDULE",
    "UNSUPPORTED_DOCUMENT",
    "SOURCE_UNAVAILABLE",
    "LIMIT_EXCEEDED",
];

/// Content-free failure; invalid schedule facts cannot partially modify coursework.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyllabusSessionError;

impl fmt::Display for SyllabusSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SYLLABUS_SESSIONS_INVALID")
    }
}

impl std::error::Error for SyllabusSessionError {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleCapture {
    schema_version: u64,
    courses: Vec<CourseSchedule>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CourseSchedule {
    course_id: u64,
    time_zone: String,
    status: String,
    reason: Option<String>,
    sessions: Vec<Session>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    source: SessionSource,
    date: String,
    start_time: String,
    end_time: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSource {
    kind: String,
    file_id: Option<u64>,
    sha256: String,
    line: u64,
    page: Option<u64>,
}

struct SessionFact {
    id: String,
    course: String,
    at: String,
    ends_at: String,
    provenance: Value,
}

/// Adds or refreshes sessions from an already validated immutable Canvas capture.
///
/// The importer validates generation, account, scopes, coverage, and archived bytes first.
/// Missing or unresolved schedules retain all existing sessions. No source field can write
/// completion, notes, manual grades, or extensions, and no absence deletes a session.
pub fn reconcile_syllabus_sessions(
    coursework: &Value,
    snapshot: &Value,
    scopes: &[BrowserCourseScope],
) -> Result<Value, SyllabusSessionError> {
    let Some(raw) = snapshot.get("syllabusSessions") else {
        return Ok(coursework.clone());
    };
    let capture: ScheduleCapture =
        serde_json::from_value(raw.clone()).map_err(|_| SyllabusSessionError)?;
    if capture.schema_version != 1 || capture.courses.len() > MAX_COURSES {
        return Err(SyllabusSessionError);
    }
    let resources = snapshot["resources"]
        .as_array()
        .ok_or(SyllabusSessionError)?;
    let active_ids = snapshot["activeCourses"]["courseIds"]
        .as_array()
        .ok_or(SyllabusSessionError)?;
    let mut scopes_by_id = HashMap::new();
    for scope in scopes {
        if scope.canvas_course_id == 0
            || scope.key.is_empty()
            || scopes_by_id.insert(scope.canvas_course_id, scope).is_some()
        {
            return Err(SyllabusSessionError);
        }
    }
    let mut seen_courses = HashSet::new();
    let mut seen_sessions = HashSet::new();
    let mut facts = Vec::new();
    for schedule in &capture.courses {
        if schedule.course_id == 0
            || !seen_courses.insert(schedule.course_id)
            || !active_ids
                .iter()
                .any(|id| id.as_u64() == Some(schedule.course_id))
            || schedule.sessions.len() > MAX_SESSIONS
        {
            return Err(SyllabusSessionError);
        }
        let course = course_item(resources, schedule.course_id)?;
        if schedule.status == "unresolved" {
            if !schedule.sessions.is_empty()
                || schedule
                    .reason
                    .as_deref()
                    .is_none_or(|reason| !REASONS.contains(&reason))
                || schedule.time_zone.len() > 100
            {
                return Err(SyllabusSessionError);
            }
            continue;
        }
        if schedule.status != "complete"
            || schedule.reason.is_some()
            || schedule.sessions.is_empty()
            || course["time_zone"].as_str() != Some(schedule.time_zone.as_str())
        {
            return Err(SyllabusSessionError);
        }
        let time_zone = schedule
            .time_zone
            .parse::<Tz>()
            .map_err(|_| SyllabusSessionError)?;
        for session in &schedule.sessions {
            validate_source(&session.source, course, resources, schedule.course_id)?;
            let (at, ends_at) = validate_times(session, time_zone)?;
            let identity = json!([
                schedule.course_id,
                session.date,
                session.start_time,
                session.end_time,
                schedule.time_zone
            ]);
            let id = format!(
                "syllabus-session-{}-{}",
                schedule.course_id,
                digest(identity.to_string().as_bytes())
            );
            if !seen_sessions.insert(id.clone()) {
                return Err(SyllabusSessionError);
            }
            let Some(scope) = scopes_by_id.get(&schedule.course_id) else {
                // An active Canvas course may not yet have an adopted local folder.
                continue;
            };
            let source = json!({
                "kind":session.source.kind, "fileId":session.source.file_id,
                "sha256":session.source.sha256, "line":session.source.line,
                "page":session.source.page
            });
            facts.push(SessionFact {
                id,
                course: scope.key.clone(),
                at,
                ends_at,
                provenance: json!({
                    "version":1, "canvasCourseId":schedule.course_id,
                    "date":session.date, "startTime":session.start_time,
                    "endTime":session.end_time, "timeZone":schedule.time_zone,
                    "source":source
                }),
            });
        }
    }
    merge_facts(coursework, facts)
}

fn course_item(resources: &[Value], course_id: u64) -> Result<&Value, SyllabusSessionError> {
    let resource = unique(resources.iter().filter(|resource| {
        resource["endpoint"] == "course"
            && resource["courseId"].as_u64() == Some(course_id)
            && resource.get("groupId").is_none_or(Value::is_null)
    }))?;
    let items = resource["items"].as_array().ok_or(SyllabusSessionError)?;
    let course = unique(items.iter())?;
    if course["id"].as_u64() != Some(course_id) {
        return Err(SyllabusSessionError);
    }
    Ok(course)
}

fn validate_source(
    source: &SessionSource,
    course: &Value,
    resources: &[Value],
    course_id: u64,
) -> Result<(), SyllabusSessionError> {
    if source.sha256.len() != 64
        || !source
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !(1..=10_000).contains(&source.line)
        || source.page.is_some_and(|page| !(1..=80).contains(&page))
    {
        return Err(SyllabusSessionError);
    }
    match source.kind.as_str() {
        "course-body" => {
            let body = course["syllabus_body"]
                .as_str()
                .ok_or(SyllabusSessionError)?;
            if source.file_id.is_some()
                || source.page.is_some()
                || body.is_empty()
                || digest(body.as_bytes()) != source.sha256
            {
                return Err(SyllabusSessionError);
            }
        }
        "file" => {
            let file_id = source
                .file_id
                .filter(|id| *id > 0)
                .ok_or(SyllabusSessionError)?;
            let files = unique(resources.iter().filter(|resource| {
                resource["endpoint"] == "courseFiles"
                    && resource["courseId"].as_u64() == Some(course_id)
                    && resource.get("groupId").is_none_or(Value::is_null)
            }))?;
            let files = files["items"].as_array().ok_or(SyllabusSessionError)?;
            unique(
                files
                    .iter()
                    .filter(|file| file["id"].as_u64() == Some(file_id)),
            )?;
            let receipts = resources
                .iter()
                .filter(|resource| resource["endpoint"] == "fileBodies")
                .map(|resource| resource["items"].as_array().ok_or(SyllabusSessionError))
                .collect::<Result<Vec<_>, _>>()?;
            let receipt = unique(
                receipts
                    .iter()
                    .flat_map(|items| items.iter())
                    .filter(|item| item["fileId"].as_u64() == Some(file_id)),
            )?;
            if receipt["status"] != "archived"
                || receipt["sha256"].as_str() != Some(source.sha256.as_str())
            {
                return Err(SyllabusSessionError);
            }
        }
        _ => return Err(SyllabusSessionError),
    }
    Ok(())
}

fn validate_times(session: &Session, zone: Tz) -> Result<(String, String), SyllabusSessionError> {
    if session.title != "Class session"
        || !exact_digits(&session.date, &[4, 7], b'-', 10)
        || !exact_digits(&session.start_time, &[2], b':', 5)
        || !exact_digits(&session.end_time, &[2], b':', 5)
    {
        return Err(SyllabusSessionError);
    }
    let date =
        NaiveDate::parse_from_str(&session.date, "%Y-%m-%d").map_err(|_| SyllabusSessionError)?;
    let start = NaiveTime::parse_from_str(&session.start_time, "%H:%M")
        .map_err(|_| SyllabusSessionError)?;
    let end =
        NaiveTime::parse_from_str(&session.end_time, "%H:%M").map_err(|_| SyllabusSessionError)?;
    if start >= end || date.format("%Y-%m-%d").to_string() != session.date {
        return Err(SyllabusSessionError);
    }
    let start = zone
        .from_local_datetime(&date.and_time(start))
        .single()
        .ok_or(SyllabusSessionError)?;
    let end = zone
        .from_local_datetime(&date.and_time(end))
        .single()
        .ok_or(SyllabusSessionError)?;
    if start >= end {
        return Err(SyllabusSessionError);
    }
    Ok((
        start.to_rfc3339_opts(SecondsFormat::Secs, false),
        end.to_rfc3339_opts(SecondsFormat::Secs, false),
    ))
}

fn exact_digits(value: &str, separators: &[usize], separator: u8, length: usize) -> bool {
    value.len() == length
        && value.bytes().enumerate().all(|(index, byte)| {
            if separators.contains(&index) {
                byte == separator
            } else {
                byte.is_ascii_digit()
            }
        })
}

fn merge_facts(
    coursework: &Value,
    mut facts: Vec<SessionFact>,
) -> Result<Value, SyllabusSessionError> {
    let mut result = coursework.clone();
    let items = result["items"].as_array_mut().ok_or(SyllabusSessionError)?;
    let mut indexes = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let id = item["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or(SyllabusSessionError)?;
        if !item.is_object() || indexes.insert(id.to_owned(), index).is_some() {
            return Err(SyllabusSessionError);
        }
    }
    facts.sort_by(|left, right| left.id.cmp(&right.id));
    for fact in facts {
        if let Some(index) = indexes.get(&fact.id).copied() {
            let existing = &mut items[index];
            if existing["kind"] != "session"
                || existing["source"] != "syllabus"
                || existing["course"].as_str() != Some(fact.course.as_str())
                || existing["syllabusSession"]["version"] != 1
                || existing["syllabusSession"]["canvasCourseId"]
                    != fact.provenance["canvasCourseId"]
            {
                return Err(SyllabusSessionError);
            }
            existing["at"] = json!(fact.at);
            existing["endsAt"] = json!(fact.ends_at);
            existing["title"] = json!("Class session");
            existing["syllabusSession"] = fact.provenance;
        } else {
            let index = items.len();
            indexes.insert(fact.id.clone(), index);
            items.push(json!({
                "id":fact.id, "course":fact.course, "kind":"session", "source":"syllabus",
                "title":"Class session", "at":fact.at, "endsAt":fact.ends_at,
                "done":false, "syllabusSession":fact.provenance
            }));
        }
    }
    Ok(result)
}

fn unique<'a>(
    mut values: impl Iterator<Item = &'a Value>,
) -> Result<&'a Value, SyllabusSessionError> {
    let value = values.next().ok_or(SyllabusSessionError)?;
    if values.next().is_some() {
        return Err(SyllabusSessionError);
    }
    Ok(value)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "syllabus_sessions_tests.rs"]
mod tests;
