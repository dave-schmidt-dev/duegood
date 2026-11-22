//! Required resource and context evidence for a claimed full browser capture.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::browser_bundle::CaptureCoverage;

use super::daily_scope::is_confirmed_omission;

const ACCOUNT_ENDPOINTS: [&str; 7] = [
    "groups",
    "personalFiles",
    "personalFolders",
    "inbox",
    "inboxAll",
    "conversationsSent",
    "conversationsArchived",
];
const COURSE_ENDPOINTS: [&str; 12] = [
    "course",
    "courseTabs",
    "assignments",
    "assignmentGroups",
    "submissions",
    "pages",
    "modules",
    "discussions",
    "announcements",
    "quizzes",
    "courseFiles",
    "folders",
];

/// Checks root request and calendar context coverage before accepting COMPLETE.
pub(super) fn has_complete_capture_evidence(
    snapshot: &Value,
    coverage: &[CaptureCoverage],
) -> bool {
    let Some(resources) = snapshot.get("resources").and_then(Value::as_array) else {
        return false;
    };
    for endpoint in ["profile", "coursesActive", "coursesCompleted"]
        .into_iter()
        .chain(ACCOUNT_ENDPOINTS)
    {
        if !scope_capture_is_recorded(resources, coverage, endpoint, endpoint, None, None, None) {
            return false;
        }
    }

    let mut course_ids = BTreeSet::new();
    for endpoint in ["coursesActive", "coursesCompleted"] {
        let matching = resources
            .iter()
            .filter(|resource| resource_scope(resource, endpoint, None, None, None))
            .collect::<Vec<_>>();
        if matching.is_empty() {
            let root_is_omitted = coverage.iter().any(|row| {
                row.endpoint == endpoint
                    && row.course_id.is_none()
                    && row.group_id.is_none()
                    && row.context_code.is_none()
                    && is_confirmed_omission(row, coverage, None)
            });
            if root_is_omitted {
                continue;
            }
        }
        if matching.len() != 1 {
            return false;
        }
        let Some(items) = matching[0].get("items").and_then(Value::as_array) else {
            return false;
        };
        for item in items {
            let Some(id) = positive_id(item.get("id")) else {
                return false;
            };
            course_ids.insert(id);
        }
    }
    for course_id in &course_ids {
        for endpoint in COURSE_ENDPOINTS {
            if !scope_capture_is_recorded(
                resources,
                coverage,
                endpoint,
                endpoint,
                Some(*course_id),
                None,
                None,
            ) {
                return false;
            }
        }
    }

    let group_resource = resources
        .iter()
        .find(|resource| resource_scope(resource, "groups", None, None, None));
    if let Some(groups) = group_resource {
        let Some(items) = groups.get("items").and_then(Value::as_array) else {
            return false;
        };
        let mut group_ids = BTreeSet::new();
        for item in items {
            let Some(id) = positive_id(item.get("id")) else {
                return false;
            };
            if !group_ids.insert(id) {
                return false;
            }
        }
        for group_id in group_ids {
            for (coverage_endpoint, resource_endpoint) in [
                ("groupFolders", "folders"),
                ("groupPages", "pages"),
                ("groupDiscussions", "discussions"),
            ] {
                if !scope_capture_is_recorded(
                    resources,
                    coverage,
                    coverage_endpoint,
                    resource_endpoint,
                    None,
                    Some(group_id),
                    None,
                ) {
                    return false;
                }
            }
        }
    }

    let account_id = snapshot
        .get("identity")
        .and_then(|identity| identity.get("accountId"))
        .and_then(Value::as_u64)
        .filter(|id| *id > 0);
    let Some(user_id) = snapshot
        .get("identity")
        .and_then(|identity| identity.get("userId"))
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
    else {
        return false;
    };
    let mut calendar_contexts = vec![(None, None, format!("user_{user_id}"))];
    if let Some(account_id) = account_id {
        calendar_contexts.push((None, None, format!("account_{account_id}")));
    }
    calendar_contexts.extend(
        course_ids
            .iter()
            .map(|course_id| (Some(*course_id), None, format!("course_{course_id}"))),
    );
    if let Some(groups) = group_resource {
        if let Some(items) = groups.get("items").and_then(Value::as_array) {
            calendar_contexts.extend(items.iter().filter_map(|item| {
                positive_id(item.get("id"))
                    .map(|group_id| (None, Some(group_id), format!("group_{group_id}")))
            }));
        }
    }
    calendar_contexts
        .into_iter()
        .all(|(course_id, group_id, context)| {
            scope_capture_is_recorded(
                resources,
                coverage,
                "calendarEvents",
                "calendarEvents",
                course_id,
                group_id,
                Some(&context),
            )
        })
}

fn scope_capture_is_recorded(
    resources: &[Value],
    coverage: &[CaptureCoverage],
    coverage_endpoint: &str,
    resource_endpoint: &str,
    course_id: Option<u64>,
    group_id: Option<u64>,
    context_code: Option<&str>,
) -> bool {
    let rows = coverage
        .iter()
        .filter(|row| {
            row.endpoint == coverage_endpoint
                && row.course_id == course_id
                && row.group_id == group_id
                && row.context_code.as_deref() == context_code
        })
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return false;
    }
    let resource_count = resources
        .iter()
        .filter(|resource| {
            resource_scope(
                resource,
                resource_endpoint,
                course_id,
                group_id,
                context_code,
            )
        })
        .count();
    match rows[0].status.as_str() {
        "complete" => resource_count == 1,
        "gap" => resource_count == 0 && is_confirmed_omission(rows[0], coverage, course_id),
        _ => false,
    }
}

fn resource_scope(
    resource: &Value,
    endpoint: &str,
    course_id: Option<u64>,
    group_id: Option<u64>,
    context_code: Option<&str>,
) -> bool {
    resource.get("endpoint").and_then(Value::as_str) == Some(endpoint)
        && positive_id(resource.get("courseId")) == course_id
        && positive_id(resource.get("groupId")) == group_id
        && resource.get("contextCode").and_then(Value::as_str) == context_code
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|id| *id > 0)
}
