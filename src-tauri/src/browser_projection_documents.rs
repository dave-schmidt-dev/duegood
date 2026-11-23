//! Fixed-path JSON document projection for browser captures.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

use super::sanitize::{project_fields, sanitize_structured_text, sanitize_text, sanitize_value};
use super::{items, positive_id, ProjectionError};

pub(super) fn project_course(course: &Value) -> Result<Map<String, Value>, ProjectionError> {
    let mut projected = project_fields(
        course,
        &[
            "id",
            "name",
            "course_code",
            "syllabus_body",
            "term",
            "links",
        ],
    )?;
    if let Some(term) = course.get("term") {
        projected.insert(
            "term".into(),
            if term.is_null() {
                Value::Null
            } else {
                Value::Object(project_fields(term, &["id", "name"])?)
            },
        );
    }
    Ok(projected)
}

pub(super) fn project_document_item(
    endpoint: &str,
    item: &Value,
) -> Result<Value, ProjectionError> {
    let fields: &[&str] = match endpoint {
        "courseTabs" => &["id", "label", "position", "visibility", "hidden", "links"],
        "pages" => &[
            "page_id",
            "title",
            "url",
            "created_at",
            "updated_at",
            "body",
            "links",
        ],
        "modules" => &["id", "name", "items_count", "items", "links"],
        "discussions" => &[
            "id",
            "title",
            "discussion_type",
            "created_at",
            "updated_at",
            "posted_at",
            "delayed_post_at",
            "unlock_at",
            "lock_at",
            "due_at",
            "html_url",
            "assignment_id",
            "is_announcement",
            "require_initial_post",
            "links",
        ],
        "announcements" => &[
            "id",
            "title",
            "created_at",
            "updated_at",
            "posted_at",
            "delayed_post_at",
            "unlock_at",
            "lock_at",
            "due_at",
            "message",
            "html_url",
            "context_code",
            "links",
        ],
        "quizzes" => &[
            "id",
            "title",
            "created_at",
            "updated_at",
            "posted_at",
            "delayed_post_at",
            "unlock_at",
            "lock_at",
            "due_at",
            "description",
            "html_url",
            "points_possible",
            "links",
        ],
        "courseFiles" | "file" => &[
            "id",
            "display_name",
            "filename",
            "size",
            "updated_at",
            "url",
            "links",
        ],
        "folders" => &[
            "id",
            "name",
            "parent_folder_id",
            "full_name",
            "files_count",
            "folders_count",
            "links",
        ],
        _ => return Err(ProjectionError::InvalidResource),
    };
    let body_field = match endpoint {
        "pages" => Some("body"),
        "discussions" | "announcements" => Some("message"),
        "quizzes" => Some("description"),
        _ => None,
    };
    let projected_fields: Vec<&str> = fields
        .iter()
        .copied()
        .filter(|field| Some(*field) != body_field)
        .collect();
    let mut projected = project_fields(item, &projected_fields)?;
    if let Some(linked_files) = project_linked_files(item, &HashMap::new())? {
        projected.insert("linkedFiles".into(), Value::Array(linked_files));
    }
    if let Some(attachments) = project_attachments(item)? {
        projected.insert("attachments".into(), Value::Array(attachments));
    }
    if let Some(body_field) = body_field {
        project_body_fields(item, body_field, &mut projected)?;
    }
    if matches!(endpoint, "courseFiles" | "file") && item.get("url").is_some() {
        projected.insert("url".into(), Value::Null);
    }
    if endpoint == "modules" {
        if let Some(items) = item.get("items") {
            let items = items.as_array().ok_or(ProjectionError::InvalidResource)?;
            projected.insert(
                "items".into(),
                Value::Array(
                    items
                        .iter()
                        .map(|item| {
                            Ok(Value::Object(project_fields(
                                item,
                                &["id", "type", "title", "content_id", "html_url", "links"],
                            )?))
                        })
                        .collect::<Result<Vec<_>, ProjectionError>>()?,
                ),
            );
        }
    }
    Ok(Value::Object(projected))
}

