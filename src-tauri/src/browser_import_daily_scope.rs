//! Fixed daily-page completion contract, separate from immutable archive completeness.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::browser_bundle::{ActiveCourseCoverage, CaptureCoverage};

use super::{BrowserImportError, OPTIONAL_FILE_BODY_REASONS};

const DAILY_COURSE_ENDPOINTS: [&str; 8] = [
    "course",
    "assignments",
    "assignmentGroups",
    "submissions",
    "pages",
    "modules",
    "announcements",
    "courseFiles",
];
const DAILY_ACCOUNT_ENDPOINTS: [&str; 4] = [
    "inbox",
    "inboxAll",
    "conversationsSent",
    "conversationsArchived",
];
const DAILY_OMISSION_REASONS: [&str; 6] = [
    "disabled",
    "forbidden-optional",
    "locked",
    "not-applicable",
    "not-found",
    "unpublished",
];
const MAX_ARCHIVED_FILE_BYTES: u64 = 256 * 1024 * 1024;

pub(super) fn summarize_daily_scope(
    snapshot: &Value,
    active_courses: &[ActiveCourseCoverage],
    coverage: &[CaptureCoverage],
) -> Result<(usize, usize), BrowserImportError> {
    let resources = snapshot
        .get("resources")
        .and_then(Value::as_array)
        .ok_or(BrowserImportError::Stage)?;
    let active_ids = active_courses
        .iter()
        .map(|course| course.course_id)
        .collect::<BTreeSet<_>>();
    let mut required_gaps = 0usize;
    let mut omissions = 0usize;
    let mut required_rows = BTreeSet::new();

    for course in active_courses {
        for endpoint in DAILY_COURSE_ENDPOINTS {
            let rows = coverage
                .iter()
                .filter(|row| root_coverage_scope(row, endpoint, Some(course.course_id)))
                .collect::<Vec<_>>();
            let omission = rows.len() == 1
                && is_confirmed_omission(rows[0], coverage, Some(course.course_id))
                && root_resource_count(resources, endpoint, Some(course.course_id)) == 0;
            if omission {
                omissions += 1;
            } else if rows.len() != 1
                || rows.first().is_none_or(|row| row.status != "complete")
                || root_resource_count(resources, endpoint, Some(course.course_id)) != 1
            {
                required_gaps += 1;
            }
            required_rows.extend(rows.into_iter().map(coverage_key));
        }
    }
    for endpoint in DAILY_ACCOUNT_ENDPOINTS {
        let rows = coverage
            .iter()
            .filter(|row| root_coverage_scope(row, endpoint, None))
            .collect::<Vec<_>>();
        let omission = rows.len() == 1
            && is_confirmed_omission(rows[0], coverage, None)
            && root_resource_count(resources, endpoint, None) == 0;
        if omission {
            omissions += 1;
        } else if rows.len() != 1
            || rows.first().is_none_or(|row| row.status != "complete")
            || root_resource_count(resources, endpoint, None) != 1
        {
            required_gaps += 1;
        }
        required_rows.extend(rows.into_iter().map(coverage_key));
    }

    let mut summaries = BTreeSet::new();
    let mut invalid_summary_ids = 0usize;
    for endpoint in DAILY_ACCOUNT_ENDPOINTS {
        for resource in resources
            .iter()
            .filter(|resource| root_resource_scope(resource, endpoint, None))
        {
            for item in resource_items(resource)? {
                match positive_id(item.get("id")) {
                    Some(id) => {
                        summaries.insert(id);
                    }
                    None => invalid_summary_ids += 1,
                }
            }
        }
    }
    let detail_resources = resources
        .iter()
        .filter(|resource| root_resource_scope(resource, "conversation", None))
        .collect::<Vec<_>>();
    let mut details = BTreeSet::new();
    let mut invalid_detail_ids = 0usize;
    for resource in &detail_resources {
        for item in resource_items(resource)? {
            match positive_id(item.get("id")) {
                Some(id) => {
                    details.insert(id);
                }
                None => invalid_detail_ids += 1,
            }
        }
    }
    let conversation_rows = coverage
        .iter()
        .filter(|row| root_coverage_scope(row, "conversation", None))
        .collect::<Vec<_>>();
    let complete_details = conversation_rows
        .iter()
        .filter(|row| row.status == "complete")
        .count();
    let omitted_details = conversation_rows
        .iter()
        .filter(|row| is_confirmed_omission(row, coverage, row.course_id))
        .count();
    let missing_details = summaries.difference(&details).count();
    let unexpected_details = details.difference(&summaries).count();
    omissions += omitted_details;
    required_gaps += [
        summaries
            .len()
            .saturating_sub(complete_details.saturating_add(omitted_details)),
        missing_details.saturating_sub(omitted_details),
        details.len().saturating_sub(summaries.len()),
        unexpected_details,
        conversation_rows.len().saturating_sub(summaries.len()),
        detail_resources.len().saturating_sub(details.len()),
        invalid_summary_ids,
        invalid_detail_ids,
    ]
    .into_iter()
    .max()
    .unwrap_or(0);

    for row in coverage {
        if row.status == "complete"
            || row.endpoint == "fileBodies"
            || required_rows.contains(&coverage_key(row))
            || row.endpoint == "conversation"
        {
            continue;
        }
        if row.endpoint == "calendar" && row.reason.as_deref() == Some("unsupported") {
            continue;
        }
        if matches!(row.endpoint.as_str(), "calendar" | "calendarEvents")
            || row.course_id.is_some_and(|id| !active_ids.contains(&id))
        {
            if is_confirmed_omission(row, coverage, row.course_id) {
                omissions += 1;
            }
            continue;
        }
        if row.status == "incomplete" {
            required_gaps += 1;
            continue;
        }
        if is_confirmed_omission(row, coverage, row.course_id) {
            omissions += 1;
            continue;
        }
        required_gaps += 1;
    }

    let mut file_receipts = std::collections::BTreeMap::<u64, Option<&Value>>::new();
    for resource in resources
        .iter()
        .filter(|resource| resource.get("endpoint").and_then(Value::as_str) == Some("fileBodies"))
    {
        for receipt in resource_items(resource)? {
            if let Some(file_id) = positive_id(receipt.get("fileId")) {
                match file_receipts.entry(file_id) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert(Some(receipt));
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        entry.insert(None);
                    }
                }
            }
        }
    }
    omissions += file_receipts
        .values()
        .filter_map(|receipt| receipt.as_ref())
        .filter(|receipt| {
            receipt.get("status").and_then(Value::as_str) == Some("gap")
                && receipt
                    .get("reason")
                    .and_then(Value::as_str)
                    .is_some_and(|reason| OPTIONAL_FILE_BODY_REASONS.contains(&reason))
        })
        .count();
    for resource in resources.iter().filter(|resource| {
        resource.get("endpoint").and_then(Value::as_str) == Some("courseFiles")
            && resource
                .get("courseId")
                .and_then(Value::as_u64)
                .is_some_and(|id| active_ids.contains(&id))
            && resource.get("groupId").is_none_or(Value::is_null)
            && resource.get("contextCode").is_none_or(Value::is_null)
    }) {
        let mut seen = BTreeSet::new();
        for file in resource_items(resource)? {
            let Some(file_id) = positive_id(file.get("id")) else {
                required_gaps += 1;
                continue;
            };
            if !seen.insert(file_id) {
                required_gaps += 1;
                continue;
            }
            match file_receipts.get(&file_id).copied().flatten() {
                Some(receipt) if valid_archived_file_receipt(receipt, file_id) => {}
                Some(receipt)
                    if receipt.get("status").and_then(Value::as_str) == Some("gap")
                        && receipt
                            .get("reason")
                            .and_then(Value::as_str)
                            .is_some_and(|reason| OPTIONAL_FILE_BODY_REASONS.contains(&reason)) => {
                }
                _ => required_gaps += 1,
            }
        }
    }

    if required_gaps > 100_000 || omissions > 100_000 {
        return Err(BrowserImportError::Stage);
    }
    Ok((required_gaps, omissions))
}

