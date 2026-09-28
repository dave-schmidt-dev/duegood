//! Bounded conversion of Canvas conversation list and detail resources.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{json, Value};

use super::{
    conversation_id, project_links, resource_items, safe_text_identifier, workflow_state,
    BrowserAccountProjectionError, BrowserAccountProjectionError as Error, CoverageIndex,
    ProjectionResult, ResourceIndex, LIST_ENDPOINTS,
};

const MAX_TEXT_CHARACTERS: usize = 64 * 1024;
const MAX_CONVERSATIONS: usize = 500;
const MAX_PARTICIPANTS: usize = 100;
const MAX_MESSAGES: usize = 2_000;
const MAX_ATTACHMENTS_PER_MESSAGE: usize = 25;
const MAX_ATTACHMENTS_TOTAL: usize = 10_000;
const MAX_MESSAGE_CHARACTERS: usize = 64 * 1024;

pub(super) fn project_inbox(
    resources: &ResourceIndex<'_>,
    coverage: &CoverageIndex,
    captured_at: &Option<String>,
) -> ProjectionResult<Value> {
    let mut summaries = BTreeMap::new();
    for endpoint in LIST_ENDPOINTS {
        let mut seen_in_list = HashSet::new();
        for item in resource_items(resources.endpoints[endpoint])? {
            let id = conversation_id(item.get("id")).ok_or(Error::InvalidResource)?;
            if !seen_in_list.insert(id.clone()) {
                return Err(Error::DuplicateResource);
            }
            workflow_state(item.get("workflow_state")).ok_or(Error::InvalidResource)?;
            summaries.entry(id).or_insert_with(|| item.clone());
        }
    }
    if summaries.len() > MAX_CONVERSATIONS {
        return Err(Error::LimitExceeded);
    }

    let mut details = HashMap::new();
    for resource in &resources.conversation_details {
        let items = resource_items(resource)?;
        if items.len() != 1 {
            return Err(Error::InvalidResource);
        }
        let id = conversation_id(items[0].get("id")).ok_or(Error::InvalidResource)?;
        if !summaries.contains_key(&id) {
            return Err(Error::IdentityMismatch);
        }
        if details.insert(id, &items[0]).is_some() {
            return Err(Error::DuplicateResource);
        }
    }

    let mut complete = details.len() == summaries.len()
        && coverage.conversation_complete == details.len()
        && coverage.conversation_gaps == 0;
    let mut rejected = summaries
        .len()
        .saturating_sub(details.len())
        .max(coverage.conversation_gaps);
    if coverage.conversation_complete != details.len() {
        rejected = rejected.max(coverage.conversation_complete.abs_diff(details.len()));
    }

    let mut conversations = Vec::with_capacity(summaries.len());
    let mut aggregate_attachments = 0usize;
    for (id, summary) in &summaries {
        let value = if let Some(detail) = details.get(id) {
            let projected = project_conversation(id, summary, detail, &mut aggregate_attachments)?;
            if projected.get("historyComplete").and_then(Value::as_bool) != Some(true) {
                complete = false;
            }
            projected
        } else {
            complete = false;
            project_incomplete_summary(id, summary)?
        };
        conversations.push(value);
    }

    Ok(json!({
        "schema":1,"generatedAt":captured_at,"complete":complete,"rejected":rejected,
        "conversations":conversations,"changes":{"added":[],"changed":[],"removed":[]}
    }))
}

