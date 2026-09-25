//! First-run calendar store creation. All data is staged before an empty-store-only adoption.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde_json::{json, Value};

use crate::config::{COURSEWORK_FILE, MANIFEST_FILE, STAGING_PREFIX};
use crate::ical::{IcalNormalization, IcalNormalizeOptions};
use crate::store::{
    atomic_write, create_private_dir, fsync_dir, new_preview_manifest, node_json_bytes, sha256_hex,
    Store, StoreCondition, StoreError,
};

use super::{merge, ApplyResult, IcalApplyError};

struct Stage {
    path: PathBuf,
    adopted: bool,
}

impl Drop for Stage {
    fn drop(&mut self) {
        if !self.adopted {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// Creates a minimal authoritative store only after one useful, validated calendar import.
pub(crate) fn bootstrap_normalization(
    store: &Store,
    options: &IcalNormalizeOptions,
    finished_at: &str,
    normalized: &IcalNormalization,
) -> Result<ApplyResult, IcalApplyError> {
    if normalized.observations.is_empty() || normalized.deletions != 0 {
        return Err(StoreError::Invalid("the calendar has no importable assignments").into());
    }
    if !super::facts::valid_timestamp(finished_at) {
        return Err(StoreError::Invalid("calendar import timestamp is invalid").into());
    }
    if options.canvas_origin != crate::canvas::CANVAS_ORIGIN || options.courses.is_empty() {
        return Err(StoreError::Invalid("calendar scope is invalid").into());
    }
    if !matches!(store.condition()?, StoreCondition::Empty) {
        return Err(StoreError::Invalid("calendar setup requires an empty app store").into());
    }
    let used_courses = normalized
        .observations
        .iter()
        .filter_map(|observation| observation.get("course").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let mut effective_options = options.clone();
    effective_options
        .courses
        .retain(|course| used_courses.contains(course.key.as_str()));
    let courses = effective_options
        .courses
        .iter()
        .map(|course| {
            json!({
                "key": course.key,
                "code": format!("Canvas {}", course.canvas_course_id),
                "title": format!("Canvas course {}", course.canvas_course_id),
                "color": "#5b7c99",
                "folder": Value::Null,
                "canvas": true,
                "canvasCourseId": course.canvas_course_id,
            })
        })
        .collect::<Vec<_>>();
    let mut document = json!({
        "schema": 1,
        "generated": finished_at,
        "source": "ical",
        "timezone": "America/New_York",
        "term": "Canvas calendar",
        "sync": { "status": "complete", "completedAt": finished_at },
        "courses": courses,
        "items": [],
    });
    let merged =
        merge::apply_to_document(&mut document, &effective_options, finished_at, normalized)?;
    if merged.added == 0 {
        return Err(StoreError::Invalid("the calendar has no importable assignments").into());
    }
    let map = json!({ "courses": effective_options.courses.iter().map(|course| json!({
        "key": course.key,
        "canvasId": course.canvas_course_id,
    })).collect::<Vec<_>>() });
    let coursework_bytes = node_json_bytes(&document);
    let map_bytes = node_json_bytes(&map);
    let path = store.data_root().join(format!(
        "{STAGING_PREFIX}ical-{}",
        uuid::Uuid::new_v4().simple()
    ));
    create_private_dir(&path, false)?;
    let mut stage = Stage {
        path,
        adopted: false,
    };
    atomic_write(&stage.path.join(COURSEWORK_FILE), &coursework_bytes)?;
    atomic_write(&stage.path.join("courses.json"), &map_bytes)?;
    let mut digest_input = coursework_bytes.clone();
    digest_input.extend_from_slice(&map_bytes);
    let mut manifest = new_preview_manifest(
        2,
        digest_input.len() as u64,
        &sha256_hex(&digest_input),
        SystemTime::now(),
    );
    manifest["state"] = Value::String("authoritative".into());
    manifest["source"]["kind"] = Value::String("ical-bootstrap".into());
    atomic_write(&stage.path.join(MANIFEST_FILE), &node_json_bytes(&manifest))?;
    fsync_dir(&stage.path)?;
    store.adopt_staging(&stage.path, &StoreCondition::Empty)?;
    stage.adopted = true;
    Ok(ApplyResult {
        version: sha256_hex(&coursework_bytes),
        added: merged.added,
        updated: merged.updated,
        held: merged.held,
        parser_held: normalized.held.len(),
        removed: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use crate::ical::{bootstrap_options, normalize_canvas_ical};
    use crate::store::{StoreCondition, StoreState};
    use crate::testutil::TempRoot;

    fn feed(url: &str) -> Vec<u8> {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-assignment-7\r\nSUMMARY:Synthetic assignment\r\nDTSTART:20300120T150000Z\r\nURL:{url}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n").into_bytes()
    }

    #[test]
    fn first_fetch_creates_authoritative_store_and_repeat_keeps_item_identity() {
        let root = TempRoot::new("ical-bootstrap");
        let store = Store::open(root.path(), Duration::from_millis(200)).unwrap();
        let bytes = String::from_utf8(feed("https://marymount.instructure.com/courses/42/assignments/7"))
            .unwrap()
            .replace("END:VCALENDAR\r\n", "BEGIN:VEVENT\r\nUID:event-calendar-event-8\r\nSUMMARY:Unverified event\r\nDTSTART:20300121T150000Z\r\nURL:https://marymount.instructure.com/courses/99/calendar_events/8\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
            .into_bytes();
        let scope = bootstrap_options(&bytes).unwrap();
        assert_eq!(scope.courses.len(), 2);
        let normalized = normalize_canvas_ical(&bytes, &scope).unwrap();
        let first =
            bootstrap_normalization(&store, &scope, "2030-01-01T00:00:00Z", &normalized).unwrap();
        assert_eq!(first.added, 1);
        assert!(
            matches!(store.condition().unwrap(), StoreCondition::Ready(summary) if summary.state == StoreState::Authoritative)
        );
        let derived = super::super::normalization_options(&store).unwrap();
        assert_eq!(derived.institution, "marymount.instructure.com");
        assert_eq!(derived.courses.len(), 1);
        assert_eq!(derived.courses[0].key, "canvas-42");
        let prior = fs::read(store.store_dir().join(COURSEWORK_FILE)).unwrap();
        let second = super::super::apply_normalization(
            &store,
            &derived,
            "2030-01-02T00:00:00Z",
            &normalized,
        )
        .unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(
            fs::read(store.store_dir().join(COURSEWORK_FILE)).unwrap(),
            prior
        );
        assert!(
            bootstrap_normalization(&store, &scope, "2030-01-03T00:00:00Z", &normalized).is_err()
        );
        assert_eq!(
            fs::read(store.store_dir().join(COURSEWORK_FILE)).unwrap(),
            prior
        );
    }

    #[test]
    fn held_only_feed_never_creates_store() {
        let root = TempRoot::new("ical-bootstrap-held");
        let store = Store::open(root.path(), Duration::from_millis(200)).unwrap();
        let bytes = feed("https://marymount.instructure.com/courses/42/calendar_events/7");
        let scope = bootstrap_options(&bytes).unwrap();
        let normalized = normalize_canvas_ical(&bytes, &scope).unwrap();
        assert!(
            bootstrap_normalization(&store, &scope, "2030-01-01T00:00:00Z", &normalized).is_err()
        );
        assert!(matches!(store.condition().unwrap(), StoreCondition::Empty));
    }
}
