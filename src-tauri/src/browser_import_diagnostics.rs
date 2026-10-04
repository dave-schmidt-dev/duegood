//! Bounded, content-free capture diagnostics persisted with browser import status.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{json, Value};

use crate::browser_bundle::ValidatedCaptureBundle;

const MAX_DIAGNOSTIC_COUNT: usize = 100_000;
const DIAGNOSTIC_ENDPOINTS: &[&str] = &[
    "profile",
    "coursesActive",
    "coursesCompleted",
    "personalFiles",
    "personalFolders",
    "personalFile",
    "inbox",
    "inboxAll",
    "conversationsSent",
    "conversationsArchived",
    "conversation",
    "course",
    "syllabus",
    "courseTabs",
    "assignments",
    "assignmentGroups",
    "submissions",
    "submission",
    "pages",
    "page",
    "modules",
    "moduleItems",
    "discussions",
    "discussionEntries",
    "discussionReplies",
    "announcements",
    "quizzes",
    "quiz",
    "courseFiles",
    "folders",
    "file",
    "fileBodies",
    "groups",
    "groupFolders",
    "groupFolderFiles",
    "groupPages",
    "groupPage",
    "groupDiscussions",
    "groupDiscussionEntries",
    "groupDiscussionReplies",
    "calendar",
    "calendarEvents",
];
const DIAGNOSTIC_REASONS: &[&str] = &[
    "capture-budget",
    "detail-budget",
    "disabled",
    "forbidden-optional",
    "invalid-slug",
    "locked",
    "not-applicable",
    "not-attempted",
    "not-found",
    "pagination-budget",
    "parent-unavailable",
    "request-failed",
    "unsupported",
    "unpublished",
];
const OPTIONAL_FILE_REASONS: &[&str] = &["locked", "unpublished", "not-applicable", "unsupported"];
const FILE_RECEIPT_REASONS: &[&str] = &[
    "CANCELED",
    "REQUEST_TIMEOUT",
    "INVALID_FILE_URL",
    "UNSAFE_REQUEST",
    "HTTP_STATUS_REJECTED",
    "RESPONSE_TOO_LARGE",
    "EMPTY_RESPONSE",
    "REDIRECT_HANDOFF_UNSUPPORTED",
    "REDIRECT_WITHOUT_LOCATION",
    "INVALID_REDIRECT_LOCATION",
    "CANVAS_SESSION_UNAVAILABLE",
    "CANVAS_NAVIGATION_FAILED",
    "CDP_SESSION_FAILED",
    "NETWORK_SETUP_FAILED",
    "SERVICE_WORKER_BYPASS_FAILED",
    "FETCH_INTERCEPTOR_SETUP_FAILED",
    "FETCH_DRIVER_FAILED",
    "CDP_RESPONSE_FAILED",
    "STAGING_CREATE_FAILED",
    "STAGING_WRITE_FAILED",
    "STAGING_PERMISSIONS_REJECTED",
    "UNSAFE_STAGING_DIRECTORY",
    "PROGRESS_CALLBACK_FAILED",
    "HELPER_UNAVAILABLE",
    "HELPER_DOWNLOAD_FAILED",
    "CAPTURE_DISK_BUDGET_EXCEEDED",
    "DOWNLOAD_FAILED",
    "HELPER_DOWNLOAD_INVALID_URL",
    "HELPER_DOWNLOAD_REDIRECT_REFUSED",
    "HELPER_DOWNLOAD_TOO_MANY_REDIRECTS",
    "HELPER_DOWNLOAD_RESPONSE_TOO_LARGE",
    "HELPER_DOWNLOAD_INVALID_AVATAR",
    "HELPER_DOWNLOAD_REQUEST_FAILED",
    "HELPER_DOWNLOAD_HTTP_STATUS",
    "HELPER_DOWNLOAD_CONCURRENCY_LOCK_POISONED",
    "HELPER_DOWNLOAD_SIGN_IN_RESPONSE",
    "HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH",
    "HELPER_DOWNLOAD_SIZE_MISMATCH",
    "HELPER_DOWNLOAD_UNSAFE_STAGING_DIRECTORY",
    "HELPER_DOWNLOAD_STAGING_FAILED",
    "redirect-handoff-pending",
    "invalid-download-result",
    "file-id-mismatch",
    "invalid-staged-size",
    "file-size-mismatch",
    "invalid-staged-file",
    "invalid-file-hash",
    "invalid-content-type",
    "invalid-source-authenticity",
    "download-not-configured",
    "file-count-limit",
    "invalid-or-oversized-file-size",
    "locked",
    "source-url-unavailable",
];

