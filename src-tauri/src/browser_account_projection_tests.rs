use serde_json::{json, Value};

use super::{project_account_documents, BrowserAccountProjectionError as Error};

const PROFILE: &str = "canvas-profile.json";
const INBOX: &str = "canvas-conversations.json";

fn coverage(endpoint: &str, status: &str) -> Value {
    json!({"endpoint":endpoint,"courseId":null,"status":status})
}

fn account_snapshot() -> Value {
    let summary = json!({
        "id":301,"subject":"Synthetic thread","context_name":"SYN-101",
        "last_message":"A short preview","last_message_at":"2026-09-26T13:00:00Z",
        "workflow_state":"unread","starred":true,"message_count":1,
        "_canvasLinks":[],"_canvasRawUrls":["https://canvas.invalid/private?token=raw-secret"]
    });
    json!({
        "schemaVersion":2,"source":"canvas-browser","capturedAt":"2026-09-27T12:00:00Z",
        "identity":{"origin":"https://marymount.instructure.com","userId":41},
        "resources":[
            {"endpoint":"profile","courseId":null,"pages":1,"items":[{
                "id":41,"name":"Synthetic Student","short_name":"Student","avatar_url":null,
                "_canvasLinks":[{"source":"profile/avatar_url","title":"Avatar","asciiHostname":"canvas.invalid",
                    "safeTarget":"https://canvas.invalid/avatar?token=signed-secret","clickable":true}],
                "_canvasRawUrls":["https://canvas.invalid/avatar?token=raw-secret"]
            }]},
            {"endpoint":"inbox","courseId":null,"pages":1,"items":[summary.clone()]},
            {"endpoint":"inboxAll","courseId":null,"pages":1,"items":[summary.clone()]},
            {"endpoint":"conversationsSent","courseId":null,"pages":1,"items":[]},
            {"endpoint":"conversationsArchived","courseId":null,"pages":1,"items":[]},
            {"endpoint":"conversation","courseId":null,"pages":1,"items":[{
                "id":301,"subject":"Synthetic thread","context_name":"SYN-101",
                "workflow_state":"read","starred":true,"message_count":1,
                "participants":[{"id":7,"name":"Synthetic participant"}],
                "messages":[{"id":9001,"author_id":7,"author_name":"Synthetic participant",
                    "created_at":"2026-09-26T13:00:00Z","body":"The handout is ready. cookie=private-cookie-value",
                    "attachments":[{"display_name":"Synthetic file.pdf","content-type":"application/pdf","size":128}]}],
                "_canvasLinks":[{"source":"conversation/301/messages/0/body","title":"Reference",
                    "asciiHostname":"example.invalid","safeTarget":"https://example.invalid/reference?X-Amz-Signature=signed-secret",
                    "clickable":true}],
                "_canvasRawUrls":["https://example.invalid/reference?token=raw-secret"]
            }]}
        ],
        "coverage":[
            coverage("profile","complete"),coverage("inbox","complete"),coverage("inboxAll","complete"),
            coverage("conversationsSent","complete"),coverage("conversationsArchived","complete"),
            coverage("conversation","complete")
        ]
    })
}

fn document(documents: &std::collections::BTreeMap<String, Vec<u8>>, path: &str) -> Value {
    serde_json::from_slice(documents.get(path).expect("fixed document")).expect("valid JSON")
}

