use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::browser_reconcile::reconcile_browser_coursework;
use crate::reconcile::CourseAssignments;

const MOCK: &str = include_str!("../../test/fixtures/refresh-canvas-mock.json");

fn fixture() -> (Value, Vec<CourseAssignments>) {
    let mock: Value = serde_json::from_str(MOCK).expect("synthetic JSON fixture");
    let mut latest = mock["priorLocalState"]["coursework.json"].clone();
    let captures = mock["apiResponses"]
        .as_object()
        .expect("course response map")
        .iter()
        .map(|(key, response)| CourseAssignments {
            key: key.clone(),
            groups: response["assignment_groups"]["body"]
                .as_array()
                .expect("synthetic groups")
                .clone(),
            assignments: response["assignments"]["body"]
                .as_array()
                .expect("synthetic assignments")
                .clone(),
        })
        .collect();
    let item = latest["items"]
        .as_array_mut()
        .expect("synthetic items")
        .iter_mut()
        .find(|item| item["id"] == "demo-alpha-70001")
        .expect("synthetic assignment");
    item["source"] = json!("ical");
    item.as_object_mut().expect("object").remove("canvasId");
    let owner = ical_owner("assignment:70001");
    item["sourceReferences"] = json!([owner.clone()]);
    item["fieldObservations"] = json!({
        "at": {
            "selected": {
                "owner": owner,
                "value": "2030-01-29T23:59:00.000Z",
                "observedAt": "2030-01-10T12:00:00Z"
            }
        }
    });
    item["at"] = json!("2030-01-29T23:59:00.000Z");
    (latest, captures)
}

fn ical_owner(id: &str) -> Value {
    json!({
        "institution": "synthetic.institution.invalid",
        "course": "demo-alpha",
        "source": "ical",
        "id": id
    })
}

fn captured_at() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_798_000_000)
}

fn assignment_item(document: &Value) -> &Value {
    document["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item["id"] == "demo-alpha-70001")
        .expect("linked assignment")
}

fn selected_source(item: &Value) -> &str {
    item["fieldObservations"]["at"]["selected"]["owner"]["source"]
        .as_str()
        .expect("selected source")
}

#[test]
fn newer_ical_due_stays_selected_and_canvas_remains_auditable() {
    let (latest, captures) = fixture();
    let result = reconcile_browser_coursework(&latest, &captures, captured_at()).expect("merge");
    let item = assignment_item(&result);
    assert_eq!(selected_source(item), "ical");
    assert_eq!(item["at"], "2030-01-29T23:59:00.000Z");
    assert!(item["fieldObservations"]["at"]["alternatives"]
        .as_array()
        .expect("alternatives")
        .iter()
        .any(|fact| fact["owner"]["source"] == "canvas"));
}

#[test]
fn older_ical_due_stays_as_an_alternative_to_fresh_canvas() {
    let (mut latest, captures) = fixture();
    latest["items"][0]["fieldObservations"]["at"]["selected"]["observedAt"] =
        json!("2020-01-10T12:00:00Z");
    let result = reconcile_browser_coursework(&latest, &captures, captured_at()).expect("merge");
    let item = assignment_item(&result);
    assert_eq!(selected_source(item), "canvas");
    assert_eq!(item["at"], "2026-11-27T23:59");
    assert_eq!(
        item["fieldObservations"]["at"]["alternatives"][0]["owner"]["source"],
        "ical"
    );
}

#[test]
fn unstamped_ical_due_is_preserved() {
    let (mut latest, captures) = fixture();
    latest["items"][0]["fieldObservations"]["at"]["selected"]
        .as_object_mut()
        .expect("fact")
        .remove("observedAt");
    let result = reconcile_browser_coursework(&latest, &captures, captured_at()).expect("merge");
    let item = assignment_item(&result);
    assert_eq!(selected_source(item), "ical");
    assert_eq!(item["at"], "2030-01-29T23:59:00.000Z");
    assert!(item["fieldObservations"]["at"]["alternatives"]
        .as_array()
        .expect("alternatives")
        .iter()
        .any(|fact| fact["owner"]["source"] == "canvas"));
}

#[test]
fn legacy_ical_due_without_observations_is_preserved_as_unstamped() {
    let (mut latest, captures) = fixture();
    let item = &mut latest["items"][0];
    item.as_object_mut()
        .expect("item")
        .remove("fieldObservations");
    item["at"] = json!("2030-01-29T23:59:00.000Z");
    let result = reconcile_browser_coursework(&latest, &captures, captured_at()).expect("merge");
    let item = assignment_item(&result);
    assert_eq!(selected_source(item), "ical");
    assert_eq!(item["at"], "2030-01-29T23:59:00.000Z");
    assert!(item["fieldObservations"]["at"]["selected"]
        .get("observedAt")
        .is_none());
    assert!(item["fieldObservations"]["at"]["alternatives"]
        .as_array()
        .expect("alternatives")
        .iter()
        .any(|fact| fact["owner"]["source"] == "canvas"));
}

#[test]
fn manual_progress_and_notes_survive_browser_reconciliation() {
    let (mut latest, captures) = fixture();
    latest["items"][0]["done"] = json!(true);
    latest["items"][0]["doneAt"] = json!("2030-01-11T09:00:00Z");
    latest["items"][0]["notes"] = json!("Keep this student note");
    let result = reconcile_browser_coursework(&latest, &captures, captured_at()).expect("merge");
    let item = assignment_item(&result);
    assert_eq!(item["done"], true);
    assert_eq!(item["doneAt"], "2030-01-11T09:00:00Z");
    assert_eq!(item["notes"], "Keep this student note");
}

#[test]
fn omitted_course_keeps_the_existing_ical_record_untouched() {
    let (latest, mut captures) = fixture();
    captures.retain(|capture| capture.key == "demo-beta");
    let before = latest["items"][0].clone();
    let result = reconcile_browser_coursework(&latest, &captures, captured_at()).expect("merge");
    let retained = assignment_item(&result);
    assert_eq!(retained, &before);
}

#[test]
fn matching_title_without_exact_reference_does_not_link() {
    let (mut latest, captures) = fixture();
    latest["items"][0]["sourceReferences"][0]["id"] = json!("unrelated-uid");
    let result = reconcile_browser_coursework(&latest, &captures, captured_at()).expect("merge");
    assert_eq!(assignment_item(&result)["source"], "ical");
    assert!(result["items"]
        .as_array()
        .expect("items")
        .iter()
        .any(|item| item["id"] == "demo-alpha-canvas-70001"));
}

#[test]
fn repeating_identical_capture_is_idempotent() {
    let (latest, captures) = fixture();
    let once = reconcile_browser_coursework(&latest, &captures, captured_at()).expect("first");
    let twice = reconcile_browser_coursework(&once, &captures, captured_at()).expect("second");
    assert_eq!(twice, once);
}
