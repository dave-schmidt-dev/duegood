//! Fixed-path JSON document projection for browser captures.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

use super::sanitize::{project_fields, sanitize_text, sanitize_value};
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
        "pages" => &["page_id", "title", "url", "updated_at", "body", "links"],
        "modules" => &["id", "name", "items_count", "items", "links"],
        "discussions" => &[
            "id",
            "title",
            "discussion_type",
            "posted_at",
            "due_at",
            "html_url",
            "assignment_id",
            "is_announcement",
            "links",
        ],
        "announcements" => &[
            "id",
            "title",
            "posted_at",
            "message",
            "html_url",
            "context_code",
            "links",
        ],
        "courseFiles" => &[
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
    let mut projected = project_fields(item, fields)?;
    if endpoint == "courseFiles" && item.get("url").is_some() {
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

pub(super) fn project_file_receipts(
    file_bodies: Option<&Value>,
    course_files: Option<&Value>,
) -> Result<Vec<Value>, ProjectionError> {
    let Some(course_files) = course_files else {
        return Ok(Vec::new());
    };
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
    for file in items(course_files)? {
        let id = file
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
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
