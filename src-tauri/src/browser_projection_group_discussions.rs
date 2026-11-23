//! Resolves group discussion topics to active courses using captured group metadata.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use super::{positive_id, ProjectionError};

/// Returns group topics whose captured group metadata proves an active course owner.
///
/// Group-scoped resources carry no courseId. Promotion is allowed only when the account-level
/// groups resource includes the same group's positive course_id and that course is active.
pub(super) fn group_discussion_rows(
    resources: &[Value],
    active_course_ids: &HashSet<u64>,
) -> Result<Vec<(u64, Value)>, ProjectionError> {
    let mut group_resource = None;
    for resource in resources {
        if resource.get("endpoint").and_then(Value::as_str) == Some("groups")
            && resource.get("courseId").is_some_and(Value::is_null)
        {
            if group_resource.replace(resource).is_some() {
                return Err(ProjectionError::DuplicateResource);
            }
        }
    }

    let Some(group_resource) = group_resource else {
        return Ok(Vec::new());
    };
    let group_items = group_resource
        .get("items")
        .and_then(Value::as_array)
        .ok_or(ProjectionError::InvalidResource)?;
    let mut course_by_group = HashMap::new();
    for group in group_items {
        let group_id = group
            .get("id")
            .and_then(positive_id)
            .ok_or(ProjectionError::InvalidResource)?;
        let course_id = match group.get("course_id") {
            None | Some(Value::Null) => None,
            Some(value) => Some(positive_id(value).ok_or(ProjectionError::InvalidResource)?),
        };
        if course_by_group.insert(group_id, course_id).is_some() {
            return Err(ProjectionError::InvalidResource);
        }
    }

    let mut output = Vec::new();
    for resource in resources {
        let endpoint = resource.get("endpoint").and_then(Value::as_str);
        let is_announcement = endpoint == Some("announcements");
        if !is_announcement && endpoint != Some("discussions") {
            continue;
        }
        if !resource.get("courseId").is_some_and(Value::is_null) {
            continue;
        }
        let Some(group_id) = resource.get("groupId").and_then(positive_id) else {
            continue;
        };
        let Some(Some(course_id)) = course_by_group.get(&group_id).copied() else {
            continue;
        };
        if !active_course_ids.contains(&course_id) {
            continue;
        }
        let topics = resource
            .get("items")
            .and_then(Value::as_array)
            .ok_or(ProjectionError::InvalidResource)?;
        for topic in topics {
            let object = topic.as_object().ok_or(ProjectionError::InvalidResource)?;
            for field in ["course_id", "courseId"] {
                if let Some(value) = object.get(field) {
                    if !value.is_null() && positive_id(value) != Some(course_id) {
                        return Err(ProjectionError::IdentityMismatch);
                    }
                }
            }
            for field in ["group_id", "context_id"] {
                if let Some(value) = object.get(field) {
                    if !value.is_null() && positive_id(value) != Some(group_id) {
                        return Err(ProjectionError::IdentityMismatch);
                    }
                }
            }
            if let Some(context) = object.get("context_code").and_then(Value::as_str) {
                if context != format!("group_{group_id}") {
                    return Err(ProjectionError::IdentityMismatch);
                }
            }

            let mut promoted = object.clone();
            promoted.insert("course_id".into(), json!(course_id));
            promoted.insert("context_code".into(), json!(format!("course_{course_id}")));
            if is_announcement {
                promoted.insert("is_announcement".into(), Value::Bool(true));
            }
            output.push((course_id, Value::Object(promoted)));
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::group_discussion_rows;
    use crate::browser_projection::ProjectionError;
    use serde_json::json;
    use std::collections::HashSet;

    #[test]
    fn promotes_only_group_topics_proved_to_belong_to_active_course() {
        let resources = vec![
            json!({
                "endpoint": "groups", "courseId": null,
                "items": [
                    {"id": 77, "course_id": 101},
                    {"id": 88, "course_id": 202},
                    {"id": 99, "course_id": null}
                ]
            }),
            json!({
                "endpoint": "discussions", "courseId": null, "groupId": 77,
                "items": [{"id": 5, "title": "Synthetic topic", "group_id": 77}]
            }),
            json!({
                "endpoint": "discussions", "courseId": null, "groupId": 88,
                "items": [{"id": 6, "title": "Inactive course topic", "group_id": 88}]
            }),
            json!({
                "endpoint": "announcements", "courseId": null, "groupId": 77,
                "items": [{"id": 7, "title": "Synthetic announcement", "group_id": 77}]
            }),
            json!({
                "endpoint": "discussions", "courseId": null, "groupId": 99,
                "items": [{"id": 8, "title": "Unowned group topic", "group_id": 99}]
            }),
        ];
        let rows = group_discussion_rows(&resources, &HashSet::from([101]))
            .expect("only active, proven groups are promoted");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|(course_id, _)| *course_id == 101));
        assert_eq!(rows[0].1["course_id"], 101);
        assert_eq!(rows[0].1["context_code"], "course_101");
        assert_eq!(rows[1].1["is_announcement"], true);
    }

    #[test]
    fn rejects_topic_with_conflicting_group_identity() {
        let resources = vec![
            json!({
                "endpoint": "groups", "courseId": null,
                "items": [{"id": 77, "course_id": 101}]
            }),
            json!({
                "endpoint": "discussions", "courseId": null, "groupId": 77,
                "items": [{"id": 5, "group_id": 78}]
            }),
        ];
        assert_eq!(
            group_discussion_rows(&resources, &HashSet::from([101])).unwrap_err(),
            ProjectionError::IdentityMismatch
        );
    }
}
