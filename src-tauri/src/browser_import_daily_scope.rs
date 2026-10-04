//! Fixed daily-page completion contract, separate from immutable archive completeness.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::browser_bundle::{ActiveCourseCoverage, CaptureCoverage};

use super::BrowserImportError;

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
const DAILY_DETAIL_ENDPOINTS: [&str; 1] = ["conversation"];
const DAILY_OMISSION_REASONS: [&str; 4] =
    ["locked", "unpublished", "not-applicable", "unsupported"];
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
            if rows.len() != 1
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
        if rows.len() != 1
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
    let missing_details = summaries.difference(&details).count();
    let unexpected_details = details.difference(&summaries).count();
    required_gaps += [
        summaries.len().saturating_sub(details.len()),
        summaries.len().saturating_sub(complete_details),
        details.len().saturating_sub(summaries.len()),
        missing_details,
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
            || matches!(row.endpoint.as_str(), "calendar" | "calendarEvents")
            || row.course_id.is_some_and(|id| !active_ids.contains(&id))
            || required_rows.contains(&coverage_key(row))
            || row.endpoint == "conversation"
        {
            continue;
        }
        if row.status == "incomplete" {
            required_gaps += 1;
            continue;
        }
        let reason = row.reason.as_deref().unwrap_or("");
        if DAILY_OMISSION_REASONS.contains(&reason) {
            omissions += 1;
            continue;
        }
        let optional_access = matches!(reason, "forbidden-optional" | "not-found");
        if optional_access
            && !DAILY_COURSE_ENDPOINTS.contains(&row.endpoint.as_str())
            && !DAILY_ACCOUNT_ENDPOINTS.contains(&row.endpoint.as_str())
            && !DAILY_DETAIL_ENDPOINTS.contains(&row.endpoint.as_str())
        {
            omissions += 1;
            continue;
        }
        required_gaps += 1;
    }

    let mut active_file_ids = BTreeSet::new();
    for resource in resources.iter().filter(|resource| {
        resource.get("endpoint").and_then(Value::as_str) == Some("courseFiles")
            && resource
                .get("courseId")
                .and_then(Value::as_u64)
                .is_some_and(|id| active_ids.contains(&id))
            && resource.get("groupId").is_none_or(Value::is_null)
            && resource.get("contextCode").is_none_or(Value::is_null)
    }) {
        for file in resource_items(resource)? {
            if let Some(file_id) = positive_id(file.get("id")) {
                active_file_ids.insert(file_id);
            }
        }
    }

    let mut file_receipts = std::collections::BTreeMap::<u64, Option<&Value>>::new();
    for resource in resources
        .iter()
        .filter(|resource| resource.get("endpoint").and_then(Value::as_str) == Some("fileBodies"))
    {
        for receipt in resource_items(resource)? {
            if let Some(file_id) = positive_id(receipt.get("fileId")) {
                let status = receipt.get("status").and_then(Value::as_str).unwrap_or("");
                let reason = receipt.get("reason").and_then(Value::as_str);
                match file_receipts.entry(file_id) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert(Some(receipt));
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        entry.insert(None);
                    }
                }
                if active_file_ids.contains(&file_id)
                    && status == "gap"
                    && reason.is_some_and(|value| DAILY_OMISSION_REASONS.contains(&value))
                {
                    omissions += 1;
                }
            }
        }
    }
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
                            .is_some_and(|reason| DAILY_OMISSION_REASONS.contains(&reason)) => {}
                _ => required_gaps += 1,
            }
        }
    }

    if required_gaps > 100_000 || omissions > 100_000 {
        return Err(BrowserImportError::Stage);
    }
    Ok((required_gaps, omissions))
}

fn coverage_key(row: &CaptureCoverage) -> (String, Option<u64>, Option<u64>, Option<String>) {
    (
        row.endpoint.clone(),
        row.course_id,
        row.group_id,
        row.context_code.clone(),
    )
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
