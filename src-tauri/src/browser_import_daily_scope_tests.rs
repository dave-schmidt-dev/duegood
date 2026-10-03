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
        resources.push(json!({"endpoint": endpoint, "courseId": 1, "items": []}));
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
    coverage_rows.push(coverage("conversation", None, "complete", None));
    // Calendar identity capture belongs to the separate native iCal lane.
    coverage_rows.push(coverage("calendar", None, "gap", Some("unsupported")));
    (json!({"resources":resources}), active, coverage_rows)
}

#[test]
fn daily_scope_distinguishes_archive_omissions_from_required_failures() {
    let (snapshot, active, mut rows) = complete_daily_fixture();
    assert_eq!(
        daily_scope::summarize_daily_scope(&snapshot, &active, &rows).unwrap(),
        (0, 0)
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

    for reason in ["invalid-slug", "detail-budget", "request-failed"] {
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
        .find(|resource| resource["endpoint"] == "courseFiles")
        .unwrap()["items"] = json!([{"id":42}]);
    file_failure["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint":"fileBodies", "courseId":1,
            "items":[{"fileId":42,"status":"gap","reason":"request-failed"}]
        }));
    assert!(
        daily_scope::summarize_daily_scope(&file_failure, &active, &rows)
            .unwrap()
            .0
            > 0
    );

    let (mut active_locked, active, rows) = complete_daily_fixture();
    active_locked["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["endpoint"] == "courseFiles")
        .unwrap()["items"] = json!([{"id":42}]);
    active_locked["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint":"fileBodies", "courseId":1,
            "items":[{"fileId":42,"status":"gap","reason":"locked"}]
        }));
    assert_eq!(
        daily_scope::summarize_daily_scope(&active_locked, &active, &rows).unwrap(),
        (0, 1)
    );

    let (mut archived_locked, active, rows) = complete_daily_fixture();
    archived_locked["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint":"courseFiles", "courseId":2, "items":[{"id":42}]
        }));
    archived_locked["resources"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "endpoint":"fileBodies", "courseId":null,
            "items":[{"fileId":42,"status":"gap","reason":"locked"}]
        }));
    assert_eq!(
        daily_scope::summarize_daily_scope(&archived_locked, &active, &rows).unwrap(),
        (0, 0)
    );
}
