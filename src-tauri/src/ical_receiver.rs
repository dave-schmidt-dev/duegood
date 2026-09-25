//! One-shot loopback endpoint for the fixed BWS Canvas iCal helper.
//!
//! The receiver binds before starting the broker, accepts one bounded calendar POST, and passes
//! only the request bytes to its caller. The feed URL stays inside the pinned BWS consumer.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const IMPORT_ADDR: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 2137);
const IMPORT_ORIGIN: &str = "http://127.0.0.1:2137";
const IMPORT_PATH: &str = "/api/local/ical-import";
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_HEADER_COUNT: usize = 32;
// The helper fetches with a 15-second deadline; the remaining 10 seconds cover broker startup,
// the local POST, and this receiver's bounded wait for the helper to exit.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(25);
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const SOCKET_POLL: Duration = Duration::from_millis(20);
const SOCKET_READ_SLICE: Duration = Duration::from_secs(2);

/// Content-free iCal receiver failure. No feed bytes, URL, or secret are retained here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IcalReceiverError {
    AlreadyRunning,
    BrokerUnavailable,
    HelperFailed,
    TimedOut,
    RequestRejected,
    ImportRejected,
}

impl std::fmt::Display for IcalReceiverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::AlreadyRunning => "the iCal receiver is already in use",
            Self::BrokerUnavailable => "the iCal credential broker is unavailable",
            Self::HelperFailed => "the iCal helper failed",
            Self::TimedOut => "the iCal import timed out",
            Self::RequestRejected => "the iCal request was rejected",
            Self::ImportRejected => "the iCal import was rejected",
        })
    }
}

impl std::error::Error for IcalReceiverError {}

/// Content-free phase updates for the Tauri progress channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IcalImportPhase {
    BrokerStarting,
    WaitingForCalendar,
    Importing,
    Completed,
}

/// Starts the fixed BWS consumer and imports one request through `callback`.
///
/// The listener is acquired before launching the broker, so an occupied port never starts a
/// second secret-consuming helper. The callback receives at most 5 MiB only after the helper
/// exits successfully, and must not retain or log the raw feed.
pub fn run_ical_import<P, F>(mut progress: P, callback: F) -> Result<(), IcalReceiverError>
where
    P: FnMut(IcalImportPhase),
    F: FnOnce(&[u8]) -> Result<(), ()>,
{
    let broker = crate::config::bws_secret_exec_path()
        .filter(|path| is_executable_file(path))
        .ok_or(IcalReceiverError::BrokerUnavailable)?;
    let receiver = Receiver::bind(IMPORT_ADDR, DEFAULT_TIMEOUT)?;
    let launch = receiver.launch_input();
    progress(IcalImportPhase::BrokerStarting);
    let mut child = spawn_bws_helper(&broker, &launch)?;
    progress(IcalImportPhase::WaitingForCalendar);

    let mut body = None;
    let received = receiver.receive_once(&mut child, &mut progress, |bytes| {
        body = Some(bytes.to_vec());
        Ok(())
    });
    if received.is_err() {
        terminate_child(&mut child);
        if let Some(mut bytes) = body {
            bytes.fill(0);
        }
        return received;
    }
    let helper_result = wait_for_child(&mut child);
    let mut body = body.ok_or(IcalReceiverError::RequestRejected)?;
    finish_import(&mut body, helper_result, callback)?;
    progress(IcalImportPhase::Completed);
    Ok(())
}

