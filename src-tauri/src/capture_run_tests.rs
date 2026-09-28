use super::*;
use serde_json::json;
use sha2::Digest;
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use uuid::Uuid;

const CANVAS_ORIGIN: &str = "https://marymount.instructure.com";

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        let root = std::env::temp_dir()
            .join(format!("duegood-capture-run-{}", Uuid::new_v4().simple()))
            .join("com.zerodelta.duegood.test");
        fs::create_dir_all(&root).expect("create synthetic test root");
        Self(fs::canonicalize(root).expect("canonical synthetic test root"))
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        if let Some(parent) = self.0.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
}

fn snapshot(run_id: u64, generation_id: &str, with_required_coverage: bool) -> Value {
    let ids = [81_u64, 82_u64];
    let mut coverage = vec![json!({
        "endpoint":"coursesActive","courseId":null,"status":"complete"
    })];
    if with_required_coverage {
        for id in ids {
            for endpoint in ["course", "assignments", "assignmentGroups", "submissions"] {
                coverage.push(json!({"endpoint":endpoint,"courseId":id,"status":"complete"}));
            }
        }
    }
    json!({
        "schemaVersion":2,
        "source":"canvas-browser",
        "runId":run_id,
        "generationId":generation_id,
        "capturedAt":"2026-09-27T12:00:00Z",
        "complete":false,
        "identity":{"origin":CANVAS_ORIGIN,"userId":41},
        "activeCourses":{"complete":true,"courseIds":ids},
        "coverageRequirements":{
            "activeCoursesComplete":true,
            "perActiveCourse":["course","assignments","assignmentGroups","submissions"]
        },
        "resources":[{
            "endpoint":"coursesActive","courseId":null,"pages":1,
            "items":[{"id":81,"name":"Synthetic A"},{"id":82,"name":"Synthetic B"}]
        }],
        "coverage":coverage
    })
}

fn publish_generation(
    root: &Path,
    run_id: u64,
    generation_id: &str,
    with_coverage: bool,
) -> String {
    let archive_root = config::canvas_capture_archive_root(root).expect("test archive root");
    let generation = archive_root.join("generations").join(generation_id);
    fs::create_dir_all(&generation).expect("create generation");
    let bytes = serde_json::to_vec(&snapshot(run_id, generation_id, with_coverage)).unwrap();
    let digest = format!("{:x}", sha2::Sha256::digest(&bytes));
    fs::write(generation.join("snapshot.json"), &bytes).unwrap();
    fs::write(
        generation.join("manifest.json"),
        serde_json::to_vec(&json!({
            "format":"duegood-canvas-capture-generation",
            "version":2,
            "runId":run_id,
            "generationId":generation_id,
            "capturedAt":"2026-09-27T12:00:00Z",
            "complete":false,
            "identity":{"origin":CANVAS_ORIGIN,"userId":41},
            "snapshotBytes":bytes.len(),
            "snapshotSha256":digest,
            "resourceCount":1,
            "itemCount":2,
            "blobCount":0,
            "blobBytes":0,
            "blobs":[]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        archive_root.join("current.json"),
        serde_json::to_vec(&json!({
            "format":"duegood-canvas-capture-current",
            "version":2,
            "runId":run_id,
            "generationId":generation_id,
            "snapshotSha256":digest
        }))
        .unwrap(),
    )
    .unwrap();
    digest
}

#[test]
fn guard_excludes_other_writers_and_unlocked_status_remains_nonblocking() {
    let root = TestRoot::new();
    let guard = CaptureRunGuard::acquire(&root.0).unwrap();
    let attempt = guard.begin().unwrap();
    assert_eq!(attempt.run_id, 1);
    assert_eq!(
        read_attempt_unlocked(&root.0).unwrap().unwrap().status,
        CaptureAttemptStatus::Running
    );
    assert_eq!(
        CaptureRunGuard::acquire(&root.0).err().unwrap().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn lease_marks_success_only_after_pointer_manifest_snapshot_and_active_coverage_match() {
    let root = TestRoot::new();
    let generation_id = "a".repeat(32);
    let digest = publish_generation(&root.0, 1, &generation_id, true);
    let request = json!({
        "status":"captured","runId":1,"generationId":generation_id,
        "snapshotSha256":digest,"userId":41
    });
    let mut output = Vec::new();
    let attempt = run_lease(
        &root.0,
        Cursor::new(serde_json::to_vec(&request).unwrap()),
        &mut output,
    )
    .unwrap();
    assert_eq!(attempt.status, CaptureAttemptStatus::Captured);
    assert_eq!(
        attempt.generation_id.as_deref(),
        Some(generation_id.as_str())
    );
    assert_eq!(attempt.user_id, Some(41));
    assert!(String::from_utf8(output)
        .unwrap()
        .contains("run=1 status=captured"));
}

#[test]
fn run_mismatch_and_incomplete_active_coverage_fail_closed() {
    let root = TestRoot::new();
    let generation_id = "b".repeat(32);
    let digest = publish_generation(&root.0, 2, &generation_id, false);
    let guard = CaptureRunGuard::acquire(&root.0).unwrap();
    let attempt = guard.begin().unwrap();
    assert_eq!(attempt.run_id, 1);
    assert!(guard.complete(1, &generation_id, &digest, 41).is_err());
    assert_eq!(
        guard.attempt().unwrap().unwrap().status,
        CaptureAttemptStatus::Running
    );
}

#[test]
fn failed_and_eof_terminal_requests_mark_the_attempt_failed() {
    let root = TestRoot::new();
    let mut output = Vec::new();
    assert!(run_lease(&root.0, Cursor::new(Vec::<u8>::new()), &mut output).is_err());
    assert_eq!(
        read_attempt_unlocked(&root.0).unwrap().unwrap().status,
        CaptureAttemptStatus::Failed
    );

    let root = TestRoot::new();
    let mut output = Vec::new();
    let failure = json!({"status":"failed","runId":1});
    let attempt = run_lease(
        &root.0,
        Cursor::new(serde_json::to_vec(&failure).unwrap()),
        &mut output,
    )
    .unwrap();
    assert_eq!(attempt.status, CaptureAttemptStatus::Failed);
}

#[test]
fn a_published_archive_after_process_crash_remains_running_not_captured() {
    let root = TestRoot::new();
    let generation_id = "c".repeat(32);
    publish_generation(&root.0, 1, &generation_id, true);
    let guard = CaptureRunGuard::acquire(&root.0).unwrap();
    guard.begin().unwrap();
    drop(guard);
    let status = read_attempt_unlocked(&root.0).unwrap().unwrap();
    assert_eq!(status.status, CaptureAttemptStatus::Running);
    assert_eq!(status.generation_id, None);
}

#[test]
fn uncommitted_counter_transition_is_not_reported_as_current() {
    let root = TestRoot::new();
    let guard = CaptureRunGuard::acquire(&root.0).unwrap();
    guard.begin().unwrap();
    let counter_path = capture_state_paths(&root.0).0;
    let counter: Value = serde_json::from_slice(&fs::read(&counter_path).unwrap()).unwrap();
    fs::write(counter_path, serde_json::to_vec(&json!({
        "format":STATE_FORMAT,"version":STATE_VERSION,"last_run_id":counter["last_run_id"].as_u64().unwrap()+1
    })).unwrap()).unwrap();
    assert!(read_attempt_unlocked(&root.0).is_err());
}
