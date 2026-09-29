use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    validate_current_bundle, validate_current_bundle_with_progress, BundleError, ExpectedCaptureRun,
};

const RUN_ID: u64 = 7;
const USER_ID: u64 = 41;
const COURSE_ID: u64 = 101;
const GENERATION_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORIGIN: &str = "https://marymount.instructure.com";

struct ArchiveFixture {
    root: PathBuf,
    app_root: PathBuf,
    generation: PathBuf,
    blobs: PathBuf,
    snapshot: Value,
    manifest: Value,
    pointer: Value,
    body: Vec<u8>,
}

impl ArchiveFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "duegood-bundle-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        private_dir(&root);
        let root = fs::canonicalize(root).expect("canonicalize synthetic root");
        let app_root = root.join("app");
        let archive = app_root.join("canvas-capture-archive");
        let generations = archive.join("generations");
        let generation = generations.join(GENERATION_ID);
        let blobs = archive.join("blobs");
        for directory in [&app_root, &archive, &generations, &generation, &blobs] {
            private_dir(directory);
        }

        let body = b"synthetic archived body".to_vec();
        let hash = format!("{:x}", Sha256::digest(&body));
        let captured_at = "2026-09-27T18:00:00.000Z";
        let required = ["course", "assignments", "assignmentGroups", "submissions"];
        let mut resources = vec![
            resource("coursesActive", Value::Null, json!([{ "id": COURSE_ID }])),
            resource("course", json!(COURSE_ID), json!([{ "id": COURSE_ID }])),
            resource("assignments", json!(COURSE_ID), json!([])),
            resource("assignmentGroups", json!(COURSE_ID), json!([])),
            resource("submissions", json!(COURSE_ID), json!([])),
            resource(
                "fileBodies",
                Value::Null,
                json!([{
                    "fileId": 77,
                    "status": "archived",
                    "byteCount": body.len(),
                    "sha256": hash,
                    "contentType": "application/octet-stream",
                    "sourceAuthenticity": "unverified"
                }]),
            ),
        ];
        for (index, resource) in resources.iter_mut().enumerate() {
            resource["pages"] = json!(1);
            assert!(index < 6);
        }
        let mut coverage =
            vec![json!({ "endpoint": "coursesActive", "courseId": null, "status": "complete" })];
        for endpoint in required {
            coverage
                .push(json!({ "endpoint": endpoint, "courseId": COURSE_ID, "status": "complete" }));
        }
        coverage.push(json!({ "endpoint": "calendar", "courseId": COURSE_ID, "status": "gap", "reason": "not-attempted" }));
        coverage.push(json!({ "endpoint": "fileBodies", "courseId": null, "status": "gap", "reason": "not-attempted" }));
        let snapshot = json!({
            "schemaVersion": 2,
            "source": "canvas-browser",
            "runId": RUN_ID,
            "generationId": GENERATION_ID,
            "capturedAt": captured_at,
            "complete": false,
            "identity": { "origin": ORIGIN, "userId": USER_ID },
            "activeCourses": { "complete": true, "courseIds": [COURSE_ID] },
            "coverageRequirements": {
                "activeCoursesComplete": true,
                "perActiveCourse": ["course", "assignments", "assignmentGroups", "submissions"]
            },
            "resources": resources,
            "coverage": coverage
        });
        let snapshot_bytes = serde_json::to_vec(&snapshot).unwrap();
        let snapshot_hash = format!("{:x}", Sha256::digest(&snapshot_bytes));
        let receipt = json!({
            "fileId": 77,
            "byteCount": body.len(),
            "sha256": hash,
            "contentType": "application/octet-stream",
            "sourceAuthenticity": "unverified"
        });
        let manifest = json!({
            "format": "duegood-canvas-capture-generation",
            "version": 2,
            "runId": RUN_ID,
            "generationId": GENERATION_ID,
            "capturedAt": captured_at,
            "complete": false,
            "identity": { "origin": ORIGIN, "userId": USER_ID },
            "snapshotBytes": snapshot_bytes.len(),
            "snapshotSha256": snapshot_hash,
            "resourceCount": 6,
            "itemCount": 3,
            "blobCount": 1,
            "blobBytes": body.len(),
            "blobs": [receipt]
        });
        let pointer = json!({
            "format": "duegood-canvas-capture-current",
            "version": 2,
            "runId": RUN_ID,
            "generationId": GENERATION_ID,
            "snapshotSha256": snapshot_hash
        });
        write_json(&generation.join("snapshot.json"), &snapshot);
        write_json(&generation.join("manifest.json"), &manifest);
        write_json(&archive.join("current.json"), &pointer);
        write_private(&blobs.join(format!("{hash}.blob")), &body);
        Self {
            root,
            app_root,
            generation,
            blobs,
            snapshot,
            manifest,
            pointer,
            body,
        }
    }

    fn expected(&self) -> ExpectedCaptureRun {
        ExpectedCaptureRun {
            run_id: RUN_ID,
            generation_id: Some(GENERATION_ID.to_owned()),
            user_id: Some(USER_ID),
        }
    }

    fn rewrite_snapshot(&mut self) {
        let snapshot_bytes = serde_json::to_vec(&self.snapshot).unwrap();
        let hash = format!("{:x}", Sha256::digest(&snapshot_bytes));
        self.manifest["snapshotBytes"] = json!(snapshot_bytes.len());
        self.manifest["snapshotSha256"] = json!(hash);
        self.pointer["snapshotSha256"] = json!(hash);
        write_private(&self.generation.join("snapshot.json"), &snapshot_bytes);
        write_json(&self.generation.join("manifest.json"), &self.manifest);
        write_json(
            &self.app_root.join("canvas-capture-archive/current.json"),
            &self.pointer,
        );
    }

    fn rewrite_manifest(&mut self) {
        write_json(&self.generation.join("manifest.json"), &self.manifest);
    }
}

