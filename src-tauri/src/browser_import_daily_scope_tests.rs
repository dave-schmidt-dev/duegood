use super::*;
use crate::browser_bundle::{ActiveCourseCoverage, CaptureCoverage};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn coverage(
    endpoint: &str,
    course_id: Option<u64>,
    status: &str,
    reason: Option<&str>,
) -> CaptureCoverage {
    CaptureCoverage {
        endpoint: endpoint.into(),
        course_id,
        group_id: None,
        context_code: None,
        status: status.into(),
        reason: reason.map(str::to_owned),
    }
}

fn complete_daily_fixture() -> (Value, Vec<ActiveCourseCoverage>, Vec<CaptureCoverage>) {
    let active = vec![ActiveCourseCoverage {
        course_id: 1,
        required_endpoints: BTreeSet::new(),
        complete: true,
    }];
    let mut resources = Vec::new();
    let mut coverage_rows = Vec::new();
    for endpoint in [
        "course",
        "assignments",
        "assignmentGroups",
        "submissions",
        "pages",
        "modules",
        "announcements",
        "courseFiles",
    ] {
        let items = if endpoint == "courseFiles" {
            json!([{"id":42}])
        } else {
            json!([])
        };
        resources.push(json!({"endpoint": endpoint, "courseId": 1, "items": items}));
        coverage_rows.push(coverage(endpoint, Some(1), "complete", None));
    }
    for endpoint in [
        "inbox",
        "inboxAll",
        "conversationsSent",
        "conversationsArchived",
    ] {
        let items = if endpoint == "inbox" {
            json!([{"id": 17}])
        } else {
            json!([])
        };
        resources.push(json!({"endpoint": endpoint, "courseId": null, "items": items}));
        coverage_rows.push(coverage(endpoint, None, "complete", None));
    }
    resources.push(json!({"endpoint":"conversation", "courseId":null, "items":[{"id":17}]}));
    resources.push(json!({
        "endpoint":"fileBodies", "courseId":null,
        "items":[{"fileId":42,"status":"archived","byteCount":12,
            "sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "contentType":"application/pdf","sourceAuthenticity":"unverified"}]
    }));
    coverage_rows.push(coverage("conversation", None, "complete", None));
    // Calendar identity capture belongs to the separate native iCal lane.
    coverage_rows.push(coverage("calendar", None, "gap", Some("unsupported")));
    (json!({"resources":resources}), active, coverage_rows)
}

#[test]
fn body_coverage_counts_empty_bodies_and_matches_page_details_by_identity() {
    let (mut snapshot, active, mut rows) = complete_daily_fixture();
    let active_ids = active
        .iter()
        .map(|course| course.course_id)
        .collect::<BTreeSet<_>>();
    let resources = snapshot["resources"].as_array_mut().unwrap();
    resources
        .iter_mut()
        .find(|resource| resource["endpoint"] == "assignments")
        .unwrap()["items"] = json!([
        {"id":31,"_canvasBody":{"html":"<p>Work</p>","text":"Work","empty":false}},
        {"id":32,"_canvasBody":{"html":"","text":"","empty":true}},
        {"id":33,"_canvasBodyReason":"BODY_MISSING"},
        {"id":34,"_canvasBodyReason":"BODY_SANITIZE_FAILED"},
        {"id":35,"_canvasBodyReason":"unexpected","_canvasBody":{"html":"<p>Work</p>","text":"Work","empty":false}},
        {"id":36,"_canvasBody":{"html":format!("{}", "é".repeat(262_145)),"text":"","empty":false}},
        {"id":37,"_canvasBody":{"html":format!("{}", "é".repeat(250_000)),"text":format!("{}", "é".repeat(30_000)),"empty":false}}
    ]);
    resources
        .iter_mut()
        .find(|resource| resource["endpoint"] == "pages")
        .unwrap()["items"] = json!([
        {"page_id":51,"_canvasBodyReason":"BODY_MISSING"},
        {"page_id":52,"published":false,"_canvasBodyReason":"BODY_MISSING"}
    ]);
    resources.push(json!({
        "endpoint":"page", "courseId":1,
        "items":[{"page_id":51,"_canvasBody":{"html":"<h2>Guide</h2>","text":"Guide","empty":false}}]
    }));
    resources.push(json!({
        "endpoint":"quizzes", "courseId":1,
        "items":[{"id":61,"locked":true,"_canvasBodyReason":"BODY_MISSING"}]
    }));
    snapshot["coverage"] = json!([
        {"endpoint":"page","courseId":1,"status":"gap","reason":"unpublished"},
        {"endpoint":"quiz","courseId":1,"status":"gap","reason":"locked"}
    ]);
    rows.push(coverage("page", Some(1), "gap", Some("unpublished")));
    rows.push(coverage("quiz", Some(1), "gap", Some("locked")));

    let counts = daily_scope::summarize_body_coverage(&snapshot, &active_ids).unwrap();
    assert_eq!(counts.body_count, 4);
    assert_eq!(counts.empty_body_count, 1);
    assert_eq!(counts.missing_count, 1);
    assert_eq!(counts.sanitize_failed_count, 3);
    assert_eq!(counts.active_failure_count, 4);
    assert_eq!(counts.body_failure_reason, Some("BODY_SANITIZE_FAILED"));
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows)
            .unwrap()
            .0,
        4
    );
    assert!(daily_scope::has_capture_failures(&snapshot, &rows).unwrap());
}

