//! Read-only validation of the private Canvas browser archive before native import.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

#[path = "browser_bundle_io.rs"]
mod io;

#[path = "browser_bundle_coverage.rs"]
mod coverage;

#[cfg(test)]
#[path = "browser_bundle_tests.rs"]
mod tests;

const ARCHIVE_NAME: &str = "canvas-capture-archive";
const POINTER_FORMAT: &str = "duegood-canvas-capture-current";
const MANIFEST_FORMAT: &str = "duegood-canvas-capture-generation";
const CANVAS_ORIGIN: &str = "https://marymount.instructure.com";
const MAX_POINTER_BYTES: u64 = 4096;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BLOB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GENERATION_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_RESOURCES: usize = 10_000;
const MAX_CAPTURE_ITEMS: usize = 100_000;
const MAX_ACTIVE_COURSES: usize = 250;
const MAX_BLOBS: usize = 10_000;
const REQUIRED_ENDPOINTS: [&str; 4] = ["course", "assignments", "assignmentGroups", "submissions"];

/// Optional receipt fields pinning a validation to one allocated native capture attempt.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpectedCaptureRun {
    pub run_id: u64,
    pub generation_id: Option<String>,
    pub user_id: Option<u64>,
}

/// Required endpoint coverage for one active Canvas course.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveCourseCoverage {
    pub course_id: u64,
    pub required_endpoints: BTreeSet<String>,
    pub complete: bool,
}

/// One source endpoint coverage row as captured, including optional account-wide rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureCoverage {
    pub endpoint: String,
    pub course_id: Option<u64>,
    /// Group ID for a group endpoint or group calendar context.
    pub group_id: Option<u64>,
    /// Bounded Canvas context code for per-context calendar coverage.
    pub context_code: Option<String>,
    pub status: String,
    pub reason: Option<String>,
}

/// Content-free progress emitted while validating saved file bodies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BundleValidationProgress {
    pub bytes_verified: u64,
    pub total_blob_bytes: u64,
    pub files_verified: usize,
    pub total_blob_files: usize,
}

/// A validated immutable archive view. The validator performs no writes or freshness updates.
#[derive(Debug)]
pub struct ValidatedCaptureBundle {
    pub run_id: u64,
    pub generation_id: String,
    pub user_id: u64,
    pub captured_at: String,
    pub snapshot: Value,
    pub manifest: Value,
    pub active_courses: Vec<ActiveCourseCoverage>,
    pub coverage: Vec<CaptureCoverage>,
    pub blob_directory: PathBuf,
}

/// Fixed, content-free validation failures suitable for native command boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BundleError {
    InvalidConfiguration,
    UnsafeDirectory,
    UnsafeFile,
    InvalidPointer,
    InvalidManifest,
    InvalidSnapshot,
    UnsupportedVersion,
    RunMismatch,
    IdentityMismatch,
    IntegrityMismatch,
    BlobMismatch,
    IncompleteInventory,
    IncompleteCoverage,
    BudgetExceeded,
}

impl BundleError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "INVALID_CONFIGURATION",
            Self::UnsafeDirectory => "UNSAFE_DIRECTORY",
            Self::UnsafeFile => "UNSAFE_FILE",
            Self::InvalidPointer => "INVALID_POINTER",
            Self::InvalidManifest => "INVALID_MANIFEST",
            Self::InvalidSnapshot => "INVALID_SNAPSHOT",
            Self::UnsupportedVersion => "UNSUPPORTED_VERSION",
            Self::RunMismatch => "RUN_MISMATCH",
            Self::IdentityMismatch => "IDENTITY_MISMATCH",
            Self::IntegrityMismatch => "INTEGRITY_MISMATCH",
            Self::BlobMismatch => "BLOB_MISMATCH",
            Self::IncompleteInventory => "INCOMPLETE_INVENTORY",
            Self::IncompleteCoverage => "INCOMPLETE_COVERAGE",
            Self::BudgetExceeded => "BUDGET_EXCEEDED",
        }
    }
}

impl std::fmt::Display for BundleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for BundleError {}

