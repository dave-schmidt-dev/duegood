//! Bounded owner-supplied class sessions for the authoritative native coursework store.
//!
//! This accepts only explicit local clock facts. It does not read Canvas, capture archives, or
//! local notes. The supplied note digest is provenance only; the note text stays outside this
//! helper and the coursework file unless another narrow owner action writes it.

use std::collections::HashSet;
use std::io::Read;
use std::time::Duration;

use chrono::{NaiveDate, NaiveTime, SecondsFormat, TimeZone};
use chrono_tz::Tz;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::{self, ReadLimits, COURSEWORK_FILE};
use crate::store::{sha256_hex, Store, StoreCondition, StoreError, StoreState};

const MAX_REQUEST_BYTES: u64 = 128 * 1024;
const MAX_SESSIONS: usize = 366;
const MAX_TEXT_BYTES: usize = 160;

/// Fixed, content-free helper failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersonalSessionHelperError(&'static str);

impl PersonalSessionHelperError {
    /// Stable code safe for a CLI error line.
    pub const fn code(self) -> &'static str {
        self.0
    }
}

impl std::fmt::Display for PersonalSessionHelperError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for PersonalSessionHelperError {}

/// A completed personal-session update. It never contains coursework content or local paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersonalSessionResult {
    pub added: usize,
    pub updated: usize,
    pub unchanged: bool,
}

/// Sanitized progress emitted only immediately before a changed document is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersonalSessionProgress {
    Writing,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersonalSessionRequest {
    expected_version: String,
    canvas_course_id: u64,
    term: String,
    time_zone: String,
    sessions: Vec<SessionInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionInput {
    date: String,
    start_time: String,
    end_time: String,
    local_note_sha256: String,
}

struct SessionFact {
    id: String,
    at: String,
    ends_at: String,
    provenance: Value,
}

/// Reads exactly one bounded JSON request from stdin.
pub fn read_personal_session_request<R: Read>(
    reader: R,
) -> Result<PersonalSessionRequest, PersonalSessionHelperError> {
    let mut bytes = Vec::with_capacity(MAX_REQUEST_BYTES as usize);
    reader
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| PersonalSessionHelperError("INPUT_UNAVAILABLE"))?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(PersonalSessionHelperError("INPUT_TOO_LARGE"));
    }
    let mut line = bytes.as_slice();
    if let Some(without_newline) = line.strip_suffix(b"\n") {
        line = without_newline;
        if let Some(without_carriage_return) = line.strip_suffix(b"\r") {
            line = without_carriage_return;
        }
    }
    if line.is_empty() || line.contains(&b'\n') || line.contains(&b'\r') {
        return Err(PersonalSessionHelperError("INVALID_INPUT"));
    }
    serde_json::from_slice(line).map_err(|_| PersonalSessionHelperError("INVALID_INPUT"))
}

/// Runs the fixed-root helper. The exact document digest fences its read against every native
/// writer using the shared OS lock, including refresh and personal completion changes.
pub fn run_personal_sessions(
    request: PersonalSessionRequest,
    progress: &mut dyn FnMut(PersonalSessionProgress),
) -> Result<PersonalSessionResult, PersonalSessionHelperError> {
    let data_root = config::resolve_helper_data_root()
        .map_err(|_| PersonalSessionHelperError("APP_DATA_UNAVAILABLE"))?;
    let store = Store::open_helper(&data_root, Duration::from_secs(5))
        .map_err(|_| PersonalSessionHelperError("STORE_UNAVAILABLE"))?;
    apply_personal_sessions(&store, &request, progress)
}

