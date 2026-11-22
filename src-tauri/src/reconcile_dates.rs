//! Canvas timestamp parsing and New York date conversion.

use std::time::{SystemTime, UNIX_EPOCH};

use super::{invalid, ReconcileError};

/// Convert a Canvas RFC 3339 timestamp into the local wall clock used by the coursework file.
pub(super) fn utc_to_new_york(input: &str) -> Result<String, ReconcileError> {
    let timestamp = parse_rfc3339(input)?;
    let local = timestamp + i64::from(new_york_offset(timestamp));
    let days = local.div_euclid(86_400);
    let within_day = local.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = within_day / 3_600;
    let minute = (within_day % 3_600) / 60;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}"
    ))
}

pub(super) fn new_york_date(time: SystemTime) -> Result<String, ReconcileError> {
    let timestamp = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_secs()).unwrap_or(i64::MAX),
    };
    let local = timestamp + i64::from(new_york_offset(timestamp));
    let (year, month, day) = civil_from_days(local.div_euclid(86_400));
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

/// RFC 3339 parser returning epoch seconds; fractional seconds are intentionally discarded.
fn parse_rfc3339(input: &str) -> Result<i64, ReconcileError> {
    let (date, time_and_zone) = input
        .split_once('T')
        .ok_or_else(|| invalid("Canvas due_at is not RFC 3339"))?;
    let mut date_parts = date.split('-');
    let year = parse_component(date_parts.next())?;
    let month = parse_component(date_parts.next())?;
    let day = parse_component(date_parts.next())?;
    if date_parts.next().is_some()
        || !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
    {
        return Err(invalid("Canvas due_at has an invalid date"));
    }

    let zone_start = time_and_zone
        .char_indices()
        .find(|(_, character)| matches!(character, 'Z' | '+' | '-'))
        .map(|(index, _)| index)
        .ok_or_else(|| invalid("Canvas due_at has no timezone"))?;
    let (clock, zone) = time_and_zone.split_at(zone_start);
    let clock = clock.strip_suffix('.').unwrap_or(clock);
    let mut clock_parts = clock.split(':');
    let hour = parse_component(clock_parts.next())?;
    let minute = parse_component(clock_parts.next())?;
    let second_text = clock_parts
        .next()
        .ok_or_else(|| invalid("Canvas due_at has no seconds"))?;
    let second = second_text
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| invalid("Canvas due_at has invalid seconds"))?;
    if clock_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return Err(invalid("Canvas due_at has an invalid time"));
    }

    let offset = if zone == "Z" || zone == "z" {
        0_i64
    } else {
        let sign = match zone.as_bytes().first() {
            Some(b'+') => 1_i64,
            Some(b'-') => -1_i64,
            _ => return Err(invalid("Canvas due_at has an invalid timezone")),
        };
        let (hours, minutes) = zone[1..]
            .split_once(':')
            .ok_or_else(|| invalid("Canvas due_at has an invalid timezone offset"))?;
        let hours = hours
            .parse::<i64>()
            .map_err(|_| invalid("Canvas due_at has an invalid timezone offset"))?;
        let minutes = minutes
            .parse::<i64>()
            .map_err(|_| invalid("Canvas due_at has an invalid timezone offset"))?;
        if hours > 23 || minutes > 59 {
            return Err(invalid("Canvas due_at has an invalid timezone offset"));
        }
        sign * (hours * 3_600 + minutes * 60)
    };

    let local_seconds = days_from_civil(year, month, day) * 86_400
        + i64::from(hour) * 3_600
        + i64::from(minute) * 60
        + i64::from(second);
    Ok(local_seconds - offset)
}

fn parse_component(value: Option<&str>) -> Result<u32, ReconcileError> {
    value
        .and_then(|text| text.parse::<u32>().ok())
        .ok_or_else(|| invalid("Canvas due_at has an invalid date or time component"))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn is_leap_year(year: u32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn new_york_offset(timestamp: i64) -> i32 {
    let (year, _, _) = civil_from_days(timestamp.div_euclid(86_400));
    let year = year as u32;
    if year < 2007 {
        return -5 * 3_600;
    }
    let march_second_sunday = nth_sunday(year, 3, 2);
    let november_first_sunday = nth_sunday(year, 11, 1);
    let starts_at = days_from_civil(year, 3, march_second_sunday) * 86_400 + 7 * 3_600;
    let ends_at = days_from_civil(year, 11, november_first_sunday) * 86_400 + 6 * 3_600;
    if (starts_at..ends_at).contains(&timestamp) {
        -4 * 3_600
    } else {
        -5 * 3_600
    }
}

fn nth_sunday(year: u32, month: u32, occurrence: u32) -> u32 {
    let first_weekday = weekday(days_from_civil(year, month, 1));
    1 + (7 - first_weekday) % 7 + 7 * (occurrence - 1)
}

fn weekday(days_since_epoch: i64) -> u32 {
    (days_since_epoch + 4).rem_euclid(7) as u32
}

fn days_from_civil(year: u32, month: u32, day: u32) -> i64 {
    let year = i64::from(year) - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    let year = year + i64::from(month <= 2);
    (year, month, day)
}