/// Projects the browser sanitizer's retained HTML and structured text together.
///
/// Older captures contain only the sanitizer's plain-text replacement. Those remain readable,
/// while captures without a body leave the local item untouched during reconciliation.
pub(super) fn project_body_fields(
    item: &Value,
    legacy_field: &str,
    projected: &mut Map<String, Value>,
) -> Result<(), ProjectionError> {
    if let Some(body) = item.get("_canvasBody") {
        let body = body.as_object().ok_or(ProjectionError::InvalidResource)?;
        let html = body
            .get("html")
            .and_then(Value::as_str)
            .ok_or(ProjectionError::InvalidResource)?;
        let text = body
            .get("text")
            .and_then(Value::as_str)
            .ok_or(ProjectionError::InvalidResource)?;
        let empty = body
            .get("empty")
            .and_then(Value::as_bool)
            .ok_or(ProjectionError::InvalidResource)?;
        if body.len() != 3
            || html.len() > 512 * 1024
            || text.len() > 512 * 1024
            || empty && (!html.is_empty() || !text.is_empty())
        {
            return Err(ProjectionError::InvalidResource);
        }
        let text = sanitize_structured_text(text)?;
        projected.insert("detail".into(), Value::String(text.clone()));
        projected.insert(legacy_field.into(), Value::String(text));
        projected.insert("bodyHtml".into(), Value::String(html.to_owned()));
        projected.insert("bodyEmpty".into(), Value::Bool(empty));
        return Ok(());
    }

    // Coverage gaps and sanitizer failures must not fall back to a different body field.
    // Reconciliation can then preserve the previously imported Canvas content.
    if item.get("_canvasBodyReason").is_some() {
        return Ok(());
    }

    let Some(body) = item.get(legacy_field) else {
        return Ok(());
    };
    let text = match body {
        Value::Null => String::new(),
        Value::String(text) => sanitize_structured_text(text)?,
        _ => return Err(ProjectionError::InvalidResource),
    };
    projected.insert("detail".into(), Value::String(text.clone()));
    projected.insert(legacy_field.into(), Value::String(text.clone()));
    projected.insert("bodyEmpty".into(), Value::Bool(text.is_empty()));
    Ok(())
}

pub(super) fn project_linked_files(
    item: &Value,
    names: &HashMap<u64, String>,
) -> Result<Option<Vec<Value>>, ProjectionError> {
    let Some(references) = item.get("_canvasLinkedFiles") else {
        return Ok(None);
    };
    let references = references
        .as_array()
        .ok_or(ProjectionError::InvalidResource)?;
    let mut seen = std::collections::HashSet::new();
    let mut output = Vec::new();
    for reference in references {
        let object = reference
            .as_object()
            .ok_or(ProjectionError::InvalidResource)?;
        let id = object
            .get("fileId")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if !seen.insert(id) {
            continue;
        }
        let mut file = Map::new();
        file.insert("fileId".into(), Value::from(id));
        let name = names
            .get(&id)
            .map(String::as_str)
            .or_else(|| object.get("name").and_then(Value::as_str));
        if let Some(name) = name {
            file.insert("name".into(), Value::String(sanitize_text(name)?));
        }
        output.push(Value::Object(file));
    }
    Ok(Some(output))
}

pub(super) fn project_attachments(item: &Value) -> Result<Option<Vec<Value>>, ProjectionError> {
    let source = item.get("attachments").or_else(|| item.get("attachment"));
    let Some(source) = source else {
        return Ok(None);
    };
    let attachments = if let Some(attachments) = source.as_array() {
        attachments.iter().collect::<Vec<_>>()
    } else if source.is_object() {
        vec![source]
    } else if source.is_null() {
        return Ok(Some(Vec::new()));
    } else {
        return Err(ProjectionError::InvalidResource);
    };
    let mut seen = std::collections::HashSet::new();
    let mut output = Vec::new();
    for attachment in attachments {
        let object = attachment
            .as_object()
            .ok_or(ProjectionError::InvalidResource)?;
        let id = object
            .get("id")
            .or_else(|| object.get("fileId"))
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if !seen.insert(id) {
            continue;
        }
        let mut projected = Map::new();
        projected.insert("fileId".into(), Value::from(id));
        if let Some(name) = object
            .get("display_name")
            .or_else(|| object.get("filename"))
            .or_else(|| object.get("name"))
            .and_then(Value::as_str)
        {
            projected.insert("name".into(), Value::String(sanitize_text(name)?));
        }
        output.push(Value::Object(projected));
    }
    Ok(Some(output))
}