#[test]
fn projects_actual_producer_shape_into_legacy_profile_and_inbox_documents() {
    let documents = project_account_documents(&account_snapshot()).expect("project snapshot");
    assert_eq!(
        documents.keys().map(String::as_str).collect::<Vec<_>>(),
        [INBOX, PROFILE]
    );

    let profile = document(&documents, PROFILE);
    assert_eq!(
        profile,
        json!({"name":"Synthetic Student","short_name":"Student","avatar":null})
    );

    let inbox = document(&documents, INBOX);
    assert_eq!(inbox["schema"], 1);
    assert_eq!(inbox["complete"], true);
    assert_eq!(inbox["conversations"][0]["canvasConversationId"], "301");
    assert_eq!(inbox["conversations"][0]["unread"], true);
    assert_eq!(inbox["conversations"][0]["workflowState"], "unread");
    assert_eq!(
        inbox["conversations"][0]["participants"][0]["canvasUserId"],
        "7"
    );
    assert_eq!(
        inbox["conversations"][0]["messages"][0]["canvasMessageId"],
        "9001"
    );
    assert_eq!(
        inbox["conversations"][0]["attachments"][0]["name"],
        "Synthetic file.pdf"
    );
    assert_eq!(inbox["conversations"][0]["links"][0]["clickable"], false);
    assert_eq!(
        inbox["conversations"][0]["links"][0]["safeTarget"],
        "https://example.invalid/reference"
    );
    let output = String::from_utf8(documents[INBOX].clone()).expect("UTF-8 JSON");
    for private_value in [
        "signed-secret",
        "raw-secret",
        "private-cookie-value",
        "_canvasRawUrls",
        "X-Amz-Signature",
        "avatar_url",
    ] {
        assert!(
            !output.contains(private_value),
            "private marker survived: {private_value}"
        );
    }
}

#[test]
fn scoped_calendar_rows_do_not_change_profile_or_inbox_documents() {
    let mut snapshot = account_snapshot();
    let expected = project_account_documents(&snapshot).expect("baseline account documents");
    for row in [
        json!({"endpoint":"calendarEvents","courseId":null,"contextCode":"user_41","status":"complete"}),
        json!({"endpoint":"calendarEvents","courseId":101,"contextCode":"course_101","status":"gap","reason":"forbidden-optional"}),
        json!({"endpoint":"calendarEvents","courseId":null,"groupId":900,"contextCode":"group_900","status":"incomplete","reason":"pagination-budget"}),
    ] {
        snapshot["coverage"]
            .as_array_mut()
            .unwrap()
            .push(row.clone());
        let mut resource = row;
        let object = resource.as_object_mut().unwrap();
        object.remove("status");
        object.remove("reason");
        object.insert("pages".to_owned(), json!(1));
        object.insert("items".to_owned(), json!([]));
        snapshot["resources"].as_array_mut().unwrap().push(resource);
    }
    let documents =
        project_account_documents(&snapshot).expect("calendar contexts are independent");
    assert_eq!(documents, expected);
    assert_eq!(
        documents.keys().map(String::as_str).collect::<Vec<_>>(),
        [INBOX, PROFILE]
    );
}

#[test]
fn missing_profile_or_required_list_coverage_omits_replacement_documents() {
    let mut snapshot = account_snapshot();
    snapshot["coverage"]
        .as_array_mut()
        .expect("coverage")
        .retain(|row| row["endpoint"] != "profile" && row["endpoint"] != "inboxAll");
    let documents = project_account_documents(&snapshot).expect("partial snapshot is projectable");
    assert!(!documents.contains_key(PROFILE));
    assert!(!documents.contains_key(INBOX));

    let mut missing_resource = account_snapshot();
    missing_resource["resources"]
        .as_array_mut()
        .expect("resources")
        .retain(|row| row["endpoint"] != "inboxAll");
    let documents =
        project_account_documents(&missing_resource).expect("missing list is projectable");
    assert!(!documents.contains_key(INBOX));
}

#[test]
fn a_gap_in_a_required_inbox_list_omits_the_inbox_document() {
    for status in ["gap", "incomplete"] {
        let mut snapshot = account_snapshot();
        let row = snapshot["coverage"]
            .as_array_mut()
            .expect("coverage")
            .iter_mut()
            .find(|row| row["endpoint"] == "inboxAll")
            .expect("inboxAll coverage");
        row["status"] = Value::from(status);
        let documents = project_account_documents(&snapshot).expect("partial snapshot is projectable");
        assert!(documents.contains_key(PROFILE));
        assert!(!documents.contains_key(INBOX));
    }
}