/// Validates the current v2 archive and every blob it claims, without changing archive or store state.
pub fn validate_current_bundle(
    app_root: &Path,
    expected: &ExpectedCaptureRun,
) -> Result<ValidatedCaptureBundle, BundleError> {
    validate_current_bundle_with_progress(app_root, expected, |_| {})
}

/// Progress-reporting validator for native commands that may hash large archived files.
/// Calls are throttled to at most once per 4 MiB or 100 ms, plus the final update.
pub fn validate_current_bundle_with_progress<F>(
    app_root: &Path,
    expected: &ExpectedCaptureRun,
    mut progress: F,
) -> Result<ValidatedCaptureBundle, BundleError>
where
    F: FnMut(BundleValidationProgress),
{
    if !app_root.is_absolute() || expected.run_id == 0 {
        return Err(BundleError::InvalidConfiguration);
    }
    let app_root = io::checked_directory(app_root)?;
    let archive = io::checked_directory(&app_root.join(ARCHIVE_NAME))?;
    let pointer_path = archive.join("current.json");
    let pointer_bytes = io::read_private_file(&pointer_path, MAX_POINTER_BYTES)?;
    let pointer: Value =
        serde_json::from_slice(&pointer_bytes).map_err(|_| BundleError::InvalidPointer)?;
    if pointer.get("format").and_then(Value::as_str) != Some(POINTER_FORMAT) {
        return Err(BundleError::InvalidPointer);
    }
    if pointer.get("version").and_then(Value::as_u64) != Some(2) {
        return Err(BundleError::UnsupportedVersion);
    }
    let run_id = required_u64(&pointer, "runId", BundleError::InvalidPointer)?;
    let generation_id = required_text(&pointer, "generationId", BundleError::InvalidPointer)?;
    if !valid_generation_id(&generation_id) {
        return Err(BundleError::InvalidPointer);
    }
    let pointer_hash = required_hash(&pointer, "snapshotSha256", BundleError::InvalidPointer)?;
    check_expected(expected, run_id, &generation_id, None)?;

    let generations = io::checked_directory(&archive.join("generations"))?;
    let generation_path = io::checked_directory(&generations.join(&generation_id))?;
    io::check_generation_entries(&generation_path)?;
    let manifest_bytes =
        io::read_private_file(&generation_path.join("manifest.json"), MAX_MANIFEST_BYTES)?;
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).map_err(|_| BundleError::InvalidManifest)?;
    validate_manifest(
        &manifest,
        &generation_id,
        run_id,
        &pointer_hash,
        manifest_bytes.len() as u64,
    )?;
    let user_id = required_nested_u64(
        &manifest,
        &["identity", "userId"],
        BundleError::InvalidManifest,
    )?;
    if user_id == 0 {
        return Err(BundleError::IdentityMismatch);
    }
    if required_nested_text(
        &manifest,
        &["identity", "origin"],
        BundleError::InvalidManifest,
    )? != CANVAS_ORIGIN
    {
        return Err(BundleError::IdentityMismatch);
    }
    check_expected(expected, run_id, &generation_id, Some(user_id))?;

    let snapshot_bytes =
        io::read_private_file(&generation_path.join("snapshot.json"), MAX_SNAPSHOT_BYTES)?;
    let expected_size = required_u64(&manifest, "snapshotBytes", BundleError::InvalidManifest)?;
    if expected_size != snapshot_bytes.len() as u64 || sha256(&snapshot_bytes) != pointer_hash {
        return Err(BundleError::IntegrityMismatch);
    }
    let snapshot: Value =
        serde_json::from_slice(&snapshot_bytes).map_err(|_| BundleError::InvalidSnapshot)?;
    let captured_at = validate_snapshot(&snapshot, run_id, &generation_id, user_id)?;
    validate_counts(&manifest, &snapshot)?;
    let (active_courses, coverage) = coverage::validate_active_coverage(&snapshot)?;

    let blobs = io::checked_directory(&archive.join("blobs"))?;
    if manifest.get("capturedAt").and_then(Value::as_str) != Some(captured_at.as_str()) {
        return Err(BundleError::IntegrityMismatch);
    }
    io::validate_blobs(&manifest, &snapshot, &blobs, &mut progress)?;
    Ok(ValidatedCaptureBundle {
        run_id,
        generation_id,
        user_id,
        captured_at,
        snapshot,
        manifest,
        active_courses,
        coverage,
        blob_directory: blobs,
    })
}

