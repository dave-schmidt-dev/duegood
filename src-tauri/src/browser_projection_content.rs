//! Projection helpers for Canvas bodies, discussion items, and detail resources.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::documents::project_document_item;
use super::{
    documents, items, positive_id, sanitize::project_fields, validate_course_identity,
    ProjectionError,
};

/// Unions course announcements with discussion topics while preferring the richer topic record.
pub(super) fn merge_course_announcements(
    discussions: &[Value],
    announcements: &[Value],
    course_id: u64,
) -> Result<Vec<Value>, ProjectionError> {
    let mut output = Vec::new();
    let mut index_by_id = HashMap::<u64, usize>::new();
    for discussion in discussions {
        super::validate_course_identity(discussion, course_id)?;
        let id = discussion
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if index_by_id.insert(id, output.len()).is_some() {
            return Err(ProjectionError::InvalidResource);
        }
        output.push(discussion.clone());
    }

    for announcement in announcements {
        super::validate_course_identity(announcement, course_id)?;
        let id = announcement
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if let Some(index) = index_by_id.get(&id).copied() {
            let discussion = output[index]
                .as_object_mut()
                .ok_or(ProjectionError::InvalidResource)?;
            discussion.insert("is_announcement".into(), Value::Bool(true));
            // The discussion endpoint wins when it supplied a field; an announcement record
            // can fill gaps without replacing a known-empty or otherwise authoritative value.
            for (key, value) in announcement
                .as_object()
                .ok_or(ProjectionError::InvalidResource)?
            {
                discussion
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
        } else {
            let mut projected = announcement
                .as_object()
                .cloned()
                .ok_or(ProjectionError::InvalidResource)?;
            projected.insert("is_announcement".into(), Value::Bool(true));
            index_by_id.insert(id, output.len());
            output.push(Value::Object(projected));
        }
    }
    Ok(output)
}

/// Adds group topics only when their active course owner was proven by captured group metadata.
pub(super) fn merge_group_discussions(
    discussions: &mut Vec<Value>,
    group_rows: &[(u64, Value)],
    course_id: u64,
) -> Result<(), ProjectionError> {
    let mut index_by_id = HashMap::<u64, usize>::new();
    for (index, discussion) in discussions.iter().enumerate() {
        let id = discussion
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if index_by_id.insert(id, index).is_some() {
            return Err(ProjectionError::InvalidResource);
        }
    }
    for (owner, group_topic) in group_rows {
        if *owner != course_id {
            continue;
        }
        super::validate_course_identity(group_topic, course_id)?;
        let id = group_topic
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if let Some(index) = index_by_id.get(&id).copied() {
            let target = discussions[index]
                .as_object_mut()
                .ok_or(ProjectionError::InvalidResource)?;
            let incoming = group_topic
                .as_object()
                .ok_or(ProjectionError::InvalidResource)?;
            for (key, value) in incoming {
                target.entry(key.clone()).or_insert_with(|| value.clone());
            }
            if incoming.get("is_announcement").and_then(Value::as_bool) == Some(true) {
                target.insert("is_announcement".into(), Value::Bool(true));
            }
        } else {
            index_by_id.insert(id, discussions.len());
            discussions.push(group_topic.clone());
        }
    }
    Ok(())
}

pub(super) fn project_course_files(
    listed_files: Option<&Value>,
    linked_files: Option<&Vec<&Value>>,
    course_id: u64,
    run_id: Option<u64>,
) -> Result<Option<Vec<Value>>, ProjectionError> {
    if listed_files.is_none() && linked_files.is_none() {
        return Ok(None);
    }
    let mut files = Vec::new();
    let mut indexes = HashMap::new();
    if let Some(resource) = listed_files {
        for item in items(resource)? {
            validate_course_identity(item, course_id)?;
            insert_projected_file(
                &mut files,
                &mut indexes,
                project_document_item("courseFiles", item)?,
            )?;
        }
    }
    if let Some(resources) = linked_files {
        for resource in resources {
            for item in items(resource)? {
                validate_course_identity(item, course_id)?;
                let mut projected = project_document_item("file", item)?;
                if let (Some(run_id), Some(object)) = (run_id, projected.as_object_mut()) {
                    object.insert("linkedCaptureRunId".into(), Value::from(run_id));
                }
                insert_projected_file(&mut files, &mut indexes, projected)?;
            }
        }
    }
    Ok(Some(files))
}

fn insert_projected_file(
    files: &mut Vec<Value>,
    indexes: &mut HashMap<u64, usize>,
    file: Value,
) -> Result<(), ProjectionError> {
    let id = file
        .get("id")
        .and_then(positive_id)
        .ok_or(ProjectionError::InvalidResource)?;
    if let Some(index) = indexes.get(&id).copied() {
        let mut previous = files[index]
            .as_object()
            .cloned()
            .ok_or(ProjectionError::InvalidResource)?;
        let mut candidate = file
            .as_object()
            .cloned()
            .ok_or(ProjectionError::InvalidResource)?;
        previous.remove("linkedCaptureRunId");
        candidate.remove("linkedCaptureRunId");
        if previous != candidate {
            return Err(ProjectionError::InvalidResource);
        }
        return Ok(());
    }
    indexes.insert(id, files.len());
    files.push(file);
    Ok(())
}

pub(super) fn project_assignments(
    assignments: &[Value],
    submissions: &[Value],
    discussions: &[Value],
    course_id: u64,
    expected_user_id: Option<u64>,
    groups: &[Value],
    linked_file_names: &HashMap<u64, String>,
) -> Result<Vec<Value>, ProjectionError> {
    let mut group_ids = HashSet::new();
    for group in groups {
        if let Some(id) = group.get("id").and_then(positive_id) {
            group_ids.insert(id);
        }
    }
    let mut submission_by_assignment = HashMap::<u64, Map<String, Value>>::new();
    let mut discussion_by_assignment = HashMap::<u64, &Value>::new();
    for discussion in discussions {
        validate_course_identity(discussion, course_id)?;
        let Some(assignment_id) = discussion.get("assignment_id").and_then(positive_id) else {
            continue;
        };
        if discussion_by_assignment
            .insert(assignment_id, discussion)
            .is_some()
        {
            return Err(ProjectionError::InvalidResource);
        }
    }
    for submission in submissions {
        validate_course_identity(submission, course_id)?;
        if let (Some(expected), Some(actual)) = (
            expected_user_id,
            submission.get("user_id").and_then(positive_id),
        ) {
            if expected != actual {
                return Err(ProjectionError::IdentityMismatch);
            }
        }
        let assignment_id = submission
            .get("assignment_id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        let projected = project_fields(
            submission,
            &[
                "workflow_state",
                "submitted_at",
                "graded_at",
                "grade",
                "score",
                "excused",
                "missing",
                "late",
            ],
        )?;
        if submission_by_assignment
            .insert(assignment_id, projected)
            .is_some()
        {
            return Err(ProjectionError::InvalidResource);
        }
    }

    let mut seen = HashSet::new();
    let mut output = Vec::with_capacity(assignments.len());
    for assignment in assignments {
        validate_course_identity(assignment, course_id)?;
        let id = assignment
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if assignment.get("name").and_then(Value::as_str).is_none() {
            return Err(ProjectionError::InvalidResource);
        }
        if !seen.insert(id) {
            return Err(ProjectionError::InvalidResource);
        }
        if let Some(group) = assignment.get("assignment_group_id") {
            if !group.is_null() {
                let group_id = positive_id(group).ok_or(ProjectionError::InvalidResource)?;
                if !group_ids.contains(&group_id) {
                    return Err(ProjectionError::IdentityMismatch);
                }
            }
        }
        let mut projected = project_fields(
            assignment,
            &[
                "id",
                "name",
                "due_at",
                "created_at",
                "updated_at",
                "posted_at",
                "delayed_post_at",
                "unlock_at",
                "lock_at",
                "points_possible",
                "assignment_group_id",
                "html_url",
                "submission_types",
                "links",
            ],
        )?;
        documents::project_body_fields(assignment, "description", &mut projected)?;
        if let Some(linked_files) = documents::project_linked_files(assignment, linked_file_names)?
        {
            projected.insert("linkedFiles".into(), Value::Array(linked_files));
        }
        if let Some(attachments) = documents::project_attachments(assignment)? {
            projected.insert("attachments".into(), Value::Array(attachments));
        }
        if let Some(topic) = discussion_by_assignment.get(&id).copied() {
            if let Some(detail) = projected.get("detail").cloned() {
                projected.insert("assignmentDetail".into(), detail);
            }
            if let Some(html) = projected.get("bodyHtml").cloned() {
                projected.insert("assignmentBodyHtml".into(), html);
            }
            if let Some(empty) = projected.get("bodyEmpty").cloned() {
                projected.insert("assignmentBodyEmpty".into(), empty);
            }
            for key in ["detail", "bodyHtml", "bodyEmpty"] {
                projected.remove(key);
            }
            projected.insert("assignmentId".into(), Value::from(id));
            if let Some(topic_id) = topic.get("id") {
                projected.insert("discussionTopicId".into(), topic_id.clone());
            }
            let mut topic_projection = project_fields(
                topic,
                &[
                    "created_at",
                    "updated_at",
                    "posted_at",
                    "delayed_post_at",
                    "unlock_at",
                    "lock_at",
                    "due_at",
                    "require_initial_post",
                    "is_announcement",
                ],
            )?;
            documents::project_body_fields(topic, "message", &mut topic_projection)?;
            if let Some(linked_files) = documents::project_linked_files(topic, linked_file_names)? {
                merge_file_refs(&mut projected, "linkedFiles", linked_files)?;
            }
            if let Some(attachments) = documents::project_attachments(topic)? {
                merge_file_refs(&mut projected, "attachments", attachments)?;
            }
            let topic_body_is_known = topic_projection
                .get("bodyEmpty")
                .and_then(Value::as_bool)
                .is_some();
            for (key, value) in topic_projection {
                let body_key = matches!(key.as_str(), "detail" | "bodyHtml" | "bodyEmpty");
                let topic_timestamp = matches!(
                    key.as_str(),
                    "created_at"
                        | "updated_at"
                        | "posted_at"
                        | "delayed_post_at"
                        | "unlock_at"
                        | "lock_at"
                        | "due_at"
                );
                if body_key && topic_body_is_known {
                    projected.insert(key, value);
                } else if topic_timestamp && !value.is_null() {
                    projected.insert(key, value);
                } else if !body_key && !projected.contains_key(&key) {
                    projected.insert(key, value);
                }
            }
        }
        if let Some(types) = assignment.get("submission_types") {
            projected.insert("submissionTypes".into(), types.clone());
        }
        projected.extend(crate::canvas_rubric::assignment_rubric_fields(assignment)?);
        if let Some(nested) = assignment.get("submission") {
            projected.insert(
                "submission".into(),
                if nested.is_null() {
                    Value::Null
                } else {
                    Value::Object(project_fields(
                        nested,
                        &[
                            "workflow_state",
                            "submitted_at",
                            "graded_at",
                            "grade",
                            "score",
                            "excused",
                            "missing",
                            "late",
                        ],
                    )?)
                },
            );
        }
        if let Some(submission) = submission_by_assignment.remove(&id) {
            projected.insert("submission".into(), Value::Object(submission));
        }
        output.push(Value::Object(projected));
    }
    if !submission_by_assignment.is_empty() {
        return Err(ProjectionError::IdentityMismatch);
    }
    Ok(output)
}

pub(super) fn project_standalone_discussions(
    discussions: &[Value],
    assignments: &[Value],
    course_id: u64,
    linked_file_names: &HashMap<u64, String>,
) -> Result<Vec<Value>, ProjectionError> {
    let assignment_ids: HashSet<u64> = assignments
        .iter()
        .filter_map(|assignment| assignment.get("id").and_then(positive_id))
        .collect();
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for discussion in discussions {
        validate_course_identity(discussion, course_id)?;
        let id = discussion
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if !seen.insert(id) {
            return Err(ProjectionError::InvalidResource);
        }
        if let Some(assignment_id) = discussion
            .get("assignment_id")
            .filter(|value| !value.is_null())
        {
            let assignment_id =
                positive_id(assignment_id).ok_or(ProjectionError::InvalidResource)?;
            if assignment_ids.contains(&assignment_id) {
                continue;
            }
        }
        let mut projected = documents::project_document_item("discussions", discussion)?;
        if let Some(object) = projected.as_object_mut() {
            if let Some(linked_files) =
                documents::project_linked_files(discussion, linked_file_names)?
            {
                object.insert("linkedFiles".into(), Value::Array(linked_files));
            }
            if let Some(attachments) = documents::project_attachments(discussion)? {
                object.insert("attachments".into(), Value::Array(attachments));
            }
        }
        output.push(projected);
    }
    Ok(output)
}

pub(super) fn project_linked_file_names(
    resources: Option<&Vec<&Value>>,
    course_id: u64,
) -> Result<HashMap<u64, String>, ProjectionError> {
    let mut names = HashMap::new();
    let Some(resources) = resources else {
        return Ok(names);
    };
    for resource in resources {
        for file in items(resource)? {
            validate_course_identity(file, course_id)?;
            let projected = documents::project_document_item("file", file)?;
            let id = projected
                .get("id")
                .and_then(positive_id)
                .ok_or(ProjectionError::InvalidResource)?;
            let name = projected
                .get("display_name")
                .or_else(|| projected.get("filename"))
                .and_then(Value::as_str);
            if let Some(name) = name {
                if names
                    .insert(id, name.to_owned())
                    .is_some_and(|previous| previous != name)
                {
                    return Err(ProjectionError::InvalidResource);
                }
            }
        }
    }
    Ok(names)
}

pub(super) fn index_detail_records(
    resources: Option<&Vec<&Value>>,
    endpoint: &str,
    course_id: u64,
) -> Result<HashMap<u64, Value>, ProjectionError> {
    let mut records = HashMap::new();
    let Some(resources) = resources else {
        return Ok(records);
    };
    let id_field = if endpoint == "page" { "page_id" } else { "id" };
    for resource in resources {
        for item in items(resource)? {
            validate_course_identity(item, course_id)?;
            let id = item
                .get(id_field)
                .and_then(positive_id)
                .ok_or(ProjectionError::InvalidResource)?;
            if records.insert(id, item.clone()).is_some() {
                return Err(ProjectionError::InvalidResource);
            }
        }
    }
    Ok(records)
}

pub(super) fn document_item_id(endpoint: &str, item: &Value) -> Option<u64> {
    let field = if endpoint == "pages" { "page_id" } else { "id" };
    item.get(field).and_then(positive_id)
}

pub(super) fn project_document_item_with_detail(
    endpoint: &str,
    item: &Value,
    detail: Option<&Value>,
    linked_file_names: &HashMap<u64, String>,
) -> Result<Value, ProjectionError> {
    let mut projected = documents::project_document_item(endpoint, item)?;
    let Some(detail) = detail else {
        return Ok(projected);
    };
    let body_field = if endpoint == "pages" {
        "body"
    } else {
        "description"
    };
    let mut body_fields = Map::new();
    documents::project_body_fields(detail, body_field, &mut body_fields)?;
    let timestamps = project_fields(
        detail,
        &[
            "created_at",
            "updated_at",
            "posted_at",
            "delayed_post_at",
            "unlock_at",
            "lock_at",
            "due_at",
        ],
    )?;
    let object = projected
        .as_object_mut()
        .ok_or(ProjectionError::InvalidResource)?;
    object.extend(timestamps);
    object.extend(body_fields);
    if let Some(linked_files) = documents::project_linked_files(detail, linked_file_names)? {
        merge_file_refs(object, "linkedFiles", linked_files)?;
    }
    if let Some(attachments) = documents::project_attachments(detail)? {
        merge_file_refs(object, "attachments", attachments)?;
    }
    Ok(projected)
}

fn merge_file_refs(
    target: &mut Map<String, Value>,
    field: &str,
    incoming: Vec<Value>,
) -> Result<(), ProjectionError> {
    let mut output = target
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for file in incoming {
        let id = file
            .get("fileId")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        if let Some(existing) = output
            .iter_mut()
            .find(|existing| existing.get("fileId").and_then(positive_id) == Some(id))
        {
            if existing.get("name").is_none() {
                if let Some(name) = file.get("name") {
                    existing["name"] = name.clone();
                }
            }
        } else {
            output.push(file);
        }
    }
    target.insert(field.into(), Value::Array(output));
    Ok(())
}
