use serde_json::{json, Value};

use crate::browser_projection::{project_snapshot, BrowserCourseScope, ProjectionError};

fn scope() -> BrowserCourseScope {
    BrowserCourseScope {
        key: "demo-101".into(),
        folder: "classes/demo-101".into(),
        canvas_course_id: 101,
    }
}

fn resource(endpoint: &str, course_id: Option<u64>, items: Value) -> Value {
    json!({
        "endpoint": endpoint,
        "courseId": course_id,
        "items": items,
        "pages": 1
    })
}

fn snapshot() -> Value {
    json!({
        "schemaVersion": 2,
        "source": "canvas-browser",
        "capturedAt": "2026-09-27T18:00:00Z",
        "complete": false,
        "identity": {"origin": "https://marymount.instructure.com", "userId": 7001},
        "resources": [
            resource("course", Some(101), json!([{"id":101,"name":"Demo 101","course_code":"DEMO 101"}])),
            resource("assignments", Some(101), json!([{
                "id": 5001,
                "course_id": 101,
                "name": "Synthetic essay",
                "assignment_group_id": 4001,
                "html_url": "https://marymount.instructure.com/courses/101/assignments/5001?verifier=synthetic-secret"
            }])),
            resource("assignmentGroups", Some(101), json!([{"id":4001,"name":"Essays","group_weight":50}])),
            resource("submissions", Some(101), json!([{
                "assignment_id": 5001,
                "course_id": 101,
                "user_id": 7001,
                "workflow_state": "submitted",
                "submitted_at": "2026-09-26T12:00:00Z",
                "score": 9
            }]))
        ]
    })
}

fn decoded_documents(snapshot: &Value) -> BTreeDocuments {
    let projection = project_snapshot(snapshot, &[scope()]).expect("projection succeeds");
    BTreeDocuments(
        projection
            .documents
            .into_iter()
            .map(|(path, bytes)| {
                (
                    path,
                    serde_json::from_slice::<Value>(&bytes).expect("document json"),
                )
            })
            .collect(),
    )
}

struct BTreeDocuments(std::collections::BTreeMap<String, Value>);

#[test]
fn projects_coursework_and_merges_canvas_submission_without_local_done_state() {
    let projection = project_snapshot(&snapshot(), &[scope()]).expect("projection succeeds");
    let course = &projection.coursework[0];
    assert_eq!(course.key, "demo-101");
    assert_eq!(course.groups[0]["id"], 4001);
    assert_eq!(
        course.assignments[0]["submission"]["workflow_state"],
        "submitted"
    );
    assert_eq!(course.assignments[0]["submission"]["score"], 9);
    assert!(course.assignments[0].get("done").is_none());
    assert!(course.assignments[0].get("completed").is_none());
    assert_eq!(
        course.assignments[0]["html_url"],
        "https://marymount.instructure.com/courses/101/assignments/5001"
    );
    assert!(projection
        .documents
        .contains_key("classes/demo-101/canvas-export/api/assignment_groups.json"));
    assert!(projection
        .documents
        .contains_key("classes/demo-101/canvas-export/api/course.json"));
    assert!(projection
        .documents
        .keys()
        .all(|path| path.starts_with("classes/demo-101/")));
}

#[test]
fn rejects_duplicate_required_endpoint_for_one_course() {
    let mut input = snapshot();
    input["resources"]
        .as_array_mut()
        .expect("resources")
        .push(resource("assignments", Some(101), json!([])));
    assert_eq!(
        project_snapshot(&input, &[scope()]).unwrap_err(),
        ProjectionError::DuplicateResource
    );
}

#[test]
fn requires_all_coursework_endpoints_even_when_capture_claims_complete() {
    let mut input = snapshot();
    input["complete"] = Value::Bool(true);
    input["resources"]
        .as_array_mut()
        .expect("resources")
        .retain(|resource| resource["endpoint"] != "submissions");
    assert_eq!(
        project_snapshot(&input, &[scope()]).unwrap_err(),
        ProjectionError::MissingEndpoint
    );
}