fn project_incomplete_summary(id: &str, summary: &Value) -> ProjectionResult<Value> {
    let state = workflow_state(summary.get("workflow_state")).ok_or(Error::InvalidResource)?;
    let subject = clean_optional(summary.get("subject"), 240)?
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "(No subject)".into());
    let preview =
        clean_optional(summary.get("last_message"), 280)?.filter(|value| !value.is_empty());
    let at = clean_optional(summary.get("last_message_at"), 80)?;
    let message_count = summary
        .get("message_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(100_000);
    let messages = preview
        .as_ref()
        .map(|body| {
            vec![json!({
                "canvasMessageId":null,"authorId":null,"author":"Canvas participant","createdAt":at,
                "body":body,"bodyTruncated":false,"attachments":[]
            })]
        })
        .unwrap_or_default();
    let mut value = json!({
        "canvasConversationId":id,"contextLabel":clean_optional(summary.get("context_name"),160)?,
        "subject":subject,"participants":[],"latestMessagePreview":preview,"latestMessageAt":at,
        "unread":state=="unread","starred":summary.get("starred").and_then(Value::as_bool).unwrap_or(false),
        "messageCount":message_count,"messages":messages,"historyComplete":false,
        "safetyTruncated":false,"detailCaptureIncomplete":true,"attachments":[],
        "links":project_links(summary)?
    });
    value
        .as_object_mut()
        .expect("conversation object")
        .insert("workflowState".into(), Value::from(state));
    Ok(value)
}

fn project_conversation(
    id: &str,
    summary: &Value,
    detail: &Value,
    aggregate_attachments: &mut usize,
) -> ProjectionResult<Value> {
    if conversation_id(detail.get("id")).as_deref() != Some(id) {
        return Err(Error::IdentityMismatch);
    }
    let state = workflow_state(summary.get("workflow_state")).ok_or(Error::InvalidResource)?;
    let subject = clean_first(detail, &["subject"], 240)?
        .filter(|text| !text.is_empty())
        .or(clean_optional(summary.get("subject"), 240)?)
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "(No subject)".into());
    let context = clean_first(detail, &["context_name"], 160)?
        .or(clean_optional(summary.get("context_name"), 160)?);
    let participants = project_participants(detail.get("participants"))?;
    let raw_messages = detail.get("messages").and_then(Value::as_array);
    let messages_present = raw_messages.is_some();
    let mut safety_truncated = detail.get("_canvasTextTruncated").and_then(Value::as_bool)
        == Some(true)
        || raw_messages.is_some_and(|messages| messages.len() > MAX_MESSAGES);
    let mut messages = Vec::new();
    let mut attachments = Vec::new();
    for message in raw_messages.into_iter().flatten().take(MAX_MESSAGES) {
        messages.push(project_message(
            message,
            &mut attachments,
            aggregate_attachments,
            &mut safety_truncated,
        )?);
    }
    let message_count = detail
        .get("message_count")
        .and_then(Value::as_u64)
        .or_else(|| raw_messages.map(|items| items.len() as u64))
        .unwrap_or(0)
        .min(100_000);
    let history_complete =
        messages_present && !safety_truncated && message_count <= messages.len() as u64;
    let latest_at = messages
        .iter()
        .filter_map(|message| message.get("createdAt").and_then(Value::as_str))
        .max()
        .map(str::to_owned)
        .or(clean_first(detail, &["last_message_at"], 80)?)
        .or(clean_optional(summary.get("last_message_at"), 80)?);
    let preview = clean_first(summary, &["last_message"], 280)?
        .or(clean_first(detail, &["last_message"], 280)?)
        .or_else(|| {
            messages.iter().find_map(|message| {
                message
                    .get("body")
                    .and_then(Value::as_str)
                    .map(|s| s.chars().take(280).collect())
            })
        });
    let links = merged_links(summary, detail)?;
    let links_truncated = summary
        .get("_canvasLinksTruncated")
        .and_then(Value::as_bool)
        == Some(true)
        || detail.get("_canvasLinksTruncated").and_then(Value::as_bool) == Some(true);
    let mut value = json!({
        "canvasConversationId":id,"contextLabel":context,"subject":subject,"participants":participants,
        "latestMessagePreview":preview,"latestMessageAt":latest_at,"unread":state=="unread",
        "starred":detail.get("starred").and_then(Value::as_bool)
            .or_else(|| summary.get("starred").and_then(Value::as_bool)).unwrap_or(false),
        "messageCount":message_count,"messages":messages,"historyComplete":history_complete,
        "safetyTruncated":safety_truncated,"attachments":attachments,"links":links
    });
    let object = value.as_object_mut().expect("conversation object");
    object.insert("workflowState".into(), Value::from(state));
    if links_truncated {
        object.insert("linksTruncated".into(), Value::Bool(true));
    }
    Ok(value)
}

