//! Active inventory and per-course import eligibility checks.

use std::collections::BTreeSet;

use serde_json::Value;

use super::{
    ActiveCourseCoverage, BundleError, CaptureCoverage, MAX_ACTIVE_COURSES, REQUIRED_ENDPOINTS,
};

pub(super) fn validate_active_coverage(
    snapshot: &Value,
) -> Result<(Vec<ActiveCourseCoverage>, Vec<CaptureCoverage>), BundleError> {
    let active = snapshot
        .get("activeCourses")
        .ok_or(BundleError::IncompleteInventory)?;
    let requirements = snapshot
        .get("coverageRequirements")
        .ok_or(BundleError::IncompleteInventory)?;
    if active.get("complete").and_then(Value::as_bool) != Some(true)
        || requirements
            .get("activeCoursesComplete")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(BundleError::IncompleteInventory);
    }
    let ids = active
        .get("courseIds")
        .and_then(Value::as_array)
        .ok_or(BundleError::IncompleteInventory)?;
    if ids.len() > MAX_ACTIVE_COURSES {
        return Err(BundleError::BudgetExceeded);
    }
    let mut course_ids = BTreeSet::new();
    for value in ids {
        let id = value
            .as_u64()
            .filter(|id| *id > 0)
            .ok_or(BundleError::IncompleteInventory)?;
        if !course_ids.insert(id) {
            return Err(BundleError::IncompleteInventory);
        }
    }

    let required = requirements
        .get("perActiveCourse")
        .and_then(Value::as_array)
        .ok_or(BundleError::IncompleteCoverage)?;
    let required_set: BTreeSet<String> = required
        .iter()
        .map(|value| value.as_str().map(str::to_owned))
        .collect::<Option<_>>()
        .ok_or(BundleError::IncompleteCoverage)?;
    let expected_set = REQUIRED_ENDPOINTS
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<BTreeSet<_>>();
    if required_set != expected_set || required.len() != REQUIRED_ENDPOINTS.len() {
        return Err(BundleError::IncompleteCoverage);
    }

    let resources = snapshot["resources"]
        .as_array()
        .ok_or(BundleError::InvalidSnapshot)?;
    let mut listed_active = BTreeSet::new();
    for resource in resources
        .iter()
        .filter(|resource| resource["endpoint"] == "coursesActive")
    {
        if !resource["courseId"].is_null() {
            return Err(BundleError::IncompleteInventory);
        }
        for item in resource["items"]
            .as_array()
            .ok_or(BundleError::InvalidSnapshot)?
        {
            let id = item
                .get("id")
                .and_then(Value::as_u64)
                .filter(|id| *id > 0)
                .ok_or(BundleError::IncompleteInventory)?;
            if !listed_active.insert(id) {
                return Err(BundleError::IncompleteInventory);
            }
        }
    }
    if listed_active != course_ids
        || resources
            .iter()
            .filter(|resource| resource["endpoint"] == "coursesActive")
            .count()
            != 1
    {
        return Err(BundleError::IncompleteInventory);
    }

    let coverage = snapshot["coverage"]
        .as_array()
        .ok_or(BundleError::InvalidSnapshot)?;
    let mut active_coverage = Vec::new();
    let mut result = Vec::with_capacity(course_ids.len());
    for course_id in course_ids {
        for endpoint in REQUIRED_ENDPOINTS {
            let rows = coverage
                .iter()
                .filter(|entry| {
                    entry.get("endpoint").and_then(Value::as_str) == Some(endpoint)
                        && entry.get("courseId").and_then(Value::as_u64) == Some(course_id)
                        && entry.get("groupId").is_none_or(Value::is_null)
                        && entry.get("contextCode").is_none_or(Value::is_null)
                })
                .collect::<Vec<_>>();
            if rows.len() != 1 || rows[0]["status"].as_str() != Some("complete") {
                return Err(BundleError::IncompleteCoverage);
            }
            let matches = resources
                .iter()
                .filter(|resource| {
                    resource.get("endpoint").and_then(Value::as_str) == Some(endpoint)
                        && resource.get("courseId").and_then(Value::as_u64) == Some(course_id)
                        && resource.get("groupId").is_none_or(Value::is_null)
                        && resource.get("contextCode").is_none_or(Value::is_null)
                })
                .count();
            if matches != 1 {
                return Err(BundleError::IncompleteCoverage);
            }
        }
        let course = resources
            .iter()
            .find(|resource| {
                resource["endpoint"] == "course"
                    && resource["courseId"].as_u64() == Some(course_id)
                    && resource.get("groupId").is_none_or(Value::is_null)
                    && resource.get("contextCode").is_none_or(Value::is_null)
            })
            .ok_or(BundleError::IncompleteCoverage)?;
        let items = course["items"]
            .as_array()
            .ok_or(BundleError::IncompleteCoverage)?;
        if items.len() != 1 || items[0].get("id").and_then(Value::as_u64) != Some(course_id) {
            return Err(BundleError::IncompleteCoverage);
        }
        result.push(ActiveCourseCoverage {
            course_id,
            required_endpoints: required_set.clone(),
            complete: true,
        });
    }
    for row in coverage.iter().filter(|entry| {
        entry.get("endpoint").and_then(Value::as_str) == Some("coursesActive")
            && entry["courseId"].is_null()
            && entry.get("groupId").is_none_or(Value::is_null)
            && entry.get("contextCode").is_none_or(Value::is_null)
    }) {
        active_coverage.push(row);
    }
    if active_coverage.len() != 1 || active_coverage[0]["status"].as_str() != Some("complete") {
        return Err(BundleError::IncompleteInventory);
    }

    let mut scopes = BTreeSet::new();
    let all_coverage = coverage
        .iter()
        .map(|entry| {
            let endpoint = entry
                .get("endpoint")
                .and_then(Value::as_str)
                .filter(|value| valid_endpoint(value))
                .ok_or(BundleError::InvalidSnapshot)?;
            let course_id = optional_id(entry, "courseId")?;
            let group_id = optional_id(entry, "groupId")?;
            let context_code = optional_context_code(entry)?;
            validate_coverage_scope(endpoint, course_id, group_id, context_code.as_deref())?;
            if !scopes.insert((
                endpoint.to_owned(),
                course_id,
                group_id,
                context_code.clone(),
            )) {
                return Err(BundleError::InvalidSnapshot);
            }
            let status = entry
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| ["complete", "incomplete", "gap"].contains(status))
                .ok_or(BundleError::InvalidSnapshot)?;
            let reason = entry
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if reason.as_deref().is_some_and(|value| {
                ![
                    "forbidden-optional",
                    "disabled",
                    "not-attempted",
                    "not-found",
                    "request-failed",
                ]
                .contains(&value)
            }) {
                return Err(BundleError::InvalidSnapshot);
            }
            Ok(CaptureCoverage {
                endpoint: endpoint.to_owned(),
                course_id,
                group_id,
                context_code,
                status: status.to_owned(),
                reason,
            })
        })
        .collect::<Result<Vec<_>, BundleError>>()?;
    Ok((result, all_coverage))
}