pub(super) fn project_file_receipts(
    file_bodies: Option<&Value>,
    files: &[Value],
) -> Result<Vec<Value>, ProjectionError> {
    let mut receipt_by_id = HashMap::new();
    if let Some(file_bodies) = file_bodies {
        for receipt in items(file_bodies)? {
            let file_id = receipt
                .get("fileId")
                .and_then(positive_id)
                .ok_or(ProjectionError::InvalidResource)?;
            if receipt_by_id.insert(file_id, receipt).is_some() {
                return Err(ProjectionError::InvalidResource);
            }
        }
    }
    let mut output = Vec::new();
    let mut seen = HashMap::<u64, &Value>::new();
    for file in files {
        let id = file
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if let Some(previous) = seen.get(&id) {
            if *previous != file {
                return Err(ProjectionError::InvalidResource);
            }
            continue;
        }
        seen.insert(id, file);
        let mut reference = Map::new();
        reference.insert("fileId".into(), Value::from(id));
        if let Some(name) = file
            .get("display_name")
            .or_else(|| file.get("filename"))
            .and_then(Value::as_str)
        {
            reference.insert("name".into(), Value::from(sanitize_text(name)?));
        }
        if let Some(size) = file.get("size") {
            reference.insert("size".into(), size.clone());
        }
        if let Some(receipt) = receipt_by_id.remove(&id) {
            match receipt.get("status").and_then(Value::as_str) {
                Some("archived") => {
                    reference.insert("status".into(), Value::from("saved"));
                    let byte_count = receipt
                        .get("byteCount")
                        .and_then(Value::as_u64)
                        .filter(|value| (1..=256 * 1024 * 1024).contains(value))
                        .ok_or(ProjectionError::InvalidResource)?;
                    if file
                        .get("size")
                        .and_then(positive_id)
                        .is_some_and(|expected| expected != byte_count)
                    {
                        return Err(ProjectionError::InvalidResource);
                    }
                    let sha256 = receipt
                        .get("sha256")
                        .and_then(Value::as_str)
                        .filter(|value| {
                            value.len() == 64
                                && value.bytes().all(|byte| {
                                    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
                                })
                        })
                        .ok_or(ProjectionError::InvalidResource)?;
                    let content_type = receipt
                        .get("contentType")
                        .and_then(Value::as_str)
                        .filter(|value| {
                            value.len() <= 127
                                && value.split_once('/').is_some_and(|(kind, subtype)| {
                                    !kind.is_empty() && !subtype.is_empty()
                                })
                                && value.matches('/').count() == 1
                                && value.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric()
                                        || matches!(byte, b'/' | b'.' | b'+' | b'-')
                                })
                        })
                        .ok_or(ProjectionError::InvalidResource)?;
                    if receipt.get("sourceAuthenticity").and_then(Value::as_str)
                        != Some("unverified")
                    {
                        return Err(ProjectionError::InvalidResource);
                    }
                    reference.insert("byteCount".into(), Value::from(byte_count));
                    reference.insert("sha256".into(), Value::from(sha256));
                    reference.insert("contentType".into(), Value::from(content_type));
                    reference.insert("sourceAuthenticity".into(), Value::from("unverified"));
                }
                Some("gap") => {
                    reference.insert("status".into(), Value::from("gap"));
                    if let Some(reason) = receipt.get("reason") {
                        reference.insert("reason".into(), sanitize_value(reason, "reason")?);
                    }
                }
                _ => return Err(ProjectionError::InvalidResource),
            }
        } else {
            reference.insert("status".into(), Value::from("unavailable"));
        }
        output.push(Value::Object(reference));
    }
    Ok(output)
}

pub(super) fn put_json(
    documents: &mut BTreeMap<String, Vec<u8>>,
    path: &str,
    value: &Value,
) -> Result<(), ProjectionError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| ProjectionError::Serialization)?;
    bytes.push(b'\n');
    documents.insert(path.to_owned(), bytes);
    Ok(())
}
