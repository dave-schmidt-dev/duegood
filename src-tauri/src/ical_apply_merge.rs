//! Exact identity matching and atomic in-memory reconciliation for iCal observations.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use crate::ical::{IcalNormalization, IcalNormalizeOptions};
use crate::store::StoreError;

use super::facts::*;
use super::refs::*;

pub(super) struct MergeResult {
    pub changed: bool,
    pub added: usize,
    pub updated: usize,
    pub held: usize,
}

pub(super) fn apply_to_document(
    document: &mut Value,
    options: &IcalNormalizeOptions,
    finished_at: &str,
    normalized: &IcalNormalization,
) -> Result<MergeResult, StoreError> {
    let root = document.as_object_mut().ok_or(StoreError::Invalid(
        "native coursework document is malformed",
    ))?;
    if !root.get("items").is_some_and(Value::is_array) {
        return Err(StoreError::Invalid("native coursework items are malformed"));
    }
    let courses = root
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(StoreError::Invalid(
            "native coursework courses are malformed",
        ))?;
    let coursework_courses = courses
        .iter()
        .map(|course| {
            let object = course.as_object().ok_or(StoreError::Invalid(
                "native coursework courses are malformed",
            ))?;
            let key = object
                .get("key")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 160)
                .ok_or(StoreError::Invalid(
                    "native coursework courses are malformed",
                ))?;
            Ok((
                key.to_owned(),
                object.get("canvasCourseId").and_then(canvas_id),
            ))
        })
        .collect::<Result<HashMap<_, _>, StoreError>>()?;
    let course_ids = options
        .courses
        .iter()
        .map(|course| {
            if !coursework_courses.contains_key(&course.key)
                || !numeric_id(&course.canvas_course_id)
            {
                return Err(StoreError::Invalid(
                    "calendar course identity does not match coursework",
                ));
            }
            if coursework_courses
                .get(&course.key)
                .and_then(Option::as_deref)
                .is_some_and(|id| id != course.canvas_course_id)
            {
                return Err(StoreError::Invalid(
                    "calendar course identity conflicts with coursework",
                ));
            }
            Ok((course.key.clone(), course.canvas_course_id.clone()))
        })
        .collect::<Result<HashMap<_, _>, StoreError>>()?;
    let mut items_by_id = HashMap::<String, Value>::new();
    let mut owners = HashMap::<RefKey, String>::new();
    for collection in ["items", "archivedForecastItems"] {
        let Some(values) = root.get(collection) else {
            continue;
        };
        let values = values
            .as_array()
            .ok_or(StoreError::Invalid("native coursework items are malformed"))?;
        for value in values {
            let item = value
                .as_object()
                .ok_or(StoreError::Invalid("native coursework items are malformed"))?;
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 200)
                .ok_or(StoreError::Invalid("native coursework items are malformed"))?;
            if items_by_id.insert(id.to_owned(), value.clone()).is_some() {
                return Err(StoreError::Invalid(
                    "native coursework item IDs are duplicated",
                ));
            }
            for reference in item_references(item)? {
                let key = reference_key(reference)?;
                if owners.insert(key, id.to_owned()).is_some() {
                    return Err(StoreError::Invalid(
                        "native coursework source references are duplicated",
                    ));
                }
            }
        }
    }
    let mut incoming = HashSet::new();
    let mut changed = false;
    let mut added = 0;
    let mut updated = 0;
    let mut held = 0;
    let mut unresolved = existing_pending_keys(root)?;

    for observation in &normalized.observations {
        let (mut local_id, course, reference, fields) =
            checked_observation(observation, &options.institution, &coursework_courses)?;
        let primary_key = reference_key(&reference)?;
        if !incoming.insert(primary_key.clone()) {
            return Err(StoreError::Invalid(
                "calendar source reference is duplicated",
            ));
        }
        for (field, value) in fields {
            let _ = field;
            if !json_value(value) {
                return Err(StoreError::Invalid("calendar source field is malformed"));
            }
        }

        let local_id_owner = items_by_id
            .contains_key(&local_id)
            .then(|| local_id.clone());
        let mut verified = HashSet::<String>::new();
        if let Some(owner) = owners.get(&primary_key) {
            verified.insert(owner.clone());
        }
        if let Some(canvas_reference) = assignment_canvas_reference(&reference)? {
            if let Some(owner) = owners.get(&reference_key(&canvas_reference)?) {
                verified.insert(owner.clone());
            }
        }
        let alias_candidates = exact_canvas_assignment_candidates(
            &root["items"],
            root.get("archivedForecastItems"),
            &course,
            &reference,
            course_ids.get(&course),
            &options.canvas_origin,
            observation,
        )?;
        verified.extend(alias_candidates.iter().cloned());
        let mut candidates = verified.iter().cloned().collect::<Vec<_>>();
        candidates.sort();

        let pending = unresolved.contains(&primary_key);
        let local_id_collision = local_id_owner.as_ref().is_some_and(|owner| {
            !verified.contains(owner) || verified.iter().any(|match_id| match_id != owner)
        });
        if local_id_collision {
            candidates.push(local_id.clone());
            candidates.sort();
            candidates.dedup();
        }
        let conflict = local_id_collision
            || verified.len() > 1
            || verified.iter().any(|id| {
                items_by_id
                    .get(id)
                    .and_then(|item| item.get("course"))
                    .and_then(Value::as_str)
                    != Some(course.as_str())
            });
        if pending || conflict {
            changed |= write_pending(
                root,
                &primary_key,
                &local_id,
                &course,
                &reference,
                observation.get("fields").expect("validated fields"),
                finished_at,
                &candidates,
                if conflict {
                    "conflicting-match"
                } else {
                    "ambiguous-match"
                },
            )?;
            unresolved.insert(primary_key);
            held += 1;
            continue;
        }

        if let Some(match_id) = verified.iter().next() {
            local_id = match_id.clone();
        }
        if !items_by_id.contains_key(&local_id) {
            let mut item = Map::new();
            item.insert("id".into(), Value::String(local_id.clone()));
            item.insert("course".into(), Value::String(course.clone()));
            item.insert("source".into(), Value::String("ical".into()));
            root.get_mut("items")
                .and_then(Value::as_array_mut)
                .ok_or(StoreError::Invalid("native coursework items are malformed"))?
                .push(Value::Object(item.clone()));
            items_by_id.insert(local_id.clone(), Value::Object(item));
            added += 1;
            changed = true;
        }
        let item = item_mut(root, &local_id)?;
        if item.get("course").and_then(Value::as_str) != Some(course.as_str()) {
            return Err(StoreError::Invalid(
                "calendar source item belongs to another course",
            ));
        }
        let mut linked = append_reference(item, &reference)?;
        if let Some(canvas_reference) = assignment_canvas_reference(&reference)? {
            linked |= append_reference(item, &canvas_reference)?;
            owners.insert(reference_key(&canvas_reference)?, local_id.clone());
        }
        if linked {
            owners.insert(primary_key.clone(), local_id.clone());
            changed = true;
        }
        let (field_count, facts_changed) =
            merge_fields(item, &reference, observation, finished_at)?;
        if facts_changed {
            updated += field_count;
            changed = true;
        }
        unresolved.remove(&primary_key);
    }
    Ok(MergeResult {
        changed,
        added,
        updated,
        held,
    })
}