pub(super) fn import_diagnostics(
    bundle: &ValidatedCaptureBundle,
    required_gap_count: usize,
    optional_omission_count: usize,
) -> Value {
    let mut grouped = BTreeMap::<(&'static str, &'static str, &'static str), usize>::new();
    let mut grouped_total = 0usize;
    let mut grouped_truncated = false;
    for row in &bundle.coverage {
        if row.status == "complete" {
            continue;
        }
        if grouped_total >= MAX_DIAGNOSTIC_COUNT {
            grouped_truncated = true;
            break;
        }
        grouped_total += 1;
        let endpoint = diagnostic_endpoint(&row.endpoint);
        let reason = diagnostic_reason(row.reason.as_deref());
        let status = match row.status.as_str() {
            "gap" => "gap",
            "incomplete" => "incomplete",
            _ => "other",
        };
        let count = grouped.entry((endpoint, reason, status)).or_default();
        *count = count.saturating_add(1).min(MAX_DIAGNOSTIC_COUNT);
    }
    let coverage_reasons = grouped
        .into_iter()
        .map(|((endpoint, reason, status), count)| {
            json!({"endpoint": endpoint, "reason": reason, "status": status, "count": count})
        })
        .collect::<Vec<_>>();

    json!({
        "requiredGapCount": required_gap_count.min(MAX_DIAGNOSTIC_COUNT),
        "optionalOmissionCount": optional_omission_count.min(MAX_DIAGNOSTIC_COUNT),
        "coverageReasonCounts": coverage_reasons,
        "coverageReasonCountsTruncated": grouped_truncated,
        "fileReceipts": file_receipt_diagnostics(bundle),
    })
}

fn diagnostic_endpoint(value: &str) -> &'static str {
    DIAGNOSTIC_ENDPOINTS
        .iter()
        .copied()
        .find(|endpoint| *endpoint == value)
        .unwrap_or("other")
}

fn diagnostic_reason(value: Option<&str>) -> &'static str {
    match value {
        Some(reason) => DIAGNOSTIC_REASONS
            .iter()
            .copied()
            .find(|allowed| *allowed == reason)
            .unwrap_or("other"),
        None => "missing-reason",
    }
}

