fn capture_inbox(
    api: &CanvasApi,
    previous: Option<&Value>,
    progress: &mut dyn FnMut(RefreshProgress),
    count: &mut u64,
    bytes_done: usize,
) -> Result<Value, CaptureError> {
    let pages = get_pages_with_progress(
        api,
        "/api/v1/conversations?scope=inbox&per_page=100",
        progress,
        count,
        bytes_done,
    )
    .map_err(|_| CaptureError::CanvasRequest)?;
    if pages.len() > MAX_INBOX_PAGES {
        return Err(CaptureError::ResponseLimit);
    }
    let mut summaries = Vec::new();
    for page in pages {
        ensure_success(&page)?;
        let rows = page
            .body
            .as_array()
            .ok_or(CaptureError::InvalidCanvasResponse)?;
        if summaries.len().saturating_add(rows.len()) > MAX_CONVERSATIONS {
            return Err(CaptureError::ResponseLimit);
        }
        summaries.extend(rows.iter().cloned());
    }

    capture_inbox_from_summaries(summaries, previous, |id| {
        before_request(progress, *count, bytes_done);
        let result = api.get_json(&format!(
            "/api/v1/conversations/{id}?auto_mark_as_read=false"
        ));
        *count += 1;
        after_request(progress, *count, bytes_done);
        let response = result.map_err(|_| CaptureError::CanvasRequest)?;
        ensure_success(&response)?;
        Ok(response.body)
    })
}

fn capture_inbox_from_summaries(
    summaries: Vec<Value>,
    previous: Option<&Value>,
    mut fetch_detail: impl FnMut(&str) -> Result<Value, CaptureError>,
) -> Result<Value, CaptureError> {
    let previous_items = previous
        .and_then(|v| v.get("conversations"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_stored_conversation)
                .take(MAX_CONVERSATIONS)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let prior_by_id: BTreeMap<String, &Value> = previous_items
        .iter()
        .filter_map(|item| string_conversation_id(item).map(|id| (id, item)))
        .collect();

    let mut current = Vec::new();
    let mut body_bytes = 0usize;
    let mut rejected = 0usize;
    let mut seen_ids = BTreeSet::new();
    for summary in summaries {
        let id = conversation_id(summary.get("id")).ok_or(CaptureError::InvalidCanvasResponse)?;
        if !seen_ids.insert(id.clone()) {
            return Err(CaptureError::InvalidCanvasResponse);
        }
        let detail = fetch_detail(&id)
            .ok()
            .and_then(|body| normalize_conversation(&body));
        let detail = detail.filter(|conversation| {
            let next_bytes = conversation_body_bytes(conversation);
            if body_bytes.saturating_add(next_bytes) > MAX_INBOX_BYTES {
                false
            } else {
                body_bytes += next_bytes;
                true
            }
        });
        let conversation = match detail {
            Some(conversation) => conversation,
            None => {
                rejected += 1;
                incomplete_conversation(&summary, prior_by_id.get(&id).copied())
                    .ok_or(CaptureError::InvalidCanvasResponse)?
            }
        };
        current.push(conversation);
    }
    if rejected > 0 {
        let current_ids: BTreeSet<String> =
            current.iter().filter_map(string_conversation_id).collect();
        for prior in &previous_items {
            let Some(id) = string_conversation_id(prior) else {
                continue;
            };
            if !current_ids.contains(&id) {
                let mut preserved = prior.clone();
                if let Some(fields) = preserved.as_object_mut() {
                    fields.insert("historyComplete".into(), Value::Bool(false));
                    fields.insert("detailCaptureIncomplete".into(), Value::Bool(true));
                }
                current.push(preserved);
            }
        }
    }
    current.sort_by(latest_first);

    let current_by_id: BTreeMap<String, &Value> = current
        .iter()
        .filter_map(|v| string_conversation_id(v).map(|id| (id, v)))
        .collect();
    let old_by_id: BTreeMap<String, &Value> = previous_items
        .iter()
        .filter_map(|v| string_conversation_id(v).map(|id| (id, v)))
        .collect();

    let mut added = Vec::new();
    let mut changed = Vec::new();
    for (id, value) in &current_by_id {
        match old_by_id.get(id) {
            None => added.push(Value::from(id.clone())),
            Some(old) if *old != *value => changed.push(Value::from(id.clone())),
            Some(_) => {}
        }
    }
    let removed: Vec<Value> = if rejected == 0 {
        old_by_id
            .keys()
            .filter(|id| !current_by_id.contains_key(*id))
            .map(|id| Value::from(id.clone()))
            .collect()
    } else {
        Vec::new()
    };

    Ok(json!({
        "schema": 1,
        "generatedAt": timestamp(SystemTime::now()),
        "complete": rejected == 0,
        "rejected": rejected,
        "conversations": current,
        "changes": { "added": added, "changed": changed, "removed": removed }
    }))
}

fn conversation_body_bytes(conversation: &Value) -> usize {
    conversation
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| message.get("body").and_then(Value::as_str))
        .map(str::len)
        .sum()
}

