//! Source-reference, pending-hold, and field provenance helpers for native iCal reconciliation.

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use crate::store::StoreError;

use super::refs::reference_key;

pub(super) const MAX_PENDING_LINKS: usize = 100;
pub(super) const MAX_PENDING_CANDIDATES: usize = 20;
const MAX_FIELD_SOURCES: usize = 20;
pub(super) const SOURCE_FIELDS: &[&str] = &[
    "kind",
    "title",
    "at",
    "points",
    "detail",
    "url",
    "submissionStatus",
    "grade",
    "score",
    "submittedAt",
    "gradedAt",
    "assignmentGroupId",
    "assignmentGroupName",
    "assignmentGroupWeight",
];

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct RefKey(pub(super) String);

#[derive(Clone)]
struct Fact {
    owner: Value,
    value: Value,
    observed_at: Option<String>,
}

pub(super) fn merge_fields(
    item: &mut Map<String, Value>,
    incoming_owner: &Value,
    observation: &Value,
    observed_at: &str,
) -> Result<(usize, bool), StoreError> {
    let fields =
        observation
            .get("fields")
            .and_then(Value::as_object)
            .ok_or(StoreError::Invalid(
                "calendar observation fields are malformed",
            ))?;
    let prior_ownership = item.remove("fieldObservations");
    let mut ownership = match prior_ownership.clone() {
        None => Map::new(),
        Some(Value::Object(fields)) => fields,
        _ => {
            return Err(StoreError::Invalid(
                "calendar field observations are malformed",
            ))
        }
    };
    let canvas_owner = canvas_reference(item, incoming_owner)?;
    let mut visible_changed = 0;
    for (field, incoming_value) in fields {
        if !json_value(incoming_value) {
            return Err(StoreError::Invalid("calendar source field is malformed"));
        }
        let old = parse_field_fact(ownership.get(field))?;
        let selected = old.as_ref().map(|entry| entry.0.clone()).or_else(|| {
            canvas_owner.as_ref().and_then(|owner| {
                item.get(field).cloned().map(|value| Fact {
                    owner: owner.clone(),
                    value,
                    observed_at: None,
                })
            })
        });
        let incoming = Fact {
            owner: incoming_owner.clone(),
            value: incoming_value.clone(),
            observed_at: Some(observed_at.to_owned()),
        };
        let mut next = selected.clone().unwrap_or_else(|| incoming.clone());
        let mut alternatives = old.map(|entry| entry.1).unwrap_or_default();
        if let Some(selected_fact) = selected {
            if reference_key(&selected_fact.owner)? == reference_key(incoming_owner)? {
                next = if selected_fact.value == incoming.value {
                    Fact {
                        observed_at: selected_fact.observed_at,
                        ..incoming
                    }
                } else {
                    incoming
                };
            } else {
                let incoming_key = reference_key(incoming_owner)?;
                if let Some(position) = alternatives.iter().position(|fact| {
                    reference_key(&fact.owner).ok().as_ref() == Some(&incoming_key)
                }) {
                    let previous = &alternatives[position];
                    alternatives[position] = if previous.value == incoming.value {
                        Fact {
                            observed_at: previous.observed_at.clone(),
                            ..incoming.clone()
                        }
                    } else {
                        incoming.clone()
                    };
                } else {
                    alternatives.push(incoming.clone());
                }
                if should_promote(field, &selected_fact, &incoming) {
                    next = incoming.clone();
                    let next_key = reference_key(&next.owner)?;
                    alternatives
                        .retain(|fact| reference_key(&fact.owner).ok().as_ref() != Some(&next_key));
                    alternatives.push(selected_fact);
                }
            }
        }
        if alternatives.len() + 1 > MAX_FIELD_SOURCES {
            return Err(StoreError::Invalid(
                "calendar field has too many source observations",
            ));
        }
        let previous = item.get(field);
        if previous != Some(&next.value) {
            item.insert(field.clone(), next.value.clone());
            visible_changed += 1;
        }
        let value = fact_value(&next, alternatives);
        if ownership.get(field) != Some(&value) {
            ownership.insert(field.clone(), value);
        }
    }
    let ownership_changed = if ownership.is_empty() {
        prior_ownership.is_some()
    } else {
        let value = Value::Object(ownership);
        let changed = prior_ownership.as_ref() != Some(&value);
        item.insert("fieldObservations".into(), value);
        changed
    };
    if ownership_changed && item.get("fieldObservations").is_none() {
        item.remove("fieldObservations");
    }
    Ok((visible_changed, ownership_changed))
}

fn should_promote(field: &str, selected: &Fact, incoming: &Fact) -> bool {
    let selected_source = selected
        .owner
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("");
    let incoming_source = incoming
        .owner
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("");
    if field == "at" && selected_source == "canvas" && incoming_source == "ical" {
        let selected_time = selected.observed_at.as_deref().and_then(parse_timestamp);
        let incoming_time = incoming.observed_at.as_deref().and_then(parse_timestamp);
        return incoming_time.is_some_and(|incoming_time| {
            selected_time.is_none_or(|selected_time| incoming_time > selected_time)
        });
    }
    priority(incoming_source) > priority(selected_source)
}

