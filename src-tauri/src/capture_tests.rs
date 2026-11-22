use super::*;

#[test]
fn linked_file_ids_include_attachments_and_safe_canvas_links_once() {
    let input = json!({
        "attachments": [{"id": 501}, {"file_id": "502"}, {"id": 501}],
        "attachment": {"id": 503},
        "body": "<a href=\"https://marymount.instructure.com/courses/77/files/504/download?wrap=1\">file</a> \
                 <a href=\"https://other.invalid/courses/77/files/505/download\">external</a> \
                 <a href=\"//other.invalid/files/506\">external relative</a> \
                 <a href=\"/courses/78/files/507\">other course</a>",
        "html_url": "/files/508/preview",
        "_canvasLinks": [{
            "safeTarget": "https://marymount.instructure.com/courses/77/files/510"
        }],
        "unrelated_text": "Canvas path /files/509 must not be interpreted as a link"
    });

    let ids = collect_linked_file_ids(&input, 77, "https://marymount.instructure.com/courses/77")
        .expect("bounded file reference scan");

    assert_eq!(ids, BTreeSet::from([501, 502, 503, 504, 508, 510]));
}

#[test]
fn direct_assignment_rubrics_are_projected_and_rich_html_is_removed() {
    let projected = project_endpoint(
        "assignments",
        &json!({
            "id": 501,
            "rubric": [{
                "id": "criterion-1",
                "description": "<p>Evidence</p>",
                "long_description": "<p>Use <strong>one source</strong>.</p>",
                "points": 5,
                "ratings": [{
                    "description": "Strong",
                    "long_description": "<p>Clear support.</p>",
                    "points": 5,
                    "unknown": "drop"
                }],
                "unknown": "drop"
            }],
            "rubric_settings": {
                "title": "Evidence rubric",
                "points_possible": 5,
                "free_form_criterion_comments": true,
                "unknown": "drop"
            },
            "use_rubric_for_grading": true,
            "unknown": "drop"
        }),
    )
    .expect("valid direct assignment projection");

    assert_eq!(projected["rubric"][0]["description"], "Evidence");
    assert_eq!(
        projected["rubric"][0]["long_description"],
        "Use one source."
    );
    assert_eq!(
        projected["rubric"][0]["ratings"][0]["long_description"],
        "Clear support."
    );
    assert!(projected["rubric"][0].get("unknown").is_none());
    assert!(projected.get("unknown").is_none());
    assert!(!projected.to_string().contains('<'));

    let absent = project_endpoint("assignments", &json!({ "id": 502 }))
        .expect("assignment without a rubric");
    assert_eq!(absent["rubric"], Value::Null);
}

#[test]
fn graded_discussion_rubrics_join_to_canonical_assignments() {
    let mut canonical = project_endpoint(
        "assignments",
        &json!({
            "id": 501,
            "rubric": null,
            "rubric_settings": null,
            "use_rubric_for_grading": null
        }),
    )
    .expect("canonical assignment");
    let mut topic = project_endpoint(
        "discussions",
        &json!({
            "id": 601,
            "assignment_id": 501,
            "assignment": {
                "id": 501,
                "rubric": [{
                    "id": "discussion-criterion",
                    "description": "<p>Participation</p>",
                    "long_description": "<p>Contribute constructively.</p>",
                    "points": 4,
                    "ratings": [{
                        "description": "Strong",
                        "long_description": "<p>Clear</p>",
                        "points": 4
                    }]
                }],
                "rubric_settings": { "title": "Discussion rubric", "points_possible": 4 },
                "use_rubric_for_grading": true
            }
        }),
    )
    .expect("graded discussion projection");
    let indices = index_assignments_by_id(std::slice::from_ref(&canonical)).unwrap();
    hydrate_discussion_assignment_rubric(
        &mut topic,
        std::slice::from_mut(&mut canonical),
        &indices,
    )
    .expect("canonical join with nested fallback");

    assert_eq!(canonical["rubric"][0]["description"], "Participation");
    assert_eq!(canonical["rubric_settings"]["title"], "Discussion rubric");
    assert_eq!(canonical["use_rubric_for_grading"], true);
    assert_eq!(topic["assignment"]["rubric"], canonical["rubric"]);
    assert_eq!(
        topic["assignment"]["rubric_settings"],
        canonical["rubric_settings"]
    );
    assert!(!topic.to_string().contains('<'));

    let mut null_assignment = project_endpoint(
        "discussions",
        &json!({ "id": 602, "assignment_id": 501, "assignment": null }),
    )
    .expect("topic with a separate assignment ID");
    hydrate_discussion_assignment_rubric(
        &mut null_assignment,
        std::slice::from_mut(&mut canonical),
        &indices,
    )
    .expect("null nested assignment is hydrated");
    assert_eq!(null_assignment["assignment"]["id"], 501);
    assert_eq!(null_assignment["assignment"]["rubric"], canonical["rubric"]);

    let mut mismatched = project_endpoint(
        "discussions",
        &json!({ "id": 603, "assignment_id": 501, "assignment": { "id": 999 } }),
    )
    .expect("mismatched topic projection");
    assert!(hydrate_discussion_assignment_rubric(
        &mut mismatched,
        std::slice::from_mut(&mut canonical),
        &indices,
    )
    .is_err());
    let mut missing = project_endpoint(
        "discussions",
        &json!({ "id": 604, "assignment_id": 999, "assignment": null }),
    )
    .expect("unmatched topic projection");
    assert!(
        hydrate_discussion_assignment_rubric(&mut missing, &mut [canonical], &indices).is_err()
    );
}

