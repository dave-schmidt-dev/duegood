use super::*;
use crate::store::node_json_bytes;
use serde_json::json;

use std::fs;
use std::time::Duration;

use crate::config::canvas_capture_archive_root;
use crate::store::{atomic_write, create_private_dir, new_preview_manifest, sha256_hex};
use crate::testutil::{snapshot_tree, TempRoot};

const USER_ID: u64 = 41;
const COURSE_ID: u64 = 900_001;
const GENERATION_ID: &str = "a123456789abcdef0123456789abcdef";

fn open_store(root: &TempRoot, state: &str, folderless: bool) -> Store {
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

fn snapshot(run_id: u64, generation_id: &str, user_id: u64) -> Value {
    let active_ids = [COURSE_ID, 900_002_u64];
    let mut resources = vec![
        json!({
            "endpoint":"coursesActive", "courseId":null, "pages":1,
            "items":[{"id":COURSE_ID,"name":"Synthetic Current"},{"id":900002,"name":"Synthetic Unselected"}]
        }),
        json!({
            "endpoint":"coursesCompleted", "courseId":null, "pages":1,
            "items":[{"id":900003,"name":"Synthetic Historical"}]
        }),
    ];
    let mut coverage = vec![
        json!({"endpoint":"coursesActive","courseId":null,"status":"complete"}),
        json!({"endpoint":"coursesCompleted","courseId":null,"status":"complete"}),
        json!({"endpoint":"quizzes","courseId":COURSE_ID,"status":"gap","reason":"not-attempted"}),
    ];
    for course_id in active_ids {
        let assignment = if course_id == COURSE_ID {
            vec![
                json!({"id":910001,"course_id":COURSE_ID,"name":"Synthetic Updated Assignment","due_at":"2030-02-01T23:59:00Z","points_possible":20,"assignment_group_id":null,"html_url":format!("https://marymount.instructure.com/courses/{COURSE_ID}/assignments/910001")}),
            ]
        } else {
            Vec::new()
        };
        for (endpoint, items) in [
            (
                "course",
                vec![
                    json!({"id":course_id,"name":format!("Synthetic Course {course_id}"),"course_code":format!("SYN-CANVAS-{course_id}")}),
                ],
            ),
            ("assignments", assignment),
            ("assignmentGroups", Vec::new()),
            ("submissions", Vec::new()),
        ] {
            resources
                .push(json!({"endpoint":endpoint,"courseId":course_id,"pages":1,"items":items}));
            coverage.push(json!({"endpoint":endpoint,"courseId":course_id,"status":"complete"}));
        }
    }
    json!({
        "schemaVersion":2,"source":"canvas-browser","capturedAt":"2030-01-08T12:00:00Z","complete":false,
        "runId":run_id,"generationId":generation_id,
        "identity":{"origin":"https://marymount.instructure.com","userId":user_id},
        "activeCourses":{"complete":true,"courseIds":active_ids},
        "coverageRequirements":{"activeCoursesComplete":true,"perActiveCourse":["course","assignments","assignmentGroups","submissions"]},
        "resources":resources,"coverage":coverage
    })
}

fn publish_attempt(root: &TempRoot, user_id: u64) -> u64 {
    let archive = canvas_capture_archive_root(root.path()).unwrap();
    create_private_dir(&archive, true).unwrap();
    create_private_dir(&archive.join("generations"), true).unwrap();
    create_private_dir(&archive.join("blobs"), true).unwrap();
    let guard = CaptureRunGuard::acquire(root.path()).unwrap();
    let attempt = guard.begin().unwrap();
    let generation_id = format!("{:032x}", attempt.run_id + 100);
    let snapshot = snapshot(attempt.run_id, &generation_id, user_id);
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
        "generationId":generation_id,"capturedAt":"2030-01-08T12:00:00Z","complete":false,
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

fn run_import(
    store: &Store,
    root: &TempRoot,
    confirmation: Option<u64>,
) -> Result<BrowserImportResult, BrowserImportError> {
    let archive = canvas_capture_archive_root(root.path()).unwrap();
    import_current_capture(store, &archive, confirmation, &mut |_| {})
}

fn run_import_confirmed(
    store: &Store,
    root: &TempRoot,
    confirm_first_account: bool,
) -> Result<BrowserImportResult, BrowserImportError> {
    let archive = canvas_capture_archive_root(root.path()).unwrap();
    import_current_capture_confirmed(store, &archive, confirm_first_account, &mut |_| {})
}

fn read_coursework(store: &Store) -> Value {
    serde_json::from_slice(&fs::read(store.store_dir().join(COURSEWORK_FILE)).unwrap()).unwrap()
}

fn write_coursework(store: &Store, coursework: &Value) {
    atomic_write(
        &store.store_dir().join(COURSEWORK_FILE),
        &node_json_bytes(coursework),
    )
    .unwrap();
}

#[test]
fn authoritative_import_preserves_latest_personal_state_and_assigns_stable_folder() {
    let root = TempRoot::new("browser-import-success");
    let store = open_store(&root, "authoritative", true);
    publish_attempt(&root, USER_ID);
    let result = run_import(&store, &root, Some(USER_ID)).unwrap();
    assert_eq!(result.imported_courses, 1);
    assert_eq!(result.archived_courses, 2);
    assert!(!result.already_current);

    let coursework: Value =
        serde_json::from_slice(&fs::read(store.store_dir().join(COURSEWORK_FILE)).unwrap())
            .unwrap();
    assert_eq!(coursework["courses"][0]["folder"], "classes/canvas-900001");
    assert_eq!(coursework["items"][0]["done"], false);
    assert_eq!(
        coursework["items"][0]["studentNote"],
        "Synthetic note kept from the latest store"
    );
    assert_eq!(
        coursework["items"][0]["syntheticItemExtension"]["preserve"],
        "graded-item"
    );
    assert_eq!(
        coursework["items"][0]["title"],
        "Synthetic Updated Assignment"
    );
    let status: Value =
        serde_json::from_slice(&fs::read(store.store_dir().join(STATUS_FILE)).unwrap()).unwrap();
    assert_eq!(status["format"], "duegood-browser-import");
    assert_eq!(status["userId"], USER_ID);
    assert!(status["sections"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["endpoint"] == "quizzes" && row["status"] == "gap"));
    let archive: Value = serde_json::from_slice(
        &fs::read(store.store_dir().join("browser-courses-archive.json")).unwrap(),
    )
    .unwrap();
    assert!(archive["courses"]
        .as_array()
        .unwrap()
        .iter()
        .any(|course| course["canvasCourseId"] == 900002 && course["active"] == false));
    assert!(archive["courses"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |course| course["canvasCourseId"] == 900003 && course["classification"] == "historical"
        ));
    assert_eq!(
        fs::read(
            store
                .store_dir()
                .join("classes/canvas-900001/canvas-export/api/course.json")
        )
        .is_ok(),
        true
    );
    assert!(fs::read_dir(root.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".import-staging-refresh-")));
}

#[test]
fn preview_store_is_rejected_without_mutation() {
    let root = TempRoot::new("browser-import-preview");
    let store = open_store(&root, "preview", false);
    publish_attempt(&root, USER_ID);
    let before = snapshot_tree(&store.store_dir());
    assert!(matches!(
        run_import(&store, &root, Some(USER_ID)),
        Err(BrowserImportError::InvalidStore)
    ));
    assert_eq!(snapshot_tree(&store.store_dir()), before);
}

#[test]
fn first_account_requires_matching_explicit_confirmation() {
    let root = TempRoot::new("browser-import-confirm");
    let store = open_store(&root, "authoritative", false);
    publish_attempt(&root, USER_ID);
    assert!(matches!(
        run_import(&store, &root, None),
        Err(BrowserImportError::ConfirmationRequired)
    ));
    assert!(matches!(
        run_import(&store, &root, Some(USER_ID + 1)),
        Err(BrowserImportError::AccountMismatch)
    ));
    assert!(store.store_dir().join(STATUS_FILE).exists() == false);
}

#[test]
fn captured_account_confirmation_is_native_and_cannot_switch_a_bound_account() {
    let root = TempRoot::new("browser-import-captured-account-confirmation");
    let store = open_store(&root, "authoritative", false);
    publish_attempt(&root, USER_ID);
    assert!(matches!(
        run_import_confirmed(&store, &root, false),
        Err(BrowserImportError::ConfirmationRequired)
    ));
    run_import_confirmed(&store, &root, true).unwrap();
    let before = snapshot_tree(&store.store_dir());

    publish_attempt(&root, USER_ID + 1);
    assert!(matches!(
        run_import_confirmed(&store, &root, true),
        Err(BrowserImportError::AccountMismatch)
    ));
    assert_eq!(snapshot_tree(&store.store_dir()), before);
}

#[test]
fn import_migrates_only_verified_legacy_materials_after_snapshot() {
    let root = TempRoot::new("browser-import-legacy-materials");
    let store = open_store(&root, "authoritative", false);
    let course_root = store.store_dir().join("classes/synthetic-course-a");
    let export_root = course_root.join("canvas-export");
    let materials = course_root.join("materials");
    create_private_dir(&materials, false).unwrap();
    let verified_bytes = b"%PDF-1.7\nSynthetic legacy handout";
    let retained_bytes = b"<html>synthetic unsupported legacy bytes</html>";
    atomic_write(&materials.join("guide.pdf"), verified_bytes).unwrap();
    atomic_write(&materials.join("unknown.html"), retained_bytes).unwrap();
    atomic_write(
        &export_root.join("download-manifest.json"),
        &node_json_bytes(&json!([
            {"id":501,"status":"downloaded","filename":"guide.pdf","size":verified_bytes.len(),"name":"Synthetic Guide"},
            {"id":502,"status":"downloaded","filename":"unknown.html","size":retained_bytes.len(),"name":"Synthetic Unknown"},
            {"id":503,"status":"downloaded","filename":"missing.pdf","size":24,"name":"Synthetic Missing"}
        ])),
    )
    .unwrap();
    publish_attempt(&root, USER_ID);

    run_import(&store, &root, Some(USER_ID)).unwrap();

    let archive_bytes = fs::read(
        store
            .store_dir()
            .join("browser-legacy-resource-archive.json"),
    )
    .unwrap();
    let archive: Value = serde_json::from_slice(&archive_bytes).unwrap();
    let files = archive["files"].as_array().unwrap();
    let saved = files.iter().find(|file| file["fileId"] == 501).unwrap();
    assert_eq!(saved["status"], "saved");
    let hash = saved["sha256"].as_str().unwrap();
    assert_eq!(
        fs::read(
            store
                .data_root()
                .join("canvas-resource-archive/blobs")
                .join(hash)
        )
        .unwrap(),
        verified_bytes
    );
    assert_eq!(
        files.iter().find(|file| file["fileId"] == 502).unwrap()["status"],
        "gap"
    );
    assert_eq!(
        files.iter().find(|file| file["fileId"] == 503).unwrap()["gapReason"],
        "missing"
    );
    assert!(!store
        .store_dir()
        .join("classes/synthetic-course-a/materials/guide.pdf")
        .exists());
    assert_eq!(
        fs::read(
            store
                .store_dir()
                .join("classes/synthetic-course-a/materials/unknown.html")
        )
        .unwrap(),
        retained_bytes
    );

    let snapshot = crate::snapshots::list_snapshots(&store).unwrap().remove(0);
    assert_eq!(snapshot.kind, "pre-refresh");
    assert_eq!(
        fs::read(
            store
                .data_root()
                .join("snapshots")
                .join(snapshot.id)
                .join("classes/synthetic-course-a/materials/guide.pdf")
        )
        .unwrap(),
        verified_bytes
    );
}

#[test]
fn repeated_import_is_idempotent_and_bound_account_cannot_change() {
    let root = TempRoot::new("browser-import-repeat");
    let store = open_store(&root, "authoritative", false);
    publish_attempt(&root, USER_ID);
    run_import(&store, &root, Some(USER_ID)).unwrap();

    let imported = read_coursework(&store);
    assert_eq!(imported["courses"][0]["title"], "Synthetic Course 900001");
    assert_eq!(imported["courses"][0]["code"], "SYN-CANVAS-900001");
    let imported_course = imported["courses"][0].clone();
    let imported_item = imported["items"][0].clone();
    let before = snapshot_tree(&store.store_dir());
    let repeated = run_import(&store, &root, None).unwrap();
    assert!(repeated.already_current);
    assert_eq!(snapshot_tree(&store.store_dir()), before);

    let mut placeholders = read_coursework(&store);
    placeholders["courses"][0]["title"] = json!("Canvas course 900001");
    placeholders["courses"][0]["code"] = json!("900001");
    write_coursework(&store, &placeholders);

    let repaired = run_import(&store, &root, None).unwrap();
    assert!(!repaired.already_current);
    let repaired_coursework = read_coursework(&store);
    assert_eq!(
        repaired_coursework["courses"][0]["title"],
        "Synthetic Course 900001"
    );
    assert_eq!(
        repaired_coursework["courses"][0]["code"],
        "SYN-CANVAS-900001"
    );
    for field in ["key", "folder", "syntheticCourseExtension"] {
        assert_eq!(
            repaired_coursework["courses"][0][field],
            imported_course[field]
        );
    }
    for field in [
        "id",
        "done",
        "doneAt",
        "studentNote",
        "syntheticItemExtension",
    ] {
        assert_eq!(repaired_coursework["items"][0][field], imported_item[field]);
    }

    let after_repair = snapshot_tree(&store.store_dir());
    let repaired_repeat = run_import(&store, &root, None).unwrap();
    assert!(repaired_repeat.already_current);
    assert_eq!(snapshot_tree(&store.store_dir()), after_repair);

    publish_attempt(&root, USER_ID + 1);
    assert!(matches!(
        run_import(&store, &root, None),
        Err(BrowserImportError::AccountMismatch)
    ));
    assert_eq!(snapshot_tree(&store.store_dir()), before);
}

#[test]
fn older_receipt_cannot_replace_a_later_import() {
    let old = json!({"format":"duegood-browser-import","version":1,"runId":2,"generationId":"b123456789abcdef0123456789abcdef","userId":USER_ID});
    assert!(matches!(
        state::check_prior_receipt(Some(&old), 1, GENERATION_ID, USER_ID, None),
        Err(BrowserImportError::OlderCapture)
    ));
}

#[cfg(unix)]
#[test]
fn failed_tree_copy_cleans_its_owned_stage() {
    use std::os::unix::fs::symlink;
    let root = TempRoot::new("browser-import-stage-cleanup");
    let store = open_store(&root, "authoritative", false);
    publish_attempt(&root, USER_ID);
    symlink("missing-target", store.store_dir().join("zz-poison")).unwrap();
    assert!(matches!(
        run_import(&store, &root, Some(USER_ID)),
        Err(BrowserImportError::Stage | BrowserImportError::Store(_))
    ));
    assert!(fs::read_dir(root.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".import-staging-refresh-")));
    assert!(!store.store_dir().join(STATUS_FILE).exists());
}

