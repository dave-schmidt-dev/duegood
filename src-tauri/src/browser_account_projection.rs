//! Fixed-path privacy projection for Canvas browser account data.

#[path = "browser_account_projection_messages.rs"]
mod messages;
use messages::clean_optional;
#[cfg(test)]
#[path = "browser_account_projection_tests.rs"]
mod tests;

use std::collections::{BTreeMap, HashMap};
use std::fmt;

use serde_json::{json, Value};

const CANVAS_ORIGIN: &str = "https://marymount.instructure.com";
const LIST_ENDPOINTS: [&str; 4] = [
    "inbox",
    "inboxAll",
    "conversationsSent",
    "conversationsArchived",
];
const MAX_CONVERSATIONS: usize = 500;
const MAX_LIST_ITEMS: usize = 5_000;
const MAX_LINKS_PER_ITEM: usize = 500;
const MAX_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;

/// Content-free failure codes for account projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserAccountProjectionError {
    InvalidSnapshot,
    InvalidIdentity,
    IdentityMismatch,
    InvalidCoverage,
    DuplicateCoverage,
    DuplicateResource,
    InvalidResource,
    UnsafeContent,
    LimitExceeded,
    Serialization,
}

impl BrowserAccountProjectionError {
    /// Returns a stable diagnostic code that contains no captured Canvas data.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidSnapshot => "INVALID_SNAPSHOT",
            Self::InvalidIdentity => "INVALID_IDENTITY",
            Self::IdentityMismatch => "IDENTITY_MISMATCH",
            Self::InvalidCoverage => "INVALID_COVERAGE",
            Self::DuplicateCoverage => "DUPLICATE_COVERAGE",
            Self::DuplicateResource => "DUPLICATE_RESOURCE",
            Self::InvalidResource => "INVALID_RESOURCE",
            Self::UnsafeContent => "UNSAFE_CONTENT",
            Self::LimitExceeded => "LIMIT_EXCEEDED",
            Self::Serialization => "SERIALIZATION_FAILED",
        }
    }
}

impl fmt::Display for BrowserAccountProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for BrowserAccountProjectionError {}

type ProjectionResult<T> = Result<T, BrowserAccountProjectionError>;

#[derive(Default)]
struct CoverageIndex {
    endpoints: HashMap<&'static str, bool>,
    conversation_complete: usize,
    conversation_gaps: usize,
}

#[derive(Default)]
struct ResourceIndex<'a> {
    endpoints: HashMap<&'static str, &'a Value>,
    conversation_details: Vec<&'a Value>,
}

/// Projects a validated schema-v2 account snapshot into fixed JSON documents.
pub fn project_account_documents(snapshot: &Value) -> ProjectionResult<BTreeMap<String, Vec<u8>>> {
    if snapshot.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || snapshot.get("source").and_then(Value::as_str) != Some("canvas-browser")
    {
        return Err(BrowserAccountProjectionError::InvalidSnapshot);
    }
    let identity = snapshot
        .get("identity")
        .and_then(Value::as_object)
        .ok_or(BrowserAccountProjectionError::InvalidIdentity)?;
    let user_id = identity
        .get("userId")
        .and_then(positive_numeric_id)
        .ok_or(BrowserAccountProjectionError::InvalidIdentity)?;
    if identity.get("origin").and_then(Value::as_str) != Some(CANVAS_ORIGIN) {
        return Err(BrowserAccountProjectionError::InvalidIdentity);
    }

    let coverage = index_coverage(snapshot.get("coverage"))?;
    let resources = index_resources(snapshot.get("resources"))?;
    let captured_at = clean_optional(snapshot.get("capturedAt"), 80)?;
    let mut documents = BTreeMap::new();

    if coverage.endpoints.get("profile") == Some(&true) {
        if let Some(resource) = resources.endpoints.get("profile") {
            let items = resource_items(resource)?;
            if items.len() != 1 {
                return Err(BrowserAccountProjectionError::InvalidResource);
            }
            let profile = &items[0];
            let profile_id = profile
                .get("id")
                .and_then(positive_numeric_id)
                .ok_or(BrowserAccountProjectionError::InvalidIdentity)?;
            if profile_id != user_id {
                return Err(BrowserAccountProjectionError::IdentityMismatch);
            }
            let name = clean_optional(profile.get("name"), 200)?;
            let short_name = clean_optional(profile.get("short_name"), 120)?;
            if name.is_some() || short_name.is_some() {
                put_json(
                    &mut documents,
                    "canvas-profile.json",
                    &json!({"name":name,"short_name":short_name,"avatar":null}),
                )?;
            }
        }
    }

    if inbox_lists_available(&coverage, &resources) {
        let inbox = messages::project_inbox(&resources, &coverage, &captured_at)?;
        put_json(&mut documents, "canvas-conversations.json", &inbox)?;
    }

    Ok(documents)
}