#[test]
fn rejects_assignment_course_and_submission_user_mismatches() {
    let mut wrong_course = snapshot();
    wrong_course["resources"][1]["items"][0]["course_id"] = json!(102);
    assert_eq!(
        project_snapshot(&wrong_course, &[scope()]).unwrap_err(),
        ProjectionError::IdentityMismatch
    );

    let mut wrong_user = snapshot();
    wrong_user["resources"][3]["items"][0]["user_id"] = json!(7002);
    assert_eq!(
        project_snapshot(&wrong_user, &[scope()]).unwrap_err(),
        ProjectionError::IdentityMismatch
    );
}

#[test]
fn rejects_submissions_without_a_matching_assignment() {
    let mut input = snapshot();
    input["resources"][3]["items"][0]["assignment_id"] = json!(5999);
    assert_eq!(
        project_snapshot(&input, &[scope()]).unwrap_err(),
        ProjectionError::IdentityMismatch
    );
}

#[test]
fn sanitizes_link_queries_and_keeps_only_synthetic_archived_receipt_metadata() {
    let mut input = snapshot();
    input["resources"].as_array_mut().unwrap().extend([
        resource("courseFiles", Some(101), json!([{
            "id": 9901,
            "display_name": "Synthetic reading.pdf",
            "filename": "reading.pdf",
            "size": 27,
            "url": "https://marymount.instructure.com/files/9901/download?verifier=synthetic-file-secret"
        }])),
        resource("fileBodies", None, json!([{
            "fileId": 9901,
            "status": "archived",
            "byteCount": 27,
            "sha256": "a".repeat(64),
            "contentType": "application/pdf",
            "sourceAuthenticity": "unverified"
        }]))
    ]);

    let documents = decoded_documents(&input);
    let manifest = &documents.0["classes/demo-101/canvas-export/download-manifest.json"];
    assert_eq!(manifest[0]["fileId"], 9901);
    assert_eq!(manifest[0]["status"], "saved");
    assert_eq!(manifest[0]["sha256"], "a".repeat(64));
    assert_eq!(manifest[0]["sourceAuthenticity"], "unverified");
    assert!(manifest[0].get("localPath").is_none());
    assert!(manifest[0].get("stagedFile").is_none());
    let files = &documents.0["classes/demo-101/canvas-export/api/files.json"];
    assert_eq!(files[0]["url"], Value::Null);
    let serialized = serde_json::to_string(&documents.0).unwrap();
    assert!(!serialized.contains("synthetic-file-secret"));
    assert!(!serialized.contains("stagedFile"));
}

#[test]
fn drops_unsafe_link_schemes_and_redacts_credentials_inside_text() {
    let mut input = snapshot();
    input["resources"][0]["items"][0]["syllabus_body"] =
        json!("A reference says access token=synthetic-secret and Bearer another-secret. See https://files.example/private?token=url-secret.");
    input["resources"][0]["items"][0]["_canvasLinks"] = json!([{
        "source": "course/101/1",
        "title": "Unsafe scheme",
        "asciiHostname": null,
        "safeTarget": "javascript:alert(1)",
        "clickable": false,
        "reason": "unsafe-scheme"
    }]);
    input["resources"][0]["items"][0]["_canvasLinksTruncated"] = json!(true);
    input["resources"][0]["items"][0]["_canvasTextTruncated"] = json!(true);
    let projection = project_snapshot(&input, &[scope()]).expect("sanitizes inputs");
    let course_path = "classes/demo-101/canvas-export/api/course.json";
    let course: Value = serde_json::from_slice(&projection.documents[course_path]).unwrap();
    assert_eq!(course["links"][0]["safeTarget"], Value::Null);
    assert_eq!(course["links"][0]["clickable"], false);
    assert_eq!(course["linksTruncated"], true);
    assert_eq!(course["textTruncated"], true);
    assert!(course["syllabus_body"]
        .as_str()
        .unwrap()
        .contains("[redacted]"));
    let text = serde_json::to_string(&course).unwrap();
    assert!(!text.contains("synthetic-secret"));
    assert!(!text.contains("another-secret"));
    assert!(!text.contains("url-secret"));
    assert!(!text.contains("files.example"));
    let inventory_path = "classes/demo-101/canvas-export/course-inventory.json";
    let inventory: Value = serde_json::from_slice(&projection.documents[inventory_path]).unwrap();
    assert_eq!(inventory["captureGaps"][0]["reason"], "links-truncated");
    assert_eq!(inventory["captureGaps"][1]["reason"], "text-truncated");
}

