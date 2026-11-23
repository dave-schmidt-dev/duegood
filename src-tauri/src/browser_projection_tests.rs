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
fn projects_assigned_and_standalone_discussion_bodies_and_joins_page_quiz_details() {
    let mut input = snapshot();
    input["resources"][1]["items"][0]["description"] = json!("Short assignment blurb");
    input["resources"][1]["items"][0]["posted_at"] = Value::Null;
    input["resources"][1]["items"][0]["_canvasBody"] = json!({
        "html": "<p>Short assignment blurb</p>",
        "text": "Short assignment blurb",
        "empty": false
    });
    input["resources"][1]["items"][0]["attachments"] =
        json!([{"id": 1301, "display_name": "Synthetic attachment.pdf"}]);
    input["resources"][1]["items"][0]["_canvasLinkedFiles"] =
        json!([{"fileId": 1304, "courseId": 101}]);
    input["resources"].as_array_mut().unwrap().extend([
        resource(
            "discussions",
            Some(101),
            json!([
                {
                    "id": 9001,
                    "title": "Synthetic graded topic",
                    "assignment_id": 5001,
                    "message": "Full discussion instructions",
                    "attachments": [{"id": 1302, "display_name": "Synthetic topic attachment.pdf"}],
                    "_canvasLinkedFiles": [{"fileId": 1305, "courseId": 101}],
                    "_canvasBody": {
                        "html": "<h2>Instructions</h2><ol><li>First</li></ol>",
                        "text": "Instructions\n\n1. First",
                        "empty": false
                    },
                    "posted_at": "2026-11-20T18:05:00Z",
                    "delayed_post_at": "2026-11-20T18:05:00Z",
                    "require_initial_post": true
                },
                {
                    "id": 9002,
                    "title": "Synthetic ungraded topic",
                    "assignment_id": null,
                    "message": "Scheduled topic body",
                    "_canvasBody": {
                        "html": "<p>Scheduled topic body</p>",
                        "text": "Scheduled topic body",
                        "empty": false
                    },
                    "delayed_post_at": "2030-01-01T12:00:00Z"
                }
            ]),
        ),
        resource(
            "announcements",
            Some(101),
            json!([
                {
                    "id": 9002,
                    "title": "Synthetic ungraded topic",
                    "message": "Announcement copy of scheduled topic"
                },
                {
                    "id": 9003,
                    "title": "Synthetic course announcement",
                    "message": "Course announcement body",
                    "_canvasBody": {
                        "html": "<p>Course announcement body</p>",
                        "text": "Course announcement body",
                        "empty": false
                    },
                    "posted_at": "2026-11-21T12:00:00Z"
                }
            ]),
        ),
        resource(
            "pages",
            Some(101),
            json!([{"page_id": 7001, "title": "Synthetic page", "url": "synthetic-page"}]),
        ),
        resource(
            "page",
            Some(101),
            json!([{
                "page_id": 7001,
                "course_id": 101,
                "title": "Synthetic page",
                "body": "Example code <p> stays text",
                "_canvasBody": {
                    "html": "<h2>Page heading</h2><p>Example code &lt;p&gt; stays text</p>",
                    "text": "Page heading\n\nExample code <p> stays text",
                    "empty": false
                },
                "updated_at": "2026-11-19T12:00:00Z"
            }]),
        ),
        resource(
            "quizzes",
            Some(101),
            json!([{"id": 8001, "title": "Synthetic quiz"}]),
        ),
        resource(
            "quiz",
            Some(101),
            json!([{
                "id": 8001,
                "course_id": 101,
                "title": "Synthetic quiz",
                "description": "Quiz instructions",
                "_canvasBody": {
                    "html": "<p>Quiz instructions</p>",
                    "text": "Quiz instructions",
                    "empty": false
                },
                "unlock_at": "2026-11-21T12:00:00Z"
            }]),
        ),
    ]);

    let projection = project_snapshot(&input, &[scope()]).expect("content projection succeeds");
    let assignments = &projection.coursework[0].assignments;
    let graded = assignments
        .iter()
        .find(|assignment| assignment["id"] == 5001)
        .expect("graded assignment");
    assert_eq!(graded["detail"], "Instructions\n\n1. First");
    assert_eq!(
        graded["bodyHtml"],
        "<h2>Instructions</h2><ol><li>First</li></ol>"
    );
    assert_eq!(graded["assignmentDetail"], "Short assignment blurb");
    assert_eq!(graded["discussionTopicId"], 9001);
    assert_eq!(graded["attachments"][0]["fileId"], 1301);
    assert_eq!(graded["attachments"][0]["name"], "Synthetic attachment.pdf");
    assert_eq!(graded["attachments"][1]["fileId"], 1302);
    assert_eq!(
        graded["attachments"][1]["name"],
        "Synthetic topic attachment.pdf"
    );
    assert_eq!(graded["linkedFiles"][0]["fileId"], 1304);
    assert_eq!(graded["linkedFiles"][1]["fileId"], 1305);
    assert_eq!(graded["require_initial_post"], true);
    assert_eq!(graded["posted_at"], "2026-11-20T18:05:00Z");
    assert_eq!(graded["delayed_post_at"], "2026-11-20T18:05:00Z");

    let standalone = &projection.coursework[0].discussions;
    assert_eq!(standalone.len(), 2);
    let scheduled = standalone
        .iter()
        .find(|topic| topic["id"] == 9002)
        .expect("scheduled discussion deduplicated with announcement");
    assert_eq!(scheduled["detail"], "Scheduled topic body");
    assert_eq!(scheduled["delayed_post_at"], "2030-01-01T12:00:00Z");
    assert_eq!(scheduled["is_announcement"], true);
    let announcement = standalone
        .iter()
        .find(|topic| topic["id"] == 9003)
        .expect("course announcement is projected as a topic");
    assert_eq!(announcement["detail"], "Course announcement body");
    assert_eq!(announcement["posted_at"], "2026-11-21T12:00:00Z");
    assert_eq!(announcement["is_announcement"], true);
    let base = "classes/demo-101/canvas-export/api";
    let pages: Value =
        serde_json::from_slice(&projection.documents[&format!("{base}/pages.json")]).unwrap();
    assert_eq!(
        pages[0]["detail"],
        "Page heading\n\nExample code <p> stays text"
    );
    assert_eq!(
        pages[0]["bodyHtml"],
        "<h2>Page heading</h2><p>Example code &lt;p&gt; stays text</p>"
    );
    assert_eq!(pages[0]["updated_at"], "2026-11-19T12:00:00Z");
    let quizzes: Value =
        serde_json::from_slice(&projection.documents[&format!("{base}/quizzes.json")]).unwrap();
    assert_eq!(quizzes[0]["detail"], "Quiz instructions");
    assert_eq!(quizzes[0]["bodyHtml"], "<p>Quiz instructions</p>");
    assert_eq!(quizzes[0]["unlock_at"], "2026-11-21T12:00:00Z");

    let discussions_index = input["resources"]
        .as_array()
        .unwrap()
        .iter()
        .position(|resource| resource["endpoint"] == "discussions")
        .unwrap();
    let mut known_empty_input = input.clone();
    known_empty_input["resources"][discussions_index]["items"][0]["_canvasBody"] = json!({
        "html": "",
        "text": "",
        "empty": true
    });
    let known_empty = project_snapshot(&known_empty_input, &[scope()]).unwrap();
    let known_empty_topic = known_empty.coursework[0]
        .assignments
        .iter()
        .find(|assignment| assignment["id"] == 5001)
        .unwrap();
    assert_eq!(known_empty_topic["detail"], "");
    assert_eq!(known_empty_topic["bodyHtml"], "");
    assert_eq!(known_empty_topic["bodyEmpty"], true);

    let mut missing_topic_input = input;
    missing_topic_input["resources"][discussions_index]["items"][0]
        .as_object_mut()
        .unwrap()
        .remove("_canvasBody");
    missing_topic_input["resources"][discussions_index]["items"][0]["_canvasBodyReason"] =
        json!("BODY_MISSING");
    let missing_topic = project_snapshot(&missing_topic_input, &[scope()]).unwrap();
    let missing_topic_assignment = missing_topic.coursework[0]
        .assignments
        .iter()
        .find(|assignment| assignment["id"] == 5001)
        .unwrap();
    assert!(missing_topic_assignment.get("detail").is_none());
    assert!(missing_topic_assignment.get("bodyHtml").is_none());
    assert_eq!(
        missing_topic_assignment["assignmentDetail"],
        "Short assignment blurb"
    );
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
fn projects_individually_fetched_files_when_the_course_files_listing_is_unavailable() {
    let mut input = snapshot();
    input["runId"] = json!(44);
    input["resources"].as_array_mut().unwrap().extend([
        resource("file", Some(101), json!([{
            "id": 9902,
            "display_name": "Linked handout.pdf",
            "filename": "linked-handout.pdf",
            "size": 27,
            "url": "https://marymount.instructure.com/files/9902/download?verifier=synthetic-file-secret"
        }])),
        resource("fileBodies", None, json!([{
            "fileId": 9902,
            "status": "archived",
            "byteCount": 27,
            "sha256": "b".repeat(64),
            "contentType": "application/pdf",
            "sourceAuthenticity": "unverified"
        }]))
    ]);

    let documents = decoded_documents(&input);
    let files = &documents.0["classes/demo-101/canvas-export/api/files.json"];
    assert_eq!(files.as_array().unwrap().len(), 1);
    assert_eq!(files[0]["id"], 9902);
    assert_eq!(files[0]["url"], Value::Null);
    assert_eq!(files[0]["linkedCaptureRunId"], 44);
    let manifest = &documents.0["classes/demo-101/canvas-export/download-manifest.json"];
    assert_eq!(manifest.as_array().unwrap().len(), 1);
    assert_eq!(manifest[0]["fileId"], 9902);
    assert_eq!(manifest[0]["status"], "saved");
    let serialized = serde_json::to_string(&documents.0).unwrap();
    assert!(!serialized.contains("synthetic-file-secret"));
}

#[test]
fn deduplicates_a_linked_file_already_present_in_the_course_files_listing() {
    let mut input = snapshot();
    input["runId"] = json!(45);
    let file = json!({
        "id": 9903,
        "display_name": "Shared handout.pdf",
        "filename": "shared-handout.pdf",
        "size": 27,
        "url": "https://marymount.instructure.com/files/9903/download"
    });
    input["resources"].as_array_mut().unwrap().extend([
        resource("courseFiles", Some(101), json!([file.clone()])),
        resource("file", Some(101), json!([file.clone()])),
        resource("file", Some(101), json!([file])),
        resource(
            "fileBodies",
            None,
            json!([{
                "fileId": 9903,
                "status": "archived",
                "byteCount": 27,
                "sha256": "c".repeat(64),
                "contentType": "application/pdf",
                "sourceAuthenticity": "unverified"
            }]),
        ),
    ]);

    let documents = decoded_documents(&input);
    let files = &documents.0["classes/demo-101/canvas-export/api/files.json"];
    assert_eq!(files.as_array().unwrap().len(), 1);
    assert_eq!(files[0]["id"], 9903);
    assert_eq!(files[0]["display_name"], "Shared handout.pdf");
    let manifest = &documents.0["classes/demo-101/canvas-export/download-manifest.json"];
    assert_eq!(manifest.as_array().unwrap().len(), 1);
    assert_eq!(manifest[0]["fileId"], 9903);
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
fn unread_optional_endpoints_are_not_published_as_empty_documents() {
    // INV-4: a gapped optional endpoint must leave the retained document untouched.
    let mut input = snapshot();
    let base = "classes/demo-101/canvas-export";
    let without = project_snapshot(&input, &[scope()]).expect("projection succeeds");
    for name in [
        "pages",
        "modules",
        "announcements",
        "files",
        "tabs",
        "discussions",
        "folders",
    ] {
        assert!(
            !without
                .documents
                .contains_key(&format!("{base}/api/{name}.json")),
            "{name} must not be emitted when its endpoint was not read"
        );
    }
    assert!(!without
        .documents
        .contains_key(&format!("{base}/download-manifest.json")));
    assert!(without
        .documents
        .contains_key(&format!("{base}/api/assignments.json")));

    input["resources"]
        .as_array_mut()
        .unwrap()
        .push(resource("pages", Some(101), json!([])));
    let with = project_snapshot(&input, &[scope()]).expect("projection succeeds");
    // A page list that was read and is genuinely empty is still published.
    assert_eq!(
        serde_json::from_slice::<Value>(&with.documents[&format!("{base}/api/pages.json")])
            .unwrap(),
        json!([])
    );
    assert!(!with
        .documents
        .contains_key(&format!("{base}/api/modules.json")));
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

#[test]
fn promotes_group_topics_only_for_a_course_proved_by_group_metadata() {
    let mut input = snapshot();
    input["resources"].as_array_mut().unwrap().extend([
        json!({
            "endpoint": "groups",
            "courseId": null,
            "items": [
                {"id": 77, "course_id": 101},
                {"id": 88, "course_id": 202}
            ]
        }),
        json!({
            "endpoint": "discussions",
            "courseId": null,
            "groupId": 77,
            "items": [{
                "id": 9101,
                "title": "Synthetic group topic",
                "group_id": 77,
                "message": "Group topic body",
                "_canvasBody": {
                    "html": "<p>Group topic body</p>",
                    "text": "Group topic body",
                    "empty": false
                }
            }]
        }),
        json!({
            "endpoint": "announcements",
            "courseId": null,
            "groupId": 77,
            "items": [{
                "id": 9102,
                "title": "Synthetic group announcement",
                "group_id": 77,
                "message": "Group announcement body",
                "_canvasBody": {
                    "html": "<p>Group announcement body</p>",
                    "text": "Group announcement body",
                    "empty": false
                }
            }]
        }),
        json!({
            "endpoint": "discussions",
            "courseId": null,
            "groupId": 88,
            "items": [{"id": 9103, "title": "Other course topic", "group_id": 88}]
        }),
    ]);

    let projection = project_snapshot(&input, &[scope()]).expect("projection succeeds");
    let topics = &projection.coursework[0].discussions;
    assert_eq!(topics.len(), 2);
    let topic = topics.iter().find(|item| item["id"] == 9101).unwrap();
    assert_eq!(topic["detail"], "Group topic body");
    let announcement = topics.iter().find(|item| item["id"] == 9102).unwrap();
    assert_eq!(announcement["detail"], "Group announcement body");
    assert_eq!(announcement["is_announcement"], true);
    assert!(topics.iter().all(|item| item["id"] != 9103));
}