#[test]
fn group_page_list_omission_matches_the_group_detail_coverage_row() {
    let snapshot = json!({
        "resources":[
            {"endpoint":"groups","courseId":null,"items":[{"id":88,"course_id":1}]},
            {"endpoint":"pages","courseId":null,"groupId":88,
                "items":[{"page_id":89,"published":false,"_canvasBodyReason":"BODY_MISSING"}]}
        ],
        "coverage":[
            {"endpoint":"page","courseId":null,"groupId":88,"status":"gap","reason":"unpublished"}
        ]
    });
    let active_ids = BTreeSet::from([1]);
    let counts = crate::browser_body_coverage::summarize(&snapshot, &active_ids).unwrap();
    assert_eq!(counts.body_count, 0);
    assert_eq!(counts.missing_count, 0);
    assert_eq!(counts.sanitize_failed_count, 0);
    assert_eq!(counts.body_failure_reason, None);
}

#[test]
fn daily_scope_distinguishes_archive_omissions_from_required_failures() {
    let (snapshot, active, mut rows) = complete_daily_fixture();
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 0)
    );

    let mut damaged_archive = snapshot.clone();
    let receipt = damaged_archive["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "fileBodies")
        .unwrap();
    receipt["items"][0]["sha256"] = json!("damaged");
    assert_eq!(
        daily_scope::summarize_daily_scope(&damaged_archive, &active, &rows).unwrap(),
        (1, 0)
    );

    rows.push(coverage(
        "discussions",
        Some(2),
        "gap",
        Some("invalid-slug"),
    ));
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 0)
    );

    let mut optional_locked = rows.clone();
    optional_locked.push(coverage("quizzes", Some(1), "gap", Some("locked")));
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &optional_locked).unwrap(),
        (0, 1)
    );

    for reason in [
        "invalid-slug",
        "detail-budget",
        "request-failed",
        "capture-budget",
        "pagination-budget",
        "unsupported",
    ] {
        let mut active_failure = rows.clone();
        active_failure.push(coverage("discussions", Some(1), "gap", Some(reason)));
        assert!(
            daily_scope::summarize_daily_scope(&snapshot, &active, &active_failure)
                .unwrap()
                .0
                > 0
        );
    }

    let mut mismatch = snapshot.clone();
    let detail = mismatch["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "conversation")
        .unwrap();
    detail["items"] = json!([{"id":18}]);
    assert!(
        daily_scope::summarize_daily_scope(&mismatch, &active, &rows)
            .unwrap()
            .0
            > 0
    );

    let mut file_failure = snapshot;
    file_failure["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "fileBodies")
        .unwrap()["items"][0] = json!({"fileId":42,"status":"gap","reason":"request-failed"});
    assert!(
        daily_scope::summarize_daily_scope(&file_failure, &active, &rows)
            .unwrap()
            .0
            > 0
    );

    for reason in ["locked", "forbidden-optional", "not-found"] {
        let (mut active_omitted, active, rows) = complete_daily_fixture();
        active_omitted["resources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|resource| resource["endpoint"] == "fileBodies")
            .unwrap()["items"][0] = json!({"fileId":42,"status":"gap","reason":reason});
        assert_eq!(
            daily_scope::summarize_daily_scope(&active_omitted, &active, &rows).unwrap(),
            (0, 1),
            "Canvas body omission {reason} should not make daily coverage partial"
        );
    }

    let (mut archived_locked, active, rows) = complete_daily_fixture();
    archived_locked["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint":"courseFiles", "courseId":2, "items":[{"id":43}]
        }));
    archived_locked["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint":"fileBodies", "courseId":null,
            "items":[{"fileId":43,"status":"gap","reason":"locked"}]
        }));
    assert_eq!(
        daily_scope::summarize_daily_scope(&archived_locked, &active, &rows).unwrap(),
        (0, 0),
        "inactive course files do not affect the daily scope"
    );
}