fn check_expected(
    expected: &ExpectedCaptureRun,
    run_id: u64,
    generation_id: &str,
    user_id: Option<u64>,
) -> Result<(), BundleError> {
    if expected.run_id != run_id
        || expected
            .generation_id
            .as_deref()
            .is_some_and(|value| value != generation_id)
    {
        return Err(BundleError::RunMismatch);
    }
    if let (Some(expected_user), Some(actual_user)) = (expected.user_id, user_id) {
        if expected_user != actual_user {
            return Err(BundleError::IdentityMismatch);
        }
    }
    Ok(())
}

fn validate_manifest(
    manifest: &Value,
    generation_id: &str,
    run_id: u64,
    pointer_hash: &str,
    manifest_bytes: u64,
) -> Result<(), BundleError> {
    if manifest.get("format").and_then(Value::as_str) != Some(MANIFEST_FORMAT) {
        return Err(BundleError::InvalidManifest);
    }
    if manifest.get("version").and_then(Value::as_u64) != Some(2) {
        return Err(BundleError::UnsupportedVersion);
    }
    if required_text(manifest, "generationId", BundleError::InvalidManifest)? != generation_id
        || required_u64(manifest, "runId", BundleError::InvalidManifest)? != run_id
    {
        return Err(BundleError::RunMismatch);
    }
    if required_hash(manifest, "snapshotSha256", BundleError::InvalidManifest)? != pointer_hash
        || manifest.get("complete").and_then(Value::as_bool) != Some(false)
    {
        return Err(BundleError::InvalidManifest);
    }
    let snapshot_bytes = required_u64(manifest, "snapshotBytes", BundleError::InvalidManifest)?;
    let blob_bytes = required_u64(manifest, "blobBytes", BundleError::InvalidManifest)?;
    if snapshot_bytes == 0 || snapshot_bytes > MAX_SNAPSHOT_BYTES {
        return Err(BundleError::BudgetExceeded);
    }
    if snapshot_bytes
        .checked_add(blob_bytes)
        .and_then(|total| total.checked_add(manifest_bytes))
        .is_none_or(|total| total > MAX_GENERATION_BYTES)
    {
        return Err(BundleError::BudgetExceeded);
    }
    if io::has_private_value(manifest, 0)? {
        return Err(BundleError::InvalidManifest);
    }
    Ok(())
}

