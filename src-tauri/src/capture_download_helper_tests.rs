#![cfg(feature = "test-overrides")]

use super::*;
use crate::capture_archive::StagingDirectory;
use crate::testutil::TempRoot;
use sha2::Digest;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};

fn mock_server(responses: Vec<(String, Vec<u8>)>) -> (String, Receiver<String>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    let server = thread::spawn(move || {
        for (headers, body) in responses {
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
                "HTTP/1.1 {headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    (origin, rx, server)
}

fn staging(label: &str) -> (TempRoot, StagingDirectory) {
    let root = TempRoot::new(label);
    let path = root.path().join("staging");
    crate::store::create_private_dir(&path, false).unwrap();
    (root, StagingDirectory::open(&path).unwrap())
}

#[test]
fn download_error_codes_are_fixed_and_do_not_include_response_details() {
    let errors = [
        downloads::DownloadError::InvalidUrl,
        downloads::DownloadError::RedirectRefused,
        downloads::DownloadError::TooManyRedirects,
        downloads::DownloadError::ResponseTooLarge,
        downloads::DownloadError::InvalidAvatar,
        downloads::DownloadError::RequestFailed,
        downloads::DownloadError::HttpStatus(403),
        downloads::DownloadError::ConcurrencyLockPoisoned,
        downloads::DownloadError::SignInResponse,
        downloads::DownloadError::MimeSignatureMismatch,
        downloads::DownloadError::SizeMismatch,
        downloads::DownloadError::UnsafeStagingDirectory,
        downloads::DownloadError::StagingFailed,
    ];
    for error in errors {
        let code = error.code();
        assert!(!code.is_empty());
        assert!(code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-'));
        assert!(!code.contains("403"));
    }
    assert_eq!(
        downloads::DownloadError::HttpStatus(403).code(),
        "http-status"
    );
}

#[test]
fn downloads_request_protocol_accepts_legacy_and_browser_redirect_shapes() {
    let legacy: CaptureDownloadRequest = serde_json::from_str(
        r#"{"fileId":41,"verifierUrl":"https://files.instructureusercontent.com/synthetic","stagingDirectory":"/tmp/staging"}"#,
    )
    .unwrap();
    assert_eq!(
        legacy.verifier_url.as_deref(),
        Some("https://files.instructureusercontent.com/synthetic")
    );
    assert!(legacy.browser_source_url.is_none());

    let browser: CaptureDownloadRequest = serde_json::from_str(
        r#"{"fileId":41,"browserSourceUrl":"https://marymount.instructure.com/files/41/download?download_frd=1","browserLocationUrl":"https://files.instructureusercontent.com/synthetic","stagingDirectory":"/tmp/staging"}"#,
    )
    .unwrap();
    assert!(browser.verifier_url.is_none());
    assert!(browser.browser_source_url.is_some());
    assert!(browser.browser_location_url.is_some());
    assert!(browser.browser_staged_path.is_none());

    let browser_body: CaptureDownloadRequest = serde_json::from_str(
        r#"{"fileId":41,"browserStagedPath":"/tmp/staging/.duegood-browser-550e8400-e29b-41d4-a716-446655440000.part","browserByteCount":18,"browserContentType":"application/pdf","stagingDirectory":"/tmp/staging"}"#,
    )
    .unwrap();
    assert!(browser_body.verifier_url.is_none());
    assert!(browser_body.browser_source_url.is_none());
    assert!(browser_body.browser_location_url.is_none());
    assert!(browser_body.browser_staged_path.is_some());
    assert_eq!(browser_body.browser_byte_count, Some(18));
    assert_eq!(
        browser_body.browser_content_type.as_deref(),
        Some("application/pdf")
    );
}

fn write_browser_stage(
    staging_path: &std::path::Path,
    id: &str,
    bytes: &[u8],
) -> std::path::PathBuf {
    let path = staging_path.join(format!(".duegood-browser-{id}.part"));
    let mut file = crate::store::create_private_file(&path).unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    path
}

#[test]
fn adopts_browser_staged_file_into_opaque_native_blob() {
    let pdf = b"%PDF-1.7\nsynthetic";
    let (root, staging) = staging("capture-browser-stage-adopt");
    let source_id = "550e8400-e29b-41d4-a716-446655440000";
    let source_path = write_browser_stage(root.path().join("staging").as_path(), source_id, pdf);
    let client = downloads::DownloadClient::with_test_origin("http://127.0.0.1:9").unwrap();
    let adopted = client
        .adopt_browser_staged_file(
            &source_path,
            41,
            pdf.len() as u64,
            Some(pdf.len() as u64),
            Some("application/pdf"),
            &staging,
        )
        .unwrap();

    assert_eq!(adopted.file_id, 41);
    assert_eq!(adopted.content_type, "application/pdf");
    assert_eq!(adopted.blob.byte_count, pdf.len() as u64);
    assert_eq!(
        adopted.blob.sha256,
        format!("{:x}", sha2::Sha256::digest(pdf))
    );
    assert!(adopted.blob.basename.ends_with(".blob"));
    assert!(!adopted.blob.basename.contains(source_id));
    assert!(!source_path.exists());
    assert_eq!(
        std::fs::read(root.path().join("staging").join(adopted.blob.basename)).unwrap(),
        pdf
    );
}

#[test]
fn browser_stage_adoption_rejects_symlinks_public_modes_and_foreign_directories() {
    let pdf = b"%PDF-1.7\nsynthetic";
    let client = downloads::DownloadClient::with_test_origin("http://127.0.0.1:9").unwrap();
    let (root, staging) = staging("capture-browser-stage-reject");
    let staging_path = root.path().join("staging");
    let source_id = "550e8400-e29b-41d4-a716-446655440000";
    let source_path = write_browser_stage(&staging_path, source_id, pdf);

    let alias = staging_path.join(".duegood-browser-550e8400-e29b-41d4-a716-446655440001.part");
    std::os::unix::fs::symlink(&source_path, &alias).unwrap();
    assert_eq!(
        client
            .adopt_browser_staged_file(&alias, 41, pdf.len() as u64, None, None, &staging)
            .err(),
        Some(downloads::DownloadError::UnsafeStagingDirectory)
    );
    std::fs::remove_file(&alias).unwrap();

    let outside = root.path().join("outside");
    crate::store::create_private_dir(&outside, false).unwrap();
    let foreign = write_browser_stage(&outside, "550e8400-e29b-41d4-a716-446655440002", pdf);
    assert_eq!(
        client
            .adopt_browser_staged_file(&foreign, 41, pdf.len() as u64, None, None, &staging)
            .err(),
        Some(downloads::DownloadError::UnsafeStagingDirectory)
    );

    let arbitrary = staging_path.join("student-document.pdf");
    let mut arbitrary_file = crate::store::create_private_file(&arbitrary).unwrap();
    arbitrary_file.write_all(pdf).unwrap();
    assert_eq!(
        client
            .adopt_browser_staged_file(&arbitrary, 41, pdf.len() as u64, None, None, &staging)
            .err(),
        Some(downloads::DownloadError::UnsafeStagingDirectory)
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&source_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            client
                .adopt_browser_staged_file(&source_path, 41, pdf.len() as u64, None, None, &staging)
                .err(),
            Some(downloads::DownloadError::UnsafeStagingDirectory)
        );
    }
}

#[test]
fn browser_stage_adoption_checks_lengths_and_sniffed_mime_before_publishing() {
    let pdf = b"%PDF-1.7\nsynthetic";
    let client = downloads::DownloadClient::with_test_origin("http://127.0.0.1:9").unwrap();
    let (root, staging) = staging("capture-browser-stage-validation");
    let staging_path = root.path().join("staging");
    let source_path =
        write_browser_stage(&staging_path, "550e8400-e29b-41d4-a716-446655440003", pdf);
    assert_eq!(
        client
            .adopt_browser_staged_file(&source_path, 41, pdf.len() as u64 + 1, None, None, &staging)
            .err(),
        Some(downloads::DownloadError::SizeMismatch)
    );
    assert_eq!(
        client
            .adopt_browser_staged_file(
                &source_path,
                41,
                pdf.len() as u64,
                None,
                Some("image/png"),
                &staging,
            )
            .err(),
        Some(downloads::DownloadError::MimeSignatureMismatch)
    );
    assert_eq!(std::fs::read_dir(&staging_path).unwrap().count(), 1);
}

#[test]
fn browser_location_downloads_staged_bytes_without_credentials() {
    let pdf = b"%PDF-1.7\nsynthetic";
    let (origin, requests, server) = mock_server(vec![
        ("302 Found\r\nLocation: /signed\r\n".into(), Vec::new()),
        (
            "200 OK\r\nContent-Type: application/pdf\r\n".into(),
            pdf.to_vec(),
        ),
    ]);
    let client = downloads::DownloadClient::with_test_origin(&origin).unwrap();
    let (root, staging) = staging("capture-download");
    let source = format!("{origin}/files/41/download?download_frd=1");
    let receipt = client
        .download_file_to_staging_from_browser_location(
            &source,
            &format!("{origin}/first"),
            41,
            Some(pdf.len() as u64),
            &staging,
        )
        .unwrap();
    assert_eq!(receipt.blob.byte_count, pdf.len() as u64);
    assert_eq!(receipt.content_type, "application/pdf");
    assert_eq!(
        receipt.blob.sha256,
        format!("{:x}", sha2::Sha256::digest(pdf))
    );
    assert_eq!(
        std::fs::read(root.path().join("staging").join(receipt.blob.basename)).unwrap(),
        pdf
    );
    for request in [requests.recv().unwrap(), requests.recv().unwrap()] {
        let request = request.to_ascii_lowercase();
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("cookie:"));
    }
    server.join().unwrap();
}

#[test]
fn browser_location_downloads_reject_unsafe_redirect_before_following() {
    let (origin, requests, server) = mock_server(vec![(
        "302 Found\r\nLocation: https://evil.invalid/file\r\n".into(),
        Vec::new(),
    )]);
    let client = downloads::DownloadClient::with_test_origin(&origin).unwrap();
    let (_root, staging) = staging("capture-redirect");
    let source = format!("{origin}/files/41/download?download_frd=1");
    assert_eq!(
        client
            .download_file_to_staging_from_browser_location(
                &source,
                &format!("{origin}/first"),
                41,
                None,
                &staging,
            )
            .err(),
        Some(downloads::DownloadError::InvalidUrl)
    );
    let request = requests.recv().unwrap().to_ascii_lowercase();
    assert!(!request.contains("authorization:"));
    assert!(!request.contains("cookie:"));
    server.join().unwrap();
}