#[test]
fn linked_file_detail_plan_deduplicates_listed_ids_and_caps_extra_reads() {
    let linked = (1..=502).collect::<BTreeSet<_>>();
    let listed = BTreeSet::from([1]);

    let (to_read, over_budget) = linked_file_detail_plan(&linked, &listed);

    assert_eq!(to_read.len(), MAX_LINKED_FILE_DETAILS);
    assert!(!to_read.contains(&1));
    assert_eq!(over_budget, [502]);
}

#[test]
fn credential_redaction_and_url_query_removal() {
    assert_eq!(
        redact("token=secret access_token=also-secret"),
        "token=[redacted] access_token=[redacted]"
    );
    assert_eq!(
        strip_query("https://example.invalid/path?token=secret#frag"),
        "https://example.invalid/path"
    );
}

#[test]
fn signed_download_query_is_used_in_memory_but_never_projected() {
    #[cfg(feature = "test-overrides")]
    let (origin, listener) = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let origin = format!("http://{}", listener.local_addr().expect("mock address"));
        (origin, listener)
    };
    #[cfg(feature = "test-overrides")]
    let download_url = format!("{origin}/files/501/download?verifier=synthetic-secret");
    #[cfg(not(feature = "test-overrides"))]
    let download_url =
        "https://canvas.example.invalid/files/501/download?verifier=synthetic-secret";
    let raw = json!({
        "id": 501,
        "display_name": "notes.pdf",
        "filename": "notes.pdf",
        "size": 4,
        "url": download_url
    });
    assert!(raw_file_download_url(&raw).is_some_and(|url| url.contains("?verifier=")));
    let projected = project_endpoint("files", &raw).expect("safe file projection");
    assert!(projected
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|url| !url.contains('?')));
    assert!(
        !serde_json::to_string(&projected)
            .expect("serialize projection")
            .contains("synthetic-secret"),
        "projection retained a verifier"
    );

    #[cfg(feature = "test-overrides")]
    {
        use std::io::{BufRead, BufReader, Write};

        let (tx, rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept download");
            let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).expect("read request");
                request.push_str(&line);
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            tx.send(request).expect("send captured request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfile")
                .expect("write response");
        });

        let client = DownloadClient::with_test_origin(&origin).expect("download client");
        let response = client
            .download_file(raw_file_download_url(&raw).expect("raw download URL"))
            .expect("download file");
        assert_eq!(response.bytes, b"file");
        let request = rx.recv().expect("download request");
        assert!(
            request.starts_with("GET /files/501/download?verifier=synthetic-secret HTTP/1.1"),
            "signed verifier missing from GET"
        );
        server.join().expect("mock server");
    }
}

