//! Reconciliation of accessible Canvas discussion topics without a matching assignment.

use super::{
    dates::utc_to_new_york, identity::identity_key, invalid, CourseAssignments, ReconcileError,
};
use serde_json::{json, Map, Value};

pub(super) fn identity(discussion: &Value) -> Option<String> {
    discussion.get("id").and_then(|value| {
        value.as_u64().map(|id| id.to_string()).or_else(|| {
            value
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
    })
}

pub(super) fn validate(discussions: &[Value]) -> Result<(), ReconcileError> {
    let mut seen = std::collections::HashSet::new();
    for discussion in discussions {
        if !discussion.is_object() {
            return Err(invalid("Canvas discussion must be an object"));
        }
        let id = identity(discussion)
            .ok_or_else(|| invalid("Canvas discussion id is missing or invalid"))?;
        if !seen.insert(id) {
            return Err(invalid("duplicate Canvas discussion id"));
        }
        if discussion.get("title").and_then(Value::as_str).is_none() {
            return Err(invalid("Canvas discussion title must be a string"));
        }
    }
    Ok(())
}

/// Updates accessible standalone topics while retaining topics omitted by incomplete captures.
pub(super) fn merge(
    root: &mut Map<String, Value>,
    captures: &[CourseAssignments],
) -> Result<(), ReconcileError> {
    let mut items = root
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| invalid("coursework items must be an array"))?;
    let mut archive = root
        .get("archivedForecastItems")
        .map(|value| {
            value
                .as_array()
                .cloned()
                .ok_or_else(|| invalid("archivedForecastItems must be an array"))
        })
        .transpose()?
        .unwrap_or_default();
    let mut used_ids: std::collections::HashSet<String> = items
        .iter()
        .chain(&archive)
        .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();

    for capture in captures {
        for discussion in &capture.discussions {
            let discussion_id = identity(discussion).expect("discussion id was validated");
            let matches: Vec<usize> = items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    let item_type = item
                        .get("canvasResourceType")
                        .or_else(|| item.get("canvasType"))
                        .and_then(Value::as_str);
                    (item.get("source").and_then(Value::as_str) == Some("canvas")
                        && item_type == Some("discussion")
                        && item.get("course").and_then(Value::as_str) == Some(&capture.key)
                        && item.get("canvasId").and_then(identity_key).as_deref()
                            == Some(discussion_id.as_str()))
                    .then_some(index)
                })
                .collect();
            match matches.as_slice() {
                [index] => update_item(&mut items[*index], discussion)?,
                [] => {
                    let archived = matching_archive(&archive, &capture.key, &discussion_id)?;
                    let (item, revived) = match archived {
                        Some(index) => {
                            let mut item = archive.remove(index);
                            update_item(&mut item, discussion)?;
                            (item, true)
                        }
                        None => (new_item(&capture.key, discussion)?, false),
                    };
                    let generated_id = item["id"]
                        .as_str()
                        .expect("generated discussion item id is a string")
                        .to_owned();
                    if !revived && !used_ids.insert(generated_id) {
                        return Err(invalid("generated Canvas discussion item id collides"));
                    }
                    items.push(item);
                }
                _ => {
                    return Err(invalid(
                        "Canvas discussion has conflicting local identities",
                    ))
                }
            }
        }
    }
    root.insert("items".into(), Value::Array(items));
    if !archive.is_empty() || root.contains_key("archivedForecastItems") {
        root.insert("archivedForecastItems".into(), Value::Array(archive));
    }
    Ok(())
}

fn matching_archive(
    archive: &[Value],
    course: &str,
    discussion_id: &str,
) -> Result<Option<usize>, ReconcileError> {
    let mut found = None;
    for (index, item) in archive.iter().enumerate() {
        if item.get("source").and_then(Value::as_str) != Some("canvas")
            || item.get("course").and_then(Value::as_str) != Some(course)
            || item
                .get("canvasResourceType")
                .or_else(|| item.get("canvasType"))
                .and_then(Value::as_str)
                != Some("discussion")
            || item.get("canvasId").and_then(identity_key).as_deref() != Some(discussion_id)
        {
            continue;
        }
        if found.replace(index).is_some() {
            return Err(invalid("archived Canvas discussion identity is duplicated"));
        }
    }
    Ok(found)
}

pub(super) fn new_item(course: &str, discussion: &Value) -> Result<Value, ReconcileError> {
    let id = identity(discussion).ok_or_else(|| invalid("Canvas discussion id is invalid"))?;
    let title = discussion
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Canvas discussion title is invalid"))?;
    let mut item = json!({
        "id": format!("{course}-canvas-discussion-{id}"),
        "course": course,
        "kind": "discussion",
        "title": title,
        "source": "canvas",
        "canvasResourceType": "discussion",
        "canvasId": discussion["id"],
        "confidence": "confirmed",
        "flags": [],
        "detail": "",
        "done": false,
        "doneAt": null,
        "submissionStatus": null,
        "submittedAt": null,
        "gradedAt": null,
        "grade": null,
        "score": null
    });
    update_fields(
        item.as_object_mut().expect("new item is an object"),
        discussion,
    )?;
    Ok(item)
}

pub(super) fn update_item(item: &mut Value, discussion: &Value) -> Result<(), ReconcileError> {
    let target = item
        .as_object_mut()
        .ok_or_else(|| invalid("coursework discussion must be an object"))?;
    if target.get("keepTitle").and_then(Value::as_bool) != Some(true) {
        target.insert(
            "title".into(),
            discussion
                .get("title")
                .and_then(Value::as_str)
                .map_or(Value::Null, |title| Value::String(title.to_owned())),
        );
    }
    target.insert("kind".into(), Value::String("discussion".into()));
    target.insert("source".into(), Value::String("canvas".into()));
    target.insert(
        "canvasResourceType".into(),
        Value::String("discussion".into()),
    );
    target.insert(
        "canvasId".into(),
        discussion
            .get("id")
            .cloned()
            .ok_or_else(|| invalid("Canvas discussion id is missing"))?,
    );
    update_fields(target, discussion)
}

fn update_fields(
    target: &mut Map<String, Value>,
    discussion: &Value,
) -> Result<(), ReconcileError> {
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
        ("require_initial_post", "requireInitialPost"),
        ("is_announcement", "isAnnouncement"),
        ("attachments", "attachments"),
        ("linkedFiles", "linkedFiles"),
        ("html_url", "url"),
        ("links", "links"),
    ] {
        if let Some(value) = discussion.get(remote) {
            target.insert(local.into(), value.clone());
        }
    }
    if let Some(value) = discussion.get("due_at") {
        let due = if value.is_null() {
            Value::Null
        } else {
            let utc = value
                .as_str()
                .ok_or_else(|| invalid("Canvas discussion due_at must be a string or null"))?;
            Value::String(utc_to_new_york(utc)?)
        };
        target.insert("at".into(), due);
    }
    Ok(())
}
