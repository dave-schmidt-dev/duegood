//! Pure reconciliation of a complete Canvas coursework capture into the local document.
//!
//! The caller must pass every successfully captured assignment for each course it supplies.
//! A course omitted from `courses` is left untouched, so a failed course capture cannot make
//! its existing work disappear. Canvas submission fields are separate from local completion.
//! Cross-source adoption is exact: a legacy Canvas ID, a scoped Canvas reference, or a scoped
//! iCal `assignment:<Canvas ID>` reference. Titles and dates are never identity evidence.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::time::SystemTime;

use serde_json::{json, Map, Value};

#[path = "reconcile_body.rs"]
mod body;
#[path = "reconcile_dates.rs"]
mod dates;
#[path = "reconcile_discussions.rs"]
mod discussions;
#[path = "reconcile_due_facts.rs"]
mod due_facts;
#[path = "reconcile_identity.rs"]
mod identity;

use dates::new_york_date;
use due_facts::{patch_due_at, patch_optional};
use identity::{
    append_canvas_reference, identity_key, item_matches_assignment, revivable_archived_index,
    same_canvas_identity, validate_source_references,
};

/// One fully captured course's assignment data.
#[derive(Debug, Clone, PartialEq)]
pub struct CourseAssignments {
    /// Stable local course key.
    pub key: String,
    /// Complete Canvas assignment-group response.
    pub groups: Vec<Value>,
    /// Complete Canvas assignments response, including each submission projection.
    pub assignments: Vec<Value>,
    /// Complete accessible discussion topics not represented by a Canvas assignment.
    pub discussions: Vec<Value>,
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
            let canvas_type = object
                .get("canvasResourceType")
                .or_else(|| object.get("canvasType"))
                .and_then(Value::as_str)
                .unwrap_or("assignment");
            if !matches!(canvas_type, "assignment" | "discussion") {
                return Err(invalid("coursework Canvas item type is invalid"));
            }
            if let (Some(course), Some(canvas_id)) = (
                object.get("course").and_then(Value::as_str),
                object.get("canvasId").and_then(identity_key),
            ) {
                if !existing_canvas_ids.insert((
                    course.to_owned(),
                    canvas_type.to_owned(),
                    canvas_id,
                )) {
                    return Err(invalid("duplicate local Canvas assignment identity"));
                }
            }
        }
    }

    let mut archive_existing = root
        .get("archivedForecastItems")
        .map(|archive| {
            archive
                .as_array()
                .ok_or_else(|| invalid("archivedForecastItems must be an array"))
        })
        .transpose()?
        .cloned()
        .unwrap_or_default();
    validate_source_references(&local_items, &archive_existing)?;

    // Resolve every link before mutating anything. This makes a duplicate Canvas/iCal claim a
    // transaction failure rather than a choice based on input order.
    let mut assignment_matches = HashMap::<(String, String), usize>::new();
    for capture in courses {
        for assignment in &capture.assignments {
            let canvas_id = identity_key(assignment.get("id").expect("assignment id validated"))
                .expect("assignment id validated");
            let matching: Vec<usize> = local_items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    match item_matches_assignment(item, &capture.key, &canvas_id) {
                        Ok(true) => Some(index),
                        Ok(false) | Err(_) => None,
                    }
                })
                .collect();
            // A malformed reference is just as unsafe as two apparently valid candidates.
            if local_items
                .iter()
                .any(|item| item_matches_assignment(item, &capture.key, &canvas_id).is_err())
            {
                return Err(invalid("coursework source reference is malformed"));
            }
            match matching.as_slice() {
                [] => {}
                [index] => {
                    assignment_matches.insert((capture.key.clone(), canvas_id), *index);
                }
                _ => {
                    return Err(invalid(
                        "Canvas assignment has conflicting local identities",
                    ))
                }
            }
        }
    }
    // Archived ids stay reserved: a generated id must never duplicate one (INV-3).
    let archived_item_ids: HashSet<String> = archive_existing
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();

    let mut seen = HashSet::<(String, String)>::new();
    let mut next_items = Vec::with_capacity(local_items.len());
    let mut newly_archived = Vec::new();
    let mut archive_changed = false;

    for (item_index, mut item) in local_items.iter().cloned().enumerate() {
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
            let Some(key) = key else {
                // An incomplete identity is not safe to delete or remap.
                next_items.push(item);
                continue;
            };
            let Some(capture) = captures.get(key.as_str()) else {
                // This course was not captured in this call.
                next_items.push(item);
                continue;
            };
            if object
                .get("canvasResourceType")
                .or_else(|| object.get("canvasType"))
                .and_then(Value::as_str)
                == Some("discussion")
            {
                next_items.push(item);
                continue;
            }
            let matched = capture.assignments.iter().find_map(|assignment| {
                let id = assignment.get("id").and_then(identity_key)?;
                (assignment_matches.get(&(key.clone(), id.clone())) == Some(&item_index))
                    .then_some((assignment, id))
            });
            if let Some((assignment, matched_id)) = matched {
                let ignored = ignored_ids(&local_courses, &key)?;
                if ignored.contains(&matched_id) {
                    newly_archived.push(item);
                    continue;
                }
                update_item(&mut item, assignment, capture, &matched_id, captured_at)?;
                seen.insert((key, matched_id));
                next_items.push(item);
            } else {
                // A legacy source="canvas" item without an exact identity is still not safe to
                // overwrite, but a complete course may archive a verified old Canvas item.
                if canvas_id.is_none() {
                    next_items.push(item);
                    continue;
                }
                newly_archived.push(item);
            }
            continue;
        }

        if let Some(key) = key.as_deref() {
            if let Some(capture) = captures.get(key) {
                if let Some((assignment, canvas_id)) =
                    capture.assignments.iter().find_map(|assignment| {
                        let id = assignment.get("id").and_then(identity_key)?;
                        (assignment_matches.get(&(key.to_owned(), id.clone())) == Some(&item_index))
                            .then_some((assignment, id))
                    })
                {
                    let ignored = ignored_ids(&local_courses, key)?;
                    if ignored.contains(&canvas_id) {
                        // An iCal-only item is never archived merely because a rolling iCal
                        // window omits it. An explicit ignored Canvas ID also must not create a
                        // competing native item, so retain the iCal record unchanged.
                        next_items.push(item);
                    } else {
                        update_item(&mut item, assignment, capture, &canvas_id, captured_at)?;
                        seen.insert((key.to_owned(), canvas_id));
                        next_items.push(item);
                    }
                    continue;
                }
            }
        }

        if source == "syllabus" {
            if key.as_deref().is_some_and(|key| captures.contains_key(key)) {
                newly_archived.push(item);
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
            // A republished assignment revives its archived record so completion, notes, and
            // extensions survive instead of being recreated as a not-done duplicate (INV-3).
            let revived = revivable_archived_index(
                &archive_existing,
                &capture.key,
                "assignment",
                &canvas_id,
            )?
            .map(|index| archive_existing.remove(index));
            let was_revived = revived.is_some();
            let item = match revived {
                Some(mut archived_item) => {
                    update_item(
                        &mut archived_item,
                        assignment,
                        capture,
                        &canvas_id,
                        captured_at,
                    )?;
                    archive_changed = true;
                    archived_item
                }
                None => new_item(&capture.key, assignment, capture, &canvas_id, captured_at)?,
            };
            let generated_id = item["id"]
                .as_str()
                .expect("new item id is a string")
                .to_owned();
            if (!was_revived && archived_item_ids.contains(&generated_id))
                || !item_ids.insert(generated_id)
            {
                return Err(invalid(
                    "generated coursework item id collides with an existing item",
                ));
            }
            seen.insert(identity);
            next_items.push(item);
        }
    }

    root.insert("items".to_owned(), Value::Array(next_items));
    if !newly_archived.is_empty() || archive_changed {
        let mut archived = archive_existing;
        // A second vanish replaces the older archived copy of the same Canvas assignment rather
        // than dropping the live item (INV-3).
        archived.retain(|old| {
            !newly_archived
                .iter()
                .any(|fresh| same_canvas_identity(old, fresh))
        });
        archived.extend(newly_archived);
        root.insert("archivedForecastItems".to_owned(), Value::Array(archived));
    }
    discussions::merge(root, courses)?;

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
    discussions::validate(&capture.discussions)?;
    Ok(())
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
    captured_at: SystemTime,
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
        "canvasResourceType".to_owned(),
        Value::String("assignment".to_owned()),
    );
    target.insert(
        "confidence".to_owned(),
        Value::String("confirmed".to_owned()),
    );
    target.insert("canvasId".to_owned(), assignment["id"].clone());
    let canvas_reference = append_canvas_reference(target, &capture.key, canvas_id)?;
    patch_due_at(target, assignment, canvas_reference.as_ref(), captured_at)?;
    patch_optional(target, "points", assignment, "points_possible");
    patch_optional(target, "url", assignment, "html_url");
    body::patch_assignment_metadata(target, assignment);
    body::patch_body_and_timestamps(target, assignment);
    patch_group(target, assignment, capture)?;
    patch_submission(target, assignment)?;
    patch_rubric(target, assignment);
    // `canvas_id` is already used to verify the match and intentionally not used to rewrite id.
    let _ = canvas_id;
    Ok(())
}