fn validate_snapshot(
    snapshot: &Value,
    run_id: u64,
    generation_id: &str,
    user_id: u64,
) -> Result<String, BundleError> {
    if snapshot.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
        return Err(BundleError::UnsupportedVersion);
    }
    if snapshot.get("source").and_then(Value::as_str) != Some("canvas-browser")
        || snapshot.get("complete").and_then(Value::as_bool) != Some(false)
    {
        return Err(BundleError::InvalidSnapshot);
    }
    if required_u64(snapshot, "runId", BundleError::InvalidSnapshot)? != run_id
        || required_text(snapshot, "generationId", BundleError::InvalidSnapshot)? != generation_id
    {
        return Err(BundleError::RunMismatch);
    }
    if required_nested_u64(
        snapshot,
        &["identity", "userId"],
        BundleError::InvalidSnapshot,
    )? != user_id
        || user_id == 0
        || required_nested_text(
            snapshot,
            &["identity", "origin"],
            BundleError::InvalidSnapshot,
        )? != CANVAS_ORIGIN
    {
        return Err(BundleError::IdentityMismatch);
    }
    if snapshot["identity"]
        .get("accountId")
        .is_some_and(|value| value.as_u64().is_none_or(|account_id| account_id == 0))
    {
        return Err(BundleError::IdentityMismatch);
    }
    let captured_at = required_text(snapshot, "capturedAt", BundleError::InvalidSnapshot)?;
    if chrono::DateTime::parse_from_rfc3339(&captured_at).is_err() {
        return Err(BundleError::InvalidSnapshot);
    }
    let resources = snapshot
        .get("resources")
        .and_then(Value::as_array)
        .ok_or(BundleError::InvalidSnapshot)?;
    let coverage = snapshot
        .get("coverage")
        .and_then(Value::as_array)
        .ok_or(BundleError::InvalidSnapshot)?;
    if resources.len() > MAX_RESOURCES || coverage.len() > MAX_CAPTURE_ITEMS {
        return Err(BundleError::BudgetExceeded);
    }
    let mut item_count = 0_usize;
    for resource in resources {
        if resource
            .get("endpoint")
            .and_then(Value::as_str)
            .is_none_or(|endpoint| endpoint.is_empty() || endpoint.len() > 80)
            || !course_id_is_valid(resource.get("courseId"))
            || resource
                .get("pages")
                .and_then(Value::as_u64)
                .is_none_or(|pages| pages == 0 || pages > 10_000)
        {
            return Err(BundleError::InvalidSnapshot);
        }
        coverage::validate_resource_scope(resource)?;
        let items = resource
            .get("items")
            .and_then(Value::as_array)
            .ok_or(BundleError::InvalidSnapshot)?;
        item_count = item_count
            .checked_add(items.len())
            .ok_or(BundleError::BudgetExceeded)?;
        if item_count > MAX_CAPTURE_ITEMS {
            return Err(BundleError::BudgetExceeded);
        }
    }
    if io::has_private_value(snapshot, 0)? {
        return Err(BundleError::InvalidSnapshot);
    }
    Ok(captured_at)
}

fn validate_counts(manifest: &Value, snapshot: &Value) -> Result<(), BundleError> {
    let resources = snapshot["resources"]
        .as_array()
        .ok_or(BundleError::InvalidSnapshot)?;
    let item_count = resources
        .iter()
        .try_fold(0_u64, |sum, resource| {
            sum.checked_add(resource["items"].as_array()?.len() as u64)
        })
        .ok_or(BundleError::InvalidSnapshot)?;
    if required_u64(manifest, "resourceCount", BundleError::InvalidManifest)?
        != resources.len() as u64
        || required_u64(manifest, "itemCount", BundleError::InvalidManifest)? != item_count
    {
        return Err(BundleError::IntegrityMismatch);
    }
    Ok(())
}

fn required_u64(value: &Value, key: &str, error: BundleError) -> Result<u64, BundleError> {
    value.get(key).and_then(Value::as_u64).ok_or(error)
}

fn required_nested_u64(
    value: &Value,
    keys: &[&str],
    error: BundleError,
) -> Result<u64, BundleError> {
    let mut current = value;
    for key in keys {
        current = current.get(*key).ok_or(error)?;
    }
    current.as_u64().ok_or(error)
}

fn required_text(value: &Value, key: &str, error: BundleError) -> Result<String, BundleError> {
    let text = value.get(key).and_then(Value::as_str).ok_or(error)?;
    if text.is_empty() || text.len() > 256 {
        return Err(error);
    }
    Ok(text.to_owned())
}

fn required_nested_text(
    value: &Value,
    keys: &[&str],
    error: BundleError,
) -> Result<String, BundleError> {
    let mut current = value;
    for key in keys {
        current = current.get(*key).ok_or(error)?;
    }
    let text = current.as_str().ok_or(error)?;
    if text.len() > 256 {
        return Err(error);
    }
    Ok(text.to_owned())
}

fn required_hash(value: &Value, key: &str, error: BundleError) -> Result<String, BundleError> {
    let text = required_text(value, key, error)?;
    if !is_hex(&text, 64) {
        return Err(error);
    }
    Ok(text)
}

fn valid_generation_id(value: &str) -> bool {
    is_hex(value, 32)
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn course_id_is_valid(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Null) => true,
        Some(value) => value.as_u64().is_some_and(|id| id > 0),
        None => false,
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