/// Returns whether a claimed full capture contains any known failure or unverified file body.
pub(super) fn has_capture_failures(
    snapshot: &Value,
    coverage: &[CaptureCoverage],
) -> Result<bool, BrowserImportError> {
    let mut calendar_events_captured = false;
    for row in coverage {
        if row.endpoint == "calendarEvents" && row.status == "complete" {
            calendar_events_captured |= has_calendar_event_resource(snapshot, row)?;
        }
    }
    let coverage_failure = coverage.iter().any(|row| {
        if row.status == "complete" {
            return false;
        }
        if row.status == "incomplete" {
            return true;
        }
        if row.endpoint == "calendar" && row.reason.as_deref() == Some("unsupported") {
            return !calendar_events_captured;
        }
        !is_confirmed_omission(row, coverage, row.course_id)
    });
    Ok(coverage_failure || !file_bodies_complete(snapshot, coverage)?)
}

fn has_calendar_event_resource(
    snapshot: &Value,
    coverage: &CaptureCoverage,
) -> Result<bool, BrowserImportError> {
    let resources = snapshot
        .get("resources")
        .and_then(Value::as_array)
        .ok_or(BrowserImportError::Stage)?;
    Ok(resources.iter().any(|resource| {
        resource.get("endpoint").and_then(Value::as_str) == Some("calendarEvents")
            && positive_id(resource.get("courseId")) == coverage.course_id
            && positive_id(resource.get("groupId")) == coverage.group_id
            && resource.get("contextCode").and_then(Value::as_str)
                == coverage.context_code.as_deref()
            && resource.get("items").and_then(Value::as_array).is_some()
    }))
}

