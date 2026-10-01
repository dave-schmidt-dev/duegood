//! Course title/code repair from the browser projection's validated course documents.
//!
//! Calendar bootstrap names a Canvas course only by its ID. The browser projection already
//! publishes each validated scope's sanitized `course` endpoint document, so this module copies
//! only that document's bounded `name`/`course_code` into the matching coursework course. Keys,
//! folders, identity, personal fields, and unknown extensions are never touched. A metadata
//! field that is missing preserves the prior value; metadata that is ID-mismatched or not
//! bounded nonempty text is refused instead of guessed.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::browser_projection::BrowserCourseScope;

use super::BrowserImportError;

const MAX_COURSE_TEXT: usize = 256;

/// Sanitized course facts copied from one scope's projected `course.json` document.
struct CourseMetadata {
    title: Option<String>,
    code: Option<String>,
}

/// Returns true when every validated scope's coursework course already carries the projected
/// title and code, so a same-generation receipt can skip republishing the store.
pub(super) fn course_metadata_current(
    coursework: &Value,
    documents: &BTreeMap<String, Vec<u8>>,
    scopes: &[BrowserCourseScope],
) -> Result<bool, BrowserImportError> {
    let courses = coursework
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(BrowserImportError::InvalidInventory)?;
    for scope in scopes {
        let course = &courses[course_index(courses, scope)?];
        let metadata = scope_metadata(documents, scope)?;
        if let Some(title) = metadata.title.as_deref() {
            if course.get("title").and_then(Value::as_str) != Some(title) {
                return Ok(false);
            }
        }
        if let Some(code) = metadata.code.as_deref() {
            if course.get("code").and_then(Value::as_str) != Some(code) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Updates each validated scope's coursework course `title`/`code` from its projected course
/// document. Only those two keys are written; every other coursework field is preserved.
pub(super) fn apply_course_metadata(
    coursework: &mut Value,
    documents: &BTreeMap<String, Vec<u8>>,
    scopes: &[BrowserCourseScope],
) -> Result<(), BrowserImportError> {
    let courses = coursework
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(BrowserImportError::InvalidInventory)?;
    // Resolve and validate every scope before mutating anything, so a refusal changes nothing.
    let mut planned = Vec::with_capacity(scopes.len());
    for scope in scopes {
        let index = course_index(courses, scope)?;
        planned.push((index, scope_metadata(documents, scope)?));
    }
    let courses = coursework
        .get_mut("courses")
        .and_then(Value::as_array_mut)
        .ok_or(BrowserImportError::InvalidInventory)?;
    for (index, metadata) in planned {
        let course = courses[index]
            .as_object_mut()
            .ok_or(BrowserImportError::InvalidInventory)?;
        if let Some(title) = metadata.title {
            course.insert("title".into(), Value::String(title));
        }
        if let Some(code) = metadata.code {
            course.insert("code".into(), Value::String(code));
        }
    }
    Ok(())
}

fn course_index(
    courses: &[Value],
    scope: &BrowserCourseScope,
) -> Result<usize, BrowserImportError> {
    let mut found = None;
    for (index, course) in courses.iter().enumerate() {
        if course.get("key").and_then(Value::as_str) == Some(scope.key.as_str())
            && found.replace(index).is_some()
        {
            return Err(BrowserImportError::InvalidInventory);
        }
    }
    found.ok_or(BrowserImportError::InvalidInventory)
}

fn scope_metadata(
    documents: &BTreeMap<String, Vec<u8>>,
    scope: &BrowserCourseScope,
) -> Result<CourseMetadata, BrowserImportError> {
    let bytes = documents
        .get(&format!("{}/canvas-export/api/course.json", scope.folder))
        .ok_or(BrowserImportError::InvalidInventory)?;
    let document: Value =
        serde_json::from_slice(bytes).map_err(|_| BrowserImportError::InvalidInventory)?;
    if positive_id(document.get("id")) != Some(scope.canvas_course_id) {
        return Err(BrowserImportError::InvalidInventory);
    }
    Ok(CourseMetadata {
        title: bounded_course_text(document.get("name"))?,
        code: bounded_course_text(document.get("course_code"))?,
    })
}

fn bounded_course_text(value: Option<&Value>) -> Result<Option<String>, BrowserImportError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            if text.trim().is_empty()
                || text.len() > MAX_COURSE_TEXT
                || text.chars().any(char::is_control)
            {
                Err(BrowserImportError::InvalidInventory)
            } else {
                Ok(Some(text.clone()))
            }
        }
        Some(_) => Err(BrowserImportError::InvalidInventory),
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

    const COURSE_ID: u64 = 900_001;

    fn scope() -> BrowserCourseScope {
        BrowserCourseScope {
            key: "canvas-900001".to_owned(),
            folder: "classes/canvas-900001".to_owned(),
            canvas_course_id: COURSE_ID,
        }
    }

    fn documents(course: Value) -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([(
            "classes/canvas-900001/canvas-export/api/course.json".to_owned(),
            serde_json::to_vec(&course).unwrap(),
        )])
    }

    fn placeholder_coursework() -> Value {
        json!({
            "schema": 1,
            "courses": [{
                "key": "canvas-900001",
                "code": format!("Canvas {COURSE_ID}"),
                "title": format!("Canvas course {COURSE_ID}"),
                "color": "#5b7c99",
                "folder": "classes/canvas-900001",
                "canvas": true,
                "canvasCourseId": COURSE_ID,
                "ignoredCanvasAssignmentIds": [990001],
                "syntheticCourseExtension": "preserve"
            }],
            "items": []
        })
    }

    #[test]
    fn synthetic_placeholder_title_and_code_are_repaired_without_touching_other_fields() {
        let documents = documents(json!({
            "id": COURSE_ID, "name": "Synthetic Course", "course_code": "SYN-101"
        }));
        let mut coursework = placeholder_coursework();
        assert!(!course_metadata_current(&coursework, &documents, &[scope()]).unwrap());
        apply_course_metadata(&mut coursework, &documents, &[scope()]).unwrap();
        let course = &coursework["courses"][0];
        assert_eq!(course["title"], "Synthetic Course");
        assert_eq!(course["code"], "SYN-101");
        assert_eq!(course["key"], "canvas-900001");
        assert_eq!(course["folder"], "classes/canvas-900001");
        assert_eq!(course["canvasCourseId"], COURSE_ID);
        assert_eq!(course["color"], "#5b7c99");
        assert_eq!(course["canvas"], true);
        assert_eq!(course["ignoredCanvasAssignmentIds"], json!([990001]));
        assert_eq!(course["syntheticCourseExtension"], "preserve");
        assert_eq!(coursework["schema"], 1);
        assert_eq!(coursework["items"], json!([]));
        assert!(course_metadata_current(&coursework, &documents, &[scope()]).unwrap());
    }

    #[test]
    fn valid_existing_title_and_code_are_updated_from_id_matched_metadata() {
        let documents = documents(json!({
            "id": COURSE_ID, "name": "Synthetic Renamed Course", "course_code": "SYN-102"
        }));
        let mut coursework = placeholder_coursework();
        coursework["courses"][0]["title"] = json!("Synthetic Prior Name");
        coursework["courses"][0]["code"] = json!("SYN-101");
        apply_course_metadata(&mut coursework, &documents, &[scope()]).unwrap();
        assert_eq!(
            coursework["courses"][0]["title"],
            "Synthetic Renamed Course"
        );
        assert_eq!(coursework["courses"][0]["code"], "SYN-102");
    }

    #[test]
    fn missing_metadata_fields_preserve_prior_title_and_code() {
        let mut coursework = placeholder_coursework();
        for course in [
            json!({"id": COURSE_ID}),
            json!({"id": COURSE_ID, "name": null, "course_code": null}),
        ] {
            let documents = documents(course);
            let before = coursework.clone();
            apply_course_metadata(&mut coursework, &documents, &[scope()]).unwrap();
            assert_eq!(coursework, before);
            assert!(course_metadata_current(&coursework, &documents, &[scope()]).unwrap());
        }
    }

    #[test]
    fn mismatched_course_document_id_is_refused_without_mutation() {
        let documents = documents(json!({
            "id": 900_002, "name": "Synthetic Other Course", "course_code": "SYN-201"
        }));
        let mut coursework = placeholder_coursework();
        let before = coursework.clone();
        assert!(matches!(
            apply_course_metadata(&mut coursework, &documents, &[scope()]),
            Err(BrowserImportError::InvalidInventory)
        ));
        assert!(matches!(
            course_metadata_current(&coursework, &documents, &[scope()]),
            Err(BrowserImportError::InvalidInventory)
        ));
        assert_eq!(coursework, before);
    }

    #[test]
    fn invalid_course_document_text_is_refused_without_mutation() {
        for course in [
            json!({"id": COURSE_ID, "name": "", "course_code": "SYN-101"}),
            json!({"id": COURSE_ID, "name": " \t\n", "course_code": "SYN-101"}),
            json!({"id": COURSE_ID, "name": "Synthetic Course", "course_code": ""}),
            json!({"id": COURSE_ID, "name": "Synthetic Course", "course_code": " \t\n"}),
            json!({"id": COURSE_ID, "name": 42, "course_code": "SYN-101"}),
            json!({"id": COURSE_ID, "name": "x".repeat(257), "course_code": "SYN-101"}),
            json!({"id": COURSE_ID, "name": "Synthetic\u{0007}Course", "course_code": "SYN-101"}),
            json!({"id": 0, "name": "Synthetic Course", "course_code": "SYN-101"}),
        ] {
            let documents = documents(course);
            let mut coursework = placeholder_coursework();
            let before = coursework.clone();
            assert!(matches!(
                apply_course_metadata(&mut coursework, &documents, &[scope()]),
                Err(BrowserImportError::InvalidInventory)
            ));
            assert_eq!(coursework, before);
        }
    }

    #[test]
    fn missing_course_document_is_refused_without_mutation() {
        let documents = BTreeMap::new();
        let mut coursework = placeholder_coursework();
        let before = coursework.clone();
        assert!(matches!(
            apply_course_metadata(&mut coursework, &documents, &[scope()]),
            Err(BrowserImportError::InvalidInventory)
        ));
        assert!(matches!(
            course_metadata_current(&coursework, &documents, &[scope()]),
            Err(BrowserImportError::InvalidInventory)
        ));
        assert_eq!(coursework, before);
    }

    #[test]
    fn unknown_or_duplicate_coursework_course_is_refused() {
        let documents = documents(json!({
            "id": COURSE_ID, "name": "Synthetic Course", "course_code": "SYN-101"
        }));
        let mut missing = placeholder_coursework();
        missing["courses"][0]["key"] = json!("canvas-other");
        assert!(matches!(
            apply_course_metadata(&mut missing, &documents, &[scope()]),
            Err(BrowserImportError::InvalidInventory)
        ));
        let mut duplicate = placeholder_coursework();
        let repeated = duplicate["courses"][0].clone();
        duplicate["courses"].as_array_mut().unwrap().push(repeated);
        assert!(matches!(
            apply_course_metadata(&mut duplicate, &documents, &[scope()]),
            Err(BrowserImportError::InvalidInventory)
        ));
    }

    #[test]
    fn repeated_apply_is_idempotent() {
        let documents = documents(json!({
            "id": COURSE_ID, "name": "Synthetic Course", "course_code": "SYN-101"
        }));
        let mut coursework = placeholder_coursework();
        apply_course_metadata(&mut coursework, &documents, &[scope()]).unwrap();
        let once = coursework.clone();
        apply_course_metadata(&mut coursework, &documents, &[scope()]).unwrap();
        assert_eq!(coursework, once);
        assert!(course_metadata_current(&coursework, &documents, &[scope()]).unwrap());
    }

    #[test]
    fn course_metadata_current_requires_exact_title_and_code_match() {
        let documents = documents(json!({
            "id": COURSE_ID, "name": "Synthetic Course", "course_code": "SYN-101"
        }));
        let mut coursework = placeholder_coursework();
        assert!(!course_metadata_current(&coursework, &documents, &[scope()]).unwrap());
        coursework["courses"][0]
            .as_object_mut()
            .unwrap()
            .remove("title");
        assert!(!course_metadata_current(&coursework, &documents, &[scope()]).unwrap());
        coursework["courses"][0]["title"] = json!("Synthetic Course");
        assert!(!course_metadata_current(&coursework, &documents, &[scope()]).unwrap());
        coursework["courses"][0]["code"] = json!("SYN-101");
        assert!(course_metadata_current(&coursework, &documents, &[scope()]).unwrap());
        coursework["courses"][0]["title"] = json!("Synthetic Course ");
        assert!(!course_metadata_current(&coursework, &documents, &[scope()]).unwrap());
    }
}
