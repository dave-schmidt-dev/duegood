//! Read-only derivation of verified calendar scope from native imported documents.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::canvas::CANVAS_ORIGIN;
use crate::config::{ReadLimits, COURSEWORK_FILE};
use crate::ical::{IcalCourseIdentity, IcalNormalizeOptions};
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
    Ok(IcalNormalizeOptions {
        institution,
        canvas_origin: CANVAS_ORIGIN.to_owned(),
        courses,
        verified_events: HashMap::new(),
        explicit_uid_mappings: HashMap::new(),
    })
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
}