fn file_bodies_complete(
    snapshot: &Value,
    coverage: &[CaptureCoverage],
) -> Result<bool, BrowserImportError> {
    let resources = snapshot
        .get("resources")
        .and_then(Value::as_array)
        .ok_or(BrowserImportError::Stage)?;
    let mut eligible_ids = BTreeSet::new();
    let mut zero_sizes = BTreeSet::new();
    let mut other_sizes = BTreeSet::new();
    for resource in resources.iter().filter(|resource| {
        matches!(
            resource.get("endpoint").and_then(Value::as_str),
            Some("courseFiles" | "personalFiles" | "personalFile" | "groupFolderFiles" | "file")
        )
    }) {
        for item in resource_items(resource)? {
            let Some(id) = positive_id(item.get("id")) else {
                return Ok(false);
            };
            eligible_ids.insert(id);
            match item.get("size") {
                Some(size) if size.as_u64() == Some(0) => {
                    zero_sizes.insert(id);
                }
                Some(size) if !size.is_null() => {
                    other_sizes.insert(id);
                }
                _ => {}
            }
        }
    }

    let mut has_empty_receipt = false;
    let mut receipt_ids = BTreeSet::new();
    for resource in resources
        .iter()
        .filter(|resource| resource.get("endpoint").and_then(Value::as_str) == Some("fileBodies"))
    {
        for receipt in resource_items(resource)? {
            let Some(file_id) = positive_id(receipt.get("fileId")) else {
                return Ok(false);
            };
            if !receipt_ids.insert(file_id) {
                return Ok(false);
            }
            match receipt.get("status").and_then(Value::as_str) {
                Some("archived") => {}
                Some("gap") if receipt["reason"] == "empty" => {
                    if !zero_sizes.contains(&file_id) || other_sizes.contains(&file_id) {
                        return Ok(false);
                    }
                    has_empty_receipt = true;
                }
                Some("gap")
                    if receipt
                        .get("reason")
                        .and_then(Value::as_str)
                        .is_some_and(|reason| OPTIONAL_FILE_BODY_REASONS.contains(&reason)) => {}
                _ => return Ok(false),
            }
        }
    }
    let claims_empty = coverage
        .iter()
        .any(|row| row.reason.as_deref() == Some("empty"));
    Ok(eligible_ids == receipt_ids && (!claims_empty || has_empty_receipt))
}

