//! Minimal, generation-bound Canvas calendar identities for iCal normalization.

use std::collections::{BTreeMap, HashMap};

use chrono::DateTime;
use serde_json::{json, Value};
use url::Url;

use crate::browser_projection::BrowserCourseScope;
use crate::canvas::CANVAS_ORIGIN;

const FORMAT: &str = "duegood-calendar-event-identities";

pub(super) fn project_event_identities(snapshot: &Value, scope: &BrowserCourseScope) -> Value {
    let context_code = format!("course_{}", scope.canvas_course_id);
    let resources = snapshot
        .get("resources")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let coverage = snapshot
        .get("coverage")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let matching_resources = resources
        .iter()
        .filter(|resource| resource_matches(resource, scope.canvas_course_id, &context_code))
        .collect::<Vec<_>>();
    let matching_coverage = coverage
        .iter()
        .filter(|row| resource_matches(row, scope.canvas_course_id, &context_code))
        .collect::<Vec<_>>();
    let complete = matching_resources.len() == 1
        && matching_coverage.len() == 1
        && matching_coverage[0].get("status").and_then(Value::as_str) == Some("complete")
        && matching_resources[0]
            .get("items")
            .and_then(Value::as_array)
            .is_some();

    let events = if complete {
        project_items(
            matching_resources[0]
                .get("items")
                .and_then(Value::as_array)
                .expect("complete resource has an item array"),
            &context_code,
        )
    } else {
        Vec::new()
    };
    let origin = snapshot
        .get("identity")
        .and_then(|identity| identity.get("origin"))
        .and_then(Value::as_str);
    let institution = origin
        .filter(|origin| *origin == CANVAS_ORIGIN)
        .and_then(|origin| Url::parse(origin).ok())
        .and_then(|url| url.host_str().map(str::to_owned));

    json!({
        "format": FORMAT,
        "version": 1,
        "runId": snapshot.get("runId"),
        "generationId": snapshot.get("generationId"),
        "userId": snapshot.pointer("/identity/userId"),
        "origin": origin,
        "institution": institution,
        "courseKey": scope.key,
        "canvasCourseId": scope.canvas_course_id,
        "coverage": {
            "endpoint": "calendarEvents",
            "contextCode": context_code,
            "status": if complete { "complete" } else { "unavailable" }
        },
        "events": events
    })
}

fn resource_matches(value: &Value, course_id: u64, context_code: &str) -> bool {
    value.get("endpoint").and_then(Value::as_str) == Some("calendarEvents")
        && value.get("courseId").and_then(Value::as_u64) == Some(course_id)
        && value.get("groupId").is_none_or(Value::is_null)
        && value.get("contextCode").and_then(Value::as_str) == Some(context_code)
}

fn project_items(items: &[Value], context_code: &str) -> Vec<Value> {
    let mut counts = HashMap::<u64, usize>::new();
    for item in items {
        if let Some(id) = positive_id(item.get("id")) {
            *counts.entry(id).or_default() += 1;
        }
    }
    let mut projected = BTreeMap::<u64, Value>::new();
    for item in items {
        let Some(id) = positive_id(item.get("id")) else {
            continue;
        };
        let Some(start_at) = item.get("start_at").and_then(Value::as_str) else {
            continue;
        };
        if counts.get(&id) != Some(&1)
            || item.get("context_code").and_then(Value::as_str) != Some(context_code)
            || item.get("type").and_then(Value::as_str) != Some("event")
            || item.get("all_day").and_then(Value::as_bool) != Some(true)
            || start_at.len() > 64
            || DateTime::parse_from_rfc3339(start_at).is_err()
        {
            continue;
        }
        projected.insert(
            id,
            json!({
                "id": id.to_string(),
                "uid": format!("event-calendar-event-{id}"),
                "contextCode": context_code,
                "type": "event",
                "allDay": true,
                "startAt": start_at
            }),
        );
    }
    projected.into_values().collect()
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    let id = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))?;
    (id > 0).then_some(id)
}
