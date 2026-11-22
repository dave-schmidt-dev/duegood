use super::*;
use crate::config::{ImportLimits, TEST_BUNDLE_IDENTIFIER};
use crate::import::{import_legacy_root, ImportOptions};
use crate::testutil::{materialize_fixture, snapshot_tree, TempRoot};
use serde_json::json;

fn authoritative_store(root: &TempRoot) -> Store {
    let data_root = root.path().join(TEST_BUNDLE_IDENTIFIER);
    let store = Store::open(&data_root, Duration::from_millis(500)).expect("store");
    let legacy = materialize_fixture(&root.path().join("legacy"));
    atomic_write(
        &legacy.join("classes/syn-202/canvas-export/api/course.json"),
        br#"{"id":1002,"name":"Applied Synthesis"}
"#,
    )
    .expect("complete synthetic course metadata");
    let options = ImportOptions {
        limits: ImportLimits::PRODUCTION,
        legacy_lock_timeout: Duration::from_millis(200),
        replace_preview: false,
    };
    import_legacy_root(&store, &legacy, &options, &mut |_| {}).expect("import");
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(store.store_dir().join(MANIFEST_FILE)).expect("manifest"))
            .expect("manifest JSON");
    manifest["state"] = Value::String(StoreState::Authoritative.as_str().to_owned());
    atomic_write(
        &store.store_dir().join(MANIFEST_FILE),
        &node_json_bytes(&manifest),
    )
    .expect("authoritative manifest");
    store
}

fn capture_from(current: &Value) -> RefreshCapture {
    let mut coursework = current.clone();
    coursework["items"][0]["title"] = Value::String("Canvas title update".to_owned());
    RefreshCapture {
        coursework,
        documents: BTreeMap::from([(
            "canvas-conversations.json".to_owned(),
            b"{\"complete\":true}\n".to_vec(),
        )]),
        captured_at: SystemTime::now(),
        source_complete: true,
    }
}

fn current_coursework(store: &Store) -> Value {
    serde_json::from_slice(&fs::read(store.store_dir().join(COURSEWORK_FILE)).expect("coursework"))
        .expect("coursework JSON")
}

