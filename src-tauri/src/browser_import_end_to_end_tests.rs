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

#[test]
fn graded_topic_instructions_reach_coursework_and_the_marked_class_readme() {
    const TEXT: &str = "## Read first\n\n1. Compare the examples.\n2. Explain your choice.";
    const HTML: &str =
        "<h2>Read first</h2><ol><li>Compare the examples.</li><li>Explain your choice.</li></ol>";
    const POSTED: &str = "2030-01-08T00:27:00Z";
    let root = TempRoot::new("topic-export-roundtrip");
    let store = open_store(&root, "authoritative", true);
    let class_folder = root.path().join("synthetic-class");
    fs::create_dir(&class_folder).unwrap();
    fs::write(
        root.path().join("class-folders.json"),
        json!({
            "schemaVersion": 1, "courses": {(COURSE_ID.to_string()): class_folder}
        })
        .to_string(),
    )
    .unwrap();
    publish_with(&root, 41, |run, generation, user| {
        let mut snapshot = accessible_capture(run, generation, user);
        for resource in snapshot["resources"].as_array_mut().unwrap() {
            match resource["endpoint"].as_str() {
                Some("assignments") => {
                    resource["items"] = json!([{
                        "id": 4242, "course_id":COURSE_ID, "name":"Synthetic forum",
                        "submission_types":["discussion_topic"], "due_at":"2030-01-08T04:59:00Z",
                        "_canvasBody":{"html":"<p>See topic.</p>","text":"See topic.","empty":false}
                    }])
                }
                Some("discussions") => {
                    resource["items"] = json!([{
                        "id": 17, "course_id":COURSE_ID, "title":"Synthetic forum", "assignment_id":4242,
                        "posted_at": POSTED, "require_initial_post":true, "message": TEXT,
                        "_canvasBody":{"html":HTML,"text":TEXT,"empty":false}
                    }])
                }
                _ => {}
            }
        }
        snapshot
    });
    let result = run_import(&store, &root, Some(41)).unwrap();
    assert_eq!(result.export_written, 1);
    let coursework: Value =
        serde_json::from_slice(&fs::read(store.store_dir().join("coursework.json")).unwrap())
            .unwrap();
    let item = coursework["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["canvasId"] == 4242)
        .unwrap();
    assert_eq!(item["detail"], TEXT);
    assert_eq!(item["bodyHtml"], HTML);
    assert_eq!(item["postedAt"], POSTED);
    let target = class_folder.join("assignments/synthetic-forum/source/README.md");
    let readme = fs::read_to_string(&target).unwrap();
    assert!(readme.starts_with("<!-- Generated by Due Good from Canvas"));
    assert!(readme.contains("# Synthetic forum"));
    assert!(readme.contains("## Assignment description\n\nSee topic."));
    assert!(readme.contains("- Require initial post: true"));
    assert!(readme.contains("- Canvas discussion topic ID: 17"));
    assert!(readme.contains(TEXT));
    assert!(readme.contains("07:27 PM ET"));
    assert_eq!(run_import(&store, &root, None).unwrap().export_unchanged, 1);
    fs::write(&target, "Private synthetic notes").unwrap();
    assert_eq!(
        run_import(&store, &root, None)
            .unwrap()
            .export_skipped_owner_files,
        1
    );
    assert_eq!(
        fs::read_to_string(target).unwrap(),
        "Private synthetic notes"
    );
}
