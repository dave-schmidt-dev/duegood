//! Native source-reference indexing and durable pending holds.

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use crate::store::StoreError;

use super::facts::{RefKey, MAX_PENDING_CANDIDATES, MAX_PENDING_LINKS};

pub(super) fn append_reference(
    item: &mut Map<String, Value>,
    reference: &Value,
) -> Result<bool, StoreError> {
    let values = item
        .entry("sourceReferences")
        .or_insert_with(|| Value::Array(Vec::new()));
    let values = values.as_array_mut().ok_or(StoreError::Invalid(
        "native coursework source references are malformed",
    ))?;
    let key = reference_key(reference)?;
    if values
        .iter()
        .any(|candidate| reference_key(candidate).ok().as_ref() == Some(&key))
    {
        return Ok(false);
    }
    values.push(reference.clone());
    Ok(true)
}

pub(super) fn item_mut<'a>(
    root: &'a mut Map<String, Value>,
    id: &str,
) -> Result<&'a mut Map<String, Value>, StoreError> {
    let active_index = root
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
        });
    if let Some(index) = active_index {
        return root
            .get_mut("items")
            .and_then(Value::as_array_mut)
            .and_then(|items| items.get_mut(index))
            .and_then(Value::as_object_mut)
            .ok_or(StoreError::Invalid("native coursework item is malformed"));
    }
    let archived_index = root
        .get("archivedForecastItems")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
        });
    if let Some(index) = archived_index {
        return root
            .get_mut("archivedForecastItems")
            .and_then(Value::as_array_mut)
            .and_then(|items| items.get_mut(index))
            .and_then(Value::as_object_mut)
            .ok_or(StoreError::Invalid("native coursework item is malformed"));
    }
    Err(StoreError::Invalid("calendar source item disappeared"))
}

pub(super) fn write_pending(
    root: &mut Map<String, Value>,
    key: &RefKey,
    local_id: &str,
    course: &str,
    reference: &Value,
    fields: &Value,
    observed_at: &str,
    candidate_ids: &[String],
    reason: &str,
) -> Result<bool, StoreError> {
    if candidate_ids.len() > MAX_PENDING_CANDIDATES {
        return Err(StoreError::Invalid(
            "calendar source has too many pending candidates",
        ));
    }
    let pending = root
        .entry("pendingSourceLinks")
        .or_insert_with(|| Value::Array(Vec::new()));
    let pending = pending.as_array_mut().ok_or(StoreError::Invalid(
        "native pending source links are malformed",
    ))?;
    let id = key.0.clone();
    let replacement = json!({
        "id": id.clone(),
        "localId": local_id,
        "course": course,
        "reference": reference,
        "verifiedReferences": [],
        "fields": fields,
        "observedAt": observed_at,
        "candidateIds": candidate_ids,
        "reason": reason,
    });
    if let Some(existing) = pending.iter_mut().find(|value| {
        value.get("id").and_then(Value::as_str) == Some(id.as_str())
            || value
                .get("reference")
                .and_then(|reference| reference_key(reference).ok())
                .as_ref()
                == Some(key)
    }) {
        if *existing == replacement {
            return Ok(false);
        }
        *existing = replacement;
        return Ok(true);
    }
    if pending.len() >= MAX_PENDING_LINKS {
        return Err(StoreError::Invalid(
            "native pending source link limit reached",
        ));
    }
    pending.push(replacement);
    Ok(true)
}

pub(super) fn existing_pending_keys(
    root: &Map<String, Value>,
) -> Result<HashSet<RefKey>, StoreError> {
    let Some(pending) = root.get("pendingSourceLinks") else {
        return Ok(HashSet::new());
    };
    let pending = pending.as_array().ok_or(StoreError::Invalid(
        "native pending source links are malformed",
    ))?;
    let mut keys = HashSet::new();
    for entry in pending {
        let reference = entry.get("reference").ok_or(StoreError::Invalid(
            "native pending source link is malformed",
        ))?;
        keys.insert(reference_key(reference)?);
    }
    Ok(keys)
}

pub(super) fn item_references(item: &Map<String, Value>) -> Result<Vec<&Value>, StoreError> {
    match item.get("sourceReferences") {
        None => Ok(Vec::new()),
        Some(Value::Array(values)) => Ok(values.iter().collect()),
        _ => Err(StoreError::Invalid(
            "native coursework source references are malformed",
        )),
    }
}

pub(super) fn reference_key(value: &Value) -> Result<RefKey, StoreError> {
    let object = value.as_object().ok_or(StoreError::Invalid(
        "calendar source reference is malformed",
    ))?;
    let required = |field: &str| {
        object
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 160)
            .map(str::to_owned)
            .ok_or(StoreError::Invalid(
                "calendar source reference is malformed",
            ))
    };
    let source = required("source")?;
    if !matches!(source.as_str(), "canvas" | "ical" | "manual" | "pdf") {
        return Err(StoreError::Invalid(
            "calendar source reference is malformed",
        ));
    }
    let instance = match object.get("instance") {
        None => Value::Null,
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 160 => {
            Value::String(value.clone())
        }
        _ => {
            return Err(StoreError::Invalid(
                "calendar source reference is malformed",
            ))
        }
    };
    Ok(RefKey(
        serde_json::to_string(&json!([
            required("institution")?,
            required("course")?,
            source,
            required("id")?,
            instance
        ]))
        .expect("string tuple serializes"),
    ))
}