fn apply_personal_sessions(
    store: &Store,
    request: &PersonalSessionRequest,
    progress: &mut dyn FnMut(PersonalSessionProgress),
) -> Result<PersonalSessionResult, PersonalSessionHelperError> {
    if !valid_digest(&request.expected_version) {
        return Err(PersonalSessionHelperError("INVALID_INPUT"));
    }
    match store.condition().map_err(store_error)? {
        StoreCondition::Ready(manifest) if manifest.state == StoreState::Authoritative => {}
        StoreCondition::Ready(_) | StoreCondition::Empty | StoreCondition::Damaged(_) => {
            return Err(PersonalSessionHelperError("STORE_NOT_AUTHORITATIVE"));
        }
    }
    let prior = store
        .read_document(COURSEWORK_FILE, ReadLimits::PRODUCTION.max_document_bytes)
        .map_err(store_error)?
        .ok_or(PersonalSessionHelperError("COURSEWORK_UNAVAILABLE"))?;
    if prior.digest != request.expected_version {
        return Err(PersonalSessionHelperError("VERSION_CONFLICT"));
    }
    let coursework: Value = serde_json::from_slice(&prior.bytes)
        .map_err(|_| PersonalSessionHelperError("COURSEWORK_INVALID"))?;
    let (next, added, updated) = merge_request(&coursework, request)?;
    if next == coursework {
        return Ok(PersonalSessionResult {
            added: 0,
            updated: 0,
            unchanged: true,
        });
    }
    progress(PersonalSessionProgress::Writing);
    store
        .replace_json_document(COURSEWORK_FILE, Some(&prior.digest), &next)
        .map_err(|error| match error {
            StoreError::Conflict => PersonalSessionHelperError("VERSION_CONFLICT"),
            _ => store_error(error),
        })?;
    Ok(PersonalSessionResult {
        added,
        updated,
        unchanged: false,
    })
}

fn merge_request(
    coursework: &Value,
    request: &PersonalSessionRequest,
) -> Result<(Value, usize, usize), PersonalSessionHelperError> {
    if request.canvas_course_id == 0
        || !bounded_text(&request.term)
        || !bounded_text(&request.time_zone)
        || request.sessions.is_empty()
        || request.sessions.len() > MAX_SESSIONS
    {
        return Err(PersonalSessionHelperError("INVALID_INPUT"));
    }
    let time_zone = request
        .time_zone
        .parse::<Tz>()
        .map_err(|_| PersonalSessionHelperError("INVALID_INPUT"))?;
    if coursework.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err(PersonalSessionHelperError("COURSEWORK_INVALID"));
    }
    if coursework.get("term").and_then(Value::as_str) != Some(request.term.as_str())
        || coursework.get("timezone").and_then(Value::as_str) != Some(request.time_zone.as_str())
    {
        return Err(PersonalSessionHelperError("COURSE_OR_TERM_MISMATCH"));
    }
    let courses = coursework
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(PersonalSessionHelperError("COURSEWORK_INVALID"))?;
    let matching = courses
        .iter()
        .filter(|course| {
            course_canvas_id(course.get("canvasCourseId")) == Some(request.canvas_course_id)
        })
        .collect::<Vec<_>>();
    let [course] = matching.as_slice() else {
        return Err(PersonalSessionHelperError("COURSE_OR_TERM_MISMATCH"));
    };
    let course_key = course
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| bounded_text(key))
        .ok_or(PersonalSessionHelperError("COURSEWORK_INVALID"))?;

    let mut dates = HashSet::new();
    let mut ids = HashSet::new();
    let mut facts = Vec::with_capacity(request.sessions.len());
    for input in &request.sessions {
        let fact = session_fact(input, request, time_zone)?;
        if !dates.insert(input.date.as_str()) || !ids.insert(fact.id.clone()) {
            return Err(PersonalSessionHelperError("INVALID_INPUT"));
        }
        facts.push(fact);
    }
    facts.sort_by(|left, right| left.id.cmp(&right.id));

    let mut result = coursework.clone();
    let items = result
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or(PersonalSessionHelperError("COURSEWORK_INVALID"))?;
    let mut existing = std::collections::HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(PersonalSessionHelperError("COURSEWORK_INVALID"))?;
        if !item.is_object() || existing.insert(id.to_owned(), index).is_some() {
            return Err(PersonalSessionHelperError("COURSEWORK_INVALID"));
        }
    }

    let mut added = 0;
    let mut updated = 0;
    for fact in facts {
        if let Some(index) = existing.get(&fact.id).copied() {
            let item = &mut items[index];
            if item.get("kind").and_then(Value::as_str) != Some("session")
                || item.get("source").and_then(Value::as_str) != Some("manual")
                || item.get("course").and_then(Value::as_str) != Some(course_key)
                || item["personalSession"]["version"].as_u64() != Some(1)
                || item["personalSession"]["canvasCourseId"].as_u64()
                    != Some(request.canvas_course_id)
                || item["personalSession"]["term"] != fact.provenance["term"]
                || item["personalSession"]["date"] != fact.provenance["date"]
                || item["personalSession"]["timeZone"] != fact.provenance["timeZone"]
            {
                return Err(PersonalSessionHelperError("SESSION_ID_CONFLICT"));
            }
            let before = item.clone();
            item["title"] = json!("Class session");
            item["at"] = json!(fact.at);
            item["endsAt"] = json!(fact.ends_at);
            item["personalSession"] = fact.provenance;
            if *item != before {
                updated += 1;
            }
        } else {
            items.push(json!({
                "id":fact.id, "course":course_key, "kind":"session", "source":"manual",
                "title":"Class session", "at":fact.at, "endsAt":fact.ends_at, "done":false,
                "personalSession":fact.provenance
            }));
            added += 1;
        }
    }
    Ok((result, added, updated))
}

