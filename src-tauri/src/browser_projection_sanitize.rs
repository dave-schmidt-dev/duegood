//! Recursive privacy and URL sanitization for the browser projection.

use serde_json::{Map, Value};

use super::ProjectionError;

pub(super) fn project_fields(
    item: &Value,
    allowed: &[&str],
) -> Result<Map<String, Value>, ProjectionError> {
    let object = item.as_object().ok_or(ProjectionError::InvalidResource)?;
    let mut result = Map::new();
    for field in allowed {
        let source = if *field == "links" {
            object.get("_canvasLinks").or_else(|| object.get("links"))
        } else {
            object.get(*field)
        };
        let Some(value) = source else {
            continue;
        };
        result.insert((*field).to_owned(), sanitize_value(value, field)?);
    }
    if allowed.contains(&"links")
        && object.get("_canvasLinksTruncated").and_then(Value::as_bool) == Some(true)
    {
        result.insert("linksTruncated".into(), Value::Bool(true));
    }
    if object.get("_canvasTextTruncated").and_then(Value::as_bool) == Some(true) {
        result.insert("textTruncated".into(), Value::Bool(true));
    }
    Ok(result)
}

pub(super) fn sanitize_value(value: &Value, field: &str) -> Result<Value, ProjectionError> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(value.clone()),
        Value::String(text) => {
            if field_is_private(field) {
                return Err(ProjectionError::UnsafeContent);
            }
            if looks_like_html(text) {
                return Err(ProjectionError::UnsafeContent);
            }
            if is_url_field(field) {
                return Ok(clean_url(text));
            }
            Ok(Value::String(sanitize_text(text)?))
        }
        Value::Array(values) => values
            .iter()
            .map(|value| sanitize_value(value, field))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(object) => {
            let mut result = Map::new();
            for (key, value) in object {
                if field_is_private(key) {
                    continue;
                }
                if field == "links"
                    && !matches!(
                        key.as_str(),
                        "source"
                            | "title"
                            | "asciiHostname"
                            | "safeTarget"
                            | "clickable"
                            | "reason"
                    )
                {
                    continue;
                }
                result.insert(key.clone(), sanitize_value(value, key)?);
            }
            if field == "links" {
                if let Some(target) = result.get("safeTarget").and_then(Value::as_str) {
                    let hostname = url::Url::parse(target)
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
                    result.insert(
                        "asciiHostname".into(),
                        hostname.map_or(Value::Null, Value::String),
                    );
                } else {
                    let hostname = result
                        .get("asciiHostname")
                        .and_then(Value::as_str)
                        .and_then(clean_hostname);
                    result.insert(
                        "asciiHostname".into(),
                        hostname.map_or(Value::Null, Value::String),
                    );
                    result.insert("clickable".into(), Value::Bool(false));
                }
            }
            Ok(Value::Object(result))
        }
    }
}

pub(super) fn sanitize_text(text: &str) -> Result<String, ProjectionError> {
    if looks_like_html(text) {
        return Err(ProjectionError::UnsafeContent);
    }
    let mut output = strip_inline_urls(text);
    for key in [
        "access_token",
        "access-token",
        "access token",
        "authorization",
        "auth",
        "bearer",
        "token",
        "password",
        "secret",
        "signature",
        "sig",
        "verifier",
        "credential",
        "policy",
        "expires",
        "awsaccesskeyid",
        "x-amz-signature",
        "x-goog-signature",
        "x-amz-",
        "x-goog-",
        "se",
        "sp",
        "sv",
    ] {
        output = redact_assignments(&output, key);
    }
    Ok(output)
}