#[test]
fn status_coverage_coalesces_duplicate_endpoint_rows_to_gap() {
    let root = TempRoot::new("browser-import-coverage");
    let _store = open_store(&root, "authoritative", false);
    publish_attempt(&root, USER_ID);
    let attempt = CaptureRunGuard::acquire(root.path())
        .unwrap()
        .attempt()
        .unwrap()
        .unwrap();
    let expected = ExpectedCaptureRun {
        run_id: attempt.run_id,
        generation_id: attempt.generation_id.clone(),
        user_id: attempt.user_id,
    };
    let app_root = canvas_capture_archive_root(root.path())
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let bundle = validate_current_bundle_with_progress(&app_root, &expected, |_| {}).unwrap();
    let mut bundle = bundle;
    bundle
        .coverage
        .push(crate::browser_bundle::CaptureCoverage {
            endpoint: "quizzes".into(),
            course_id: Some(COURSE_ID),
            group_id: None,
            context_code: None,
            status: "gap".into(),
            reason: None,
        });
    bundle.coverage.extend([
        crate::browser_bundle::CaptureCoverage {
            endpoint: "groupFolders".into(),
            course_id: None,
            group_id: Some(77),
            context_code: None,
            status: "complete".into(),
            reason: None,
        },
        crate::browser_bundle::CaptureCoverage {
            endpoint: "calendarEvents".into(),
            course_id: None,
            group_id: None,
            context_code: Some("user_41".into()),
            status: "complete".into(),
            reason: None,
        },
        crate::browser_bundle::CaptureCoverage {
            endpoint: "groups".into(),
            course_id: Some(COURSE_ID),
            group_id: None,
            context_code: None,
            status: "complete".into(),
            reason: None,
        },
    ]);
    let status = state::import_status(
        &bundle,
        &PromotionResult {
            promoted_blobs: 0,
            reused_blobs: 0,
            bytes_verified: 0,
        },
    )
    .unwrap();
    let quizzes = status["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["endpoint"] == "quizzes")
        .unwrap();
    assert_eq!(quizzes["status"], "gap");
    let sections = status["sections"].as_array().unwrap();
    assert!(!sections.iter().any(|row| row["endpoint"] == "groupFolders"));
    assert!(!sections
        .iter()
        .any(|row| row["endpoint"] == "calendarEvents"));
    assert!(!sections.iter().any(|row| row["endpoint"] == "groups"));
}
