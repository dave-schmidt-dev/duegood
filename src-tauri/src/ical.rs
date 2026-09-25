//! Bounded, pure Canvas iCalendar normalization. This module neither fetches feeds nor writes data.

use std::collections::HashMap;

use serde_json::Value;

#[path = "ical_bootstrap.rs"]
mod bootstrap;
#[path = "ical_date.rs"]
mod date;
#[path = "ical_parse.rs"]
mod parse;

pub const MAX_ICAL_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_ICAL_EVENTS: usize = 2_000;

#[derive(Clone, Debug)]
pub struct IcalCourseIdentity {
    pub key: String,
    pub canvas_course_id: String,
}

#[derive(Clone, Debug)]
pub struct VerifiedCalendarEvent {
    pub kind: EventKind,
    pub course_id: String,
    pub parent_assignment_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ExplicitFeedIdentity {
    pub course_key: String,
    pub stable_identity: String,
    pub kind: EventKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventKind {
    AssignmentParent,
    DiscussionPostCheckpoint,
    DiscussionReplyCheckpoint,
    OtherEvent,
}

#[derive(Clone, Debug)]
pub struct IcalNormalizeOptions {
    pub institution: String,
    pub canvas_origin: String,
    pub courses: Vec<IcalCourseIdentity>,
    pub verified_events: HashMap<String, VerifiedCalendarEvent>,
    pub explicit_uid_mappings: HashMap<String, ExplicitFeedIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IcalNormalizationError {
    InvalidInput,
    TooLarge,
    TooManyEvents,
    MalformedCalendar,
    UnresolvedTimezone,
}

impl std::fmt::Display for IcalNormalizationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            Self::InvalidInput => "INVALID_INPUT",
            Self::TooLarge => "TOO_LARGE",
            Self::TooManyEvents => "TOO_MANY_EVENTS",
            Self::MalformedCalendar => "MALFORMED_CALENDAR",
            Self::UnresolvedTimezone => "UNRESOLVED_TIMEZONE",
        };
        write!(f, "Calendar normalization failed: {code}")
    }
}

