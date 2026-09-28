//! Browser-capture reconciliation that keeps a newer iCal due observation selected.

use std::fmt;
use std::time::SystemTime;

use chrono::{DateTime, FixedOffset, Utc};
use serde_json::{json, Map, Value};

use crate::reconcile::{reconcile_coursework, CourseAssignments};

const ERROR: &str = "browser coursework reconciliation failed";

/// A fixed, content-free reconciliation failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserReconcileError;

impl fmt::Display for BrowserReconcileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(ERROR)
    }
}

impl std::error::Error for BrowserReconcileError {}

/// Reconcile Canvas facts while retaining a newer or unstamped selected iCal due fact.
///
/// Matching uses the existing exact Canvas assignment aliases. Titles and due-date values are
/// never used to associate records. The Canvas fact remains in provenance alternatives after a
/// fresh iCal fact is restored as the visible due date.
pub fn reconcile_browser_coursework(
    latest: &Value,
    courses: &[CourseAssignments],
    captured_at: SystemTime,
) -> Result<Value, BrowserReconcileError> {
    let mut result =
        reconcile_coursework(latest, courses, captured_at).map_err(|_| BrowserReconcileError)?;
    let capture_time = DateTime::<Utc>::from(captured_at);
    let Some(input_items) = latest.get("items").and_then(Value::as_array) else {
        return Err(BrowserReconcileError);
    };
    let Some(output_items) = result.get_mut("items").and_then(Value::as_array_mut) else {
        return Err(BrowserReconcileError);
    };

    for input in input_items {
        let Some(input_id) = input.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(ical_fact) = selected_ical_fact(input, courses)? else {
            continue;
        };
        let Some(owner) = ical_fact.get("owner").filter(|value| value.is_object()) else {
            continue;
        };
        let Some(output) = output_items
            .iter_mut()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(input_id))
        else {
            continue;
        };
        if !exact_canvas_link(input, output, owner, courses)
            || !is_newer_than_capture(&ical_fact, capture_time)?
        {
            continue;
        }
        restore_selected_fact(output, &ical_fact)?;
    }
    Ok(result)
}

fn selected_ical_fact(
    item: &Value,
    courses: &[CourseAssignments],
) -> Result<Option<Value>, BrowserReconcileError> {
    if let Some(selected) = item
        .get("fieldObservations")
        .and_then(|value| value.get("at"))
        .and_then(|value| value.get("selected"))
    {
        return Ok((selected
            .get("owner")
            .and_then(|owner| owner.get("source"))
            .and_then(Value::as_str)
            == Some("ical"))
        .then(|| selected.clone()));
    }
    if item.get("fieldObservations").is_some()
        || item.get("source").and_then(Value::as_str) != Some("ical")
    {
        return Ok(None);
    }
    let Some(value) = item.get("at") else {
        return Ok(None);
    };
    let Some(course) = item.get("course").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(references) = item.get("sourceReferences").and_then(Value::as_array) else {
        return Ok(None);
    };
    let mut owners = Vec::new();
    for reference in references {
        if reference.get("source").and_then(Value::as_str) != Some("ical")
            || reference.get("course").and_then(Value::as_str) != Some(course)
        {
            continue;
        }
        let Some(reference_id) = reference.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(canvas_id) = reference_id.strip_prefix("assignment:") else {
            continue;
        };
        let is_captured = courses.iter().any(|capture| {
            capture.key == course
                && capture.assignments.iter().any(|assignment| {
                    assignment_id(assignment.get("id")).as_deref() == Some(canvas_id)
                })
        });
        if is_captured {
            owners.push(reference.clone());
        }
    }
    match owners.as_slice() {
        [owner] => Ok(Some(json!({"owner": owner, "value": value}))),
        [] => Ok(None),
        _ => Err(BrowserReconcileError),
    }
}

fn is_newer_than_capture(
    fact: &Value,
    capture_time: DateTime<Utc>,
) -> Result<bool, BrowserReconcileError> {
    match fact.get("observedAt") {
        None => Ok(true),
        Some(Value::String(stamp)) => {
            let observed: DateTime<FixedOffset> =
                DateTime::parse_from_rfc3339(stamp).map_err(|_| BrowserReconcileError)?;
            Ok((observed.timestamp(), observed.timestamp_subsec_nanos())
                > (
                    capture_time.timestamp(),
                    capture_time.timestamp_subsec_nanos(),
                ))
        }
        _ => Err(BrowserReconcileError),
    }
}

