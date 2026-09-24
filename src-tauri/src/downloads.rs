//! Unauthenticated, bounded Canvas material and avatar downloads.
//!
//! Downloads use a separate HTTP client with automatic redirects disabled. Each redirect hop is
//! checked before a new request is sent, and no Authorization header is ever attached.

use std::fmt;
use std::io::Read;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::{StatusCode, Url};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_AVATAR_BYTES: u64 = 5 * 1024 * 1024;
const REQUEST_ATTEMPTS: usize = 2;
const MAX_REDIRECT_HOPS: usize = 3;

/// Downloaded bytes and the non-sensitive response metadata needed by the capture layer.
pub struct DownloadedBody {
    pub status: u16,
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
}

/// Content-free download error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    InvalidUrl,
    RedirectRefused,
    TooManyRedirects,
    ResponseTooLarge,
    InvalidAvatar,
    RequestFailed,
    HttpStatus(u16),
    ConcurrencyLockPoisoned,
}

impl DownloadError {
    /// Stable machine-readable error identifier.
    pub fn code(&self) -> &'static str {
        match self {
            DownloadError::InvalidUrl => "invalid-url",
            DownloadError::RedirectRefused => "redirect-refused",
            DownloadError::TooManyRedirects => "too-many-redirects",
            DownloadError::ResponseTooLarge => "response-too-large",
            DownloadError::InvalidAvatar => "invalid-avatar",
            DownloadError::RequestFailed => "request-failed",
            DownloadError::HttpStatus(_) => "http-status",
            DownloadError::ConcurrencyLockPoisoned => "concurrency-lock-poisoned",
        }
    }
}

impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DownloadError::HttpStatus(status) => {
                write!(f, "Canvas download returned HTTP status {status}.")
            }
            _ => write!(f, "Canvas download failed ({}).", self.code()),
        }
    }
}

impl std::error::Error for DownloadError {}

/// HTTP client for Canvas files and profile avatars.
pub struct DownloadClient {
    client: Client,
    request_gate: Mutex<()>,
    #[cfg(feature = "test-overrides")]
    test_origin: Option<Url>,
}

impl DownloadClient {
    /// Creates a production client. URLs must use HTTPS and a reviewed Canvas/Gravatar host.
    pub fn new() -> Result<Self, DownloadError> {
        Self::build(
            #[cfg(feature = "test-overrides")]
            None,
        )
    }

    /// Creates a test client limited to the loopback origin configured by the test harness.
    ///
    /// This is available only under the Cargo `test-overrides` feature. It reads
    /// `DUEGOOD_TEST_CANVAS_ORIGIN`, which must be a literal loopback HTTP origin with an explicit
    /// port.
    #[cfg(feature = "test-overrides")]
    pub fn from_test_environment() -> Result<Self, DownloadError> {
        let origin =
            std::env::var("DUEGOOD_TEST_CANVAS_ORIGIN").map_err(|_| DownloadError::InvalidUrl)?;
        Self::with_test_origin(&origin)
    }

    /// Creates a test client limited to the supplied loopback mock origin.
    #[cfg(feature = "test-overrides")]
    pub fn with_test_origin(origin: &str) -> Result<Self, DownloadError> {
        let origin = parse_test_origin(origin)?;
        Self::build(Some(origin))
    }

