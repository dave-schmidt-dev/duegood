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
    assert!(is_reviewed_download_host(
        "files.canvas-user-content.com",
        DownloadKind::File
    ));
    assert!(is_reviewed_download_host(
        "a5703-4238380.cluster367.canvas-user-content.com",
        DownloadKind::File
    ));
    for host in [
        "instructure-uploads.s3.amazonaws.com",
        "instructure-uploads-2.s3.amazonaws.com",
        "instructure-uploads-eu.s3.amazonaws.com",
        "instructure-uploads-apse1.s3.amazonaws.com",
        "instructure-uploads-apse2.s3.amazonaws.com",
        "instructure-uploads-fra.s3.amazonaws.com",
        "instructure-uploads-pdx.s3.amazonaws.com",
        "instructure-uploads-yul.s3.amazonaws.com",
    ] {
        assert!(
            is_reviewed_download_host(host, DownloadKind::File),
            "{host}"
        );
    }
    assert!(!is_reviewed_download_host(
        "instructure-uploads.s3.amazonaws.com",
        DownloadKind::Avatar
    ));
    assert!(!is_reviewed_download_host(
        "files.canvas-user-content.com",
        DownloadKind::Avatar
    ));
    assert!(!is_reviewed_download_host(
        "a5703-4238380.cluster367.canvas-user-content.com",
        DownloadKind::Avatar
    ));
    assert!(!is_reviewed_download_host(
        "inscloudgate.net.evil.invalid",
        DownloadKind::File
    ));
    for host in [
        "canvas-user-content.com",
        "files.canvas-user-content.com.evil.invalid",
        "nested.files.canvas-user-content.com",
        "a5703-4238380.cluster.canvas-user-content.com",
        "a5703-4238380.clusterx.canvas-user-content.com",
        "a5703-4238380.cluster367x.canvas-user-content.com",
        "a5703-4238380.cluster-367.canvas-user-content.com",
        "-bad.cluster367.canvas-user-content.com",
        "bad-.cluster367.canvas-user-content.com",
        "nested.a5703-4238380.cluster367.canvas-user-content.com",
        "a5703-4238380.cluster367.canvas-user-content.com.evil.invalid",
        "a5703-4238380.cluster367.canvas-user-content.co",
        "evil-instructure-uploads.s3.amazonaws.com",
        "instructure-uploads.s3.amazonaws.com.evil.invalid",
        "random-bucket.s3.amazonaws.com",
        "notorious-prod.s3.amazonaws.com",
    ] {
        assert!(
            !is_reviewed_download_host(host, DownloadKind::File),
            "{host}"
        );
    }
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
fn browser_source_is_bound_to_exact_marymount_file_route() {
    let client = DownloadClient::with_test_origin("http://127.0.0.1:8011").unwrap();
    assert!(client
        .validate_browser_source_url("http://127.0.0.1:8011/files/41/download?download_frd=1", 41)
        .is_ok());
    for (url, id) in [
        ("http://127.0.0.1:8011/files/42/download?download_frd=1", 41),
        ("http://evil.invalid/files/41/download?download_frd=1", 41),
        (
            "http://127.0.0.1:8011/files/41/download?download_frd=1&x=y",
            41,
        ),
    ] {
        assert_eq!(
            client.validate_browser_source_url(url, id).err(),
            Some(DownloadError::InvalidUrl)
        );
    }
    for location in [
        "https://evil.invalid/file",
        "http://127.0.0.1:8012/file",
        "https://127.0.0.1:8011/file",
    ] {
        assert_eq!(
            client
                .resolve_browser_location(
                    "http://127.0.0.1:8011/files/41/download?download_frd=1",
                    location,
                    41,
                )
                .err(),
            Some(DownloadError::InvalidUrl)
        );
    }
    assert!(client
        .validate_initial_file_url(
            "http://127.0.0.1:8011/files/41/download?download_frd=1&verifier=synthetic",
            41
        )
        .is_ok());
}

#[cfg(feature = "test-overrides")]
#[test]
fn avatar_redirects_are_manual_and_never_send_credentials() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let redirect = format!("{origin}/avatar-final");
    let (tx, rx) = mpsc::channel();
    let server = thread::spawn(move || {
        for (status, headers, body) in [
            ("302 Found", format!("Location: {redirect}\r\n"), &b""[..]),
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
    for request in [rx.recv().unwrap(), rx.recv().unwrap()] {
        let request = request.to_ascii_lowercase();
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("cookie:"));
    }
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
        write!(stream, "HTTP/1.1 302 Found\r\nLocation: https://evil.invalid/file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });

    let client = DownloadClient::with_test_origin(&origin).unwrap();
    assert_eq!(
        client.download_file(&format!("{origin}/file")).err(),
        Some(DownloadError::InvalidUrl)
    );
    let request = rx.recv().unwrap().to_ascii_lowercase();
    assert!(!request.contains("authorization:"));
    assert!(!request.contains("cookie:"));
    server.join().unwrap();
}
