use super::*;
use serde_json::json;
use std::path::PathBuf;

const USER_ID: u64 = 41;
const GENERATION_ID: &str = "a123456789abcdef0123456789abcdef";

fn complete_claim_bundle() -> ValidatedCaptureBundle {
    let generation_id = GENERATION_ID.to_owned();
    let mut resources = vec![
        json!({"endpoint":"profile","courseId":null,"pages":1,"items":[{"id":USER_ID}]}),
        json!({"endpoint":"coursesActive","courseId":null,"pages":1,"items":[]}),
        json!({"endpoint":"coursesCompleted","courseId":null,"pages":1,"items":[]}),
        json!({"endpoint":"groups","courseId":null,"pages":1,"items":[]}),
        json!({"endpoint":"personalFiles","courseId":null,"pages":1,"items":[]}),
        json!({"endpoint":"personalFolders","courseId":null,"pages":1,"items":[]}),
        json!({"endpoint":"fileBodies","courseId":null,"pages":1,"items":[]}),
        json!({"endpoint":"calendarEvents","courseId":null,"contextCode":"user_41","pages":1,"items":[{"id":7}]}),
    ];
    let mut coverage = vec![
        coverage_row("profile", None, None, "complete", None),
        coverage_row("coursesActive", None, None, "complete", None),
        coverage_row("coursesCompleted", None, None, "complete", None),
        coverage_row("groups", None, None, "complete", None),
        coverage_row("personalFiles", None, None, "complete", None),
        coverage_row("personalFolders", None, None, "complete", None),
        coverage_row("calendar", None, None, "gap", Some("unsupported")),
        coverage_row("calendarEvents", None, Some("user_41"), "complete", None),
    ];
    for endpoint in [
        "inbox",
        "inboxAll",
        "conversationsSent",
        "conversationsArchived",
    ] {
        resources.push(json!({"endpoint":endpoint,"courseId":null,"pages":1,"items":[]}));
        coverage.push(coverage_row(endpoint, None, None, "complete", None));
    }
    let snapshot = json!({
        "schemaVersion":2,"source":"canvas-browser","complete":true,
        "runId":1,"generationId":generation_id,"capturedAt":"2030-01-08T12:00:00Z",
        "identity":{"origin":"https://marymount.instructure.com","userId":USER_ID},
        "activeCourses":{"complete":true,"courseIds":[]},
        "coverageRequirements":{"activeCoursesComplete":true,"perActiveCourse":["course","assignments","assignmentGroups","submissions"]},
        "resources":resources,"coverage":[]
    });
    ValidatedCaptureBundle {
        run_id: 1,
        generation_id,
        user_id: USER_ID,
        captured_at: "2030-01-08T12:00:00Z".into(),
        snapshot,
        manifest: json!({"complete":true}),
        active_courses: Vec::new(),
        coverage,
        blob_directory: PathBuf::new(),
    }
}

fn coverage_row(
    endpoint: &str,
    course_id: Option<u64>,
    context_code: Option<&str>,
    status: &str,
    reason: Option<&str>,
) -> crate::browser_bundle::CaptureCoverage {
    crate::browser_bundle::CaptureCoverage {
        endpoint: endpoint.into(),
        course_id,
        group_id: None,
        context_code: context_code.map(str::to_owned),
        status: status.into(),
        reason: reason.map(str::to_owned),
    }
}

