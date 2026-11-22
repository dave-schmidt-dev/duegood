use serde_json::json;

use super::{assignment_rubric_fields, complete_assignment_rubric_fields};

#[test]
fn projects_only_the_supported_rubric_contract() {
    let assignment = json!({
        "rubric": [{
            "id": "criterion-1",
            "description": "Evidence",
            "long_description": "Use two sources. See https://private.invalid/source",
            "points": 5,
            "ratings": [{
                "description": "Strong",
                "long_description": "Clear and relevant",
                "points": 5,
                "private_extension": "discard this"
            }],
            "private_extension": "discard this"
        }],
        "rubric_settings": {
            "title": "Essay rubric",
            "points_possible": 5,
            "free_form_criterion_comments": true,
            "unknown": "discard this"
        },
        "use_rubric_for_grading": true,
        "unknown": "discard this"
    });

    let projected = assignment_rubric_fields(&assignment).expect("valid rubric");
    assert_eq!(projected["rubric"][0]["id"], "criterion-1");
    assert_eq!(projected["rubric"][0]["description"], "Evidence");
    assert_eq!(
        projected["rubric"][0]["long_description"],
        "Use two sources. See [link]"
    );
    assert_eq!(projected["rubric"][0]["points"], 5);
    assert_eq!(
        projected["rubric"][0]["ratings"][0]["description"],
        "Strong"
    );
    assert_eq!(
        projected["rubric"][0]["ratings"][0]["long_description"],
        "Clear and relevant"
    );
    assert_eq!(projected["rubric"][0]["ratings"][0]["points"], 5);
    assert!(projected["rubric"][0].get("private_extension").is_none());
    assert!(projected["rubric_settings"].get("unknown").is_none());
    assert_eq!(projected["use_rubric_for_grading"], true);
}

#[test]
fn keeps_omitted_rubric_unknown_and_explicit_null_known_absent() {
    let old_assignment = json!({ "name": "Old capture" });
    assert!(assignment_rubric_fields(&old_assignment)
        .expect("old capture projects")
        .get("rubric")
        .is_none());
    assert_eq!(
        complete_assignment_rubric_fields(&old_assignment).expect("complete read")["rubric"],
        json!(null)
    );
    assert_eq!(
        assignment_rubric_fields(&json!({ "rubric": null })).expect("explicit absence")["rubric"],
        json!(null)
    );
}

#[test]
fn rejects_malformed_rubric_settings_and_criteria() {
    assert!(assignment_rubric_fields(&json!({
        "rubric_settings": { "title": 10 }
    }))
    .is_err());
    assert!(assignment_rubric_fields(&json!({
        "rubric_settings": { "points_possible": "5" }
    }))
    .is_err());
    assert!(assignment_rubric_fields(&json!({
        "rubric": [{ "ratings": [{ "points": "5" }] }]
    }))
    .is_err());
    assert!(assignment_rubric_fields(&json!({ "rubric": {} })).is_err());
}