fn session_fact(
    input: &SessionInput,
    request: &PersonalSessionRequest,
    time_zone: Tz,
) -> Result<SessionFact, PersonalSessionHelperError> {
    if !exact_date(&input.date)
        || !exact_clock(&input.start_time)
        || !exact_clock(&input.end_time)
        || !valid_digest(&input.local_note_sha256)
    {
        return Err(PersonalSessionHelperError("INVALID_INPUT"));
    }
    let date = NaiveDate::parse_from_str(&input.date, "%Y-%m-%d")
        .map_err(|_| PersonalSessionHelperError("INVALID_INPUT"))?;
    if date.format("%Y-%m-%d").to_string() != input.date {
        return Err(PersonalSessionHelperError("INVALID_INPUT"));
    }
    let start = NaiveTime::parse_from_str(&input.start_time, "%H:%M")
        .map_err(|_| PersonalSessionHelperError("INVALID_INPUT"))?;
    let end = NaiveTime::parse_from_str(&input.end_time, "%H:%M")
        .map_err(|_| PersonalSessionHelperError("INVALID_INPUT"))?;
    if start >= end {
        return Err(PersonalSessionHelperError("INVALID_INPUT"));
    }
    let start = time_zone
        .from_local_datetime(&date.and_time(start))
        .single()
        .ok_or(PersonalSessionHelperError("INVALID_INPUT"))?;
    let end = time_zone
        .from_local_datetime(&date.and_time(end))
        .single()
        .ok_or(PersonalSessionHelperError("INVALID_INPUT"))?;
    if start >= end {
        return Err(PersonalSessionHelperError("INVALID_INPUT"));
    }
    let identity = json!([
        request.canvas_course_id,
        request.term,
        input.date,
        request.time_zone
    ]);
    let id = format!(
        "manual-session-{}-{}",
        request.canvas_course_id,
        sha256_hex(identity.to_string().as_bytes())
    );
    Ok(SessionFact {
        id,
        at: start.to_rfc3339_opts(SecondsFormat::Secs, false),
        ends_at: end.to_rfc3339_opts(SecondsFormat::Secs, false),
        provenance: json!({
            "version":1, "canvasCourseId":request.canvas_course_id, "term":request.term,
            "date":input.date, "startTime":input.start_time, "endTime":input.end_time,
            "timeZone":request.time_zone, "localNoteSha256":input.local_note_sha256
        }),
    })
}

fn bounded_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_TEXT_BYTES && !value.chars().any(char::is_control)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn course_canvas_id(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(value)) => value.as_u64().filter(|id| *id > 0),
        Some(Value::String(value))
            if !value.is_empty()
                && value.bytes().all(|byte| byte.is_ascii_digit())
                && !value.starts_with('0') =>
        {
            value.parse::<u64>().ok().filter(|id| *id > 0)
        }
        _ => None,
    }
}

fn exact_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn exact_clock(value: &str) -> bool {
    value.len() == 5
        && value.as_bytes().get(2) == Some(&b':')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit())
}

fn store_error(error: StoreError) -> PersonalSessionHelperError {
    match error {
        StoreError::Conflict => PersonalSessionHelperError("VERSION_CONFLICT"),
        _ => PersonalSessionHelperError("STORE_UNAVAILABLE"),
    }
}

#[cfg(test)]
#[path = "personal_sessions_tests.rs"]
mod tests;