#[test]
fn canvas_url_scheme_is_correct_for_build() {
    #[cfg(feature = "test-overrides")]
    {
        assert!(allowed_canvas_url("http://127.0.0.1:3030/api/v1/courses"));
        assert!(!allowed_canvas_url(
            "http://example.invalid:3030/api/v1/courses"
        ));
        assert!(!allowed_canvas_url("http://127.0.0.1/api/v1/courses"));
        assert!(!allowed_canvas_url(
            "http://user@127.0.0.1:3030/api/v1/courses"
        ));
    }
    #[cfg(not(feature = "test-overrides"))]
    {
        assert!(!allowed_canvas_url("http://127.0.0.1:3030/api/v1/courses"));
        assert!(allowed_canvas_url(
            "https://canvas.example.invalid/api/v1/courses"
        ));
    }
}

#[test]
fn inbox_rejects_truncated_message_histories() {
    let too_many = json!({
        "id": 77001,
        "subject": "Synthetic thread",
        "workflow_state": "read",
        "message_count": (MAX_MESSAGES + 1),
        "participants": [],
        "messages": vec![json!({"body":"complete"}); MAX_MESSAGES + 1]
    });
    assert!(normalize_conversation(&too_many).is_none());

    let oversized = json!({
        "id": 77002,
        "subject": "Synthetic thread",
        "workflow_state": "read",
        "message_count": 1,
        "participants": [],
        "messages": [{"body":"x".repeat(MAX_MESSAGE_BYTES + 1)}]
    });
    assert!(normalize_conversation(&oversized).is_none());
}