fn incomplete_conversation(summary: &Value, prior: Option<&Value>) -> Option<Value> {
    let id = conversation_id(summary.get("id"))?;
    let preserved = prior.cloned().unwrap_or(Value::Null);
    let subject = summary
        .get("subject")
        .and_then(Value::as_str)
        .map(|value| redact(&clean(value, 240)))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            preserved
                .get("subject")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "(No subject)".into());
    let context = summary
        .get("context_name")
        .and_then(Value::as_str)
        .map(|value| redact(&clean(value, 160)))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            preserved
                .get("contextLabel")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let state = summary
        .get("workflow_state")
        .and_then(Value::as_str)
        .filter(|state| matches!(*state, "read" | "unread" | "archived"));
    let unread = state
        .map(|state| state == "unread")
        .or_else(|| preserved.get("unread").and_then(Value::as_bool))
        .unwrap_or(false);
    let (preview, preview_truncated) = summary
        .get("last_message")
        .and_then(Value::as_str)
        .map(clean_message)
        .filter(|(value, _)| !value.is_empty())
        .or_else(|| {
            preserved
                .get("latestMessagePreview")
                .and_then(Value::as_str)
                .map(|value| (value.to_owned(), false))
        })
        .unwrap_or((String::new(), false));
    let latest_at = normalize_time(summary.get("last_message_at").and_then(Value::as_str));
    let participants = preserved
        .get("participants")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let messages = preserved
        .get("messages")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let attachments = preserved
        .get("attachments")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let reported_message_count = summary
        .get("message_count")
        .and_then(Value::as_u64)
        .or_else(|| preserved.get("messageCount").and_then(Value::as_u64))
        .unwrap_or(messages.as_array().map_or(0, |items| items.len() as u64));
    const MAX_REPORTED_MESSAGE_COUNT: u64 = 100_000;
    let message_count = reported_message_count.min(MAX_REPORTED_MESSAGE_COUNT);
    let safety_truncated = preview_truncated
        || reported_message_count > MAX_REPORTED_MESSAGE_COUNT
        || preserved.get("safetyTruncated").and_then(Value::as_bool) == Some(true);
    Some(json!({
        "canvasConversationId":id,
        "contextLabel":context,
        "subject":subject,
        "participants":participants,
        "latestMessagePreview":if preview.is_empty() { Value::Null } else { Value::from(preview.chars().take(280).collect::<String>()) },
        "latestMessageAt":latest_at.or_else(|| preserved.get("latestMessageAt").cloned().and_then(|value| value.as_str().map(str::to_owned))),
        "unread":unread,
        "starred":summary.get("starred").and_then(Value::as_bool).or_else(|| preserved.get("starred").and_then(Value::as_bool)).unwrap_or(false),
        "messageCount":message_count,
        "messages":messages,
        "historyComplete":false,
        "safetyTruncated":safety_truncated,
        "detailCaptureIncomplete":true,
        "attachments":attachments
    }))
}