fn exact_canvas_link(
    input: &Value,
    output: &Value,
    ical_owner: &Value,
    courses: &[CourseAssignments],
) -> bool {
    let Some(institution) = ical_owner.get("institution").and_then(Value::as_str) else {
        return false;
    };
    let Some(course) = ical_owner.get("course").and_then(Value::as_str) else {
        return false;
    };
    let Some(reference_id) = ical_owner.get("id").and_then(Value::as_str) else {
        return false;
    };
    let Some(canvas_id) = reference_id.strip_prefix("assignment:") else {
        return false;
    };
    if canvas_id.is_empty()
        || input.get("course").and_then(Value::as_str) != Some(course)
        || !input
            .get("sourceReferences")
            .and_then(Value::as_array)
            .is_some_and(|references| references.iter().any(|reference| reference == ical_owner))
        || !courses.iter().any(|capture| {
            capture.key == course
                && capture.assignments.iter().any(|assignment| {
                    assignment_id(assignment.get("id")).as_deref() == Some(canvas_id)
                })
        })
    {
        return false;
    }
    output
        .get("sourceReferences")
        .and_then(Value::as_array)
        .is_some_and(|references| {
            references.iter().any(|reference| {
                reference.get("institution").and_then(Value::as_str) == Some(institution)
                    && reference.get("course").and_then(Value::as_str) == Some(course)
                    && reference.get("source").and_then(Value::as_str) == Some("canvas")
                    && reference.get("id").and_then(Value::as_str) == Some(canvas_id)
            })
        })
}

fn assignment_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => value.as_u64().map(|id| id.to_string()),
        _ => None,
    }
}

fn restore_selected_fact(item: &mut Value, ical_fact: &Value) -> Result<(), BrowserReconcileError> {
    let current = item
        .get("fieldObservations")
        .and_then(|value| value.get("at"))
        .and_then(|value| value.as_object())
        .ok_or(BrowserReconcileError)?;
    let canvas_fact = current
        .get("selected")
        .filter(|fact| fact.get("owner").is_some() && fact.get("value").is_some())
        .cloned()
        .ok_or(BrowserReconcileError)?;
    if canvas_fact["owner"]["source"].as_str() != Some("canvas") {
        return Ok(());
    }
    let ical_owner = ical_fact.get("owner").ok_or(BrowserReconcileError)?;
    let canvas_owner = canvas_fact.get("owner").ok_or(BrowserReconcileError)?;
    let mut alternatives = current
        .get("alternatives")
        .map(|value| value.as_array().cloned().ok_or(BrowserReconcileError))
        .transpose()?
        .unwrap_or_default();
    alternatives.retain(|fact| {
        fact.get("owner") != Some(ical_owner) && fact.get("owner") != Some(canvas_owner)
    });
    alternatives.push(canvas_fact);

    let selected_value = ical_fact
        .get("value")
        .filter(|value| valid_json_value(value))
        .cloned()
        .ok_or(BrowserReconcileError)?;
    let mut observation = Map::new();
    observation.insert("selected".into(), ical_fact.clone());
    if !alternatives.is_empty() {
        observation.insert("alternatives".into(), Value::Array(alternatives));
    }
    let field_observations = item
        .get_mut("fieldObservations")
        .and_then(Value::as_object_mut)
        .ok_or(BrowserReconcileError)?;
    field_observations
        .entry("at")
        .or_insert_with(|| Value::Object(Map::new()));
    *field_observations
        .get_mut("at")
        .ok_or(BrowserReconcileError)? = Value::Object(observation);
    item.as_object_mut()
        .ok_or(BrowserReconcileError)?
        .insert("at".into(), selected_value);
    Ok(())
}

fn valid_json_value(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => true,
        Value::Array(values) => values.iter().all(valid_json_value),
        Value::Object(values) => values.values().all(valid_json_value),
    }
}

#[cfg(test)]
#[path = "browser_reconcile_tests.rs"]
mod tests;
