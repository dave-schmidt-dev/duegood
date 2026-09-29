use super::*;
use crate::reconcile::{reconcile_coursework, CourseAssignments};
use std::time::SystemTime;

const COURSE: u64 = 900_001;
const OTHER: u64 = 900_002;
const BODY: &str = "Synthetic syllabus\nClass session: 2030-01-14 18:00-20:30";

fn scopes() -> Vec<BrowserCourseScope> {
    vec![
        BrowserCourseScope {
            key: "synthetic-a".into(),
            folder: "classes/synthetic-a".into(),
            canvas_course_id: COURSE,
        },
        BrowserCourseScope {
            key: "synthetic-b".into(),
            folder: "classes/synthetic-b".into(),
            canvas_course_id: OTHER,
        },
    ]
}

fn coursework() -> Value {
    json!({
        "courses":[{"key":"synthetic-a"},{"key":"synthetic-b"}],
        "items":[
            {"id":"manual-a","course":"synthetic-a","kind":"session","source":"manual","title":"Personal session","at":"2030-01-14T18:00:00-05:00","notes":"Synthetic personal note","done":true},
            {"id":"legacy-b","course":"synthetic-b","kind":"session","source":"syllabus","title":"Retained legacy session","at":"2030-01-15T18:00:00-05:00","done":false}
        ],
        "archivedForecastItems":[], "extension":{"preserve":true}
    })
}

fn session(date: &str, start: &str, end: &str) -> Value {
    json!({
        "date":date,"startTime":start,"endTime":end,"title":"Class session",
        "source":{"kind":"course-body","sha256":digest(BODY.as_bytes()),"line":2}
    })
}

fn snapshot() -> Value {
    json!({
        "activeCourses":{"courseIds":[COURSE,OTHER]},
        "resources":[
            {"endpoint":"course","courseId":COURSE,"items":[{"id":COURSE,"time_zone":"America/New_York","syllabus_body":BODY}]},
            {"endpoint":"course","courseId":OTHER,"items":[{"id":OTHER,"time_zone":"America/New_York","syllabus_body":BODY}]}
        ],
        "syllabusSessions":{"schemaVersion":1,"courses":[{
            "courseId":COURSE,"timeZone":"America/New_York","status":"complete",
            "sessions":[session("2030-01-14","18:00","20:30")]
        }]}
    })
}

fn schedule_mut(snapshot: &mut Value) -> &mut Value {
    &mut snapshot["syllabusSessions"]["courses"][0]
}