    fn build(
        #[cfg(feature = "test-overrides")] test_origin: Option<Url>,
    ) -> Result<Self, DownloadError> {
        let client = Client::builder()
            .timeout(DOWNLOAD_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("DueGood-Canvas-Download/1")
            .build()
            .map_err(|_| DownloadError::RequestFailed)?;
        Ok(Self {
            client,
            request_gate: Mutex::new(()),
            #[cfg(feature = "test-overrides")]
            test_origin,
        })
    }

    /// Downloads a Canvas file without credentials, validating each redirect destination.
    pub fn download_file(&self, url: &str) -> Result<DownloadedBody, DownloadError> {
        self.download(url, DownloadKind::File)
    }

    /// Downloads and signature-checks a Canvas profile avatar without credentials.
    pub fn download_avatar(&self, url: &str) -> Result<DownloadedBody, DownloadError> {
        let body = self.download(url, DownloadKind::Avatar)?;
        let content_type = body
            .content_type
            .as_deref()
            .and_then(normalized_image_type)
            .ok_or(DownloadError::InvalidAvatar)?;
        if !image_signature_matches(&body.bytes, content_type) {
            return Err(DownloadError::InvalidAvatar);
        }
        Ok(body)
    }

    fn download(&self, raw_url: &str, kind: DownloadKind) -> Result<DownloadedBody, DownloadError> {
        let _guard = self
            .request_gate
            .lock()
            .map_err(|_| DownloadError::ConcurrencyLockPoisoned)?;
        let mut current = Url::parse(raw_url).map_err(|_| DownloadError::InvalidUrl)?;
        self.validate_url(&current, kind)?;

        for redirect_hops in 0..=MAX_REDIRECT_HOPS {
            let response = self.fetch_hop(&current, kind)?;
            let status = response.status();
            if status.is_redirection() {
                if redirect_hops == MAX_REDIRECT_HOPS {
                    return Err(DownloadError::TooManyRedirects);
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or(DownloadError::RedirectRefused)?;
                current = current
                    .join(location)
                    .map_err(|_| DownloadError::RedirectRefused)?;
                self.validate_url(&current, kind)?;
                continue;
            }
            if !status.is_success() {
                return Err(DownloadError::HttpStatus(status.as_u16()));
            }

            let content_type = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let content_disposition = response
                .headers()
                .get(CONTENT_DISPOSITION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let bytes = read_response_bounded(response, kind.max_bytes())?;
            return Ok(DownloadedBody {
                status: status.as_u16(),
                bytes,
                content_type,
                content_disposition,
            });
        }
        Err(DownloadError::TooManyRedirects)
    }

    fn validate_url(&self, url: &Url, kind: DownloadKind) -> Result<(), DownloadError> {
        if url.username().len() > 0 || url.password().is_some() || url.fragment().is_some() {
            return Err(DownloadError::InvalidUrl);
        }
        #[cfg(feature = "test-overrides")]
        if let Some(origin) = &self.test_origin {
            if !same_origin(url, origin) || url.scheme() != "http" {
                return Err(DownloadError::InvalidUrl);
            }
            return Ok(());
        }
        #[cfg(not(feature = "test-overrides"))]
        let _ = kind;

        if url.scheme() != "https"
            || url.port().is_some()
            || url.host_str().is_none_or(is_ip_address)
            || !is_reviewed_download_host(url.host_str().unwrap_or_default(), kind)
        {
            return Err(DownloadError::InvalidUrl);
        }
        Ok(())
    }

    fn fetch_hop(&self, url: &Url, kind: DownloadKind) -> Result<Response, DownloadError> {
        let mut last_error = DownloadError::RequestFailed;
        for attempt in 0..REQUEST_ATTEMPTS {
            // Intentionally no Authorization header: file verifier URLs and avatar URLs are
            // separate unauthenticated requests, including on validated redirect hops.
            let response = self
                .client
                .get(url.clone())
                .header(ACCEPT, kind.accept())
                .send();
            let response = match response {
                Ok(response) => response,
                Err(_) => {
                    last_error = DownloadError::RequestFailed;
                    if attempt + 1 < REQUEST_ATTEMPTS {
                        retry_pause();
                        continue;
                    }
                    return Err(last_error);
                }
            };
            if is_retryable_status(response.status()) {
                last_error = DownloadError::HttpStatus(response.status().as_u16());
                if attempt + 1 < REQUEST_ATTEMPTS {
                    retry_pause();
                    continue;
                }
                return Err(last_error);
            }
            return Ok(response);
        }
        Err(last_error)
    }
}

#[derive(Clone, Copy)]
enum DownloadKind {
    File,
    Avatar,
}

impl DownloadKind {
    fn max_bytes(self) -> u64 {
        match self {
            DownloadKind::File => MAX_FILE_BYTES,
            DownloadKind::Avatar => MAX_AVATAR_BYTES,
        }
    }

    fn accept(self) -> &'static str {
        match self {
            DownloadKind::File => "application/octet-stream, application/pdf, */*",
            DownloadKind::Avatar => "image/jpeg,image/png,image/webp,image/gif",
        }
    }
}

fn is_reviewed_download_host(host: &str, kind: DownloadKind) -> bool {
    let host = host.to_ascii_lowercase();
    let canvas = host == "marymount.instructure.com"
        || host.ends_with(".instructure.com")
        || host == "instructureusercontent.com"
        || host.ends_with(".instructureusercontent.com")
        || host.ends_with(".inscloudgate.net");
    canvas
        || matches!(kind, DownloadKind::Avatar)
            && (host == "gravatar.com" || host.ends_with(".gravatar.com"))
}

fn parse_test_origin(origin: &str) -> Result<Url, DownloadError> {
    let parsed = Url::parse(origin).map_err(|_| DownloadError::InvalidUrl)?;
    let host = parsed.host_str().ok_or(DownloadError::InvalidUrl)?;
    let ip = IpAddr::from_str(host).map_err(|_| DownloadError::InvalidUrl)?;
    if parsed.scheme() != "http"
        || !ip.is_loopback()
        || parsed.port().is_none()
        || parsed.username().len() > 0
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(DownloadError::InvalidUrl);
    }
    Ok(parsed)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
        && left.username().is_empty()
        && left.password().is_none()
}

fn is_ip_address(host: &str) -> bool {
    IpAddr::from_str(host).is_ok()
}

fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

fn retry_pause() {
    thread::sleep(Duration::from_millis(100));
}

fn read_response_bounded(mut response: Response, max_bytes: u64) -> Result<Vec<u8>, DownloadError> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > max_bytes)
    {
        return Err(DownloadError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| DownloadError::RequestFailed)?;
    if bytes.len() as u64 > max_bytes {
        return Err(DownloadError::ResponseTooLarge);
    }
    Ok(bytes)
}

