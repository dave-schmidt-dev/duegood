//! Applies validated course names and codes from the current native Canvas capture.
//!
//! The calendar bootstrap can create a course using its numeric Canvas ID as a placeholder.
//! Each capture already contains the allowlisted `course.json`; this helper only copies its
//! bounded name/code into the existing coursework row with the exact scope key. It never
//! changes course identity, personal data, or extension fields.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::CourseScope;

const MAX_COURSE_TEXT_BYTES: usize = 256;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ApplyMetadataError {
    InvalidCoursework,
    InvalidScope,
    InvalidMetadata,
}

struct CourseMetadata {
    title: Option<String>,
    code: Option<String>,
}

/// Copies title and code from validated capture documents into their matching coursework rows.
///
/// All scopes, IDs, rows, and metadata are checked before mutating the document. Missing or null
/// fields leave an existing title/code untouched; malformed values refuse the entire update.
pub(super) fn apply(
    coursework: &mut Value,
    documents: &BTreeMap<String, Vec<u8>>,
    scopes: &[CourseScope],
) -> Result<(), ApplyMetadataError> {
    let courses = coursework
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(ApplyMetadataError::InvalidCoursework)?;
    let mut seen_keys = BTreeSet::new();
    let mut seen_ids = BTreeSet::new();
    let mut planned = Vec::with_capacity(scopes.len());

    for scope in scopes {
        if !seen_keys.insert(scope.key.as_str()) || !seen_ids.insert(scope.canvas_course_id) {
            return Err(ApplyMetadataError::InvalidScope);
        }
        let index = course_index(courses, scope)?;
        let metadata = captured_metadata(documents, scope)?;
        planned.push((index, metadata));
    }

    let courses = coursework
        .get_mut("courses")
        .and_then(Value::as_array_mut)
        .ok_or(ApplyMetadataError::InvalidCoursework)?;
    for (index, metadata) in planned {
        let course = courses[index]
            .as_object_mut()
            .expect("course row was validated before applying metadata");
        if let Some(title) = metadata.title {
            course.insert("title".into(), Value::String(title));
        }
        if let Some(code) = metadata.code {
            course.insert("code".into(), Value::String(code));
        }
    }
    Ok(())
}

fn course_index(courses: &[Value], scope: &CourseScope) -> Result<usize, ApplyMetadataError> {
    let mut matching = courses.iter().enumerate().filter(|(_, course)| {
        course.get("key").and_then(Value::as_str) == Some(scope.key.as_str())
    });
    let (index, course) = matching
        .next()
        .ok_or(ApplyMetadataError::InvalidCoursework)?;
    if matching.next().is_some() || !course.is_object() {
        return Err(ApplyMetadataError::InvalidCoursework);
    }
    Ok(index)
}

fn captured_metadata(
    documents: &BTreeMap<String, Vec<u8>>,
    scope: &CourseScope,
) -> Result<CourseMetadata, ApplyMetadataError> {
    let path = format!("{}/canvas-export/api/course.json", scope.folder);
    let bytes = documents
        .get(&path)
        .ok_or(ApplyMetadataError::InvalidMetadata)?;
    let document: Value =
        serde_json::from_slice(bytes).map_err(|_| ApplyMetadataError::InvalidMetadata)?;
    if positive_id(document.get("id")) != Some(scope.canvas_course_id) {
        return Err(ApplyMetadataError::InvalidMetadata);
    }
    Ok(CourseMetadata {
        title: bounded_text(document.get("name"))?,
        code: bounded_text(document.get("course_code"))?,
    })
}

