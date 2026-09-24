//! Bounded, read-only Canvas HTTP access for the local refresh helper.
//!
//! Production requests are pinned to Marymount's Canvas origin. Bearer credentials are used only
//! for the allowlisted API paths below, and the HTTP client never follows redirects.

use std::collections::HashSet;
use std::fmt;
use std::io::Read;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_LENGTH, LINK};
use reqwest::{StatusCode, Url};
use serde_json::Value;

pub const CANVAS_ORIGIN: &str = "https://marymount.instructure.com";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const REQUEST_ATTEMPTS: usize = 2;
const MAX_COURSE_PAGES: usize = 100;
const MAX_INBOX_PAGES: usize = 10;
const MAX_INBOX_ITEMS: usize = 500;

/// A Canvas response with a URL safe to place in local request metadata.
#[derive(Clone, PartialEq)]
pub struct ApiResponse {
    pub status: u16,
    /// The requested URL with its query and fragment removed.
    pub safe_url: String,
    pub body: Value,
}

/// Content-free Canvas HTTP error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanvasError {
    InvalidToken,
    InvalidOrigin,
    InvalidEndpoint,
    UnsafePaginationLink,
    PaginationLoop,
    PageLimitExceeded,
    ItemLimitExceeded,
    RedirectRefused,
    ResponseTooLarge,
    InvalidResponse,
    RequestFailed,
    HttpStatus(u16),
    ConcurrencyLockPoisoned,
}

impl CanvasError {
    /// Stable machine-readable error identifier.
    pub fn code(&self) -> &'static str {
        match self {
            CanvasError::InvalidToken => "invalid-token",
            CanvasError::InvalidOrigin => "invalid-origin",
            CanvasError::InvalidEndpoint => "invalid-endpoint",
            CanvasError::UnsafePaginationLink => "unsafe-pagination-link",
            CanvasError::PaginationLoop => "pagination-loop",
            CanvasError::PageLimitExceeded => "page-limit-exceeded",
            CanvasError::ItemLimitExceeded => "item-limit-exceeded",
            CanvasError::RedirectRefused => "redirect-refused",
            CanvasError::ResponseTooLarge => "response-too-large",
            CanvasError::InvalidResponse => "invalid-response",
            CanvasError::RequestFailed => "request-failed",
            CanvasError::HttpStatus(_) => "http-status",
            CanvasError::ConcurrencyLockPoisoned => "concurrency-lock-poisoned",
        }
    }
}

impl fmt::Display for CanvasError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CanvasError::HttpStatus(status) => write!(f, "Canvas returned HTTP status {status}."),
            _ => write!(f, "Canvas request failed ({}).", self.code()),
        }
    }
}

impl std::error::Error for CanvasError {}

/// Read-only Canvas API client.
pub struct CanvasApi {
    client: Client,
    origin: Url,
    authorization: HeaderValue,
    request_gate: Mutex<()>,
}

impl CanvasApi {
    /// Creates a client pinned to the production Marymount Canvas origin.
    pub fn new(token: &str) -> Result<Self, CanvasError> {
        Self::build(CANVAS_ORIGIN, token, false)
    }

    /// Creates a test client pinned to a loopback HTTP mock server.
    ///
    /// This constructor exists only when the Cargo `test-overrides` feature is enabled; it cannot
    /// be used to point the production constructor at another Canvas instance.
    #[cfg(feature = "test-overrides")]
    pub fn with_test_origin(origin: &str, token: &str) -> Result<Self, CanvasError> {
        Self::build(origin, token, true)
    }

    /// Creates a test client from `DUEGOOD_TEST_CANVAS_ORIGIN`.
    #[cfg(feature = "test-overrides")]
    pub fn from_test_environment(token: &str) -> Result<Self, CanvasError> {
        let origin =
            std::env::var("DUEGOOD_TEST_CANVAS_ORIGIN").map_err(|_| CanvasError::InvalidOrigin)?;
        Self::with_test_origin(&origin, token)
    }

