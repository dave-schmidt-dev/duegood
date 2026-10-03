//! Read-only derivation of verified calendar scope from native imported documents.

use std::collections::{HashMap, HashSet};

use chrono::DateTime;
use serde_json::Value;

use crate::canvas::CANVAS_ORIGIN;
use crate::config::{ReadLimits, COURSEWORK_FILE};
use crate::ical::{
    EventKind, ExplicitFeedIdentity, IcalCourseIdentity, IcalNormalizeOptions, MAX_ICAL_EVENTS,
};
use crate::store::{Store, StoreCondition, StoreError};

use super::facts::{canvas_id, numeric_id, validate_text};
use super::IcalApplyError;

/// Builds iCal identities only from the imported fixed course map and the existing coursework
/// document. The institution scope must already appear in source provenance; absent or mixed
/// provenance is a setup blocker, never guessed from a display name or private configuration.
pub(crate) fn normalization_options(store: &Store) -> Result<IcalNormalizeOptions, IcalApplyError> {
    let _read_lock = store.read_lock()?;
    normalization_options_locked(store)
}

pub(super) fn normalization_options_locked(
    store: &Store,
) -> Result<IcalNormalizeOptions, IcalApplyError> {
    if !matches!(
        store.condition()?,
        StoreCondition::Ready(ref manifest) if manifest.state == crate::store::StoreState::Authoritative
    ) {
        return Err(IcalApplyError::StoreNotAuthoritative);
    }
    let courses_bytes = store
        .read_document("courses.json", 1024 * 1024)?
        .ok_or(StoreError::Invalid("the native course map is missing"))?;
    let coursework_bytes = store
        .read_document(COURSEWORK_FILE, ReadLimits::PRODUCTION.max_document_bytes)?
        .ok_or(StoreError::Invalid(
            "the native coursework document is missing",
        ))?;
    let course_map: Value = serde_json::from_slice(&courses_bytes.bytes)
        .map_err(|_| StoreError::Invalid("the native course map is invalid"))?;
    let coursework: Value = serde_json::from_slice(&coursework_bytes.bytes)
        .map_err(|_| StoreError::Invalid("the native coursework document is invalid"))?;
    let memberships =
        coursework
            .get("courses")
            .and_then(Value::as_array)
            .ok_or(StoreError::Invalid(
                "native coursework courses are malformed",
            ))?;
    let membership_keys = memberships
        .iter()
        .map(|entry| {
            entry
                .get("key")
                .and_then(Value::as_str)
                .filter(|key| !key.is_empty() && key.len() <= 160)
                .map(str::to_owned)
                .ok_or(StoreError::Invalid(
                    "native coursework courses are malformed",
                ))
        })
        .collect::<Result<HashSet<_>, _>>()?;
    if membership_keys.len() != memberships.len() {
        return Err(StoreError::Invalid("native coursework course keys are duplicated").into());
    }
    let mapped = course_map
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(StoreError::Invalid("native course map is malformed"))?;
    let mut mappings = HashMap::<String, String>::new();
    for entry in mapped {
        let key = entry
            .get("key")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 160)
            .ok_or(StoreError::Invalid("native course map is malformed"))?;
        let id = entry
            .get("canvasId")
            .and_then(canvas_id)
            .filter(|value| numeric_id(value))
            .ok_or(StoreError::Invalid("native course map is malformed"))?;
        if !membership_keys.contains(key) || mappings.insert(key.to_owned(), id).is_some() {
            return Err(StoreError::Invalid("native course map does not match coursework").into());
        }
    }
    let courses = mappings
        .into_iter()
        .map(|(key, canvas_course_id)| IcalCourseIdentity {
            key,
            canvas_course_id,
        })
        .collect::<Vec<_>>();
    let mut courses = courses;
    courses.sort_by(|left, right| left.key.cmp(&right.key));
    if courses.is_empty() {
        return Err(StoreError::Invalid("the native course map has no Canvas courses").into());
    }
    let scope_courses: HashSet<_> = courses.iter().map(|course| course.key.as_str()).collect();
    let mut institutions = HashSet::new();
    for collection in ["items", "archivedForecastItems"] {
        let Some(items) = coursework.get(collection).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let Some(course) = item.get("course").and_then(Value::as_str) else {
                continue;
            };
            if !scope_courses.contains(course) {
                continue;
            }
            if let Some(references) = item.get("sourceReferences").and_then(Value::as_array) {
                for reference in references {
                    if matches!(
                        reference.get("source").and_then(Value::as_str),
                        Some("canvas" | "ical")
                    ) {
                        if let Some(institution) =
                            reference.get("institution").and_then(Value::as_str)
                        {
                            institutions.insert(institution.to_owned());
                        }
                    }
                }
            }
        }
    }
    if institutions.len() != 1 {
        return Err(StoreError::Invalid(
            "the native institution scope is unavailable or ambiguous",
        )
        .into());
    }
    let institution = institutions
        .into_iter()
        .next()
        .expect("one institution checked");
    validate_text(&institution, 160)?;
    let explicit_uid_mappings =
        verified_calendar_event_mappings(store, &institution, &courses, memberships)?;
    Ok(IcalNormalizeOptions {
        institution,
        canvas_origin: CANVAS_ORIGIN.to_owned(),
        courses,
        verified_events: HashMap::new(),
        explicit_uid_mappings,
    })
}