#[test]
fn personal_merge_does_not_restore_reconciled_syllabus_forecast() {
    let current = serde_json::json!({
        "items": [
            {"id":"forecast-1","course":"course-1","source":"syllabus","done":false},
            {"id":"manual-1","course":"course-1","source":"manual","done":true}
        ],
        "archivedForecastItems": []
    });
    let fresh = serde_json::json!({
        "items": [],
        "archivedForecastItems": [
            {"id":"forecast-1","course":"course-1","source":"syllabus","done":false}
        ]
    });

    let merged = merge_personal_state(&current, &fresh, false).expect("personal merge");

    assert!(merged["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| { item.get("id").and_then(Value::as_str) != Some("forecast-1") }));
    assert_eq!(merged["items"].as_array().unwrap().len(), 1);
    assert_eq!(merged["items"][0]["id"], "manual-1");
    assert_eq!(merged["archivedForecastItems"].as_array().unwrap().len(), 1);
    assert_eq!(merged["archivedForecastItems"][0]["id"], "forecast-1");
}

#[test]
fn incomplete_refresh_keeps_omitted_syllabus_forecast_active() {
    let current = serde_json::json!({
        "items": [
            {"id":"forecast-1","course":"course-1","source":"syllabus","done":true}
        ],
        "archivedForecastItems": []
    });
    let fresh = serde_json::json!({
        "items": [],
        "archivedForecastItems": [
            {"id":"forecast-1","course":"course-1","source":"syllabus","done":false}
        ]
    });

    let merged = merge_personal_state(&current, &fresh, true).expect("partial personal merge");

    assert_eq!(merged["items"].as_array().unwrap().len(), 1);
    assert_eq!(merged["items"][0]["id"], "forecast-1");
    assert_eq!(merged["items"][0]["done"], true);
    assert!(merged["archivedForecastItems"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn complete_refresh_preserves_personal_state_and_manifest() {
    let root = TempRoot::new("refresh-commit");
    let store = authoritative_store(&root);
    let mut current = current_coursework(&store);
    current["items"][0]["done"] = Value::Bool(true);
    current["items"][0]["doneAt"] = Value::String("student-time".into());
    current["items"][0]["manualGradeObservation"] =
        json!({"version": 1, "value": "A-", "source": "pdf"});
    atomic_write(
        &store.store_dir().join(COURSEWORK_FILE),
        &node_json_bytes(&current),
    )
    .unwrap();
    let manifest = fs::read(store.store_dir().join(MANIFEST_FILE)).unwrap();
    let baseline = current.clone();
    let mut capture = capture_from(&baseline);
    capture.coursework["items"][0]
        .as_object_mut()
        .unwrap()
        .remove("manualGradeObservation");
    let result = refresh(&store, move |_, _| Ok(capture), &mut |_| {}).expect("complete refresh");
    assert_eq!(result.status, "complete");
    let published = current_coursework(&store);
    assert_eq!(published["items"][0]["title"], "Canvas title update");
    assert_eq!(published["items"][0]["done"], true);
    assert_eq!(published["items"][0]["doneAt"], "student-time");
    assert_eq!(
        published["items"][0]["manualGradeObservation"],
        json!({"version": 1, "value": "A-", "source": "pdf"})
    );
    assert_eq!(
        fs::read(store.store_dir().join(MANIFEST_FILE)).unwrap(),
        manifest
    );
    assert!(store.store_dir().join(CONVERSATIONS_FILE).is_file());
    let history: Value =
        serde_json::from_slice(&fs::read(store.store_dir().join(HISTORY_FILE)).unwrap()).unwrap();
    let event = history["events"].as_array().unwrap().last().unwrap();
    assert_eq!(event["status"], "succeeded");
    assert_eq!(event["personalStateReapplied"], false);
}

#[test]
fn partial_refresh_preserves_omitted_canvas_items_and_prior_materials() {
    let root = TempRoot::new("refresh-partial-capture");
    let store = authoritative_store(&root);
    let baseline = current_coursework(&store);
    let retained_material = store
        .store_dir()
        .join("classes/syn-101/materials/refresh-retained-synthetic.bin");
    atomic_write(&retained_material, b"synthetic prior material").unwrap();

    let mut capture = capture_from(&baseline);
    capture.source_complete = false;
    capture.documents.insert(
        CONVERSATIONS_FILE.to_owned(),
        b"{\"complete\":false}\n".to_vec(),
    );
    let items = capture.coursework["items"].as_array_mut().unwrap();
    let omitted_index = items
        .iter()
        .position(|item| item.get("source").and_then(Value::as_str) == Some("canvas"))
        .expect("synthetic Canvas coursework item");
    let omitted = items.remove(omitted_index);
    let omitted_key = personal_key(&omitted).expect("stable item key");
    capture
        .coursework
        .as_object_mut()
        .unwrap()
        .entry("archivedForecastItems".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .expect("archive list")
        .push(omitted);

    let result = refresh(&store, move |_, _| Ok(capture), &mut |_| {})
        .expect("partial capture publishes as incomplete");

    assert_eq!(result.status, "incomplete");
    let published = current_coursework(&store);
    let active_matches = published["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| personal_key(item).as_deref() == Some(omitted_key.as_str()))
        .count();
    let archived_matches = published["archivedForecastItems"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| personal_key(item).as_deref() == Some(omitted_key.as_str()))
        .count();
    assert_eq!(active_matches, 1, "omitted Canvas item remains active");
    assert_eq!(archived_matches, 0, "partial capture does not archive it");
    assert_eq!(
        fs::read(retained_material).unwrap(),
        b"synthetic prior material"
    );
    let history: Value =
        serde_json::from_slice(&fs::read(store.store_dir().join(HISTORY_FILE)).unwrap()).unwrap();
    let event = history["events"].as_array().unwrap().last().unwrap();
    assert_eq!(event["status"], "incomplete");
    assert_eq!(event["sourceComplete"], false);
    assert_eq!(event["summary"]["removed"], 0);
    assert!(event["changes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|change| change["kind"] != "removed"));
}

#[test]
fn failed_capture_leaves_authoritative_store_bytes_intact() {
    let root = TempRoot::new("refresh-failure");
    let store = authoritative_store(&root);
    let before = snapshot_tree(&store.store_dir());
    let error = refresh(&store, |_, _| Err(RefreshError::FetchFailed), &mut |_| {})
        .expect_err("failed capture");
    assert_eq!(error.to_string(), "refresh could not be completed");
    assert_eq!(snapshot_tree(&store.store_dir()), before);
}

#[test]
fn personal_mutation_completes_during_staging_and_is_reapplied() {
    let root = TempRoot::new("refresh-personal-during-stage");
    let store = authoritative_store(&root);
    let before = current_coursework(&store);
    let item_id = before["items"][0]["id"].as_str().expect("string item ID");
    assert_eq!(before["items"][0]["done"], false);
    let capture = capture_from(&before);
    let mut mutation_succeeded = false;
    let mut report = |progress: RefreshProgress| {
        if !mutation_succeeded && progress.phase == RefreshPhase::Stage && progress.completed > 0 {
            store
                .mutate_item(item_id, "done", false, true)
                .expect("personal mutation is not blocked by staging");
            mutation_succeeded = true;
        }
    };

    refresh(&store, move |_, _| Ok(capture), &mut report).expect("complete refresh");

    assert!(mutation_succeeded);
    let published = current_coursework(&store);
    assert_eq!(published["items"][0]["title"], "Canvas title update");
    assert_eq!(published["items"][0]["done"], true);
    assert!(published["items"][0]["doneAt"].is_string());
    let history: Value =
        serde_json::from_slice(&fs::read(store.store_dir().join(HISTORY_FILE)).unwrap()).unwrap();
    let event = history["events"].as_array().unwrap().last().unwrap();
    assert_eq!(event["personalStateReapplied"], true);
    assert_eq!(event["notice"], "personal_state_reapplied");
    assert_eq!(
        event["changes"][0],
        serde_json::json!({
            "kind": "notice",
            "title": "Personal progress kept",
            "detail": "Changes made during this refresh were preserved."
        })
    );
}

#[test]
fn declared_local_edit_rebases_under_the_publish_lock() {
    let root = TempRoot::new("refresh-declared-local-rebase");
    let store = authoritative_store(&root);
    let mut baseline = current_coursework(&store);
    baseline["items"][0]["localOwnedFields"] = json!(["studentNote"]);
    baseline["items"][0]["studentNote"] = json!("before");
    atomic_write(
        &store.store_dir().join(COURSEWORK_FILE),
        &node_json_bytes(&baseline),
    )
    .unwrap();
    let capture = capture_from(&baseline);
    let mut changed = false;
    let mut report = |progress: RefreshProgress| {
        if !changed && progress.phase == RefreshPhase::Stage && progress.completed > 0 {
            let _write_lock = store.write_lock().expect("write lock");
            let mut current = current_coursework(&store);
            current["items"][0]["studentNote"] = json!("during-refresh");
            atomic_write(
                &store.store_dir().join(COURSEWORK_FILE),
                &node_json_bytes(&current),
            )
            .unwrap();
            changed = true;
        }
    };
    refresh(&store, move |_, _| Ok(capture), &mut report).expect("declared field rebase");
    let published = current_coursework(&store);
    assert!(changed);
    assert_eq!(published["items"][0]["title"], "Canvas title update");
    assert_eq!(published["items"][0]["studentNote"], "during-refresh");
}

#[test]
fn unknown_item_edit_during_staging_fails_closed() {
    let root = TempRoot::new("refresh-unknown-item-conflict");
    let store = authoritative_store(&root);
    let before = current_coursework(&store);
    let capture = capture_from(&before);
    let mut changed = false;
    let mut report = |progress: RefreshProgress| {
        if !changed && progress.phase == RefreshPhase::Stage && progress.completed > 0 {
            let _write_lock = store.write_lock().expect("write lock");
            let mut current = current_coursework(&store);
            current["items"][0]["unrecognizedExtension"] = json!({"changed": true});
            atomic_write(
                &store.store_dir().join(COURSEWORK_FILE),
                &node_json_bytes(&current),
            )
            .unwrap();
            changed = true;
        }
    };
    let error = refresh(&store, move |_, _| Ok(capture), &mut report)
        .expect_err("unknown concurrent edit must fail closed");
    assert!(changed);
    assert_eq!(error.to_string(), "refresh could not be completed");
    assert_eq!(
        current_coursework(&store)["items"][0]["unrecognizedExtension"]["changed"],
        true
    );
}

#[test]
fn non_coursework_change_during_staging_aborts_and_cleans_staging() {
    let root = TempRoot::new("refresh-generation-conflict");
    let store = authoritative_store(&root);
    let before = snapshot_tree(&store.store_dir());
    let capture = capture_from(&current_coursework(&store));
    let mut changed = false;
    let mut report = |progress: RefreshProgress| {
        if !changed && progress.phase == RefreshPhase::Stage && progress.completed > 0 {
            let _write_lock = store.write_lock().expect("write lock");
            atomic_write(&store.store_dir().join("new-owner-file.txt"), b"synthetic")
                .expect("external document update");
            changed = true;
        }
    };

    let error = refresh(&store, move |_, _| Ok(capture), &mut report)
        .expect_err("changed store generation must fail closed");

    assert!(changed);
    assert_eq!(error.to_string(), "refresh could not be completed");
    let mut after = snapshot_tree(&store.store_dir());
    assert_eq!(
        after.remove("new-owner-file.txt"),
        Some(crate::testutil::Entry::File(b"synthetic".to_vec()))
    );
    assert_eq!(after, before);
    assert!(!fs::read_dir(store.data_root())
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with(STAGING_PREFIX)));
}

#[test]
fn staging_failure_leaves_authoritative_store_bytes_intact() {
    let root = TempRoot::new("refresh-stage-failure");
    let store = authoritative_store(&root);
    let coursework = current_coursework(&store);
    let blocked_target = store.store_dir().join("canvas-profile.json");
    if blocked_target.exists() {
        fs::remove_file(&blocked_target).expect("remove existing profile file");
    }
    create_private_dir(&blocked_target, false).expect("block profile target");
    let before = snapshot_tree(&store.store_dir());
    let mut capture = capture_from(&coursework);
    capture.documents.insert(
        "canvas-profile.json".to_owned(),
        b"{\"profile\":true}\n".to_vec(),
    );

    let error = refresh(&store, move |_, _| Ok(capture), &mut |_| {})
        .expect_err("stage cannot replace a directory with a file");

    assert_eq!(error.to_string(), "refresh could not be completed");
    assert_eq!(snapshot_tree(&store.store_dir()), before);
}

#[test]
fn helper_attaches_without_instance_lock_or_recovery_side_effects() {
    let root = TempRoot::new("refresh-helper-open");
    let store = authoritative_store(&root);
    let staging = store
        .data_root()
        .join(format!("{STAGING_PREFIX}refresh-orphan"));
    create_private_dir(&staging, false).unwrap();
    let helper = Store::open_helper(store.data_root(), Duration::from_millis(100)).unwrap();
    assert!(staging.is_dir(), "helper attachment does not run cleanup");
    assert!(helper.read_lock().is_ok());
    assert!(store
        .data_root()
        .join(crate::config::INSTANCE_LOCK_FILE)
        .exists());
}

#[test]
fn capture_rejects_store_control_paths_before_mutating_anything() {
    let capture = RefreshCapture {
        coursework: serde_json::json!({"courses":[],"items":[]}),
        documents: BTreeMap::from([("../escape.txt".to_owned(), b"unsafe".to_vec())]),
        captured_at: SystemTime::now(),
        source_complete: true,
    };
    assert!(matches!(
        validate_capture(&capture),
        Err(RefreshError::InvalidCapture)
    ));
}
