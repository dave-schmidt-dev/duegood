//! Journaled adoption of one validated private Canvas browser capture.
//!
//! A shared capture lease spans validation, blob promotion, latest-state reconciliation, and the
//! atomic store swap. Native locks follow snapshot-before-write order; success is recorded only
//! inside the staged tree installed by the existing refresh journal.

use std::fmt;
use std::path::Path;
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

use crate::browser_bundle::{
    validate_current_bundle_with_progress, BundleError, ExpectedCaptureRun,
};
use crate::browser_projection::{project_snapshot, ProjectionError};
use crate::browser_reconcile::{reconcile_browser_coursework, BrowserReconcileError};
use crate::browser_resources::legacy::LegacyResourceError;
use crate::browser_resources::{promote_capture_blobs, PromotionResult, ResourceArchiveError};
use crate::capture_run::{CaptureAttemptStatus, CaptureRunGuard};
use crate::config::{canvas_capture_archive_root, COURSEWORK_FILE, MANIFEST_FILE, STAGING_PREFIX};
use crate::export::{copy_tree, ExportProgress};
use crate::store::{Store, StoreError};

#[path = "browser_import_course_metadata.rs"]
mod course_metadata;
#[path = "browser_import_inventory.rs"]
mod inventory;
#[path = "browser_import_state.rs"]
mod state;

use inventory::{apply_promoted_folders, inactive_course_archive, validate_native_inventory};
use state::{
    check_prior_receipt, import_status, read_native_view, write_projected_document,
    write_stage_json, StageCleanup,
};

#[derive(Clone, Copy)]
enum FirstAccountConfirmation {
    None,
    ExplicitId(u64),
    CapturedAccount,
}

impl FirstAccountConfirmation {
    fn resolve(self, captured_user_id: u64) -> Option<u64> {
        match self {
            Self::None => None,
            Self::ExplicitId(user_id) => Some(user_id),
            Self::CapturedAccount => Some(captured_user_id),
        }
    }
}

const STATUS_FILE: &str = "browser-capture-status.json";
const STATUS_FORMAT: &str = "duegood-browser-import";
const STATUS_VERSION: u64 = 1;
const MAX_ARCHIVE_PATH_NAME: &str = "canvas-capture-archive";
const MAX_COURSES: usize = 500;
const MAX_JSON_BYTES: u64 = 32 * 1024 * 1024;

/// Content-free phases surfaced while a browser capture is validated and adopted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserImportPhase {
    Validating,
    Copying,
    Reconciling,
    Publishing,
    Complete,
}

/// Bounded content-free progress; it contains no filenames, paths, Canvas text, or IDs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImportProgress {
    pub phase: BrowserImportPhase,
    pub files_done: u64,
    pub bytes_done: u64,
}

/// Content-free result of one native adoption.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImportResult {
    pub run_id: u64,
    pub imported_courses: usize,
    pub archived_courses: usize,
    pub promoted_blobs: u64,
    pub reused_blobs: u64,
    pub bytes_verified: u64,
    pub already_current: bool,
}

/// Fixed importer error codes. `Display` never includes source content, IDs, or local paths.
#[derive(Debug)]
pub enum BrowserImportError {
    Busy,
    CaptureUnavailable,
    CaptureUnverified,
    Bundle(BundleError),
    Resources(ResourceArchiveError),
    LegacyMigration(LegacyResourceError),
    Projection(ProjectionError),
    AccountProjection(crate::browser_account_projection::BrowserAccountProjectionError),
    Reconciliation(BrowserReconcileError),
    SyllabusSessions(crate::syllabus_sessions::SyllabusSessionError),
    Store(StoreError),
    InvalidStore,
    ConfirmationRequired,
    AccountMismatch,
    OlderCapture,
    IncompleteCoverage,
    InvalidInventory,
    Stage,
}