#[test]
fn incomplete_expected_conversation_detail_is_kept_as_an_incomplete_inbox() {
    let mut snapshot = account_snapshot();
    let row = snapshot["coverage"]
        .as_array_mut()
        .expect("coverage")
        .iter_mut()
        .find(|row| row["endpoint"] == "conversation")
        .expect("conversation coverage");
    row["status"] = Value::from("incomplete");

    let documents = project_account_documents(&snapshot).expect("partial inbox remains projectable");
    let inbox = document(&documents, INBOX);
    assert_eq!(inbox["complete"], false);
    assert_eq!(inbox["rejected"], 1);
    assert_eq!(inbox["conversations"][0]["historyComplete"], true);
}

#[test]
fn duplicate_coverage_and_duplicate_conversation_details_are_rejected() {
    let mut duplicate_coverage = account_snapshot();
    duplicate_coverage["coverage"]
        .as_array_mut()
        .expect("coverage")
        .push(coverage("inbox", "complete"));
    assert_eq!(
        project_account_documents(&duplicate_coverage),
        Err(Error::DuplicateCoverage)
    );

    let mut duplicate_detail = account_snapshot();
    let detail = duplicate_detail["resources"]
        .as_array()
        .expect("resources")
        .iter()
        .find(|row| row["endpoint"] == "conversation")
        .expect("detail")
        .clone();
    duplicate_detail["resources"]
        .as_array_mut()
        .expect("resources")
        .push(detail);
    assert_eq!(
        project_account_documents(&duplicate_detail),
        Err(Error::DuplicateResource)
    );
}

#[test]
fn missing_detail_is_partial_and_never_marked_synced() {
    let mut snapshot = account_snapshot();
    snapshot["resources"]
        .as_array_mut()
        .expect("resources")
        .retain(|row| row["endpoint"] != "conversation");
    let coverage_row = snapshot["coverage"]
        .as_array_mut()
        .expect("coverage")
        .iter_mut()
        .find(|row| row["endpoint"] == "conversation")
        .expect("detail coverage");
    coverage_row["status"] = Value::from("gap");

    let documents = project_account_documents(&snapshot).expect("partial detail snapshot");
    let inbox = document(&documents, INBOX);
    assert_eq!(inbox["complete"], false);
    assert_eq!(inbox["rejected"], 1);
    assert_eq!(inbox["conversations"][0]["historyComplete"], false);
    assert_eq!(inbox["conversations"][0]["unread"], true);
}

#[test]
fn profile_identity_must_match_the_numeric_snapshot_identity() {
    let mut snapshot = account_snapshot();
    snapshot["resources"][0]["items"][0]["id"] = Value::from(42);
    assert_eq!(
        project_account_documents(&snapshot),
        Err(Error::IdentityMismatch)
    );
}

#[test]
fn raw_html_and_missing_workflow_state_are_not_projected() {
    let mut html = account_snapshot();
    html["resources"][5]["items"][0]["messages"][0]["body"] =
        Value::from("<script>private()</script>");
    assert_eq!(project_account_documents(&html), Err(Error::UnsafeContent));

    let mut missing_state = account_snapshot();
    missing_state["resources"][1]["items"][0]
        .as_object_mut()
        .expect("summary")
        .remove("workflow_state");
    assert_eq!(
        project_account_documents(&missing_state),
        Err(Error::InvalidResource)
    );
}

#[test]
fn oversized_message_is_bounded_and_marks_the_document_partial() {
    let mut snapshot = account_snapshot();
    snapshot["resources"][5]["items"][0]["messages"][0]["body"] = Value::String("x".repeat(70_000));
    let documents = project_account_documents(&snapshot).expect("bounded projection");
    let inbox = document(&documents, INBOX);
    assert_eq!(inbox["complete"], false);
    assert_eq!(
        inbox["conversations"][0]["messages"][0]["body"]
            .as_str()
            .expect("body")
            .len(),
        64 * 1024
    );
    assert_eq!(
        inbox["conversations"][0]["messages"][0]["bodyTruncated"],
        true
    );
}
