//! MIME and prefix validation for downloaded Canvas files.

/// Content-free media validation failures returned to the downloader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaError {
    SignInResponse,
    MimeSignatureMismatch,
}

/// Checks known binary types against prefix signatures and declared text types for UTF-8 text in
/// the inspected prefix and non-HTML content. This does not validate full grammar or container
/// integrity, nor establish source authenticity.
pub fn verify_content_type(
    header: Option<&str>,
    prefix: &[u8],
) -> Result<&'static str, MediaError> {
    if prefix.is_empty() {
        return Err(MediaError::MimeSignatureMismatch);
    }
    if header
        .and_then(canonical_content_type)
        .is_some_and(|content_type| content_type == "text/html")
        || looks_like_html(prefix)
    {
        return Err(MediaError::SignInResponse);
    }

    let detected = sniff_content_type(prefix).ok_or(MediaError::MimeSignatureMismatch)?;
    let Some(raw_header) = header else {
        return Ok(detected);
    };
    let Some(content_type) = canonical_content_type(raw_header) else {
        return Err(MediaError::MimeSignatureMismatch);
    };
    if content_type == "application/octet-stream" {
        return Ok(detected);
    }
    if content_type == detected {
        return Ok(content_type);
    }
    if is_raster_image(content_type) && is_raster_image(detected) {
        return Ok(detected);
    }
    if is_text_type(content_type) && detected == "text/plain" {
        return Ok(content_type);
    }
    // SQL exports may contain only comments or client metadata, so their MIME is sufficient
    // once the body has passed the same valid UTF-8 text check as other text formats.
    if content_type == "application/sql" && detected == "text/plain" {
        return Ok(content_type);
    }
    // Office Open XML files are ZIP containers; retain their reviewed MIME when the ZIP signature
    // matches, while refusing every other signature.
    if is_office_open_xml(content_type) && detected == "application/zip" {
        return Ok(content_type);
    }
    // Legacy Office files use the OLE compound-document signature.
    if is_legacy_office(content_type) && detected == "application/x-ole-storage" {
        return Ok(content_type);
    }
    Err(MediaError::MimeSignatureMismatch)
}

/// Checks the response type and, when Canvas declared a raster image, requires the detected body
/// to remain within the reviewed raster image set. The returned type is the type detected from
/// the bytes, so a mislabeled image is recorded using its actual format.
pub fn verify_content_type_with_declared_type(
    response_header: Option<&str>,
    declared_type: Option<&str>,
    prefix: &[u8],
) -> Result<&'static str, MediaError> {
    let detected = verify_content_type(response_header, prefix)?;
    if declared_type
        .and_then(canonical_content_type)
        .is_some_and(is_raster_image)
        && !is_raster_image(detected)
    {
        return Err(MediaError::MimeSignatureMismatch);
    }
    Ok(detected)
}

/// An archived raster receipt already records the detected type, so verify it exactly.
pub(crate) fn verify_archived_content_type(header: &str, prefix: &[u8]) -> Result<(), MediaError> {
    let detected = verify_content_type(Some(header), prefix)?;
    if canonical_content_type(header).is_some_and(|kind| is_raster_image(kind) && kind != detected) {
        return Err(MediaError::MimeSignatureMismatch);
    }
    Ok(())
}

fn canonical_content_type(value: &str) -> Option<&'static str> {
    let value = value.split(';').next()?.trim().to_ascii_lowercase();
    Some(match value.as_str() {
        "application/octet-stream" => "application/octet-stream",
        "application/pdf" | "application/x-pdf" => "application/pdf",
        "application/zip" | "application/x-zip-compressed" => "application/zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        }
        "application/msword" | "application/vnd.ms-word" => "application/msword",
        "application/vnd.ms-excel" => "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint" => "application/vnd.ms-powerpoint",
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/png" => "image/png",
        "image/gif" => "image/gif",
        "image/webp" => "image/webp",
        "image/heic" | "image/heif" => "image/heic",
        "image/avif" => "image/avif",
        "text/plain" => "text/plain",
        "text/csv" | "application/csv" => "text/csv",
        "application/json" | "text/json" => "application/json",
        "application/xml" | "text/xml" => "application/xml",
        "application/sql" | "text/x-sql" => "application/sql",
        "application/vnd.sqlite3" | "application/x-sqlite3" => "application/vnd.sqlite3",
        "video/mp4" => "video/mp4",
        "image/svg+xml" => "image/svg+xml",
        "text/html" | "application/xhtml+xml" => "text/html",
        _ => return None,
    })
}

