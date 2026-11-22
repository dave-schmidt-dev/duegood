//! Synthetic store and generation publication shared by disk-backed import tests.
use super::*;
use crate::config::canvas_capture_archive_root;
use crate::store::{
    atomic_write, create_private_dir, new_preview_manifest, node_json_bytes, sha256_hex,
};
use crate::testutil::TempRoot;
use serde_json::json;
use std::time::Duration;

pub(super) const COURSE_ID: u64 = 900_001;

pub(super) fn open_store(root: &TempRoot, state: &str, folderless: bool) -> Store {
    let store = Store::open(root.path(), Duration::from_millis(300)).unwrap();
    create_private_dir(&store.store_dir(), false).unwrap();
    let mut manifest = new_preview_manifest(1, 1, "synthetic", SystemTime::now());
    manifest["state"] = Value::String(state.into());
    atomic_write(
        &store.store_dir().join(MANIFEST_FILE),
        &node_json_bytes(&manifest),
    )
    .unwrap();

    let mut coursework: Value = serde_json::from_slice(include_bytes!(
        "../../fixtures/local-coursework-contract.json"
    ))
    .unwrap();
    coursework["courses"][0]["canvasCourseId"] = json!(COURSE_ID);
    if folderless {
        coursework["courses"][0]["folder"] = Value::Null;
    }
    coursework["items"][0]["done"] = Value::Bool(false);
    coursework["items"][0]["doneAt"] = Value::Null;
    coursework["items"][0]["studentNote"] = json!("Synthetic note kept from the latest store");
    atomic_write(
        &store.store_dir().join(COURSEWORK_FILE),
        &node_json_bytes(&coursework),
    )
    .unwrap();
    atomic_write(
        &store.store_dir().join("courses.json"),
        &node_json_bytes(&json!({"courses":[{"key":"course-a","canvasId":COURSE_ID}]})),
    )
    .unwrap();

    if !folderless {
        let directory = store
            .store_dir()
            .join("classes/synthetic-course-a/canvas-export/api");
        create_private_dir(&store.store_dir().join("classes"), false).unwrap();
        create_private_dir(&store.store_dir().join("classes/synthetic-course-a"), false).unwrap();
        create_private_dir(
            &store
                .store_dir()
                .join("classes/synthetic-course-a/canvas-export"),
            false,
        )
        .unwrap();
        create_private_dir(&directory, false).unwrap();
        atomic_write(
            &directory.join("course.json"),
            &node_json_bytes(&json!({"id":COURSE_ID,"name":"Synthetic"})),
        )
        .unwrap();
    }
    store
}

pub(super) fn publish_with(
    root: &TempRoot,
    user_id: u64,
    build: fn(u64, &str, u64) -> Value,
) -> u64 {
    let archive = canvas_capture_archive_root(root.path()).unwrap();
    create_private_dir(&archive, true).unwrap();
    create_private_dir(&archive.join("generations"), true).unwrap();
    create_private_dir(&archive.join("blobs"), true).unwrap();
    let guard = CaptureRunGuard::acquire(root.path()).unwrap();
    let attempt = guard.begin().unwrap();
    let generation_id = format!("{:032x}", attempt.run_id + 100);
    let snapshot = build(attempt.run_id, &generation_id, user_id);
    let snapshot_bytes = node_json_bytes(&snapshot);
    let snapshot_hash = sha256_hex(&snapshot_bytes);
    let generation = archive.join("generations").join(&generation_id);
    create_private_dir(&generation, false).unwrap();
    atomic_write(&generation.join("snapshot.json"), &snapshot_bytes).unwrap();
    let resource_count = snapshot["resources"].as_array().unwrap().len() as u64;
    let item_count = snapshot["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|resource| resource["items"].as_array().unwrap().len() as u64)
        .sum::<u64>();
    let manifest = json!({
        "format":"duegood-canvas-capture-generation","version":2,"runId":attempt.run_id,
        "generationId":generation_id,"capturedAt":"2030-01-08T12:00:00Z","complete":snapshot["complete"],
        "identity":{"origin":"https://marymount.instructure.com","userId":user_id},
        "snapshotBytes":snapshot_bytes.len(),"snapshotSha256":snapshot_hash,
        "resourceCount":resource_count,"itemCount":item_count,"blobCount":0,"blobBytes":0,"blobs":[]
    });
    atomic_write(
        &generation.join("manifest.json"),
        &node_json_bytes(&manifest),
    )
    .unwrap();
    let pointer = json!({"format":"duegood-canvas-capture-current","version":2,"runId":attempt.run_id,"generationId":generation_id,"snapshotSha256":snapshot_hash});
    atomic_write(&archive.join("current.json"), &node_json_bytes(&pointer)).unwrap();
    guard
        .complete(attempt.run_id, &generation_id, &snapshot_hash, user_id)
        .unwrap();
    attempt.run_id
}
