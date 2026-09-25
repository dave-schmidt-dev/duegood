//! Pure event classification and observation construction for iCalendar feeds.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::date::{parse_start, StartTime};
use super::parse::{
    canvas_link, numeric_id, origin, parse_events, safe_text, CanvasLink, RawEvent,
};
use super::{
    EventKind, HeldIcalEvent, IcalDateValue, IcalNormalization, IcalNormalizationError,
    IcalNormalizeOptions, NormalizedIcalEvent, MAX_ICAL_BYTES,
};

fn fail<T>(error: IcalNormalizationError) -> Result<T, IcalNormalizationError> {
    Err(error)
}

fn valid_identity(kind: EventKind, id: &str) -> bool {
    match kind {
        EventKind::AssignmentParent => id.strip_prefix("assignment:").is_some_and(numeric_id),
        EventKind::OtherEvent => id.strip_prefix("event:").is_some_and(numeric_id),
        EventKind::DiscussionPostCheckpoint => checkpoint(id, "discussion-post-checkpoint"),
        EventKind::DiscussionReplyCheckpoint => checkpoint(id, "discussion-reply-checkpoint"),
    }
}

fn checkpoint(id: &str, kind: &str) -> bool {
    let Some(rest) = id.strip_prefix("assignment:") else {
        return false;
    };
    let Some((assignment, suffix)) = rest.split_once(":checkpoint:") else {
        return false;
    };
    numeric_id(assignment) && suffix == kind
}