fn is_office_open_xml(content_type: &str) -> bool {
    matches!(
        content_type,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    )
}

fn is_legacy_office(content_type: &str) -> bool {
    matches!(
        content_type,
        "application/msword" | "application/vnd.ms-excel" | "application/vnd.ms-powerpoint"
    )
}

fn is_text_type(content_type: &str) -> bool {
    matches!(
        content_type,
        "text/plain" | "text/csv" | "application/json" | "application/xml"
    )
}

fn is_raster_image(content_type: &str) -> bool {
    matches!(
        content_type,
        "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/heic" | "image/avif"
    )
}

fn sniff_content_type(prefix: &[u8]) -> Option<&'static str> {
    if looks_like_executable(prefix) {
        None
    } else if prefix.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if prefix.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if prefix.len() >= 12 && prefix.starts_with(b"RIFF") && &prefix[8..12] == b"WEBP" {
        Some("image/webp")
    } else if let Some(image_type) = ftyp_image_type(prefix) {
        Some(image_type)
    } else if prefix.starts_with(b"PK\x03\x04") || prefix.starts_with(b"PK\x05\x06") {
        Some("application/zip")
    } else if prefix.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) {
        Some("application/x-ole-storage")
    } else if prefix.starts_with(b"SQLite format 3\0") {
        Some("application/vnd.sqlite3")
    } else if is_mp4(prefix) {
        Some("video/mp4")
    } else if is_svg(prefix) {
        Some("image/svg+xml")
    } else if is_sql(prefix) {
        Some("application/sql")
    } else if is_text_prefix(prefix) {
        Some("text/plain")
    } else {
        None
    }
}

fn looks_like_executable(prefix: &[u8]) -> bool {
    [
        b"MZ".as_slice(),
        b"\x7fELF".as_slice(),
        b"\xca\xfe\xba\xbe".as_slice(),
        b"\xbe\xba\xfe\xca".as_slice(),
        b"\xfe\xed\xfa\xce".as_slice(),
        b"\xce\xfa\xed\xfe".as_slice(),
        b"\xfe\xed\xfa\xcf".as_slice(),
        b"\xcf\xfa\xed\xfe".as_slice(),
        b"\0asm".as_slice(),
    ]
    .iter()
    .any(|signature| prefix.starts_with(signature))
}

fn is_mp4(prefix: &[u8]) -> bool {
    if prefix.len() < 16 || &prefix[4..8] != b"ftyp" || ftyp_image_type(prefix).is_some() {
        return false;
    }
    let box_size = u32::from_be_bytes(prefix[..4].try_into().expect("four-byte size")) as usize;
    if box_size < 16 || (box_size - 16) % 4 != 0 {
        return false;
    }
    matches!(
        &prefix[8..12],
        b"isom"
            | b"iso2"
            | b"iso3"
            | b"iso4"
            | b"iso5"
            | b"iso6"
            | b"iso7"
            | b"iso8"
            | b"iso9"
            | b"mp41"
            | b"mp42"
            | b"mp71"
            | b"avc1"
            | b"dash"
            | b"M4V "
            | b"M4VH"
            | b"M4VP"
            | b"MSNV"
    )
}

fn ftyp_image_type(prefix: &[u8]) -> Option<&'static str> {
    if prefix.len() < 16 || &prefix[4..8] != b"ftyp" {
        return None;
    }
    let box_size = u32::from_be_bytes(prefix[..4].try_into().expect("four-byte size")) as usize;
    if box_size < 16 || (box_size - 16) % 4 != 0 {
        return None;
    }
    let brand_end = prefix.len().min(box_size);
    let brands = std::iter::once(&prefix[8..12]).chain(prefix[16..brand_end].chunks_exact(4));
    let mut is_heif = false;
    for brand in brands {
        match brand {
            b"avif" | b"avis" => return Some("image/avif"),
            b"heic" | b"heix" | b"hevc" | b"heim" | b"heis" | b"mif1" | b"msf1" => {
                is_heif = true;
            }
            _ => {}
        }
    }
    is_heif.then_some("image/heic")
}