fn index_coverage(value: Option<&Value>) -> ProjectionResult<CoverageIndex> {
    let rows = value
        .and_then(Value::as_array)
        .ok_or(BrowserAccountProjectionError::InvalidCoverage)?;
    if rows.len() > MAX_LIST_ITEMS * 4 {
        return Err(BrowserAccountProjectionError::LimitExceeded);
    }
    let mut result = CoverageIndex::default();
    for row in rows {
        let endpoint = row
            .get("endpoint")
            .and_then(Value::as_str)
            .ok_or(BrowserAccountProjectionError::InvalidCoverage)?;
        if endpoint == "conversation" {
            if !row.get("courseId").is_some_and(Value::is_null) {
                return Err(BrowserAccountProjectionError::InvalidCoverage);
            }
            match row.get("status").and_then(Value::as_str) {
                Some("complete") => result.conversation_complete += 1,
                Some("gap" | "incomplete") => result.conversation_gaps += 1,
                _ => return Err(BrowserAccountProjectionError::InvalidCoverage),
            }
            continue;
        }
        let Some(key) = account_endpoint(endpoint) else {
            continue;
        };
        if !row.get("courseId").is_some_and(Value::is_null) {
            return Err(BrowserAccountProjectionError::InvalidCoverage);
        }
        let complete = match row.get("status").and_then(Value::as_str) {
            Some("complete") => true,
            Some("gap" | "incomplete") => false,
            _ => return Err(BrowserAccountProjectionError::InvalidCoverage),
        };
        if result.endpoints.insert(key, complete).is_some() {
            return Err(BrowserAccountProjectionError::DuplicateCoverage);
        }
    }
    Ok(result)
}

fn account_endpoint(endpoint: &str) -> Option<&'static str> {
    match endpoint {
        "profile"
        | "groups"
        | "personalFiles"
        | "personalFolders"
        | "inbox"
        | "inboxAll"
        | "conversationsSent"
        | "conversationsArchived" => Some(match endpoint {
            "profile" => "profile",
            "groups" => "groups",
            "personalFiles" => "personalFiles",
            "personalFolders" => "personalFolders",
            "inbox" => "inbox",
            "inboxAll" => "inboxAll",
            "conversationsSent" => "conversationsSent",
            _ => "conversationsArchived",
        }),
        _ => None,
    }
}

fn index_resources(value: Option<&Value>) -> ProjectionResult<ResourceIndex<'_>> {
    let rows = value
        .and_then(Value::as_array)
        .ok_or(BrowserAccountProjectionError::InvalidSnapshot)?;
    if rows.len() > MAX_LIST_ITEMS * 4 {
        return Err(BrowserAccountProjectionError::LimitExceeded);
    }
    let mut result = ResourceIndex::default();
    for row in rows {
        let endpoint = row
            .get("endpoint")
            .and_then(Value::as_str)
            .ok_or(BrowserAccountProjectionError::InvalidResource)?;
        let Some(key) = account_endpoint(endpoint) else {
            if endpoint == "conversation" {
                if !row.get("courseId").is_some_and(Value::is_null) {
                    return Err(BrowserAccountProjectionError::InvalidResource);
                }
                if result.conversation_details.len() >= MAX_CONVERSATIONS {
                    return Err(BrowserAccountProjectionError::LimitExceeded);
                }
                let items = resource_items(row)?;
                if items.len() != 1 {
                    return Err(BrowserAccountProjectionError::InvalidResource);
                }
                result.conversation_details.push(row);
                continue;
            }
            continue;
        };
        if !row.get("courseId").is_some_and(Value::is_null) {
            return Err(BrowserAccountProjectionError::InvalidResource);
        }
        resource_items(row)?;
        if result.endpoints.insert(key, row).is_some() {
            return Err(BrowserAccountProjectionError::DuplicateResource);
        }
    }
    Ok(result)
}

