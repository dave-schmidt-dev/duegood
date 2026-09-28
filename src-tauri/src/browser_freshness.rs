//! Content-free freshness derived from one journaled import and the latest capture attempt.
//!
//! Retained documents are never evidence that a later failed or running capture succeeded.
//! This pure projection performs no I/O and assigns no invented age-based expiration policy.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFreshness {
    pub current: bool,
    pub reason: &'static str,
    pub run_id: Option<u64>,
    pub observed_at: Option<String>,
    pub sections: Vec<SectionFreshness>,
    pub capture_availability: Option<CaptureAvailability>,
}

/// Native-validated capture metadata that is safe for the dashboard recovery surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureAvailability {
    pub available: bool,
    pub reason: &'static str,
    pub run_id: Option<u64>,
    pub observed_at: Option<String>,
    pub active_course_count: Option<usize>,
    pub resource_count: Option<usize>,
    pub item_count: Option<usize>,
    pub blob_count: Option<usize>,
    pub blob_bytes: Option<u64>,
    pub account_confirmation_needed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionFreshness {
    pub course_id: Option<u64>,
    pub endpoint: String,
    pub current: bool,
}

fn positive(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(|value| {
            value.as_u64().or_else(|| {
                value
                    .as_str()
                    .filter(|text| {
                        !text.is_empty()
                            && text.len() <= 20
                            && text.bytes().all(|b| b.is_ascii_digit())
                    })
                    .and_then(|text| text.parse().ok())
            })
        })
        .filter(|id| *id > 0)
}

fn unknown(reason: &'static str) -> BrowserFreshness {
    BrowserFreshness {
        current: false,
        reason,
        run_id: None,
        observed_at: None,
        sections: Vec::new(),
        capture_availability: None,
    }
}

/// Projects freshness only when the latest durable attempt matches the published import.
/// Caller supplies a validated, atomically read attempt; unavailable/busy state is `None`.
pub fn project_freshness(imported: Option<&Value>, attempt: Option<&Value>) -> BrowserFreshness {
    let Some(imported) = imported else {
        return unknown("not-imported");
    };
    let Some(attempt) = attempt else {
        return unknown("attempt-unavailable");
    };
    if imported["format"] != "duegood-browser-import" || imported["version"] != 1 {
        return unknown("invalid-import-receipt");
    }
    let run_id = positive(imported.get("runId"));
    let latest_id = positive(attempt.get("runId").or_else(|| attempt.get("run_id")));
    if run_id.is_none() || latest_id.is_none() {
        return unknown("invalid-run");
    }
    if run_id != latest_id {
        return unknown("newer-or-inconsistent-attempt");
    }
    if attempt["status"] != "captured" {
        return unknown("capture-unverified");
    }
    let generation = imported
        .get("generationId")
        .and_then(Value::as_str)
        .filter(|id| {
            id.len() == 32
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
    let latest_generation = attempt
        .get("generationId")
        .or_else(|| attempt.get("generation_id"))
        .and_then(Value::as_str);
    let user = positive(imported.get("userId"));
    let latest_user = positive(attempt.get("userId").or_else(|| attempt.get("user_id")));
    if generation.is_none()
        || generation != latest_generation
        || user.is_none()
        || user != latest_user
    {
        return unknown("identity-or-generation-mismatch");
    }
    let Some(observed_at) = imported
        .get("observedAt")
        .and_then(Value::as_str)
        .filter(|stamp| stamp.len() <= 80 && chrono::DateTime::parse_from_rfc3339(stamp).is_ok())
    else {
        return unknown("invalid-observation");
    };
    let Some(records) = imported
        .get("sections")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() <= 20_000)
    else {
        return unknown("invalid-coverage");
    };
    let mut sections = Vec::new();
    let mut identities = std::collections::BTreeSet::new();
    for record in records {
        let Some(endpoint) = record
            .get("endpoint")
            .and_then(Value::as_str)
            .filter(|name| {
                !name.is_empty()
                    && name.len() <= 80
                    && name.bytes().all(|b| b.is_ascii_alphanumeric())
            })
        else {
            return unknown("invalid-coverage");
        };
        if record.get("courseId").is_none() {
            return unknown("invalid-coverage");
        }
        let course_id = if record["courseId"].is_null() {
            None
        } else {
            let Some(id) = positive(record.get("courseId")) else {
                return unknown("invalid-coverage");
            };
            Some(id)
        };
        if !identities.insert((course_id, endpoint)) {
            return unknown("duplicate-coverage");
        }
        let Some(status) = record
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| matches!(*status, "complete" | "incomplete" | "gap"))
        else {
            return unknown("invalid-coverage");
        };
        sections.push(SectionFreshness {
            course_id,
            endpoint: endpoint.into(),
            current: status == "complete",
        });
    }
    BrowserFreshness {
        current: true,
        reason: "verified-import",
        run_id,
        observed_at: Some(observed_at.into()),
        sections,
        capture_availability: None,
    }
}