fn new_item(
    course_key: &str,
    assignment: &Value,
    capture: &CourseAssignments,
    canvas_id: &str,
    captured_at: SystemTime,
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
        "canvasResourceType": "assignment",
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
    // Older documents have no verified institution scope. Do not invent one solely to attach a
    // provenance record; linked iCal records supply a verified scope during adoption.
    patch_due_at(target, assignment, None, captured_at)?;
    patch_optional(target, "points", assignment, "points_possible");
    patch_optional(target, "url", assignment, "html_url");
    body::patch_assignment_metadata(target, assignment);
    body::patch_body_and_timestamps(target, assignment);
    patch_group(target, assignment, capture)?;
    patch_submission(target, assignment)?;
    patch_rubric(target, assignment);
    Ok(item)
}

fn patch_rubric(target: &mut Map<String, Value>, assignment: &Value) {
    let Some(criteria) = assignment.get("rubric") else {
        return;
    };
    let rubric = if criteria.is_null() {
        Value::Null
    } else {
        let settings = assignment.get("rubric_settings").and_then(Value::as_object);
        json!({
            "criteria": criteria,
            "settings": settings.map(|settings| json!({
                "title": settings.get("title").cloned().unwrap_or(Value::Null),
                "pointsPossible": settings.get("points_possible").cloned().unwrap_or(Value::Null),
                "freeFormCriterionComments": settings.get("free_form_criterion_comments").cloned().unwrap_or(Value::Null)
            })),
            "useForGrading": assignment.get("use_rubric_for_grading").cloned().unwrap_or(Value::Null)
        })
    };
    target.insert("rubric".to_owned(), rubric);
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

#[cfg(test)]
#[path = "reconcile_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "reconcile_content_tests.rs"]
mod content_tests;
