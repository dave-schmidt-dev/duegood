use super::dates::utc_to_new_york;
use super::*;

const MOCK: &str = include_str!("../../test/fixtures/refresh-canvas-mock.json");

fn fixture_capture() -> (Value, Vec<CourseAssignments>) {
    let mock: Value = serde_json::from_str(MOCK).expect("synthetic fixture JSON");
    let base = mock["priorLocalState"]["coursework.json"].clone();
    let captures = mock["apiResponses"]
        .as_object()
        .expect("course captures")
        .iter()
        .map(|(key, response)| CourseAssignments {
            key: key.clone(),
            groups: response["assignment_groups"]["body"]
                .as_array()
                .expect("groups")
                .clone(),
            assignments: response["assignments"]["body"]
                .as_array()
                .expect("assignments")
                .iter()
                .filter(|value| value.is_object() && value.get("id").is_some())
                .cloned()
                .collect(),
            discussions: vec![],
        })
        .collect();
    (base, captures)
}

fn captured_at() -> SystemTime {
    std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_798_000_000)
}

#[test]
fn fixture_reconciles_assignment_fields_and_keeps_personal_state() {
    let (mut base, captures) = fixture_capture();
    base["items"][0]["done"] = json!(true);
    base["items"][0]["doneAt"] = json!("2026-11-18T12:00:00Z");
    base["items"][0]["privateExtension"] = json!({"kept": true});

    let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    let items = result["items"].as_array().expect("items");
    let retained = items
        .iter()
        .find(|item| item["canvasId"] == json!(70001))
        .expect("retained assignment");
    assert_eq!(retained["id"], "demo-alpha-70001");
    assert_eq!(retained["title"], "Draft Essay v2");
    assert_eq!(retained["at"], "2026-11-27T23:59");
    assert_eq!(retained["submissionStatus"], "graded");
    assert_eq!(retained["done"], true);
    assert_eq!(retained["doneAt"], "2026-11-18T12:00:00Z");
    assert_eq!(retained["privateExtension"]["kept"], true);
    assert!(items
        .iter()
        .any(|item| item["id"] == "demo-alpha-session-1"));
    assert!(!items.iter().any(|item| item["canvasId"] == json!(80001)));
    assert!(items
        .iter()
        .any(|item| item["id"] == "demo-alpha-canvas-70002"));
    assert_eq!(
        result["archivedForecastItems"][0]["id"],
        "demo-alpha-forecast-1"
    );
    assert_eq!(result["courses"][0]["gradeGroups"][0]["weight"], 40);
}

