//! Pure reconciliation of a complete Canvas coursework capture into the local document.
//!
//! The caller must pass every successfully captured assignment for each course it supplies.
//! A course omitted from `courses` is left untouched, so a failed course capture cannot make
//! its existing work disappear. Canvas submission fields are separate from local completion.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

/// One fully captured course's assignment data.
#[derive(Debug, Clone, PartialEq)]
pub struct CourseAssignments {
    /// Stable local course key.
    pub key: String,
    /// Complete Canvas assignment-group response.
    pub groups: Vec<Value>,
    /// Complete Canvas assignments response, including each submission projection.
    pub assignments: Vec<Value>,
}

/// A malformed document or capture that cannot be reconciled without guessing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileError(&'static str);

impl fmt::Display for ReconcileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ReconcileError {}

fn invalid(message: &'static str) -> ReconcileError {
    ReconcileError(message)
}

/// Reconcile a complete capture for the listed courses into a cloned local document.
///
/// Items are matched by `(course key, Canvas assignment ID)`. Existing item identity,
/// student-owned completion, manual work, unknown fields, and prior archives are retained.
/// Only a changed document gets a new `sync.lastSync`; no-op input returns the document exactly
/// as supplied. Missing courses are deliberately untouched, allowing callers to stage only
/// successfully captured courses without archiving work from a failed course.
pub fn reconcile_coursework(
    base: &Value,
    courses: &[CourseAssignments],
    captured_at: SystemTime,
) -> Result<Value, ReconcileError> {
    let mut result = base.clone();
    let root = result
        .as_object_mut()
        .ok_or_else(|| invalid("coursework document must be an object"))?;

    let local_courses = root
        .get("courses")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| invalid("coursework courses must be an array"))?;
    let local_items = root
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| invalid("coursework items must be an array"))?;

    let course_indexes = index_local_courses(&local_courses)?;
    let mut captures = HashMap::new();
    for capture in courses {
        if !course_indexes.contains_key(capture.key.as_str()) {
            return Err(invalid("capture references an unknown course key"));
        }
        if captures.contains_key(capture.key.as_str()) {
            return Err(invalid("duplicate course capture"));
        }
        validate_capture(capture)?;
        captures.insert(capture.key.as_str(), capture);
    }

    let mut item_ids = HashSet::new();
    let mut existing_canvas_ids = HashSet::new();
    for item in &local_items {
        let object = item
            .as_object()
            .ok_or_else(|| invalid("coursework item must be an object"))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("coursework item id must be a nonempty string"))?;
        if !item_ids.insert(id.to_owned()) {
            return Err(invalid("duplicate coursework item id"));
        }
        if object.get("source").and_then(Value::as_str) == Some("canvas") {
            if let (Some(course), Some(canvas_id)) = (
                object.get("course").and_then(Value::as_str),
                object.get("canvasId").and_then(identity_key),
            ) {
                if !existing_canvas_ids.insert((course.to_owned(), canvas_id)) {
                    return Err(invalid("duplicate local Canvas assignment identity"));
                }
            }
        }
    }

    let archive_existing = root
        .get("archivedForecastItems")
        .map(|archive| {
            archive
                .as_array()
                .ok_or_else(|| invalid("archivedForecastItems must be an array"))
        })
        .transpose()?
        .cloned()
        .unwrap_or_default();
    let archived_canvas_ids: HashSet<(String, String)> = archive_existing
        .iter()
        .filter_map(|item| {
            Some((
                item.get("course")?.as_str()?.to_owned(),
                identity_key(item.get("canvasId")?)?,
            ))
        })
        .collect();

    let mut seen = HashSet::<(String, String)>::new();
    let mut next_items = Vec::with_capacity(local_items.len());
    let mut newly_archived = Vec::new();

    for mut item in local_items.iter().cloned() {
        let object = item.as_object().expect("validated item object");
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let source = object
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let key = object
            .get("course")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let canvas_id = object.get("canvasId").and_then(identity_key);

        if is_personal_live_item(&kind, &source) {
            next_items.push(item);
            continue;
        }

        if source == "canvas" {
            let (Some(key), Some(canvas_id)) = (key, canvas_id) else {
                // An incomplete identity is not safe to delete or remap.
                next_items.push(item);
                continue;
            };
            let Some(capture) = captures.get(key.as_str()) else {
                // This course was not captured in this call.
                next_items.push(item);
                continue;
            };
            let ignored = ignored_ids(&local_courses, &key)?;
            if ignored.contains(&canvas_id) {
                move_to_archive(item, &mut newly_archived, &archived_canvas_ids);
                continue;
            }
            if let Some(assignment) = capture.assignments.iter().find(|assignment| {
                assignment.get("id").and_then(identity_key).as_deref() == Some(canvas_id.as_str())
            }) {
                update_item(&mut item, assignment, capture, &canvas_id)?;
                seen.insert((key, canvas_id));
                next_items.push(item);
            } else {
                move_to_archive(item, &mut newly_archived, &archived_canvas_ids);
            }
            continue;
        }

        if source == "syllabus" {
            if key.as_deref().is_some_and(|key| captures.contains_key(key)) {
                move_to_archive(item, &mut newly_archived, &archived_canvas_ids);
            } else {
                next_items.push(item);
            }
        } else {
            // Manual and unrecognized sources are retained as local work.
            next_items.push(item);
        }
    }

    for capture in courses {
        let course_index = *course_indexes
            .get(capture.key.as_str())
            .expect("capture course validated");
        let existing_course = root["courses"]
            .as_array()
            .expect("courses array validated")
            .get(course_index)
            .expect("course index validated")
            .as_object()
            .expect("course object validated");
        let groups = merged_groups(existing_course, capture)?;
        let course = root["courses"]
            .as_array_mut()
            .expect("courses array validated")
            .get_mut(course_index)
            .expect("course index validated")
            .as_object_mut()
            .expect("course object validated");
        course.insert("gradeGroups".to_owned(), Value::Array(groups));

        let ignored = ignored_ids(&local_courses, &capture.key)?;
        for assignment in &capture.assignments {
            let canvas_id = identity_key(assignment.get("id").expect("assignment id validated"))
                .expect("assignment id validated");
            if ignored.contains(&canvas_id) {
                continue;
            }
            let identity = (capture.key.clone(), canvas_id.clone());
            if seen.contains(&identity) {
                continue;
            }
            let item = new_item(&capture.key, assignment, capture, &canvas_id)?;
            let generated_id = item["id"]
                .as_str()
                .expect("new item id is a string")
                .to_owned();
            if !item_ids.insert(generated_id) {
                return Err(invalid(
                    "generated coursework item id collides with an existing item",
                ));
            }
            seen.insert(identity);
            next_items.push(item);
        }
    }

    root.insert("items".to_owned(), Value::Array(next_items));
    if !newly_archived.is_empty() {
        let mut archived = archive_existing;
        archived.extend(newly_archived);
        root.insert("archivedForecastItems".to_owned(), Value::Array(archived));
    }

    if result == *base {
        return Ok(result);
    }
    let last_sync = new_york_date(captured_at)?;
    let root = result
        .as_object_mut()
        .expect("coursework root object was validated");
    let sync = root
        .entry("sync".to_owned())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| invalid("coursework sync must be an object"))?;
    sync.insert("lastSync".to_owned(), Value::String(last_sync));
    Ok(result)
}

