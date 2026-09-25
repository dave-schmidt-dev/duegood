//! Envelope, folding, and property parsing for the pure iCalendar normalizer.

use std::collections::HashMap;

use url::Url;

use crate::ical::{IcalNormalizationError as Error, MAX_ICAL_EVENTS};

#[derive(Default)]
pub(crate) struct RawEvent {
    pub(crate) uid: Option<String>,
    pub(crate) summary: Option<String>,
    pub(crate) start: Option<String>,
    pub(crate) url: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) method_cancel: bool,
    method_seen: bool,
    pub(crate) recurrence_id: Option<String>,
}

pub(crate) fn safe_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= max
        && !value
            .chars()
            .any(|c| matches!(c as u32, 0..=8 | 11..=12 | 14..=31 | 127))
}

fn unfold(input: &str) -> Result<Vec<String>, Error> {
    let mut lines: Vec<String> = Vec::new();
    for line in input.split(['\r', '\n']).filter(|line| !line.is_empty()) {
        if line.starts_with([' ', '\t']) {
            let Some(previous) = lines.last_mut() else {
                return Err(Error::MalformedCalendar);
            };
            previous.push_str(&line[1..]);
        } else {
            lines.push(line.to_owned());
        }
    }
    if lines.first().map(String::as_str) != Some("BEGIN:VCALENDAR")
        || lines.last().map(String::as_str) != Some("END:VCALENDAR")
        || !lines.iter().any(|line| line == "VERSION:2.0")
    {
        return Err(Error::MalformedCalendar);
    }
    Ok(lines)
}

fn property_value(line: &str) -> Result<&str, Error> {
    line.split_once(':')
        .map(|(_, value)| value)
        .ok_or(Error::MalformedCalendar)
}

fn validate_tzid(head: &str) -> Result<(), Error> {
    let name = head.split(';').skip(1).find_map(|param| {
        let (key, value) = param.split_once('=')?;
        key.eq_ignore_ascii_case("TZID").then_some(value)
    });
    if name.is_some_and(|name| name.parse::<chrono_tz::Tz>().is_err()) {
        return Err(Error::UnresolvedTimezone);
    }
    Ok(())
}

fn unescape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(next @ (',' | ';' | '\\')) => out.push(next),
            Some(next) => {
                out.push('\\');
                out.push(next);
            }
            None => out.push('\\'),
        }
    }
    out
}

pub(crate) fn parse_events(input: &str) -> Result<(Vec<RawEvent>, bool), Error> {
    let mut stack: Vec<String> = Vec::new();
    let mut events = Vec::new();
    let mut current: Option<RawEvent> = None;
    let mut cancelled = false;
    let mut seen_calendar = false;
    for line in unfold(input)? {
        if let Some(component) = line.strip_prefix("BEGIN:") {
            if component.is_empty()
                || !component
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
                || (!stack.is_empty() && component == "VCALENDAR")
                || (stack.is_empty() && component != "VCALENDAR")
            {
                return Err(Error::MalformedCalendar);
            }
            if component == "VCALENDAR" {
                if seen_calendar {
                    return Err(Error::MalformedCalendar);
                }
                seen_calendar = true;
            }
            if component == "VEVENT" {
                if stack.last().map(String::as_str) != Some("VCALENDAR") {
                    return Err(Error::MalformedCalendar);
                }
                if events.len() >= MAX_ICAL_EVENTS {
                    return Err(Error::TooManyEvents);
                }
                current = Some(RawEvent::default());
            }
            stack.push(component.to_owned());
            continue;
        }
        if let Some(component) = line.strip_prefix("END:") {
            if stack.pop().as_deref() != Some(component) {
                return Err(Error::MalformedCalendar);
            }
            if component == "VEVENT" {
                let event = current.take().ok_or(Error::MalformedCalendar)?;
                if event.uid.is_none() {
                    return Err(Error::MalformedCalendar);
                }
                events.push(event);
            }
            continue;
        }
        if stack.is_empty() {
            return Err(Error::MalformedCalendar);
        }
        let (head, _) = line.split_once(':').ok_or(Error::MalformedCalendar)?;
        validate_tzid(head)?;
        if stack.last().map(String::as_str) == Some("VCALENDAR") && line == "METHOD:CANCEL" {
            cancelled = true;
        }
        if current.is_none() || stack.last().map(String::as_str) != Some("VEVENT") {
            continue;
        }
        let name = head.split(';').next().unwrap_or_default();
        let event = current.as_mut().expect("checked above");
        match name {
            "UID" => set_once(&mut event.uid, &line)?,
            "SUMMARY" => set_once(&mut event.summary, &line)?,
            "DTSTART" => set_once(&mut event.start, &line)?,
            "URL" => set_once(&mut event.url, &line)?,
            "STATUS" => set_once(&mut event.status, &line)?,
            "RECURRENCE-ID" => set_once(&mut event.recurrence_id, &line)?,
            "METHOD" => {
                if event.method_seen {
                    return Err(Error::MalformedCalendar);
                }
                event.method_seen = true;
                event.method_cancel = line == "METHOD:CANCEL";
            }
            _ => {}
        }
    }
    if !stack.is_empty() || !seen_calendar {
        return Err(Error::MalformedCalendar);
    }
    for event in &mut events {
        if let Some(line) = event.uid.take() {
            event.uid = Some(property_value(&line)?.to_owned());
        }
        if let Some(line) = event.summary.take() {
            event.summary = Some(unescape_text(property_value(&line)?));
        }
        if let Some(line) = event.url.take() {
            event.url = Some(property_value(&line)?.to_owned());
        }
        if let Some(line) = event.status.take() {
            event.status = Some(property_value(&line)?.to_owned());
        }
        if let Some(line) = event.recurrence_id.take() {
            event.recurrence_id = Some(property_value(&line)?.to_owned());
        }
    }
    if events.iter().any(|event| {
        !event.uid.as_ref().is_some_and(|uid| safe_text(uid, 500))
            || event
                .summary
                .as_ref()
                .is_some_and(|summary| !safe_text(summary, 1_000))
    }) {
        return Err(Error::MalformedCalendar);
    }
    Ok((events, cancelled))
}

