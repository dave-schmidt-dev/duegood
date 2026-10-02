use super::*;
use std::collections::HashMap;
use std::time::Duration;

use crate::canvas::CANVAS_ORIGIN;
use crate::ical::{
    bootstrap_options, normalize_canvas_ical, IcalCourseIdentity, IcalNormalization,
    IcalNormalizeOptions,
};
use crate::store::{
    create_private_dir, new_preview_manifest, node_json_bytes, StoreCondition, StoreState,
};
use crate::testutil::TempRoot;

fn test_store() -> (TempRoot, Store) {
    let root = TempRoot::new("ical-apply-history");
    let store = Store::open(root.path(), Duration::from_millis(200)).unwrap();
    let directory = store.store_dir();
    create_private_dir(&directory, false).unwrap();
    let mut manifest = new_preview_manifest(1, 10, "synthetic", SystemTime::now());
    manifest["state"] = Value::String("authoritative".into());
    atomic_write(
        &directory.join(crate::config::MANIFEST_FILE),
        &node_json_bytes(&manifest),
    )
    .unwrap();
    let mut coursework: Value = serde_json::from_slice(include_bytes!(
        "../../fixtures/local-coursework-contract.json"
    ))
    .unwrap();
    coursework["items"][0]["sourceReferences"] = json!([{
        "institution": "synthetic.institution.invalid",
        "course": "course-a",
        "source": "canvas",
        "id": "910001"
    }]);
    atomic_write(
        &directory.join(COURSEWORK_FILE),
        &node_json_bytes(&coursework),
    )
    .unwrap();
    atomic_write(
        &directory.join("courses.json"),
        br#"{"courses":[{"key":"course-a","canvasId":900001}]}"#,
    )
    .unwrap();
    (root, store)
}

fn test_options() -> IcalNormalizeOptions {
    IcalNormalizeOptions {
        institution: "synthetic.institution.invalid".into(),
        canvas_origin: CANVAS_ORIGIN.into(),
        courses: vec![IcalCourseIdentity {
            key: "course-a".into(),
            canvas_course_id: "900001".into(),
        }],
        verified_events: HashMap::new(),
        explicit_uid_mappings: HashMap::new(),
    }
}

fn test_observation(id: &str, local_id: &str, canvas_course_id: &str, title: &str) -> Value {
    json!({
        "localId": local_id,
        "course": "course-a",
        "reference": {
            "institution": "synthetic.institution.invalid",
            "course": "course-a",
            "source": "ical",
            "id": format!("assignment:{id}")
        },
        "fields": {
            "kind": "assignment",
            "title": title,
            "at": "2030-01-29T23:59:00.000Z",
            "url": format!("https://marymount.instructure.com/courses/{canvas_course_id}/assignments/{id}")
        }
    })
}

fn test_normalized(observations: Vec<Value>, held: Vec<HeldIcalEvent>) -> IcalNormalization {
    IcalNormalization {
        events: Vec::new(),
        observations,
        held,
        deletions: 0,
    }
}

