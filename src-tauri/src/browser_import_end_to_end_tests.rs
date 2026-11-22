use super::fixture::{open_store, publish_with, COURSE_ID};
use super::tests::{read_history, run_import};
use super::STATUS_FILE;
use crate::{browser_freshness, capture_run, testutil::TempRoot};
use serde_json::{json, Value};
use std::fs;

fn accessible_capture(run_id: u64, generation: &str, user: u64) -> Value {
    let mut resources = Vec::new();
    let mut coverage = Vec::new();
    let mut capture =
        |endpoint: &str, course: Option<u64>, context: Option<String>, items: Value| {
            let mut key = json!({"endpoint":endpoint, "courseId":course});
            if let Some(context) = context {
                key["contextCode"] = json!(context);
            }
            let mut resource = key.clone();
            resource["pages"] = json!(1);
            resource["items"] = items;
            resources.push(resource);
            key["status"] = json!("complete");
            coverage.push(key);
        };
    capture("profile", None, None, json!([{"id":user,"account_id":42}]));
    capture("coursesActive", None, None, json!([{"id":COURSE_ID}]));
    for endpoint in [
        "coursesCompleted",
        "groups",
        "personalFiles",
        "personalFolders",
        "inbox",
        "inboxAll",
        "conversationsSent",
        "conversationsArchived",
    ] {
        capture(endpoint, None, None, json!([]));
    }
    capture(
        "course",
        Some(COURSE_ID),
        None,
        json!([{"id":COURSE_ID,"name":"Synthetic course"}]),
    );
    for endpoint in [
        "courseTabs",
        "assignments",
        "assignmentGroups",
        "submissions",
        "modules",
        "discussions",
        "announcements",
        "quizzes",
        "folders",
    ] {
        capture(endpoint, Some(COURSE_ID), None, json!([]));
    }
    capture(
        "calendarEvents",
        Some(COURSE_ID),
        Some(format!("course_{COURSE_ID}")),
        json!([]),
    );
    capture(
        "calendarEvents",
        None,
        Some(format!("user_{user}")),
        json!([]),
    );
    coverage.push(
        json!({"endpoint":"calendarEvents","courseId":null,"contextCode":"account_42",
        "status":"gap","reason":"forbidden-optional"}),
    );
    for (endpoint, reason) in [
        ("courseFiles", "forbidden-optional"),
        ("file", "parent-unavailable"),
        ("pages", "not-found"),
        ("page", "parent-unavailable"),
    ] {
        coverage
            .push(json!({"endpoint":endpoint,"courseId":COURSE_ID,"status":"gap","reason":reason}));
    }
    json!({
        "schemaVersion":2,"source":"canvas-browser","complete":true,"capturedAt":"2030-01-08T12:00:00Z",
        "runId":run_id,"generationId":generation,"identity":{"origin":"https://marymount.instructure.com","userId":user,"accountId":42},
        "activeCourses":{"complete":true,"courseIds":[COURSE_ID]},
        "coverageRequirements":{"activeCoursesComplete":true,"perActiveCourse":["course","assignments","assignmentGroups","submissions"]},
        "resources":resources,"coverage":coverage
    })
}

#[test]
fn omission_only_generation_publishes_complete_history_and_verified_freshness() {
    let root = TempRoot::new("accessible-capture");
    let store = open_store(&root, "authoritative", true);
    let user = 41;
    publish_with(&root, user, accessible_capture);
    let imported = run_import(&store, &root, Some(user)).unwrap();
    assert_eq!(imported.imported_courses, 1);
    let event = &read_history(&store)["events"][0];
    assert_eq!(event["sourceComplete"], true);
    assert_eq!(event["status"], "succeeded");
    assert_eq!(event["dailyGapCount"], 0);
    assert_eq!(event["dailyOmissionCount"], 5);
    let status =
        serde_json::from_slice(&fs::read(store.store_dir().join(STATUS_FILE)).unwrap()).unwrap();
    let attempt =
        serde_json::to_value(capture_run::read_attempt(root.path()).unwrap().unwrap()).unwrap();
    let freshness = browser_freshness::project_freshness(Some(&status), Some(&attempt));
    assert!(freshness.current);
    assert!(freshness
        .sections
        .iter()
        .any(|row| row.endpoint == "course" && row.current));
    assert!(freshness
        .sections
        .iter()
        .any(|row| row.endpoint == "pages" && !row.current));
}
