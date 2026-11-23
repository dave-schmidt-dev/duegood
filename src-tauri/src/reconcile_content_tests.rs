use super::{reconcile_coursework, CourseAssignments};
use serde_json::json;
use std::time::{Duration, SystemTime};

#[test]
fn graded_discussion_content_and_files_survive_native_reconciliation() {
    let base = json!({
        "courses": [{"key": "demo-course"}],
        "items": [],
        "archivedForecastItems": []
    });
    let capture = CourseAssignments {
        key: "demo-course".into(),
        groups: vec![],
        assignments: vec![json!({
            "id": 5001,
            "name": "Synthetic graded discussion",
            "detail": "Topic instructions\n\n1. First\n2. Second",
            "bodyHtml": "<h2>Topic instructions</h2><ol><li>First</li><li>Second</li></ol>",
            "bodyEmpty": false,
            "assignmentDetail": "Short assignment blurb",
            "assignmentBodyHtml": "<p>Short assignment blurb</p>",
            "assignmentBodyEmpty": false,
            "discussionTopicId": 9001,
            "assignmentId": 5001,
            "submissionTypes": ["discussion_topic"],
            "require_initial_post": true,
            "attachments": [
                {"fileId": 1301, "name": "Synthetic assignment attachment.pdf"},
                {"fileId": 1302, "name": "Synthetic topic attachment.pdf"}
            ],
            "linkedFiles": [
                {"fileId": 1304, "name": "Synthetic assignment link.pdf"},
                {"fileId": 1305, "name": "Synthetic topic link.pdf"}
            ],
            "due_at": "2026-11-28T04:59:00Z",
            "posted_at": "2026-11-20T18:05:00Z"
        })],
        discussions: vec![json!({
            "id": 9002,
            "title": "Synthetic announcement",
            "detail": "Announcement body",
            "bodyHtml": "<p>Announcement body</p>",
            "bodyEmpty": false,
            "is_announcement": true,
            "attachments": [{"fileId": 1401, "name": "Synthetic announcement attachment.pdf"}],
            "linkedFiles": [{"fileId": 1402, "name": "Synthetic announcement link.pdf"}]
        })],
    };

    let result = reconcile_coursework(
        &base,
        &[capture],
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_798_000_000),
    )
    .expect("native content reconciliation");
    let items = result["items"].as_array().expect("coursework items");
    let graded = items
        .iter()
        .find(|item| item["canvasResourceType"] == "assignment")
        .expect("graded assignment item");
    assert_eq!(graded["canvasId"], 5001);
    assert_eq!(graded["assignmentId"], 5001);
    assert_eq!(graded["discussionTopicId"], 9001);
    assert_eq!(
        graded["detail"],
        "Topic instructions\n\n1. First\n2. Second"
    );
    assert_eq!(
        graded["bodyHtml"],
        "<h2>Topic instructions</h2><ol><li>First</li><li>Second</li></ol>"
    );
    assert_eq!(graded["assignmentDetail"], "Short assignment blurb");
    assert_eq!(
        graded["assignmentBodyHtml"],
        "<p>Short assignment blurb</p>"
    );
    assert_eq!(graded["requireInitialPost"], true);
    assert_eq!(graded["submissionTypes"], json!(["discussion_topic"]));
    assert_eq!(graded["attachments"][0]["fileId"], 1301);
    assert_eq!(graded["attachments"][1]["fileId"], 1302);
    assert_eq!(graded["linkedFiles"][0]["fileId"], 1304);
    assert_eq!(graded["linkedFiles"][1]["fileId"], 1305);
    assert_eq!(graded["dueAtUtc"], "2026-11-28T04:59:00Z");
    assert_eq!(graded["postedAt"], "2026-11-20T18:05:00Z");

    let announcement = items
        .iter()
        .find(|item| item["canvasId"] == 9002)
        .expect("standalone announcement");
    assert_eq!(announcement["canvasResourceType"], "discussion");
    assert_eq!(announcement["isAnnouncement"], true);
    assert_eq!(announcement["detail"], "Announcement body");
    assert_eq!(announcement["attachments"][0]["fileId"], 1401);
    assert_eq!(announcement["linkedFiles"][0]["fileId"], 1402);
}

#[test]
fn missing_joined_topic_body_preserves_the_previously_imported_prompt() {
    let base = json!({
        "courses": [{"key": "demo-course"}],
        "items": [{
            "id": "demo-course-canvas-5001",
            "course": "demo-course",
            "kind": "discussion",
            "title": "Synthetic graded discussion",
            "source": "canvas",
            "canvasResourceType": "assignment",
            "canvasId": 5001,
            "detail": "Previously imported topic body",
            "bodyHtml": "<p>Previously imported topic body</p>",
            "bodyEmpty": false,
            "done": false
        }],
        "archivedForecastItems": []
    });
    let capture = CourseAssignments {
        key: "demo-course".into(),
        groups: vec![],
        assignments: vec![json!({
            "id": 5001,
            "name": "Synthetic graded discussion",
            "assignmentId": 5001,
            "discussionTopicId": 9001,
            "assignmentDetail": "Short assignment blurb",
            "assignmentBodyHtml": "<p>Short assignment blurb</p>",
            "assignmentBodyEmpty": false
        })],
        discussions: vec![],
    };

    let result = reconcile_coursework(
        &base,
        &[capture],
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_798_000_000),
    )
    .expect("partial topic refresh");
    let item = &result["items"][0];
    assert_eq!(item["detail"], "Previously imported topic body");
    assert_eq!(item["bodyHtml"], "<p>Previously imported topic body</p>");
    assert_eq!(item["assignmentDetail"], "Short assignment blurb");
}
