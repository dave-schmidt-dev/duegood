//! Fixed-root stdin/stdout interface for the native Canvas importer helper.

use std::io::Read;
use std::time::Duration;

use serde::{Deserialize, Deserializer};

use crate::browser_import::{
    import_current_capture, BrowserImportError, BrowserImportProgress, BrowserImportResult,
};
use crate::config;
use crate::store::Store;

const MAX_REQUEST_BYTES: u64 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserImportHelperError(&'static str);

impl BrowserImportHelperError {
    pub const fn code(self) -> &'static str {
        self.0
    }
}

impl std::fmt::Display for BrowserImportHelperError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for BrowserImportHelperError {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRequest {
    #[serde(deserialize_with = "required_nullable_user_id")]
    confirmed_first_user_id: Option<u64>,
}

fn required_nullable_user_id<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<u64>::deserialize(deserializer)
}

/// Reads and validates one bounded JSON line from the private stdin pipe.
pub fn read_confirmation<R: Read>(reader: R) -> Result<Option<u64>, BrowserImportHelperError> {
    let mut bytes = Vec::with_capacity(MAX_REQUEST_BYTES as usize);
    reader
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| BrowserImportHelperError("INPUT_UNAVAILABLE"))?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(BrowserImportHelperError("INPUT_TOO_LARGE"));
    }

    let mut line = bytes.as_slice();
    if let Some(without_newline) = line.strip_suffix(b"\n") {
        line = without_newline;
        if let Some(without_carriage_return) = line.strip_suffix(b"\r") {
            line = without_carriage_return;
        }
    }
    if line.is_empty() || line.contains(&b'\n') || line.contains(&b'\r') {
        return Err(BrowserImportHelperError("INVALID_INPUT"));
    }
    let request: ImportRequest =
        serde_json::from_slice(line).map_err(|_| BrowserImportHelperError("INVALID_INPUT"))?;
    if request.confirmed_first_user_id == Some(0) {
        return Err(BrowserImportHelperError("INVALID_INPUT"));
    }
    Ok(request.confirmed_first_user_id)
}

/// Runs the importer against its fixed production roots and emits only typed progress to caller.
pub fn run_import(
    confirmed_first_user_id: Option<u64>,
    progress: &mut dyn FnMut(BrowserImportProgress),
) -> Result<BrowserImportResult, BrowserImportHelperError> {
    let data_root = config::resolve_helper_data_root()
        .map_err(|_| BrowserImportHelperError("APP_DATA_UNAVAILABLE"))?;
    let archive_root = config::canvas_capture_archive_root(&data_root)
        .map_err(|_| BrowserImportHelperError("CAPTURE_ARCHIVE_UNAVAILABLE"))?;
    let store = Store::open_helper(&data_root, Duration::from_secs(5))
        .map_err(|_| BrowserImportHelperError("STORE_UNAVAILABLE"))?;
    import_current_capture(&store, &archive_root, confirmed_first_user_id, progress)
        .map_err(|error| BrowserImportHelperError(import_error_code(&error)))
}

fn import_error_code(error: &BrowserImportError) -> &'static str {
    error.code()
}

#[cfg(test)]
#[path = "browser_import_helper_tests.rs"]
mod tests;
