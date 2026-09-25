//! Strict iCalendar DTSTART validation and UTC conversion.

use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

use crate::ical::IcalNormalizationError as Error;

pub(crate) enum StartTime {
    Date(String),
    Timed {
        utc: Option<NaiveDateTime>,
        zone: Option<String>,
    },
}

pub(crate) fn parse_start(raw: &str) -> Result<StartTime, Error> {
    let (head, value) = raw.split_once(':').ok_or(Error::MalformedCalendar)?;
    let mut parts = head.split(';');
    if !parts
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("DTSTART"))
    {
        return Err(Error::MalformedCalendar);
    }
    let params: Vec<&str> = parts.collect();
    let date_params = params
        .iter()
        .filter(|p| p.eq_ignore_ascii_case("VALUE=DATE"))
        .count();
    let is_date = date_params > 0 && date_params == params.len() && (1..=2).contains(&date_params);
    if date_params > 0 && !is_date
        || !is_date
            && (params.len() > 1
                || params
                    .iter()
                    .any(|p| !p.to_ascii_uppercase().starts_with("TZID=")))
    {
        return Err(Error::MalformedCalendar);
    }
    let zone_name = params.iter().find_map(|p| {
        let (key, value) = p.split_once('=')?;
        key.eq_ignore_ascii_case("TZID").then_some(value)
    });
    let timezone = zone_name
        .map(|name| name.parse::<Tz>().map_err(|_| Error::UnresolvedTimezone))
        .transpose()?;
    if is_date {
        if timezone.is_some() {
            return Err(Error::MalformedCalendar);
        }
        let date =
            NaiveDate::parse_from_str(value, "%Y%m%d").map_err(|_| Error::MalformedCalendar)?;
        return Ok(StartTime::Date(date.format("%Y-%m-%d").to_string()));
    }
    if value.len() != 15 && value.len() != 16
        || !value.as_bytes().get(8).is_some_and(|b| *b == b'T')
        || value.len() == 16 && !value.ends_with('Z')
        || value.len() == 15 && value.ends_with('Z')
        || timezone.is_some() && value.ends_with('Z')
    {
        return Err(Error::MalformedCalendar);
    }
    let date_time = NaiveDateTime::parse_from_str(value.trim_end_matches('Z'), "%Y%m%dT%H%M%S")
        .map_err(|_| Error::MalformedCalendar)?;
    if let Some(zone) = timezone {
        let utc = match zone.from_local_datetime(&date_time) {
            chrono::LocalResult::Single(time) => Some(time.with_timezone(&Utc).naive_utc()),
            chrono::LocalResult::Ambiguous(_, _) | chrono::LocalResult::None => None,
        };
        Ok(StartTime::Timed {
            utc,
            zone: Some(zone.name().to_owned()),
        })
    } else if value.ends_with('Z') {
        Ok(StartTime::Timed {
            utc: Some(date_time),
            zone: Some("UTC".into()),
        })
    } else {
        Ok(StartTime::Timed {
            utc: None,
            zone: None,
        })
    }
}