#[test]
fn disabled_required_lists_and_children_of_omissions_are_counted_as_omissions() {
    for (endpoint, reason, child) in [
        ("courseFiles", "forbidden-optional", "file"),
        ("pages", "not-found", "page"),
    ] {
        let (mut snapshot, active, mut rows) = complete_daily_fixture();
        snapshot["resources"]
            .as_array_mut()
            .unwrap()
            .retain(|resource| resource["endpoint"] != endpoint);
        rows.retain(|row| row.endpoint != endpoint);
        rows.push(coverage(endpoint, Some(1), "gap", Some(reason)));
        rows.push(coverage(child, Some(1), "gap", Some("parent-unavailable")));

        assert_eq!(
            daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
            (0, 2),
            "{endpoint} omission and its child should be visible omissions"
        );
    }
}

#[test]
fn parent_unavailable_children_of_failed_lists_remain_required_gaps() {
    let (mut snapshot, active, mut rows) = complete_daily_fixture();
    snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|resource| resource["endpoint"] != "pages");
    rows.retain(|row| row.endpoint != "pages");
    rows.push(coverage("pages", Some(1), "gap", Some("request-failed")));
    rows.push(coverage("page", Some(1), "gap", Some("parent-unavailable")));

    let (gaps, omissions) = daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap();
    assert!(gaps >= 2);
    assert_eq!(omissions, 0);

    rows.push(coverage("pages", Some(1), "gap", Some("not-found")));
    let (gaps, omissions) = daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap();
    assert!(gaps >= 2);
    assert_eq!(omissions, 0, "a duplicate parent result is ambiguous");
}

#[test]
fn complete_capture_allows_calendar_identity_events_and_only_safe_file_omissions() {
    let (mut snapshot, _active, mut rows) = complete_daily_fixture();
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"calendarEvents", "courseId":null, "contextCode":"user_41",
        "items":[{"id":1}], "pages":1
    }));
    rows.push(CaptureCoverage {
        endpoint: "calendarEvents".into(),
        course_id: None,
        group_id: None,
        context_code: Some("user_41".into()),
        status: "complete".into(),
        reason: None,
    });
    assert!(!daily_scope::has_capture_failures(&snapshot, &rows).unwrap());

    let file_bodies_index = snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .iter()
        .position(|resource| resource["endpoint"] == "fileBodies")
        .unwrap();
    snapshot["resources"][file_bodies_index]["items"][0] =
        json!({"fileId":42,"status":"gap","reason":"not-applicable"});
    assert!(!daily_scope::has_capture_failures(&snapshot, &rows).unwrap());

    snapshot["resources"][file_bodies_index]["items"][0] = json!({
        "fileId":42,"status":"gap","reason":"HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH"
    });
    assert!(daily_scope::has_capture_failures(&snapshot, &rows).unwrap());
}

#[test]
fn linked_file_details_require_body_receipts_when_course_files_are_hidden() {
    let (mut snapshot, active, mut rows) = complete_daily_fixture();
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"calendarEvents", "courseId":null, "contextCode":"user_41",
        "items":[{"id":1}]
    }));
    rows.push(CaptureCoverage {
        endpoint: "calendarEvents".into(),
        course_id: None,
        group_id: None,
        context_code: Some("user_41".into()),
        status: "complete".into(),
        reason: None,
    });
    snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|resource| resource["endpoint"] != "courseFiles");
    rows.retain(|row| row.endpoint != "courseFiles");
    rows.push(coverage(
        "courseFiles",
        Some(1),
        "gap",
        Some("forbidden-optional"),
    ));
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"file", "courseId":1, "pages":1, "items":[{"id":43}]
    }));
    rows.push(coverage("file", Some(1), "complete", None));
    let file_receipts = snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "fileBodies")
        .unwrap();
    file_receipts["items"] = json!([{
        "fileId":43,"status":"archived","byteCount":12,
        "sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "contentType":"application/pdf","sourceAuthenticity":"unverified"
    }]);

    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 1)
    );
    assert!(!daily_scope::has_capture_failures(&snapshot, &rows).unwrap());

    snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "fileBodies")
        .unwrap()["items"] = json!([]);
    assert!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows)
            .unwrap()
            .0
            > 0
    );
    assert!(daily_scope::has_capture_failures(&snapshot, &rows).unwrap());

    snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|resource| resource["endpoint"] != "file");
    rows.retain(|row| row.endpoint != "file");
    rows.push(coverage("file", Some(1), "gap", Some("not-found")));
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 2)
    );
    assert!(!daily_scope::has_capture_failures(&snapshot, &rows).unwrap());
}

