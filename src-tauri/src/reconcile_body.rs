//! Canvas body and source timestamp projection into coursework rows.

use serde_json::{Map, Value};

pub(super) fn patch_assignment_metadata(target: &mut Map<String, Value>, source: &Value) {
    for (remote, local) in [
        ("submissionTypes", "submissionTypes"),
        ("require_initial_post", "requireInitialPost"),
        ("attachments", "attachments"),
        ("linkedFiles", "linkedFiles"),
        ("assignmentId", "assignmentId"),
        ("discussionTopicId", "discussionTopicId"),
        ("assignmentDetail", "assignmentDetail"),
        ("assignmentBodyHtml", "assignmentBodyHtml"),
        ("assignmentBodyEmpty", "assignmentBodyEmpty"),
    ] {
        if let Some(value) = source.get(remote) {
            target.insert(local.into(), value.clone());
        }
    }
}

pub(super) fn patch_body_and_timestamps(target: &mut Map<String, Value>, source: &Value) {
    for (remote, local) in [
        ("detail", "detail"),
        ("bodyHtml", "bodyHtml"),
        ("bodyEmpty", "bodyEmpty"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
        ("posted_at", "postedAt"),
        ("delayed_post_at", "delayedPostAt"),
        ("unlock_at", "unlockAt"),
        ("lock_at", "lockAt"),
        ("due_at", "dueAtUtc"),
    ] {
        if let Some(value) = source.get(remote) {
            target.insert(local.into(), value.clone());
        }
    }
}
