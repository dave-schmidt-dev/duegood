//! Canvas and iCal identity matching for coursework reconciliation.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use super::{invalid, ReconcileError};

pub(super) fn identity_key(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) if number.as_u64().is_some() => Some(number.to_string()),
        _ => None,
    }
}

pub(super) fn canvas_identity(item: &Value) -> Option<(String, String, String)> {
    Some((
        item.get("course")?.as_str()?.to_owned(),
        item.get("canvasResourceType")
            .or_else(|| item.get("canvasType"))
            .and_then(Value::as_str)
            .unwrap_or("assignment")
            .to_owned(),
        identity_key(item.get("canvasId")?)?,
    ))
}

pub(super) fn same_canvas_identity(old: &Value, fresh: &Value) -> bool {
    old.get("source").and_then(Value::as_str) == Some("canvas")
        && canvas_identity(old).is_some_and(|identity| Some(identity) == canvas_identity(fresh))
}

pub(super) fn revivable_archived_index(
    archive: &[Value],
    course: &str,
    canvas_type: &str,
    canvas_id: &str,
) -> Result<Option<usize>, ReconcileError> {
    let mut found = None;
    for (index, item) in archive.iter().enumerate() {
        if item.get("source").and_then(Value::as_str) != Some("canvas") {
            continue;
        }
        if item.get("canvasId").and_then(identity_key).as_deref() != Some(canvas_id)
            || item.get("course").and_then(Value::as_str) != Some(course)
            || item
                .get("canvasResourceType")
                .or_else(|| item.get("canvasType"))
                .and_then(Value::as_str)
                .unwrap_or("assignment")
                != canvas_type
        {
            continue;
        }
        if found.replace(index).is_some() {
            return Err(invalid("archived Canvas assignment identity is duplicated"));
        }
    }
    Ok(found)
}

pub(super) fn reference_key(
    reference: &Map<String, Value>,
) -> Result<(String, String, String, String, Option<String>), ReconcileError> {
    let institution = reference
        .get("institution")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("coursework source reference is malformed"))?;
    let course = reference
        .get("course")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("coursework source reference is malformed"))?;
    let source = reference
        .get("source")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "canvas" | "ical" | "manual" | "pdf"))
        .ok_or_else(|| invalid("coursework source reference is malformed"))?;
    let id = reference
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("coursework source reference is malformed"))?;
    let instance = match reference.get("instance") {
        None => None,
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => return Err(invalid("coursework source reference is malformed")),
    };
    Ok((
        institution.to_owned(),
        course.to_owned(),
        source.to_owned(),
        id.to_owned(),
        instance,
    ))
}

pub(super) fn item_references(item: &Value) -> Result<Vec<&Map<String, Value>>, ReconcileError> {
    match item.get("sourceReferences") {
        None => Ok(Vec::new()),
        Some(Value::Array(references)) => references
            .iter()
            .map(|reference| {
                reference
                    .as_object()
                    .ok_or_else(|| invalid("coursework source reference is malformed"))
            })
            .collect(),
        _ => Err(invalid("coursework source reference is malformed")),
    }
}

pub(super) fn validate_source_references(
    items: &[Value],
    archived: &[Value],
) -> Result<(), ReconcileError> {
    let mut owners = HashMap::new();
    for item in items.iter().chain(archived) {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("coursework item id must be a nonempty string"))?;
        for reference in item_references(item)? {
            let key = reference_key(reference)?;
            if let Some(previous) = owners.insert(key, id) {
                if previous != id {
                    return Err(invalid("duplicate scoped source reference"));
                }
                return Err(invalid("duplicate scoped source reference"));
            }
        }
    }
    Ok(())
}

/// The iCal parser emits this exact verified alias only after it recognizes Canvas's assignment
/// endpoint. It is intentionally not a title, date, or loose URL comparison.
pub(super) fn item_matches_assignment(
    item: &Value,
    course: &str,
    canvas_id: &str,
) -> Result<bool, ReconcileError> {
    if item.get("course").and_then(Value::as_str) != Some(course) {
        return Ok(false);
    }
    if item
        .get("canvasResourceType")
        .or_else(|| item.get("canvasType"))
        .and_then(Value::as_str)
        .is_some_and(|item_type| item_type != "assignment")
    {
        return Ok(false);
    }
    if item.get("canvasId").and_then(identity_key).as_deref() == Some(canvas_id) {
        return Ok(true);
    }
    for reference in item_references(item)? {
        let (_, reference_course, source, id, _) = reference_key(reference)?;
        if reference_course != course {
            continue;
        }
        if (source == "canvas" && id == canvas_id)
            || (source == "ical" && id == format!("assignment:{canvas_id}"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn canvas_reference_for(
    item: &Value,
    course: &str,
    canvas_id: &str,
) -> Result<Option<Value>, ReconcileError> {
    for reference in item_references(item)? {
        let (institution, reference_course, source, id, _) = reference_key(reference)?;
        if reference_course != course {
            continue;
        }
        if source == "canvas" && id == canvas_id {
            return Ok(Some(Value::Object(reference.clone())));
        }
        if source == "ical" && id == format!("assignment:{canvas_id}") {
            return Ok(Some(
                json!({"institution": institution, "course": course, "source": "canvas", "id": canvas_id}),
            ));
        }
    }
    Ok(None)
}

pub(super) fn append_canvas_reference(
    target: &mut Map<String, Value>,
    course: &str,
    canvas_id: &str,
) -> Result<Option<Value>, ReconcileError> {
    let current = Value::Object(target.clone());
    let Some(reference) = canvas_reference_for(&current, course, canvas_id)? else {
        return Ok(None);
    };
    let references = target
        .entry("sourceReferences".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| invalid("coursework source reference is malformed"))?;
    if !references.iter().any(|value| value == &reference) {
        references.push(reference.clone());
    }
    Ok(Some(reference))
}
