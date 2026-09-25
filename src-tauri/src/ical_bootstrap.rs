//! Derives a minimal first-run scope from canonical links on the fixed Canvas origin.

use std::collections::{HashMap, HashSet};

use crate::canvas::CANVAS_ORIGIN;

use super::parse::{canvas_link, origin, parse_events};
use super::{IcalCourseIdentity, IcalNormalizationError, IcalNormalizeOptions, MAX_ICAL_BYTES};

const MAX_COURSES: usize = 500;

pub(super) fn bootstrap_options(
    input: &[u8],
) -> Result<IcalNormalizeOptions, IcalNormalizationError> {
    if input.len() > MAX_ICAL_BYTES {
        return Err(IcalNormalizationError::TooLarge);
    }
    let text = std::str::from_utf8(input).map_err(|_| IcalNormalizationError::MalformedCalendar)?;
    let (url, expected_origin) = origin(CANVAS_ORIGIN)?;
    let institution = url
        .host_str()
        .ok_or(IcalNormalizationError::InvalidInput)?
        .to_owned();
    let (events, _) = parse_events(text)?;
    let mut ids = HashSet::new();
    for event in events {
        if let Some(link) = canvas_link(
            event.url.as_deref(),
            event.uid.as_deref().unwrap_or_default(),
            &expected_origin,
        ) {
            ids.insert(link.course_id);
            if ids.len() > MAX_COURSES {
                return Err(IcalNormalizationError::InvalidInput);
            }
        }
    }
    if ids.is_empty() {
        return Err(IcalNormalizationError::InvalidInput);
    }
    let mut courses = ids
        .into_iter()
        .map(|canvas_course_id| IcalCourseIdentity {
            key: format!("canvas-{canvas_course_id}"),
            canvas_course_id,
        })
        .collect::<Vec<_>>();
    courses.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(IcalNormalizeOptions {
        institution,
        canvas_origin: CANVAS_ORIGIN.to_owned(),
        courses,
        verified_events: HashMap::new(),
        explicit_uid_mappings: HashMap::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(url: &str) -> Vec<u8> {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-assignment-7\r\nSUMMARY:Synthetic assignment\r\nDTSTART:20300120T150000Z\r\nURL:{url}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n").into_bytes()
    }

    #[test]
    fn accepts_only_fixed_origin_course_links() {
        let options = bootstrap_options(&feed(
            "https://marymount.instructure.com/courses/42/assignments/7",
        ))
        .unwrap();
        assert_eq!(options.institution, "marymount.instructure.com");
        assert_eq!(options.courses[0].key, "canvas-42");
        assert!(
            bootstrap_options(&feed("https://other.invalid/courses/42/assignments/7")).is_err()
        );
        assert!(bootstrap_options(&feed(
            "https://marymount.instructure.com/courses/42/settings"
        ))
        .is_err());
    }
}
