const MAX_LINKED_FILE_DETAILS: usize = 500;
const MAX_REFERENCE_SCAN_VALUES: usize = 100_000;
const MAX_REFERENCE_SCAN_DEPTH: usize = 32;
const HTML_FIELDS: [&str; 7] = [
    "body",
    "content",
    "description",
    "discussion",
    "message",
    "syllabus_body",
    "html",
];
const URL_FIELDS: [&str; 4] = ["html_url", "url", "href", "safeTarget"];

fn collect_linked_file_ids(
    value: &Value,
    course_id: u64,
    origin: &str,
) -> Result<BTreeSet<u64>, CaptureError> {
    let mut ids = BTreeSet::new();
    let mut visited = 0;
    scan_file_references(value, "", course_id, origin, 0, &mut visited, &mut ids)?;
    Ok(ids)
}

fn scan_file_references(
    value: &Value,
    field: &str,
    course_id: u64,
    origin: &str,
    depth: usize,
    visited: &mut usize,
    ids: &mut BTreeSet<u64>,
) -> Result<(), CaptureError> {
    *visited += 1;
    if *visited > MAX_REFERENCE_SCAN_VALUES || depth > MAX_REFERENCE_SCAN_DEPTH {
        return Err(CaptureError::ResponseLimit);
    }
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if matches!(key.as_str(), "attachments" | "attachment") {
                    collect_attachment_ids(child, ids);
                }
                scan_file_references(child, key, course_id, origin, depth + 1, visited, ids)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                scan_file_references(child, field, course_id, origin, depth + 1, visited, ids)?;
            }
        }
        Value::String(text) if URL_FIELDS.contains(&field) => {
            if let Some(id) = canvas_file_id(text, course_id, origin) {
                ids.insert(id);
            }
        }
        Value::String(text) if HTML_FIELDS.contains(&field) => {
            collect_html_href_file_ids(text, course_id, origin, ids);
        }
        _ => {}
    }
    Ok(())
}

fn collect_attachment_ids(value: &Value, ids: &mut BTreeSet<u64>) {
    let attachments = value
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_else(|| std::slice::from_ref(value));
    for attachment in attachments {
        let Some(attachment) = attachment.as_object() else {
            continue;
        };
        if let Some(id) = id_of(attachment.get("id").or_else(|| attachment.get("file_id"))) {
            ids.insert(id);
        }
    }
}

fn collect_html_href_file_ids(html: &str, course_id: u64, origin: &str, ids: &mut BTreeSet<u64>) {
    let lowercase = html.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(found) = lowercase[offset..].find("href") {
        let start = offset + found;
        let end = start + 4;
        let before_ok = start == 0
            || lowercase[..start]
                .chars()
                .next_back()
                .is_some_and(|character| character.is_whitespace() || character == '<');
        let Some((target, next_offset)) = read_href_value(html, &lowercase, end) else {
            offset = end;
            continue;
        };
        offset = next_offset.max(end);
        if !before_ok {
            continue;
        }
        if let Some(id) = canvas_file_id(target, course_id, origin) {
            ids.insert(id);
        }
    }
}

fn read_href_value<'a>(
    html: &'a str,
    lowercase: &str,
    mut cursor: usize,
) -> Option<(&'a str, usize)> {
    let bytes = lowercase.as_bytes();
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'=') {
        return None;
    }
    cursor += 1;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    let quote = *bytes.get(cursor)?;
    if !matches!(quote, b'\'' | b'"') {
        return None;
    }
    let value_start = cursor + 1;
    let value_end = lowercase[value_start..].find(quote as char)? + value_start;
    Some((&html[value_start..value_end], value_end + 1))
}

fn canvas_file_id(candidate: &str, course_id: u64, origin: &str) -> Option<u64> {
    let origin = reqwest::Url::parse(origin).ok()?;
    let target = reqwest::Url::parse(candidate)
        .or_else(|_| origin.join(candidate))
        .ok()?;
    if target.origin() != origin.origin()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
    {
        return None;
    }
    let segments = target
        .path_segments()?
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let segments = if segments.starts_with(&["api", "v1"]) {
        &segments[2..]
    } else {
        segments.as_slice()
    };
    let (linked_course_id, file_id, suffix) = match segments {
        ["courses", linked_course_id, "files", file_id, suffix @ ..] => (
            Some(linked_course_id.parse::<u64>().ok()?),
            *file_id,
            suffix,
        ),
        ["files", file_id, suffix @ ..] => (None, *file_id, suffix),
        _ => return None,
    };
    if linked_course_id.is_some_and(|linked| linked != course_id) {
        return None;
    }
    let file_id = file_id.parse::<u64>().ok()?;
    if file_id == 0 {
        return None;
    }
    match suffix {
        [] => Some(file_id),
        ["download" | "preview"] => Some(file_id),
        _ => None,
    }
}