fn file_receipt_diagnostics(bundle: &ValidatedCaptureBundle) -> Value {
    #[derive(Clone, Copy)]
    enum ReceiptKind {
        Archived,
        OptionalOmission,
        Failed,
        Other,
    }

    let active_ids = bundle
        .active_courses
        .iter()
        .map(|course| course.course_id)
        .collect::<BTreeSet<_>>();
    let resources = bundle
        .snapshot
        .get("resources")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut listed_ids = BTreeSet::new();
    let mut invalid_listed_files = 0usize;
    let mut duplicate_listed_files = 0usize;
    let mut inspected = 0usize;
    for resource in resources.iter().filter(|resource| {
        resource.get("endpoint").and_then(Value::as_str) == Some("courseFiles")
            && resource
                .get("courseId")
                .and_then(Value::as_u64)
                .is_some_and(|id| active_ids.contains(&id))
            && resource.get("groupId").is_none_or(Value::is_null)
            && resource.get("contextCode").is_none_or(Value::is_null)
    }) {
        let Some(items) = resource.get("items").and_then(Value::as_array) else {
            continue;
        };
        for file in items
            .iter()
            .take(MAX_DIAGNOSTIC_COUNT.saturating_sub(inspected))
        {
            inspected += 1;
            let Some(id) = positive_id(file.get("id")) else {
                bounded_increment(&mut invalid_listed_files);
                continue;
            };
            if !listed_ids.insert(id) {
                bounded_increment(&mut duplicate_listed_files);
            }
        }
        if inspected >= MAX_DIAGNOSTIC_COUNT {
            break;
        }
    }

    let mut receipts = HashMap::<u64, ReceiptKind>::new();
    let mut duplicate_receipts = 0usize;
    let mut invalid_receipts = 0usize;
    let mut reason_counts = BTreeMap::<&'static str, usize>::new();
    inspected = 0;
    for resource in resources
        .iter()
        .filter(|resource| resource.get("endpoint").and_then(Value::as_str) == Some("fileBodies"))
    {
        let Some(items) = resource.get("items").and_then(Value::as_array) else {
            continue;
        };
        for receipt in items
            .iter()
            .take(MAX_DIAGNOSTIC_COUNT.saturating_sub(inspected))
        {
            inspected += 1;
            let Some(file_id) = positive_id(receipt.get("fileId")) else {
                bounded_increment(&mut invalid_receipts);
                continue;
            };
            let status = receipt.get("status").and_then(Value::as_str).unwrap_or("");
            let reason = receipt.get("reason").and_then(Value::as_str);
            if status == "gap" {
                let bucket = file_receipt_reason(reason);
                let count = reason_counts.entry(bucket).or_default();
                *count = count.saturating_add(1).min(MAX_DIAGNOSTIC_COUNT);
            }
            let kind = match status {
                "archived" | "staged" => ReceiptKind::Archived,
                "gap" if reason.is_some_and(|value| OPTIONAL_FILE_REASONS.contains(&value)) => {
                    ReceiptKind::OptionalOmission
                }
                "gap" => ReceiptKind::Failed,
                _ => ReceiptKind::Other,
            };
            if listed_ids.contains(&file_id) {
                if let std::collections::hash_map::Entry::Vacant(entry) = receipts.entry(file_id) {
                    entry.insert(kind);
                } else {
                    bounded_increment(&mut duplicate_receipts);
                }
            }
        }
        if inspected >= MAX_DIAGNOSTIC_COUNT {
            break;
        }
    }

    let mut archived = 0usize;
    let mut optional_omissions = 0usize;
    let mut failed = 0usize;
    let mut other = 0usize;
    let mut missing = 0usize;
    for file_id in &listed_ids {
        match receipts.get(file_id) {
            Some(ReceiptKind::Archived) => bounded_increment(&mut archived),
            Some(ReceiptKind::OptionalOmission) => bounded_increment(&mut optional_omissions),
            Some(ReceiptKind::Failed) => bounded_increment(&mut failed),
            Some(ReceiptKind::Other) => bounded_increment(&mut other),
            None => bounded_increment(&mut missing),
        }
    }
    json!({
        "activeFilesListed": listed_ids.len().min(MAX_DIAGNOSTIC_COUNT),
        "archivedReceipts": archived,
        "optionalOmissionReceipts": optional_omissions,
        "failedReceipts": failed,
        "otherReceipts": other,
        "missingReceipts": missing,
        "invalidListedFiles": invalid_listed_files,
        "duplicateListedFiles": duplicate_listed_files,
        "duplicateReceipts": duplicate_receipts,
        "invalidReceipts": invalid_receipts,
        "reasonCounts": reason_counts
            .into_iter()
            .map(|(reason, count)| json!({"reason": reason, "count": count}))
            .collect::<Vec<_>>(),
    })
}

fn file_receipt_reason(value: Option<&str>) -> &'static str {
    match value {
        Some(reason) => FILE_RECEIPT_REASONS
            .iter()
            .copied()
            .find(|allowed| *allowed == reason)
            .unwrap_or("other"),
        None => "other",
    }
}

fn bounded_increment(value: &mut usize) {
    *value = value.saturating_add(1).min(MAX_DIAGNOSTIC_COUNT);
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    let id = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))?;
    (id > 0).then_some(id)
}