#[test]
fn persisted_counts_and_changed_fields_detail() {
    let (_root, store) = test_store();
    let input = test_normalized(
        vec![
            test_observation("910001", "ical-existing-id", "900001", "Updated Title"),
            test_observation("910099", "ical-new-id", "900001", "Brand New Title"),
        ],
        Vec::new(),
    );
    let outcome = crate::ical_apply::apply_normalization(
        &store,
        &test_options(),
        "2030-01-10T12:00:00Z",
        &input,
    )
    .unwrap();
    assert_eq!(outcome.added, 1);
    assert_eq!(outcome.updated, 1);
    assert_eq!(outcome.held, 0);
    assert_eq!(outcome.removed, 0);

    let history_bytes = fs::read(store.store_dir().join(HISTORY_FILE)).unwrap();
    let history: Value = serde_json::from_slice(&history_bytes).unwrap();
    let events = history["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event["summary"]["added"], 1);
    assert_eq!(event["summary"]["updated"], 1);
    assert_eq!(event["summary"]["removed"], 0);
    assert_eq!(event["source"], "calendar");
    assert_eq!(event["sourceLabel"], "calendar");
    assert_eq!(event["sourceComplete"], false);
    assert_eq!(event["status"], "succeeded");

    let changes = event["changes"].as_array().unwrap();
    let changed = changes
        .iter()
        .find(|c| c["kind"] == "changed" && c["itemId"] == "course-a-canvas-910001")
        .expect("changed item present");
    assert_eq!(changed["title"], "Synthetic Submitted Work");
    let fields = changed["fields"].as_array().unwrap();
    let at_field = fields.iter().find(|f| f["field"] == "at").unwrap();
    assert_eq!(at_field["before"], "2030-01-10T23:59");
    assert_eq!(at_field["after"], "2030-01-29T23:59:00.000Z");

    let added = changes.iter().find(|c| c["kind"] == "added").unwrap();
    assert_eq!(added["itemId"], "ical-new-id");
    assert_eq!(added["title"], "Brand New Title");
}

#[test]
fn held_notices_and_incomplete_status() {
    let (_root, store) = test_store();
    let path = store.store_dir().join(COURSEWORK_FILE);
    let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let duplicate = document["items"][0].clone();
    let mut duplicate = duplicate;
    duplicate["id"] = Value::String("course-a-canvas-duplicate".into());
    duplicate
        .as_object_mut()
        .unwrap()
        .remove("sourceReferences");
    document["items"].as_array_mut().unwrap().push(duplicate);
    atomic_write(&path, &node_json_bytes(&document)).unwrap();

    let input = test_normalized(
        vec![test_observation(
            "910001",
            "ical-collision-id",
            "900001",
            "Feed Title",
        )],
        vec![HeldIcalEvent {
            uid: "event-unsupported-7".into(),
            reason: "unsupported-event",
            canvas_course_id: Some("900001".into()),
            candidate_courses: vec!["course-a".into()],
            cancelled: false,
        }],
    );
    let outcome = crate::ical_apply::apply_normalization(
        &store,
        &test_options(),
        "2030-01-10T12:00:00Z",
        &input,
    )
    .unwrap();
    assert_eq!(outcome.held, 1);
    assert_eq!(outcome.parser_held, 1);

    let history_bytes = fs::read(store.store_dir().join(HISTORY_FILE)).unwrap();
    let history: Value = serde_json::from_slice(&history_bytes).unwrap();
    let event = &history["events"].as_array().unwrap()[0];
    assert_eq!(event["status"], "incomplete");
    assert_eq!(event["sourceComplete"], false);

    let changes = event["changes"].as_array().unwrap();
    let conflict_notice = changes
        .iter()
        .find(|c| {
            c["kind"] == "notice"
                && c.get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .contains("conflicting-match")
        })
        .expect("conflict notice present");
    assert_eq!(conflict_notice["itemId"], "ical-collision-id");

    let parser_notice = changes
        .iter()
        .find(|c| {
            c["kind"] == "notice"
                && c.get("detail").and_then(Value::as_str) == Some("unsupported-event")
        })
        .expect("parser held notice present");
    assert_eq!(parser_notice["itemId"], "event-unsupported-7");
}

#[test]
fn unchanged_repeat_history() {
    let (_root, store) = test_store();
    let input = test_normalized(
        vec![test_observation(
            "910001",
            "ical-id",
            "900001",
            "Synthetic Submitted Work",
        )],
        Vec::new(),
    );
    let first = crate::ical_apply::apply_normalization(
        &store,
        &test_options(),
        "2030-01-10T12:00:00Z",
        &input,
    )
    .unwrap();
    let coursework_after_first = fs::read(store.store_dir().join(COURSEWORK_FILE)).unwrap();

    let second = crate::ical_apply::apply_normalization(
        &store,
        &test_options(),
        "2030-01-10T12:05:00Z",
        &input,
    )
    .unwrap();
    assert_eq!(second.added, 0);
    assert_eq!(second.updated, 0);
    assert_eq!(second.version, first.version);
    assert_eq!(
        fs::read(store.store_dir().join(COURSEWORK_FILE)).unwrap(),
        coursework_after_first
    );

    let history_bytes = fs::read(store.store_dir().join(HISTORY_FILE)).unwrap();
    let history: Value = serde_json::from_slice(&history_bytes).unwrap();
    let events = history["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1]["summary"]["added"], 0);
    assert_eq!(events[1]["summary"]["updated"], 0);
    assert_eq!(events[1]["status"], "succeeded");
}

#[test]
fn personal_state_retention() {
    let (_root, store) = test_store();
    let path = store.store_dir().join(COURSEWORK_FILE);
    let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let item = &mut document["items"][0];
    item["done"] = json!(true);
    item["doneAt"] = json!("2030-01-09T15:05:00Z");
    item["notes"] = json!("Private student study note");
    item["manualGrade"] = json!({"source": "manual", "value": "A"});
    item["syntheticItemExtension"] = json!({"preserve": "extension"});
    atomic_write(&path, &node_json_bytes(&document)).unwrap();

    let input = test_normalized(
        vec![test_observation(
            "910001",
            "ical-id",
            "900001",
            "Updated Feed Title",
        )],
        Vec::new(),
    );
    crate::ical_apply::apply_normalization(&store, &test_options(), "2030-01-10T12:00:00Z", &input)
        .unwrap();

    let after: Value =
        serde_json::from_slice(&fs::read(store.store_dir().join(COURSEWORK_FILE)).unwrap())
            .unwrap();
    let updated_item = &after["items"][0];
    assert_eq!(updated_item["done"], true);
    assert_eq!(updated_item["doneAt"], "2030-01-09T15:05:00Z");
    assert_eq!(updated_item["notes"], "Private student study note");
    assert_eq!(updated_item["manualGrade"]["value"], "A");
    assert_eq!(
        updated_item["syntheticItemExtension"]["preserve"],
        "extension"
    );

    let history_bytes = fs::read(store.store_dir().join(HISTORY_FILE)).unwrap();
    let history: Value = serde_json::from_slice(&history_bytes).unwrap();
    let event = &history["events"].as_array().unwrap()[0];
    let changes = event["changes"].as_array().unwrap();
    let changed = changes.iter().find(|c| c["kind"] == "changed").unwrap();
    let fields = changed["fields"].as_array().unwrap();
    for field in fields {
        let name = field["field"].as_str().unwrap();
        assert!(
            name != "done" && name != "doneAt" && name != "notes" && name != "manualGrade",
            "personal field leaked into diff: {name}"
        );
    }
}

#[test]
fn atomic_failure_retaining_prior_store() {
    let (_root, store) = test_store();
    let path = store.store_dir().join(COURSEWORK_FILE);
    let coursework_before = fs::read(&path).unwrap();
    let manifest_before = fs::read(store.store_dir().join(MANIFEST_FILE)).unwrap();

    let mut invalid_options = test_options();
    invalid_options.canvas_origin = "https://untrusted-origin.invalid".into();
    let input = test_normalized(
        vec![test_observation("910001", "ical-id", "900001", "New Title")],
        Vec::new(),
    );
    let err = crate::ical_apply::apply_normalization(
        &store,
        &invalid_options,
        "2030-01-10T12:00:00Z",
        &input,
    )
    .expect_err("mismatched origin must fail");

    assert!(err.to_string().contains("origin"));
    assert_eq!(fs::read(&path).unwrap(), coursework_before);
    assert_eq!(
        fs::read(store.store_dir().join(MANIFEST_FILE)).unwrap(),
        manifest_before
    );

    let data_root_entries = fs::read_dir(store.data_root()).unwrap();
    for entry in data_root_entries {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        assert!(
            !name.starts_with(STAGING_PREFIX),
            "orphaned staging: {name}"
        );
    }
}

#[test]
fn bootstrap_same_staging() {
    let root = TempRoot::new("ical-history-bootstrap");
    let store = Store::open(root.path(), Duration::from_millis(200)).unwrap();
    let feed = format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-assignment-42\r\nSUMMARY:Bootstrap assignment\r\nDTSTART:20300120T150000Z\r\nURL:https://marymount.instructure.com/courses/900001/assignments/42\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        ).into_bytes();
    let scope = bootstrap_options(&feed).unwrap();
    let normalized = normalize_canvas_ical(&feed, &scope).unwrap();

    let result = crate::ical_apply::bootstrap_normalization(
        &store,
        &scope,
        "2030-01-01T00:00:00Z",
        &normalized,
    )
    .unwrap();
    assert_eq!(result.added, 1);
    assert!(matches!(
        store.condition().unwrap(),
        StoreCondition::Ready(summary) if summary.state == StoreState::Authoritative
    ));

    assert!(store.store_dir().join(COURSEWORK_FILE).exists());
    assert!(store.store_dir().join("courses.json").exists());
    assert!(store.store_dir().join(MANIFEST_FILE).exists());
    assert!(store.store_dir().join(HISTORY_FILE).exists());

    let history_bytes = fs::read(store.store_dir().join(HISTORY_FILE)).unwrap();
    let history: Value = serde_json::from_slice(&history_bytes).unwrap();
    let events = history["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["status"], "succeeded");
    assert_eq!(events[0]["source"], "calendar");
    assert_eq!(events[0]["sourceComplete"], false);
    assert_eq!(events[0]["summary"]["added"], 1);
    assert_eq!(events[0]["summary"]["updated"], 0);

    let data_root_entries = fs::read_dir(store.data_root()).unwrap();
    for entry in data_root_entries {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        assert!(
            !name.starts_with(STAGING_PREFIX),
            "orphaned staging: {name}"
        );
    }
}

#[test]
fn held_only_creates_entry_in_authoritative_store() {
    let (_root, store) = test_store();
    let input = test_normalized(
        Vec::new(),
        vec![HeldIcalEvent {
            uid: "event-floating-9".into(),
            reason: "floating-time",
            canvas_course_id: Some("900001".into()),
            candidate_courses: vec!["course-a".into()],
            cancelled: false,
        }],
    );
    let outcome = crate::ical_apply::apply_normalization(
        &store,
        &test_options(),
        "2030-01-10T12:00:00Z",
        &input,
    )
    .unwrap();
    assert_eq!(outcome.added, 0);
    assert_eq!(outcome.updated, 0);
    assert_eq!(outcome.held, 0);
    assert_eq!(outcome.parser_held, 1);

    let history_bytes = fs::read(store.store_dir().join(HISTORY_FILE)).unwrap();
    let history: Value = serde_json::from_slice(&history_bytes).unwrap();
    let events = history["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event["status"], "incomplete");
    assert_eq!(event["sourceComplete"], false);
    assert_eq!(event["summary"]["added"], 0);
    assert_eq!(event["summary"]["updated"], 0);
    assert_eq!(event["summary"]["held"], 1);
    let notice = &event["changes"].as_array().unwrap()[0];
    assert_eq!(notice["kind"], "notice");
    assert_eq!(notice["detail"], "floating-time");
}