fn index_local_courses(courses: &[Value]) -> Result<HashMap<&str, usize>, ReconcileError> {
    let mut indexes = HashMap::new();
    for (index, course) in courses.iter().enumerate() {
        let object = course
            .as_object()
            .ok_or_else(|| invalid("coursework course must be an object"))?;
        let key = object
            .get("key")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .ok_or_else(|| invalid("coursework course key must be a nonempty string"))?;
        if indexes.insert(key, index).is_some() {
            return Err(invalid("duplicate coursework course key"));
        }
    }
    Ok(indexes)
}

fn validate_capture(capture: &CourseAssignments) -> Result<(), ReconcileError> {
    let mut groups = HashSet::new();
    for group in &capture.groups {
        let id = group
            .get("id")
            .and_then(identity_key)
            .ok_or_else(|| invalid("Canvas assignment group id is missing or invalid"))?;
        if !groups.insert(id) {
            return Err(invalid("duplicate Canvas assignment group id"));
        }
    }
    let mut assignments = HashSet::new();
    for assignment in &capture.assignments {
        if !assignment.is_object() {
            return Err(invalid("Canvas assignment must be an object"));
        }
        let id = assignment
            .get("id")
            .and_then(identity_key)
            .ok_or_else(|| invalid("Canvas assignment id is missing or invalid"))?;
        if !assignments.insert(id) {
            return Err(invalid("duplicate Canvas assignment id"));
        }
        if assignment.get("name").and_then(Value::as_str).is_none() {
            return Err(invalid("Canvas assignment name must be a string"));
        }
        if let Some(submission) = assignment.get("submission") {
            if !submission.is_null() && !submission.is_object() {
                return Err(invalid(
                    "Canvas assignment submission must be an object or null",
                ));
            }
        }
    }
    Ok(())
}