fn is_svg(prefix: &[u8]) -> bool {
    let prefix = prefix.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(prefix);
    let text = match std::str::from_utf8(prefix) {
        Ok(text) => text,
        // The streaming prefix may end in the middle of a UTF-8 code point.
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&prefix[..error.valid_up_to()])
                .ok()
                .unwrap_or("")
        }
        Err(_) => return false,
    };
    let mut rest = text.trim_start();
    loop {
        if let Some(after_declaration) = rest.strip_prefix("<?xml") {
            let Some(end) = after_declaration.find("?>") else {
                return false;
            };
            rest = after_declaration[end + 2..].trim_start();
            continue;
        }
        if let Some(after_comment) = rest.strip_prefix("<!--") {
            let Some(end) = after_comment.find("-->") else {
                return false;
            };
            rest = after_comment[end + 3..].trim_start();
            continue;
        }
        if let Some(after_doctype) = rest.strip_prefix("<!DOCTYPE") {
            let Some(end) = after_doctype.find('>') else {
                return false;
            };
            rest = after_doctype[end + 1..].trim_start();
            continue;
        }
        break;
    }
    let Some(root) = rest.strip_prefix("<svg") else {
        return false;
    };
    root.chars()
        .next()
        .is_some_and(|next| next.is_ascii_whitespace() || matches!(next, '>' | '/'))
}

fn is_sql(prefix: &[u8]) -> bool {
    let text = match std::str::from_utf8(prefix) {
        Ok(text) => text,
        // The streaming prefix may end in the middle of a UTF-8 code point.
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&prefix[..error.valid_up_to()])
                .ok()
                .unwrap_or("")
        }
        Err(_) => return false,
    };
    let mut rest = text.trim_start_matches('\u{feff}').trim_start();
    loop {
        if let Some(after_comment) = rest.strip_prefix("--") {
            let Some(end) = after_comment.find('\n') else {
                return false;
            };
            rest = after_comment[end + 1..].trim_start();
            continue;
        }
        if let Some(after_comment) = rest.strip_prefix("/*") {
            let Some(end) = after_comment.find("*/") else {
                return false;
            };
            rest = after_comment[end + 2..].trim_start();
            continue;
        }
        break;
    }
    let keyword_end = rest
        .find(|character: char| !character.is_ascii_alphabetic())
        .unwrap_or(rest.len());
    if keyword_end == 0 {
        return false;
    }
    matches!(
        &rest[..keyword_end].to_ascii_uppercase()[..],
        "SELECT"
            | "WITH"
            | "INSERT"
            | "UPDATE"
            | "DELETE"
            | "MERGE"
            | "CREATE"
            | "ALTER"
            | "DROP"
            | "TRUNCATE"
            | "REPLACE"
            | "PRAGMA"
            | "BEGIN"
            | "COMMIT"
            | "END"
            | "ROLLBACK"
            | "SAVEPOINT"
            | "RELEASE"
            | "EXPLAIN"
            | "VACUUM"
            | "ANALYZE"
            | "ATTACH"
            | "DETACH"
            | "GRANT"
            | "REVOKE"
            | "CALL"
            | "DO"
            | "DECLARE"
            | "SET"
            | "USE"
    )
}

fn is_text_prefix(prefix: &[u8]) -> bool {
    if prefix.contains(&0) {
        return false;
    }
    match std::str::from_utf8(prefix) {
        Ok(_) => true,
        // A streaming prefix can end part-way through a multi-byte code point.
        Err(error) => error.error_len().is_none() && error.valid_up_to() > 0,
    }
}