fn checked_observation<'a>(
    observation: &'a Value,
    institution: &str,
    courses: &HashMap<String, Option<String>>,
) -> Result<(String, String, Value, &'a Map<String, Value>), StoreError> {
    let object = observation
        .as_object()
        .ok_or(StoreError::Invalid("calendar observation is malformed"))?;
    let text = |field: &str, max: usize| {
        object
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= max)
            .map(str::to_owned)
            .ok_or(StoreError::Invalid("calendar observation is malformed"))
    };
    let local_id = text("localId", 200)?;
    let course = text("course", 160)?;
    if !courses.contains_key(&course) {
        return Err(StoreError::Invalid(
            "calendar observation course is unknown",
        ));
    }
    let reference = object
        .get("reference")
        .filter(|reference| {
            reference.get("institution").and_then(Value::as_str) == Some(institution)
                && reference.get("course").and_then(Value::as_str) == Some(course.as_str())
                && reference.get("source").and_then(Value::as_str) == Some("ical")
        })
        .cloned()
        .ok_or(StoreError::Invalid("calendar observation scope is invalid"))?;
    let _ = reference_key(&reference)?;
    let fields = object
        .get("fields")
        .and_then(Value::as_object)
        .ok_or(StoreError::Invalid(
            "calendar observation fields are malformed",
        ))?;
    if fields
        .keys()
        .any(|field| !SOURCE_FIELDS.contains(&field.as_str()))
    {
        return Err(StoreError::Invalid(
            "calendar observation contains an unsupported field",
        ));
    }
    Ok((local_id, course, reference, fields))
}

fn exact_canvas_assignment_candidates(
    active: &Value,
    archived: Option<&Value>,
    course: &str,
    reference: &Value,
    expected_course_id: Option<&String>,
    expected_origin: &str,
    observation: &Value,
) -> Result<Vec<String>, StoreError> {
    let Some(assignment_id) = reference
        .get("id")
        .and_then(Value::as_str)
        .and_then(|id| id.strip_prefix("assignment:"))
        .filter(|id| numeric_id(id))
    else {
        return Ok(Vec::new());
    };
    let Some(canvas_course_id) = expected_course_id else {
        return Ok(Vec::new());
    };
    let Some(url) = observation
        .get("fields")
        .and_then(|fields| fields.get("url"))
        .and_then(Value::as_str)
    else {
        return Ok(Vec::new());
    };
    let expected_path = format!("/courses/{canvas_course_id}/assignments/{assignment_id}");
    let url = url::Url::parse(url)
        .map_err(|_| StoreError::Invalid("calendar assignment URL is invalid"))?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != expected_path
        || url.origin().ascii_serialization() != expected_origin
    {
        return Ok(Vec::new());
    }
    let mut matches = Vec::new();
    for values in std::iter::once(Some(active)).chain(std::iter::once(archived)) {
        let Some(values) = values else { continue };
        let values = values
            .as_array()
            .ok_or(StoreError::Invalid("native coursework items are malformed"))?;
        for item in values {
            if item.get("course").and_then(Value::as_str) == Some(course)
                && item.get("canvasId").and_then(canvas_id).as_deref() == Some(assignment_id)
            {
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Invalid("native coursework item is malformed"))?;
                matches.push(id.to_owned());
            }
        }
    }
    matches.sort();
    matches.dedup();
    if matches.len() > MAX_PENDING_CANDIDATES {
        return Err(StoreError::Invalid(
            "calendar assignment has too many exact candidates",
        ));
    }
    Ok(matches)
}

fn assignment_canvas_reference(reference: &Value) -> Result<Option<Value>, StoreError> {
    let Some(id) = reference
        .get("id")
        .and_then(Value::as_str)
        .and_then(|id| id.strip_prefix("assignment:"))
        .filter(|id| numeric_id(id))
    else {
        return Ok(None);
    };
    Ok(Some(json!({
        "institution": reference.get("institution").and_then(Value::as_str).ok_or(StoreError::Invalid("calendar source reference is malformed"))?,
        "course": reference.get("course").and_then(Value::as_str).ok_or(StoreError::Invalid("calendar source reference is malformed"))?,
        "source": "canvas",
        "id": id,
    })))
}