#[test]
fn rubric_round_trips_through_assignment_reconciliation() {
    let (base, mut captures) = fixture_capture();
    let capture = captures
        .iter_mut()
        .find(|capture| capture.key == "demo-alpha")
        .unwrap();
    let assignment = &mut capture.assignments[0];
    assignment["rubric"] = json!([{
        "id": "criterion-1",
        "description": "Evidence",
        "long_description": "Use two sources",
        "points": 5,
        "ratings": [{ "description": "Strong", "long_description": "Clear", "points": 5 }]
    }]);
    assignment["rubric_settings"] = json!({
        "title": "Essay rubric",
        "points_possible": 5,
        "free_form_criterion_comments": true
    });
    assignment["use_rubric_for_grading"] = json!(true);
    let canvas_id = assignment["id"].clone();

    let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    let item = result["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item.get("canvasId") == Some(&canvas_id))
        .expect("reconciled assignment");
    assert_eq!(item["rubric"]["criteria"][0]["id"], "criterion-1");
    assert_eq!(item["rubric"]["criteria"][0]["ratings"][0]["points"], 5);
    assert_eq!(item["rubric"]["settings"]["title"], "Essay rubric");
    assert_eq!(item["rubric"]["settings"]["pointsPossible"], 5);
    assert_eq!(
        item["rubric"]["settings"]["freeFormCriterionComments"],
        true
    );
    assert_eq!(item["rubric"]["useForGrading"], true);
}

#[test]
fn body_html_structured_text_and_canvas_timestamps_round_trip() {
    let (base, mut captures) = fixture_capture();
    let assignment = &mut captures[0].assignments[0];
    assignment["detail"] = json!("First paragraph.\n\n- First item\n- Second item");
    assignment["bodyHtml"] = json!("<p>First paragraph.</p><ul><li>First item</li><li>Second item</li></ul>");
    assignment["bodyEmpty"] = json!(false);
    assignment["due_at"] = json!("2026-11-28T04:59:00Z");
    assignment["created_at"] = json!("2026-11-01T15:00:00Z");
    assignment["updated_at"] = json!("2026-11-20T18:00:00Z");
    assignment["posted_at"] = json!("2026-11-20T18:05:00Z");
    assignment["delayed_post_at"] = json!("2026-11-20T18:05:00Z");
    assignment["unlock_at"] = json!("2026-11-20T18:05:00Z");
    assignment["lock_at"] = json!("2026-11-29T04:59:00Z");

    let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    let item = result["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["canvasId"] == json!(70001))
        .expect("reconciled assignment");
    assert_eq!(
        item["detail"],
        "First paragraph.\n\n- First item\n- Second item"
    );
    assert_eq!(
        item["bodyHtml"],
        "<p>First paragraph.</p><ul><li>First item</li><li>Second item</li></ul>"
    );
    assert_eq!(item["dueAtUtc"], "2026-11-28T04:59:00Z");
    assert_eq!(item["createdAt"], "2026-11-01T15:00:00Z");
    assert_eq!(item["updatedAt"], "2026-11-20T18:00:00Z");
    assert_eq!(item["postedAt"], "2026-11-20T18:05:00Z");
    assert_eq!(item["delayedPostAt"], "2026-11-20T18:05:00Z");
    assert_eq!(item["unlockAt"], "2026-11-20T18:05:00Z");
    assert_eq!(item["lockAt"], "2026-11-29T04:59:00Z");
}

#[test]
fn omitted_body_preserves_previous_body_but_known_empty_body_is_recorded() {
    let (mut base, mut captures) = fixture_capture();
    let prior = base["items"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|item| item["canvasId"] == 70001)
        .unwrap();
    prior["detail"] = json!("Previously imported body");
    prior["bodyHtml"] = json!("<p>Previously imported body</p>");
    let alpha_index = captures
        .iter_mut()
        .position(|capture| capture.key == "demo-alpha")
        .unwrap();
    let assignment_index = captures[alpha_index]
        .assignments
        .iter()
        .position(|assignment| assignment["id"] == 70001)
        .unwrap();
    for field in ["detail", "bodyHtml", "bodyEmpty"] {
        captures[alpha_index].assignments[assignment_index]
            .as_object_mut()
            .unwrap()
            .remove(field);
    }
    let missing = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    let retained = missing["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["canvasId"] == 70001)
        .unwrap();
    assert_eq!(retained["detail"], "Previously imported body");
    assert_eq!(retained["bodyHtml"], "<p>Previously imported body</p>");

    captures[alpha_index].assignments[assignment_index]["detail"] = json!("");
    captures[alpha_index].assignments[assignment_index]["bodyHtml"] = json!("");
    captures[alpha_index].assignments[assignment_index]["bodyEmpty"] = json!(true);
    let known_empty = reconcile_coursework(&base, &captures, captured_at()).expect("empty body");
    let cleared = known_empty["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["canvasId"] == 70001)
        .unwrap();
    assert_eq!(cleared["detail"], "");
    assert_eq!(cleared["bodyHtml"], "");
    assert_eq!(cleared["bodyEmpty"], true);
}

#[test]
fn discussion_and_assignment_with_same_canvas_id_keep_separate_identities() {
    let (base, mut captures) = fixture_capture();
    let alpha_index = captures
        .iter_mut()
        .position(|capture| capture.key == "demo-alpha")
        .unwrap();
    captures[alpha_index].discussions = vec![json!({
        "id": 70001,
        "title": "Synthetic ungraded topic",
        "detail": "Original discussion text",
        "bodyHtml": "<p>Original discussion text</p>",
        "bodyEmpty": false,
        "created_at": "2026-11-01T15:00:00Z",
        "posted_at": "2026-11-20T18:05:00Z",
        "delayed_post_at": "2026-11-20T18:05:00Z",
        "unlock_at": "2026-11-20T18:05:00Z",
        "lock_at": "2026-11-29T04:59:00Z",
        "due_at": "2026-11-28T04:59:00Z"
    })];

    let first = reconcile_coursework(&base, &captures, captured_at()).expect("first refresh");
    let discussion_id = "demo-alpha-canvas-discussion-70001";
    let discussion = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == discussion_id)
        .expect("standalone discussion");
    assert_eq!(discussion["canvasResourceType"], "discussion");
    assert_eq!(discussion["canvasId"], 70001);
    assert_eq!(discussion["dueAtUtc"], "2026-11-28T04:59:00Z");
    assert!(first["items"].as_array().unwrap().iter().any(|item| {
        item["canvasResourceType"] == "assignment" && item["canvasId"] == 70001
    }));

    captures[alpha_index].discussions[0]["detail"] = json!("Updated discussion text");
    captures[alpha_index].discussions[0]["bodyHtml"] = json!("<p>Updated discussion text</p>");
    let second = reconcile_coursework(&first, &captures, captured_at()).expect("second refresh");
    let discussions = second["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["canvasResourceType"] == "discussion")
        .collect::<Vec<_>>();
    assert_eq!(discussions.len(), 1);
    assert_eq!(discussions[0]["detail"], "Updated discussion text");
    assert_eq!(discussions[0]["bodyHtml"], "<p>Updated discussion text</p>");

    let omitted = CourseAssignments {
        key: captures[alpha_index].key.clone(),
        groups: captures[alpha_index].groups.clone(),
        assignments: captures[alpha_index].assignments.clone(),
        discussions: vec![],
    };
    let after_omission = reconcile_coursework(&second, &[omitted], captured_at())
        .expect("omitted discussion remains");
    assert!(after_omission["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == discussion_id));
}

#[test]
fn explicit_no_rubric_is_known_absent_but_old_omissions_are_preserved() {
    let (mut base, mut captures) = fixture_capture();
    let assignment = &mut captures[0].assignments[0];
    let canvas_id = assignment["id"].clone();
    assignment["rubric"] = Value::Null;
    let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    let item = result["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item.get("canvasId") == Some(&canvas_id))
        .expect("reconciled assignment");
    assert_eq!(item["rubric"], Value::Null);

    let (base_without_rubric, captures_without_rubric) = fixture_capture();
    let old_rubric = json!({ "criteria": [] });
    let existing_item = base["items"]
        .as_array_mut()
        .expect("items")
        .iter_mut()
        .find(|item| item.get("canvasId") == Some(&canvas_id));
    if let Some(item) = existing_item {
        item["rubric"] = old_rubric.clone();
        let result = reconcile_coursework(&base, &captures_without_rubric, captured_at())
            .expect("legacy reconcile");
        let retained = result["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item.get("canvasId") == Some(&canvas_id))
            .expect("reconciled assignment");
        assert_eq!(retained["rubric"], old_rubric);
    } else {
        let result = reconcile_coursework(
            &base_without_rubric,
            &captures_without_rubric,
            captured_at(),
        )
        .expect("legacy reconcile");
        let created = result["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item.get("canvasId") == Some(&canvas_id))
            .expect("reconciled assignment");
        assert!(created.get("rubric").is_none());
    }
}

#[test]
fn incomplete_course_capture_does_not_remove_omitted_course_items() {
    let (base, mut captures) = fixture_capture();
    captures.retain(|capture| capture.key == "demo-beta");
    let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    assert!(result["items"].as_array().unwrap().iter().any(|item| {
        item["id"] == "demo-alpha-70001"
            || item["id"] == "demo-beta-80002"
            || item["canvasId"] == json!(80001)
    }));
    assert!(result["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == "demo-alpha-forecast-1"));
}

#[test]
fn vanished_canvas_items_are_archived_verbatim_and_old_archives_remain() {
    let (mut base, mut captures) = fixture_capture();
    captures
        .iter_mut()
        .find(|capture| capture.key == "demo-alpha")
        .unwrap()
        .assignments
        .retain(|assignment| assignment["id"] != 70001);
    base["items"][0]["done"] = json!(true);
    base["items"][0]["extension"] = json!("preserved");
    base["archivedForecastItems"] = json!([{"id":"older-archive","opaque":7}]);

    let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    assert!(!result["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["canvasId"] == 70001));
    assert_eq!(result["archivedForecastItems"][0]["id"], "older-archive");
    assert_eq!(result["archivedForecastItems"][1]["done"], true);
    assert_eq!(result["archivedForecastItems"][1]["extension"], "preserved");
}

fn ids(result: &Value) -> Vec<String> {
    result["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(result["archivedForecastItems"].as_array().unwrap())
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn reappearing_canvas_assignment_revives_archived_progress_without_duplicate_ids() {
    let (mut base, captures) = fixture_capture();
    base["items"][0]["done"] = json!(true);
    base["items"][0]["doneAt"] = json!("2026-11-18T12:00:00Z");
    base["items"][0]["notes"] = json!("keep me");
    let mut vanished = captures.clone();
    vanished
        .iter_mut()
        .find(|capture| capture.key == "demo-alpha")
        .unwrap()
        .assignments
        .retain(|assignment| assignment["id"] != 70001);

    let archived = reconcile_coursework(&base, &vanished, captured_at()).expect("vanish");
    assert!(!ids(&archived).iter().all(|id| id != "demo-alpha-70001"));
    let revived = reconcile_coursework(&archived, &captures, captured_at()).expect("revive");
    let item = revived["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["canvasId"] == json!(70001))
        .expect("revived item is live");
    assert_eq!(item["id"], "demo-alpha-70001");
    assert_eq!(item["done"], true);
    assert_eq!(item["doneAt"], "2026-11-18T12:00:00Z");
    assert_eq!(item["notes"], "keep me");
    let all = ids(&revived);
    let unique: HashSet<&String> = all.iter().collect();
    assert_eq!(all.len(), unique.len(), "no duplicate ids: {all:?}");

    // A second vanish archives the live item again instead of silently dropping it.
    base = revived;
    base["items"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|item| item["canvasId"] == json!(70001))
        .unwrap()["notes"] = json!("newer note");
    let again = reconcile_coursework(&base, &vanished, captured_at()).expect("vanish again");
    let archived_copy = again["archivedForecastItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["canvasId"] == json!(70001))
        .expect("archived again");
    assert_eq!(archived_copy["notes"], "newer note");
    assert_eq!(archived_copy["done"], true);
    let all = ids(&again);
    let unique: HashSet<&String> = all.iter().collect();
    assert_eq!(all.len(), unique.len(), "no duplicate ids: {all:?}");
}

#[test]
fn no_op_preserves_sync_timestamp_and_document_exactly() {
    let (base, captures) = fixture_capture();
    let once = reconcile_coursework(&base, &captures, captured_at()).expect("first reconcile");
    let again = reconcile_coursework(&once, &captures, captured_at()).expect("no-op reconcile");
    assert_eq!(again, once);
    assert_eq!(again["sync"]["lastSync"], once["sync"]["lastSync"]);
}

#[test]
fn flat_canvas_due_observations_preserve_metadata_alternatives_and_no_op_identity() {
    let (mut base, captures) = fixture_capture();
    let owner = json!({"institution":"synthetic.institution.invalid","course":"demo-alpha","source":"canvas","id":"70001"});
    let alternative = json!({"owner":{"institution":"synthetic.institution.invalid","course":"demo-alpha","source":"ical","id":"assignment:70001"},"value":"2030-01-29T23:59Z","extension":{"keep":true}});
    base["items"][0]["sourceReferences"] = json!([owner.clone(), alternative["owner"].clone()]);
    base["items"][0]["fieldObservations"] = json!({"at":{
            "owner":owner,"value":base["items"][0]["at"].clone(),"observedAt":"2020-01-01T00:00:00Z",
            "extension":{"keep":true},"alternatives":[alternative.clone()]
        },"otherExtension":{"keep":true}});
    let result = reconcile_coursework(&base, &captures, captured_at()).expect("flat merge");
    let item = result["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == base["items"][0]["id"])
        .unwrap();
    let observation = &item["fieldObservations"]["at"];
    assert!(observation.get("selected").is_none());
    assert_eq!(observation["owner"]["source"], "canvas");
    assert_eq!(observation["extension"], json!({"keep":true}));
    assert_eq!(observation["alternatives"], json!([alternative]));
    assert_eq!(
        item["fieldObservations"]["otherExtension"],
        json!({"keep":true})
    );
    let repeated = reconcile_coursework(&result, &captures, SystemTime::now()).expect("flat no-op");
    assert_eq!(repeated, result);

    for nested in [false, true] {
        let (mut base, captures) = fixture_capture();
        let owner = json!({"institution":"synthetic.institution.invalid","course":"demo-alpha","source":"canvas","id":"70001"});
        let mut observation = json!({"owner":owner.clone(),"value":base["items"][0]["at"].clone(),
                "observedAt":"2020-01-01T00:00:00Z","extension":{"keep":true}});
        if nested {
            observation = json!({"selected":observation});
        }
        observation["recordExtension"] = json!("keep");
        observation["alternatives"] = json!([{"owner":owner.clone(),"value":"stale Canvas date"}]);
        base["items"][0]["sourceReferences"] = json!([owner]);
        base["items"][0]["fieldObservations"] = json!({"at":observation});
        let result = reconcile_coursework(&base, &captures, captured_at())
            .expect("clear stale Canvas alternative");
        let item = result["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == base["items"][0]["id"])
            .unwrap();
        let observation = &item["fieldObservations"]["at"];
        assert_eq!(observation.get("selected").is_some(), nested);
        assert!(observation.get("alternatives").is_none());
        assert_eq!(observation["recordExtension"], "keep");
        let selected = observation.get("selected").unwrap_or(observation);
        assert_eq!(selected["value"], "2026-11-27T23:59");
        assert_eq!(selected["extension"], json!({"keep":true}));
        assert_eq!(
            reconcile_coursework(&result, &captures, SystemTime::now())
                .expect("repeat cleared alternatives"),
            result
        );
    }
}

#[test]
fn malformed_flat_and_nested_due_observations_still_fail_closed() {
    for observation in [
        Value::Null,
        json!({}),
        json!({"owner":null,"value":"date"}),
        json!({"owner":{},"alternatives":[]}),
        json!({"selected":null}),
        json!({"selected":{"value":"date"}}),
    ] {
        let (mut base, captures) = fixture_capture();
        base["items"][0]["sourceReferences"] = json!([{"institution":"synthetic.institution.invalid","course":"demo-alpha","source":"canvas","id":"70001"}]);
        base["items"][0]["fieldObservations"] = json!({"at":observation});
        assert_eq!(
            reconcile_coursework(&base, &captures, captured_at())
                .unwrap_err()
                .to_string(),
            "field observations are malformed"
        );
    }
}

#[test]
fn omitted_submission_fields_and_unknown_group_fields_survive() {
    let (mut base, mut captures) = fixture_capture();
    let alpha = captures
        .iter_mut()
        .find(|capture| capture.key == "demo-alpha")
        .unwrap();
    alpha.assignments[0]
        .as_object_mut()
        .unwrap()
        .remove("submission");
    base["courses"][0]["courseExtension"] = json!("keep");
    base["courses"][0]["gradeGroups"] = json!([
        {"id":601,"name":"Old label","weight":10,"groupExtension":"keep"},
        {"id":777,"localOnly":true}
    ]);

    let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    let retained = result["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["canvasId"] == 70001)
        .unwrap();
    assert_eq!(retained["submissionStatus"], "pending");
    assert_eq!(result["courses"][0]["courseExtension"], "keep");
    assert_eq!(result["courses"][0]["gradeGroups"][0]["name"], "Essays");
    assert_eq!(
        result["courses"][0]["gradeGroups"][0]["groupExtension"],
        "keep"
    );
    assert_eq!(result["courses"][0]["gradeGroups"][1]["localOnly"], true);
}

#[test]
fn verified_ical_assignment_adopts_its_immutable_local_id_and_keeps_both_facts() {
    let (mut base, captures) = fixture_capture();
    let item = base["items"][0].as_object_mut().unwrap();
    item.insert("id".into(), json!("ical-local-immutable"));
    item.insert("source".into(), json!("ical"));
    item.remove("canvasId");
    item.insert("at".into(), json!("2026-11-19T23:59"));
    item.insert("done".into(), json!(true));
    item.insert("grade".into(), json!("local-grade-preserved"));
    item.insert("notesExtension".into(), json!({"keep": true}));
    item.insert(
        "sourceReferences".into(),
        json!([{
            "institution":"synthetic.institution.invalid", "course":"demo-alpha",
            "source":"ical", "id":"assignment:70001"
        }]),
    );
    item.insert("fieldObservations".into(), json!({"at":{"selected":{
            "owner":{"institution":"synthetic.institution.invalid","course":"demo-alpha","source":"ical","id":"assignment:70001"},
            "value":"2026-11-19T23:59","observedAt":"2026-11-01T00:00:00Z"
        }}}));

    let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    let linked = result["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "ical-local-immutable")
        .unwrap();
    assert_eq!(linked["canvasId"], 70001);
    assert_eq!(linked["source"], "canvas");
    assert_eq!(linked["done"], true);
    assert_eq!(linked["grade"], "A-");
    assert_eq!(linked["notesExtension"]["keep"], true);
    assert_eq!(linked["sourceReferences"].as_array().unwrap().len(), 2);
    assert_eq!(
        linked["fieldObservations"]["at"]["selected"]["owner"]["source"],
        "canvas"
    );
    assert_eq!(
        linked["fieldObservations"]["at"]["alternatives"][0]["owner"]["source"],
        "ical"
    );
    assert_eq!(
        linked["fieldObservations"]["at"]["selected"]["observedAt"]
            .as_str()
            .unwrap(),
        crate::store::utc_stamp(captured_at()).iso
    );

    let repeated = reconcile_coursework(&result, &captures, SystemTime::now()).expect("repeat");
    assert_eq!(
        repeated, result,
        "unchanged Canvas observations keep their first timestamp"
    );
}

#[test]
fn conflicting_or_ambiguous_verified_candidates_fail_closed_without_fuzzy_linking() {
    let (mut base, captures) = fixture_capture();
    base["items"].as_array_mut().unwrap().push(json!({
            "id":"ical-a", "course":"demo-alpha", "source":"ical", "title":"same title",
            "at":"2026-11-27T23:59", "sourceReferences":[{
              "institution":"synthetic.institution.invalid", "course":"demo-alpha", "source":"ical", "id":"assignment:70001"
            }]
        }));
    let error = reconcile_coursework(&base, &captures, captured_at()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Canvas assignment has conflicting local identities"
    );

    base["items"].as_array_mut().unwrap().pop();
    base["items"][0]["title"] = json!("same title but no verified alias");
    base["items"][0]["at"] = json!("2026-11-27T23:59");
    base["items"][0].as_object_mut().unwrap().remove("canvasId");
    base["items"][0]["source"] = json!("ical");
    base["items"][0]["sourceReferences"] = json!([{
      "institution":"synthetic.institution.invalid", "course":"demo-alpha", "source":"ical", "id":"unrelated-uid"
    }]);
    let result = reconcile_coursework(&base, &captures, captured_at()).expect("no fuzzy link");
    assert!(result["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == base["items"][0]["id"]));
    assert!(result["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == "demo-alpha-canvas-70001"));
}

#[test]
fn complete_capture_archives_canvas_but_never_archives_ical_for_a_rolling_omission() {
    let (mut base, mut captures) = fixture_capture();
    captures
        .iter_mut()
        .find(|capture| capture.key == "demo-alpha")
        .unwrap()
        .assignments
        .retain(|assignment| assignment["id"] != 70001);
    base["items"].as_array_mut().unwrap().push(json!({
            "id":"rolling-ical", "course":"demo-alpha", "source":"ical", "title":"iCal retained",
            "sourceReferences":[{"institution":"synthetic.institution.invalid","course":"demo-alpha","source":"ical","id":"assignment:70001"}]
        }));
    let result = reconcile_coursework(&base, &captures, captured_at()).expect("reconcile");
    assert!(result["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == "rolling-ical"));
    assert!(result["archivedForecastItems"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == "demo-alpha-70001"));
}

#[test]
fn error_display_does_not_include_course_identity() {
    let base = json!({"courses":[],"items":[]});
    let capture = CourseAssignments {
        key: "SYNTHETIC_PRIVATE_COURSE_KEY".to_owned(),
        groups: Vec::new(),
        assignments: Vec::new(),
        discussions: Vec::new(),
    };
    let error = reconcile_coursework(&base, &[capture], captured_at()).unwrap_err();
    assert!(!error.to_string().contains("SYNTHETIC_PRIVATE_COURSE_KEY"));
}

#[test]
fn generated_item_id_collision_fails_closed() {
    let (mut base, captures) = fixture_capture();
    base["items"].as_array_mut().unwrap().push(json!({
        "id": "demo-alpha-canvas-70002",
        "course": "demo-alpha",
        "source": "manual",
        "title": "Local item"
    }));

    let error = reconcile_coursework(&base, &captures, captured_at()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "generated coursework item id collides with an existing item"
    );
}

#[test]
fn date_conversion_observes_eastern_standard_and_daylight_time() {
    assert_eq!(
        utc_to_new_york("2026-11-28T04:59:00Z").unwrap(),
        "2026-11-27T23:59"
    );
    assert_eq!(
        utc_to_new_york("2026-07-01T16:00:00Z").unwrap(),
        "2026-07-01T12:00"
    );
    assert_eq!(
        utc_to_new_york("2026-01-01T04:00:00+00:00").unwrap(),
        "2025-12-31T23:00"
    );
}

#[test]
fn kind_inference_uses_name_and_submission_type_fallback() {
    assert_eq!(
        kind_for(&json!({"name":"Draft Essay", "submission_types":["online_upload"]})),
        "paper"
    );
    assert_eq!(
        kind_for(&json!({"name":"Reading Reflection 3", "submission_types":["online_text_entry"]})),
        "assignment"
    );
    assert_eq!(
        kind_for(&json!({"name":"Untitled", "submission_types":["online_quiz"]})),
        "quiz"
    );
}
