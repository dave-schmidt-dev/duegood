//! Bounded, private Canvas change history for the Activity view. Errors contain no document
//! content; the ledger itself intentionally stores old/new Canvas values for local display.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

use serde_json::Value;

use crate::store::{atomic_write, node_json_bytes, read_capped, utc_stamp, StoreError};

pub const HISTORY_FILE: &str = "coursework-refresh-history.json";
const MAX_HISTORY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_HISTORY_EVENTS: usize = 100;
const MAX_RECOVERY_ITEMS: usize = 100;
const MAX_HISTORY_TEXT: usize = 280;

/// Count and detail rows produced by a complete refresh.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CourseworkDiff {
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub changes: Vec<Value>,
}

fn canvas_id(item: &Value) -> Option<String> {
    match item.get("canvasId")? {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn is_observed_source_item(item: &Value) -> bool {
    item.get("source").and_then(Value::as_str) == Some("canvas")
        || item
            .get("sourceReferences")
            .and_then(Value::as_array)
            .is_some_and(|references| {
                references.iter().any(|reference| {
                    matches!(
                        reference.get("source").and_then(Value::as_str),
                        Some("canvas" | "ical")
                    )
                })
            })
}

fn stable_key(item: &Value) -> Option<String> {
    item.get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn indexed_items(value: &Value) -> Result<BTreeMap<String, &Value>, StoreError> {
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or(StoreError::Invalid("coursework items are malformed"))?;
    let mut indexed = BTreeMap::new();
    for item in items.iter().filter(|item| is_observed_source_item(item)) {
        let key =
            stable_key(item).ok_or(StoreError::Invalid("coursework item identity is malformed"))?;
        if indexed.insert(key, item).is_some() {
            return Err(StoreError::Invalid(
                "coursework item identity is duplicated",
            ));
        }
    }
    Ok(indexed)
}

fn item_label(item: &Value, key: &str, field: &str) -> Value {
    item.get(field)
        .cloned()
        .unwrap_or_else(|| Value::String(key.to_owned()))
}

const VISIBLE_SOURCE_FIELDS: &[&str] = &[
    "kind",
    "title",
    "at",
    "points",
    "url",
    "confidence",
    "flags",
    "detail",
    "assignmentGroupId",
    "assignmentGroupName",
    "assignmentGroupWeight",
    "submissionStatus",
    "submittedAt",
    "gradedAt",
    "grade",
    "score",
];

fn display_changes(before: &Value, after: &Value) -> Vec<Value> {
    VISIBLE_SOURCE_FIELDS
        .iter()
        .copied()
        .filter(|name| before.get(*name).is_some() || after.get(*name).is_some())
        .filter_map(|name| {
            let old = before.get(name).unwrap_or(&Value::Null);
            let new = after.get(name).unwrap_or(&Value::Null);
            (old != new).then(|| {
                serde_json::json!({
                    "field": if name == "submissionStatus" { "submissionState" } else { name },
                    "before": old,
                    "after": new,
                })
            })
        })
        .collect()
}

/// Diffs observed source items by immutable local ID. Student progress, source-reference
/// bookkeeping, and arbitrary local extensions never enter Activity history.
pub fn diff_coursework(before: &Value, after: &Value) -> Result<CourseworkDiff, StoreError> {
    let previous = indexed_items(before)?;
    let current = indexed_items(after)?;
    let mut diff = CourseworkDiff::default();

    for (key, item) in &current {
        match previous.get(key) {
            None => {
                diff.added += 1;
                diff.changes.push(serde_json::json!({
                    "kind": "added",
                    "itemId": item_label(item, key, "id"),
                    "title": item.get("title").cloned().unwrap_or(Value::Null),
                    "course": item.get("course").cloned().unwrap_or(Value::Null),
                }));
            }
            Some(old) => {
                let fields = display_changes(old, item);
                if !fields.is_empty() {
                    diff.updated += 1;
                    diff.changes.push(serde_json::json!({
                        "kind": "changed",
                        "itemId": item_label(item, key, "id"),
                        "title": item.get("title").cloned().unwrap_or(Value::Null),
                        "course": item.get("course").cloned().unwrap_or(Value::Null),
                        "fields": fields,
                    }));
                }
            }
        }
    }
    for (key, item) in &previous {
        if !current.contains_key(key) {
            diff.removed += 1;
            diff.changes.push(serde_json::json!({
                "kind": "removed",
                "itemId": item_label(item, key, "id"),
                "title": item.get("title").cloned().unwrap_or(Value::Null),
                "course": item.get("course").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    Ok(diff)
}

/// Builds the Activity record for one fully committed refresh.
pub fn event_value(
    diff: &CourseworkDiff,
    started_at: &str,
    finished_at: &str,
    now: SystemTime,
) -> Value {
    let stamp = utc_stamp(now);
    serde_json::json!({
        "schema": 1,
        "id": format!("refresh-{}-{}", stamp.compact, &uuid::Uuid::new_v4().simple().to_string()[..8]),
        "status": "succeeded",
        "sourceComplete": true,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "summary": { "added": diff.added, "updated": diff.updated, "removed": diff.removed },
        "changes": diff.changes,
    })
}

fn days_from_civil(mut year: i64, month: u32, day: u32) -> i64 {
    year -= i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = if month > 2 {
        month as i64 - 3
    } else {
        month as i64 + 9
    };
    let day_of_year = (153 * shifted_month + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Parses the RFC 3339 timestamps emitted by Canvas and this app to nanoseconds from epoch.
/// A malformed or unsupported timestamp is ignored as a recovery boundary/candidate.
fn timestamp_nanos(value: &Value) -> Option<i128> {
    let input = value.as_str()?.trim();
    if !(20..=64).contains(&input.len()) {
        return None;
    }
    let bytes = input.as_bytes();
    if !matches!(bytes[4], b'-')
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let decimal = |start: usize, end: usize| -> Option<u32> {
        let slice = bytes.get(start..end)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(slice).ok()?.parse().ok()
    };
    let year = decimal(0, 4)? as i64;
    let month = decimal(5, 7)?;
    let day = decimal(8, 10)?;
    let hour = decimal(11, 13)?;
    let minute = decimal(14, 16)?;
    let second = decimal(17, 19)?;
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => return None,
    };
    if day == 0 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    let mut cursor = 19;
    let mut fractional_nanos = 0_i128;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            if cursor - fraction_start < 9 {
                fractional_nanos = fractional_nanos * 10 + i128::from(bytes[cursor] - b'0');
            }
            cursor += 1;
        }
        let digits = cursor - fraction_start;
        if digits == 0 {
            return None;
        }
        for _ in digits.min(9)..9 {
            fractional_nanos *= 10;
        }
    }

    let offset_seconds = match bytes.get(cursor).copied()? {
        b'Z' | b'z' if cursor + 1 == bytes.len() => 0_i64,
        sign @ (b'+' | b'-') if cursor + 6 == bytes.len() => {
            if bytes[cursor + 3] != b':' {
                return None;
            }
            let offset_hour = decimal(cursor + 1, cursor + 3)?;
            let offset_minute = decimal(cursor + 4, cursor + 6)?;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let absolute = i64::from(offset_hour * 3_600 + offset_minute * 60);
            if sign == b'+' {
                absolute
            } else {
                -absolute
            }
        }
        _ => return None,
    };
    let local_seconds = i128::from(days_from_civil(year, month, day)) * 86_400
        + i128::from(hour * 3_600 + minute * 60 + second);
    Some((local_seconds - i128::from(offset_seconds)) * 1_000_000_000 + fractional_nanos)
}

fn bounded_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let value = value?.as_str()?;
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let normalized = normalized.trim();
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(max_chars).collect())
}

fn recovery_field(item: &Value, name: &str) -> Value {
    let value = item.get(name);
    match value {
        Some(Value::String(_)) => bounded_text(value, MAX_HISTORY_TEXT)
            .map(Value::String)
            .unwrap_or(Value::Null),
        Some(Value::Number(number)) if number.is_i64() || number.is_u64() || number.is_f64() => {
            Value::Number(number.clone())
        }
        _ => Value::Null,
    }
}

/// Finds one recoverable missed-grade event from the pre-refresh coursework baseline.
/// It only reads `path`; the caller appends the returned event before recording the current
/// refresh. A current capture must never be supplied here because its new grades have no
/// trustworthy prior-history comparison.
pub fn recover_missed_grade_history(
    path: &Path,
    current: &Value,
    now: SystemTime,
) -> Result<Option<Value>, StoreError> {
    let Some(bytes) = read_capped(path, MAX_HISTORY_BYTES)? else {
        return Ok(None);
    };
    let Ok(history) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(None);
    };
    if !history.as_object().is_some_and(|object| {
        object
            .get("schema")
            .is_none_or(|schema| schema.as_u64() == Some(1))
    }) {
        return Ok(None);
    }
    let Some(events) = history.get("events").and_then(Value::as_array) else {
        return Ok(None);
    };
    if events
        .iter()
        .any(|event| event.get("recovery").and_then(Value::as_str) == Some("recovery-v1"))
    {
        return Ok(None);
    }

    let boundary = events
        .iter()
        .filter(|event| {
            event.get("status").and_then(Value::as_str) == Some("succeeded")
                && event.get("sourceComplete").and_then(Value::as_bool) == Some(true)
        })
        .filter_map(|event| event.get("finishedAt").and_then(timestamp_nanos))
        .max();
    let Some(boundary) = boundary else {
        return Ok(None);
    };
    let Some(items) = current.get("items").and_then(Value::as_array) else {
        return Ok(None);
    };

    let mut changes = vec![serde_json::json!({
        "kind": "notice",
        "title": "Earlier grade history recovered",
        "detail": "An earlier Due Good refresh omitted item-level history; these current Canvas grade fields are shown without claiming a complete before/after diff."
    })];
    let mut candidates = 0_u64;
    for item in items {
        if item.get("source").and_then(Value::as_str) != Some("canvas") || canvas_id(item).is_none()
        {
            continue;
        }
        let Some(item_id) = bounded_text(item.get("id"), 160) else {
            continue;
        };
        let graded_at = bounded_text(item.get("gradedAt"), MAX_HISTORY_TEXT);
        let graded_at_value = graded_at.clone().map(Value::String).unwrap_or(Value::Null);
        if timestamp_nanos(&graded_at_value).is_none_or(|timestamp| timestamp <= boundary) {
            continue;
        }
        let submission_state = bounded_text(item.get("submissionState"), MAX_HISTORY_TEXT)
            .or_else(|| bounded_text(item.get("submissionStatus"), MAX_HISTORY_TEXT))
            .or_else(|| bounded_text(item.get("status"), MAX_HISTORY_TEXT));
        let grade = recovery_field(item, "grade");
        let score = item
            .get("score")
            .filter(|value| value.is_number())
            .cloned()
            .unwrap_or(Value::Null);
        if submission_state.as_deref() != Some("graded") && grade.is_null() && score.is_null() {
            continue;
        }
        let course = bounded_text(item.get("course"), 160)
            .map(Value::String)
            .unwrap_or(Value::Null);
        let title =
            bounded_text(item.get("title"), MAX_HISTORY_TEXT).unwrap_or_else(|| item_id.clone());
        changes.push(serde_json::json!({
            "kind": "changed",
            "itemId": item_id,
            "title": title,
            "course": course,
            "fields": [
                {"field":"submissionState", "before":null, "after":submission_state},
                {"field":"gradedAt", "before":null, "after":graded_at},
                {"field":"grade", "before":null, "after":grade},
                {"field":"score", "before":null, "after":score}
            ]
        }));
        candidates += 1;
        if candidates as usize == MAX_RECOVERY_ITEMS {
            break;
        }
    }
    if candidates == 0 {
        return Ok(None);
    }
    let stamp = utc_stamp(now);
    Ok(Some(serde_json::json!({
        "schema": 1,
        "id": format!("refresh-recovery-v1-{}-{}", stamp.iso, &uuid::Uuid::new_v4().simple().to_string()[..8]),
        "recovery": "recovery-v1",
        "status": "incomplete",
        "sourceComplete": false,
        "startedAt": stamp.iso,
        "finishedAt": stamp.iso,
        "summary": {"added": 0, "updated": candidates, "removed": 0},
        "changes": changes
    })))
}

fn valid_history(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.get("events").and_then(Value::as_array).is_some()
            && object
                .get("schema")
                .map_or(true, |schema| schema.as_u64() == Some(1))
    })
}

fn quarantine(path: &Path, now: SystemTime) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .ok_or(StoreError::Invalid("history path is invalid"))?;
    let stamp = utc_stamp(now);
    let target = parent.join(format!(
        "{HISTORY_FILE}.corrupt-{}-{}.json",
        stamp.compact,
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    fs::rename(path, target)?;
    crate::store::fsync_dir(parent)?;
    Ok(())
}

/// Appends an event to a complete staged store. Invalid prior history is retained under a
/// generated quarantine name, then a fresh ledger is written atomically.
pub fn append_event(path: &Path, event: Value, now: SystemTime) -> Result<(), StoreError> {
    let existed = fs::symlink_metadata(path).is_ok();
    let existing = match read_capped(path, MAX_HISTORY_BYTES) {
        Ok(Some(bytes)) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(valid_history),
        Ok(None) => None,
        Err(StoreError::TooLarge | StoreError::Invalid(_)) => None,
        Err(error) => return Err(error),
    };
    let mut history = if let Some(history) = existing {
        history
    } else {
        if existed {
            quarantine(path, now)?;
        }
        serde_json::json!({ "schema": 1, "events": [] })
    };
    history
        .as_object_mut()
        .and_then(|object| object.get_mut("events"))
        .and_then(Value::as_array_mut)
        .ok_or(StoreError::Invalid("refresh history is malformed"))?
        .push(event);
    loop {
        let event_count = history
            .get("events")
            .and_then(Value::as_array)
            .map(Vec::len)
            .ok_or(StoreError::Invalid("refresh history is malformed"))?;
        if event_count > MAX_HISTORY_EVENTS {
            history
                .get_mut("events")
                .and_then(Value::as_array_mut)
                .ok_or(StoreError::Invalid("refresh history is malformed"))?
                .remove(0);
            continue;
        }
        let bytes = node_json_bytes(&history);
        if bytes.len() as u64 > MAX_HISTORY_BYTES {
            if event_count <= 1 {
                return Err(StoreError::TooLarge);
            }
            history
                .get_mut("events")
                .and_then(Value::as_array_mut)
                .ok_or(StoreError::Invalid("refresh history is malformed"))?
                .remove(0);
            continue;
        }
        atomic_write(path, &bytes)?;
        break;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::create_private_dir;
    use crate::testutil::TempRoot;

    fn recovery_history(events: Value) -> (TempRoot, std::path::PathBuf) {
        let temp = TempRoot::new("grade-history-recovery");
        let store = temp.path().join("store");
        create_private_dir(&store, false).unwrap();
        let path = store.join(HISTORY_FILE);
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({"schema":1,"events":events})).unwrap(),
        )
        .unwrap();
        (temp, path)
    }

    fn eligible_baseline() -> Value {
        serde_json::json!({"items":[{
            "id":"canvas:course-1:assignment-42",
            "course":"course-1",
            "source":"canvas",
            "canvasId":42,
            "title":"Synthetic assignment",
            "submissionStatus":"graded",
            "gradedAt":"2026-08-12T09:30:00Z",
            "grade":"A-",
            "score":91.5
        }]})
    }

    #[test]
    fn diff_uses_immutable_local_identity_and_excludes_personal_progress() {
        let before = serde_json::json!({"items":[
            {"id":"stable-id","course":"c1","source":"canvas","canvasId":7,"title":"Old","done":false,"doneAt":null,"discussionPostDone":false,"grade":null},
            {"id":"manual","course":"c1","source":"manual","title":"Keep me"}
        ]});
        let after = serde_json::json!({"items":[
            {"id":"stable-id","course":"c1","source":"canvas","canvasId":7,"title":"New","done":true,"doneAt":"local-time","discussionPostDone":true,"grade":"A"},
            {"id":"new","course":"c1","source":"canvas","canvasId":"8","title":"Added"}
        ]});
        let diff = diff_coursework(&before, &after).expect("diff");
        assert_eq!((diff.added, diff.updated, diff.removed), (1, 1, 0));
        let changed = diff.changes.iter().find(|change| change["kind"] == "changed").unwrap();
        assert_eq!(changed["itemId"], "stable-id");
        assert_eq!(changed["fields"].as_array().unwrap().len(), 2);
        assert_eq!(changed["fields"][0]["field"], "title");
        assert_eq!(changed["fields"][1]["field"], "grade");
    }

    #[test]
    fn diff_ignores_reference_and_unknown_bookkeeping_but_records_visible_source_facts() {
        let before = serde_json::json!({"items":[{
            "id":"ical-local", "course":"c1", "source":"ical", "title":"Same",
            "sourceReferences":[{"institution":"synthetic.invalid","course":"c1","source":"ical","id":"assignment:7"}],
            "fieldObservations":{"at":{"selected":{"owner":{"institution":"synthetic.invalid","course":"c1","source":"ical","id":"assignment:7"},"value":"2030-01-01T10:00"}}},
            "notesExtension":{"private":true}
        }]});
        let after = serde_json::json!({"items":[{
            "id":"ical-local", "course":"c1", "source":"canvas", "title":"Same", "at":"2030-01-02T10:00",
            "canvasId":7,
            "sourceReferences":[
              {"institution":"synthetic.invalid","course":"c1","source":"ical","id":"assignment:7"},
              {"institution":"synthetic.invalid","course":"c1","source":"canvas","id":"7"}
            ],
            "fieldObservations":{"at":{"selected":{"owner":{"institution":"synthetic.invalid","course":"c1","source":"canvas","id":"7"},"value":"2030-01-02T10:00","observedAt":"2030-01-01T00:00:00Z"}}},
            "notesExtension":{"private":false}
        }]});
        let diff = diff_coursework(&before, &after).expect("diff");
        assert_eq!((diff.added, diff.updated, diff.removed), (0, 1, 0));
        assert_eq!(diff.changes[0]["itemId"], "ical-local");
        assert_eq!(
            diff.changes[0]["fields"],
            serde_json::json!([{
                "field":"at", "before":null, "after":"2030-01-02T10:00"
            }])
        );
    }

    #[test]
    fn malformed_history_is_quarantined_and_capped() {
        let temp = TempRoot::new("history");
        let store = temp.path().join("store");
        create_private_dir(&store, false).unwrap();
        let path = store.join(HISTORY_FILE);
        fs::write(&path, b"{broken").unwrap();
        let event = serde_json::json!({"status":"succeeded"});
        append_event(&path, event.clone(), SystemTime::UNIX_EPOCH).unwrap();
        let quarantines: Vec<_> = fs::read_dir(&store)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(quarantines.len(), 1);
        assert_eq!(fs::read(quarantines[0].path()).unwrap(), b"{broken");
        for _ in 0..MAX_HISTORY_EVENTS {
            append_event(&path, event.clone(), SystemTime::UNIX_EPOCH).unwrap();
        }
        let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            value["events"].as_array().unwrap().len(),
            MAX_HISTORY_EVENTS
        );
    }

    #[test]
    fn missed_grade_recovery_records_current_fields_without_a_before_claim() {
        let (_temp, path) = recovery_history(serde_json::json!([
            {"status":"succeeded","sourceComplete":true,"finishedAt":"2026-08-01T00:00:00Z"},
            {"status":"succeeded","sourceComplete":false,"finishedAt":"2026-08-11T00:00:00Z"},
            {"status":"failed","sourceComplete":true,"finishedAt":"2026-08-20T00:00:00Z"}
        ]));
        let prior_bytes = fs::read(&path).unwrap();
        let event = recover_missed_grade_history(
            &path,
            &eligible_baseline(),
            SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000),
        )
        .unwrap()
        .expect("one grade event should be recovered");

        assert_eq!(event["recovery"], "recovery-v1");
        assert_eq!(event["status"], "incomplete");
        assert_eq!(event["sourceComplete"], false);
        assert_eq!(event["summary"]["updated"], 1);
        assert_eq!(event["changes"][0]["kind"], "notice");
        let fields = event["changes"][1]["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 4);
        assert_eq!(fields[0]["field"], "submissionState");
        assert_eq!(fields[0]["before"], Value::Null);
        assert_eq!(fields[0]["after"], "graded");
        assert_eq!(fields[1]["after"], "2026-08-12T09:30:00Z");
        assert_eq!(fields[2]["after"], "A-");
        assert_eq!(fields[3]["after"], 91.5);
        assert_eq!(
            fs::read(path).unwrap(),
            prior_bytes,
            "the caller appends the event"
        );
    }

    #[test]
    fn missed_grade_recovery_is_idempotent_and_ignores_unqualified_history() {
        let baseline = eligible_baseline();
        let (_temp, path) = recovery_history(serde_json::json!([
            {"status":"succeeded","sourceComplete":true,"finishedAt":"2026-08-01T00:00:00Z"},
            {"status":"incomplete","sourceComplete":false,"finishedAt":"2026-08-13T00:00:00Z","recovery":"recovery-v1"}
        ]));
        assert!(
            recover_missed_grade_history(&path, &baseline, SystemTime::UNIX_EPOCH)
                .unwrap()
                .is_none()
        );

        let (_temp, path) = recovery_history(serde_json::json!([
            {"status":"incomplete","sourceComplete":false,"finishedAt":"2026-08-01T00:00:00Z"},
            {"status":"failed","sourceComplete":true,"finishedAt":"2026-08-02T00:00:00Z"}
        ]));
        assert!(
            recover_missed_grade_history(&path, &baseline, SystemTime::UNIX_EPOCH)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn pre_refresh_baseline_does_not_turn_a_new_capture_grade_into_recovery() {
        let (_temp, path) = recovery_history(serde_json::json!([
            {"status":"succeeded","sourceComplete":true,"finishedAt":"2026-08-01T00:00:00Z"}
        ]));
        let baseline = serde_json::json!({"items":[{
            "id":"canvas:course-1:assignment-42",
            "course":"course-1",
            "source":"canvas",
            "canvasId":42,
            "title":"Synthetic assignment",
            "submissionStatus":"submitted",
            "gradedAt":null,
            "grade":null,
            "score":null
        }]});
        let current_capture = serde_json::json!({"items":[{
            "id":"canvas:course-1:assignment-42",
            "course":"course-1",
            "source":"canvas",
            "canvasId":42,
            "title":"Synthetic assignment",
            "submissionStatus":"graded",
            "gradedAt":"2026-08-12T09:30:00Z",
            "grade":"A-",
            "score":91.5
        }]});
        assert_eq!(current_capture["items"][0]["grade"], "A-");
        assert!(
            recover_missed_grade_history(&path, &baseline, SystemTime::UNIX_EPOCH)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn missed_grade_recovery_caps_items_and_compares_timezone_offsets() {
        let (_temp, path) = recovery_history(serde_json::json!([
            {"status":"succeeded","sourceComplete":true,"finishedAt":"2026-08-01T00:00:00-04:00"}
        ]));
        let items: Vec<Value> = (0..MAX_RECOVERY_ITEMS + 1)
            .map(|index| {
                serde_json::json!({
                    "id":format!("synthetic-{index}"),
                    "course":"course-1",
                    "source":"canvas",
                    "canvasId":index,
                    "title":"Synthetic assignment",
                    "submissionStatus":"graded",
                "gradedAt":"2026-08-01T05:00:00Z",
                    "grade":"A"
                })
            })
            .collect();
        let current = serde_json::json!({"items":items});
        let event = recover_missed_grade_history(&path, &current, SystemTime::UNIX_EPOCH)
            .unwrap()
            .expect("fraction after the boundary should be a candidate");
        assert_eq!(event["summary"]["updated"], MAX_RECOVERY_ITEMS);
        assert_eq!(
            event["changes"].as_array().unwrap().len(),
            MAX_RECOVERY_ITEMS + 1
        );
    }
}