    fn build(origin: &str, token: &str, allow_loopback_http: bool) -> Result<Self, CanvasError> {
        let origin = parse_origin(origin, allow_loopback_http)?;
        if token.is_empty() || token.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(CanvasError::InvalidToken);
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| CanvasError::InvalidToken)?;
        authorization.set_sensitive(true);
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("DueGood-Canvas-Refresh/1")
            .build()
            .map_err(|_| CanvasError::RequestFailed)?;
        Ok(Self {
            client,
            origin,
            authorization,
            request_gate: Mutex::new(()),
        })
    }

    /// Fetches one JSON response from an allowlisted Canvas API endpoint.
    pub fn get_json(&self, path_and_query: &str) -> Result<ApiResponse, CanvasError> {
        let _guard = self
            .request_gate
            .lock()
            .map_err(|_| CanvasError::ConcurrencyLockPoisoned)?;
        let url = self.initial_url(path_and_query)?;
        let (status, _, body) = self.fetch_json_page(&url)?;
        Ok(ApiResponse {
            status,
            safe_url: safe_url(&url),
            body,
        })
    }

    /// Fetches all pages from one allowlisted list endpoint.
    ///
    /// Course list endpoints are capped at 100 pages. The read-only Inbox is capped at 10 pages
    /// and 500 items. Reaching a cap while Canvas still advertises another page is an error, so a
    /// truncated response cannot look like a complete refresh.
    pub fn get_pages(&self, path_and_query: &str) -> Result<Vec<ApiResponse>, CanvasError> {
        self.get_pages_with_progress(path_and_query, &mut |_| {})
    }

    /// Fetches all pages while reporting content-free completed-page counts.
    ///
    /// The callback receives `0` immediately before the first request, then `1`, `2`, and so on
    /// after each valid page body is received. It receives no endpoint, query, or Canvas data.
    pub fn get_pages_with_progress(
        &self,
        path_and_query: &str,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<ApiResponse>, CanvasError> {
        let _guard = self
            .request_gate
            .lock()
            .map_err(|_| CanvasError::ConcurrencyLockPoisoned)?;
        let mut current = self.initial_url(path_and_query)?;
        if !is_paginated_path(current.path()) {
            return Err(CanvasError::InvalidEndpoint);
        }
        let (page_limit, item_limit) = page_policy(current.path());
        let mut visited = HashSet::new();
        let mut item_count = 0usize;
        let mut pages = Vec::new();
        on_progress(0);

        for _ in 0..page_limit {
            if !visited.insert(current.as_str().to_owned()) {
                return Err(CanvasError::PaginationLoop);
            }
            let (status, links, body) = self.fetch_json_page(&current)?;
            let values = body.as_array().ok_or(CanvasError::InvalidResponse)?;
            item_count = item_count
                .checked_add(values.len())
                .ok_or(CanvasError::ItemLimitExceeded)?;
            if item_limit.is_some_and(|limit| item_count > limit) {
                return Err(CanvasError::ItemLimitExceeded);
            }
            pages.push(ApiResponse {
                status,
                safe_url: safe_url(&current),
                body,
            });
            on_progress(pages.len() as u64);

            let Some(target) = parse_next_link(&links)? else {
                return Ok(pages);
            };
            let next = validate_next_url(&current, &target)?;
            if visited.contains(next.as_str()) {
                return Err(CanvasError::PaginationLoop);
            }
            current = next;
        }

        // Never report a capped/truncated listing as complete.
        Err(CanvasError::PageLimitExceeded)
    }

    fn initial_url(&self, path_and_query: &str) -> Result<Url, CanvasError> {
        if !path_and_query.starts_with('/')
            || path_and_query.starts_with("//")
            || path_and_query.contains('#')
            || path_and_query.contains('\\')
            || path_and_query.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(CanvasError::InvalidEndpoint);
        }
        let url = self
            .origin
            .join(path_and_query)
            .map_err(|_| CanvasError::InvalidEndpoint)?;
        if !same_origin(&url, &self.origin) || !is_allowed_api_path(url.path()) {
            return Err(CanvasError::InvalidEndpoint);
        }
        Ok(url)
    }

    fn fetch_json_page(&self, url: &Url) -> Result<(u16, Vec<String>, Value), CanvasError> {
        let mut last_error = CanvasError::RequestFailed;
        for attempt in 0..REQUEST_ATTEMPTS {
            let response = self
                .client
                .get(url.clone())
                .header(ACCEPT, "application/json")
                .header(AUTHORIZATION, self.authorization.clone())
                .send();
            let response = match response {
                Ok(response) => response,
                Err(_) => {
                    last_error = CanvasError::RequestFailed;
                    if attempt + 1 < REQUEST_ATTEMPTS {
                        retry_pause();
                        continue;
                    }
                    return Err(last_error);
                }
            };

            let status = response.status();
            if is_retryable_status(status) {
                last_error = CanvasError::HttpStatus(status.as_u16());
                if attempt + 1 < REQUEST_ATTEMPTS {
                    retry_pause();
                    continue;
                }
                return Err(last_error);
            }
            if status.is_redirection() {
                return Err(CanvasError::RedirectRefused);
            }
            if !status.is_success() {
                return Err(CanvasError::HttpStatus(status.as_u16()));
            }

            let links = response
                .headers()
                .get_all(LINK)
                .iter()
                .map(|value| value.to_str().map(str::to_owned))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| CanvasError::InvalidResponse)?;
            let body = match read_response_bounded(response, MAX_RESPONSE_BYTES) {
                Ok(body) => body,
                Err(CanvasError::RequestFailed) if attempt + 1 < REQUEST_ATTEMPTS => {
                    last_error = CanvasError::RequestFailed;
                    retry_pause();
                    continue;
                }
                Err(error) => return Err(error),
            };
            let json = serde_json::from_slice(&body).map_err(|_| CanvasError::InvalidResponse)?;
            return Ok((status.as_u16(), links, json));
        }
        Err(last_error)
    }
}