fn imported(document: &Value) -> &Value {
    document["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item.get("syllabusSession").is_some())
        .unwrap()
}

#[test]
fn bound_body_schedule_adds_a_class_with_timezone_and_source_location() {
    let base = coursework();
    let merged = reconcile_syllabus_sessions(&base, &snapshot(), &scopes()).unwrap();
    let added = imported(&merged);
    assert_eq!(added["kind"], "session");
    assert_eq!(added["source"], "syllabus");
    assert_eq!(added["course"], "synthetic-a");
    assert_eq!(added["at"], "2030-01-14T18:00:00-05:00");
    assert_eq!(added["endsAt"], "2030-01-14T20:30:00-05:00");
    assert_eq!(added["syllabusSession"]["source"]["line"], 2);
    assert_eq!(
        added["syllabusSession"]["source"]["sha256"],
        digest(BODY.as_bytes())
    );
    assert_eq!(merged["items"][0], base["items"][0]);
    assert_eq!(merged["items"][1], base["items"][1]);
    assert_eq!(merged["extension"], base["extension"]);
}

#[test]
fn every_scoped_course_imports_without_a_course_name_filter() {
    let mut capture = snapshot();
    let mut second = schedule_mut(&mut capture).clone();
    second["courseId"] = json!(OTHER);
    capture["syllabusSessions"]["courses"]
        .as_array_mut()
        .unwrap()
        .push(second);
    let merged = reconcile_syllabus_sessions(&coursework(), &capture, &scopes()).unwrap();
    let sessions: Vec<_> = merged["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item.get("syllabusSession").is_some())
        .collect();
    assert_eq!(sessions.len(), 2);
    assert_ne!(sessions[0]["id"], sessions[1]["id"]);
    assert!(sessions.iter().any(|item| item["course"] == "synthetic-a"));
    assert!(sessions.iter().any(|item| item["course"] == "synthetic-b"));
}

#[test]
fn repeated_capture_is_idempotent_and_preserves_personal_fields() {
    let mut first = reconcile_syllabus_sessions(&coursework(), &snapshot(), &scopes()).unwrap();
    let added = first["items"].as_array_mut().unwrap().last_mut().unwrap();
    added["done"] = json!(true);
    added["doneAt"] = json!("2030-01-14T23:00:00Z");
    added["notes"] = json!("Synthetic personal note");
    added["studentNote"] = json!("Synthetic student-owned note");
    added["manualGradeObservation"] = json!({"version":1,"value":"A","source":"manual"});
    added["custom"] = json!({"preserve":true});
    let second = reconcile_syllabus_sessions(&first, &snapshot(), &scopes()).unwrap();
    assert_eq!(second, first);
}

#[test]
fn source_revision_updates_provenance_without_changing_identity_or_completion() {
    let mut first = reconcile_syllabus_sessions(&coursework(), &snapshot(), &scopes()).unwrap();
    first["items"].as_array_mut().unwrap().last_mut().unwrap()["done"] = json!(true);
    let prior_id = imported(&first)["id"].clone();
    let mut capture = snapshot();
    let changed_body = format!("{BODY}\nSynthetic updated source");
    capture["resources"][0]["items"][0]["syllabus_body"] = json!(changed_body);
    schedule_mut(&mut capture)["sessions"][0]["source"]["sha256"] =
        json!(digest(changed_body.as_bytes()));
    let merged = reconcile_syllabus_sessions(&first, &capture, &scopes()).unwrap();
    assert_eq!(imported(&merged)["id"], prior_id);
    assert_eq!(imported(&merged)["done"], true);
    assert_eq!(
        imported(&merged)["syllabusSession"]["source"]["sha256"],
        digest(changed_body.as_bytes())
    );
    assert_eq!(merged["items"].as_array().unwrap().len(), 3);
}

#[test]
fn missing_and_unresolved_schedules_keep_existing_sessions_exactly() {
    let first = reconcile_syllabus_sessions(&coursework(), &snapshot(), &scopes()).unwrap();
    let mut absent = snapshot();
    absent.as_object_mut().unwrap().remove("syllabusSessions");
    assert_eq!(
        reconcile_syllabus_sessions(&first, &absent, &scopes()).unwrap(),
        first
    );
    let mut unresolved = snapshot();
    *schedule_mut(&mut unresolved) = json!({
        "courseId":COURSE,"timeZone":"","status":"unresolved",
        "reason":"AMBIGUOUS_SCHEDULE","sessions":[]
    });
    assert_eq!(
        reconcile_syllabus_sessions(&first, &unresolved, &scopes()).unwrap(),
        first
    );
}

#[test]
fn omitted_sessions_are_never_deleted_and_new_sessions_are_additive() {
    let first = reconcile_syllabus_sessions(&coursework(), &snapshot(), &scopes()).unwrap();
    let mut capture = snapshot();
    schedule_mut(&mut capture)["sessions"] = json!([session("2030-01-21", "18:00", "20:30")]);
    let merged = reconcile_syllabus_sessions(&first, &capture, &scopes()).unwrap();
    assert_eq!(merged["items"].as_array().unwrap().len(), 4);
    assert!(merged["items"]
        .as_array()
        .unwrap()
        .contains(imported(&first)));
}

#[test]
fn subsequent_assignment_reconciliation_retains_imported_sessions() {
    let first = reconcile_syllabus_sessions(&coursework(), &snapshot(), &scopes()).unwrap();
    let captured = CourseAssignments {
        key: "synthetic-a".into(),
        groups: vec![],
        assignments: vec![],
    };
    let reconciled = reconcile_coursework(&first, &[captured], SystemTime::now()).unwrap();
    assert_eq!(imported(&reconciled), imported(&first));
}

#[test]
fn summer_and_winter_offsets_are_resolved_from_the_captured_zone() {
    let winter = reconcile_syllabus_sessions(&coursework(), &snapshot(), &scopes()).unwrap();
    let mut summer_capture = snapshot();
    schedule_mut(&mut summer_capture)["sessions"] =
        json!([session("2030-07-15", "18:00", "20:30")]);
    let summer = reconcile_syllabus_sessions(&coursework(), &summer_capture, &scopes()).unwrap();
    assert_eq!(imported(&winter)["at"], "2030-01-14T18:00:00-05:00");
    assert_eq!(imported(&summer)["at"], "2030-07-15T18:00:00-04:00");
}

#[test]
fn dst_gaps_and_folds_reject_the_entire_schedule() {
    for (date, start, end) in [
        ("2030-03-10", "02:15", "03:30"),
        ("2030-11-03", "01:15", "02:30"),
    ] {
        let mut capture = snapshot();
        schedule_mut(&mut capture)["sessions"]
            .as_array_mut()
            .unwrap()
            .push(session(date, start, end));
        let base = coursework();
        assert_eq!(
            reconcile_syllabus_sessions(&base, &capture, &scopes()),
            Err(SyllabusSessionError)
        );
        assert_eq!(base, coursework());
    }
}

#[test]
fn explicit_date_and_local_time_are_required_without_guessing() {
    for (date, start, end) in [
        ("January 14", "18:00", "20:30"),
        ("2030-02-30", "18:00", "20:30"),
        ("2030-1-14", "18:00", "20:30"),
        ("2030-01-14", "6 PM", "20:30"),
        ("2030-01-14", "18:00", "18:00"),
        ("2030-01-14", "23:00", "01:00"),
    ] {
        let mut capture = snapshot();
        schedule_mut(&mut capture)["sessions"] = json!([session(date, start, end)]);
        assert_eq!(
            reconcile_syllabus_sessions(&coursework(), &capture, &scopes()),
            Err(SyllabusSessionError)
        );
    }
}

#[test]
fn course_timezone_must_match_exactly_and_be_an_iana_zone() {
    for zone in ["UTC", "Eastern", "America/New_York "] {
        let mut capture = snapshot();
        schedule_mut(&mut capture)["timeZone"] = json!(zone);
        assert_eq!(
            reconcile_syllabus_sessions(&coursework(), &capture, &scopes()),
            Err(SyllabusSessionError)
        );
    }
    let mut absent = snapshot();
    absent["resources"][0]["items"][0]
        .as_object_mut()
        .unwrap()
        .remove("time_zone");
    assert_eq!(
        reconcile_syllabus_sessions(&coursework(), &absent, &scopes()),
        Err(SyllabusSessionError)
    );
}

#[test]
fn source_body_hash_and_source_location_are_bounded() {
    for (field, value) in [
        ("sha256", json!("a".repeat(64))),
        ("sha256", json!(digest(BODY.as_bytes()).to_uppercase())),
        ("line", json!(0)),
        ("line", json!(10_001)),
        ("page", json!(0)),
        ("page", json!(81)),
        ("fileId", json!(41)),
    ] {
        let mut capture = snapshot();
        schedule_mut(&mut capture)["sessions"][0]["source"][field] = value;
        assert_eq!(
            reconcile_syllabus_sessions(&coursework(), &capture, &scopes()),
            Err(SyllabusSessionError)
        );
    }
}

fn file_snapshot() -> Value {
    let mut capture = snapshot();
    capture["resources"].as_array_mut().unwrap().extend([
        json!({"endpoint":"courseFiles","courseId":COURSE,"items":[{"id":77,"filename":"synthetic-syllabus.pdf"}]}),
        json!({"endpoint":"fileBodies","courseId":null,"items":[{"fileId":77,"status":"archived","sha256":"b".repeat(64)}]}),
    ]);
    schedule_mut(&mut capture)["sessions"][0]["source"] = json!({
        "kind":"file","fileId":77,"sha256":"b".repeat(64),"line":3,"page":2
    });
    capture
}

#[test]
fn archived_file_hash_and_same_course_metadata_bind_pdf_sessions() {
    let merged = reconcile_syllabus_sessions(&coursework(), &file_snapshot(), &scopes()).unwrap();
    let source = &imported(&merged)["syllabusSession"]["source"];
    assert_eq!(source["fileId"], 77);
    assert_eq!(source["page"], 2);
    assert_eq!(source["line"], 3);
}

#[test]
fn cross_course_unarchived_or_changed_files_are_rejected() {
    let mut wrong_course = file_snapshot();
    wrong_course["resources"][2]["courseId"] = json!(OTHER);
    let mut unarchived = file_snapshot();
    unarchived["resources"][3]["items"][0]["status"] = json!("staged");
    let mut wrong_hash = file_snapshot();
    wrong_hash["resources"][3]["items"][0]["sha256"] = json!("c".repeat(64));
    let mut missing_metadata = file_snapshot();
    missing_metadata["resources"][2]["items"] = json!([]);
    for capture in [wrong_course, unarchived, wrong_hash, missing_metadata] {
        assert_eq!(
            reconcile_syllabus_sessions(&coursework(), &capture, &scopes()),
            Err(SyllabusSessionError)
        );
    }
}

#[test]
fn duplicate_courses_sessions_resources_or_receipts_cannot_choose_an_owner() {
    let mut duplicate_course = snapshot();
    let course = duplicate_course["syllabusSessions"]["courses"][0].clone();
    duplicate_course["syllabusSessions"]["courses"]
        .as_array_mut()
        .unwrap()
        .push(course);
    let mut duplicate_session = snapshot();
    let session = schedule_mut(&mut duplicate_session)["sessions"][0].clone();
    schedule_mut(&mut duplicate_session)["sessions"]
        .as_array_mut()
        .unwrap()
        .push(session);
    let mut duplicate_resource = snapshot();
    let resource = duplicate_resource["resources"][0].clone();
    duplicate_resource["resources"]
        .as_array_mut()
        .unwrap()
        .push(resource);
    let mut duplicate_receipt = file_snapshot();
    let receipt = duplicate_receipt["resources"][3]["items"][0].clone();
    duplicate_receipt["resources"][3]["items"]
        .as_array_mut()
        .unwrap()
        .push(receipt);
    for capture in [
        duplicate_course,
        duplicate_session,
        duplicate_resource,
        duplicate_receipt,
    ] {
        assert_eq!(
            reconcile_syllabus_sessions(&coursework(), &capture, &scopes()),
            Err(SyllabusSessionError)
        );
    }
}

#[test]
fn malformed_or_unresolved_fact_payloads_fail_without_partial_import() {
    let mut unexpected = snapshot();
    schedule_mut(&mut unexpected)["sessions"][0]["notes"] = json!("Cannot overwrite a note");
    let mut html = snapshot();
    schedule_mut(&mut html)["sessions"][0]["title"] = json!("<b>Class</b>");
    let mut unresolved = snapshot();
    schedule_mut(&mut unresolved)["status"] = json!("unresolved");
    schedule_mut(&mut unresolved)["reason"] = json!("AMBIGUOUS_SCHEDULE");
    let mut bad_reason = snapshot();
    schedule_mut(&mut bad_reason)["status"] = json!("unresolved");
    schedule_mut(&mut bad_reason)["sessions"] = json!([]);
    schedule_mut(&mut bad_reason)["reason"] = json!("Arbitrary private text");
    for capture in [unexpected, html, unresolved, bad_reason] {
        assert_eq!(
            reconcile_syllabus_sessions(&coursework(), &capture, &scopes()),
            Err(SyllabusSessionError)
        );
    }
}

#[test]
fn captured_unmapped_courses_are_not_assigned_to_a_local_course_by_guessing() {
    let merged = reconcile_syllabus_sessions(&coursework(), &snapshot(), &[]).unwrap();
    assert_eq!(merged, coursework());
}

#[test]
fn colliding_personal_identity_is_not_overwritten() {
    let added = reconcile_syllabus_sessions(&coursework(), &snapshot(), &scopes()).unwrap();
    let mut base = coursework();
    base["items"][0]["id"] = imported(&added)["id"].clone();
    assert_eq!(
        reconcile_syllabus_sessions(&base, &snapshot(), &scopes()),
        Err(SyllabusSessionError)
    );
}