impl std::error::Error for IcalNormalizationError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedIcalEvent {
    pub kind: EventKind,
    pub uid: String,
    pub course: String,
    pub canvas_course_id: Option<String>,
    pub calendar_identity: String,
    pub title: String,
    pub at: IcalDateValue,
    pub observation: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IcalDateValue {
    pub kind: &'static str,
    pub value: String,
    pub zone: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HeldIcalEvent {
    pub uid: String,
    pub reason: &'static str,
    pub canvas_course_id: Option<String>,
    pub candidate_courses: Vec<String>,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IcalNormalization {
    pub events: Vec<NormalizedIcalEvent>,
    pub observations: Vec<Value>,
    pub held: Vec<HeldIcalEvent>,
    pub deletions: usize,
}

#[path = "ical_normalize.rs"]
mod normalize;

pub fn normalize_canvas_ical(
    input: &[u8],
    options: &IcalNormalizeOptions,
) -> Result<IcalNormalization, IcalNormalizationError> {
    normalize::normalize_canvas_ical(input, options)
}

/// Builds the initial course scope from canonical links in a bounded Canvas calendar feed.
/// Course labels are deliberately generic: iCal does not establish their display names.
pub fn bootstrap_options(input: &[u8]) -> Result<IcalNormalizeOptions, IcalNormalizationError> {
    bootstrap::bootstrap_options(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn options() -> IcalNormalizeOptions {
        IcalNormalizeOptions {
            institution: "synthetic.institution.invalid".into(),
            canvas_origin: "https://canvas.synthetic.invalid".into(),
            courses: vec![IcalCourseIdentity {
                key: "course-a".into(),
                canvas_course_id: "42".into(),
            }],
            verified_events: [
                (
                    "101".into(),
                    VerifiedCalendarEvent {
                        kind: EventKind::DiscussionPostCheckpoint,
                        course_id: "42".into(),
                        parent_assignment_id: Some("5".into()),
                    },
                ),
                (
                    "103".into(),
                    VerifiedCalendarEvent {
                        kind: EventKind::OtherEvent,
                        course_id: "42".into(),
                        parent_assignment_id: None,
                    },
                ),
            ]
            .into(),
            explicit_uid_mappings: HashMap::new(),
        }
    }

    fn event(uid: &str, url: &str, extra: &str, start: &str) -> String {
        format!("BEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:Synthetic work\r\n{start}\r\nURL:{url}\r\n{extra}END:VEVENT\r\n")
    }

    fn feed(events: &[String], extra: &str) -> Vec<u8> {
        format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{extra}{}END:VCALENDAR\r\n",
            events.join("")
        )
        .into_bytes()
    }

    fn assignment() -> &'static str {
        "https://canvas.synthetic.invalid/courses/42/assignments/5"
    }
    fn assignment_for(id: &str) -> String {
        format!("https://canvas.synthetic.invalid/courses/42/assignments/{id}")
    }
    fn calendar_event(id: &str) -> String {
        format!("https://canvas.synthetic.invalid/courses/42/calendar_events/{id}")
    }

    #[test]
    fn accepted_assignment_has_stable_identity_and_observation_shape() {
        let first = normalize_canvas_ical(
            &feed(
                &[event("one", assignment(), "", "DTSTART:20300120T150000Z")],
                "",
            ),
            &options(),
        )
        .unwrap();
        let second = normalize_canvas_ical(
            &feed(
                &[event(
                    "changed",
                    assignment(),
                    "",
                    "DTSTART:20300120T150000Z",
                )],
                "",
            ),
            &options(),
        )
        .unwrap();
        assert_eq!(first.events[0].calendar_identity, "assignment:5");
        assert_eq!(first.observations[0]["reference"]["source"], "ical");
        assert_eq!(
            first.observations[0]["localId"],
            second.observations[0]["localId"]
        );
        assert_eq!(first.deletions, 0);
    }

    #[test]
    fn date_utc_zoned_and_floating_times_keep_their_meaning() {
        let entries = [
            event(
                "day",
                &assignment_for("6"),
                "",
                "DTSTART;VALUE=DATE:20300120",
            ),
            event("utc", &assignment_for("7"), "", "DTSTART:20300120T150000Z"),
            event(
                "zone",
                &assignment_for("8"),
                "",
                "DTSTART;TZID=America/New_York:20300120T150000",
            ),
            event("float", &assignment_for("9"), "", "DTSTART:20300120T150000"),
        ];
        let result = normalize_canvas_ical(&feed(&entries, ""), &options()).unwrap();
        assert_eq!(result.events.len(), 3);
        assert!(result.events.iter().any(|e| e.at.value == "2030-01-20"));
        assert!(result
            .events
            .iter()
            .any(|e| e.at.value == "2030-01-20T20:00:00.000Z"));
        assert!(result.held.iter().any(|e| e.reason == "floating-time"));
    }

    #[test]
    fn unknown_course_unverified_event_and_foreign_link_are_held() {
        let entries = [
            event(
                "unknown",
                "https://canvas.synthetic.invalid/courses/999/assignments/5",
                "",
                "DTSTART:20300120T150000Z",
            ),
            event(
                "unverified",
                &calendar_event("900"),
                "",
                "DTSTART:20300120T150000Z",
            ),
            event(
                "foreign",
                "https://foreign.synthetic.invalid/courses/42/assignments/5",
                "",
                "DTSTART:20300120T150000Z",
            ),
        ];
        let result = normalize_canvas_ical(&feed(&entries, ""), &options()).unwrap();
        assert!(result.events.is_empty());
        assert_eq!(
            result
                .held
                .iter()
                .map(|e| e.reason)
                .collect::<HashSet<_>>()
                .len(),
            3
        );
        assert_eq!(result.deletions, 0);
    }

    #[test]
    fn calendar_view_link_requires_matching_uid_and_verified_event_semantics() {
        let url = "https://canvas.synthetic.invalid/calendar?include_contexts=course_42&month=09&year=2030#assignment_5";
        let input = feed(
            &[event(
                "event-assignment-5",
                url,
                "",
                "DTSTART:20300120T150000Z",
            )],
            "",
        );
        let accepted = normalize_canvas_ical(&input, &options()).unwrap();
        assert_eq!(accepted.events[0].calendar_identity, "assignment:5");
        let bad = feed(
            &[event(
                "event-assignment-6",
                url,
                "",
                "DTSTART:20300120T150000Z",
            )],
            "",
        );
        assert_eq!(
            normalize_canvas_ical(&bad, &options()).unwrap().held[0].reason,
            "unsupported-event"
        );
        let padded_month = feed(
            &[event(
                "event-assignment-5",
                "https://canvas.synthetic.invalid/calendar?include_contexts=course_42&month=001&year=2030#assignment_5",
                "",
                "DTSTART:20300120T150000Z",
            )],
            "",
        );
        assert_eq!(
            normalize_canvas_ical(&padded_month, &options())
                .unwrap()
                .held[0]
                .reason,
            "unsupported-event"
        );
    }

    #[test]
    fn daylight_saving_fold_and_gap_are_held_without_guessing_a_due_instant() {
        let entries = [
            event(
                "fold",
                &assignment_for("10"),
                "",
                "DTSTART;TZID=America/New_York:20301103T013000",
            ),
            event(
                "gap",
                &assignment_for("11"),
                "",
                "DTSTART;TZID=America/New_York:20300310T023000",
            ),
        ];
        let result = normalize_canvas_ical(&feed(&entries, ""), &options()).unwrap();
        assert!(result.events.is_empty());
        assert_eq!(result.held.len(), 2);
        assert!(result
            .held
            .iter()
            .all(|event| event.reason == "ambiguous-event"));
        assert_eq!(result.deletions, 0);
    }

    #[test]
    fn cancellations_recurrence_and_duplicate_identity_never_delete() {
        let entries = [
            event(
                "cancel",
                assignment(),
                "STATUS:CANCELLED\r\n",
                "DTSTART:20300120T150000Z",
            ),
            event("same", assignment(), "", "DTSTART:20300120T150000Z"),
            event(
                "same",
                assignment(),
                "RECURRENCE-ID:20300120T150000Z\r\n",
                "DTSTART:20300120T150000Z",
            ),
        ];
        let result = normalize_canvas_ical(&feed(&entries, ""), &options()).unwrap();
        assert_eq!(result.events.len(), 1);
        assert!(result
            .held
            .iter()
            .any(|event| event.reason == "cancelled-event"));
        assert!(result
            .held
            .iter()
            .any(|event| event.reason == "ambiguous-event"));
        assert_eq!(result.deletions, 0);
    }

    #[test]
    fn malformed_oversized_overcount_and_unknown_timezone_are_rejected() {
        assert_eq!(
            normalize_canvas_ical(b"bad", &options()).unwrap_err(),
            IcalNormalizationError::MalformedCalendar
        );
        assert_eq!(
            normalize_canvas_ical(&vec![b'x'; MAX_ICAL_BYTES + 1], &options()).unwrap_err(),
            IcalNormalizationError::TooLarge
        );
        let bad_zone = feed(
            &[event(
                "zone",
                assignment(),
                "",
                "DTSTART;TZID=Unknown/Nope:20300120T150000",
            )],
            "",
        );
        assert_eq!(
            normalize_canvas_ical(&bad_zone, &options()).unwrap_err(),
            IcalNormalizationError::UnresolvedTimezone
        );
        let too_many: Vec<String> = (0..=MAX_ICAL_EVENTS)
            .map(|i| {
                event(
                    &format!("id-{i}"),
                    assignment(),
                    "",
                    "DTSTART:20300120T150000Z",
                )
            })
            .collect();
        assert_eq!(
            normalize_canvas_ical(&feed(&too_many, ""), &options()).unwrap_err(),
            IcalNormalizationError::TooManyEvents
        );
    }

    #[test]
    fn folded_text_is_unescaped_and_invalid_start_parameters_fail_closed() {
        let title = "SUMMARY:Synthetic\\, folded\\; title\\nline\r\n continuation\r\n";
        let input = format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:folded\r\n{title}DTSTART:20300120T150000Z\r\nURL:{}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            assignment()
        );
        let result = normalize_canvas_ical(input.as_bytes(), &options()).unwrap();
        assert_eq!(
            result.events[0].title,
            "Synthetic, folded; title\nlinecontinuation"
        );
        let invalid = feed(
            &[event(
                "bad",
                assignment(),
                "",
                "DTSTART;VALUE=DATE;VALUE=DATE;VALUE=DATE:20300120",
            )],
            "",
        );
        assert_eq!(
            normalize_canvas_ical(&invalid, &options()).unwrap_err(),
            IcalNormalizationError::MalformedCalendar
        );
    }

    #[test]
    fn invalid_canvas_origins_and_duplicate_courses_do_not_select_a_course() {
        let mut bad = options();
        bad.canvas_origin = "https://canvas.synthetic.invalid/path".into();
        assert_eq!(
            normalize_canvas_ical(&feed(&[], ""), &bad).unwrap_err(),
            IcalNormalizationError::InvalidInput
        );
        let mut ambiguous = options();
        ambiguous.courses.push(IcalCourseIdentity {
            key: "course-b".into(),
            canvas_course_id: "42".into(),
        });
        let result = normalize_canvas_ical(
            &feed(
                &[event("x", assignment(), "", "DTSTART:20300120T150000Z")],
                "",
            ),
            &ambiguous,
        )
        .unwrap();
        assert_eq!(result.held[0].reason, "ambiguous-course");
    }
}