fn set_once(target: &mut Option<String>, line: &str) -> Result<(), Error> {
    if target.is_some() {
        return Err(Error::MalformedCalendar);
    }
    *target = Some(line.to_owned());
    Ok(())
}

pub(super) struct CanvasLink {
    pub(super) course_id: String,
    pub(super) kind: &'static str,
    pub(super) id: String,
    pub(super) url: String,
}

pub(super) fn numeric_id(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes()[0].is_ascii_digit()
        && value.as_bytes()[0] != b'0'
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn calendar_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    match bytes {
        [b'1'..=b'9'] | [b'0', b'1'..=b'9'] | [b'1', b'0'..=b'2'] => true,
        _ => false,
    }
}

pub(super) fn origin(value: &str) -> Result<(Url, String), Error> {
    let url = Url::parse(value).map_err(|_| Error::InvalidInput)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidInput);
    }
    let serialized = url.origin().ascii_serialization();
    Ok((url, serialized))
}

fn path_id(path: &str, resource: Option<&str>) -> Option<(String, &'static str, String)> {
    let parts: Vec<&str> = path.split('/').collect();
    let parts = if parts.last() == Some(&"") {
        &parts[..parts.len() - 1]
    } else {
        &parts[..]
    };
    if parts.len() != 5
        || parts[0] != ""
        || parts[1] != "courses"
        || !numeric_id(parts[2])
        || !numeric_id(parts[4])
    {
        return None;
    }
    let kind = match parts[3] {
        "assignments" if resource.is_none_or(|r| r == "assignments") => "assignment",
        "calendar_events" if resource.is_none_or(|r| r == "calendar_events") => "event",
        _ => return None,
    };
    Some((parts[2].into(), kind, parts[4].into()))
}

pub(super) fn canvas_link(
    raw: Option<&str>,
    uid: &str,
    expected_origin: &str,
) -> Option<CanvasLink> {
    let raw = raw?;
    if raw.encode_utf16().count() > 2_048 {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.origin().ascii_serialization() != expected_origin
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    if url.fragment().is_none_or(str::is_empty) {
        if url.scheme() != "https" {
            return None;
        }
        if let Some((course_id, kind, id)) = path_id(url.path(), None) {
            let segment = if kind == "assignment" {
                "assignments"
            } else {
                "calendar_events"
            };
            return Some(CanvasLink {
                url: format!("{expected_origin}/courses/{course_id}/{segment}/{id}"),
                course_id,
                kind,
                id,
            });
        }
        return None;
    }
    if url.path() != "/calendar" || url.scheme() != "https" {
        return None;
    }
    let uid = uid.strip_prefix("event-")?;
    let (uid_kind, id) = if let Some(id) = uid.strip_prefix("assignment-") {
        ("assignment", id)
    } else if let Some(id) = uid.strip_prefix("calendar-event-") {
        ("event", id)
    } else {
        return None;
    };
    if !numeric_id(id) {
        return None;
    }
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if pairs.len() != 3 {
        return None;
    }
    let mut values = HashMap::new();
    for (key, value) in pairs {
        if values.insert(key, value).is_some() {
            return None;
        }
    }
    if values.len() != 3 {
        return None;
    }
    let course_id = values.get("include_contexts")?.strip_prefix("course_")?;
    let month = values.get("month")?;
    let year = values.get("year")?;
    if !numeric_id(course_id)
        || !calendar_month(month)
        || year.len() != 4
        || year.starts_with('0')
        || !year.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let expected_fragment = format!(
        "{}_{}",
        if uid_kind == "assignment" {
            "assignment"
        } else {
            "calendar_event"
        },
        id
    );
    if url.fragment()? != expected_fragment {
        return None;
    }
    let segment = if uid_kind == "assignment" {
        "assignments"
    } else {
        "calendar_events"
    };
    Some(CanvasLink {
        url: format!("{expected_origin}/courses/{course_id}/{segment}/{id}"),
        course_id: course_id.into(),
        kind: uid_kind,
        id: id.into(),
    })
}
