//! Unauthenticated, bounded Canvas material and avatar downloads.
//!
//! Downloads use a separate HTTP client with automatic redirects disabled. Each redirect hop is
//! checked before a new request is sent, and no Authorization header is ever attached.

use std::fmt;
use std::io::{Read, Write};
use std::net::IpAddr;
use std::path::Path;
use std::str::FromStr;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::{StatusCode, Url};
use sha2::{Digest, Sha256};

use crate::capture_archive::{StagedBlob, StagingDirectory, StagingError};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const MAX_CAPTURE_FILE_BYTES: u64 =
    crate::config::ImportLimits::PRODUCTION.max_file_bytes;
const MAX_AVATAR_BYTES: u64 = 5 * 1024 * 1024;
const REQUEST_ATTEMPTS: usize = 2;
const MAX_REDIRECT_HOPS: usize = 3;
const SIGNATURE_PREFIX_BYTES: usize = 2048;

/// Downloaded bytes and the non-sensitive response metadata needed by the capture layer.
pub struct DownloadedBody {
    pub status: u16,
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
}

/// Content-free result for one verified file staged by the private capture helper.
pub struct StagedDownload {
    pub blob: StagedBlob,
    pub file_id: u64,
    pub content_type: &'static str,
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
    SignInResponse,
    MimeSignatureMismatch,
    SizeMismatch,
    UnsafeStagingDirectory,
    StagingFailed,
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
            DownloadError::SignInResponse => "sign-in-response",
            DownloadError::MimeSignatureMismatch => "mime-signature-mismatch",
            DownloadError::SizeMismatch => "size-mismatch",
            DownloadError::UnsafeStagingDirectory => "unsafe-staging-directory",
            DownloadError::StagingFailed => "staging-failed",
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

    /// Streams one Canvas file into private staging without retaining its complete body in memory.
    /// The caller supplies only the numeric Canvas file ID and optional metadata size; the verifier
    /// URL remains transient input and is never included in any returned value or error.
    pub fn download_file_to_staging(
        &self,
        url: &str,
        file_id: u64,
        expected_size: Option<u64>,
        staging: &StagingDirectory,
    ) -> Result<StagedDownload, DownloadError> {
        if expected_size.is_some_and(|size| size > MAX_CAPTURE_FILE_BYTES) {
            return Err(DownloadError::ResponseTooLarge);
        }
        self.validate_initial_file_url(url, file_id)?;
        self.stream_file_to_staging(url, file_id, expected_size, staging)
    }

    /// Streams a browser-observed Canvas download redirect without contacting the initial route.
    /// The source must be the exact file-ID-bound Marymount download URL, and the redirect target
    /// is checked with the same host policy used for every subsequent hop.
    pub fn download_file_to_staging_from_browser_location(
        &self,
        source_url: &str,
        location: &str,
        file_id: u64,
        expected_size: Option<u64>,
        staging: &StagingDirectory,
    ) -> Result<StagedDownload, DownloadError> {
        if expected_size.is_some_and(|size| size > MAX_CAPTURE_FILE_BYTES) {
            return Err(DownloadError::ResponseTooLarge);
        }
        let target = self.resolve_browser_location(source_url, location, file_id)?;
        self.stream_file_to_staging(target.as_str(), file_id, expected_size, staging)
    }

