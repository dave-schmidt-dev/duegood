use super::*;
use serde_json::json;

fn receipts() -> (Value, Value) {
    (
        json!({"format":"duegood-browser-import","version":1,"runId":5,"generationId":"0123456789abcdef0123456789abcdef","userId":7,"observedAt":"2026-09-27T20:00:00Z","sections":[{"courseId":9,"endpoint":"assignments","status":"complete"},{"courseId":9,"endpoint":"fileBodies","status":"gap"}]}),
        json!({"runId":5,"generationId":"0123456789abcdef0123456789abcdef","userId":7,"status":"captured"}),
    )
}

#[test]
fn matching_import_preserves_independent_file_gap() {
    let (imported, attempt) = receipts();
    let status = project_freshness(Some(&imported), Some(&attempt));
    assert!(status.current);
    assert!(status.sections[0].current);
    assert!(!status.sections[1].current);
}

#[test]
fn later_running_failed_or_unavailable_attempt_invalidates_prior_facts() {
    let (imported, mut attempt) = receipts();
    for state in ["running", "failed"] {
        attempt["status"] = json!(state);
        assert!(!project_freshness(Some(&imported), Some(&attempt)).current);
    }
    assert!(!project_freshness(Some(&imported), None).current);
    attempt["status"] = json!("captured");
    attempt["runId"] = json!(6);
    assert!(!project_freshness(Some(&imported), Some(&attempt)).current);
}

#[test]
fn older_run_wrong_account_or_generation_never_qualifies() {
    let (imported, attempt) = receipts();
    for (field, value) in [
        ("runId", json!(4)),
        ("userId", json!(8)),
        ("generationId", json!("other")),
    ] {
        let mut changed = attempt.clone();
        changed[field] = value;
        assert!(!project_freshness(Some(&imported), Some(&changed)).current);
    }
}

#[test]
fn duplicate_or_malformed_coverage_is_unknown() {
    let (mut imported, attempt) = receipts();
    let duplicate = imported["sections"][0].clone();
    imported["sections"].as_array_mut().unwrap().push(duplicate);
    assert!(!project_freshness(Some(&imported), Some(&attempt)).current);
    imported["sections"] = json!([{"courseId":0,"endpoint":"assignments","status":"complete"}]);
    assert!(!project_freshness(Some(&imported), Some(&attempt)).current);
}

#[test]
fn capture_availability_asks_for_boolean_confirmation_without_serializing_account_id() {
    let (imported, attempt_value) = receipts();
    let freshness = project_freshness(Some(&imported), Some(&attempt_value));
    let attempt = crate::capture_run::CaptureAttempt {
        run_id: 5,
        status: crate::capture_run::CaptureAttemptStatus::Captured,
        generation_id: Some("0123456789abcdef0123456789abcdef".into()),
        snapshot_sha256: Some("a".repeat(64)),
        user_id: Some(7),
    };
    let summary = crate::capture_run::PublishedGenerationSummary {
        generation_id: "0123456789abcdef0123456789abcdef".into(),
        user_id: 7,
        captured_at: "2026-09-27T20:00:00Z".into(),
        active_course_count: 2,
        resource_count: 8,
        item_count: 24,
        blob_count: 3,
        blob_bytes: 900,
    };
    let projected = with_capture_availability(
        freshness,
        true,
        Some(&attempt),
        Some(&summary),
        ExistingAccountBinding::Unbound,
    );
    let availability = projected.capture_availability.as_ref().unwrap();
    assert!(availability.available);
    assert!(availability.account_confirmation_needed);
    assert_eq!(availability.reason, "confirmation-required");
    let serialized = serde_json::to_string(&projected).unwrap();
    assert!(!serialized.contains("userId"));
    assert!(!serialized.contains("\"7\""));
}

#[test]
fn existing_mismatched_account_never_requests_rebinding() {
    let freshness = project_freshness(None, None);
    let attempt = crate::capture_run::CaptureAttempt {
        run_id: 5,
        status: crate::capture_run::CaptureAttemptStatus::Captured,
        generation_id: Some("0123456789abcdef0123456789abcdef".into()),
        snapshot_sha256: Some("a".repeat(64)),
        user_id: Some(7),
    };
    let summary = crate::capture_run::PublishedGenerationSummary {
        generation_id: "0123456789abcdef0123456789abcdef".into(),
        user_id: 7,
        captured_at: "2026-09-27T20:00:00Z".into(),
        active_course_count: 2,
        resource_count: 8,
        item_count: 24,
        blob_count: 3,
        blob_bytes: 900,
    };
    let projected = with_capture_availability(
        freshness,
        true,
        Some(&attempt),
        Some(&summary),
        ExistingAccountBinding::Bound(8),
    );
    let availability = projected.capture_availability.unwrap();
    assert!(!availability.available);
    assert!(!availability.account_confirmation_needed);
    assert_eq!(availability.reason, "account-mismatch");
}

#[test]
fn invalid_current_pointer_does_not_leave_imported_facts_marked_current() {
    let (imported, attempt_value) = receipts();
    let attempt = crate::capture_run::CaptureAttempt {
        run_id: 5,
        status: crate::capture_run::CaptureAttemptStatus::Captured,
        generation_id: Some("0123456789abcdef0123456789abcdef".into()),
        snapshot_sha256: Some("a".repeat(64)),
        user_id: Some(7),
    };
    let freshness = project_freshness(Some(&imported), Some(&attempt_value));
    let projected = with_capture_availability(
        freshness,
        true,
        Some(&attempt),
        None,
        ExistingAccountBinding::Unbound,
    );
    assert!(!projected.current);
    assert_eq!(projected.reason, "capture-unverified");
    assert!(projected.sections.is_empty());
    assert_eq!(
        projected.capture_availability.unwrap().reason,
        "archive-unverified"
    );
}