fn normalized_image_type(value: &str) -> Option<&'static str> {
    let normalized = value.split(';').next()?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "image/jpeg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        _ => None,
    }
}

fn image_signature_matches(bytes: &[u8], content_type: &str) -> bool {
    match content_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_reviewed_host_patterns_are_enforced() {
        assert!(is_reviewed_download_host(
            "marymount.instructure.com",
            DownloadKind::File
        ));
        assert!(is_reviewed_download_host(
            "files.instructureusercontent.com",
            DownloadKind::File
        ));
        assert!(is_reviewed_download_host(
            "inst-fs-iad-prod.inscloudgate.net",
            DownloadKind::File
        ));
        assert!(!is_reviewed_download_host(
            "inscloudgate.net.evil.invalid",
            DownloadKind::File
        ));
        assert!(!is_reviewed_download_host(
            "evil.invalid",
            DownloadKind::File
        ));
        assert!(!is_reviewed_download_host(
            "gravatar.com",
            DownloadKind::File
        ));
        assert!(is_reviewed_download_host(
            "secure.gravatar.com",
            DownloadKind::Avatar
        ));
        assert!(!is_reviewed_download_host(
            "gravatar.com.evil.invalid",
            DownloadKind::Avatar
        ));
    }

    #[test]
    fn avatar_requires_matching_image_type_and_signature() {
        assert_eq!(
            normalized_image_type("image/png; charset=binary"),
            Some("image/png")
        );
        assert!(image_signature_matches(
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
            "image/png"
        ));
        assert!(!image_signature_matches(b"not an image", "image/png"));
        assert!(!image_signature_matches(b"GIF89a", "image/png"));
        assert_eq!(normalized_image_type("text/html"), None);
    }

    #[cfg(feature = "test-overrides")]
    #[test]
    fn test_origin_is_loopback_and_explicitly_ported() {
        assert!(parse_test_origin("http://127.0.0.1:8011").is_ok());
        assert!(parse_test_origin("http://10.0.0.2:8011").is_err());
        assert!(parse_test_origin("https://127.0.0.1:8011").is_err());
        assert!(parse_test_origin("http://127.0.0.1").is_err());
    }

    #[cfg(feature = "test-overrides")]
    #[test]
    fn avatar_redirects_are_manual_and_never_send_authorization() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::sync::mpsc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let redirect = format!("{origin}/avatar-final");
        let (tx, rx) = mpsc::channel();
        let server = thread::spawn(move || {
            for (status, headers, body) in [
                (
                    "302 Found",
                    format!("Location: {redirect}\r\n"),
                    "".as_bytes(),
                ),
                (
                    "200 OK",
                    "Content-Type: image/png\r\n".to_owned(),
                    &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a][..],
                ),
            ] {
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
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            }
        });

        let client = DownloadClient::with_test_origin(&origin).unwrap();
        let result = client.download_avatar(&format!("{origin}/avatar")).unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.bytes.len(), 8);
        let first = rx.recv().unwrap();
        let second = rx.recv().unwrap();
        assert!(!first.to_ascii_lowercase().contains("authorization:"));
        assert!(!second.to_ascii_lowercase().contains("authorization:"));
        server.join().unwrap();
    }

    #[cfg(feature = "test-overrides")]
    #[test]
    fn download_redirect_outside_mock_origin_is_rejected_before_following() {
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
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: https://evil.invalid/file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });

        let client = DownloadClient::with_test_origin(&origin).unwrap();
        assert_eq!(
            client
                .download_file(&format!("{origin}/file"))
                .err()
                .unwrap(),
            DownloadError::InvalidUrl
        );
        assert!(!rx
            .recv()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
        server.join().unwrap();
    }
}