pub(super) fn resource_items(resource: &Value) -> ProjectionResult<&[Value]> {
    let items = resource
        .get("items")
        .and_then(Value::as_array)
        .ok_or(BrowserAccountProjectionError::InvalidResource)?;
    if items.len() > MAX_LIST_ITEMS {
        return Err(BrowserAccountProjectionError::LimitExceeded);
    }
    Ok(items)
}

fn inbox_lists_available(coverage: &CoverageIndex, resources: &ResourceIndex<'_>) -> bool {
    LIST_ENDPOINTS.iter().all(|endpoint| {
        coverage.endpoints.get(endpoint) == Some(&true)
            && resources.endpoints.contains_key(endpoint)
    })
}

fn project_links(item: &Value) -> ProjectionResult<Vec<Value>> {
    let Some(value) = item.get("_canvasLinks").or_else(|| item.get("links")) else {
        return Ok(Vec::new());
    };
    let links = value
        .as_array()
        .ok_or(BrowserAccountProjectionError::InvalidResource)?;
    if links.len() > MAX_LINKS_PER_ITEM {
        return Err(BrowserAccountProjectionError::LimitExceeded);
    }
    links.iter().map(project_link).collect()
}

fn project_link(value: &Value) -> ProjectionResult<Value> {
    let object = value
        .as_object()
        .ok_or(BrowserAccountProjectionError::InvalidResource)?;
    let source = clean_optional(object.get("source"), 96)?;
    let title = clean_optional(object.get("title"), 256)?;
    let mut host = None;
    let mut target = None;
    let mut query_removed = false;
    if let Some(raw_target) = object.get("safeTarget").and_then(Value::as_str) {
        if raw_target.len() > 2_048 {
            return Err(BrowserAccountProjectionError::LimitExceeded);
        }
        if let Ok(mut url) = url::Url::parse(raw_target) {
            if matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
            {
                host = url.host_str().map(str::to_ascii_lowercase);
                query_removed = url.query().is_some() || url.fragment().is_some();
                url.set_query(None);
                url.set_fragment(None);
                target = Some(url.to_string());
            }
        }
    }
    if host.is_none() {
        host = clean_hostname(object.get("asciiHostname").and_then(Value::as_str));
    }
    let clickable = object.get("clickable").and_then(Value::as_bool) == Some(true)
        && target.is_some()
        && !query_removed;
    let reason = if query_removed {
        Some("query-removed".to_owned())
    } else {
        clean_optional(object.get("reason"), 120)?
    };
    Ok(json!({
        "source":source,"title":title,"asciiHostname":host,
        "safeTarget":target,"clickable":clickable,"reason":reason
    }))
}

fn clean_hostname(value: Option<&str>) -> Option<String> {
    let value = value?.to_ascii_lowercase();
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
        None
    } else {
        Some(value)
    }
}

fn positive_numeric_id(value: &Value) -> Option<u64> {
    value.as_u64().filter(|id| *id > 0)
}

pub(super) fn safe_text_identifier(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value?;
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    (!text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control))
        .then_some(text)
}

pub(super) fn workflow_state(value: Option<&Value>) -> Option<&'static str> {
    match value?.as_str()? {
        "read" => Some("read"),
        "unread" => Some("unread"),
        "archived" => Some("archived"),
        _ => None,
    }
}

pub(super) fn conversation_id(value: Option<&Value>) -> Option<String> {
    let id = safe_text_identifier(value, 20)?;
    (id.bytes().all(|byte| byte.is_ascii_digit()) && id.bytes().any(|byte| byte != b'0'))
        .then_some(id)
}

fn put_json(
    documents: &mut BTreeMap<String, Vec<u8>>,
    path: &str,
    value: &Value,
) -> ProjectionResult<()> {
    let mut bytes =
        serde_json::to_vec(value).map_err(|_| BrowserAccountProjectionError::Serialization)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(BrowserAccountProjectionError::LimitExceeded);
    }
    documents.insert(path.to_owned(), bytes);
    Ok(())
}