    /// Adopts an owner-only `.part` file produced by the authenticated browser transfer helper.
    /// The input path must be the exact random-name shape in the same private staging directory;
    /// only the opaque native destination basename is returned to the caller.
    pub fn adopt_browser_staged_file(
        &self,
        path: &Path,
        file_id: u64,
        browser_byte_count: u64,
        expected_size: Option<u64>,
        browser_content_type: Option<&str>,
        staging: &StagingDirectory,
    ) -> Result<StagedDownload, DownloadError> {
        if file_id == 0 {
            return Err(DownloadError::InvalidUrl);
        }
        if browser_byte_count == 0
            || browser_byte_count > MAX_CAPTURE_FILE_BYTES
            || expected_size.is_some_and(|size| size > MAX_CAPTURE_FILE_BYTES)
        {
            return Err(DownloadError::ResponseTooLarge);
        }
        if expected_size.is_some_and(|size| size != browser_byte_count) {
            return Err(DownloadError::SizeMismatch);
        }
        if browser_content_type.is_some_and(|value| value.len() > 256) {
            return Err(DownloadError::MimeSignatureMismatch);
        }
        let mut source = staging
            .open_browser_source(path)
            .map_err(map_staging_error)?;
        let metadata = source
            .file_mut()
            .metadata()
            .map_err(|_| DownloadError::UnsafeStagingDirectory)?;
        if metadata.len() != browser_byte_count {
            return Err(DownloadError::SizeMismatch);
        }

        let mut staged = staging.create_file().map_err(map_staging_error)?;
        let mut hasher = Sha256::new();
        let mut prefix = Vec::with_capacity(SIGNATURE_PREFIX_BYTES);
        let mut byte_count = 0_u64;
        let mut chunk = [0_u8; 8192];
        loop {
            let count = source
                .file_mut()
                .read(&mut chunk)
                .map_err(|_| DownloadError::StagingFailed)?;
            if count == 0 {
                break;
            }
            let next_count = byte_count
                .checked_add(count as u64)
                .ok_or(DownloadError::ResponseTooLarge)?;
            if next_count > MAX_CAPTURE_FILE_BYTES {
                return Err(DownloadError::ResponseTooLarge);
            }
            if next_count > browser_byte_count {
                return Err(DownloadError::SizeMismatch);
            }
            staged
                .file_mut()
                .map_err(map_staging_error)?
                .write_all(&chunk[..count])
                .map_err(|_| DownloadError::StagingFailed)?;
            hasher.update(&chunk[..count]);
            if prefix.len() < SIGNATURE_PREFIX_BYTES {
                let remaining = SIGNATURE_PREFIX_BYTES - prefix.len();
                prefix.extend_from_slice(&chunk[..count.min(remaining)]);
            }
            byte_count = next_count;
        }
        if byte_count != browser_byte_count || expected_size.is_some_and(|size| size != byte_count)
        {
            return Err(DownloadError::SizeMismatch);
        }
        let content_type = crate::capture_archive::verify_content_type(
            browser_content_type,
            &prefix,
        )
        .map_err(|error| match error {
            crate::capture_archive::MediaError::SignInResponse => DownloadError::SignInResponse,
            crate::capture_archive::MediaError::MimeSignatureMismatch => {
                DownloadError::MimeSignatureMismatch
            }
        })?;
        source
            .verify_unchanged(staging)
            .map_err(map_staging_error)?;
        let sha256 = format!("{:x}", hasher.finalize());
        let blob = staged
            .commit(byte_count, sha256)
            .map_err(map_staging_error)?;
        source.remove(staging).map_err(|error| {
            let _ = staging.remove_committed_blob(&blob.basename);
            map_staging_error(error)
        })?;
        Ok(StagedDownload {
            blob,
            file_id,
            content_type,
        })
    }