fn finish_import<F>(
    body: &mut [u8],
    helper_result: Result<(), IcalReceiverError>,
    callback: F,
) -> Result<(), IcalReceiverError>
where
    F: FnOnce(&[u8]) -> Result<(), ()>,
{
    let result =
        helper_result.and_then(|()| callback(body).map_err(|_| IcalReceiverError::ImportRejected));
    body.fill(0);
    result
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn spawn_bws_helper(broker: &Path, launch: &[u8]) -> Result<Child, IcalReceiverError> {
    let mut child = Command::new(broker)
        .arg("duegood-canvas-ical")
        .arg("--")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| IcalReceiverError::BrokerUnavailable)?;
    let write_result = child
        .stdin
        .take()
        .ok_or(IcalReceiverError::BrokerUnavailable)
        .and_then(|mut input| {
            input
                .write_all(launch)
                .map_err(|_| IcalReceiverError::BrokerUnavailable)
        });
    if write_result.is_err() {
        terminate_child(&mut child);
        return Err(IcalReceiverError::BrokerUnavailable);
    }
    Ok(child)
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_for_child(child: &mut Child) -> Result<(), IcalReceiverError> {
    let deadline = Instant::now() + CHILD_EXIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(IcalReceiverError::HelperFailed),
            Err(_) => {
                terminate_child(child);
                return Err(IcalReceiverError::HelperFailed);
            }
            Ok(None) if Instant::now() >= deadline => {
                terminate_child(child);
                return Err(IcalReceiverError::TimedOut);
            }
            Ok(None) => thread::sleep(SOCKET_POLL),
        }
    }
}

struct Receiver {
    listener: TcpListener,
    token: String,
    deadline: Instant,
}

