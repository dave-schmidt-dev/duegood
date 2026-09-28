use std::io::Cursor;

use super::read_confirmation;

fn parse(input: &[u8]) -> Result<Option<u64>, super::BrowserImportHelperError> {
    read_confirmation(Cursor::new(input))
}

#[test]
fn accepts_null_or_positive_first_account_confirmation() {
    assert_eq!(parse(br#"{"confirmedFirstUserId":null}"#), Ok(None));
    assert_eq!(parse(br#"{"confirmedFirstUserId":41}"#), Ok(Some(41)));
    assert_eq!(parse(b"{\"confirmedFirstUserId\":null}\r\n"), Ok(None));
}

#[test]
fn rejects_malformed_or_missing_request_fields() {
    for input in [b"".as_slice(), b"not json", b"[]"] {
        assert_eq!(parse(input).unwrap_err().code(), "INVALID_INPUT");
    }
}

#[test]
fn rejects_a_valid_object_without_confirmation_field() {
    assert_eq!(parse(b"{}\n").unwrap_err().code(), "INVALID_INPUT");
}

#[test]
fn rejects_unknown_fields_and_duplicate_confirmation_keys() {
    assert_eq!(
        parse(br#"{"confirmedFirstUserId":null,"root":"/tmp"}"#)
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
    assert_eq!(
        parse(br#"{"confirmedFirstUserId":null,"confirmedFirstUserId":1}"#)
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
}

#[test]
fn rejects_zero_and_non_numeric_confirmation_ids() {
    for input in [
        br#"{"confirmedFirstUserId":0}"#.as_slice(),
        br#"{"confirmedFirstUserId":-1}"#,
        br#"{"confirmedFirstUserId":"41"}"#,
    ] {
        assert_eq!(parse(input).unwrap_err().code(), "INVALID_INPUT");
    }
}

#[test]
fn rejects_payloads_over_the_1024_byte_limit() {
    let mut input = br#"{"confirmedFirstUserId":null}"#.to_vec();
    input.resize(1025, b' ');
    assert_eq!(parse(&input).unwrap_err().code(), "INPUT_TOO_LARGE");
}

#[test]
fn rejects_multiple_json_lines() {
    assert_eq!(
        parse(b"{\"confirmedFirstUserId\":null}\n{\"confirmedFirstUserId\":1}\n")
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
}