fn verified_calendar_event_mappings(
    store: &Store,
    institution: &str,
    courses: &[IcalCourseIdentity],
    memberships: &[Value],
) -> Result<HashMap<String, ExplicitFeedIdentity>, IcalApplyError> {
    let Some(status_bytes) = store.read_document("browser-capture-status.json", 1024 * 1024)?
    else {
        return Ok(HashMap::new());
    };
    let Ok(status) = serde_json::from_slice::<Value>(&status_bytes.bytes) else {
        return Ok(HashMap::new());
    };
    if !valid_capture_status(&status) {
        return Ok(HashMap::new());
    }

    let mut mappings = HashMap::new();
    let mut conflicts = HashSet::new();
    for course in courses {
        let Some(folder) = projected_course_folder(memberships, &course.key) else {
            continue;
        };
        let path = format!("{folder}/canvas-export/api/calendar-event-identities.json");
        let Some(bytes) = store.read_document(&path, ReadLimits::PRODUCTION.max_document_bytes)?
        else {
            continue;
        };
        let Ok(document) = serde_json::from_slice::<Value>(&bytes.bytes) else {
            continue;
        };
        if !valid_identity_document(&document, &status, institution, course) {
            continue;
        }
        let Some(events) = document.get("events").and_then(Value::as_array) else {
            continue;
        };
        if events.len() > MAX_ICAL_EVENTS {
            continue;
        }
        let mut id_counts = HashMap::<String, usize>::new();
        for event in events {
            if let Some(id) = event
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| numeric_id(id))
            {
                *id_counts.entry(id.to_owned()).or_default() += 1;
            }
        }
        let expected_context = format!("course_{}", course.canvas_course_id);
        for event in events {
            let Some(id) = event
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| numeric_id(id))
            else {
                continue;
            };
            let uid = format!("event-calendar-event-{id}");
            let Some(start_at) = event.get("startAt").and_then(Value::as_str) else {
                continue;
            };
            if id_counts.get(id) != Some(&1)
                || event.get("uid").and_then(Value::as_str) != Some(uid.as_str())
                || event.get("contextCode").and_then(Value::as_str)
                    != Some(expected_context.as_str())
                || event.get("type").and_then(Value::as_str) != Some("event")
                || event.get("allDay").and_then(Value::as_bool) != Some(true)
                || start_at.len() > 64
            {
                continue;
            }
            let Ok(start_at) = DateTime::parse_from_rfc3339(start_at) else {
                continue;
            };
            let expected_date = start_at.date_naive().format("%Y-%m-%d").to_string();
            let mapping = ExplicitFeedIdentity {
                course_key: course.key.clone(),
                stable_identity: format!("event:{id}"),
                kind: EventKind::OtherEvent,
                expected_date: Some(expected_date),
            };
            if conflicts.contains(&uid) {
                continue;
            }
            if mappings.insert(uid.clone(), mapping).is_some() {
                mappings.remove(&uid);
                conflicts.insert(uid);
            }
        }
    }
    Ok(mappings)
}

fn valid_capture_status(status: &Value) -> bool {
    status.get("format").and_then(Value::as_str) == Some("duegood-browser-import")
        && status.get("version").and_then(Value::as_u64) == Some(1)
        && status
            .get("runId")
            .and_then(Value::as_u64)
            .is_some_and(|id| id > 0)
        && status
            .get("userId")
            .and_then(Value::as_u64)
            .is_some_and(|id| id > 0)
        && status
            .get("generationId")
            .and_then(Value::as_str)
            .is_some_and(valid_generation_id)
}

fn valid_identity_document(
    document: &Value,
    status: &Value,
    institution: &str,
    course: &IcalCourseIdentity,
) -> bool {
    let expected_context = format!("course_{}", course.canvas_course_id);
    document.get("format").and_then(Value::as_str) == Some("duegood-calendar-event-identities")
        && document.get("version").and_then(Value::as_u64) == Some(1)
        && ["runId", "generationId", "userId"]
            .iter()
            .all(|field| document.get(*field) == status.get(*field))
        && document.get("origin").and_then(Value::as_str) == Some(CANVAS_ORIGIN)
        && document.get("institution").and_then(Value::as_str) == Some(institution)
        && document.get("courseKey").and_then(Value::as_str) == Some(course.key.as_str())
        && document.get("canvasCourseId").and_then(Value::as_u64)
            == course.canvas_course_id.parse::<u64>().ok()
        && document
            .pointer("/coverage/endpoint")
            .and_then(Value::as_str)
            == Some("calendarEvents")
        && document
            .pointer("/coverage/contextCode")
            .and_then(Value::as_str)
            == Some(expected_context.as_str())
        && document.pointer("/coverage/status").and_then(Value::as_str) == Some("complete")
}

fn valid_generation_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn projected_course_folder(memberships: &[Value], course_key: &str) -> Option<String> {
    let matches = memberships
        .iter()
        .filter(|entry| entry.get("key").and_then(Value::as_str) == Some(course_key))
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return None;
    }
    let folder = matches[0].get("folder").and_then(Value::as_str)?;
    let name = folder.strip_prefix("classes/")?;
    if name.contains('/') || !crate::import::is_course_folder_name(name) {
        return None;
    }
    Some(folder.to_owned())
}

pub(super) fn same_scope(expected: &IcalNormalizeOptions, current: &IcalNormalizeOptions) -> bool {
    if expected.institution != current.institution
        || expected.canvas_origin != current.canvas_origin
    {
        return false;
    }
    let mut expected_courses = expected
        .courses
        .iter()
        .map(|course| (&course.key, &course.canvas_course_id))
        .collect::<Vec<_>>();
    let mut current_courses = current
        .courses
        .iter()
        .map(|course| (&course.key, &course.canvas_course_id))
        .collect::<Vec<_>>();
    expected_courses.sort();
    current_courses.sort();
    expected_courses == current_courses
        && expected.explicit_uid_mappings == current.explicit_uid_mappings
}
