//! Due-date fact reconciliation for Canvas and iCal observations.

use std::time::SystemTime;

use serde_json::{json, Map, Value};

use super::{
    dates::utc_to_new_york,
    identity::{item_references, reference_key},
    invalid, ReconcileError,
};

pub(super) fn patch_due_at(
    target: &mut Map<String, Value>,
    assignment: &Value,
    canvas_reference: Option<&Value>,
    captured_at: SystemTime,
) -> Result<(), ReconcileError> {
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
    if let Some(reference) = canvas_reference {
        merge_canvas_due_fact(target, local, reference.clone(), captured_at)?;
    } else {
        target.insert("at".to_owned(), local);
    }
    Ok(())
}

/// Preserves a verified iCal due fact as an alternative while a new Canvas API observation
/// becomes visible. Repeated identical API captures retain the original observation timestamp,
/// which keeps a no-op reconciliation byte-stable.
fn merge_canvas_due_fact(
    target: &mut Map<String, Value>,
    local: Value,
    canvas_reference: Value,
    captured_at: SystemTime,
) -> Result<(), ReconcileError> {
    let old_visible = target.get("at").cloned().unwrap_or(Value::Null);
    let observed_at = crate::store::utc_stamp(captured_at).iso;
    let existing = match target.get("fieldObservations") {
        None => None,
        Some(Value::Object(observations)) => observations.get("at").cloned(),
        Some(_) => return Err(invalid("field observations are malformed")),
    };
    let canvas_owner = canvas_reference.clone();
    let canvas_fact = |value: Value, stamp: Option<&str>| {
        let mut fact = Map::new();
        fact.insert("owner".into(), canvas_owner.clone());
        fact.insert("value".into(), value);
        if let Some(stamp) = stamp {
            fact.insert("observedAt".into(), Value::String(stamp.to_owned()));
        }
        Value::Object(fact)
    };

    let next = if let Some(existing) = existing {
        let mut record = existing
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("field observations are malformed"))?;
        let nested = record.contains_key("selected");
        let selected = existing
            .get("selected")
            .unwrap_or(&existing)
            .as_object()
            .ok_or_else(|| invalid("field observations are malformed"))?;
        let selected_owner = selected
            .get("owner")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("field observations are malformed"))?;
        if !selected.contains_key("value") {
            return Err(invalid("field observations are malformed"));
        }
        let selected_is_canvas =
            selected_owner == canvas_reference.as_object().expect("reference object");
        if selected_is_canvas && selected.get("value") == Some(&local) {
            // No new fact: the prior capture time remains authoritative for this unchanged value.
            existing
        } else {
            let mut alternatives = existing
                .get("alternatives")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let previous_canvas = alternatives
                .iter()
                .find(|fact| fact.get("owner") == Some(&canvas_reference))
                .and_then(Value::as_object)
                .cloned();
            alternatives.retain(|fact| fact.get("owner") != Some(&canvas_reference));
            // Keep the prior selected source auditable when Canvas takes over. Updating the
            // same Canvas owner retains its metadata without duplicating that source identity.
            alternatives.retain(|fact| fact.get("owner") != selected.get("owner"));
            let mut previous = selected.clone();
            previous.remove("alternatives");
            if !selected_is_canvas {
                alternatives.push(Value::Object(previous));
            }
            let mut incoming = if selected_is_canvas {
                selected.clone()
            } else {
                previous_canvas.unwrap_or_default()
            };
            incoming.remove("alternatives");
            incoming.extend(
                canvas_fact(local.clone(), Some(&observed_at))
                    .as_object()
                    .unwrap()
                    .clone(),
            );
            if nested {
                record.insert("selected".into(), Value::Object(incoming));
            } else {
                record.remove("owner");
                record.remove("value");
                record.remove("observedAt");
                record.extend(incoming);
            }
            if !alternatives.is_empty() {
                record.insert("alternatives".into(), Value::Array(alternatives));
            } else {
                record.remove("alternatives");
            }
            Value::Object(record)
        }
    } else {
        let mut alternatives = Vec::new();
        if let Some(ical_owner) = item_ical_owner(target)? {
            alternatives.push(json!({"owner": ical_owner, "value": old_visible}));
        }
        let mut record = canvas_fact(local.clone(), Some(&observed_at))
            .as_object()
            .unwrap()
            .clone();
        if !alternatives.is_empty() {
            record.insert("alternatives".into(), Value::Array(alternatives));
        }
        Value::Object(record)
    };
    let selected = next
        .get("selected")
        .unwrap_or(&next)
        .get("value")
        .cloned()
        .ok_or_else(|| invalid("field observations are malformed"))?;
    target
        .entry("fieldObservations".to_owned())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| invalid("field observations are malformed"))?
        .insert("at".to_owned(), next);
    target.insert("at".to_owned(), selected);
    Ok(())
}

fn item_ical_owner(target: &Map<String, Value>) -> Result<Option<Value>, ReconcileError> {
    let item = Value::Object(target.clone());
    Ok(item_references(&item)?.into_iter().find_map(|reference| {
        reference_key(reference)
            .ok()
            .and_then(|(_, _, source, _, _)| {
                (source == "ical").then(|| Value::Object(reference.clone()))
            })
    }))
}

pub(super) fn patch_optional(
    target: &mut Map<String, Value>,
    local: &str,
    source: &Value,
    remote: &str,
) {
    if let Some(value) = source.get(remote) {
        target.insert(local.to_owned(), value.clone());
    }
}