impl Receiver {
    fn bind(address: SocketAddr, timeout: Duration) -> Result<Self, IcalReceiverError> {
        let listener = TcpListener::bind(address).map_err(|_| IcalReceiverError::AlreadyRunning)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| IcalReceiverError::AlreadyRunning)?;
        Ok(Self {
            listener,
            token: uuid::Uuid::new_v4().to_string(),
            deadline: Instant::now() + timeout,
        })
    }

    fn launch_input(&self) -> Vec<u8> {
        format!(
            "{{\"origin\":\"{IMPORT_ORIGIN}\",\"csrfToken\":\"{}\"}}",
            self.token
        )
        .into_bytes()
    }

    fn receive_once<P, F>(
        &self,
        child: &mut Child,
        progress: &mut P,
        callback: F,
    ) -> Result<(), IcalReceiverError>
    where
        P: FnMut(IcalImportPhase),
        F: FnOnce(&[u8]) -> Result<(), ()>,
    {
        let mut callback = Some(callback);
        let mut next_heartbeat = Instant::now() + Duration::from_secs(1);
        loop {
            if Instant::now() >= self.deadline {
                return Err(IcalReceiverError::TimedOut);
            }
            if Instant::now() >= next_heartbeat {
                progress(IcalImportPhase::WaitingForCalendar);
                next_heartbeat = Instant::now() + Duration::from_secs(1);
            }
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => return Err(IcalReceiverError::HelperFailed),
                Ok(None) => {}
            }
            match self.listener.accept() {
                Ok((stream, peer)) => {
                    if !peer.ip().is_loopback() {
                        write_response(&stream, 403);
                        continue;
                    }
                    let mut stream = stream;
                    match handle_connection(&mut stream, &self.token, self.deadline) {
                        Ok(mut body) => {
                            progress(IcalImportPhase::Importing);
                            let imported = callback.take().is_some_and(|run| run(&body).is_ok());
                            body.fill(0);
                            write_response(&stream, if imported { 200 } else { 500 });
                            if imported {
                                return Ok(());
                            }
                            return Err(IcalReceiverError::ImportRejected);
                        }
                        Err(rejection) => {
                            // Rejections do not consume the one-shot receiver; the helper may retry.
                            write_response(&stream, rejection.status());
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(
                        SOCKET_POLL.min(self.deadline.saturating_duration_since(Instant::now())),
                    );
                }
                Err(_) => return Err(IcalReceiverError::RequestRejected),
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rejection {
    BadRequest,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    PayloadTooLarge,
    HeaderTooLarge,
    TimedOut,
}

impl Rejection {
    fn status(self) -> u16 {
        match self {
            Self::BadRequest | Self::TimedOut => 400,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
            Self::PayloadTooLarge => 413,
            Self::HeaderTooLarge => 431,
        }
    }
}

fn handle_connection(
    stream: &mut TcpStream,
    expected_token: &str,
    deadline: Instant,
) -> Result<Vec<u8>, Rejection> {
    let mut reader = BufReader::new(stream);
    let request_line = read_capped_line(&mut reader, 2_048, deadline)?;
    let request_line = strip_crlf(&request_line).ok_or(Rejection::BadRequest)?;
    let mut pieces = request_line.split(|byte| *byte == b' ');
    let method = pieces.next().ok_or(Rejection::BadRequest)?;
    let target = pieces.next().ok_or(Rejection::BadRequest)?;
    let version = pieces.next().ok_or(Rejection::BadRequest)?;
    if pieces.next().is_some() || version != b"HTTP/1.1" {
        return Err(Rejection::BadRequest);
    }
    if method != b"POST" {
        return Err(Rejection::MethodNotAllowed);
    }
    if target != IMPORT_PATH.as_bytes() {
        return Err(Rejection::NotFound);
    }

    let mut total_header_bytes = request_line.len();
    let mut headers = std::collections::BTreeMap::<String, String>::new();
    loop {
        let line = read_capped_line(&mut reader, MAX_HEADER_BYTES, deadline)?;
        total_header_bytes = total_header_bytes.saturating_add(line.len());
        if total_header_bytes > MAX_HEADER_BYTES {
            return Err(Rejection::HeaderTooLarge);
        }
        let line = strip_crlf(&line).ok_or(Rejection::BadRequest)?;
        if line.is_empty() {
            break;
        }
        if headers.len() >= MAX_HEADER_COUNT {
            return Err(Rejection::HeaderTooLarge);
        }
        let colon = line
            .iter()
            .position(|byte| *byte == b':')
            .ok_or(Rejection::BadRequest)?;
        let name = &line[..colon];
        if name.is_empty()
            || !name
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            return Err(Rejection::BadRequest);
        }
        let name = std::str::from_utf8(name)
            .map_err(|_| Rejection::BadRequest)?
            .to_ascii_lowercase();
        let value = trim_ascii(&line[colon + 1..]);
        if value
            .iter()
            .any(|byte| *byte < 0x20 && *byte != b'\t' || *byte > 0x7e)
        {
            return Err(Rejection::BadRequest);
        }
        let value = std::str::from_utf8(value)
            .map_err(|_| Rejection::BadRequest)?
            .to_owned();
        if headers.insert(name, value).is_some() {
            return Err(Rejection::BadRequest);
        }
    }

    if headers.get("host").map(String::as_str) != Some("127.0.0.1:2137") {
        return Err(Rejection::Forbidden);
    }
    if headers
        .get("origin")
        .is_some_and(|origin| origin != IMPORT_ORIGIN)
    {
        return Err(Rejection::Forbidden);
    }
    if !headers
        .get("x-duegood-csrf-token")
        .is_some_and(|token| constant_time_eq(token.as_bytes(), expected_token.as_bytes()))
    {
        return Err(Rejection::Forbidden);
    }
    if headers.contains_key("content-encoding") || headers.contains_key("transfer-encoding") {
        return Err(Rejection::BadRequest);
    }
    let content_type = headers
        .get("content-type")
        .map(String::as_str)
        .unwrap_or("");
    if !content_type.eq_ignore_ascii_case("text/calendar")
        && !content_type.eq_ignore_ascii_case("text/calendar; charset=utf-8")
    {
        return Err(Rejection::BadRequest);
    }
    let length = headers
        .get("content-length")
        .ok_or(Rejection::BadRequest)?
        .parse::<usize>()
        .map_err(|_| Rejection::BadRequest)?;
    if length == 0 {
        return Err(Rejection::BadRequest);
    }
    if length > MAX_BODY_BYTES {
        return Err(Rejection::PayloadTooLarge);
    }
    let body = read_exact_bounded(&mut reader, length, deadline)?;
    Ok(body)
}

fn read_capped_line(
    reader: &mut BufReader<&mut TcpStream>,
    maximum: usize,
    deadline: Instant,
) -> Result<Vec<u8>, Rejection> {
    let mut output = Vec::new();
    loop {
        set_read_slice(reader.get_ref(), deadline)?;
        let available = reader.fill_buf().map_err(map_read_error)?;
        if available.is_empty() {
            return Err(Rejection::BadRequest);
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |i| i + 1);
        if output.len().saturating_add(count) > maximum {
            return Err(Rejection::HeaderTooLarge);
        }
        let complete = available.get(count - 1) == Some(&b'\n');
        output.extend_from_slice(&available[..count]);
        reader.consume(count);
        if complete {
            return Ok(output);
        }
    }
}

fn read_exact_bounded(
    reader: &mut BufReader<&mut TcpStream>,
    length: usize,
    deadline: Instant,
) -> Result<Vec<u8>, Rejection> {
    let mut body = vec![0; length];
    let mut offset = 0;
    while offset < length {
        set_read_slice(reader.get_ref(), deadline)?;
        let count = reader.read(&mut body[offset..]).map_err(map_read_error)?;
        if count == 0 {
            return Err(Rejection::BadRequest);
        }
        offset += count;
    }
    Ok(body)
}

fn set_read_slice(stream: &TcpStream, deadline: Instant) -> Result<(), Rejection> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(Rejection::TimedOut);
    }
    stream
        .set_read_timeout(Some(remaining.min(SOCKET_READ_SLICE)))
        .map_err(|_| Rejection::BadRequest)
}

fn map_read_error(error: io::Error) -> Rejection {
    if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) {
        Rejection::TimedOut
    } else {
        Rejection::BadRequest
    }
}