fn bounded_text(value: Option<&Value>) -> Result<Option<String>, ApplyMetadataError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.is_empty()
                || text.len() > MAX_COURSE_TEXT_BYTES
                || text.chars().any(char::is_control)
            {
                Err(ApplyMetadataError::InvalidMetadata)
            } else {
                Ok(Some(text.to_owned()))
            }
        }
        Some(_) => Err(ApplyMetadataError::InvalidMetadata),
    }
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    let id = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))?;
    (id > 0).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const COURSE_ID: u64 = 910_101;
    const COURSE_KEY: &str = "synthetic-course-910101";
    const COURSE_FOLDER: &str = "classes/synthetic-course-910101";

    fn scope() -> CourseScope {
        CourseScope {
            key: COURSE_KEY.into(),
            folder: COURSE_FOLDER.into(),
            canvas_course_id: COURSE_ID,
        }
    }

    fn coursework() -> Value {
        json!({
            "schema": 1,
            "courses": [{
                "key": COURSE_KEY,
                "folder": COURSE_FOLDER,
                "title": format!("Canvas course {COURSE_ID}"),
                "code": format!("Canvas {COURSE_ID}"),
                "canvasCourseId": COURSE_ID,
                "color": "#56789a",
                "note": "keep student note",
                "syntheticExtension": { "retain": true }
            }],
            "items": [{ "id": "synthetic-item", "title": "Keep assignment", "done": true }],
            "rootExtension": "retain"
        })
    }

    fn documents(course: Value) -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([(
            format!("{COURSE_FOLDER}/canvas-export/api/course.json"),
            serde_json::to_vec(&course).unwrap(),
        )])
    }

    #[test]
    fn repairs_placeholder_title_and_code_and_preserves_other_coursework() {
        let mut document = coursework();
        let all_before = document.clone();
        let captured = documents(json!({
            "id": COURSE_ID,
            "name": "Synthetic Network Defense",
            "course_code": "SYN 401"
        }));

        apply(&mut document, &captured, &[scope()]).unwrap();

        assert_eq!(document["courses"][0]["title"], "Synthetic Network Defense");
        assert_eq!(document["courses"][0]["code"], "SYN 401");
        for field in [
            "key",
            "folder",
            "canvasCourseId",
            "color",
            "note",
            "syntheticExtension",
        ] {
            assert_eq!(
                document["courses"][0][field],
                all_before["courses"][0][field]
            );
        }
        assert_eq!(document["items"], all_before["items"]);
        assert_eq!(document["rootExtension"], all_before["rootExtension"]);
    }

    #[test]
    fn absent_or_null_fields_preserve_existing_values() {
        let mut document = coursework();
        let before_title = document["courses"][0]["title"].clone();
        let before_code = document["courses"][0]["code"].clone();
        let captured = documents(json!({ "id": COURSE_ID, "name": null }));

        apply(&mut document, &captured, &[scope()]).unwrap();

        assert_eq!(document["courses"][0]["title"], before_title);
        assert_eq!(document["courses"][0]["code"], before_code);
    }

    #[test]
    fn mismatched_course_id_refuses_update_without_partial_mutation() {
        let mut document = coursework();
        let before = document.clone();
        let captured = documents(json!({
            "id": COURSE_ID + 1,
            "name": "Wrong synthetic course",
            "course_code": "WRONG"
        }));

        assert_eq!(
            apply(&mut document, &captured, &[scope()]),
            Err(ApplyMetadataError::InvalidMetadata)
        );
        assert_eq!(document, before);
    }

    #[test]
    fn invalid_field_refuses_valid_sibling_change_without_partial_mutation() {
        let mut document = coursework();
        let before = document.clone();
        let captured = documents(json!({
            "id": COURSE_ID,
            "name": "Valid synthetic title",
            "course_code": 7
        }));

        assert_eq!(
            apply(&mut document, &captured, &[scope()]),
            Err(ApplyMetadataError::InvalidMetadata)
        );
        assert_eq!(document, before);
    }

    #[test]
    fn duplicate_scope_or_duplicate_course_key_refuses_update_without_mutation() {
        let mut document = coursework();
        let before = document.clone();
        let captured = documents(json!({
            "id": COURSE_ID,
            "name": "Synthetic title",
            "course_code": "SYN 401"
        }));
        assert_eq!(
            apply(&mut document, &captured, &[scope(), scope()]),
            Err(ApplyMetadataError::InvalidScope)
        );
        assert_eq!(document, before);

        let duplicate = document["courses"][0].clone();
        document["courses"].as_array_mut().unwrap().push(duplicate);
        let duplicated = document.clone();
        assert_eq!(
            apply(&mut document, &captured, &[scope()]),
            Err(ApplyMetadataError::InvalidCoursework)
        );
        assert_eq!(document, duplicated);
    }
}