impl Drop for ArchiveFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn resource(endpoint: &str, course_id: Value, items: Value) -> Value {
    json!({ "endpoint": endpoint, "courseId": course_id, "items": items, "pages": 1 })
}

fn private_dir(path: &Path) {
    fs::create_dir(path).expect("create synthetic directory");
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .expect("set private directory mode");
}

fn write_private(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .expect("open synthetic private file");
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .expect("set private file mode");
    file.write_all(bytes).expect("write synthetic private file");
}

fn write_json(path: &Path, value: &Value) {
    write_private(path, &serde_json::to_vec(value).unwrap());
}

#[test]
fn validates_v2_generation_coverage_and_streamed_blob_progress() {
    let fixture = ArchiveFixture::new();
    let mut last = None;
    let result =
        validate_current_bundle_with_progress(&fixture.app_root, &fixture.expected(), |value| {
            last = Some(value)
        })
        .expect("synthetic bundle validates");
    assert_eq!(result.run_id, RUN_ID);
    assert_eq!(result.user_id, USER_ID);
    assert_eq!(result.active_courses.len(), 1);
    assert!(result.active_courses[0].complete);
    assert!(result
        .coverage
        .iter()
        .any(|row| row.endpoint == "fileBodies" && row.status == "gap"));
    let progress = last.expect("final progress emitted");
    assert_eq!(progress.bytes_verified, fixture.body.len() as u64);
    assert_eq!(progress.total_blob_bytes, fixture.body.len() as u64);
    assert_eq!(progress.files_verified, 1);
    assert_eq!(progress.total_blob_files, 1);
}

