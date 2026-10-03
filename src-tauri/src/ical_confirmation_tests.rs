use super::*;

fn identity(id: &str, local_id: &str) -> CalendarMember {
    CalendarMember {
        reference: json!({
            "institution": "synthetic.institution.invalid",
            "course": "course-a",
            "source": "ical",
            "id": format!("event:{id}"),
        }),
        local_id: local_id.to_owned(),
    }
}

fn metadata(root: &Map<String, Value>) -> Value {
    root.get(METADATA_FIELD).cloned().unwrap_or(Value::Null)
}

fn empty_coursework() -> Map<String, Value> {
    Map::from_iter([("items".into(), json!([]))])
}

#[test]
fn generation_is_stable_for_the_same_members_in_any_input_order() {
    let a = identity("a", "item-a");
    let b = identity("b", "item-b");
    let mut first = empty_coursework();
    let mut second = empty_coursework();

    apply(&mut first, &[a.clone(), b.clone()], true).unwrap();
    apply(&mut second, &[b, a], true).unwrap();

    assert_eq!(metadata(&first), metadata(&second));
    let generation = &first[METADATA_FIELD]["eligibleGeneration"];
    assert_eq!(generation["members"].as_array().unwrap().len(), 2);
    assert_eq!(generation["digest"].as_str().unwrap().len(), 64);
}

#[test]
fn only_an_eligible_feed_marks_prior_omissions_retained() {
    let a = identity("a", "item-a");
    let b = identity("b", "item-b");
    let c = identity("c", "item-c");
    let mut root = empty_coursework();
    apply(&mut root, &[a.clone(), b.clone()], true).unwrap();
    let baseline = metadata(&root)["eligibleGeneration"].clone();

    apply(&mut root, &[a.clone(), c], false).unwrap();
    assert_eq!(root[METADATA_FIELD]["eligibleGeneration"], baseline);
    assert_eq!(root[METADATA_FIELD]["retained"], json!([]));

    apply(&mut root, &[a], true).unwrap();
    assert_eq!(root[METADATA_FIELD]["retained"], json!(["item-b"]));
}

#[test]
fn accepted_positive_clears_item_retention_even_when_another_event_is_held() {
    let a = identity("a", "item-a");
    let b = identity("b", "item-b");
    let c = identity("c", "item-c");
    let mut root = empty_coursework();
    apply(&mut root, &[a.clone(), b.clone()], true).unwrap();
    apply(&mut root, &[a.clone()], true).unwrap();
    assert_eq!(root[METADATA_FIELD]["retained"], json!(["item-b"]));
    let baseline = root[METADATA_FIELD]["eligibleGeneration"].clone();

    apply(&mut root, &[b, c], false).unwrap();

    assert_eq!(root[METADATA_FIELD]["eligibleGeneration"], baseline);
    assert_eq!(root[METADATA_FIELD]["retained"], json!([]));
}

#[test]
fn first_eligible_feed_compares_existing_calendar_only_references_without_prior_metadata() {
    let b = identity("b", "legacy-calendar-item");
    let mut root = Map::from_iter([(
        "items".into(),
        json!([{
            "id": "legacy-calendar-item",
            "course": "course-a",
            "source": "ical",
            "sourceReferences": [b.reference.clone()],
        }]),
    )]);

    apply(&mut root, &[], false).unwrap();
    assert!(root.get(METADATA_FIELD).is_none());
    apply(&mut root, &[], true).unwrap();

    assert_eq!(
        root[METADATA_FIELD]["retained"],
        json!(["legacy-calendar-item"])
    );
}

#[test]
fn accepted_item_from_a_held_feed_is_compared_on_the_next_eligible_feed() {
    let b = identity("b", "partial-calendar-item");
    let mut root = Map::from_iter([(
        "items".into(),
        json!([{
            "id": "partial-calendar-item",
            "course": "course-a",
            "source": "ical",
            "sourceReferences": [b.reference.clone()],
        }]),
    )]);

    apply(&mut root, &[b], false).unwrap();
    assert!(root.get(METADATA_FIELD).is_none());
    apply(&mut root, &[], true).unwrap();

    assert_eq!(
        root[METADATA_FIELD]["retained"],
        json!(["partial-calendar-item"])
    );
}

#[test]
fn canvas_provenance_suppresses_retention_but_assignment_aliases_do_not() {
    let canvas_backed = identity("b", "canvas-backed-item");
    let calendar_only = json!({
        "institution": "synthetic.institution.invalid",
        "course": "course-a",
        "source": "ical",
        "id": "assignment:990002",
    });
    let mut root = Map::from_iter([(
        "items".into(),
        json!([
            {
                "id": "canvas-backed-item",
                "course": "course-a",
                "source": "ical",
                "fieldObservations": {"title": {"owner": {"source": "canvas"}}},
                "sourceReferences": [
                    canvas_backed.reference.clone(),
                    {"institution":"synthetic.institution.invalid", "course":"course-a", "source":"canvas", "id":"910002"}
                ],
            },
            {
                "id": "calendar-only-item",
                "course": "course-a",
                "source": "ical",
                "sourceReferences": [
                    calendar_only,
                    {"institution":"synthetic.institution.invalid", "course":"course-a", "source":"canvas", "id":"990002"}
                ],
            }
        ]),
    )]);

    apply(&mut root, &[], true).unwrap();

    assert_eq!(
        root[METADATA_FIELD]["retained"],
        json!(["calendar-only-item"])
    );
}
