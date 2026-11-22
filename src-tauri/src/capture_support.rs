fn capture_profile(
    api: &CanvasApi,
    downloads: &DownloadClient,
    docs: &mut BTreeMap<String, Vec<u8>>,
    total: &mut usize,
    progress: &mut dyn FnMut(RefreshProgress),
    count: &mut u64,
) -> Result<(), CaptureError> {
    before_request(progress, *count, *total);
    let result = api.get_json("/api/v1/users/self/profile");
    *count += 1;
    after_request(progress, *count, *total);
    let response = result.map_err(|_| CaptureError::CanvasRequest)?;
    ensure_success(&response)?;
    let profile = response
        .body
        .as_object()
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    let name = profile
        .get("name")
        .and_then(Value::as_str)
        .map(|s| redact(&clean(s, 200)));
    let short_name = profile
        .get("short_name")
        .and_then(Value::as_str)
        .map(|s| redact(&clean(s, 120)));
    let avatar_url = profile
        .get("avatar_url")
        .or_else(|| profile.get("avatar"))
        .and_then(Value::as_str);

    let avatar = if let Some(url) = avatar_url.filter(|s| !s.is_empty()) {
        before_request(progress, *count, *total);
        let result = downloads.download_avatar(url);
        *count += 1;
        after_request(progress, *count, *total);
        let body = result.map_err(|_| CaptureError::Download)?;
        let content_type =
            image_type(body.content_type.as_deref()).ok_or(CaptureError::InvalidCanvasResponse)?;
        if body.status != 200
            || body.bytes.is_empty()
            || body.bytes.len() > MAX_AVATAR_BYTES
            || !image_signature(&body.bytes, content_type)
        {
            return Err(CaptureError::InvalidCanvasResponse);
        }
        let size = body.bytes.len();
        put_document(docs, "canvas-profile-avatar", body.bytes, total)?;
        json!({"path":"canvas-profile-avatar","contentType":content_type,"bytes":size})
    } else {
        Value::Null
    };
    put_json(
        docs,
        "canvas-profile.json",
        &json!({"name":name,"short_name":short_name,"avatar":avatar}),
        total,
    )?;
    Ok(())
}

fn image_type(value: Option<&str>) -> Option<&'static str> {
    match value?
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/jpeg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        _ => None,
    }
}

fn image_signature(bytes: &[u8], content_type: &str) -> bool {
    match content_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn before_request(progress: &mut dyn FnMut(RefreshProgress), count: u64, bytes: usize) {
    progress(RefreshProgress::new(
        RefreshPhase::Fetch,
        count,
        None,
        Some(bytes as u64),
    ));
}

fn get_pages_with_progress(
    api: &CanvasApi,
    path: &str,
    progress: &mut dyn FnMut(RefreshProgress),
    count: &mut u64,
    bytes: usize,
) -> Result<Vec<ApiResponse>, (crate::canvas::CanvasError, u64)> {
    let mut seen_pages = 0u64;
    let result = api.get_pages_with_progress(path, &mut |completed_pages| {
        if completed_pages == 0 {
            before_request(progress, *count, bytes);
        } else {
            while seen_pages < completed_pages {
                seen_pages += 1;
                *count += 1;
                after_request(progress, *count, bytes);
            }
        }
    });
    if seen_pages == 0 {
        *count += 1;
    }
    after_request(progress, *count, bytes);
    result.map_err(|error| (error, seen_pages))
}

fn after_request(progress: &mut dyn FnMut(RefreshProgress), count: u64, bytes: usize) {
    progress(RefreshProgress::new(
        RefreshPhase::Fetch,
        count,
        None,
        Some(bytes as u64),
    ));
}

fn put_json(
    docs: &mut BTreeMap<String, Vec<u8>>,
    path: &str,
    value: &Value,
    total: &mut usize,
) -> Result<(), CaptureError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| CaptureError::InvalidCanvasResponse)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_JSON_BYTES {
        return Err(CaptureError::ResponseLimit);
    }
    put_document(docs, path, bytes, total)
}

fn put_text(
    docs: &mut BTreeMap<String, Vec<u8>>,
    path: &str,
    value: &[u8],
    total: &mut usize,
) -> Result<(), CaptureError> {
    if value.len() > MAX_JSON_BYTES {
        return Err(CaptureError::ResponseLimit);
    }
    put_document(docs, path, value.to_vec(), total)
}

fn put_document(
    docs: &mut BTreeMap<String, Vec<u8>>,
    path: &str,
    bytes: Vec<u8>,
    total: &mut usize,
) -> Result<(), CaptureError> {
    if path.starts_with('/')
        || path.len() > 1024
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(CaptureError::InvalidScope);
    }
    let old = docs.get(path).map_or(0, Vec::len);
    let combined = total.saturating_sub(old).saturating_add(bytes.len());
    if combined > MAX_TOTAL_BYTES {
        return Err(CaptureError::OutputLimit);
    }
    *total = combined;
    docs.insert(path.to_owned(), bytes);
    Ok(())
}

fn timestamp(time: SystemTime) -> String {
    let elapsed = time.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    let seconds = elapsed.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date(days);
    let hour = day_seconds / 3600;
    let minute = day_seconds % 3600 / 60;
    let second = day_seconds % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        elapsed.subsec_millis()
    )
}

fn normalize_time(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.len() > 64 {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10).copied(), Some(b'T' | b't' | b' '))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year = value.get(0..4)?.parse::<i64>().ok()?;
    let month = value.get(5..7)?.parse::<i64>().ok()?;
    let day = value.get(8..10)?.parse::<i64>().ok()?;
    let hour = value.get(11..13)?.parse::<i64>().ok()?;
    let minute = value.get(14..16)?.parse::<i64>().ok()?;
    let second = value.get(17..19)?.parse::<i64>().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut index = 19;
    let mut millis = 0u32;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(|byte| byte.is_ascii_digit()) {
            index += 1;
        }
        let fraction = value.get(start..index)?;
        let mut digits: String = fraction.chars().take(3).collect();
        while digits.len() < 3 {
            digits.push('0');
        }
        millis = digits.parse().ok()?;
    }
    let offset = match bytes.get(index).copied() {
        Some(b'Z' | b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let direction = if sign == b'+' { 1 } else { -1 };
            let hours = value.get(index + 1..index + 3)?.parse::<i64>().ok()?;
            let mins = value.get(index + 4..index + 6)?.parse::<i64>().ok()?;
            direction * (hours * 3600 + mins * 60)
        }
        _ => return None,
    };
    let seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset;
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date(days);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    ))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * adjusted_month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_date(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}