/// Existing binding state is read from the private store; the Canvas ID never leaves native code.
pub(crate) enum ExistingAccountBinding {
    Unbound,
    Bound(u64),
    Unverifiable,
}

/// Adds a bounded capture availability summary after native pointer/snapshot/link validation.
pub(crate) fn with_capture_availability(
    mut freshness: BrowserFreshness,
    attempt_read_ok: bool,
    attempt: Option<&crate::capture_run::CaptureAttempt>,
    summary: Option<&crate::capture_run::PublishedGenerationSummary>,
    binding: ExistingAccountBinding,
) -> BrowserFreshness {
    let unavailable = |reason| CaptureAvailability {
        available: false,
        reason,
        run_id: None,
        observed_at: None,
        active_course_count: None,
        resource_count: None,
        item_count: None,
        blob_count: None,
        blob_bytes: None,
        account_confirmation_needed: false,
    };
    if !attempt_read_ok {
        freshness.capture_availability = Some(unavailable("attempt-unavailable"));
        return freshness;
    }
    let Some(attempt) = attempt else {
        freshness.capture_availability = Some(unavailable("no-capture"));
        return freshness;
    };
    if attempt.status != crate::capture_run::CaptureAttemptStatus::Captured {
        freshness.capture_availability = Some(unavailable("capture-unverified"));
        return freshness;
    }
    let Some(summary) = summary.filter(|summary| {
        Some(summary.user_id) == attempt.user_id
            && attempt.generation_id.as_deref() == Some(summary.generation_id.as_str())
    }) else {
        freshness.current = false;
        freshness.reason = "capture-unverified";
        freshness.run_id = None;
        freshness.observed_at = None;
        freshness.sections.clear();
        freshness.capture_availability = Some(unavailable("archive-unverified"));
        return freshness;
    };
    let (available, reason, account_confirmation_needed) = match binding {
        ExistingAccountBinding::Unbound => (true, "confirmation-required", true),
        ExistingAccountBinding::Bound(user_id) if user_id == summary.user_id => {
            (true, "already-bound", false)
        }
        ExistingAccountBinding::Bound(_) => (false, "account-mismatch", false),
        ExistingAccountBinding::Unverifiable => (false, "account-binding-unverified", false),
    };
    freshness.capture_availability = Some(CaptureAvailability {
        available,
        reason,
        run_id: Some(attempt.run_id),
        observed_at: Some(summary.captured_at.clone()),
        active_course_count: Some(summary.active_course_count),
        resource_count: Some(summary.resource_count),
        item_count: Some(summary.item_count),
        blob_count: Some(summary.blob_count),
        blob_bytes: Some(summary.blob_bytes),
        account_confirmation_needed,
    });
    freshness
}

#[cfg(test)]
#[path = "browser_freshness_tests.rs"]
mod tests;