fn looks_like_html(prefix: &[u8]) -> bool {
    let prefix = prefix.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(prefix);
    let text = String::from_utf8_lossy(prefix);
    let trimmed = text
        .trim_start_matches(char::is_whitespace)
        .to_ascii_lowercase();
    [
        "<!doctype html",
        "<html",
        "<head",
        "<body",
        "<form",
        "<meta",
        "<script",
    ]
    .iter()
    .any(|marker| trimmed.starts_with(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ftyp(major_brand: &[u8; 4], compatible_brands: &[[u8; 4]]) -> Vec<u8> {
        let box_size = 16 + compatible_brands.len() * 4;
        let mut prefix = Vec::with_capacity(box_size);
        prefix.extend_from_slice(&(box_size as u32).to_be_bytes());
        prefix.extend_from_slice(b"ftyp");
        prefix.extend_from_slice(major_brand);
        prefix.extend_from_slice(&[0; 4]);
        for brand in compatible_brands {
            prefix.extend_from_slice(brand);
        }
        prefix
    }

    #[test]
    fn media_validation_rejects_html_and_signature_mismatches() {
        assert_eq!(
            verify_content_type(Some("application/pdf; charset=binary"), b"%PDF-1.7"),
            Ok("application/pdf")
        );
        assert_eq!(
            verify_content_type(
                Some("application/octet-stream"),
                b"<!doctype html><title>Sign in</title>"
            ),
            Err(MediaError::SignInResponse)
        );
        assert_eq!(
            verify_content_type(Some("application/pdf"), b"plain synthetic text"),
            Err(MediaError::MimeSignatureMismatch)
        );
    }

    #[test]
    fn media_validation_recognizes_reviewed_sqlite_and_mp4_signatures() {
        assert_eq!(
            verify_content_type(
                Some("application/octet-stream"),
                b"SQLite format 3\0\x01\0\0\0"
            ),
            Ok("application/vnd.sqlite3")
        );
        assert_eq!(
            verify_content_type(Some("application/x-sqlite3"), b"SQLite format 3\0"),
            Ok("application/vnd.sqlite3")
        );
        assert_eq!(
            verify_content_type(Some("video/mp4"), b"\0\0\0\x18ftypisom\0\0\0\0isom"),
            Ok("video/mp4")
        );
        assert_eq!(
            verify_content_type(Some("video/mp4"), b"\0\0\0\x18ftypnope\0\0\0\0nope"),
            Err(MediaError::MimeSignatureMismatch)
        );
        assert_eq!(
            verify_content_type(Some("application/octet-stream"), b"SQLite format 2\0"),
            Err(MediaError::MimeSignatureMismatch)
        );
    }

    #[test]
    fn image_declarations_accept_only_detected_raster_image_types() {
        let heic = ftyp(b"heic", &[]);
        let avif = ftyp(b"avif", &[]);
        let fixtures = [
            ("image/png", b"\x89PNG\r\n\x1a\nsynthetic".as_slice()),
            ("image/webp", b"RIFF\0\0\0\0WEBPsynthetic".as_slice()),
            ("image/heic", heic.as_slice()),
            ("image/avif", avif.as_slice()),
        ];
        for (expected, prefix) in fixtures {
            assert_eq!(
                verify_content_type_with_declared_type(
                    Some("application/octet-stream"),
                    Some("image/jpeg"),
                    prefix,
                ),
                Ok(expected)
            );
        }

        for (response_type, prefix) in [
            (
                Some("application/octet-stream"),
                b"\0\0\0\x18ftypisom\0\0\0\0isom".as_slice(),
            ),
            (
                Some("application/octet-stream"),
                b"PK\x03\x04synthetic ZIP".as_slice(),
            ),
            (None, b"MZ synthetic executable".as_slice()),
        ] {
            assert_eq!(
                verify_content_type_with_declared_type(response_type, Some("image/jpeg"), prefix),
                Err(MediaError::MimeSignatureMismatch)
            );
        }
        assert_eq!(
            verify_content_type_with_declared_type(
                Some("application/octet-stream"),
                Some("image/jpeg"),
                b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
            ),
            Err(MediaError::MimeSignatureMismatch)
        );
        assert_eq!(
            verify_content_type_with_declared_type(
                Some("application/octet-stream"),
                Some("image/jpeg"),
                b"<!doctype html><html></html>",
            ),
            Err(MediaError::SignInResponse)
        );
    }

    #[test]
    fn heif_and_avif_brands_are_not_misclassified_as_mp4() {
        for brand in [
            b"heic", b"heix", b"hevc", b"heim", b"heis", b"mif1", b"msf1",
        ] {
            let prefix = ftyp(brand, &[]);
            assert_eq!(sniff_content_type(&prefix), Some("image/heic"));
            assert!(!is_mp4(&prefix));
        }
        for brand in [b"avif", b"avis"] {
            let prefix = ftyp(brand, &[]);
            assert_eq!(sniff_content_type(&prefix), Some("image/avif"));
            assert!(!is_mp4(&prefix));
        }
        let compatible_brand = ftyp(b"isom", &[*b"avif"]);
        assert_eq!(sniff_content_type(&compatible_brand), Some("image/avif"));
        assert!(!is_mp4(&compatible_brand));
        assert_eq!(
            sniff_content_type(b"\0\0\0\x18ftypisom\0\0\0\0isom"),
            Some("video/mp4")
        );
    }

    #[test]
    fn media_validation_accepts_reviewed_benign_mime_cases() {
        let office_open_xml =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        assert_eq!(
            verify_content_type(Some("application/octet-stream"), b"%PDF-1.7\nsynthetic"),
            Ok("application/pdf")
        );
        assert_eq!(
            verify_content_type(Some(office_open_xml), b"PK\x03\x04synthetic ZIP container"),
            Ok(office_open_xml)
        );
        assert_eq!(
            verify_content_type(Some("text/plain; charset=utf-8"), b"Synthetic notes\n"),
            Ok("text/plain")
        );
    }

    #[test]
    fn media_validation_rejects_executables_and_unknown_binary_prefixes() {
        for executable in [
            b"MZ synthetic executable prefix".as_slice(),
            b"\x7fELF synthetic executable prefix".as_slice(),
            b"\xfe\xed\xfa\xcf synthetic Mach-O prefix".as_slice(),
            b"\xca\xfe\xba\xbe synthetic executable prefix".as_slice(),
            b"\0asm synthetic WebAssembly prefix".as_slice(),
        ] {
            assert_eq!(
                verify_content_type(None, executable),
                Err(MediaError::MimeSignatureMismatch)
            );
            assert_eq!(
                verify_content_type(Some("application/octet-stream"), executable),
                Err(MediaError::MimeSignatureMismatch)
            );
            assert_eq!(
                verify_content_type(Some("text/plain"), executable),
                Err(MediaError::MimeSignatureMismatch)
            );
        }
        assert_eq!(
            verify_content_type(Some("application/octet-stream"), b"\0\xff\x01\x80"),
            Err(MediaError::MimeSignatureMismatch)
        );
    }

    #[test]
    fn media_validation_requires_sql_structure_and_svg_root() {
        let sql = b"-- generated for testing\n/* schema */ CREATE TABLE example (id INTEGER);";
        assert_eq!(
            verify_content_type(Some("text/x-sql"), sql),
            Ok("application/sql")
        );
        assert_eq!(
            verify_content_type(Some("application/sql"), b"SELECT id FROM example;"),
            Ok("application/sql")
        );
        assert_eq!(
            verify_content_type(Some("application/sql"), b"a plain note, not a query"),
            Ok("application/sql")
        );
        assert_eq!(
            verify_content_type(
                Some("text/x-sql"),
                b"-- exported by client\n/* schema omitted */\n-- no DDL in this fragment\n"
            ),
            Ok("application/sql")
        );
        assert_eq!(
            verify_content_type(
                Some("application/sql"),
                b"<!doctype html><form>Sign in</form>"
            ),
            Err(MediaError::SignInResponse)
        );
        assert_eq!(
            verify_content_type(Some("application/sql"), b"\xff\x00\xfe"),
            Err(MediaError::MimeSignatureMismatch)
        );
        assert_eq!(
        verify_content_type(
            Some("image/svg+xml"),
            b"<?xml version=\"1.0\"?>\n<!-- synthetic -->\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"
        ),
        Ok("image/svg+xml")
    );
        assert_eq!(
            verify_content_type(Some("image/svg+xml"), b"<svg-not-an-svg-root/>"),
            Err(MediaError::MimeSignatureMismatch)
        );
        assert_eq!(
            verify_content_type(
                Some("image/svg+xml"),
                b"<!doctype html><html><body>sign in</body></html>"
            ),
            Err(MediaError::SignInResponse)
        );
    }
}