fn strip_inline_urls(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while cursor < input.len() {
        let next = ["https://", "http://", "//"]
            .iter()
            .filter_map(|prefix| lower[cursor..].find(prefix).map(|at| (at, *prefix)))
            .min_by_key(|(at, _)| *at);
        let Some((relative, prefix)) = next else {
            output.push_str(&input[cursor..]);
            break;
        };
        let start = cursor + relative;
        let before_ok = start == 0
            || (!lower.as_bytes()[start - 1].is_ascii_alphanumeric()
                && !matches!(lower.as_bytes()[start - 1], b'_' | b'@'));
        if !before_ok {
            let end = start + prefix.len();
            output.push_str(&input[cursor..end]);
            cursor = end;
            continue;
        }
        let mut end = start + prefix.len();
        while end < input.len() {
            let character = input[end..]
                .chars()
                .next()
                .expect("valid character boundary");
            if character.is_whitespace() || matches!(character, '<' | '>' | '"' | '\'' | '`') {
                break;
            }
            end += character.len_utf8();
        }
        output.push_str(&input[cursor..start]);
        output.push_str("[link]");
        cursor = end;
    }
    output
}

fn redact_assignments(input: &str, key: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while cursor < input.len() {
        let Some(relative) = lower[cursor..].find(key) else {
            output.push_str(&input[cursor..]);
            break;
        };
        let start = cursor + relative;
        let end = start + key.len();
        let before_ok = start == 0
            || (!lower.as_bytes()[start - 1].is_ascii_alphanumeric()
                && lower.as_bytes()[start - 1] != b'_');
        let after_ok = end == lower.len()
            || (!lower.as_bytes()[end].is_ascii_alphanumeric() && lower.as_bytes()[end] != b'_');
        if !before_ok || !after_ok {
            output.push_str(&input[cursor..end]);
            cursor = end;
            continue;
        }
        let mut value_start = end;
        while value_start < input.len() && input.as_bytes()[value_start].is_ascii_whitespace() {
            value_start += 1;
        }
        let has_separator = value_start < input.len()
            && (matches!(input.as_bytes()[value_start], b'=' | b':')
                || key == "bearer" && value_start > end);
        if !has_separator {
            output.push_str(&input[cursor..end]);
            cursor = end;
            continue;
        }
        if matches!(input.as_bytes()[value_start], b'=' | b':') {
            value_start += 1;
        }
        while value_start < input.len() && input.as_bytes()[value_start].is_ascii_whitespace() {
            value_start += 1;
        }
        let mut value_end = value_start;
        while value_end < input.len() {
            let character = input[value_end..]
                .chars()
                .next()
                .expect("valid character boundary");
            if character.is_whitespace()
                || matches!(character, '&' | ';' | ',' | '<' | '>' | '"' | '\'')
            {
                break;
            }
            value_end += character.len_utf8();
        }
        if value_start == value_end {
            output.push_str(&input[cursor..end]);
            cursor = end;
            continue;
        }
        output.push_str(&input[cursor..end]);
        output.push_str("=[redacted]");
        cursor = value_end;
    }
    output
}

fn clean_url(value: &str) -> Value {
    let Ok(mut url) = url::Url::parse(value) else {
        return Value::Null;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Value::Null;
    }
    url.set_query(None);
    url.set_fragment(None);
    Value::from(url.to_string())
}

fn clean_hostname(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 253
        || !value.is_ascii()
        || value.starts_with('.')
        || value.ends_with('.')
        || value.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

fn field_is_private(field: &str) -> bool {
    let lower = field.to_ascii_lowercase();
    [
        "access_token",
        "access-token",
        "authorization",
        "credential",
        "password",
        "secret",
        "signature",
        "verifier",
        "private_key",
        "signed_url",
        "private_url",
        "calendar_feed",
        "cookie",
        "session",
        "policy",
        "expires",
        "awsaccesskeyid",
        "x-amz-",
        "x-goog-",
        "lti_user_id",
        "sis_user_id",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
        || matches!(lower.as_str(), "auth" | "token" | "sig")
}

fn is_url_field(field: &str) -> bool {
    matches!(field, "url" | "uri" | "href" | "src" | "safeTarget")
        || field.ends_with("_url")
        || field.ends_with("_uri")
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
