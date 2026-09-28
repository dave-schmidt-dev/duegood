use std::fs;
use std::io::Write;
use std::time::Duration;

use serde_json::{json, Value};

use crate::browser_export::{export_referenced_blobs, export_referenced_blobs_from_root};
use crate::config::{ImportLimits, TEST_BUNDLE_IDENTIFIER};
use crate::export::{export_native_store, ExportProgress};
use crate::import::{import_legacy_root, ImportOptions};
use crate::store::{atomic_write, create_private_dir, create_private_file, node_json_bytes, Store};
use crate::testutil::{materialize_fixture, TempRoot};

const PDF: &[u8] = b"%PDF-1.7\nsynthetic body\n";

fn fixture(root: &TempRoot) -> (Store, std::path::PathBuf) {
    let store = Store::open(
        &root.path().join(TEST_BUNDLE_IDENTIFIER),
        Duration::from_millis(200),
    )
    .expect("test store");
    create_private_dir(&store.store_dir(), false).expect("store folder");
    let course = store
        .store_dir()
        .join("classes/synthetic-course/canvas-export");
    create_private_dir(&store.store_dir().join("classes"), false).expect("classes folder");
    create_private_dir(&store.store_dir().join("classes/synthetic-course"), false)
        .expect("course folder");
    create_private_dir(&course, false).expect("canvas export folder");
    atomic_write(
        &store.store_dir().join("coursework.json"),
        &node_json_bytes(&json!({
            "courses": [{"key":"synthetic", "folder":"classes/synthetic-course"}],
            "items": []
        })),
    )
    .expect("coursework");
    let archive = store.data_root().join("canvas-resource-archive");
    create_private_dir(&archive, false).expect("archive");
    create_private_dir(&archive.join("blobs"), false).expect("blobs");
    let output = root.path().join("owner-export");
    create_private_dir(&output, false).expect("output root");
    (store, output)
}

fn write_blob(store: &Store, body: &[u8]) -> String {
    let hash = crate::store::sha256_hex(body);
    let path = store
        .data_root()
        .join("canvas-resource-archive/blobs")
        .join(&hash);
    let mut file = create_private_file(&path).expect("private source blob");
    file.write_all(body).expect("source body");
    file.sync_all().expect("source sync");
    hash
}

fn write_manifest(store: &Store, entries: Vec<Value>) {
    let path = store
        .store_dir()
        .join("classes/synthetic-course/canvas-export/download-manifest.json");
    atomic_write(&path, &node_json_bytes(&Value::Array(entries))).expect("manifest");
}

fn imported_fixture_store(root: &TempRoot) -> Store {
    let store = Store::open(
        &root.path().join(TEST_BUNDLE_IDENTIFIER),
        Duration::from_millis(200),
    )
    .expect("test store");
    let source = materialize_fixture(&root.path().join("legacy-source"));
    import_legacy_root(
        &store,
        &source,
        &ImportOptions {
            limits: ImportLimits::PRODUCTION,
            legacy_lock_timeout: Duration::from_millis(200),
            replace_preview: false,
        },
        &mut |_| {},
    )
    .expect("import synthetic legacy fixture");
    let archive = store.data_root().join("canvas-resource-archive");
    create_private_dir(&archive, false).expect("archive");
    create_private_dir(&archive.join("blobs"), false).expect("blobs");
    store
}

fn saved(file_id: u64, hash: &str, byte_count: usize) -> Value {
    json!({
        "fileId": file_id,
        "status": "saved",
        "sha256": hash,
        "byteCount": byte_count,
        "contentType": "application/pdf",
        "sourceAuthenticity": "unverified"
    })
}

