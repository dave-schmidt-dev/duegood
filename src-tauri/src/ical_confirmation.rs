//! Stable calendar-feed membership and item-specific retained state.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::ical::MAX_ICAL_EVENTS;
use crate::store::{sha256_hex, StoreError};

use super::refs::reference_key;

const METADATA_FIELD: &str = "_calendarConfirmation";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct CalendarMember {
    pub reference: Value,
    pub local_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Confirmation {
    eligible_members: Vec<CalendarMember>,
    retained_ids: BTreeSet<String>,
    has_generation: bool,
}

fn member(value: &Value) -> Result<CalendarMember, StoreError> {
    let reference = value
        .get("reference")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or(StoreError::Invalid(
            "calendar confirmation member is malformed",
        ))?;
    if reference.get("source").and_then(Value::as_str) != Some("ical") {
        return Err(StoreError::Invalid(
            "calendar confirmation member is malformed",
        ));
    }
    reference_key(&reference)?;
    let local_id = value
        .get("localId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .map(str::to_owned)
        .ok_or(StoreError::Invalid(
            "calendar confirmation member is malformed",
        ))?;
    Ok(CalendarMember {
        reference,
        local_id,
    })
}

fn canonical_members(
    values: impl IntoIterator<Item = CalendarMember>,
) -> Result<Vec<CalendarMember>, StoreError> {
    let mut by_reference = BTreeMap::new();
    for entry in values {
        let key = reference_key(&entry.reference)?.0;
        if let Some(existing) = by_reference.insert(key, entry.clone()) {
            if existing.local_id != entry.local_id {
                return Err(StoreError::Invalid(
                    "calendar confirmation identity conflicts",
                ));
            }
        }
    }
    if by_reference.len() > MAX_ICAL_EVENTS {
        return Err(StoreError::Invalid(
            "calendar confirmation exceeds its limit",
        ));
    }
    Ok(by_reference.into_values().collect())
}

fn members_value(members: &[CalendarMember]) -> Value {
    Value::Array(
        members
            .iter()
            .map(|entry| json!({ "reference": entry.reference, "localId": entry.local_id }))
            .collect(),
    )
}

fn generation_digest(members: &[CalendarMember]) -> String {
    let identities: Vec<_> = members
        .iter()
        .map(|entry| {
            (
                reference_key(&entry.reference)
                    .expect("validated reference")
                    .0,
                entry.local_id.as_str(),
            )
        })
        .collect();
    sha256_hex(&serde_json::to_vec(&identities).expect("calendar identities serialize"))
}

fn read(root: &Map<String, Value>) -> Result<Confirmation, StoreError> {
    let Some(value) = root.get(METADATA_FIELD) else {
        return Ok(Confirmation::default());
    };
    if value.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err(StoreError::Invalid(
            "calendar confirmation metadata is malformed",
        ));
    }
    let generation = value.get("eligibleGeneration").ok_or(StoreError::Invalid(
        "calendar confirmation metadata is malformed",
    ))?;
    let (eligible_members, has_generation) = if generation.is_null() {
        (Vec::new(), false)
    } else {
        let raw_members =
            generation
                .get("members")
                .and_then(Value::as_array)
                .ok_or(StoreError::Invalid(
                    "calendar confirmation generation is malformed",
                ))?;
        let entries = raw_members
            .iter()
            .map(member)
            .collect::<Result<Vec<_>, _>>()?;
        let eligible_members = canonical_members(entries)?;
        if members_value(&eligible_members) != Value::Array(raw_members.clone())
            || generation.get("digest").and_then(Value::as_str)
                != Some(generation_digest(&eligible_members).as_str())
        {
            return Err(StoreError::Invalid(
                "calendar confirmation generation is malformed",
            ));
        }
        (eligible_members, true)
    };
    let raw_retained =
        value
            .get("retained")
            .and_then(Value::as_array)
            .ok_or(StoreError::Invalid(
                "calendar confirmation metadata is malformed",
            ))?;
    if raw_retained.len() > MAX_ICAL_EVENTS {
        return Err(StoreError::Invalid(
            "calendar confirmation exceeds its limit",
        ));
    }
    let mut retained_ids = BTreeSet::new();
    for id in raw_retained {
        let id = id
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 200)
            .ok_or(StoreError::Invalid(
                "calendar confirmation metadata is malformed",
            ))?;
        if !retained_ids.insert(id.to_owned()) {
            return Err(StoreError::Invalid(
                "calendar confirmation metadata is malformed",
            ));
        }
    }
    Ok(Confirmation {
        eligible_members,
        retained_ids,
        has_generation,
    })
}