fn identifier(parts: &[&str]) -> String {
    let bytes = serde_json::to_vec(parts).expect("string array serializes");
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn add_held(
    held: &mut Vec<HeldIcalEvent>,
    event: &RawEvent,
    link: Option<&CanvasLink>,
    reason: &'static str,
    candidates: Vec<String>,
) {
    held.push(HeldIcalEvent {
        uid: event.uid.clone().unwrap_or_default(),
        reason,
        canvas_course_id: link.map(|item| item.course_id.clone()),
        candidate_courses: candidates,
        cancelled: reason == "cancelled-event",
    });
}

pub(super) fn normalize_canvas_ical(
    input: &[u8],
    options: &IcalNormalizeOptions,
) -> Result<IcalNormalization, IcalNormalizationError> {
    if input.len() > MAX_ICAL_BYTES {
        return fail(IcalNormalizationError::TooLarge);
    }
    if !safe_text(&options.institution, 160) {
        return fail(IcalNormalizationError::InvalidInput);
    }
    let text = std::str::from_utf8(input).map_err(|_| IcalNormalizationError::MalformedCalendar)?;
    let (_, expected_origin) = origin(&options.canvas_origin)?;
    let (raw_events, calendar_cancelled) = parse_events(text)?;
    let mut course_by_canvas: HashMap<String, Vec<String>> = HashMap::new();
    let mut course_key_count: HashMap<String, usize> = HashMap::new();
    for course in &options.courses {
        if !safe_text(&course.key, 160) || !numeric_id(&course.canvas_course_id) {
            return fail(IcalNormalizationError::InvalidInput);
        }
        *course_key_count.entry(course.key.clone()).or_default() += 1;
        course_by_canvas
            .entry(course.canvas_course_id.clone())
            .or_default()
            .push(course.key.clone());
    }
    for matches in course_by_canvas.values_mut() {
        matches.sort();
        matches.dedup();
    }
    let mut uid_counts = HashMap::<String, usize>::new();
    for event in &raw_events {
        *uid_counts
            .entry(event.uid.clone().unwrap_or_default())
            .or_default() += 1;
    }
    let mut events = Vec::<NormalizedIcalEvent>::new();
    let mut held = Vec::<HeldIcalEvent>::new();
    let mut identities = HashSet::<(String, String, String)>::new();
    for (index, event) in raw_events.iter().enumerate() {
        let uid = event.uid.as_deref().unwrap_or_default();
        let link = canvas_link(event.url.as_deref(), uid, &expected_origin);
        let cancelled = calendar_cancelled
            || event.method_cancel
            || event
                .status
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case("CANCELLED"));
        let mut candidates = link
            .as_ref()
            .and_then(|l| course_by_canvas.get(&l.course_id))
            .cloned()
            .unwrap_or_default();
        candidates.sort();
        candidates.dedup();
        if cancelled {
            add_held(
                &mut held,
                event,
                link.as_ref(),
                "cancelled-event",
                candidates,
            );
            continue;
        }
        if event.recurrence_id.is_some()
            || uid_counts[uid] > 1
                && !raw_events
                    .iter()
                    .any(|e| e.uid.as_deref() == Some(uid) && e.recurrence_id.is_some())
        {
            add_held(
                &mut held,
                event,
                link.as_ref(),
                "ambiguous-event",
                candidates,
            );
            continue;
        }
        let (Some(summary), Some(start)) = (&event.summary, &event.start) else {
            add_held(
                &mut held,
                event,
                link.as_ref(),
                "unsupported-event",
                candidates,
            );
            continue;
        };
        let parsed_start = parse_start(start)?;
        let at = match parsed_start {
            StartTime::Date(value) => IcalDateValue {
                kind: "date",
                value,
                zone: None,
            },
            StartTime::Timed {
                utc: None,
                zone: None,
            } => {
                add_held(&mut held, event, link.as_ref(), "floating-time", candidates);
                continue;
            }
            StartTime::Timed {
                utc: None,
                zone: Some(_),
            } => {
                add_held(
                    &mut held,
                    event,
                    link.as_ref(),
                    "ambiguous-event",
                    candidates,
                );
                continue;
            }
            StartTime::Timed {
                utc: Some(value),
                zone,
            } => IcalDateValue {
                kind: "timed",
                value: format!("{}Z", value.format("%Y-%m-%dT%H:%M:%S.000")),
                zone,
            },
        };
        let explicit = event
            .url
            .is_none()
            .then(|| options.explicit_uid_mappings.get(uid))
            .flatten();
        if link.is_none() && explicit.is_none() {
            add_held(&mut held, event, None, "unsupported-event", candidates);
            continue;
        }
        if let Some(link) = &link {
            if candidates.is_empty() {
                add_held(&mut held, event, Some(link), "unknown-course", candidates);
                continue;
            }
            if candidates.len() != 1 || course_key_count.get(&candidates[0]) != Some(&1) {
                add_held(&mut held, event, Some(link), "ambiguous-course", candidates);
                continue;
            }
        }
        let (course, kind, stable_identity) = if let Some(explicit) = explicit {
            let count = course_key_count
                .get(&explicit.course_key)
                .copied()
                .unwrap_or(0);
            if count != 1 {
                add_held(
                    &mut held,
                    event,
                    link.as_ref(),
                    if count == 0 {
                        "unknown-course"
                    } else {
                        "ambiguous-course"
                    },
                    candidates,
                );
                continue;
            }
            if !valid_identity(explicit.kind, &explicit.stable_identity) {
                return fail(IcalNormalizationError::InvalidInput);
            }
            (
                explicit.course_key.clone(),
                explicit.kind,
                explicit.stable_identity.clone(),
            )
        } else if let Some(link) = &link {
            if link.kind == "assignment" {
                (
                    candidates[0].clone(),
                    EventKind::AssignmentParent,
                    format!("assignment:{}", link.id),
                )
            } else {
                let Some(verified) = options
                    .verified_events
                    .get(&link.id)
                    .filter(|v| v.course_id == link.course_id)
                else {
                    add_held(&mut held, event, Some(link), "ambiguous-event", candidates);
                    continue;
                };
                if verified.kind == EventKind::AssignmentParent
                    || verified.kind == EventKind::DiscussionPostCheckpoint
                        && !verified
                            .parent_assignment_id
                            .as_deref()
                            .is_some_and(numeric_id)
                    || verified.kind == EventKind::DiscussionReplyCheckpoint
                        && !verified
                            .parent_assignment_id
                            .as_deref()
                            .is_some_and(numeric_id)
                {
                    return fail(IcalNormalizationError::InvalidInput);
                }
                let identity = match verified.kind {
                    EventKind::OtherEvent => format!("event:{}", link.id),
                    EventKind::DiscussionPostCheckpoint => format!(
                        "assignment:{}:checkpoint:discussion-post-checkpoint",
                        verified.parent_assignment_id.as_deref().unwrap_or_default()
                    ),
                    EventKind::DiscussionReplyCheckpoint => format!(
                        "assignment:{}:checkpoint:discussion-reply-checkpoint",
                        verified.parent_assignment_id.as_deref().unwrap_or_default()
                    ),
                    EventKind::AssignmentParent => unreachable!(),
                };
                (candidates[0].clone(), verified.kind, identity)
            }
        } else {
            unreachable!("mapping must be present when link is missing")
        };
        let identity_key = (
            options.institution.clone(),
            course.clone(),
            stable_identity.clone(),
        );
        if !identities.insert(identity_key) {
            if let Some(position) = events.iter().position(|previous| {
                previous.calendar_identity == stable_identity && previous.course == course
            }) {
                let previous = events.remove(position);
                held.push(HeldIcalEvent {
                    uid: previous.uid,
                    reason: "ambiguous-event",
                    canvas_course_id: link.as_ref().map(|item| item.course_id.clone()),
                    candidate_courses: Vec::new(),
                    cancelled: false,
                });
            }
            add_held(
                &mut held,
                event,
                link.as_ref(),
                "ambiguous-event",
                Vec::new(),
            );
            continue;
        }
        let fields_kind = match kind {
            EventKind::AssignmentParent => "assignment",
            EventKind::OtherEvent => "event",
            _ => "discussion-checkpoint",
        };
        let local_id = format!(
            "ical-{}",
            identifier(&[&options.institution, &course, &stable_identity])
        );
        let reference = json!({"institution": options.institution, "course": course, "source": "ical", "id": stable_identity});
        let mut fields = json!({"kind": fields_kind, "title": summary, "at": at.value});
        if let Some(link) = &link {
            fields["url"] = Value::String(link.url.clone());
        }
        let observation = json!({"localId": local_id, "course": course, "reference": reference, "fields": fields});
        events.push(NormalizedIcalEvent {
            kind,
            uid: uid.into(),
            course,
            canvas_course_id: link.as_ref().map(|item| item.course_id.clone()),
            calendar_identity: stable_identity,
            title: summary.clone(),
            at,
            observation,
        });
        let _ = index;
    }
    events.sort_by(|a, b| {
        a.observation["localId"]
            .as_str()
            .cmp(&b.observation["localId"].as_str())
    });
    held.sort_by(|a, b| a.uid.cmp(&b.uid));
    let observations = events
        .iter()
        .map(|event| event.observation.clone())
        .collect();
    Ok(IcalNormalization {
        events,
        observations,
        held,
        deletions: 0,
    })
}