#[test]
fn linked_personal_files_and_optional_metadata_omissions_keep_their_coverage_state() {
    let (mut snapshot, active, mut rows) = complete_daily_fixture();
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"calendarEvents", "courseId":null, "contextCode":"user_41",
        "items":[{"id":1}]
    }));
    rows.push(CaptureCoverage {
        endpoint: "calendarEvents".into(),
        course_id: None,
        group_id: None,
        context_code: Some("user_41".into()),
        status: "complete".into(),
        reason: None,
    });
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"personalFile", "courseId":null, "pages":1, "items":[{"id":44}]
    }));
    rows.push(coverage("personalFile", None, "complete", None));
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"fileBodies", "courseId":null,
        "items":[{"fileId":44,"status":"archived","byteCount":12,
            "sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "contentType":"application/pdf","sourceAuthenticity":"unverified"}]
    }));
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 0)
    );
    assert!(!daily_scope::has_capture_failures(&snapshot, &rows).unwrap());

    snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|resource| resource["endpoint"] != "personalFile");
    rows.retain(|row| row.endpoint != "personalFile");
    rows.push(coverage("personalFile", None, "gap", Some("not-found")));
    snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|resource| {
            resource["endpoint"] != "fileBodies" || resource["items"][0]["fileId"] != 44
        });
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 0)
    );
    assert!(!daily_scope::has_capture_failures(&snapshot, &rows).unwrap());

    rows.retain(|row| row.endpoint != "personalFile");
    rows.push(coverage(
        "personalFile",
        None,
        "incomplete",
        Some("request-failed"),
    ));
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 0)
    );
    assert!(daily_scope::has_capture_failures(&snapshot, &rows).unwrap());

    rows.retain(|row| row.endpoint != "personalFile");
    rows.push(coverage("personalFile", None, "gap", Some("detail-budget")));
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 0)
    );
    assert!(daily_scope::has_capture_failures(&snapshot, &rows).unwrap());
}

#[test]
fn non_course_file_failures_do_not_change_daily_scope() {
    let (mut snapshot, active, mut rows) = complete_daily_fixture();
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"file", "courseId":null, "groupId":91, "pages":1,
        "items":[{"id":45}]
    }));
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"fileBodies", "courseId":null,
        "items":[{"fileId":45,"status":"gap","reason":"request-failed"}]
    }));
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"personalFile", "courseId":null, "pages":1,
        "items":[{"id":46}]
    }));
    snapshot["resources"].as_array_mut().unwrap().push(json!({
        "endpoint":"fileBodies", "courseId":null,
        "items":[{"fileId":46,"status":"gap","reason":"request-failed"}]
    }));
    rows.push(CaptureCoverage {
        endpoint: "file".into(),
        course_id: None,
        group_id: Some(91),
        context_code: None,
        status: "incomplete".into(),
        reason: Some("request-failed".into()),
    });
    rows.push(coverage(
        "personalFile",
        None,
        "incomplete",
        Some("request-failed"),
    ));

    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 0)
    );
    assert!(daily_scope::has_capture_failures(&snapshot, &rows).unwrap());
}

#[test]
fn conversation_details_require_one_captured_or_explicitly_omitted_row_per_summary() {
    let (mut snapshot, active, mut rows) = complete_daily_fixture();
    snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|resource| resource["endpoint"] != "conversation");
    rows.retain(|row| row.endpoint != "conversation");
    rows.push(coverage("conversation", None, "gap", Some("not-found")));

    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 1)
    );

    rows.retain(|row| row.endpoint != "conversation");
    rows.push(coverage("conversation", None, "gap", Some("not-found")));
    rows.push(coverage(
        "conversation",
        None,
        "gap",
        Some("request-failed"),
    ));
    let (gaps, omissions) = daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap();
    assert!(gaps > 0);
    assert_eq!(omissions, 1);
}
