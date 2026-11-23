//! Content-free validation and counts for Canvas coursework bodies.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

const BODY_ENDPOINTS: [(&str, &str); 10] = [
    ("assignments", "assignment"),
    ("discussions", "discussion"),
    ("announcements", "announcement"),
    ("quizzes", "quiz"),
    ("quiz", "quiz"),
    ("pages", "page"),
    ("page", "page"),
    ("groupDiscussions", "group-discussion"),
    ("groupPages", "group-page"),
    ("groupPage", "group-page"),
];

const BODY_OMISSION_REASONS: [&str; 5] = [
    "forbidden-optional",
    "locked",
    "not-applicable",
    "not-found",
    "unpublished",
];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BodyCoverageCounts {
    pub body_count: usize,
    pub empty_body_count: usize,
    pub missing_count: usize,
    pub sanitize_failed_count: usize,
    pub active_failure_count: usize,
    pub body_failure_reason: Option<&'static str>,
}

impl BodyCoverageCounts {
    pub(crate) fn has_failures(self) -> bool {
        self.missing_count > 0 || self.sanitize_failed_count > 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BodyCoverageError {
    InvalidResources,
    BudgetExceeded,
}

#[derive(Default)]
struct BodyEvidence {
    empty: Option<bool>,
    reason: Option<&'static str>,
    omitted: bool,
    active: bool,
}

pub(crate) fn summarize(
    snapshot: &Value,
    active_course_ids: &BTreeSet<u64>,
) -> Result<BodyCoverageCounts, BodyCoverageError> {
    let resources = snapshot
        .get("resources")
        .and_then(Value::as_array)
        .ok_or(BodyCoverageError::InvalidResources)?;
    let active_group_ids = active_groups(resources, active_course_ids)?;
    let mut bodies = BTreeMap::<String, BodyEvidence>::new();
    let mut omission_credits = body_omission_credits(snapshot);

    for resource in resources {
        let endpoint = resource
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some((_, family)) = BODY_ENDPOINTS.iter().find(|(name, _)| *name == endpoint) else {
            continue;
        };
        let course_id = positive_id(resource.get("courseId"));
        let group_id = positive_id(resource.get("groupId"));
        let context_code = resource.get("contextCode").and_then(Value::as_str);
        let active = course_id.is_some_and(|id| active_course_ids.contains(&id))
            || group_id.is_some_and(|id| active_group_ids.contains(&id))
            || context_id(context_code, "course_")
                .is_some_and(|id| active_course_ids.contains(&id))
            || context_id(context_code, "group_").is_some_and(|id| active_group_ids.contains(&id));
        let items = resource
            .get("items")
            .and_then(Value::as_array)
            .ok_or(BodyCoverageError::InvalidResources)?;

        for (index, item) in items.iter().enumerate() {
            let item_id = item
                .get("id")
                .filter(|value| !value.is_null())
                .or_else(|| item.get("page_id").filter(|value| !value.is_null()))
                .or_else(|| item.get("url").filter(|value| !value.is_null()))
                .map(Value::to_string)
                .unwrap_or_else(|| format!("{endpoint}:{index}"));
            let key = format!(
                "{family}:{}:{}:{}:{item_id}",
                course_id.map_or_else(String::new, |id| id.to_string()),
                group_id.map_or_else(String::new, |id| id.to_string()),
                context_code.unwrap_or("")
            );
            let body = item.get("_canvasBody");
            let body_reason = match item.get("_canvasBodyReason").and_then(Value::as_str) {
                Some("BODY_SANITIZE_FAILED") => Some("BODY_SANITIZE_FAILED"),
                Some("BODY_MISSING") => Some("BODY_MISSING"),
                Some(_) => Some("BODY_SANITIZE_FAILED"),
                None if body.is_none() => Some("BODY_MISSING"),
                None if valid_body(body) => None,
                None => Some("BODY_SANITIZE_FAILED"),
            };
            let marker_reason = item
                .get("_canvasBodyOmissionReason")
                .and_then(Value::as_str)
                .filter(|reason| BODY_OMISSION_REASONS.contains(reason));
            let listing_reason = if matches!(endpoint, "pages" | "groupPages" | "quizzes") {
                if item.get("locked_for_user").and_then(Value::as_bool) == Some(true)
                    || item.get("locked").and_then(Value::as_bool) == Some(true)
                {
                    Some("locked")
                } else if item.get("published").and_then(Value::as_bool) == Some(false) {
                    Some("unpublished")
                } else {
                    None
                }
            } else {
                None
            };
            let detail_endpoint = match endpoint {
                "pages" if group_id.is_some() => Some("groupPage"),
                "pages" => Some("page"),
                "quizzes" => Some("quiz"),
                "groupPages" => Some("groupPage"),
                _ => None,
            };
            let omission_reason = marker_reason.or(listing_reason);
            let omission_confirmed = detail_endpoint.is_some_and(|detail_endpoint| {
                consume_omission_credit(
                    &mut omission_credits,
                    detail_endpoint,
                    course_id,
                    group_id,
                    context_code,
                    omission_reason,
                )
            });
            let entry = bodies.entry(key).or_default();
            entry.active |= active;
            if omission_confirmed
                && (listing_reason.is_some() || body_reason == Some("BODY_MISSING"))
            {
                if entry.empty.is_none() && entry.reason != Some("BODY_SANITIZE_FAILED") {
                    entry.omitted = true;
                }
                continue;
            }
            if body_reason.is_none() {
                entry.empty = body
                    .and_then(|value| value.get("empty"))
                    .and_then(Value::as_bool);
                entry.reason = None;
                entry.omitted = false;
            } else if entry.empty.is_none() {
                if body_reason == Some("BODY_SANITIZE_FAILED") || entry.reason.is_none() {
                    entry.reason = body_reason;
                }
                if body_reason == Some("BODY_SANITIZE_FAILED") {
                    entry.omitted = false;
                }
            }
        }
    }

    let mut counts = BodyCoverageCounts::default();
    for evidence in bodies.values() {
        if let Some(empty) = evidence.empty {
            counts.body_count += 1;
            if empty {
                counts.empty_body_count += 1;
            }
        } else if !evidence.omitted {
            match evidence.reason {
                Some("BODY_SANITIZE_FAILED") => counts.sanitize_failed_count += 1,
                Some("BODY_MISSING") => counts.missing_count += 1,
                _ => {}
            }
            if evidence.active && evidence.reason.is_some() {
                counts.active_failure_count += 1;
            }
        }
    }
    if counts.body_count > 100_000
        || counts.empty_body_count > counts.body_count
        || counts.missing_count + counts.sanitize_failed_count > 100_000
    {
        return Err(BodyCoverageError::BudgetExceeded);
    }
    counts.body_failure_reason = if counts.sanitize_failed_count > 0 {
        Some("BODY_SANITIZE_FAILED")
    } else if counts.missing_count > 0 {
        Some("BODY_MISSING")
    } else {
        None
    };
    Ok(counts)
}

type OmissionKey = (String, Option<u64>, Option<u64>, Option<String>, String);

fn body_omission_credits(snapshot: &Value) -> BTreeMap<OmissionKey, usize> {
    let mut credits = BTreeMap::new();
    for row in snapshot
        .get("coverage")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(mut endpoint @ ("page" | "quiz" | "groupPage")) =
            row.get("endpoint").and_then(Value::as_str)
        else {
            continue;
        };
        let Some(reason) = row.get("reason").and_then(Value::as_str) else {
            continue;
        };
        if row.get("status").and_then(Value::as_str) != Some("gap")
            || !BODY_OMISSION_REASONS.contains(&reason)
        {
            continue;
        }
        if endpoint == "page" && positive_id(row.get("groupId")).is_some() {
            endpoint = "groupPage";
        }
        let key = omission_key(
            endpoint,
            positive_id(row.get("courseId")),
            positive_id(row.get("groupId")),
            row.get("contextCode").and_then(Value::as_str),
            reason,
        );
        *credits.entry(key).or_default() += 1;
    }
    credits
}

fn consume_omission_credit(
    credits: &mut BTreeMap<OmissionKey, usize>,
    endpoint: &str,
    course_id: Option<u64>,
    group_id: Option<u64>,
    context_code: Option<&str>,
    reason: Option<&str>,
) -> bool {
    let Some(reason) = reason.filter(|reason| BODY_OMISSION_REASONS.contains(reason)) else {
        return false;
    };
    let key = omission_key(endpoint, course_id, group_id, context_code, reason);
    let Some(remaining) = credits.get_mut(&key) else {
        return false;
    };
    if *remaining == 0 {
        return false;
    }
    *remaining -= 1;
    true
}

fn omission_key(
    endpoint: &str,
    course_id: Option<u64>,
    group_id: Option<u64>,
    context_code: Option<&str>,
    reason: &str,
) -> OmissionKey {
    (
        endpoint.to_owned(),
        course_id,
        group_id,
        context_code.map(str::to_owned),
        reason.to_owned(),
    )
}

fn active_groups(
    resources: &[Value],
    active_course_ids: &BTreeSet<u64>,
) -> Result<BTreeSet<u64>, BodyCoverageError> {
    let mut active_group_ids = BTreeSet::new();
    for resource in resources
        .iter()
        .filter(|resource| resource.get("endpoint").and_then(Value::as_str) == Some("groups"))
    {
        let items = resource
            .get("items")
            .and_then(Value::as_array)
            .ok_or(BodyCoverageError::InvalidResources)?;
        for item in items {
            let Some(group_id) = positive_id(item.get("id")) else {
                continue;
            };
            let Some(course_id) =
                positive_id(item.get("course_id").or_else(|| item.get("courseId")))
            else {
                continue;
            };
            if active_course_ids.contains(&course_id) {
                active_group_ids.insert(group_id);
            }
        }
    }
    Ok(active_group_ids)
}

fn valid_body(body: Option<&Value>) -> bool {
    let Some(body) = body.and_then(Value::as_object) else {
        return false;
    };
    body.len() == 3
        && body
            .get("html")
            .and_then(Value::as_str)
            .is_some_and(|html| html.len() <= 512 * 1024)
        && body
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| text.len() <= 512 * 1024)
        && body
            .get("empty")
            .and_then(Value::as_bool)
            .is_some_and(|empty| {
                !empty
                    || body.get("html").and_then(Value::as_str) == Some("")
                        && body.get("text").and_then(Value::as_str) == Some("")
            })
}

fn context_id(context_code: Option<&str>, prefix: &str) -> Option<u64> {
    let value = context_code?.strip_prefix(prefix)?;
    let id = value.parse::<u64>().ok()?;
    (id > 0 && id.to_string() == value).then_some(id)
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|id| *id > 0)
}
