use super::*;
use crate::store::{atomic_write, create_private_dir, node_json_bytes};
use crate::testutil::TempRoot;
use sha2::Digest;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

fn fixture(label: &str, bytes: &[u8], filename: &str) -> (TempRoot, Store, PathBuf) {
    let temp = TempRoot::new(label);
    let store = Store::open(temp.path(), Duration::from_millis(200)).unwrap();
    let root = store.store_dir();
    create_private_dir(&root, false).unwrap();
    atomic_write(&root.join("coursework.json"), &node_json_bytes(&serde_json::json!({"courses":[{"key":"synthetic-41","folder":"classes/synthetic-41","canvasCourseId":41}]}))).unwrap();
    let base = root.join("classes/synthetic-41/canvas-export");
    let materials = root.join("classes/synthetic-41/materials");
    for dir in [
        root.join("classes"),
        root.join("classes/synthetic-41"),
        base.clone(),
        materials.clone(),
    ] {
        create_private_dir(&dir, false).unwrap();
    }
    atomic_write(&base.join("download-manifest.json"), &node_json_bytes(&serde_json::json!([{"id":501,"status":"downloaded","filename":filename,"size":bytes.len(),"name":"Synthetic Guide"}]))).unwrap();
    atomic_write(&materials.join(filename), bytes).unwrap();
    (temp, store, materials)
}

#[test]
fn migrates_verified_legacy_bytes_idempotently_without_touching_source() {
    let bytes = b"%PDF-1.7\nsynthetic fixture";
    let (_temp, store, materials) = fixture("legacy-resource", bytes, "guide.pdf");
    let first = migrate_legacy_resources(&store, |_, _| true).unwrap();
    let doc: Value = serde_json::from_slice(&first.document).unwrap();
    let file = &doc["files"][0];
    assert_eq!(file["status"], "saved");
    assert_eq!(file["courseKey"], "synthetic-41");
    assert_eq!(file["fileId"], 501);
    assert_eq!(file["sourceAuthenticity"], "unverified");
    assert_eq!(
        file["sha256"],
        crate::store::hex(&sha2::Sha256::digest(bytes))
    );
    assert!(first
        .removable_material_paths
        .contains(&PathBuf::from("classes/synthetic-41/materials/guide.pdf")));
    assert_eq!(fs::read(materials.join("guide.pdf")).unwrap(), bytes);
    let second = migrate_legacy_resources(&store, |_, _| true).unwrap();
    assert_eq!(first.document, second.document);
    assert_eq!(second.reused_blobs, 1);
}

#[test]
fn unsupported_material_becomes_gap_and_is_not_removable() {
    let (_temp, store, _) = fixture("legacy-gap", b"<html>synthetic</html>", "guide.html");
    let result = migrate_legacy_resources(&store, |_, _| true).unwrap();
    let doc: Value = serde_json::from_slice(&result.document).unwrap();
    assert_eq!(doc["files"][0]["status"], "gap");
    assert_eq!(doc["files"][0]["gapReason"], GAP_UNSUPPORTED);
    assert!(result.removable_material_paths.is_empty());
}

#[test]
fn folderless_course_is_skipped_while_foldered_course_materials_are_migrated() {
    let bytes = b"%PDF-1.7\nsynthetic foldered course";
    let (_temp, store, materials) = fixture("legacy-folderless-course", bytes, "guide.pdf");
    let coursework_path = store.store_dir().join("coursework.json");
    let mut coursework: Value =
        serde_json::from_slice(&fs::read(&coursework_path).unwrap()).unwrap();
    coursework["courses"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "key":"folderless-course",
            "folder":null,
            "canvasCourseId":42
        }));
    atomic_write(&coursework_path, &node_json_bytes(&coursework)).unwrap();

    let migrated = migrate_legacy_resources(&store, |_, _| true).unwrap();
    let document: Value = serde_json::from_slice(&migrated.document).unwrap();
    assert_eq!(migrated.migrated_files, 1);
    assert_eq!(document["files"].as_array().unwrap().len(), 1);
    assert_eq!(document["files"][0]["courseKey"], "synthetic-41");
    assert_eq!(
        migrated.removable_material_paths,
        vec![PathBuf::from("classes/synthetic-41/materials/guide.pdf")]
    );
    assert_eq!(fs::read(materials.join("guide.pdf")).unwrap(), bytes);
}

#[test]
fn invalid_nonempty_folder_string_still_rejects_legacy_migration() {
    let (_temp, store, _) = fixture(
        "legacy-invalid-folder-string",
        b"%PDF-1.7\nsynthetic fixture",
        "guide.pdf",
    );
    let coursework_path = store.store_dir().join("coursework.json");
    let mut coursework: Value =
        serde_json::from_slice(&fs::read(&coursework_path).unwrap()).unwrap();
    coursework["courses"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "key":"invalid-course",
            "folder":"../escape",
            "canvasCourseId":43
        }));
    atomic_write(&coursework_path, &node_json_bytes(&coursework)).unwrap();

    assert_eq!(
        migrate_legacy_resources(&store, |_, _| true).unwrap_err(),
        LegacyResourceError::InvalidCoursework
    );
}

#[test]
fn cancellation_publishes_nothing_and_preserves_source() {
    let bytes = b"%PDF-1.7\nsynthetic fixture";
    let (_temp, store, materials) = fixture("legacy-cancel", bytes, "guide.pdf");
    let result = migrate_legacy_resources(&store, |_, _| false);
    assert_eq!(result.unwrap_err(), LegacyResourceError::Cancelled);
    assert!(!store
        .store_dir()
        .join(LEGACY_RESOURCE_ARCHIVE_DOCUMENT)
        .exists());
    assert_eq!(fs::read(materials.join("guide.pdf")).unwrap(), bytes);
}
