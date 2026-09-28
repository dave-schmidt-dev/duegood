use super::*;
use serde_json::json;
use std::path::PathBuf;
use uuid::Uuid;

struct TempArchive(PathBuf);

impl TempArchive {
    fn new() -> Self {
        let root = std::env::temp_dir()
            .join(format!(
                "duegood-capture-summary-{}",
                Uuid::new_v4().simple()
            ))
            .join(crate::config::TEST_BUNDLE_IDENTIFIER)
            .join("canvas-capture-archive");
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        Self(root)
    }
}

impl Drop for TempArchive {
    fn drop(&mut self) {
        if let Some(parent) = self.0.parent().and_then(Path::parent) {
            let _ = fs::remove_dir_all(parent);
        }
    }
}

fn publish(root: &Path, snapshot: &Value, blobs: Vec<Value>) -> (String, String) {
    let run_id = 4;
    let generation_id = "a".repeat(32);
    let generation = root.join("generations").join(&generation_id);
    fs::create_dir_all(&generation).unwrap();
    let bytes = serde_json::to_vec(snapshot).unwrap();
    let digest = format!("{:x}", sha2::Sha256::digest(&bytes));
    fs::write(generation.join("snapshot.json"), &bytes).unwrap();
    let item_count: usize = snapshot["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|resource| resource["items"].as_array().unwrap().len())
        .sum();
    let manifest = json!({
        "format":"duegood-canvas-capture-generation", "version":2,
        "runId":run_id, "generationId":generation_id, "capturedAt":"2026-09-27T12:00:00Z",
        "complete":false, "identity":{"origin":CANVAS_ORIGIN,"userId":41},
        "snapshotBytes":bytes.len(), "snapshotSha256":digest,
        "resourceCount":snapshot["resources"].as_array().unwrap().len(), "itemCount":item_count,
        "blobCount":blobs.len(), "blobBytes":blobs.iter().map(|blob| blob["byteCount"].as_u64().unwrap()).sum::<u64>(),
        "blobs":blobs,
    });
    fs::write(
        generation.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    fs::write(
        root.join("current.json"),
        serde_json::to_vec(&json!({
            "format":"duegood-canvas-capture-current", "version":2,
            "runId":run_id, "generationId":generation_id, "snapshotSha256":digest,
        }))
        .unwrap(),
    )
    .unwrap();
    (generation_id, digest)
}

fn snapshot(file_body: Option<Value>) -> Value {
    let mut resources = vec![json!({
        "endpoint":"coursesActive", "courseId":null, "pages":1,
        "items":[{"id":81,"name":"Synthetic course"}],
    })];
    let mut coverage =
        vec![json!({"endpoint":"coursesActive","courseId":null,"status":"complete"})];
    for endpoint in ["course", "assignments", "assignmentGroups", "submissions"] {
        resources.push(json!({"endpoint":endpoint,"courseId":81,"pages":1,"items":[]}));
        coverage.push(json!({"endpoint":endpoint,"courseId":81,"status":"complete"}));
    }
    if let Some(item) = file_body {
        resources.push(json!({"endpoint":"fileBodies","courseId":null,"pages":1,"items":[item]}));
        coverage.push(json!({"endpoint":"fileBodies","courseId":null,"status":"complete"}));
    }
    json!({
        "schemaVersion":2,"source":"canvas-browser","runId":4,
        "generationId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","capturedAt":"2026-09-27T12:00:00Z",
        "complete":false,"identity":{"origin":CANVAS_ORIGIN,"userId":41},
        "activeCourses":{"complete":true,"courseIds":[81]},
        "coverageRequirements":{"activeCoursesComplete":true,"perActiveCourse":["course","assignments","assignmentGroups","submissions"]},
        "resources":resources,"coverage":coverage,
    })
}

#[test]
fn summary_validates_blob_links_and_metadata_without_reading_blob_body() {
    let archive = TempArchive::new();
    let hash = "b".repeat(64);
    let receipt = json!({"fileId":99,"byteCount":4,"sha256":hash,"contentType":"application/pdf","sourceAuthenticity":"unverified"});
    let item = json!({"status":"archived","fileId":99,"byteCount":4,"sha256":hash,"contentType":"application/pdf","sourceAuthenticity":"unverified"});
    let snapshot = snapshot(Some(item));
    let (generation_id, digest) = publish(&archive.0, &snapshot, vec![receipt]);
    let blobs = archive.0.join("blobs");
    fs::create_dir(&blobs).unwrap();
    let body = blobs.join(format!("{hash}.blob"));
    fs::write(&body, b"data").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&body, fs::Permissions::from_mode(0o600)).unwrap();
    }

    let summary =
        summarize_published_generation(&archive.0, 4, &generation_id, &digest, 41).unwrap();
    assert_eq!(summary.user_id, 41);
    assert_eq!(summary.active_course_count, 1);
    assert_eq!(summary.resource_count, 6);
    assert_eq!(summary.item_count, 2);
    assert_eq!(summary.blob_count, 1);
    assert_eq!(summary.blob_bytes, 4);
}

#[test]
fn summary_rejects_missing_or_mismatched_blob_links() {
    let archive = TempArchive::new();
    let hash = "c".repeat(64);
    let receipt = json!({"fileId":99,"byteCount":4,"sha256":hash,"contentType":"application/pdf","sourceAuthenticity":"unverified"});
    let item = json!({"status":"archived","fileId":99,"byteCount":5,"sha256":hash,"contentType":"application/pdf","sourceAuthenticity":"unverified"});
    let (generation_id, digest) = publish(&archive.0, &snapshot(Some(item)), vec![receipt]);
    assert!(summarize_published_generation(&archive.0, 4, &generation_id, &digest, 41).is_err());
}