#[test]
fn inbox_detail_failures_fall_back_and_do_not_remove_prior_threads() {
    fn detail(id: &str) -> Value {
        json!({
            "id": id,
            "subject": "Current detail",
            "context_name": "Demo course",
            "workflow_state": "read",
            "starred": false,
            "message_count": 1,
            "participants": [],
            "messages": [{
                "id": format!("{id}-message"),
                "author_id": "9500",
                "author_name": "Synthetic instructor",
                "created_at": "2026-11-25T16:30:00Z",
                "body": "Full later-thread detail",
                "attachments": []
            }]
        })
    }

    let previous = json!({
        "conversations": [
            {
                "canvasConversationId": "77001",
                "contextLabel": "Demo course",
                "subject": "Prior thread",
                "latestMessagePreview": "Prior preview",
                "latestMessageAt": "2026-11-25T15:00:00.000Z",
                "unread": true,
                "starred": false,
                "messageCount": 2,
                "participants": [{"canvasUserId":"9500","name":"Synthetic instructor"}],
                "messages": [{
                    "canvasMessageId":"77001-prior",
                    "authorId":"9500",
                    "author":"Synthetic instructor",
                    "createdAt":"2026-11-25T15:00:00.000Z",
                    "body":"Preserved prior detail",
                    "bodyTruncated":false,
                    "attachments":[]
                }],
                "historyComplete":true,
                "safetyTruncated":false,
                "attachments":[]
            },
            {
                "canvasConversationId":"77999",
                "contextLabel":"Demo course",
                "subject":"Prior removed candidate",
                "latestMessagePreview":"Old",
                "latestMessageAt":"2026-11-20T15:00:00.000Z",
                "unread":false,
                "starred":false,
                "messageCount":0,
                "participants":[],
                "messages":[],
                "historyComplete":true,
                "safetyTruncated":false,
                "attachments":[]
            }
        ]
    });
    let summaries = vec![
        json!({
            "id":"77001","subject":"Current summary","context_name":"Demo course",
            "last_message":"<p>Summary access_token=synthetic-private</p>",
            "last_message_at":"2026-11-26T15:00:00Z","workflow_state":"unread",
            "starred":true,"message_count":2
        }),
        json!({
            "id":"77002","subject":"Later thread","context_name":"Demo course",
            "last_message":"Later preview","last_message_at":"2026-11-25T14:00:00Z",
            "workflow_state":"read","starred":false,"message_count":1
        }),
        json!({
            "id":"77003","subject":"Oversized thread","context_name":"Demo course",
            "last_message":"Oversized preview","last_message_at":"2026-11-24T14:00:00Z",
            "workflow_state":"read","starred":false,"message_count":1
        }),
        json!({
            "id":"77004","subject":"Truncated thread","context_name":"Demo course",
            "last_message":"Truncated preview","last_message_at":"2026-11-23T14:00:00Z",
            "workflow_state":"read","starred":false,"message_count":MAX_MESSAGES + 1
        }),
    ];
    let mut fetched = Vec::new();
    let inbox = capture_inbox_from_summaries(summaries, Some(&previous), |id| {
        fetched.push(id.to_owned());
        match id {
            "77001" => Err(CaptureError::CanvasRequest),
            "77002" => Ok(detail(id)),
            "77003" => Ok(json!({
                "id":id,"subject":"Oversized thread","workflow_state":"read",
                "message_count":1,"participants":[],
                "messages":[{"body":"x".repeat(MAX_MESSAGE_BYTES + 1)}]
            })),
            "77004" => Ok(json!({
                "id":id,"subject":"Truncated thread","workflow_state":"read",
                "message_count":MAX_MESSAGES + 1,"participants":[],
                "messages":vec![json!({"body":"partial"}); MAX_MESSAGES + 1]
            })),
            _ => Err(CaptureError::InvalidCanvasResponse),
        }
    })
    .expect("partial inbox is represented, not aborted");

    assert_eq!(fetched, ["77001", "77002", "77003", "77004"]);
    assert_eq!(inbox.get("complete").and_then(Value::as_bool), Some(false));
    assert_eq!(inbox.get("rejected").and_then(Value::as_u64), Some(3));
    assert_eq!(
        inbox
            .pointer("/changes/removed")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(0)
    );
    let rows = inbox
        .get("conversations")
        .and_then(Value::as_array)
        .unwrap();
    let row = |id: &str| {
        rows.iter()
            .find(|item| item.get("canvasConversationId").and_then(Value::as_str) == Some(id))
            .expect("conversation row")
    };
    let failed = row("77001");
    assert_eq!(
        failed.get("historyComplete").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        failed
            .get("detailCaptureIncomplete")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        failed.pointer("/messages/0/body").and_then(Value::as_str),
        Some("Preserved prior detail")
    );
    assert_eq!(
        failed.get("latestMessagePreview").and_then(Value::as_str),
        Some("Summary access_token=[redacted]")
    );
    assert_eq!(
        row("77002").get("historyComplete").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        row("77003")
            .get("messages")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(0)
    );
    assert_eq!(
        row("77004")
            .get("messages")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(0)
    );
    let absent_from_list = row("77999");
    assert_eq!(
        absent_from_list
            .get("historyComplete")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        absent_from_list
            .get("detailCaptureIncomplete")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert!(!serde_json::to_string(&inbox)
        .expect("serialize partial inbox")
        .contains("synthetic-private"));
}

#[test]
fn message_body_removes_active_markup_and_redacts_tokens() {
    let (body, truncated) =
        clean_message("<p>Hello<script>alert(1)</script> world</p> access_token=secret");
    assert_eq!(body, "Hello world access_token=[redacted]");
    assert!(!truncated);
}

#[test]
fn course_and_material_paths_are_bounded() {
    let scope = CourseScope {
        key: "demo-alpha".into(),
        folder: "classes/demo-alpha".into(),
        canvas_course_id: 9101,
    };
    assert!(validate_scope(&scope).is_ok());
    assert!(validate_scope(&CourseScope {
        key: "../bad".into(),
        folder: "classes/../bad".into(),
        canvas_course_id: 1,
    })
    .is_err());
    assert_eq!(material_name(501, "../notes.pdf").unwrap(), "501-notes.pdf");
}

#[test]
fn avatar_requires_matching_magic_bytes() {
    assert!(image_signature(
        &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        "image/png"
    ));
    assert!(!image_signature(b"bad", "image/png"));
}

#[test]
fn timestamps_normalize_offsets_to_utc() {
    assert_eq!(
        normalize_time(Some("2026-11-25T16:30:00Z")).as_deref(),
        Some("2026-11-25T16:30:00.000Z")
    );
    assert_eq!(
        normalize_time(Some("2026-11-25T11:30:00-05:00")).as_deref(),
        Some("2026-11-25T16:30:00.000Z")
    );
}

#[test]
fn capture_error_is_content_free() {
    let display = CaptureError::InvalidCanvasResponse.to_string();
    assert!(!display.contains("do-not-leak-this"));
    assert!(!display.contains("9101"));
}