    fn stream_file_to_staging(
        &self,
        url: &str,
        file_id: u64,
        expected_size: Option<u64>,
        staging: &StagingDirectory,
    ) -> Result<StagedDownload, DownloadError> {
        let _guard = self
            .request_gate
            .lock()
            .map_err(|_| DownloadError::ConcurrencyLockPoisoned)?;
        let mut response = self.final_response(url, DownloadKind::File)?;
        let status = response.status();
        if status != StatusCode::OK {
            return Err(DownloadError::HttpStatus(status.as_u16()));
        }
        if response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > MAX_CAPTURE_FILE_BYTES)
        {
            return Err(DownloadError::ResponseTooLarge);
        }
        let response_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let mut staged = staging.create_file().map_err(map_staging_error)?;
        let mut hasher = Sha256::new();
        let mut byte_count = 0_u64;
        let mut prefix = Vec::with_capacity(SIGNATURE_PREFIX_BYTES);
        let mut chunk = [0_u8; 8192];
        loop {
            let count = response
                .read(&mut chunk)
                .map_err(|_| DownloadError::RequestFailed)?;
            if count == 0 {
                break;
            }
            let next_count = byte_count
                .checked_add(count as u64)
                .ok_or(DownloadError::ResponseTooLarge)?;
            if next_count > MAX_CAPTURE_FILE_BYTES {
                return Err(DownloadError::ResponseTooLarge);
            }
            staged
                .file_mut()
                .map_err(map_staging_error)?
                .write_all(&chunk[..count])
                .map_err(|_| DownloadError::StagingFailed)?;
            hasher.update(&chunk[..count]);
            if prefix.len() < SIGNATURE_PREFIX_BYTES {
                let remaining = SIGNATURE_PREFIX_BYTES - prefix.len();
                prefix.extend_from_slice(&chunk[..count.min(remaining)]);
            }
            byte_count = next_count;
        }
        if expected_size.is_some_and(|size| size != byte_count) {
            return Err(DownloadError::SizeMismatch);
        }
        let content_type =
            crate::capture_archive::verify_content_type(response_type.as_deref(), &prefix)
                .map_err(|error| match error {
                    crate::capture_archive::MediaError::SignInResponse => {
                        DownloadError::SignInResponse
                    }
                    crate::capture_archive::MediaError::MimeSignatureMismatch => {
                        DownloadError::MimeSignatureMismatch
                    }
                })?;
        let sha256 = format!("{:x}", hasher.finalize());
        let blob = staged
            .commit(byte_count, sha256)
            .map_err(map_staging_error)?;
        Ok(StagedDownload {
            blob,
            file_id,
            content_type,
        })
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
        let response = self.final_response(raw_url, kind)?;
        let status = response.status();
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
        Ok(DownloadedBody {
            status: status.as_u16(),
            bytes,
            content_type,
            content_disposition,
        })
    }

    fn final_response(&self, raw_url: &str, kind: DownloadKind) -> Result<Response, DownloadError> {
        let mut current = Url::parse(raw_url).map_err(|_| DownloadError::InvalidUrl)?;
        self.validate_url(&current, kind)?;
        for redirect_hops in 0..=MAX_REDIRECT_HOPS {
            let response = self.fetch_hop(&current, kind)?;
            if response.status().is_redirection() {
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
            return Ok(response);
        }
        Err(DownloadError::TooManyRedirects)
    }

    /// Validates the original Canvas verifier URL before opening any network connection. This is
    /// deliberately narrower than the redirect allowlist: only the Marymount file download route
    /// bound to the supplied numeric ID is accepted, followed by the existing reviewed CDN hops.
    fn validate_initial_file_url(&self, raw_url: &str, file_id: u64) -> Result<(), DownloadError> {
        let url = self.parse_canvas_file_url(raw_url, file_id)?;
        let mut verifier_seen = false;
        let mut download_frd_seen = false;
        for (name, value) in url.query_pairs() {
            match name.as_ref() {
                "verifier" => {
                    if verifier_seen
                        || value.is_empty()
                        || value.len() > 512
                        || value.chars().any(char::is_control)
                    {
                        return Err(DownloadError::InvalidUrl);
                    }
                    verifier_seen = true;
                }
                "download_frd" => {
                    if download_frd_seen || value != "1" {
                        return Err(DownloadError::InvalidUrl);
                    }
                    download_frd_seen = true;
                }
                _ => return Err(DownloadError::InvalidUrl),
            }
        }
        Ok(())
    }

    fn validate_browser_source_url(
        &self,
        raw_url: &str,
        file_id: u64,
    ) -> Result<Url, DownloadError> {
        let url = self.parse_canvas_file_url(raw_url, file_id)?;
        if url.query() != Some("download_frd=1") {
            return Err(DownloadError::InvalidUrl);
        }
        Ok(url)
    }

    fn resolve_browser_location(
        &self,
        source_url: &str,
        location: &str,
        file_id: u64,
    ) -> Result<Url, DownloadError> {
        let source = self.validate_browser_source_url(source_url, file_id)?;
        if location.is_empty() || location.len() > 16 * 1024 {
            return Err(DownloadError::InvalidUrl);
        }
        let target = source
            .join(location)
            .map_err(|_| DownloadError::InvalidUrl)?;
        self.validate_url(&target, DownloadKind::File)?;
        Ok(target)
    }

    fn parse_canvas_file_url(&self, raw_url: &str, file_id: u64) -> Result<Url, DownloadError> {
        if file_id == 0 || raw_url.len() > 16 * 1024 {
            return Err(DownloadError::InvalidUrl);
        }
        let url = Url::parse(raw_url).map_err(|_| DownloadError::InvalidUrl)?;
        let identity_ok = {
            #[cfg(feature = "test-overrides")]
            if let Some(origin) = &self.test_origin {
                same_origin(&url, origin) && url.scheme() == "http"
            } else {
                url.scheme() == "https"
                    && url.host_str() == Some("marymount.instructure.com")
                    && url.port().is_none()
            }
            #[cfg(not(feature = "test-overrides"))]
            {
                url.scheme() == "https"
                    && url.host_str() == Some("marymount.instructure.com")
                    && url.port().is_none()
            }
        };
        if !identity_ok
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.path() != format!("/files/{file_id}/download")
            || url.query() == Some("")
        {
            return Err(DownloadError::InvalidUrl);
        }
        Ok(url)
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
    let canvas_user_content = is_canvas_user_content_host(&host);
    let instructure_uploads = matches!(
        host.as_str(),
        "instructure-uploads.s3.amazonaws.com"
            | "instructure-uploads-2.s3.amazonaws.com"
            | "instructure-uploads-eu.s3.amazonaws.com"
            | "instructure-uploads-apse1.s3.amazonaws.com"
            | "instructure-uploads-apse2.s3.amazonaws.com"
            | "instructure-uploads-fra.s3.amazonaws.com"
            | "instructure-uploads-pdx.s3.amazonaws.com"
            | "instructure-uploads-yul.s3.amazonaws.com"
    );
    let canvas_file_storage =
        matches!(kind, DownloadKind::File) && (canvas_user_content || instructure_uploads);
    let canvas = host == "marymount.instructure.com"
        || host.ends_with(".instructure.com")
        || host == "instructureusercontent.com"
        || host.ends_with(".instructureusercontent.com")
        || host.ends_with(".inscloudgate.net")
        || canvas_file_storage;
    canvas
        || matches!(kind, DownloadKind::Avatar)
            && (host == "gravatar.com" || host.ends_with(".gravatar.com"))
}

fn is_canvas_user_content_host(host: &str) -> bool {
    let Some(subdomain) = host.strip_suffix(".canvas-user-content.com") else {
        return false;
    };
    let labels = subdomain.split('.').collect::<Vec<_>>();
    match labels.as_slice() {
        // Preserve the existing single-label file host allowlist.
        [label] => !label.is_empty(),
        // Canvas file redirects may use a source label followed by a numeric cluster label.
        [source, cluster] => {
            valid_dns_label(source)
                && cluster.len() <= 63
                && cluster.strip_prefix("cluster").is_some_and(|digits| {
                    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                })
        }
        _ => false,
    }
}

fn valid_dns_label(label: &str) -> bool {
    label.len() <= 63
        && label
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && label
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
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

fn map_staging_error(error: StagingError) -> DownloadError {
    match error {
        StagingError::UnsafeDirectory => DownloadError::UnsafeStagingDirectory,
        StagingError::CreateFailed | StagingError::WriteFailed => DownloadError::StagingFailed,
    }
}

/// Checks the response MIME against a small, reviewed set of file signatures. Unknown types are
/// refused as a file-coverage gap instead of being guessed from a filename supplied by Canvas.
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
#[path = "downloads_tests.rs"]
mod tests;