fn latest_first(left: &Value, right: &Value) -> std::cmp::Ordering {
    right
        .get("latestMessageAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .cmp(
            left.get("latestMessageAt")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
}

fn string_conversation_id(value: &Value) -> Option<String> {
    value
        .get("canvasConversationId")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn conversation_id(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let text = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => return None,
    };
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(text)
}

fn normalize_stored_conversation(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut raw = Map::new();
    raw.insert("id".into(), object.get("canvasConversationId")?.clone());
    raw.insert(
        "context_name".into(),
        object.get("contextLabel").cloned().unwrap_or(Value::Null),
    );
    raw.insert(
        "subject".into(),
        object.get("subject").cloned().unwrap_or(Value::Null),
    );
    raw.insert(
        "last_message".into(),
        object
            .get("latestMessagePreview")
            .cloned()
            .unwrap_or(Value::Null),
    );
    raw.insert(
        "last_message_at".into(),
        object
            .get("latestMessageAt")
            .cloned()
            .unwrap_or(Value::Null),
    );
    raw.insert(
        "workflow_state".into(),
        Value::from(
            if object.get("unread").and_then(Value::as_bool) == Some(true) {
                "unread"
            } else {
                "read"
            },
        ),
    );
    raw.insert(
        "starred".into(),
        object.get("starred").cloned().unwrap_or(Value::Bool(false)),
    );
    raw.insert(
        "message_count".into(),
        object
            .get("messageCount")
            .cloned()
            .unwrap_or(Value::from(0)),
    );
    let participants = object
        .get("participants")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(json!({
                        "id": item.get("canvasUserId")?, "name": item.get("name")?
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    raw.insert("participants".into(), Value::Array(participants));
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().map(|item| json!({
            "id": item.get("canvasMessageId").cloned().unwrap_or(Value::Null),
            "author_id": item.get("authorId").cloned().unwrap_or(Value::Null),
            "author_name": item.get("author").cloned().unwrap_or(Value::Null),
            "created_at": item.get("createdAt").cloned().unwrap_or(Value::Null),
            "body": item.get("body").cloned().unwrap_or(Value::Null),
            "attachments": item.get("attachments").and_then(Value::as_array).map(|entries| {
                entries.iter().map(|entry| json!({
                    "display_name": entry.get("name").cloned().unwrap_or(Value::Null),
                    "content-type": entry.get("contentType").cloned().unwrap_or(Value::Null),
                    "size": entry.get("sizeBytes").cloned().unwrap_or(Value::Null)
                })).collect::<Vec<_>>()
            }).unwrap_or_default()
        })).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    raw.insert("messages".into(), Value::Array(messages));
    let mut normalized = normalize_conversation_inner(&Value::Object(raw), false)?;
    let was_incomplete = object.get("historyComplete").and_then(Value::as_bool) == Some(false)
        || object
            .get("detailCaptureIncomplete")
            .and_then(Value::as_bool)
            == Some(true);
    if was_incomplete {
        let fields = normalized.as_object_mut()?;
        fields.insert("historyComplete".into(), Value::Bool(false));
        fields.insert("detailCaptureIncomplete".into(), Value::Bool(true));
        if object.get("safetyTruncated").and_then(Value::as_bool) == Some(true) {
            fields.insert("safetyTruncated".into(), Value::Bool(true));
        }
    }
    Some(normalized)
}

fn normalize_conversation(value: &Value) -> Option<Value> {
    normalize_conversation_inner(value, true)
}

fn normalize_conversation_inner(value: &Value, require_complete: bool) -> Option<Value> {
    let object = value.as_object()?;
    let id = conversation_id(object.get("id"))?;
    let subject = object
        .get("subject")
        .and_then(Value::as_str)
        .map(|s| clean(s, 240))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(No subject)".into());
    let context = object
        .get("context_name")
        .and_then(Value::as_str)
        .map(|s| clean(s, 160))
        .filter(|s| !s.is_empty());
    let state = object
        .get("workflow_state")
        .and_then(Value::as_str)
        .unwrap_or("read");
    if !matches!(state, "read" | "unread" | "archived") {
        return None;
    }
    let starred = object
        .get("starred")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let raw_messages = object.get("messages").and_then(Value::as_array);
    let message_count = object
        .get("message_count")
        .and_then(Value::as_u64)
        .or_else(|| raw_messages.map(|items| items.len() as u64))
        .unwrap_or(0);
    if message_count > 100_000 {
        return None;
    }

    let raw_participants = object.get("participants").and_then(Value::as_array);
    if raw_participants.is_some_and(|items| items.len() > 100) {
        return None;
    }
    let mut participants = Vec::new();
    let mut seen = BTreeSet::new();
    for raw in raw_participants.into_iter().flatten() {
        let participant = raw.as_object()?;
        let id = text_id(
            participant
                .get("id")
                .or_else(|| participant.get("canvasUserId")),
            128,
        )?;
        let name = participant
            .get("name")
            .or_else(|| participant.get("display_name"))
            .and_then(Value::as_str)
            .map(|s| clean(s, 120))?;
        if name.is_empty() {
            return None;
        }
        if seen.insert(id.clone()) {
            participants.push(json!({"canvasUserId":id,"name":name}));
        }
    }

    let mut messages = Vec::new();
    let mut all_attachments = Vec::new();
    let too_many_messages = raw_messages.is_some_and(|items| items.len() > MAX_MESSAGES);
    let mut safety_truncated = too_many_messages;
    for raw in raw_messages.into_iter().flatten().take(MAX_MESSAGES) {
        let message = raw.as_object()?;
        let input_body = message
            .get("body")
            .or_else(|| message.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let (body, body_truncated) = clean_message(input_body);
        safety_truncated |= body_truncated;
        let raw_attachments = message.get("attachments").and_then(Value::as_array);
        if raw_attachments.is_some_and(|items| items.len() > MAX_ATTACHMENTS) {
            return None;
        }
        let mut attachments = Vec::new();
        for raw_attachment in raw_attachments.into_iter().flatten() {
            let attachment = raw_attachment.as_object()?;
            let name = attachment
                .get("display_name")
                .or_else(|| attachment.get("filename"))
                .or_else(|| attachment.get("name"))
                .and_then(Value::as_str)
                .map(|s| clean(s, 240))?;
            if name.is_empty() {
                return None;
            }
            let content_type = attachment
                .get("content-type")
                .or_else(|| attachment.get("content_type"))
                .and_then(Value::as_str)
                .map(|s| clean(s, 120));
            let size = attachment.get("size").and_then(Value::as_u64);
            let projected = json!({"name":name,"contentType":content_type,"sizeBytes":size});
            attachments.push(projected.clone());
            all_attachments.push(projected);
        }
        let author = message
            .get("author_name")
            .or_else(|| message.get("sender_name"))
            .or_else(|| message.get("author").and_then(|v| v.get("name")))
            .and_then(Value::as_str)
            .map(|s| clean(s, 120))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Canvas participant".into());
        let author_id = text_id(
            message
                .get("author_id")
                .or_else(|| message.get("sender_id"))
                .or_else(|| message.get("author").and_then(|v| v.get("id"))),
            128,
        );
        let created_at = normalize_time(
            message
                .get("created_at")
                .or_else(|| message.get("createdAt"))
                .and_then(Value::as_str),
        );
        let message_id = text_id(
            message.get("id").or_else(|| message.get("canvasMessageId")),
            128,
        );
        messages.push(json!({
            "canvasMessageId":message_id,"authorId":author_id,"author":author,
            "createdAt":created_at,"body":body,"bodyTruncated":body_truncated,
            "attachments":attachments
        }));
    }
    let body_total: usize = messages
        .iter()
        .filter_map(|v| v.get("body").and_then(Value::as_str))
        .map(str::len)
        .sum();
    if body_total > MAX_INBOX_BYTES {
        return None;
    }

    let latest_at = messages
        .iter()
        .filter_map(|v| v.get("createdAt").and_then(Value::as_str))
        .max()
        .map(str::to_owned)
        .or_else(|| {
            normalize_time(
                object
                    .get("last_message_at")
                    .or_else(|| object.get("latestMessageAt"))
                    .and_then(Value::as_str),
            )
        });
    let preview = object
        .get("last_message")
        .or_else(|| object.get("lastMessage"))
        .and_then(Value::as_str)
        .map(|s| clean_message(s).0)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            messages.iter().find_map(|v| {
                v.get("body")
                    .and_then(Value::as_str)
                    .map(|s| s.chars().take(280).collect())
            })
        });
    if messages.is_empty() {
        if let Some(preview) = &preview {
            messages.push(json!({
                "canvasMessageId":Value::Null,"authorId":Value::Null,"author":"Canvas participant",
                "createdAt":latest_at,"body":preview,"bodyTruncated":false,"attachments":[]
            }));
        }
    }
    let history_complete = raw_messages.is_some()
        && !too_many_messages
        && !safety_truncated
        && message_count <= messages.len() as u64;
    if require_complete && !history_complete {
        return None;
    }
    Some(json!({
        "canvasConversationId":id,"contextLabel":context,"subject":subject,
        "participants":participants,
        "latestMessagePreview":preview.map(|s|s.chars().take(280).collect::<String>()),
        "latestMessageAt":latest_at,"unread":state=="unread","starred":starred,
        "messageCount":message_count,"messages":messages,"historyComplete":history_complete,
        "safetyTruncated":safety_truncated,"attachments":all_attachments
    }))
}

fn text_id(value: Option<&Value>, max: usize) -> Option<String> {
    let text = match value? {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() || text.len() > max {
        None
    } else {
        Some(text.into())
    }
}

fn clean_message(input: &str) -> (String, bool) {
    let stripped = strip_active(input);
    let stripped = strip_tags(&stripped);
    let decoded = stripped
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    let normalized = whitespace(&redact(&decoded));
    if normalized.len() <= MAX_MESSAGE_BYTES {
        return (normalized, false);
    }
    let mut end = MAX_MESSAGE_BYTES - 3;
    while !normalized.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &normalized[..end]), true)
}

fn strip_active(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    while cursor < input.len() {
        let script = lower[cursor..].find("<script");
        let style = lower[cursor..].find("<style");
        let next = match (script, style) {
            (Some(a), Some(b)) => Some((a.min(b), if a <= b { "script" } else { "style" })),
            (Some(a), None) => Some((a, "script")),
            (None, Some(b)) => Some((b, "style")),
            _ => None,
        };
        let Some((offset, tag)) = next else {
            out.push_str(&input[cursor..]);
            break;
        };
        let start = cursor + offset;
        out.push_str(&input[cursor..start]);
        let end_tag = format!("</{tag}");
        let Some(close) = lower[start..].find(&end_tag) else {
            break;
        };
        let Some(end) = lower[start + close..]
            .find('>')
            .map(|n| start + close + n + 1)
        else {
            break;
        };
        cursor = end;
    }
    out
}

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut inside = false;
    for ch in input.chars() {
        match ch {
            '<' => inside = true,
            '>' if inside => inside = false,
            _ if !inside => out.push(ch),
            _ => {}
        }
    }
    out
}

fn whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut space = false;
    let mut newlines = 0;
    for ch in input.chars() {
        if ch == '\r' || ch == '\n' {
            if !out.is_empty() && newlines < 2 {
                out.push('\n');
            }
            newlines += 1;
            space = false;
        } else if ch.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
            newlines = 0;
        } else if !ch.is_control() {
            out.push(ch);
            space = false;
            newlines = 0;
        }
    }
    out.trim().into()
}

fn clean(input: &str, max: usize) -> String {
    input
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}