#[test]
fn rejects_traversal_scopes_and_raw_html() {
    let mut traversal = scope();
    traversal.folder = "classes/../outside/demo-101".into();
    assert_eq!(
        project_snapshot(&snapshot(), &[traversal]).unwrap_err(),
        ProjectionError::InvalidScope
    );

    let mut raw_html = snapshot();
    raw_html["resources"][0]["items"][0]["syllabus_body"] = json!("<script>secret()</script>");
    assert_eq!(
        project_snapshot(&raw_html, &[scope()]).unwrap_err(),
        ProjectionError::UnsafeContent
    );
}

#[test]
fn stable_local_key_can_use_a_generated_course_folder() {
    let mut course_scope = scope();
    course_scope.folder = "classes/canvas-101".into();
    let projection = project_snapshot(&snapshot(), &[course_scope]).expect("projection succeeds");
    assert_eq!(projection.coursework[0].key, "demo-101");
    assert!(projection
        .documents
        .contains_key("classes/canvas-101/canvas-export/api/course.json"));
}

#[test]
fn rejects_invalid_or_duplicate_ids() {
    let mut invalid = snapshot();
    invalid["resources"][1]["items"][0]["id"] = json!(0);
    assert_eq!(
        project_snapshot(&invalid, &[scope()]).unwrap_err(),
        ProjectionError::InvalidResource
    );

    let mut duplicate = snapshot();
    let assignment = duplicate["resources"][1]["items"][0].clone();
    duplicate["resources"][1]["items"]
        .as_array_mut()
        .unwrap()
        .push(assignment);
    assert_eq!(
        project_snapshot(&duplicate, &[scope()]).unwrap_err(),
        ProjectionError::InvalidResource
    );
}

#[test]
fn projects_current_complete_all_day_calendar_event_identity_without_display_data() {
    let mut input = snapshot();
    input["runId"] = json!(72);
    input["generationId"] = json!("a".repeat(32));
    input["resources"].as_array_mut().unwrap().push(json!({
        "endpoint": "calendarEvents",
        "courseId": 101,
        "groupId": null,
        "contextCode": "course_101",
        "items": [{
            "id": 808,
            "context_code": "course_101",
            "type": "event",
            "all_day": true,
            "start_at": "2030-01-20T00:00:00Z",
            "title": "Synthetic private event title",
            "html_url": "https://canvas.invalid/private-event"
        }]
    }));
    input["coverage"] = json!([{
        "endpoint": "calendarEvents",
        "courseId": 101,
        "groupId": null,
        "contextCode": "course_101",
        "status": "complete"
    }]);

    let projection = project_snapshot(&input, &[scope()]).expect("projection succeeds");
    let path = "classes/demo-101/canvas-export/api/calendar-event-identities.json";
    let document: Value = serde_json::from_slice(&projection.documents[path]).unwrap();
    assert_eq!(document["runId"], 72);
    assert_eq!(document["generationId"], "a".repeat(32));
    assert_eq!(document["userId"], 7001);
    assert_eq!(document["institution"], "marymount.instructure.com");
    assert_eq!(document["origin"], "https://marymount.instructure.com");
    assert_eq!(document["courseKey"], "demo-101");
    assert_eq!(document["coverage"]["status"], "complete");
    assert_eq!(document["events"].as_array().unwrap().len(), 1);
    assert_eq!(document["events"][0]["id"], "808");
    assert_eq!(document["events"][0]["uid"], "event-calendar-event-808");
    assert_eq!(document["events"][0]["startAt"], "2030-01-20T00:00:00Z");
    let serialized = String::from_utf8(projection.documents[path].clone()).unwrap();
    assert!(!serialized.contains("Synthetic private event title"));
    assert!(!serialized.contains("html_url"));

    let duplicate = input["resources"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["items"][0]
        .clone();
    input["resources"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["items"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let duplicated = project_snapshot(&input, &[scope()]).expect("projection succeeds");
    let document: Value = serde_json::from_slice(&duplicated.documents[path]).unwrap();
    assert!(document["events"].as_array().unwrap().is_empty());

    input["coverage"][0]["status"] = json!("gap");
    let incomplete = project_snapshot(&input, &[scope()]).expect("projection succeeds");
    let document: Value = serde_json::from_slice(&incomplete.documents[path]).unwrap();
    assert_eq!(document["coverage"]["status"], "unavailable");
    assert!(document["events"].as_array().unwrap().is_empty());
}