fn merged_links(summary: &Value, detail: &Value) -> ProjectionResult<Vec<Value>> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for link in project_links(summary)?
        .into_iter()
        .chain(project_links(detail)?)
    {
        let key = serde_json::to_string(&link).map_err(|_| Error::InvalidResource)?;
        if seen.insert(key) {
            if result.len() >= 2 * 500 {
                return Err(Error::LimitExceeded);
            }
            result.push(link);
        }
    }
    Ok(result)
}

fn project_participants(value: Option<&Value>) -> ProjectionResult<Vec<Value>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or(Error::InvalidResource)?;
    if values.len() > MAX_PARTICIPANTS {
        return Err(Error::LimitExceeded);
    }
    values
        .iter()
        .map(|participant| {
            let object = participant.as_object().ok_or(Error::InvalidResource)?;
            let id =
                safe_text_identifier(object.get("id").or_else(|| object.get("canvasUserId")), 128)
                    .ok_or(Error::InvalidResource)?;
            let name = clean_first(participant, &["name", "display_name"], 120)?
                .filter(|value| !value.is_empty())
                .ok_or(Error::InvalidResource)?;
            Ok(json!({"canvasUserId":id,"name":name}))
        })
        .collect()
}

fn project_message(
    value: &Value,
    conversation_attachments: &mut Vec<Value>,
    aggregate_attachments: &mut usize,
    safety_truncated: &mut bool,
) -> ProjectionResult<Value> {
    let object = value.as_object().ok_or(Error::InvalidResource)?;
    let author = clean_first(value, &["author_name", "sender_name"], 120)?
        .or(clean_optional(
            object.get("author").and_then(|author| author.get("name")),
            120,
        )?)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Canvas participant".into());
    let body_value = object.get("body").or_else(|| object.get("message"));
    let original_body = body_value.and_then(Value::as_str).unwrap_or("");
    let truncated = original_body.chars().count() > MAX_MESSAGE_CHARACTERS;
    *safety_truncated |= truncated;
    let body = clean_text(original_body, MAX_MESSAGE_CHARACTERS)?;
    let attachments = project_attachments(
        object.get("attachments"),
        conversation_attachments,
        aggregate_attachments,
    )?;
    let created_at = clean_optional(
        object.get("created_at").or_else(|| object.get("createdAt")),
        80,
    )?;
    let message_id = safe_text_identifier(
        object.get("id").or_else(|| object.get("canvasMessageId")),
        128,
    );
    let author_id = safe_text_identifier(
        object.get("author_id").or_else(|| object.get("sender_id")),
        128,
    )
    .or_else(|| {
        object
            .get("author")
            .and_then(|author| author.get("id"))
            .and_then(|id| safe_text_identifier(Some(id), 128))
    });
    Ok(json!({
        "canvasMessageId":message_id,"authorId":author_id,"author":author,"createdAt":created_at,
        "body":body,"bodyTruncated":truncated,"attachments":attachments
    }))
}

fn project_attachments(
    value: Option<&Value>,
    conversation_attachments: &mut Vec<Value>,
    aggregate_attachments: &mut usize,
) -> ProjectionResult<Vec<Value>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or(Error::InvalidResource)?;
    if values.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(Error::LimitExceeded);
    }
    let mut output = Vec::new();
    for attachment in values {
        *aggregate_attachments += 1;
        if *aggregate_attachments > MAX_ATTACHMENTS_TOTAL {
            return Err(Error::LimitExceeded);
        }
        let name = clean_first(attachment, &["display_name", "filename", "name"], 240)?
            .filter(|value| !value.is_empty())
            .ok_or(Error::InvalidResource)?;
        let content_type = clean_first(attachment, &["content-type", "content_type"], 120)?;
        let size = attachment.get("size").and_then(Value::as_u64);
        let projected = json!({"name":name,"contentType":content_type,"sizeBytes":size});
        conversation_attachments.push(projected.clone());
        output.push(projected);
    }
    Ok(output)
}