fn coverage_key(row: &CaptureCoverage) -> (String, Option<u64>, Option<u64>, Option<String>) {
    (
        row.endpoint.clone(),
        row.course_id,
        row.group_id,
        row.context_code.clone(),
    )
}

pub(super) fn is_confirmed_omission(
    row: &CaptureCoverage,
    coverage: &[CaptureCoverage],
    course_id: Option<u64>,
) -> bool {
    if row.status != "gap" {
        return false;
    }
    match row.reason.as_deref() {
        Some("empty") => row.endpoint == "fileBodies",
        Some(reason) if DAILY_OMISSION_REASONS.contains(&reason) => true,
        Some("parent-unavailable") => parent_is_omitted(row, coverage, course_id),
        _ => false,
    }
}

fn parent_is_omitted(
    row: &CaptureCoverage,
    coverage: &[CaptureCoverage],
    course_id: Option<u64>,
) -> bool {
    let Some(parent_endpoint) = parent_endpoint(&row.endpoint) else {
        return false;
    };
    let matches = coverage
        .iter()
        .filter(|parent| {
            parent.endpoint == parent_endpoint
                && parent.course_id == course_id
                && parent.group_id == row.group_id
                && parent.context_code == row.context_code
        })
        .collect::<Vec<_>>();
    matches.len() == 1
        && matches[0].status == "gap"
        && matches[0]
            .reason
            .as_deref()
            .is_some_and(|reason| DAILY_OMISSION_REASONS.contains(&reason))
}

fn parent_endpoint(endpoint: &str) -> Option<&'static str> {
    match endpoint {
        "file" => Some("courseFiles"),
        "page" => Some("pages"),
        "moduleItems" => Some("modules"),
        "discussionEntries" | "discussionReplies" => Some("discussions"),
        "submission" => Some("submissions"),
        "quiz" => Some("quizzes"),
        "personalFile" => Some("personalFiles"),
        "groupFolderFiles" => Some("groupFolders"),
        "groupPage" => Some("groupPages"),
        "groupDiscussionEntries" | "groupDiscussionReplies" => Some("groupDiscussions"),
        _ => None,
    }
}

fn root_coverage_scope(row: &CaptureCoverage, endpoint: &str, course_id: Option<u64>) -> bool {
    row.endpoint == endpoint
        && row.course_id == course_id
        && row.group_id.is_none()
        && row.context_code.is_none()
}

fn root_resource_scope(resource: &Value, endpoint: &str, course_id: Option<u64>) -> bool {
    resource.get("endpoint").and_then(Value::as_str) == Some(endpoint)
        && resource.get("courseId").and_then(Value::as_u64) == course_id
        && resource.get("groupId").is_none_or(Value::is_null)
        && resource.get("contextCode").is_none_or(Value::is_null)
}

fn root_resource_count(resources: &[Value], endpoint: &str, course_id: Option<u64>) -> usize {
    resources
        .iter()
        .filter(|resource| root_resource_scope(resource, endpoint, course_id))
        .count()
}

fn resource_items(resource: &Value) -> Result<&[Value], BrowserImportError> {
    resource
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or(BrowserImportError::Stage)
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|id| *id > 0)
}

fn valid_archived_file_receipt(receipt: &Value, file_id: u64) -> bool {
    if receipt.get("status").and_then(Value::as_str) != Some("archived")
        || positive_id(receipt.get("fileId")) != Some(file_id)
        || receipt
            .get("byteCount")
            .and_then(Value::as_u64)
            .is_none_or(|bytes| bytes == 0 || bytes > MAX_ARCHIVED_FILE_BYTES)
        || receipt.get("sourceAuthenticity").and_then(Value::as_str) != Some("unverified")
    {
        return false;
    }
    let Some(hash) = receipt.get("sha256").and_then(Value::as_str) else {
        return false;
    };
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return false;
    }
    let Some(content_type) = receipt.get("contentType").and_then(Value::as_str) else {
        return false;
    };
    let Some((major, minor)) = content_type.split_once('/') else {
        return false;
    };
    [major, minor].iter().all(|part| {
        !part.is_empty()
            && part.len() <= 64
            && part.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-.+".contains(&byte)
            })
    })
}