fn identity_key(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) if number.as_u64().is_some() => Some(number.to_string()),
        _ => None,
    }
}

fn ignored_ids(local_courses: &[Value], key: &str) -> Result<HashSet<String>, ReconcileError> {
    let course = local_courses
        .iter()
        .find(|course| course.get("key").and_then(Value::as_str) == Some(key))
        .ok_or_else(|| invalid("captured course disappeared from coursework document"))?;
    let Some(ids) = course.get("ignoredCanvasAssignmentIds") else {
        return Ok(HashSet::new());
    };
    let ids = ids
        .as_array()
        .ok_or_else(|| invalid("ignoredCanvasAssignmentIds must be an array"))?;
    ids.iter()
        .map(|id| {
            identity_key(id).ok_or_else(|| invalid("ignored Canvas assignment id is invalid"))
        })
        .collect()
}

fn merged_groups(
    existing_course: &Map<String, Value>,
    capture: &CourseAssignments,
) -> Result<Vec<Value>, ReconcileError> {
    let existing: &[Value] = match existing_course.get("gradeGroups") {
        Some(value) => value
            .as_array()
            .ok_or_else(|| invalid("course gradeGroups must be an array"))?
            .as_slice(),
        None => &[],
    };
    let incoming: HashMap<String, &Value> = capture
        .groups
        .iter()
        .map(|group| {
            (
                identity_key(group.get("id").expect("group id validated"))
                    .expect("group id validated"),
                group,
            )
        })
        .collect();
    let mut seen = HashSet::new();
    let mut groups = Vec::with_capacity(existing.len().max(capture.groups.len()));
    for old in existing {
        let old_id = old.get("id").and_then(identity_key);
        if let Some(id) = old_id.as_ref() {
            if !seen.insert(id.clone()) {
                return Err(invalid("duplicate local grade group identity"));
            }
        }
        if let Some(group) = old_id.as_ref().and_then(|id| incoming.get(id)) {
            let mut updated = old.clone();
            if let Some(object) = updated.as_object_mut() {
                object.insert(
                    "name".to_owned(),
                    group.get("name").cloned().unwrap_or(Value::Null),
                );
                object.insert(
                    "weight".to_owned(),
                    group.get("group_weight").cloned().unwrap_or(Value::Null),
                );
            }
            groups.push(updated);
        } else {
            // Preserve an unknown or no-longer-returned local group entry instead of dropping it.
            groups.push(old.clone());
        }
    }
    for group in &capture.groups {
        let id =
            identity_key(group.get("id").expect("group id validated")).expect("group id validated");
        if seen.insert(id) {
            groups.push(json!({
                "id": group["id"].clone(),
                "name": group.get("name").cloned().unwrap_or(Value::Null),
                "weight": group.get("group_weight").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    Ok(groups)
}

fn update_item(
    item: &mut Value,
    assignment: &Value,
    capture: &CourseAssignments,
    canvas_id: &str,
) -> Result<(), ReconcileError> {
    let target = item
        .as_object_mut()
        .ok_or_else(|| invalid("coursework item must be an object"))?;
    let incoming_name = assignment["name"]
        .as_str()
        .expect("validated assignment name");
    if target.get("keepTitle").and_then(Value::as_bool) != Some(true) {
        target.insert("title".to_owned(), Value::String(incoming_name.to_owned()));
    }
    target.insert(
        "kind".to_owned(),
        Value::String(kind_for(assignment).to_owned()),
    );
    target.insert("source".to_owned(), Value::String("canvas".to_owned()));
    target.insert(
        "confidence".to_owned(),
        Value::String("confirmed".to_owned()),
    );
    target.insert("canvasId".to_owned(), assignment["id"].clone());
    patch_due_at(target, assignment)?;
    patch_optional(target, "points", assignment, "points_possible");
    patch_optional(target, "url", assignment, "html_url");
    patch_group(target, assignment, capture)?;
    patch_submission(target, assignment)?;
    // `canvas_id` is already used to verify the match and intentionally not used to rewrite id.
    let _ = canvas_id;
    Ok(())
}

fn new_item(
    course_key: &str,
    assignment: &Value,
    capture: &CourseAssignments,
    canvas_id: &str,
) -> Result<Value, ReconcileError> {
    let name = assignment["name"]
        .as_str()
        .expect("validated assignment name");
    let mut item = json!({
        "id": format!("{course_key}-canvas-{canvas_id}"),
        "course": course_key,
        "kind": kind_for(assignment),
        "title": name,
        "source": "canvas",
        "confidence": "confirmed",
        "flags": [],
        "detail": "",
        "canvasId": assignment["id"].clone(),
        "done": false,
        "doneAt": null,
        "submissionStatus": null,
        "submittedAt": null,
        "gradedAt": null,
        "grade": null,
        "score": null
    });
    let target = item.as_object_mut().expect("new item is object");
    patch_due_at(target, assignment)?;
    patch_optional(target, "points", assignment, "points_possible");
    patch_optional(target, "url", assignment, "html_url");
    patch_group(target, assignment, capture)?;
    patch_submission(target, assignment)?;
    Ok(item)
}

fn patch_due_at(target: &mut Map<String, Value>, assignment: &Value) -> Result<(), ReconcileError> {
    let Some(value) = assignment.get("due_at") else {
        return Ok(());
    };
    let local = if value.is_null() {
        Value::Null
    } else {
        let utc = value
            .as_str()
            .ok_or_else(|| invalid("Canvas due_at must be a string or null"))?;
        Value::String(utc_to_new_york(utc)?)
    };
    target.insert("at".to_owned(), local);
    Ok(())
}

fn patch_optional(target: &mut Map<String, Value>, local: &str, source: &Value, remote: &str) {
    if let Some(value) = source.get(remote) {
        target.insert(local.to_owned(), value.clone());
    }
}

fn patch_group(
    target: &mut Map<String, Value>,
    assignment: &Value,
    capture: &CourseAssignments,
) -> Result<(), ReconcileError> {
    let Some(group_id) = assignment.get("assignment_group_id") else {
        return Ok(());
    };
    if group_id.is_null() {
        target.insert("assignmentGroupId".to_owned(), Value::Null);
        target.insert("assignmentGroupName".to_owned(), Value::Null);
        target.insert("assignmentGroupWeight".to_owned(), Value::Null);
        return Ok(());
    }
    let id = identity_key(group_id).ok_or_else(|| invalid("assignment group id is invalid"))?;
    let group = capture
        .groups
        .iter()
        .find(|group| group.get("id").and_then(identity_key).as_deref() == Some(id.as_str()));
    target.insert("assignmentGroupId".to_owned(), group_id.clone());
    target.insert(
        "assignmentGroupName".to_owned(),
        group
            .and_then(|group| group.get("name"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    target.insert(
        "assignmentGroupWeight".to_owned(),
        group
            .and_then(|group| group.get("group_weight"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    Ok(())
}

fn patch_submission(
    target: &mut Map<String, Value>,
    assignment: &Value,
) -> Result<(), ReconcileError> {
    let Some(submission) = assignment.get("submission") else {
        // An absent field is not evidence that previously captured submission data disappeared.
        return Ok(());
    };
    if submission.is_null() {
        for field in [
            "submissionStatus",
            "submittedAt",
            "gradedAt",
            "grade",
            "score",
        ] {
            target.insert(field.to_owned(), Value::Null);
        }
        return Ok(());
    }
    let submission = submission
        .as_object()
        .ok_or_else(|| invalid("Canvas assignment submission must be an object or null"))?;
    for (remote, local) in [
        ("workflow_state", "submissionStatus"),
        ("submitted_at", "submittedAt"),
        ("graded_at", "gradedAt"),
        ("grade", "grade"),
        ("score", "score"),
    ] {
        if let Some(value) = submission.get(remote) {
            target.insert(local.to_owned(), value.clone());
        }
    }
    Ok(())
}

fn is_personal_live_item(kind: &str, source: &str) -> bool {
    matches!(kind, "session" | "milestone") || source == "manual"
}

fn move_to_archive(
    item: Value,
    archive: &mut Vec<Value>,
    archived_canvas_ids: &HashSet<(String, String)>,
) {
    let identity = item
        .get("course")
        .and_then(Value::as_str)
        .and_then(|course| {
            item.get("canvasId")
                .and_then(identity_key)
                .map(|canvas_id| (course.to_owned(), canvas_id))
        });
    if identity
        .as_ref()
        .is_some_and(|key| archived_canvas_ids.contains(key))
    {
        return;
    }
    archive.push(item);
}

fn kind_for(assignment: &Value) -> &'static str {
    let name = assignment
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let types = assignment
        .get("submission_types")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    let has = |words: &[&str]| {
        name.split(|character: char| !character.is_alphanumeric())
            .any(|token| words.contains(&token))
    };

    if has(&["discussion", "discussions", "forum", "forums"]) || types.contains("discussion_topic")
    {
        "discussion"
    } else if has(&["quiz", "quizzes", "test", "tests"]) || types.contains("online_quiz") {
        if has(&["exam", "midterm", "final"]) {
            "exam"
        } else {
            "quiz"
        }
    } else if has(&["exam", "exams", "midterm", "midterms", "final"]) {
        "exam"
    } else if has(&["lab", "labs", "laboratory", "laboratories"]) {
        "lab"
    } else if has(&["session", "sessions", "meeting", "meetings"]) {
        "session"
    } else if has(&["milestone", "milestones", "checkpoint", "checkpoints"]) {
        "milestone"
    } else if has(&["paper", "papers", "essay", "essays"]) {
        "paper"
    } else {
        "assignment"
    }
}

/// Convert a Canvas RFC 3339 timestamp into the local wall clock used by the coursework file.
fn utc_to_new_york(input: &str) -> Result<String, ReconcileError> {
    let timestamp = parse_rfc3339(input)?;
    let local = timestamp + i64::from(new_york_offset(timestamp));
    let days = local.div_euclid(86_400);
    let within_day = local.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = within_day / 3_600;
    let minute = (within_day % 3_600) / 60;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}"
    ))
}

fn new_york_date(time: SystemTime) -> Result<String, ReconcileError> {
    let timestamp = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_secs()).unwrap_or(i64::MAX),
    };
    let local = timestamp + i64::from(new_york_offset(timestamp));
    let (year, month, day) = civil_from_days(local.div_euclid(86_400));
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

/// RFC 3339 parser returning epoch seconds; fractional seconds are intentionally discarded.
fn parse_rfc3339(input: &str) -> Result<i64, ReconcileError> {
    let (date, time_and_zone) = input
        .split_once('T')
        .ok_or_else(|| invalid("Canvas due_at is not RFC 3339"))?;
    let mut date_parts = date.split('-');
    let year = parse_component(date_parts.next())?;
    let month = parse_component(date_parts.next())?;
    let day = parse_component(date_parts.next())?;
    if date_parts.next().is_some()
        || !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
    {
        return Err(invalid("Canvas due_at has an invalid date"));
    }

    let zone_start = time_and_zone
        .char_indices()
        .find(|(_, character)| matches!(character, 'Z' | '+' | '-'))
        .map(|(index, _)| index)
        .ok_or_else(|| invalid("Canvas due_at has no timezone"))?;
    let (clock, zone) = time_and_zone.split_at(zone_start);
    let clock = clock.strip_suffix('.').unwrap_or(clock);
    let mut clock_parts = clock.split(':');
    let hour = parse_component(clock_parts.next())?;
    let minute = parse_component(clock_parts.next())?;
    let second_text = clock_parts
        .next()
        .ok_or_else(|| invalid("Canvas due_at has no seconds"))?;
    let second = second_text
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| invalid("Canvas due_at has invalid seconds"))?;
    if clock_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return Err(invalid("Canvas due_at has an invalid time"));
    }

    let offset = if zone == "Z" || zone == "z" {
        0_i64
    } else {
        let sign = match zone.as_bytes().first() {
            Some(b'+') => 1_i64,
            Some(b'-') => -1_i64,
            _ => return Err(invalid("Canvas due_at has an invalid timezone")),
        };
        let (hours, minutes) = zone[1..]
            .split_once(':')
            .ok_or_else(|| invalid("Canvas due_at has an invalid timezone offset"))?;
        let hours = hours
            .parse::<i64>()
            .map_err(|_| invalid("Canvas due_at has an invalid timezone offset"))?;
        let minutes = minutes
            .parse::<i64>()
            .map_err(|_| invalid("Canvas due_at has an invalid timezone offset"))?;
        if hours > 23 || minutes > 59 {
            return Err(invalid("Canvas due_at has an invalid timezone offset"));
        }
        sign * (hours * 3_600 + minutes * 60)
    };

    let local_seconds = days_from_civil(year, month, day) * 86_400
        + i64::from(hour) * 3_600
        + i64::from(minute) * 60
        + i64::from(second);
    Ok(local_seconds - offset)
}

fn parse_component(value: Option<&str>) -> Result<u32, ReconcileError> {
    value
        .and_then(|text| text.parse::<u32>().ok())
        .ok_or_else(|| invalid("Canvas due_at has an invalid date or time component"))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn is_leap_year(year: u32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn new_york_offset(timestamp: i64) -> i32 {
    let (year, _, _) = civil_from_days(timestamp.div_euclid(86_400));
    let year = year as u32;
    if year < 2007 {
        return -5 * 3_600;
    }
    let march_second_sunday = nth_sunday(year, 3, 2);
    let november_first_sunday = nth_sunday(year, 11, 1);
    let starts_at = days_from_civil(year, 3, march_second_sunday) * 86_400 + 7 * 3_600;
    let ends_at = days_from_civil(year, 11, november_first_sunday) * 86_400 + 6 * 3_600;
    if (starts_at..ends_at).contains(&timestamp) {
        -4 * 3_600
    } else {
        -5 * 3_600
    }
}

fn nth_sunday(year: u32, month: u32, occurrence: u32) -> u32 {
    let first_weekday = weekday(days_from_civil(year, month, 1));
    1 + (7 - first_weekday) % 7 + 7 * (occurrence - 1)
}

fn weekday(days_since_epoch: i64) -> u32 {
    (days_since_epoch + 4).rem_euclid(7) as u32
}

fn days_from_civil(year: u32, month: u32, day: u32) -> i64 {
    let year = i64::from(year) - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    let year = year + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOCK: &str = include_str!("../../test/fixtures/refresh-canvas-mock.json");

    fn fixture_capture() -> (Value, Vec<CourseAssignments>) {
        let mock: Value = serde_json::from_str(MOCK).expect("synthetic fixture JSON");
        let base = mock["priorLocalState"]["coursework.json"].clone();
        let captures = mock["apiResponses"]
            .as_object()
            .expect("course captures")
            .iter()
            .map(|(key, response)| CourseAssignments {
                key: key.clone(),
                groups: response["assignment_groups"]["body"]
                    .as_array()
                    .expect("groups")
                    .clone(),
                assignments: response["assignments"]["body"]
                    .as_array()
                    .expect("assignments")
                    .iter()
                    .filter(|value| value.is_object() && value.get("id").is_some())
                    .cloned()
                    .collect(),
            })
            .collect();
        (base, captures)
    }

    fn captured_at() -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_secs(1_798_000_000)
    }

    #[test]
    fn fixture_reconciles_assignment_fields_and_keeps_personal_state() {
        let (mut base, captures) = fixture_capture();
        base["items"][0]["done"] = json!(true);
        base["items"][0]["doneAt"] = json!("2026-11-18T12:00:00Z");
        base["items"][0]["privateExtension"] = json!({"kept": true});

        let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
        let items = result["items"].as_array().expect("items");
        let retained = items
            .iter()
            .find(|item| item["canvasId"] == json!(70001))
            .expect("retained assignment");
        assert_eq!(retained["id"], "demo-alpha-70001");
        assert_eq!(retained["title"], "Draft Essay v2");
        assert_eq!(retained["at"], "2026-11-27T23:59");
        assert_eq!(retained["submissionStatus"], "graded");
        assert_eq!(retained["done"], true);
        assert_eq!(retained["doneAt"], "2026-11-18T12:00:00Z");
        assert_eq!(retained["privateExtension"]["kept"], true);
        assert!(items
            .iter()
            .any(|item| item["id"] == "demo-alpha-session-1"));
        assert!(!items.iter().any(|item| item["canvasId"] == json!(80001)));
        assert!(items
            .iter()
            .any(|item| item["id"] == "demo-alpha-canvas-70002"));
        assert_eq!(
            result["archivedForecastItems"][0]["id"],
            "demo-alpha-forecast-1"
        );
        assert_eq!(result["courses"][0]["gradeGroups"][0]["weight"], 40);
    }

    #[test]
    fn incomplete_course_capture_does_not_remove_omitted_course_items() {
        let (base, mut captures) = fixture_capture();
        captures.retain(|capture| capture.key == "demo-beta");
        let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
        assert!(result["items"].as_array().unwrap().iter().any(|item| {
            item["id"] == "demo-alpha-70001"
                || item["id"] == "demo-beta-80002"
                || item["canvasId"] == json!(80001)
        }));
        assert!(result["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "demo-alpha-forecast-1"));
    }

    #[test]
    fn vanished_canvas_items_are_archived_verbatim_and_old_archives_remain() {
        let (mut base, mut captures) = fixture_capture();
        captures
            .iter_mut()
            .find(|capture| capture.key == "demo-alpha")
            .unwrap()
            .assignments
            .retain(|assignment| assignment["id"] != 70001);
        base["items"][0]["done"] = json!(true);
        base["items"][0]["extension"] = json!("preserved");
        base["archivedForecastItems"] = json!([{"id":"older-archive","opaque":7}]);

        let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
        assert!(!result["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["canvasId"] == 70001));
        assert_eq!(result["archivedForecastItems"][0]["id"], "older-archive");
        assert_eq!(result["archivedForecastItems"][1]["done"], true);
        assert_eq!(result["archivedForecastItems"][1]["extension"], "preserved");
    }

    #[test]
    fn no_op_preserves_sync_timestamp_and_document_exactly() {
        let (base, captures) = fixture_capture();
        let once = reconcile_coursework(&base, &captures, captured_at()).expect("first reconcile");
        let again = reconcile_coursework(&once, &captures, captured_at()).expect("no-op reconcile");
        assert_eq!(again, once);
        assert_eq!(again["sync"]["lastSync"], once["sync"]["lastSync"]);
    }

    #[test]
    fn omitted_submission_fields_and_unknown_group_fields_survive() {
        let (mut base, mut captures) = fixture_capture();
        let alpha = captures
            .iter_mut()
            .find(|capture| capture.key == "demo-alpha")
            .unwrap();
        alpha.assignments[0]
            .as_object_mut()
            .unwrap()
            .remove("submission");
        base["courses"][0]["courseExtension"] = json!("keep");
        base["courses"][0]["gradeGroups"] = json!([
            {"id":601,"name":"Old label","weight":10,"groupExtension":"keep"},
            {"id":777,"localOnly":true}
        ]);

        let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
        let retained = result["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["canvasId"] == 70001)
            .unwrap();
        assert_eq!(retained["submissionStatus"], "pending");
        assert_eq!(result["courses"][0]["courseExtension"], "keep");
        assert_eq!(result["courses"][0]["gradeGroups"][0]["name"], "Essays");
        assert_eq!(
            result["courses"][0]["gradeGroups"][0]["groupExtension"],
            "keep"
        );
        assert_eq!(result["courses"][0]["gradeGroups"][1]["localOnly"], true);
    }

    #[test]
    fn error_display_does_not_include_course_identity() {
        let base = json!({"courses":[],"items":[]});
        let capture = CourseAssignments {
            key: "SYNTHETIC_PRIVATE_COURSE_KEY".to_owned(),
            groups: Vec::new(),
            assignments: Vec::new(),
        };
        let error = reconcile_coursework(&base, &[capture], captured_at()).unwrap_err();
        assert!(!error.to_string().contains("SYNTHETIC_PRIVATE_COURSE_KEY"));
    }

    #[test]
    fn generated_item_id_collision_fails_closed() {
        let (mut base, captures) = fixture_capture();
        base["items"].as_array_mut().unwrap().push(json!({
            "id": "demo-alpha-canvas-70002",
            "course": "demo-alpha",
            "source": "manual",
            "title": "Local item"
        }));

        let error = reconcile_coursework(&base, &captures, captured_at()).unwrap_err();
        assert_eq!(
            error.to_string(),
            "generated coursework item id collides with an existing item"
        );
    }

    #[test]
    fn date_conversion_observes_eastern_standard_and_daylight_time() {
        assert_eq!(
            utc_to_new_york("2026-11-28T04:59:00Z").unwrap(),
            "2026-11-27T23:59"
        );
        assert_eq!(
            utc_to_new_york("2026-07-01T16:00:00Z").unwrap(),
            "2026-07-01T12:00"
        );
        assert_eq!(
            utc_to_new_york("2026-01-01T04:00:00+00:00").unwrap(),
            "2025-12-31T23:00"
        );
    }

    #[test]
    fn kind_inference_uses_name_and_submission_type_fallback() {
        assert_eq!(
            kind_for(&json!({"name":"Draft Essay", "submission_types":["online_upload"]})),
            "paper"
        );
        assert_eq!(
            kind_for(
                &json!({"name":"Reading Reflection 3", "submission_types":["online_text_entry"]})
            ),
            "assignment"
        );
        assert_eq!(
            kind_for(&json!({"name":"Untitled", "submission_types":["online_quiz"]})),
            "quiz"
        );
    }
}