#[test]
fn copies_only_saved_referenced_blobs_to_the_export_archive() {
    let root = TempRoot::new("browser-export-referenced");
    let (store, output) = fixture(&root);
    let referenced_hash = write_blob(&store, PDF);
    let unreferenced_hash = write_blob(&store, b"%PDF-1.7\nunreferenced\n");
    write_manifest(
        &store,
        vec![
            saved(5001, &referenced_hash, PDF.len()),
            json!({"fileId":5002,"status":"gap","reason":"not saved"}),
        ],
    );
    let _lock = store.read_lock().expect("read lock");
    let mut events = Vec::new();
    let totals =
        export_referenced_blobs(&store, &output, ExportProgress::default(), &mut |event| {
            events.push(event);
        })
        .expect("export");
    let blobs = output.join("canvas-resource-archive/blobs");
    assert_eq!(fs::read(blobs.join(&referenced_hash)).unwrap(), PDF);
    assert!(!blobs.join(unreferenced_hash).exists());
    assert_eq!(fs::read_dir(blobs).unwrap().count(), 1);
    assert_eq!(totals.files_done, 1);
    assert_eq!(totals.bytes_done, PDF.len() as u64);
    assert_eq!(events.last(), Some(&totals));
}

#[test]
fn explicit_frozen_document_root_controls_the_references() {
    let root = TempRoot::new("browser-export-frozen-root");
    let (store, output) = fixture(&root);
    let current_body = b"%PDF-1.7\ncurrent manifest body\n";
    let frozen_body = b"%PDF-1.7\nfrozen manifest body\n";
    let current_hash = write_blob(&store, current_body);
    let frozen_hash = write_blob(&store, frozen_body);
    write_manifest(&store, vec![saved(5001, &current_hash, current_body.len())]);

    let frozen = root.path().join("frozen-documents");
    create_private_dir(&frozen, false).expect("frozen root");
    create_private_dir(&frozen.join("classes"), false).expect("frozen classes");
    let course_directory = frozen.join("classes/synthetic-course");
    create_private_dir(&course_directory, false).expect("frozen course");
    let course = course_directory.join("canvas-export");
    create_private_dir(&course, false).expect("frozen Canvas export");
    atomic_write(
        &frozen.join("coursework.json"),
        &node_json_bytes(&json!({
            "courses": [{"key":"frozen", "folder":"classes/synthetic-course"}],
            "items": []
        })),
    )
    .expect("frozen coursework");
    atomic_write(
        &course.join("download-manifest.json"),
        &node_json_bytes(&json!([saved(9001, &frozen_hash, frozen_body.len())])),
    )
    .expect("frozen manifest");

    let _lock = store.read_lock().expect("read lock");
    export_referenced_blobs_from_root(
        &store,
        &frozen,
        &output,
        ExportProgress::default(),
        &mut |_| {},
    )
    .expect("frozen export");
    let blobs = output.join("canvas-resource-archive/blobs");
    assert!(blobs.join(&frozen_hash).is_file());
    assert!(!blobs.join(&current_hash).exists());
}

#[test]
fn folderless_ical_course_is_skipped_and_saved_legacy_receipts_are_exported() {
    let root = TempRoot::new("browser-export-ical-and-legacy");
    let (store, output) = fixture(&root);
    let canvas_body = b"%PDF-1.7\nCanvas resource\n";
    let legacy_body = b"%PDF-1.7\nLegacy saved resource\n";
    let gap_body = b"%PDF-1.7\nUnreferenced gap resource\n";
    let canvas_hash = write_blob(&store, canvas_body);
    let legacy_hash = write_blob(&store, legacy_body);
    let gap_hash = write_blob(&store, gap_body);
    write_manifest(&store, vec![saved(5001, &canvas_hash, canvas_body.len())]);
    atomic_write(
        &store.store_dir().join("coursework.json"),
        &node_json_bytes(&json!({
            "courses": [
                {"key":"synthetic", "folder":"classes/synthetic-course"},
                {"key":"private-ical", "source":"ical", "folder":null}
            ],
            "items": []
        })),
    )
    .expect("coursework with folderless iCal course");
    atomic_write(
        &store
            .store_dir()
            .join("browser-legacy-resource-archive.json"),
        &node_json_bytes(&json!({
            "format":"duegood-browser-legacy-resources",
            "version":1,
            "files":[
                {
                    "courseKey":"synthetic",
                    "fileId":7001,
                    "status":"saved",
                    "sha256":legacy_hash,
                    "byteCount":legacy_body.len(),
                    "contentType":"application/pdf",
                    "source":"legacy",
                    "sourceAuthenticity":"unverified",
                    "observedAt":null
                },
                {
                    "courseKey":"synthetic",
                    "fileId":7002,
                    "status":"gap",
                    "source":"legacy",
                    "sourceAuthenticity":"unverified",
                    "observedAt":null
                }
            ]
        })),
    )
    .expect("legacy archive inventory");

    let _lock = store.read_lock().expect("read lock");
    export_referenced_blobs(&store, &output, ExportProgress::default(), &mut |_| {})
        .expect("export current and legacy references");
    let blobs = output.join("canvas-resource-archive/blobs");
    assert_eq!(fs::read(blobs.join(&canvas_hash)).unwrap(), canvas_body);
    assert_eq!(fs::read(blobs.join(&legacy_hash)).unwrap(), legacy_body);
    assert!(!blobs.join(gap_hash).exists());
    assert_eq!(fs::read_dir(blobs).unwrap().count(), 2);
}