fn clean_first(value: &Value, keys: &[&str], max: usize) -> ProjectionResult<Option<String>> {
    for key in keys {
        if value.get(*key).is_some_and(Value::is_string) {
            return clean_optional(value.get(*key), max);
        }
    }
    Ok(None)
}

pub(super) fn clean_optional(
    value: Option<&Value>,
    max: usize,
) -> ProjectionResult<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let Some(text) = value.as_str() else {
        return Ok(None);
    };
    clean_text(text, max).map(|text| (!text.is_empty()).then_some(text))
}

fn clean_text(value: &str, max: usize) -> ProjectionResult<String> {
    if looks_like_html(value) {
        return Err(BrowserAccountProjectionError::UnsafeContent);
    }
    let mut words: Vec<String> = Vec::new();
    let mut redact_next = 0u8;
    for word in value.split_whitespace() {
        if redact_next > 0 {
            if redact_next == 2
                && word
                    .trim_matches(|ch: char| !ch.is_ascii_alphanumeric())
                    .eq_ignore_ascii_case("bearer")
            {
                words.push("Bearer [redacted]".into());
                redact_next = 1;
            } else {
                words.push("[redacted]".into());
                redact_next = 0;
            }
            continue;
        }
        let lower = word.to_ascii_lowercase();
        if lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("//")
            || lower.starts_with("www.")
            || lower.starts_with("javascript:")
            || lower.starts_with("data:")
            || lower.contains("://")
            || has_signed_query(&lower)
        {
            words.push("[link]".into());
            continue;
        }
        let separator = word.find(['=', ':']);
        if let Some(index) = separator {
            let key = lower[..index]
                .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-');
            if is_private_key(key) {
                let prefix = &word[..=index];
                words.push(format!("{prefix}[redacted]"));
                if index + 1 == word.len() {
                    redact_next = if matches!(key, "auth" | "authorization") {
                        2
                    } else {
                        1
                    };
                }
                continue;
            }
        }
        if lower == "bearer"
            || is_private_key(
                lower
                    .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-'),
            )
        {
            redact_next = 1;
            words.push("[redacted]".into());
            continue;
        }
        words.push(word.to_owned());
    }
    let mut cleaned = words
        .join(" ")
        .chars()
        .filter(|ch| !ch.is_control() || matches!(*ch, '\n' | '\t'))
        .collect::<String>();
    cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(cleaned.chars().take(max.min(MAX_TEXT_CHARACTERS)).collect())
}

fn is_private_key(value: &str) -> bool {
    let key = value.to_ascii_lowercase();
    matches!(
        key.as_str(),
        "token"
            | "access_token"
            | "access-token"
            | "authorization"
            | "auth"
            | "cookie"
            | "session"
            | "password"
            | "secret"
            | "signature"
            | "sig"
            | "verifier"
            | "credential"
            | "policy"
            | "expires"
            | "awsaccesskeyid"
            | "x-amz-signature"
            | "x-goog-signature"
    ) || key.starts_with("x-amz-")
        || key.starts_with("x-goog-")
}

fn has_signed_query(value: &str) -> bool {
    [
        "verifier",
        "token",
        "access_token",
        "signature",
        "sig",
        "auth",
        "credential",
        "password",
        "policy",
        "expires",
        "awsaccesskeyid",
        "x-amz-",
        "x-goog-",
        "se",
        "sp",
        "sv",
    ]
    .iter()
    .any(|key| {
        value.contains(format!("?{key}=").as_str()) || value.contains(format!("&{key}=").as_str())
    })
}

fn looks_like_html(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.iter().enumerate().any(|(index, byte)| {
        if *byte != b'<' {
            return false;
        }
        let mut next = index + 1;
        if matches!(bytes.get(next), Some(b'/' | b'!')) {
            next += 1;
        }
        bytes.get(next).is_some_and(u8::is_ascii_alphabetic)
            && bytes[next..]
                .iter()
                .take(512)
                .any(|character| *character == b'>')
    })
}