fn parse_origin(origin: &str, allow_loopback_http: bool) -> Result<Url, CanvasError> {
    let parsed = Url::parse(origin).map_err(|_| CanvasError::InvalidOrigin)?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(CanvasError::InvalidOrigin);
    }
    if allow_loopback_http {
        let host = parsed.host_str().ok_or(CanvasError::InvalidOrigin)?;
        let ip = IpAddr::from_str(host).map_err(|_| CanvasError::InvalidOrigin)?;
        if parsed.scheme() != "http" || !ip.is_loopback() || parsed.port().is_none() {
            return Err(CanvasError::InvalidOrigin);
        }
    } else if parsed.as_str().trim_end_matches('/') != CANVAS_ORIGIN
        || parsed.scheme() != "https"
        || parsed.port().is_some()
    {
        return Err(CanvasError::InvalidOrigin);
    }
    Ok(parsed)
}

fn is_allowed_api_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').skip(1).collect();
    match parts.as_slice() {
        ["api", "v1", "courses", id] => numeric_id(id),
        ["api", "v1", "courses", id, resource] => {
            numeric_id(id)
                && matches!(
                    *resource,
                    "tabs"
                        | "pages"
                        | "modules"
                        | "assignment_groups"
                        | "assignments"
                        | "discussion_topics"
                        | "files"
                        | "folders"
                )
        }
        ["api", "v1", "announcements"] => true,
        ["api", "v1", "conversations"] => true,
        ["api", "v1", "conversations", id] => numeric_id(id),
        ["api", "v1", "users", "self", "profile"] => true,
        _ => false,
    }
}

fn is_paginated_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').skip(1).collect();
    match parts.as_slice() {
        ["api", "v1", "courses", id, resource] => {
            numeric_id(id)
                && matches!(
                    *resource,
                    "tabs"
                        | "pages"
                        | "modules"
                        | "assignment_groups"
                        | "assignments"
                        | "discussion_topics"
                        | "files"
                        | "folders"
                )
        }
        ["api", "v1", "announcements"] | ["api", "v1", "conversations"] => true,
        _ => false,
    }
}