fn strip_crlf(line: &[u8]) -> Option<&[u8]> {
    line.strip_suffix(b"\r\n")
}

fn trim_ascii(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(u8::is_ascii_whitespace) {
        value = &value[1..];
    }
    while value.last().is_some_and(u8::is_ascii_whitespace) {
        value = &value[..value.len() - 1];
    }
    value
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn write_response(stream: &TcpStream, status: u16) {
    let mut stream = stream;
    let (label, body) = match status {
        200 => ("OK", "ok"),
        400 => ("Bad Request", "rejected"),
        403 => ("Forbidden", "rejected"),
        404 => ("Not Found", "rejected"),
        405 => ("Method Not Allowed", "rejected"),
        413 => ("Payload Too Large", "rejected"),
        431 => ("Request Header Fields Too Large", "rejected"),
        _ => ("Internal Server Error", "rejected"),
    };
    let response = format!(
        "HTTP/1.1 {status} {label}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn test_receiver(timeout: Duration) -> (Receiver, SocketAddr) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        (
            Receiver {
                listener,
                token: uuid::Uuid::new_v4().to_string(),
                deadline: Instant::now() + timeout,
            },
            address,
        )
    }

    fn request(
        address: SocketAddr,
        origin: Option<&str>,
        token: &str,
        content_type: &str,
        length: usize,
        path: &str,
        method: &str,
    ) -> io::Result<TcpStream> {
        let mut stream = TcpStream::connect(address)?;
        let origin_header = origin.map_or(String::new(), |value| format!("Origin: {value}\r\n"));
        write!(stream,
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:2137\r\n{origin_header}X-DueGood-CSRF-Token: {token}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\n\r\n"
        )?;
        Ok(stream)
    }

    #[test]
    fn launch_contract_is_fixed_and_contains_only_origin_and_fresh_token() {
        let (receiver, _) = test_receiver(Duration::from_secs(1));
        let launch: serde_json::Value = serde_json::from_slice(&receiver.launch_input()).unwrap();
        assert_eq!(launch.as_object().unwrap().len(), 2);
        assert_eq!(launch["origin"], IMPORT_ORIGIN);
        let token = launch["csrfToken"].as_str().unwrap();
        assert!(token.len() >= 32);
        assert_ne!(token, "");
    }

    #[test]
    fn failed_helper_cannot_apply_a_received_calendar() {
        let mut body = b"private-calendar".to_vec();
        let mut called = false;
        let result = finish_import(&mut body, Err(IcalReceiverError::HelperFailed), |_| {
            called = true;
            Ok(())
        });
        assert_eq!(result, Err(IcalReceiverError::HelperFailed));
        assert!(!called);
        assert!(body.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn occupied_port_refuses_without_reusing_the_listener() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = occupied.local_addr().unwrap();
        assert_eq!(
            Receiver::bind(address, Duration::from_secs(1)).err(),
            Some(IcalReceiverError::AlreadyRunning)
        );
        assert!(occupied.local_addr().is_ok());
    }

    #[test]
    fn timeout_returns_without_accepting_a_request() {
        let (receiver, _) = test_receiver(Duration::from_millis(40));
        let mut child = Command::new("/bin/sleep").arg("1").spawn().unwrap();
        let mut progress = |_| {};
        let result =
            receiver.receive_once(&mut child, &mut progress, |_| panic!("no request expected"));
        terminate_child(&mut child);
        assert_eq!(result, Err(IcalReceiverError::TimedOut));
    }

    #[test]
    fn accepts_fixed_loopback_request_and_calls_import_once() {
        let (receiver, address) = test_receiver(Duration::from_secs(2));
        let token = receiver.token.clone();
        let worker = thread::spawn(move || {
            let mut child = Command::new("/bin/sleep").arg("10").spawn().unwrap();
            let mut progress = |_| {};
            let result = receiver.receive_once(&mut child, &mut progress, |bytes| {
                assert_eq!(bytes, b"abc");
                Ok(())
            });
            terminate_child(&mut child);
            result
        });
        let mut stream = request(
            address,
            None,
            &token,
            "text/calendar; charset=utf-8",
            3,
            IMPORT_PATH,
            "POST",
        )
        .unwrap();
        stream.write_all(b"abc").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(worker.join().unwrap(), Ok(()));
    }

    #[test]
    fn rejects_invalid_host_path_method_origin_token_type_and_oversize() {
        let good = format!("Host: 127.0.0.1:2137\r\nOrigin: {IMPORT_ORIGIN}\r\nX-DueGood-CSRF-Token: tok\r\nContent-Type: text/calendar\r\nContent-Length: 1\r\n\r\nx");
        assert_eq!(
            reject_request(&format!("GET {IMPORT_PATH} HTTP/1.1\r\n{good}")),
            Rejection::MethodNotAllowed
        );
        assert_eq!(
            reject_request(&format!("POST /wrong HTTP/1.1\r\n{good}")),
            Rejection::NotFound
        );
        assert_eq!(
            reject_request(&format!(
                "POST {IMPORT_PATH} HTTP/1.1\r\n{}",
                good.replace("127.0.0.1:2137", "localhost:2137")
            )),
            Rejection::Forbidden
        );
        assert_eq!(
            reject_request(&format!(
                "POST {IMPORT_PATH} HTTP/1.1\r\n{}",
                good.replace(IMPORT_ORIGIN, "http://localhost:2137")
            )),
            Rejection::Forbidden
        );
        assert_eq!(
            reject_request(&format!(
                "POST {IMPORT_PATH} HTTP/1.1\r\n{}",
                good.replace("tok", "wrong")
            )),
            Rejection::Forbidden
        );
        assert_eq!(
            reject_request(&format!(
                "POST {IMPORT_PATH} HTTP/1.1\r\n{}",
                good.replace("text/calendar", "application/octet-stream")
            )),
            Rejection::BadRequest
        );
        assert_eq!(
            reject_request(&format!(
                "POST {IMPORT_PATH} HTTP/1.1\r\n{}",
                good.replace(
                    "Content-Length: 1",
                    &format!("Content-Length: {}", MAX_BODY_BYTES + 1)
                )
            )),
            Rejection::PayloadTooLarge
        );
    }

    fn reject_request(request: &str) -> Rejection {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let request = request.as_bytes().to_vec();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(&request).unwrap();
            let _ = stream.shutdown(std::net::Shutdown::Write);
        });
        let (mut stream, _) = listener.accept().unwrap();
        let result = handle_connection(&mut stream, "tok", Instant::now() + Duration::from_secs(1));
        client.join().unwrap();
        result.unwrap_err()
    }
}