fn capture_discussion_file_references(
    api: &CanvasApi,
    course_id: u64,
    origin: &str,
    topics: &[Value],
    linked_file_ids: &mut BTreeSet<u64>,
    requests: &mut Map<String, Value>,
    omissions: &mut Vec<Value>,
    progress: &mut dyn FnMut(RefreshProgress),
    request_count: &mut u64,
    bytes: usize,
    source_complete: &mut bool,
) -> Result<(), CaptureError> {
    let mut detail_request_count = 0usize;
    let mut detail_item_count = 0usize;
    'topics: for topic in topics {
        let topic_id = id_of(topic.get("id")).ok_or(CaptureError::InvalidCanvasResponse)?;
        let entry_endpoint = format!("discussionEntries/{topic_id}");
        let Some(entries) = read_discussion_rows(
            api,
            course_id,
            topic_id,
            None,
            &entry_endpoint,
            requests,
            omissions,
            progress,
            request_count,
            bytes,
            &mut detail_request_count,
            &mut detail_item_count,
            source_complete,
        )?
        else {
            if detail_request_count > 1_000 {
                break 'topics;
            }
            continue;
        };
        for entry in entries {
            linked_file_ids.extend(collect_linked_file_ids(&entry, course_id, origin)?);
            let entry_id = id_of(entry.get("id")).ok_or(CaptureError::InvalidCanvasResponse)?;
            let reply_endpoint = format!("discussionReplies/{topic_id}/{entry_id}");
            let Some(replies) = read_discussion_rows(
                api,
                course_id,
                topic_id,
                Some(entry_id),
                &reply_endpoint,
                requests,
                omissions,
                progress,
                request_count,
                bytes,
                &mut detail_request_count,
                &mut detail_item_count,
                source_complete,
            )?
            else {
                if detail_request_count > 1_000 {
                    break 'topics;
                }
                continue;
            };
            for reply in &replies {
                if id_of(reply.get("id")).is_none() {
                    return Err(CaptureError::InvalidCanvasResponse);
                }
                linked_file_ids.extend(collect_linked_file_ids(reply, course_id, origin)?);
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn read_discussion_rows(
    api: &CanvasApi,
    course_id: u64,
    topic_id: u64,
    entry_id: Option<u64>,
    endpoint: &str,
    requests: &mut Map<String, Value>,
    omissions: &mut Vec<Value>,
    progress: &mut dyn FnMut(RefreshProgress),
    request_count: &mut u64,
    bytes: usize,
    detail_request_count: &mut usize,
    detail_item_count: &mut usize,
    source_complete: &mut bool,
) -> Result<Option<Vec<Value>>, CaptureError> {
    *detail_request_count += 1;
    if *detail_request_count > 1_000 {
        *source_complete = false;
        omissions.push(json!({
            "endpoint": endpoint,
            "courseId": course_id,
            "topicId": topic_id,
            "entryId": entry_id,
            "reason": "detail-budget"
        }));
        return Ok(None);
    }
    let path = match entry_id {
        Some(entry_id) => format!(
            "/api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries/{entry_id}/replies?per_page=100"
        ),
        None => format!(
            "/api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries?per_page=100"
        ),
    };
    let pages = match get_pages_with_progress(api, &path, progress, request_count, bytes) {
        Ok(pages) => pages,
        Err((CanvasError::HttpStatus(status @ (401 | 403 | 404)), 0)) => {
            omissions.push(json!({
                "endpoint": endpoint,
                "courseId": course_id,
                "topicId": topic_id,
                "entryId": entry_id,
                "reason": match status {
                    401 => "locked",
                    403 => "forbidden-optional",
                    _ => "not-found"
                }
            }));
            return Ok(None);
        }
        Err((error, completed_pages)) => {
            *source_complete = false;
            omissions.push(json!({
                "endpoint": endpoint,
                "courseId": course_id,
                "topicId": topic_id,
                "entryId": entry_id,
                "reason": if completed_pages > 0 || matches!(error,
                    CanvasError::PageLimitExceeded | CanvasError::ItemLimitExceeded | CanvasError::ResponseTooLarge
                ) { "detail-budget" } else { "request-failed" }
            }));
            return Ok(None);
        }
    };
    if pages.len() > MAX_PAGES {
        return Err(CaptureError::ResponseLimit);
    }
    let mut rows = Vec::new();
    let mut records = Vec::with_capacity(pages.len());
    for page in &pages {
        ensure_success(page)?;
        records.push(request_record(page)?);
        let items = page
            .body
            .as_array()
            .ok_or(CaptureError::InvalidCanvasResponse)?;
        *detail_item_count = detail_item_count
            .checked_add(items.len())
            .ok_or(CaptureError::ResponseLimit)?;
        if *detail_item_count > MAX_ITEMS {
            return Err(CaptureError::ResponseLimit);
        }
        rows.extend(items.iter().cloned());
    }
    requests.insert(endpoint.to_owned(), Value::Array(records));
    Ok(Some(rows))
}

fn append_linked_file_metadata(
    api: &CanvasApi,
    course_id: u64,
    linked_file_ids: &BTreeSet<u64>,
    raw_files: &mut Vec<Value>,
    file_records: &mut Vec<Value>,
    requests: &mut Map<String, Value>,
    omissions: &mut Vec<Value>,
    progress: &mut dyn FnMut(RefreshProgress),
    request_count: &mut u64,
    bytes: usize,
) -> Result<bool, CaptureError> {
    let listed_ids = raw_files
        .iter()
        .filter_map(|file| id_of(file.get("id")))
        .collect::<BTreeSet<_>>();
    let (extra_ids, over_budget_ids) = linked_file_detail_plan(linked_file_ids, &listed_ids);
    let mut source_complete = over_budget_ids.is_empty();
    for file_id in over_budget_ids {
        omissions.push(json!({
            "endpoint":"file",
            "courseId":course_id,
            "fileId":file_id,
            "reason":"detail-budget"
        }));
    }
    for file_id in extra_ids {
        before_request(progress, *request_count, bytes);
        let response = api.get_json(&format!("/api/v1/files/{file_id}"));
        *request_count += 1;
        after_request(progress, *request_count, bytes);
        let response = match response {
            Ok(response) => response,
            Err(CanvasError::HttpStatus(status @ (401 | 403 | 404))) => {
                omissions.push(json!({
                    "endpoint": "file",
                    "courseId": course_id,
                    "fileId": file_id,
                    "reason": match status {
                        401 => "locked",
                        403 => "forbidden-optional",
                        _ => "not-found"
                    }
                }));
                continue;
            }
            Err(error) => {
                source_complete = false;
                omissions.push(json!({
                    "endpoint":"file",
                    "courseId":course_id,
                    "fileId":file_id,
                    "reason": if matches!(error,
                        CanvasError::PageLimitExceeded | CanvasError::ItemLimitExceeded | CanvasError::ResponseTooLarge
                    ) { "detail-budget" } else { "request-failed" }
                }));
                continue;
            }
        };
        ensure_success(&response)?;
        if id_of(response.body.get("id")) != Some(file_id) {
            return Err(CaptureError::InvalidCanvasResponse);
        }
        if response.body.get("locked").and_then(Value::as_bool) == Some(true)
            || response
                .body
                .get("locked_for_user")
                .and_then(Value::as_bool)
                == Some(true)
        {
            omissions.push(json!({
                "endpoint":"file",
                "courseId":course_id,
                "fileId":file_id,
                "reason":"locked"
            }));
            continue;
        }
        if !raw_file_download_url(&response.body).is_some_and(|url| !url.is_empty()) {
            return Err(CaptureError::InvalidCanvasResponse);
        }
        requests.insert(
            format!("file/{file_id}"),
            Value::Array(vec![request_record(&response)?]),
        );
        file_records.push(project_endpoint("files", &response.body)?);
        raw_files.push(response.body);
    }
    Ok(source_complete)
}

fn linked_file_detail_plan(
    linked_file_ids: &BTreeSet<u64>,
    listed_file_ids: &BTreeSet<u64>,
) -> (Vec<u64>, Vec<u64>) {
    let mut reads = Vec::new();
    let mut over_budget = Vec::new();
    for id in linked_file_ids.difference(listed_file_ids) {
        if reads.len() < MAX_LINKED_FILE_DETAILS {
            reads.push(*id);
        } else {
            over_budget.push(*id);
        }
    }
    (reads, over_budget)
}