#[test]
fn retains_repeated_child_detail_coverage_and_each_optional_gap() {
    let mut fixture = ArchiveFixture::new();
    let endpoints = [
        "page",
        "moduleItems",
        "discussionEntries",
        "discussionReplies",
        "submission",
        "quiz",
        "conversation",
        "file",
        "personalFile",
        "groupFolderFiles",
        "groupPage",
        "groupDiscussionEntries",
        "groupDiscussionReplies",
    ];
    for endpoint in endpoints {
        let course_id = if endpoint.starts_with("group")
            || ["conversation", "file", "personalFile"].contains(&endpoint)
        {
            Value::Null
        } else {
            json!(COURSE_ID)
        };
        let mut row = json!({"endpoint": endpoint, "courseId": course_id, "status": "complete"});
        if endpoint.starts_with("group") {
            row["groupId"] = json!(900);
        }
        let coverage = fixture.snapshot["coverage"].as_array_mut().unwrap();
        coverage.extend([row.clone(), row.clone()]);
        for reason in ["forbidden-optional", "request-failed", "not-attempted"] {
            row["status"] = json!("gap");
            row["reason"] = json!(reason);
            coverage.push(row.clone());
        }
    }
    fixture.rewrite_snapshot();
    let bundle = validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap();
    for endpoint in endpoints {
        let rows = bundle
            .coverage
            .iter()
            .filter(|row| row.endpoint == endpoint)
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 5, "{endpoint}");
        assert_eq!(
            rows.iter().filter(|row| row.status == "complete").count(),
            2
        );
        for reason in ["forbidden-optional", "request-failed", "not-attempted"] {
            assert!(rows
                .iter()
                .any(|row| row.status == "gap" && row.reason.as_deref() == Some(reason)));
        }
    }
}

#[test]
fn rejects_duplicate_required_and_aggregate_optional_coverage() {
    for endpoint in [
        "coursesActive",
        "course",
        "assignments",
        "assignmentGroups",
        "submissions",
        "inbox",
        "pages",
        "courseFiles",
        "groupPages",
        "calendarEvents",
        "unknownDetail",
    ] {
        let mut fixture = ArchiveFixture::new();
        let coverage = fixture.snapshot["coverage"].as_array_mut().unwrap();
        let existing = coverage
            .iter()
            .find(|row| row["endpoint"] == endpoint)
            .cloned();
        if let Some(row) = existing {
            coverage.push(row);
        } else {
            let mut row = json!({"endpoint": endpoint, "courseId": null, "status": "complete"});
            if endpoint == "groupPages" {
                row["groupId"] = json!(900);
            }
            if endpoint == "calendarEvents" {
                row["contextCode"] = json!("user_41");
            }
            coverage.extend([row.clone(), row]);
        }
        fixture.rewrite_snapshot();
        let expected = match endpoint {
            "coursesActive" => BundleError::IncompleteInventory,
            "course" | "assignments" | "assignmentGroups" | "submissions" => {
                BundleError::IncompleteCoverage
            }
            _ => BundleError::InvalidSnapshot,
        };
        assert_eq!(
            validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
            expected,
            "{endpoint}"
        );
    }
}

#[test]
fn rejects_legacy_pointer_and_stale_run_receipt() {
    let mut fixture = ArchiveFixture::new();
    fixture.pointer["version"] = json!(1);
    write_json(
        &fixture.app_root.join("canvas-capture-archive/current.json"),
        &fixture.pointer,
    );
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
        BundleError::UnsupportedVersion
    );

    fixture.pointer["version"] = json!(2);
    write_json(
        &fixture.app_root.join("canvas-capture-archive/current.json"),
        &fixture.pointer,
    );
    let mut stale = fixture.expected();
    stale.run_id += 1;
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &stale).unwrap_err(),
        BundleError::RunMismatch
    );
}

#[test]
fn rejects_incomplete_active_course_coverage_even_when_snapshot_is_partial() {
    let mut fixture = ArchiveFixture::new();
    fixture.snapshot["coverage"][2]["status"] = json!("gap");
    fixture.rewrite_snapshot();
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
        BundleError::IncompleteCoverage
    );
}

#[test]
fn rejects_claimed_blob_with_wrong_content_hash() {
    let fixture = ArchiveFixture::new();
    let blob = fs::read_dir(&fixture.blobs)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut corrupt = fixture.body.clone();
    corrupt[0] ^= 1;
    write_private(&blob, &corrupt);
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
        BundleError::BlobMismatch
    );
}