const GROUP_COVERAGE_ENDPOINTS: [&str; 7] = [
    "groupFolders",
    "groupFolderFiles",
    "groupPages",
    "groupPage",
    "groupDiscussions",
    "groupDiscussionEntries",
    "groupDiscussionReplies",
];
const GROUP_RESOURCE_ENDPOINTS: [&str; 8] = [
    "folders",
    "courseFiles",
    "file",
    "pages",
    "page",
    "discussions",
    "discussionEntries",
    "discussionReplies",
];

pub(super) fn validate_resource_scope(resource: &Value) -> Result<(), BundleError> {
    let endpoint = resource
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|value| valid_endpoint(value))
        .ok_or(BundleError::InvalidSnapshot)?;
    let course_id = optional_id(resource, "courseId")?;
    let group_id = optional_id(resource, "groupId")?;
    let context_code = optional_context_code(resource)?;
    validate_context_scope(endpoint, course_id, group_id, context_code.as_deref())?;
    if (group_id.is_some() && course_id.is_some())
        || (group_id.is_some()
            && endpoint != "calendarEvents"
            && !GROUP_RESOURCE_ENDPOINTS.contains(&endpoint))
    {
        return Err(BundleError::InvalidSnapshot);
    }
    if context_code.is_some() && endpoint != "calendarEvents" {
        return Err(BundleError::InvalidSnapshot);
    }
    Ok(())
}

fn validate_coverage_scope(
    endpoint: &str,
    course_id: Option<u64>,
    group_id: Option<u64>,
    context_code: Option<&str>,
) -> Result<(), BundleError> {
    let is_group_endpoint = GROUP_COVERAGE_ENDPOINTS.contains(&endpoint);
    if (is_group_endpoint && group_id.is_none())
        || (!is_group_endpoint && group_id.is_some() && endpoint != "calendarEvents")
        || (group_id.is_some() && course_id.is_some())
        || (context_code.is_some() && endpoint != "calendarEvents")
    {
        return Err(BundleError::InvalidSnapshot);
    }
    validate_context_scope(endpoint, course_id, group_id, context_code)
}

fn validate_context_scope(
    endpoint: &str,
    course_id: Option<u64>,
    group_id: Option<u64>,
    context_code: Option<&str>,
) -> Result<(), BundleError> {
    if let Some(context_code) = context_code {
        if endpoint != "calendarEvents" {
            return Err(BundleError::InvalidSnapshot);
        }
        let (kind, id) = parse_context_code(context_code)?;
        match kind {
            "user" | "account" if course_id.is_none() && group_id.is_none() => {}
            "course" if group_id.is_none() && course_id.is_none_or(|value| value == id) => {}
            "group" if course_id.is_none() && group_id.is_none_or(|value| value == id) => {}
            _ => return Err(BundleError::InvalidSnapshot),
        }
    }
    Ok(())
}

fn optional_context_code(value: &Value) -> Result<Option<String>, BundleError> {
    match value.get("contextCode") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(code)) => {
            parse_context_code(code)?;
            Ok(Some(code.clone()))
        }
        Some(_) => Err(BundleError::InvalidSnapshot),
    }
}

fn parse_context_code(value: &str) -> Result<(&str, u64), BundleError> {
    if value.len() > 40 {
        return Err(BundleError::InvalidSnapshot);
    }
    let (kind, suffix) = value.split_once('_').ok_or(BundleError::InvalidSnapshot)?;
    if !["user", "account", "course", "group"].contains(&kind)
        || suffix.is_empty()
        || suffix.starts_with('0')
        || !suffix.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(BundleError::InvalidSnapshot);
    }
    let id = suffix
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or(BundleError::InvalidSnapshot)?;
    Ok((kind, id))
}

fn optional_id(value: &Value, key: &str) -> Result<Option<u64>, BundleError> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|id| *id > 0)
            .map(Some)
            .ok_or(BundleError::InvalidSnapshot),
    }
}

fn valid_endpoint(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}
