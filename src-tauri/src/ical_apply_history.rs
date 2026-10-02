//! Activity history diff, calendar event building, and refresh generation publishing.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};

use crate::config::{COURSEWORK_FILE, MANIFEST_FILE, STAGING_PREFIX};
use crate::history::{self, CourseworkDiff, HISTORY_FILE};
use crate::ical::HeldIcalEvent;
use crate::store::{atomic_write, fsync_dir, read_capped, utc_stamp, Store, StoreError};

use super::merge::HeldNotice;

const MAX_HISTORY_TEXT: usize = 280;
const MAX_CHANGES: usize = 500;

fn bounded_text(value: &str, max_chars: usize) -> String {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean = clean.trim();
    clean.chars().take(max_chars).collect()
}

pub(super) fn build_calendar_history_event(
    diff: &CourseworkDiff,
    finished_at: &str,
    held_notices: &[HeldNotice],
    parser_held: &[HeldIcalEvent],
    now: SystemTime,
) -> Value {
    let stamp = utc_stamp(now);
    let total_held = held_notices.len() + parser_held.len();
    let status = if total_held > 0 {
        "incomplete"
    } else {
        "succeeded"
    };

    let mut changes = Vec::new();

    for change in &diff.changes {
        let kind = change.get("kind").and_then(Value::as_str);
        if kind == Some("removed") {
            continue;
        }
        changes.push(change.clone());
    }

    for notice in held_notices {
        changes.push(json!({
            "kind": "notice",
            "itemId": bounded_text(&notice.item_id, 200),
            "course": bounded_text(&notice.course, 160),
            "title": bounded_text(&notice.title, MAX_HISTORY_TEXT),
            "detail": bounded_text(&notice.detail, MAX_HISTORY_TEXT),
        }));
    }

    for held in parser_held {
        let item_id = bounded_text(&held.uid, 200);
        let course = held
            .candidate_courses
            .first()
            .map(|c| bounded_text(c, 160))
            .unwrap_or_default();
        let title = if !item_id.is_empty() {
            format!("Calendar event {item_id}")
        } else {
            "Calendar event held".to_string()
        };
        changes.push(json!({
            "kind": "notice",
            "itemId": item_id,
            "course": course,
            "title": title,
            "detail": held.reason,
        }));
    }

    changes.truncate(MAX_CHANGES);

    json!({
        "schema": 1,
        "id": format!("refresh-{}-{}", stamp.compact, &uuid::Uuid::new_v4().simple().to_string()[..8]),
        "status": status,
        "source": "calendar",
        "sourceLabel": "calendar",
        "sourceComplete": false,
        "startedAt": finished_at,
        "finishedAt": finished_at,
        "summary": {
            "added": diff.added,
            "updated": diff.updated,
            "removed": 0,
            "held": total_held,
        },
        "changes": changes,
    })
}

struct StagingGuard(PathBuf);

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

pub(super) fn publish_calendar_generation(
    store: &Store,
    coursework_bytes: &[u8],
    event: Value,
    now: SystemTime,
) -> Result<(), StoreError> {
    let generation = uuid::Uuid::new_v4().simple().to_string();
    let staging = store
        .data_root()
        .join(format!("{STAGING_PREFIX}refresh-{generation}"));

    let _cleanup = StagingGuard(staging.clone());

    crate::export::copy_tree(&store.store_dir(), &staging, true, &mut |_| {})?;

    atomic_write(&staging.join(COURSEWORK_FILE), coursework_bytes)?;

    history::append_event(&staging.join(HISTORY_FILE), event, now)?;

    let manifest_before = read_capped(&store.store_dir().join(MANIFEST_FILE), 1024 * 1024)?
        .ok_or(StoreError::Invalid("store manifest is missing"))?;
    let manifest_after = read_capped(&staging.join(MANIFEST_FILE), 1024 * 1024)?
        .ok_or(StoreError::Invalid("staged manifest is missing"))?;
    if manifest_before != manifest_after {
        return Err(StoreError::Invalid("refresh changed the store manifest"));
    }

    fsync_dir(&staging)?;

    store.publish_refresh_generation(&staging, &generation)?;

    Ok(())
}

pub(super) fn record_bootstrap_history(
    staging_path: &Path,
    document: &Value,
    finished_at: &str,
    held_notices: &[HeldNotice],
    parser_held: &[HeldIcalEvent],
    now: SystemTime,
) -> Result<(), StoreError> {
    let empty_baseline = json!({ "items": [] });
    let diff = history::diff_coursework(&empty_baseline, document)?;
    let event = build_calendar_history_event(&diff, finished_at, held_notices, parser_held, now);
    history::append_event(&staging_path.join(HISTORY_FILE), event, now)
}

#[cfg(test)]
#[path = "ical_apply_history_tests.rs"]
mod tests;