fn numeric_id(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn page_policy(path: &str) -> (usize, Option<usize>) {
    if path == "/api/v1/conversations" {
        (MAX_INBOX_PAGES, Some(MAX_INBOX_ITEMS))
    } else {
        (MAX_COURSE_PAGES, None)
    }
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
        && left.username().is_empty()
        && left.password().is_none()
}

fn validate_next_url(current: &Url, target: &str) -> Result<Url, CanvasError> {
    if target.is_empty() || target.contains('#') || target.contains('\\') {
        return Err(CanvasError::UnsafePaginationLink);
    }
    let next = current
        .join(target)
        .map_err(|_| CanvasError::UnsafePaginationLink)?;
    if !same_origin(&next, current)
        || next.path() != current.path()
        || !is_allowed_api_path(next.path())
    {
        return Err(CanvasError::UnsafePaginationLink);
    }
    Ok(next)
}

fn parse_next_link(headers: &[String]) -> Result<Option<String>, CanvasError> {
    let mut next = None;
    for header in headers {
        for part in split_link_values(header)? {
            let part = part.trim();
            if !part.starts_with('<') {
                return Err(CanvasError::InvalidResponse);
            }
            let close = part.find('>').ok_or(CanvasError::InvalidResponse)?;
            let target = &part[1..close];
            let mut is_next = false;
            for parameter in part[close + 1..].split(';').skip(1) {
                let Some((name, value)) = parameter.trim().split_once('=') else {
                    continue;
                };
                if name.trim().eq_ignore_ascii_case("rel") {
                    let mut relations = value.trim().trim_matches('"').split_ascii_whitespace();
                    is_next = relations.any(|relation| relation.eq_ignore_ascii_case("next"));
                }
            }
            if is_next {
                if target.is_empty() {
                    return Err(CanvasError::InvalidResponse);
                }
                if next.as_deref().is_some_and(|existing| existing != target) {
                    return Err(CanvasError::InvalidResponse);
                }
                next = Some(target.to_owned());
            }
        }
    }
    Ok(next)
}

fn split_link_values(header: &str) -> Result<Vec<&str>, CanvasError> {
    let mut result = Vec::new();
    let mut start = 0usize;
    let mut in_target = false;
    let mut in_quote = false;
    let mut escaped = false;
    for (index, character) in header.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && in_quote {
            escaped = true;
            continue;
        }
        if character == '"' && !in_target {
            in_quote = !in_quote;
            continue;
        }
        if in_quote {
            continue;
        }
        match character {
            '<' if !in_target => in_target = true,
            '>' if in_target => in_target = false,
            ',' if !in_target => {
                result.push(&header[start..index]);
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    if in_target || in_quote || escaped {
        return Err(CanvasError::InvalidResponse);
    }
    result.push(&header[start..]);
    Ok(result)
}

fn safe_url(url: &Url) -> String {
    let mut safe = url.clone();
    safe.set_query(None);
    safe.set_fragment(None);
    safe.to_string()
}

fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

fn retry_pause() {
    thread::sleep(Duration::from_millis(100));
}

fn read_response_bounded(mut response: Response, max_bytes: u64) -> Result<Vec<u8>, CanvasError> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > max_bytes)
    {
        return Err(CanvasError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CanvasError::RequestFailed)?;
    if bytes.len() as u64 > max_bytes {
        return Err(CanvasError::ResponseTooLarge);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_origin_and_endpoint_families_are_fixed() {
        assert_eq!(
            parse_origin(CANVAS_ORIGIN, false).unwrap().as_str(),
            "https://marymount.instructure.com/"
        );
        assert_eq!(
            parse_origin("https://other.instructure.com", false),
            Err(CanvasError::InvalidOrigin)
        );
        assert!(is_allowed_api_path("/api/v1/courses/9101/modules"));
        assert!(is_allowed_api_path("/api/v1/announcements"));
        assert!(is_allowed_api_path("/api/v1/conversations/77001"));
        assert!(is_allowed_api_path("/api/v1/users/self/profile"));
        assert!(!is_allowed_api_path("/api/v1/accounts/self/reports"));
        assert!(!is_allowed_api_path("/api/v1/courses/../accounts"));
        assert!(!is_allowed_api_path("/api/v1/courses/9101/assignments/77"));
    }

    #[test]
    fn next_links_must_keep_exact_origin_and_path() {
        let current =
            Url::parse("https://marymount.instructure.com/api/v1/courses/9101/modules?page=1")
                .unwrap();
        let next = validate_next_url(
            &current,
            "https://marymount.instructure.com/api/v1/courses/9101/modules?page=2",
        )
        .unwrap();
        assert_eq!(next.query(), Some("page=2"));
        assert_eq!(
            validate_next_url(
                &current,
                "https://evil.invalid/api/v1/courses/9101/modules?page=2"
            ),
            Err(CanvasError::UnsafePaginationLink)
        );
        assert_eq!(
            validate_next_url(
                &current,
                "https://marymount.instructure.com/api/v1/accounts/self/reports?page=2"
            ),
            Err(CanvasError::UnsafePaginationLink)
        );
        assert_eq!(
            validate_next_url(
                &current,
                "https://marymount.instructure.com/api/v1/courses/9102/modules?page=2"
            ),
            Err(CanvasError::UnsafePaginationLink)
        );
    }

    #[test]
    fn safe_url_strips_verifier_query_and_link_parser_handles_quoted_commas() {
        let url = Url::parse(
            "https://marymount.instructure.com/api/v1/courses/9101/files?verifier=secret",
        )
        .unwrap();
        assert_eq!(
            safe_url(&url),
            "https://marymount.instructure.com/api/v1/courses/9101/files"
        );
        let links = vec!["<https://marymount.instructure.com/api/v1/courses/9101/modules?page=2>; rel=\"next\", <https://marymount.instructure.com/api/v1/courses/9101/modules?page=1>; rel=\"first\"; title=\"a,b\"".to_owned()];
        assert_eq!(
            parse_next_link(&links).unwrap().as_deref(),
            Some("https://marymount.instructure.com/api/v1/courses/9101/modules?page=2")
        );
    }

    #[test]
    fn inbox_uses_smaller_pagination_and_item_caps() {
        assert_eq!(page_policy("/api/v1/conversations"), (10, Some(500)));
        assert_eq!(page_policy("/api/v1/courses/9101/modules"), (100, None));
        assert!(is_paginated_path("/api/v1/conversations"));
        assert!(!is_paginated_path("/api/v1/users/self/profile"));
    }

    #[cfg(feature = "test-overrides")]
    #[test]
    fn test_origin_override_accepts_only_loopback_http() {
        assert!(parse_origin("http://127.0.0.1:8011", true).is_ok());
        assert!(parse_origin("http://10.0.0.2:8011", true).is_err());
        assert!(parse_origin("https://marymount.instructure.com", true).is_err());
        assert!(parse_origin("http://127.0.0.1", true).is_err());
    }

    #[cfg(feature = "test-overrides")]
    #[test]
    fn paginated_requests_report_content_free_page_progress() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::sync::mpsc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let server = thread::spawn(move || {
            for body in [r#"[{"id":1}]"#, "[]"] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    request.push_str(&line);
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                tx.send(request).unwrap();
                let link = if body == r#"[{"id":1}]"# {
                    format!("Link: </api/v1/courses/9101/modules?page=2>; rel=\"next\"\r\n")
                } else {
                    String::new()
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{link}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });

        let client = CanvasApi::with_test_origin(&origin, "synthetic-test-token").unwrap();
        let mut progress = Vec::new();
        let pages = client
            .get_pages_with_progress(
                "/api/v1/courses/9101/modules?per_page=100&verifier=secret",
                &mut |completed_pages| progress.push(completed_pages),
            )
            .unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(progress, vec![0, 1, 2]);
        assert_eq!(pages[0].status, 200);
        assert_eq!(
            pages[0].safe_url,
            format!("{origin}/api/v1/courses/9101/modules")
        );
        assert_eq!(pages[0].body.as_array().unwrap().len(), 1);
        let first_request = rx.recv().unwrap();
        let second_request = rx.recv().unwrap();
        assert!(first_request
            .to_ascii_lowercase()
            .contains("authorization: bearer synthetic-test-token"));
        assert!(second_request
            .to_ascii_lowercase()
            .contains("authorization: bearer synthetic-test-token"));
        server.join().unwrap();
    }

    #[cfg(feature = "test-overrides")]
    #[test]
    fn api_redirect_is_refused_before_a_second_request() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::sync::mpsc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                request.push_str(&line);
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            tx.send(request).unwrap();
            let body = "";
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: https://evil.invalid/api/v1/courses/9101\r\nContent-Length: 0\r\nConnection: close\r\n\r\n{body}"
            )
            .unwrap();
        });
        let client = CanvasApi::with_test_origin(&origin, "synthetic-test-token").unwrap();
        assert_eq!(
            client.get_json("/api/v1/courses/9101").err().unwrap(),
            CanvasError::RedirectRefused
        );
        assert!(rx
            .recv()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization: bearer synthetic-test-token"));
        server.join().unwrap();
    }
}