impl BrowserImportError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Busy => "CAPTURE_OR_IMPORT_BUSY",
            Self::CaptureUnavailable => "CAPTURE_ATTEMPT_UNAVAILABLE",
            Self::CaptureUnverified => "CAPTURE_NOT_VERIFIED",
            Self::Bundle(_) => "CAPTURE_BUNDLE_INVALID",
            Self::Resources(_) => "CAPTURE_FILES_UNAVAILABLE",
            Self::LegacyMigration(_) => "LEGACY_RESOURCE_MIGRATION_FAILED",
            Self::Projection(_) => "CAPTURE_PROJECTION_FAILED",
            Self::AccountProjection(_) => "CAPTURE_ACCOUNT_PROJECTION_FAILED",
            Self::Reconciliation(_) => "COURSEWORK_RECONCILIATION_FAILED",
            Self::SyllabusSessions(_) => "SYLLABUS_SESSIONS_INVALID",
            Self::Store(_) => "STORE_OPERATION_FAILED",
            Self::InvalidStore => "STORE_NOT_AUTHORITATIVE_OR_UNREADABLE",
            Self::ConfirmationRequired => "FIRST_ACCOUNT_CONFIRMATION_REQUIRED",
            Self::AccountMismatch => "CANVAS_ACCOUNT_MISMATCH",
            Self::OlderCapture => "OLDER_CAPTURE_REJECTED",
            Self::IncompleteCoverage => "REQUIRED_COVERAGE_INCOMPLETE",
            Self::InvalidInventory => "NATIVE_COURSE_INVENTORY_INVALID",
            Self::Stage => "STORE_STAGE_FAILED",
        }
    }
}

impl fmt::Display for BrowserImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for BrowserImportError {}
impl From<StoreError> for BrowserImportError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// Imports the fixed current archive root, rechecks latest native state under ordered locks, and
/// publishes coursework, exports, inactive course records, account identity, and coverage in one
/// journaled store generation. The optional ID is required only for first account binding.
pub fn import_current_capture(
    store: &Store,
    capture_archive_root: &Path,
    confirmed_first_user_id: Option<u64>,
    progress: &mut dyn FnMut(BrowserImportProgress),
) -> Result<BrowserImportResult, BrowserImportError> {
    let confirmation = confirmed_first_user_id.map_or(
        FirstAccountConfirmation::None,
        FirstAccountConfirmation::ExplicitId,
    );
    import_current_capture_inner(store, capture_archive_root, confirmation, progress)
}

/// Imports the current capture and confirms its account only when the owner explicitly opts in.
/// The captured Canvas ID stays inside the importer and is resolved under the capture lease.
pub fn import_current_capture_confirmed(
    store: &Store,
    capture_archive_root: &Path,
    confirm_first_account: bool,
    progress: &mut dyn FnMut(BrowserImportProgress),
) -> Result<BrowserImportResult, BrowserImportError> {
    let confirmation = if confirm_first_account {
        FirstAccountConfirmation::CapturedAccount
    } else {
        FirstAccountConfirmation::None
    };
    import_current_capture_inner(store, capture_archive_root, confirmation, progress)
}