#[test]
fn legacy_folder_leaf_resolves_referenced_blobs_under_classes() {
    let root = TempRoot::new("browser-export-legacy-folder-leaf");
    let store = imported_fixture_store(&root);
    let output = root.path().join("owner-export");
    create_private_dir(&output, false).expect("output root");
    let body = b"%PDF-1.7\nlegacy folder leaf resource\n";
    let hash = write_blob(&store, body);
    let manifest = store
        .store_dir()
        .join("classes/syn-101/canvas-export/download-manifest.json");
    atomic_write(
        &manifest,
        &node_json_bytes(&json!([saved(7101, &hash, body.len())])),
    )
    .expect("legacy course manifest");

    let _lock = store.read_lock().expect("read lock");
    export_referenced_blobs(&store, &output, ExportProgress::default(), &mut |_| {})
        .expect("legacy leaf folder export");
    assert_eq!(
        fs::read(output.join("canvas-resource-archive/blobs").join(hash)).unwrap(),
        body
    );
}

#[test]
fn native_backup_preserves_enriched_coursework_and_referenced_blobs() {
    let root = TempRoot::new("browser-export-native-backup");
    let store = imported_fixture_store(&root);
    let body = b"%PDF-1.7\nnative backup referenced file\n";
    let hash = write_blob(&store, body);
    atomic_write(
        &store
            .store_dir()
            .join("classes/syn-101/canvas-export/download-manifest.json"),
        &node_json_bytes(&json!([saved(6001, &hash, body.len())])),
    )
    .expect("native backup manifest");
    let coursework = json!({
        "courses": [{"key":"syn-101", "folder":"syn-101"}],
        "items": [{
            "id": 8001,
            "name": "Synthetic assignment",
            "done": true,
            "notes": "private synthetic note",
            "sourceReferences": [{"source":"ical", "id":"assignment:8001"}],
            "fieldObservations": {"dueAt": {"selected": {
                "owner": {"source":"ical", "id":"assignment:8001"},
                "value": "2026-09-27T20:00:00Z"
            }}}
        }],
        "pendingSourceLinks": [{"id":"pending:1", "status":"unresolved"}]
    });
    atomic_write(
        &store.store_dir().join("coursework.json"),
        &node_json_bytes(&coursework),
    )
    .expect("enriched coursework");
    let parent = root.path().join("native-backups");
    create_private_dir(&parent, false).expect("backup parent");

    let totals = export_native_store(&store, &parent, &mut |_| {}).expect("native backup");
    let name = fs::read_dir(&parent)
        .expect("backup list")
        .next()
        .expect("backup folder")
        .expect("backup entry")
        .file_name()
        .into_string()
        .expect("UTF-8 backup folder");
    assert!(name.starts_with("duegood-native-backup-"));
    let backup = parent.join(name);
    let archived_coursework: Value =
        serde_json::from_slice(&fs::read(backup.join("coursework.json")).unwrap()).unwrap();
    assert_eq!(archived_coursework, coursework);
    assert_eq!(
        fs::read(backup.join("canvas-resource-archive/blobs").join(&hash)).unwrap(),
        body
    );
    assert!(totals.files_done > 0);
    assert!(totals.bytes_done >= body.len() as u64);
}