#[test]
fn complete_claim_accepts_omissions_and_rejects_failures_before_import() {
    let mut bundle = complete_claim_bundle();
    assert!(validate_complete_claim(&bundle).is_ok());

    bundle.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "personalFiles")
        .unwrap()["items"] = json!([{"id":77}]);
    bundle.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "fileBodies")
        .unwrap()["items"] = json!([{"fileId":77,"status":"gap","reason":"not-applicable"}]);
    assert!(validate_complete_claim(&bundle).is_ok());
    assert_eq!(
        daily_scope::summarize_daily_scope(
            &bundle.snapshot,
            &bundle.active_courses,
            &bundle.coverage,
        )
        .unwrap(),
        (0, 1)
    );
    for reason in ["forbidden-optional", "not-found"] {
        bundle.snapshot["resources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|resource| resource["endpoint"] == "fileBodies")
            .unwrap()["items"][0]["reason"] = json!(reason);
        assert!(validate_complete_claim(&bundle).is_ok());
        let report = diagnostics::import_diagnostics(&bundle, 0, 1).unwrap();
        assert_eq!(
            report["fileReceipts"]["personalFileReceipts"]["optionalOmissionReceipts"],
            1
        );
        assert_eq!(
            report["fileReceipts"]["personalFileReceipts"]["failedReceipts"],
            0
        );
    }

    for resource in bundle.snapshot["resources"].as_array_mut().unwrap() {
        if resource["endpoint"] == "personalFiles" {
            resource["items"][0]["size"] = json!(0);
        } else if resource["endpoint"] == "fileBodies" {
            resource["items"][0]["reason"] = json!("empty");
        }
    }
    assert!(validate_complete_claim(&bundle).is_ok());
    bundle
        .coverage
        .push(coverage_row("fileBodies", None, None, "gap", Some("empty")));
    assert!(validate_complete_claim(&bundle).is_ok());
    let report = diagnostics::import_diagnostics(&bundle, 0, 1).unwrap();
    let personal = &report["fileReceipts"]["personalFileReceipts"];
    assert_eq!(personal["optionalOmissionReceipts"], 1);
    assert_eq!(personal["archivedReceipts"], 0);
    assert_eq!(personal["failedReceipts"], 0);
    assert_eq!(personal["reasonCounts"][0]["reason"], "empty");
    assert!(report["coverageReasonCounts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["endpoint"] == "fileBodies"
            && row["reason"] == "empty"
            && row["count"] == 1));

    bundle.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "fileBodies")
        .unwrap()["items"][0]["reason"] = json!("HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH");
    assert!(matches!(
        validate_complete_claim(&bundle),
        Err(BrowserImportError::IncompleteCoverage)
    ));

    let mut missing_daily_section = complete_claim_bundle();
    missing_daily_section.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|resource| resource["endpoint"] != "inbox");
    missing_daily_section
        .coverage
        .retain(|row| row.endpoint != "inbox");
    assert!(matches!(
        validate_complete_claim(&missing_daily_section),
        Err(BrowserImportError::IncompleteCoverage)
    ));

    let mut known_calendar_failure = complete_claim_bundle();
    let calendar_events = known_calendar_failure
        .coverage
        .iter_mut()
        .find(|row| row.endpoint == "calendarEvents")
        .unwrap();
    calendar_events.status = "incomplete".into();
    calendar_events.reason = Some("pagination-budget".into());
    assert!(matches!(
        validate_complete_claim(&known_calendar_failure),
        Err(BrowserImportError::IncompleteCoverage)
    ));
}

#[test]
fn personal_file_body_failures_have_content_free_source_counts() {
    let mut bundle = complete_claim_bundle();
    bundle.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "personalFiles")
        .unwrap()["items"] = json!([{"id":77}]);
    bundle.snapshot["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "fileBodies")
        .unwrap()["items"] = json!([{
        "fileId":77,"status":"gap","reason":"HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH"
    }]);

    let diagnostics = diagnostics::import_diagnostics(&bundle, 1, 0).unwrap();
    assert_eq!(
        diagnostics["fileReceipts"]["personalFileReceipts"]["listed"],
        1
    );
    assert_eq!(
        diagnostics["fileReceipts"]["personalFileReceipts"]["failedReceipts"],
        1
    );
    assert!(
        diagnostics["fileReceipts"]["personalFileReceipts"]["reasonCounts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| {
                row["reason"] == "HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH" && row["count"] == 1
            })
    );
    let encoded = serde_json::to_string(&diagnostics).unwrap();
    assert!(!encoded.contains("fileId"));
    assert!(!encoded.contains("77"));
}