#[test]
fn rejects_symlinked_snapshot_and_identity_mismatch() {
    let fixture = ArchiveFixture::new();
    let snapshot_path = fixture.generation.join("snapshot.json");
    fs::remove_file(&snapshot_path).unwrap();
    let outside = fixture.root.join("snapshot.json");
    write_json(&outside, &fixture.snapshot);
    std::os::unix::fs::symlink(outside, snapshot_path).unwrap();
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
        BundleError::UnsafeFile
    );

    let mut fixture = ArchiveFixture::new();
    fixture.manifest["identity"]["userId"] = json!(USER_ID + 1);
    fixture.rewrite_manifest();
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
        BundleError::IdentityMismatch
    );
}

#[test]
fn rejects_private_material_and_incomplete_inventory() {
    let mut fixture = ArchiveFixture::new();
    fixture.snapshot["resources"][1]["items"][0]["access_token"] = json!("synthetic-redacted");
    fixture.rewrite_snapshot();
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
        BundleError::InvalidSnapshot
    );

    let mut fixture = ArchiveFixture::new();
    fixture.snapshot["activeCourses"]["complete"] = json!(false);
    fixture.rewrite_snapshot();
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
        BundleError::IncompleteInventory
    );
}

#[test]
fn preserves_group_and_calendar_context_without_expanding_active_course_scope() {
    let mut fixture = ArchiveFixture::new();
    fixture.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint": "pages",
            "courseId": null,
            "groupId": 900,
            "items": [],
            "pages": 1
        }));
    fixture.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint": "calendarEvents",
            "courseId": null,
            "contextCode": "account_9",
            "items": [],
            "pages": 1
        }));
    fixture.snapshot["coverage"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint": "groupPages",
            "courseId": null,
            "groupId": 900,
            "status": "complete"
        }));
    fixture.snapshot["coverage"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint": "calendarEvents",
            "contextCode": "account_9",
            "status": "complete"
        }));
    fixture.manifest["resourceCount"] = json!(8);
    fixture.rewrite_snapshot();

    let bundle = validate_current_bundle(&fixture.app_root, &fixture.expected())
        .expect("bounded group and calendar contexts validate");
    assert_eq!(bundle.active_courses.len(), 1);
    assert!(bundle.active_courses[0].complete);
    assert!(bundle.coverage.iter().any(|row| {
        row.endpoint == "groupPages"
            && row.course_id.is_none()
            && row.group_id == Some(900)
            && row.context_code.is_none()
    }));
    assert!(bundle.coverage.iter().any(|row| {
        row.endpoint == "calendarEvents"
            && row.course_id.is_none()
            && row.group_id.is_none()
            && row.context_code.as_deref() == Some("account_9")
    }));
}

#[test]
fn group_coverage_cannot_replace_required_course_coverage_and_context_is_strict() {
    let mut fixture = ArchiveFixture::new();
    fixture.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|row| row["endpoint"] != "assignments");
    fixture.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint": "courseFiles",
            "courseId": null,
            "groupId": 900,
            "items": [],
            "pages": 1
        }));
    fixture.snapshot["coverage"]
        .as_array_mut()
        .unwrap()
        .retain(|row| row["endpoint"] != "assignments");
    fixture.snapshot["coverage"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint": "groupFolderFiles",
            "courseId": null,
            "groupId": 900,
            "status": "complete"
        }));
    fixture.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint": "calendarEvents",
            "courseId": null,
            "contextCode": "account_09",
            "items": [],
            "pages": 1
        }));
    fixture.manifest["resourceCount"] = json!(7);
    fixture.rewrite_snapshot();
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
        BundleError::InvalidSnapshot
    );

    let mut fixture = ArchiveFixture::new();
    fixture.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|row| row["endpoint"] != "assignments");
    fixture.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint": "courseFiles",
            "courseId": null,
            "groupId": 900,
            "items": [],
            "pages": 1
        }));
    fixture.snapshot["coverage"]
        .as_array_mut()
        .unwrap()
        .retain(|row| row["endpoint"] != "assignments");
    fixture.snapshot["coverage"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint": "groupFolderFiles",
            "courseId": null,
            "groupId": 900,
            "status": "complete"
        }));
    fixture.manifest["resourceCount"] = json!(6);
    fixture.rewrite_snapshot();
    assert_eq!(
        validate_current_bundle(&fixture.app_root, &fixture.expected()).unwrap_err(),
        BundleError::IncompleteCoverage
    );
}