fn import_current_capture_inner(
    store: &Store,
    capture_archive_root: &Path,
    first_account_confirmation: FirstAccountConfirmation,
    progress: &mut dyn FnMut(BrowserImportProgress),
) -> Result<BrowserImportResult, BrowserImportError> {
    let fixed_archive = canvas_capture_archive_root(store.data_root())
        .map_err(|_| BrowserImportError::InvalidInventory)?;
    if capture_archive_root != fixed_archive
        || capture_archive_root
            .file_name()
            .and_then(|name| name.to_str())
            != Some(MAX_ARCHIVE_PATH_NAME)
    {
        return Err(BrowserImportError::InvalidInventory);
    }
    let capture_guard = CaptureRunGuard::acquire(store.data_root()).map_err(map_busy)?;
    let attempt = capture_guard
        .attempt()
        .map_err(map_busy)?
        .ok_or(BrowserImportError::CaptureUnavailable)?;
    if attempt.status != CaptureAttemptStatus::Captured {
        return Err(BrowserImportError::CaptureUnverified);
    }
    let generation_id = attempt
        .generation_id
        .as_deref()
        .ok_or(BrowserImportError::CaptureUnverified)?;
    let snapshot_sha256 = attempt
        .snapshot_sha256
        .as_deref()
        .ok_or(BrowserImportError::CaptureUnverified)?;
    let user_id = attempt
        .user_id
        .ok_or(BrowserImportError::CaptureUnverified)?;
    progress(progress_value(BrowserImportPhase::Validating, 0, 0));

    // The validator accepts the app-data parent and resolves its fixed archive child.
    let app_root = capture_archive_root
        .parent()
        .ok_or(BrowserImportError::InvalidInventory)?;
    let expected = ExpectedCaptureRun {
        run_id: attempt.run_id,
        generation_id: Some(generation_id.to_owned()),
        user_id: Some(user_id),
    };
    let bundle = validate_current_bundle_with_progress(app_root, &expected, |verified| {
        progress(progress_value(
            BrowserImportPhase::Validating,
            verified.files_verified as u64,
            verified.bytes_verified,
        ));
    })
    .map_err(BrowserImportError::Bundle)?;
    if bundle.run_id != attempt.run_id
        || bundle.generation_id != generation_id
        || bundle.user_id != user_id
        || bundle
            .manifest
            .get("snapshotSha256")
            .and_then(Value::as_str)
            != Some(snapshot_sha256)
    {
        return Err(BrowserImportError::CaptureUnverified);
    }
    let confirmed_first_user_id = first_account_confirmation.resolve(bundle.user_id);

    let initial = {
        let _read_lock = store.read_lock()?;
        read_native_view(store)?
    };
    let initial_scopes =
        validate_native_inventory(&initial.coursework, &initial.course_map, store, &bundle)?;
    check_prior_receipt(
        initial.status.as_ref(),
        bundle.run_id,
        &bundle.generation_id,
        bundle.user_id,
        confirmed_first_user_id,
    )?;

    // Archive bytes before taking native store locks. A failed later commit leaves only harmless,
    // content-addressed orphan blobs; no status or file reference points to them.
    progress(progress_value(BrowserImportPhase::Copying, 0, 0));
    let promoted = promote_capture_blobs(store.data_root(), &bundle, |done, _total| {
        progress(progress_value(BrowserImportPhase::Copying, 0, done));
    })
    .map_err(BrowserImportError::Resources)?;

    // One lock order for all imports: capture lease, snapshot catalog, then store writer.
    let _snapshot_lock = store.snapshot_lock()?;
    let _write_lock = store.write_lock()?;
    store.recover_refresh_locked()?;
    let latest = read_native_view(store)?;
    let scopes = validate_native_inventory(&latest.coursework, &latest.course_map, store, &bundle)?;
    if scopes != initial_scopes {
        return Err(BrowserImportError::InvalidInventory);
    }
    if check_prior_receipt(
        latest.status.as_ref(),
        bundle.run_id,
        &bundle.generation_id,
        bundle.user_id,
        confirmed_first_user_id,
    )? {
        // A same-generation receipt may skip republishing only when the coursework course
        // title/code already match the projected course metadata. Otherwise the journaled
        // import below repairs the placeholders an earlier importer retained.
        let receipt_projection = project_snapshot(&bundle.snapshot, &scopes)
            .map_err(BrowserImportError::Projection)?;
        if course_metadata::course_metadata_current(
            &latest.coursework,
            &receipt_projection.documents,
            &scopes,
        )? {
            progress(progress_value(BrowserImportPhase::Complete, 0, 0));
            return Ok(make_result(bundle.run_id, scopes.len(), 0, promoted, true));
        }
    }

    crate::snapshots::snapshot_before_refresh_locked_with_progress(
        store,
        "canvas-browser-import",
        &mut |copied| {
            progress(progress_value(
                BrowserImportPhase::Copying,
                copied.files_done,
                copied.bytes_done,
            ));
        },
    )?;
    let legacy =
        crate::browser_resources::legacy::migrate_legacy_resources(store, |done, _total| {
            progress(progress_value(BrowserImportPhase::Copying, 0, done));
            true
        })
        .map_err(BrowserImportError::LegacyMigration)?;

    progress(progress_value(BrowserImportPhase::Reconciling, 0, 0));
    let mut projection =
        project_snapshot(&bundle.snapshot, &scopes).map_err(BrowserImportError::Projection)?;
    let account_documents =
        crate::browser_account_projection::project_account_documents(&bundle.snapshot)
            .map_err(BrowserImportError::AccountProjection)?;
    projection.documents.extend(account_documents);
    let captured_at = parse_capture_time(&bundle.captured_at)?;
    let mut coursework =
        reconcile_browser_coursework(&latest.coursework, &projection.coursework, captured_at)
            .map_err(BrowserImportError::Reconciliation)?;
    coursework = crate::syllabus_sessions::reconcile_syllabus_sessions(
        &coursework,
        &bundle.snapshot,
        &scopes,
    )
    .map_err(BrowserImportError::SyllabusSessions)?;
    apply_promoted_folders(&mut coursework, &scopes)?;
    course_metadata::apply_course_metadata(&mut coursework, &projection.documents, &scopes)?;
    let archive = inactive_course_archive(&bundle, &scopes)?;
    let status = import_status(&bundle, &promoted)?;

    let generation = uuid::Uuid::new_v4().simple().to_string();
    let stage = store
        .data_root()
        .join(format!("{STAGING_PREFIX}refresh-{generation}"));
    let _cleanup = StageCleanup(stage.clone());
    let mut copied = ExportProgress::default();
    copy_tree(&store.store_dir(), &stage, true, &mut |current| {
        copied = current;
        progress(progress_value(
            BrowserImportPhase::Copying,
            current.files_done,
            current.bytes_done,
        ));
    })
    .map_err(|_| BrowserImportError::Stage)?;
    for (relative, bytes) in projection.documents {
        write_projected_document(&stage, &relative, &bytes, &scopes)?;
    }
    write_stage_json(&stage, COURSEWORK_FILE, &coursework)?;
    write_stage_json(&stage, STATUS_FILE, &status)?;
    write_stage_json(&stage, "browser-courses-archive.json", &archive)?;
    state::write_verified_legacy_archive(&stage, &legacy.document)?;
    state::remove_verified_legacy_materials(&stage, &legacy.removable_material_paths)?;
    let staged_manifest = state::read_plain_file(&stage.join(MANIFEST_FILE), 1024 * 1024)?;
    let current_manifest =
        state::read_plain_file(&store.store_dir().join(MANIFEST_FILE), 1024 * 1024)?;
    if staged_manifest != current_manifest || staged_manifest.is_empty() {
        return Err(BrowserImportError::InvalidStore);
    }

    progress(progress_value(
        BrowserImportPhase::Publishing,
        copied.files_done,
        copied.bytes_done,
    ));
    store.publish_refresh_generation(&stage, &generation)?;
    progress(progress_value(
        BrowserImportPhase::Complete,
        copied.files_done,
        copied.bytes_done,
    ));
    let archived_courses = archive["courses"].as_array().map_or(0, Vec::len);
    Ok(make_result(
        bundle.run_id,
        scopes.len(),
        archived_courses,
        promoted,
        false,
    ))
}

fn map_busy(error: std::io::Error) -> BrowserImportError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ) {
        BrowserImportError::Busy
    } else {
        BrowserImportError::CaptureUnavailable
    }
}

fn progress_value(
    phase: BrowserImportPhase,
    files_done: u64,
    bytes_done: u64,
) -> BrowserImportProgress {
    BrowserImportProgress {
        phase,
        files_done,
        bytes_done,
    }
}

fn make_result(
    run_id: u64,
    imported_courses: usize,
    archived_courses: usize,
    promoted: PromotionResult,
    already_current: bool,
) -> BrowserImportResult {
    BrowserImportResult {
        run_id,
        imported_courses,
        archived_courses,
        promoted_blobs: promoted.promoted_blobs,
        reused_blobs: promoted.reused_blobs,
        bytes_verified: promoted.bytes_verified,
        already_current,
    }
}

fn parse_capture_time(value: &str) -> Result<SystemTime, BrowserImportError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| SystemTime::from(date.with_timezone(&chrono::Utc)))
        .map_err(|_| BrowserImportError::InvalidInventory)
}

#[cfg(test)]
#[path = "browser_import_tests.rs"]
mod tests;