fn priority(source: &str) -> u8 {
    match source {
        "canvas" => 2,
        "ical" => 1,
        _ => 0,
    }
}

fn fact_value(selected: &Fact, alternatives: Vec<Fact>) -> Value {
    let mut value = Map::new();
    value.insert("owner".into(), selected.owner.clone());
    value.insert("value".into(), selected.value.clone());
    if let Some(at) = &selected.observed_at {
        value.insert("observedAt".into(), Value::String(at.clone()));
    }
    if !alternatives.is_empty() {
        value.insert(
            "alternatives".into(),
            Value::Array(alternatives.iter().map(fact_value_single).collect()),
        );
    }
    Value::Object(value)
}

fn fact_value_single(fact: &Fact) -> Value {
    let mut value = Map::new();
    value.insert("owner".into(), fact.owner.clone());
    value.insert("value".into(), fact.value.clone());
    if let Some(at) = &fact.observed_at {
        value.insert("observedAt".into(), Value::String(at.clone()));
    }
    Value::Object(value)
}

fn parse_field_fact(value: Option<&Value>) -> Result<Option<(Fact, Vec<Fact>)>, StoreError> {
    let Some(value) = value else { return Ok(None) };
    let object = value.as_object().ok_or(StoreError::Invalid(
        "calendar field observation is malformed",
    ))?;
    let selected = fact_from(object)?;
    let alternatives = match object.get("alternatives") {
        None => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_object()
                    .ok_or(StoreError::Invalid(
                        "calendar field observation is malformed",
                    ))
                    .and_then(fact_from)
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(StoreError::Invalid(
                "calendar field observation is malformed",
            ))
        }
    };
    let mut sources = HashSet::new();
    for fact in std::iter::once(&selected).chain(alternatives.iter()) {
        if !sources.insert(reference_key(&fact.owner)?) {
            return Err(StoreError::Invalid(
                "calendar field observations contain duplicate sources",
            ));
        }
    }
    if sources.len() > MAX_FIELD_SOURCES {
        return Err(StoreError::Invalid(
            "calendar field has too many source observations",
        ));
    }
    Ok(Some((selected, alternatives)))
}

fn fact_from(object: &Map<String, Value>) -> Result<Fact, StoreError> {
    let owner = object
        .get("owner")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or(StoreError::Invalid(
            "calendar field observation is malformed",
        ))?;
    let _ = reference_key(&owner)?;
    let value = object
        .get("value")
        .filter(|value| json_value(value))
        .cloned()
        .ok_or(StoreError::Invalid(
            "calendar field observation is malformed",
        ))?;
    let observed_at = match object.get("observedAt") {
        None => None,
        Some(Value::String(value)) if valid_timestamp(value) => Some(value.clone()),
        _ => {
            return Err(StoreError::Invalid(
                "calendar field observation is malformed",
            ))
        }
    };
    Ok(Fact {
        owner,
        value,
        observed_at,
    })
}

fn canvas_reference(
    item: &Map<String, Value>,
    incoming: &Value,
) -> Result<Option<Value>, StoreError> {
    let Some(canvas_id) = item.get("canvasId").and_then(canvas_id) else {
        return Ok(None);
    };
    let course = item
        .get("course")
        .and_then(Value::as_str)
        .ok_or(StoreError::Invalid("native coursework item is malformed"))?;
    let institution =
        incoming
            .get("institution")
            .and_then(Value::as_str)
            .ok_or(StoreError::Invalid(
                "calendar source reference is malformed",
            ))?;
    Ok(Some(
        json!({"institution": institution, "course": course, "source": "canvas", "id": canvas_id}),
    ))
}

pub(super) fn canvas_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if numeric_id(value) => Some(value.clone()),
        Value::Number(value) => value
            .as_u64()
            .filter(|value| *value > 0)
            .map(|value| value.to_string()),
        _ => None,
    }
}

pub(super) fn numeric_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 24
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && !value.starts_with('0')
}

pub(super) fn validate_text(value: &str, max: usize) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(StoreError::Invalid("calendar import scope is invalid"));
    }
    Ok(())
}

pub(super) fn valid_timestamp(value: &str) -> bool {
    value.len() == 20
        && value.ends_with('Z')
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && value.as_bytes().get(13) == Some(&b':')
        && value.as_bytes().get(16) == Some(&b':')
        && value.bytes().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19) || byte.is_ascii_digit()
        })
        && parse_timestamp(value).is_some()
}

fn parse_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}

pub(super) fn json_value(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => true,
        Value::Array(values) => values.iter().all(json_value),
        Value::Object(values) => values.values().all(json_value),
    }
}