fn existing_calendar_members(root: &Map<String, Value>) -> Result<Vec<CalendarMember>, StoreError> {
    let mut members = Vec::new();
    let items = root
        .get("items")
        .and_then(Value::as_array)
        .ok_or(StoreError::Invalid("native coursework items are malformed"))?;
    for item in items {
        let item_object = item
            .as_object()
            .ok_or(StoreError::Invalid("native coursework items are malformed"))?;
        if has_canvas_provenance(item_object) {
            continue;
        }
        let local_id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 200)
            .ok_or(StoreError::Invalid("native coursework items are malformed"))?;
        for reference in super::refs::item_references(item_object)? {
            if reference.get("source").and_then(Value::as_str) == Some("ical") {
                members.push(CalendarMember {
                    reference: reference.clone(),
                    local_id: local_id.to_owned(),
                });
            }
        }
    }
    canonical_members(members)
}

fn has_canvas_provenance(item: &Map<String, Value>) -> bool {
    if item.get("source").and_then(Value::as_str) == Some("canvas") {
        return true;
    }
    item.get("fieldObservations")
        .and_then(Value::as_object)
        .is_some_and(|fields| {
            fields.values().any(|value| {
                value
                    .get("owner")
                    .and_then(|owner| owner.get("source"))
                    .and_then(Value::as_str)
                    == Some("canvas")
                    || value
                        .get("selected")
                        .and_then(|selected| selected.get("owner"))
                        .and_then(|owner| owner.get("source"))
                        .and_then(Value::as_str)
                        == Some("canvas")
            })
        })
}

/// Records accepted positive observations on every successful apply. Only an eligible complete
/// feed advances the comparison baseline and marks omitted items as retained.
pub(super) fn apply(
    root: &mut Map<String, Value>,
    accepted: &[CalendarMember],
    eligible: bool,
) -> Result<bool, StoreError> {
    let before = root.get(METADATA_FIELD).cloned();
    let mut state = read(root)?;
    let accepted = canonical_members(accepted.iter().cloned())?;
    let accepted_ids: BTreeSet<_> = accepted
        .iter()
        .map(|entry| entry.local_id.clone())
        .collect();
    state.retained_ids.retain(|id| !accepted_ids.contains(id));

    if eligible {
        // Also seed from currently stored calendar-only references. This upgrades old stores
        // without timestamps and covers exact positives accepted during an earlier held feed.
        let prior_members = canonical_members(
            state
                .eligible_members
                .iter()
                .cloned()
                .chain(existing_calendar_members(root)?),
        )?;
        let present: BTreeSet<_> = accepted
            .iter()
            .map(|entry| {
                reference_key(&entry.reference)
                    .expect("validated reference")
                    .0
            })
            .collect();
        for prior in &prior_members {
            let key = reference_key(&prior.reference)?.0;
            if !present.contains(&key) && !accepted_ids.contains(&prior.local_id) {
                state.retained_ids.insert(prior.local_id.clone());
            }
        }
        state.eligible_members = accepted;
        state.has_generation = true;
    }
    if state.retained_ids.len() > MAX_ICAL_EVENTS {
        return Err(StoreError::Invalid(
            "calendar confirmation exceeds its limit",
        ));
    }
    if !state.has_generation && state.retained_ids.is_empty() {
        root.remove(METADATA_FIELD);
    } else {
        let generation = if state.has_generation {
            json!({
                "digest": generation_digest(&state.eligible_members),
                "members": members_value(&state.eligible_members),
            })
        } else {
            Value::Null
        };
        root.insert(
            METADATA_FIELD.into(),
            json!({
                "schema": 1,
                "eligibleGeneration": generation,
                "retained": state.retained_ids,
            }),
        );
    }
    Ok(before != root.get(METADATA_FIELD).cloned())
}

#[cfg(test)]
#[path = "ical_confirmation_tests.rs"]
mod tests;