#[test]
fn conflicting_size_and_missing_blob_are_rejected() {
    let root = TempRoot::new("browser-export-size-mismatch");
    let (store, output) = fixture(&root);
    let hash = write_blob(&store, PDF);
    write_manifest(&store, vec![saved(5001, &hash, PDF.len() + 1)]);
    let _lock = store.read_lock().expect("read lock");
    assert!(
        export_referenced_blobs(&store, &output, ExportProgress::default(), &mut |_| {}).is_err()
    );

    let missing_root = TempRoot::new("browser-export-missing");
    let (missing_store, missing_output) = fixture(&missing_root);
    write_manifest(
        &missing_store,
        vec![saved(5002, &"a".repeat(64), PDF.len())],
    );
    let _missing_lock = missing_store.read_lock().expect("read lock");
    assert!(export_referenced_blobs(
        &missing_store,
        &missing_output,
        ExportProgress::default(),
        &mut |_| {}
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn source_blob_symlink_is_rejected() {
    use std::os::unix::fs::symlink;

    let root = TempRoot::new("browser-export-symlink");
    let (store, output) = fixture(&root);
    let hash = crate::store::sha256_hex(PDF);
    let target = root.path().join("outside-target");
    let mut file = create_private_file(&target).expect("target");
    file.write_all(PDF).unwrap();
    let path = store
        .data_root()
        .join("canvas-resource-archive/blobs")
        .join(&hash);
    symlink(&target, path).expect("source symlink");
    write_manifest(&store, vec![saved(5001, &hash, PDF.len())]);
    let _lock = store.read_lock().expect("read lock");
    assert!(
        export_referenced_blobs(&store, &output, ExportProgress::default(), &mut |_| {}).is_err()
    );
}

#[test]
fn course_path_reference_traversal_is_rejected() {
    let root = TempRoot::new("browser-export-path-reference");
    let (store, output) = fixture(&root);
    let coursework = json!({
        "courses": [{"key":"synthetic", "folder":"classes/../outside"}],
        "items": []
    });
    atomic_write(
        &store.store_dir().join("coursework.json"),
        &node_json_bytes(&coursework),
    )
    .unwrap();
    let _lock = store.read_lock().expect("read lock");
    assert!(
        export_referenced_blobs(&store, &output, ExportProgress::default(), &mut |_| {}).is_err()
    );
    assert!(!output.join("canvas-resource-archive").exists());
}

#[test]
fn repeated_hash_references_copy_once_and_accumulate_prior_progress() {
    let root = TempRoot::new("browser-export-deduplicate");
    let (store, output) = fixture(&root);
    let hash = write_blob(&store, PDF);
    write_manifest(
        &store,
        vec![saved(5001, &hash, PDF.len()), saved(5002, &hash, PDF.len())],
    );
    let _lock = store.read_lock().expect("read lock");
    let prior = ExportProgress {
        files_done: 7,
        bytes_done: 101,
    };
    let totals = export_referenced_blobs(&store, &output, prior, &mut |_| {}).expect("export");
    assert_eq!(
        fs::read_dir(output.join("canvas-resource-archive/blobs"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(totals.files_done, 8);
    assert_eq!(totals.bytes_done, 101 + PDF.len() as u64);
}

#[test]
fn repeated_hash_with_conflicting_sizes_is_rejected_before_copy() {
    let root = TempRoot::new("browser-export-conflicting-size");
    let (store, output) = fixture(&root);
    let hash = write_blob(&store, PDF);
    write_manifest(
        &store,
        vec![
            saved(5001, &hash, PDF.len()),
            saved(5002, &hash, PDF.len() + 1),
        ],
    );
    let _lock = store.read_lock().expect("read lock");
    assert!(
        export_referenced_blobs(&store, &output, ExportProgress::default(), &mut |_| {}).is_err()
    );
    assert!(!output.join("canvas-resource-archive").exists());
}
