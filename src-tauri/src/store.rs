//! The app store: the legacy on-disk layout inside `<data root>/store`, plus a versioned manifest.
//!
//! Rust owns all store I/O. Writes are same-directory temp files that are fsynced, renamed into
//! place, and followed by a parent-directory fsync. Files are `0600` and directories `0700`.
//! Every document write holds the short OS [`WriteLock`]; opening the store takes the
//! [`InstanceLock`], so a second app instance is denied. JSON documents round-trip through
//! `serde_json::Value` with insertion order preserved, so unknown fields survive, and change
//! detection compares SHA-256 digests of the exact bytes.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::config::{
    BACKUPS_DIR, MANIFEST_FILE, MANIFEST_FORMAT, MANIFEST_VERSION, REPLACE_JOURNAL_FILE,
    STAGING_PREFIX, STORE_DIR,
};
use crate::locking::{InstanceLock, LockError, ReadLock, RefreshLock, SnapshotLock, WriteLock};

const REFRESH_JOURNAL_FILE: &str = "refresh-journal.json";

/// Store failure. Messages never include paths or document content.
#[derive(Debug)]
pub enum StoreError {
    Lock(LockError),
    Io(io::Error),
    /// A write's expected digest no longer matches the document on disk.
    // The first store write command arrives with the next task; the primitive is tested now.
    #[cfg_attr(not(test), allow(dead_code))]
    Conflict,
    /// One item's value changed since it was rendered, independent of other items.
    ItemConflict(bool),
    ItemMissing,
    /// A document exceeds its declared read cap.
    TooLarge,
    /// A document name is not a fixed relative store path.
    InvalidName,
    /// The store changed between an import's start and its adoption.
    StoreChanged,
    Invalid(&'static str),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Lock(error) => write!(f, "{error}"),
            StoreError::Io(error) => write!(f, "store input/output failed ({})", error.kind()),
            StoreError::Conflict => write!(f, "the document changed since it was read"),
            StoreError::ItemConflict(_) => write!(f, "the item changed since it was shown"),
            StoreError::ItemMissing => write!(f, "the coursework item was not found"),
            StoreError::TooLarge => write!(f, "a store document exceeds its size cap"),
            StoreError::InvalidName => write!(f, "invalid store document name"),
            StoreError::StoreChanged => write!(f, "the app store changed during the import"),
            StoreError::Invalid(reason) => write!(f, "{reason}"),
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        StoreError::Io(error)
    }
}

impl From<LockError> for StoreError {
    fn from(error: LockError) -> Self {
        StoreError::Lock(error)
    }
}

/// Lowercase hex SHA-256 of exact bytes (the Node store's `version`).
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Node's `JSON.stringify(document, null, 2) + "\n"` for `serde_json::Value` documents.
pub fn node_json_bytes(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(value).expect("serializing a JSON value cannot fail");
    bytes.push(b'\n');
    bytes
}

/// Creates one directory with mode `0700` (and tightens an existing one when `existing_ok`).
pub fn create_private_dir(path: &Path, existing_ok: bool) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => {}
        Err(error)
            if existing_ok && error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(error) => return Err(error),
    }
    set_private_dir_mode(path)
}

/// Creates one directory with mode `0700` if it is missing, leaving an existing directory's mode
/// alone (the caller tightens it only once it holds the instance lock).
fn create_private_dir_if_missing(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
        Err(error) => Err(error),
    }
}

pub(crate) fn set_private_dir_mode(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Opens a new private file (`0600`) that must not already exist.
pub fn create_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Flushes a directory entry change (create, rename, remove) to disk.
pub fn fsync_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Same-directory atomic replacement: temp file (`0600`), write, fsync, rename, parent fsync.
pub fn atomic_write(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let temporary = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = create_private_file(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, target)?;
        fsync_dir(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// UTC timestamp in ISO-8601 (`2026-09-23T12:34:56Z`) and compact (`20260923T123456Z`) forms.
pub struct UtcStamp {
    pub iso: String,
    pub compact: String,
}

/// Howard Hinnant's days-from-civil inverse: days since 1970-01-01 to (year, month, day).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

pub fn utc_stamp(time: SystemTime) -> UtcStamp {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64;
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let rest = seconds.rem_euclid(86_400);
    let (hour, minute, second) = (rest / 3_600, (rest % 3_600) / 60, rest % 60);
    UtcStamp {
        iso: format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"),
        compact: format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z"),
    }
}

/// Manifest state. A preview never refreshes; only an authoritative store may (Phase 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StoreState {
    Preview,
    Authoritative,
}

impl StoreState {
    pub fn as_str(self) -> &'static str {
        match self {
            StoreState::Preview => "preview",
            StoreState::Authoritative => "authoritative",
        }
    }
}

/// Summary of a readable manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestSummary {
    pub state: StoreState,
    pub imported_at: Option<String>,
    pub files: Option<u64>,
    pub bytes: Option<u64>,
    /// Digest of the manifest's exact bytes, used to detect a concurrent change.
    pub digest: String,
}

/// What the data root currently holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreCondition {
    Empty,
    Ready(ManifestSummary),
    /// The store folder exists but its manifest is missing or unusable. Import never replaces it.
    Damaged(&'static str),
}

/// Builds a new manifest value for an imported preview store.
pub fn new_preview_manifest(files: u64, bytes: u64, tree_digest: &str, now: SystemTime) -> Value {
    let stamp = utc_stamp(now).iso;
    serde_json::json!({
        "format": MANIFEST_FORMAT,
        "version": MANIFEST_VERSION,
        "state": StoreState::Preview.as_str(),
        "createdAt": stamp,
        "importedAt": stamp,
        "source": { "kind": "legacy-import", "files": files, "bytes": bytes, "treeDigest": tree_digest },
    })
}

fn parse_manifest(bytes: &[u8]) -> Result<ManifestSummary, &'static str> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "store manifest is not valid JSON")?;
    let object = value.as_object().ok_or("store manifest is not an object")?;
    if object.get("format").and_then(Value::as_str) != Some(MANIFEST_FORMAT) {
        return Err("store manifest format is unknown");
    }
    if object.get("version").and_then(Value::as_u64) != Some(MANIFEST_VERSION) {
        return Err("store manifest version is unsupported");
    }
    let state = match object.get("state").and_then(Value::as_str) {
        Some("preview") => StoreState::Preview,
        Some("authoritative") => StoreState::Authoritative,
        _ => return Err("store manifest state is unknown"),
    };
    let source = object.get("source");
    Ok(ManifestSummary {
        state,
        imported_at: object
            .get("importedAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
        files: source
            .and_then(|source| source.get("files"))
            .and_then(Value::as_u64),
        bytes: source
            .and_then(|source| source.get("bytes"))
            .and_then(Value::as_u64),
        digest: sha256_hex(bytes),
    })
}

/// Exact bytes of one store document and their digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentBytes {
    pub bytes: Vec<u8>,
    pub digest: String,
}

/// The result of one personal-progress change, with no Canvas submission side effects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub completed: bool,
    pub completed_at: Option<i64>,
    pub discussion_post_done: bool,
    pub discussion_replies_done: bool,
    pub version: String,
}

/// A versioned local grade observation. It deliberately does not replace Canvas grade or score.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualGradeResult {
    pub manual_grade: Option<String>,
    pub manual_grade_version: Option<u8>,
    pub version: String,
}

/// A completed, explicitly reviewed source-link decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLinkResult {
    pub version: String,
}

/// Validates a fixed relative document name: only normal components, no traversal.
fn checked_relative(name: &str) -> Result<&Path, StoreError> {
    let path = Path::new(name);
    if name.is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(StoreError::InvalidName);
    }
    Ok(path)
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn coursework_item_mut<'a>(
    document: &'a mut Value,
    item_id: &str,
) -> Result<&'a mut Map<String, Value>, StoreError> {
    document
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or(StoreError::Invalid("coursework items are malformed"))?
        .iter_mut()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(item_id))
        .and_then(Value::as_object_mut)
        .ok_or(StoreError::ItemMissing)
}

#[derive(Clone)]
struct SourceFact {
    owner: Value,
    value: Value,
    observed_at: Option<String>,
}

struct FieldFacts {
    selected: SourceFact,
    alternatives: Vec<SourceFact>,
}

fn source_reference_parts(
    value: &Value,
) -> Result<(String, String, String, String, Option<String>), StoreError> {
    let object = value
        .as_object()
        .ok_or(StoreError::Invalid("source reference is malformed"))?;
    let required = |name| {
        object
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 160)
            .map(str::to_owned)
            .ok_or(StoreError::Invalid("source reference is malformed"))
    };
    let institution = required("institution")?;
    let course = required("course")?;
    let source = required("source")?;
    if !matches!(source.as_str(), "canvas" | "ical" | "manual" | "pdf") {
        return Err(StoreError::Invalid("source reference is malformed"));
    }
    let id = required("id")?;
    let instance = match object.get("instance") {
        None => None,
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 160 => {
            Some(value.clone())
        }
        _ => return Err(StoreError::Invalid("source reference is malformed")),
    };
    Ok((institution, course, source, id, instance))
}

fn source_reference_key(value: &Value) -> Result<String, StoreError> {
    let (institution, course, source, id, instance) = source_reference_parts(value)?;
    Ok(serde_json::to_string(&serde_json::json!([
        institution,
        course,
        source,
        id,
        instance
    ]))
    .expect("source reference key is serializable"))
}

fn source_reference_source(value: &Value) -> Result<&str, StoreError> {
    value
        .get("source")
        .and_then(Value::as_str)
        .ok_or(StoreError::Invalid("source reference is malformed"))
}

fn source_priority(value: &Value) -> Result<u8, StoreError> {
    match source_reference_source(value)? {
        "canvas" => Ok(2),
        "ical" => Ok(1),
        "manual" | "pdf" => Ok(0),
        _ => Err(StoreError::Invalid("source reference is malformed")),
    }
}

fn is_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    let fractional = match bytes.len() {
        20 => false,
        22..=24 => bytes.get(19) == Some(&b'.'),
        _ => return false,
    };
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || bytes.last() != Some(&b'Z')
    {
        return false;
    }
    let digit = |index: usize| bytes.get(index).is_some_and(u8::is_ascii_digit);
    if ![0..4, 5..7, 8..10, 11..13, 14..16, 17..19]
        .into_iter()
        .flatten()
        .all(digit)
        || (fractional && !(20..bytes.len() - 1).all(digit))
    {
        return false;
    }
    let number = |start: usize, end: usize| {
        std::str::from_utf8(&bytes[start..end])
            .expect("ASCII digits")
            .parse::<u32>()
            .expect("ASCII digits parse")
    };
    let (year, month, day) = (number(0, 4), number(5, 7), number(8, 10));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        _ => return false,
    };
    day > 0 && day <= days && number(11, 13) < 24 && number(14, 16) < 60 && number(17, 19) < 60
}

fn checked_observed_at(value: Option<&Value>) -> Result<Option<String>, StoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .filter(|value| is_utc_timestamp(value))
        .ok_or(StoreError::Invalid("source observation time is malformed"))?;
    Ok(Some(value.to_owned()))
}

fn source_fact(value: &Value) -> Result<SourceFact, StoreError> {
    let object = value
        .as_object()
        .ok_or(StoreError::Invalid("field observations are malformed"))?;
    let owner = object
        .get("owner")
        .cloned()
        .ok_or(StoreError::Invalid("field observations are malformed"))?;
    source_reference_key(&owner)?;
    let fact_value = object
        .get("value")
        .cloned()
        .ok_or(StoreError::Invalid("field observations are malformed"))?;
    Ok(SourceFact {
        owner,
        value: fact_value,
        observed_at: checked_observed_at(object.get("observedAt"))?,
    })
}

fn field_facts(value: Option<&Value>) -> Result<Option<FieldFacts>, StoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or(StoreError::Invalid("field observations are malformed"))?;
    let selected = source_fact(value)?;
    let alternatives = match object.get("alternatives") {
        None => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(source_fact)
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(StoreError::Invalid("field observations are malformed")),
    };
    let mut owners = std::collections::HashSet::new();
    for fact in std::iter::once(&selected).chain(alternatives.iter()) {
        if !owners.insert(source_reference_key(&fact.owner)?) {
            return Err(StoreError::Invalid("field observations are malformed"));
        }
    }
    if owners.len() > 20 {
        return Err(StoreError::Invalid("field observations are malformed"));
    }
    Ok(Some(FieldFacts {
        selected,
        alternatives,
    }))
}

fn stable_fact(incoming: &SourceFact, previous: Option<&SourceFact>) -> SourceFact {
    match previous {
        Some(previous) if previous.value == incoming.value => SourceFact {
            owner: incoming.owner.clone(),
            value: incoming.value.clone(),
            observed_at: previous.observed_at.clone(),
        },
        _ => incoming.clone(),
    }
}

fn should_promote(
    field: &str,
    selected: &SourceFact,
    candidate: &SourceFact,
    incoming: &SourceFact,
) -> Result<bool, StoreError> {
    let incoming_source = source_reference_source(&incoming.owner)?;
    let selected_source = source_reference_source(&selected.owner)?;
    if field != "at" {
        return Ok(source_priority(&incoming.owner)? > source_priority(&selected.owner)?);
    }
    if incoming_source == "ical" && selected_source == "canvas" {
        return Ok(candidate
            .observed_at
            .as_ref()
            .is_some_and(|candidate_time| {
                selected
                    .observed_at
                    .as_ref()
                    .is_none_or(|selected_time| candidate_time > selected_time)
            }));
    }
    if incoming_source == "canvas" && selected_source == "ical" {
        return Ok(incoming.observed_at.as_ref().is_some_and(|api_time| {
            selected
                .observed_at
                .as_ref()
                .is_none_or(|selected_time| api_time >= selected_time)
        }));
    }
    Ok(source_priority(&incoming.owner)? > source_priority(&selected.owner)?)
}

fn fact_value(fact: &SourceFact) -> Value {
    let mut value = Map::new();
    value.insert("owner".to_owned(), fact.owner.clone());
    value.insert("value".to_owned(), fact.value.clone());
    if let Some(observed_at) = &fact.observed_at {
        value.insert("observedAt".to_owned(), Value::String(observed_at.clone()));
    }
    Value::Object(value)
}

fn merge_source_field(
    item: &mut Map<String, Value>,
    observations: &mut Map<String, Value>,
    field: &str,
    incoming: SourceFact,
) -> Result<(), StoreError> {
    let old = field_facts(observations.get(field))?;
    let selected = old
        .as_ref()
        .map(|facts| facts.selected.clone())
        .unwrap_or_else(|| incoming.clone());
    let mut alternatives = old.map(|facts| facts.alternatives).unwrap_or_default();
    let incoming_key = source_reference_key(&incoming.owner)?;
    let selected_key = source_reference_key(&selected.owner)?;
    let mut next_selected = selected.clone();
    if incoming_key == selected_key {
        if field == "at"
            && source_reference_source(&incoming.owner)? == "canvas"
            && incoming.observed_at.is_some()
        {
            next_selected = incoming;
        } else {
            next_selected = stable_fact(&incoming, Some(&selected));
        }
    } else {
        let existing_index = alternatives.iter().position(|fact| {
            source_reference_key(&fact.owner).expect("validated source fact") == incoming_key
        });
        let candidate = if let Some(index) = existing_index {
            let next = stable_fact(&incoming, Some(&alternatives[index]));
            alternatives[index] = next.clone();
            next
        } else {
            alternatives.push(incoming.clone());
            incoming.clone()
        };
        if should_promote(field, &selected, &candidate, &incoming)? {
            next_selected =
                if field == "at" && source_reference_source(&incoming.owner)? == "canvas" {
                    incoming
                } else {
                    candidate
                };
            let next_key = source_reference_key(&next_selected.owner)?;
            alternatives.retain(|fact| {
                source_reference_key(&fact.owner).expect("validated source fact") != next_key
            });
            if let Some(index) = alternatives.iter().position(|fact| {
                source_reference_key(&fact.owner).expect("validated source fact") == selected_key
            }) {
                alternatives[index] = selected;
            } else {
                alternatives.push(selected);
            }
        }
    }
    if alternatives.len() + 1 > 20 {
        return Err(StoreError::Invalid("field observations are malformed"));
    }
    let mut stored = fact_value(&next_selected)
        .as_object()
        .expect("source fact is an object")
        .clone();
    if !alternatives.is_empty() {
        stored.insert(
            "alternatives".to_owned(),
            Value::Array(alternatives.iter().map(fact_value).collect()),
        );
    }
    observations.insert(field.to_owned(), Value::Object(stored));
    if item.get(field) != Some(&next_selected.value) {
        item.insert(field.to_owned(), next_selected.value);
    }
    Ok(())
}

fn source_owned_field(field: &str) -> bool {
    matches!(
        field,
        "kind"
            | "title"
            | "at"
            | "points"
            | "detail"
            | "url"
            | "submissionStatus"
            | "grade"
            | "score"
            | "submittedAt"
            | "gradedAt"
            | "assignmentGroupId"
            | "assignmentGroupName"
            | "assignmentGroupWeight"
    )
}

/// Reads a regular, non-symlink file up to `cap` bytes; `None` when absent.
pub fn read_capped(path: &Path, cap: u64) -> Result<Option<Vec<u8>>, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() {
        return Err(StoreError::Invalid(
            "a store document is not a regular file",
        ));
    }
    if metadata.len() > cap {
        return Err(StoreError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?.take(cap + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > cap {
        return Err(StoreError::TooLarge);
    }
    Ok(Some(bytes))
}

/// An open store: holds the instance lock for as long as it lives.
#[derive(Debug)]
pub struct Store {
    data_root: PathBuf,
    write_lock_timeout: Duration,
    _instance: Option<InstanceLock>,
}

impl Store {
    /// Opens (creating if needed) the data root, takes the instance lock, and recovers from an
    /// interrupted import or preview replacement.
    pub fn open(data_root: &Path, write_lock_timeout: Duration) -> Result<Store, StoreError> {
        if !data_root.is_absolute() {
            return Err(StoreError::Invalid("the data root must be absolute"));
        }
        if let Some(parent) = data_root.parent() {
            fs::create_dir_all(parent)?;
        }
        create_private_dir_if_missing(data_root)?;
        let instance = InstanceLock::acquire(data_root)?;
        // Only the lock holder tightens an existing data root: a denied second instance must leave
        // private-store metadata exactly as it found it.
        set_private_dir_mode(data_root)?;
        let store = Store {
            data_root: data_root.to_path_buf(),
            write_lock_timeout,
            _instance: Some(instance),
        };
        store.recover()?;
        Ok(store)
    }

    /// Attaches a helper process to an already-open app-data root without taking the app's
    /// lifetime instance lock. It deliberately performs no recovery, cleanup, or directory-mode
    /// changes; helpers must use the shared/exclusive OS lock before store operations.
    pub fn open_helper(
        data_root: &Path,
        write_lock_timeout: Duration,
    ) -> Result<Store, StoreError> {
        if !data_root.is_absolute() {
            return Err(StoreError::Invalid("the data root must be absolute"));
        }
        let metadata = fs::symlink_metadata(data_root)?;
        if !metadata.file_type().is_dir() {
            return Err(StoreError::Invalid(
                "the helper data root is not a plain directory",
            ));
        }
        Ok(Store {
            data_root: data_root.to_path_buf(),
            write_lock_timeout,
            _instance: None,
        })
    }

    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub fn store_dir(&self) -> PathBuf {
        self.data_root.join(STORE_DIR)
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.data_root.join(BACKUPS_DIR)
    }

    /// Takes the short OS write lock.
    pub fn write_lock(&self) -> Result<WriteLock, StoreError> {
        Ok(WriteLock::acquire(
            &self.data_root,
            self.write_lock_timeout,
        )?)
    }

    /// Takes a shared OS lock around one complete multi-document read operation.
    pub fn read_lock(&self) -> Result<ReadLock, StoreError> {
        Ok(ReadLock::acquire(&self.data_root, self.write_lock_timeout)?)
    }

    /// Takes the cross-process lease for the full duration of one refresh transaction.
    pub fn refresh_lock(&self) -> Result<RefreshLock, StoreError> {
        Ok(RefreshLock::acquire(&self.data_root)?)
    }

    /// Takes the catalog lock used to serialize snapshot creation, rotation, and listing.
    pub fn snapshot_lock(&self) -> Result<SnapshotLock, StoreError> {
        Ok(SnapshotLock::acquire(
            &self.data_root,
            self.write_lock_timeout,
        )?)
    }

    /// Crash recovery, run under the instance lock: finish or roll back an interrupted preview
    /// replacement, then remove incomplete import staging folders (never the store or backups).
    fn recover(&self) -> Result<(), StoreError> {
        // Do not clean a helper's stage directory while its refresh lease is active. If a helper
        // outlives an app crash, startup fails busy and can retry once that bounded job exits.
        let _refresh_lease = self.refresh_lock()?;
        let _write_lock = self.write_lock()?;
        self.recover_refresh_locked()?;
        let journal_path = self.data_root.join(REPLACE_JOURNAL_FILE);
        if let Some(bytes) = read_capped(&journal_path, 64 * 1024)? {
            let journal: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let archive = journal
                .get("archive")
                .and_then(Value::as_str)
                .filter(|name| is_archive_name(name));
            let store_dir = self.store_dir();
            if fs::symlink_metadata(&store_dir).is_err() {
                if let Some(archive) = archive {
                    let archived = self.backups_dir().join(archive);
                    if archived.is_dir() {
                        // Crash between the two renames: restore the prior preview store.
                        fs::rename(&archived, &store_dir)?;
                        fsync_dir(&self.backups_dir())?;
                        fsync_dir(&self.data_root)?;
                    }
                }
            }
            fs::remove_file(&journal_path)?;
            fsync_dir(&self.data_root)?;
        }
        for entry in fs::read_dir(&self.data_root)? {
            let entry = entry?;
            let name = entry.file_name();
            let is_staging = name
                .to_str()
                .is_some_and(|name| name.starts_with(STAGING_PREFIX));
            if is_staging && entry.file_type()?.is_dir() {
                fs::remove_dir_all(entry.path())?;
            }
        }
        fsync_dir(&self.data_root)?;
        Ok(())
    }

    /// Recovers an interrupted complete-store refresh. The caller must hold the exclusive write
    /// lock; malformed or ambiguous journals fail closed and are never silently discarded.
    pub(crate) fn recover_refresh_locked(&self) -> Result<(), StoreError> {
        let journal_path = self.data_root.join(REFRESH_JOURNAL_FILE);
        let Some(bytes) = read_capped(&journal_path, 16 * 1024)? else {
            return Ok(());
        };
        let journal: Value = serde_json::from_slice(&bytes)
            .map_err(|_| StoreError::Invalid("refresh journal is malformed"))?;
        let object = journal
            .as_object()
            .ok_or(StoreError::Invalid("refresh journal is malformed"))?;
        if object.get("schema").and_then(Value::as_u64) != Some(1) {
            return Err(StoreError::Invalid(
                "refresh journal version is unsupported",
            ));
        }
        let generation = object
            .get("generation")
            .and_then(Value::as_str)
            .filter(|id| is_refresh_generation(id))
            .ok_or(StoreError::Invalid("refresh journal is malformed"))?;
        let phase = object
            .get("phase")
            .and_then(Value::as_str)
            .ok_or(StoreError::Invalid("refresh journal is malformed"))?;
        if !matches!(phase, "prepared" | "committed") {
            return Err(StoreError::Invalid("refresh journal is malformed"));
        }
        let staging_name = format!("{STAGING_PREFIX}refresh-{generation}");
        let archive_name = format!("refresh-store-{generation}");
        if object.get("staging").and_then(Value::as_str) != Some(&staging_name)
            || object.get("archive").and_then(Value::as_str) != Some(&archive_name)
        {
            return Err(StoreError::Invalid("refresh journal is malformed"));
        }
        let staging = self.data_root.join(&staging_name);
        let current = self.store_dir();
        let archived = self.backups_dir().join(&archive_name);
        let stage_exists = plain_directory_exists(&staging)?;
        let current_exists = plain_directory_exists(&current)?;
        let archive_exists = plain_directory_exists(&archived)?;

        match (phase, current_exists, archive_exists, stage_exists) {
            ("prepared", true, false, _) => {
                if stage_exists {
                    fs::remove_dir_all(&staging)?;
                    fsync_dir(&self.data_root)?;
                }
                remove_refresh_journal(&journal_path, &self.data_root)?;
            }
            ("prepared", false, true, _) => {
                // Crash after moving the prior generation aside but before installing the stage.
                fs::rename(&archived, &current)?;
                fsync_dir(&self.backups_dir())?;
                fsync_dir(&self.data_root)?;
                if stage_exists {
                    fs::remove_dir_all(&staging)?;
                }
                remove_refresh_journal(&journal_path, &self.data_root)?;
            }
            ("prepared", true, true, false) => {
                // The stage rename is atomic; its absence with both generations present means
                // the new generation was installed before the committed marker was persisted.
                atomic_write(
                    &journal_path,
                    &node_json_bytes(&refresh_journal_value("committed", generation)),
                )?;
                remove_refresh_journal(&journal_path, &self.data_root)?;
            }
            ("committed", true, true, _) => {
                if stage_exists {
                    fs::remove_dir_all(&staging)?;
                }
                remove_refresh_journal(&journal_path, &self.data_root)?;
            }
            _ => return Err(StoreError::Invalid("refresh journal state is ambiguous")),
        }
        Ok(())
    }

    /// Atomically installs a fully staged refresh generation. The caller must hold the exclusive
    /// write lock and the staging folder must be this transaction's private sibling directory.
    pub(crate) fn publish_refresh_generation(
        &self,
        staging: &Path,
        generation: &str,
    ) -> Result<(), StoreError> {
        if !is_refresh_generation(generation)
            || staging.parent() != Some(self.data_root.as_path())
            || staging.file_name().and_then(|name| name.to_str())
                != Some(format!("{STAGING_PREFIX}refresh-{generation}").as_str())
            || !plain_directory_exists(staging)?
            || !plain_directory_exists(&self.store_dir())?
        {
            return Err(StoreError::Invalid("refresh staging folder is invalid"));
        }
        let backups = self.backups_dir();
        create_private_dir(&backups, true)?;
        let archived = backups.join(format!("refresh-store-{generation}"));
        if fs::symlink_metadata(&archived).is_ok() {
            return Err(StoreError::Invalid("refresh generation already exists"));
        }
        let journal_path = self.data_root.join(REFRESH_JOURNAL_FILE);
        atomic_write(
            &journal_path,
            &node_json_bytes(&refresh_journal_value("prepared", generation)),
        )?;
        if let Err(error) = fs::rename(self.store_dir(), &archived) {
            remove_refresh_journal(&journal_path, &self.data_root)?;
            return Err(error.into());
        }
        let sync_prior_move = fsync_dir(&backups).and_then(|_| fsync_dir(&self.data_root));
        if let Err(error) = sync_prior_move {
            if fs::rename(&archived, self.store_dir()).is_ok() {
                let _ = fsync_dir(&backups);
                let _ = fsync_dir(&self.data_root);
                let _ = remove_refresh_journal(&journal_path, &self.data_root);
            }
            return Err(error.into());
        }
        if let Err(error) = fs::rename(staging, self.store_dir()) {
            if fs::rename(&archived, self.store_dir()).is_ok() {
                let _ = fsync_dir(&backups);
                let _ = fsync_dir(&self.data_root);
                remove_refresh_journal(&journal_path, &self.data_root)?;
            }
            return Err(error.into());
        }
        if let Err(error) = fsync_dir(&self.data_root) {
            // The second rename is the visibility point. If persisting that rename fails, try to
            // put the complete staged tree back under its temporary name and restore the prior
            // generation before reporting failure. A prepared journal remains recoverable if a
            // second filesystem error prevents the rollback.
            let restored = fs::rename(self.store_dir(), staging)
                .and_then(|_| fs::rename(&archived, self.store_dir()));
            if restored.is_ok() {
                let _ = fs::remove_dir_all(staging);
                let _ = fsync_dir(&backups);
                let _ = fsync_dir(&self.data_root);
                let _ = remove_refresh_journal(&journal_path, &self.data_root);
            }
            return Err(error.into());
        }
        // The generation is now the commit point. If updating or removing the journal fails,
        // startup can infer this completed rename from the prepared journal and directory names.
        let _ = atomic_write(
            &journal_path,
            &node_json_bytes(&refresh_journal_value("committed", generation)),
        );
        let _ = remove_refresh_journal(&journal_path, &self.data_root);
        Ok(())
    }

    /// Reports whether the store is empty, ready (with its manifest), or damaged.
    pub fn condition(&self) -> Result<StoreCondition, StoreError> {
        let store_dir = self.store_dir();
        match fs::symlink_metadata(&store_dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(StoreCondition::Empty)
            }
            Err(error) => return Err(error.into()),
            Ok(metadata) if !metadata.file_type().is_dir() => {
                return Ok(StoreCondition::Damaged(
                    "the store folder is not a directory",
                ))
            }
            Ok(_) => {}
        }
        match read_capped(&store_dir.join(MANIFEST_FILE), 1024 * 1024) {
            Ok(Some(bytes)) => Ok(match parse_manifest(&bytes) {
                Ok(summary) => StoreCondition::Ready(summary),
                Err(reason) => StoreCondition::Damaged(reason),
            }),
            Ok(None) => Ok(StoreCondition::Damaged("the store manifest is missing")),
            Err(StoreError::TooLarge) | Err(StoreError::Invalid(_)) => {
                Ok(StoreCondition::Damaged("the store manifest is unreadable"))
            }
            Err(error) => Err(error),
        }
    }

    /// Changes only the manifest state while the caller holds the transition locks.
    ///
    /// The exact manifest digest prevents a stale readiness proof from changing newer state;
    /// parsing and reserializing the existing value preserves fields this version does not know.
    pub fn set_state_locked(
        &self,
        _write_lock: &WriteLock,
        expected_state: StoreState,
        expected_digest: &str,
        next_state: StoreState,
    ) -> Result<String, StoreError> {
        let path = self.store_dir().join(MANIFEST_FILE);
        let bytes = read_capped(&path, 1024 * 1024)?
            .ok_or(StoreError::Invalid("the store manifest is missing"))?;
        let summary = parse_manifest(&bytes)
            .map_err(|_| StoreError::Invalid("the store manifest is unreadable"))?;
        if summary.state != expected_state || summary.digest != expected_digest {
            return Err(StoreError::StoreChanged);
        }
        let mut value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| StoreError::Invalid("the store manifest is unreadable"))?;
        let object = value
            .as_object_mut()
            .ok_or(StoreError::Invalid("the store manifest is unreadable"))?;
        object.insert(
            "state".to_owned(),
            Value::String(next_state.as_str().to_owned()),
        );
        let next_bytes = node_json_bytes(&value);
        atomic_write(&path, &next_bytes)?;
        Ok(sha256_hex(&next_bytes))
    }

    /// Reads one fixed-name store document (exact bytes and digest), or `None` when absent.
    pub fn read_document(&self, name: &str, cap: u64) -> Result<Option<DocumentBytes>, StoreError> {
        let relative = checked_relative(name)?;
        Ok(
            read_capped(&self.store_dir().join(relative), cap)?.map(|bytes| {
                let digest = sha256_hex(&bytes);
                DocumentBytes { bytes, digest }
            }),
        )
    }

    /// Applies a completion or discussion-field change against that item's prior value. The
    /// document is read again under the write lock, so an external byte change cannot make this
    /// write use stale JSON. Changes to other items and other fields merge safely.
    pub fn mutate_item(
        &self,
        item_id: &str,
        field: &str,
        expected: bool,
        value: bool,
    ) -> Result<MutationResult, StoreError> {
        self.mutate_item_with_hook(item_id, field, expected, value, || {})
    }

    /// Stores or clears one local grade under an exact dashboard-version fence.
    pub fn set_manual_grade(
        &self,
        item_id: &str,
        value: Option<&str>,
        expected_version: &str,
    ) -> Result<ManualGradeResult, StoreError> {
        if item_id.is_empty() || item_id.len() > 200 || !is_digest(expected_version) {
            return Err(StoreError::Invalid("invalid local grade mutation"));
        }
        let normalized = value.map(str::trim);
        if normalized.is_some_and(|grade| grade.is_empty() || grade.len() > 80) {
            return Err(StoreError::Invalid(
                "local grade must be a nonempty value up to 80 characters",
            ));
        }
        let _lock = self.write_lock()?;
        if !matches!(self.condition()?, StoreCondition::Ready(_)) {
            return Err(StoreError::Invalid("the app store is not ready for writes"));
        }
        let current = self
            .read_document(
                "coursework.json",
                crate::config::ReadLimits::PRODUCTION.max_document_bytes,
            )?
            .ok_or(StoreError::Invalid("coursework document is missing"))?;
        if current.digest != expected_version {
            return Err(StoreError::Conflict);
        }
        let mut document: Value = serde_json::from_slice(&current.bytes)
            .map_err(|_| StoreError::Invalid("coursework document is malformed"))?;
        let item = coursework_item_mut(&mut document, item_id)?;
        match normalized {
            Some(grade) => {
                item.insert(
                    "manualGradeObservation".to_owned(),
                    serde_json::json!({ "version": 1, "value": grade }),
                );
            }
            None => {
                item.remove("manualGradeObservation");
            }
        }
        let bytes = node_json_bytes(&document);
        atomic_write(&self.store_dir().join("coursework.json"), &bytes)?;
        Ok(ManualGradeResult {
            manual_grade: normalized.map(str::to_owned),
            manual_grade_version: normalized.map(|_| 1),
            version: sha256_hex(&bytes),
        })
    }

    /// Resolves a held link only when the exact document the user reviewed is still current.
    /// Confirmation adds source facts to the selected immutable local record; keeping distinct
    /// materializes the held source record without guessing a title/date match.
    pub fn resolve_pending_source_link(
        &self,
        pending_id: &str,
        local_item_id: &str,
        decision: &str,
        expected_version: &str,
    ) -> Result<PendingLinkResult, StoreError> {
        if pending_id.is_empty()
            || pending_id.len() > 1024
            || local_item_id.len() > 200
            || !matches!(decision, "confirm" | "reject")
            || !is_digest(expected_version)
        {
            return Err(StoreError::Invalid("invalid source link decision"));
        }
        let _lock = self.write_lock()?;
        if !matches!(self.condition()?, StoreCondition::Ready(_)) {
            return Err(StoreError::Invalid("the app store is not ready for writes"));
        }
        let current = self
            .read_document(
                "coursework.json",
                crate::config::ReadLimits::PRODUCTION.max_document_bytes,
            )?
            .ok_or(StoreError::Invalid("coursework document is missing"))?;
        if current.digest != expected_version {
            return Err(StoreError::Conflict);
        }
        let mut document: Value = serde_json::from_slice(&current.bytes)
            .map_err(|_| StoreError::Invalid("coursework document is malformed"))?;
        let (index, pending) = {
            let links = document
                .get("pendingSourceLinks")
                .and_then(Value::as_array)
                .ok_or(StoreError::Invalid("pending source links are malformed"))?;
            let index = links
                .iter()
                .position(|entry| entry.get("id").and_then(Value::as_str) == Some(pending_id))
                .ok_or(StoreError::Conflict)?;
            (
                index,
                links[index]
                    .as_object()
                    .cloned()
                    .ok_or(StoreError::Invalid("pending source link is malformed"))?,
            )
        };
        let course = pending
            .get("course")
            .and_then(Value::as_str)
            .ok_or(StoreError::Invalid("pending source link is malformed"))?;
        let source_id = pending
            .get("localId")
            .and_then(Value::as_str)
            .ok_or(StoreError::Invalid("pending source link is malformed"))?;
        let reference = pending
            .get("reference")
            .cloned()
            .filter(Value::is_object)
            .ok_or(StoreError::Invalid("pending source link is malformed"))?;
        let (institution, reference_course, source, _, _) = source_reference_parts(&reference)
            .map_err(|_| StoreError::Invalid("pending source link is malformed"))?;
        if reference_course != course {
            return Err(StoreError::Invalid("pending source link is malformed"));
        }
        let aliases = match pending.get("verifiedReferences") {
            None => Vec::new(),
            Some(Value::Array(values)) => values.iter().cloned().collect::<Vec<_>>(),
            _ => return Err(StoreError::Invalid("pending source link is malformed")),
        };
        for alias in &aliases {
            let (alias_institution, alias_course, _, _, _) = source_reference_parts(alias)
                .map_err(|_| StoreError::Invalid("pending source link is malformed"))?;
            if alias_institution != institution || alias_course != course {
                return Err(StoreError::Invalid("pending source link is malformed"));
            }
        }
        let mut references = Vec::with_capacity(aliases.len() + 1);
        references.push(reference.clone());
        references.extend(aliases.iter().cloned());
        let mut incoming_keys = std::collections::HashSet::new();
        for reference in &references {
            if !incoming_keys.insert(source_reference_key(reference)?) {
                return Err(StoreError::Invalid("pending source link is malformed"));
            }
        }
        let fields = pending
            .get("fields")
            .and_then(Value::as_object)
            .ok_or(StoreError::Invalid("pending source link is malformed"))?;
        if fields.keys().any(|field| !source_owned_field(field)) {
            return Err(StoreError::Invalid("pending source link is malformed"));
        }
        let observed_at = checked_observed_at(pending.get("observedAt"))?;
        let mut reference_owners = std::collections::HashMap::new();
        let mut item_ids = std::collections::HashSet::new();
        for collection in ["items", "archivedForecastItems"] {
            let Some(items) = document.get(collection) else {
                continue;
            };
            let items = items
                .as_array()
                .ok_or(StoreError::Invalid("coursework items are malformed"))?;
            for item in items {
                let item = item
                    .as_object()
                    .ok_or(StoreError::Invalid("coursework items are malformed"))?;
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Invalid("coursework items are malformed"))?;
                if !item_ids.insert(id.to_owned()) {
                    return Err(StoreError::Invalid("coursework items are malformed"));
                }
                let item_references = match item.get("sourceReferences") {
                    None => continue,
                    Some(Value::Array(values)) => values,
                    _ => return Err(StoreError::Invalid("source references are malformed")),
                };
                for item_reference in item_references {
                    let key = source_reference_key(item_reference)?;
                    if reference_owners.insert(key, id.to_owned()).is_some() {
                        return Err(StoreError::Invalid("source references are malformed"));
                    }
                }
            }
        }
        if decision == "confirm" {
            let candidates = pending
                .get("candidateIds")
                .and_then(Value::as_array)
                .ok_or(StoreError::Invalid("pending source link is malformed"))?;
            if !candidates
                .iter()
                .any(|id| id.as_str() == Some(local_item_id))
            {
                return Err(StoreError::Conflict);
            }
            let selected = document
                .get("items")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item.get("id").and_then(Value::as_str) == Some(local_item_id))
                })
                .and_then(Value::as_object)
                .ok_or(StoreError::ItemMissing)?;
            if selected.get("course").and_then(Value::as_str) != Some(course) {
                return Err(StoreError::Conflict);
            }
            if references.iter().any(|reference| {
                reference_owners
                    .get(&source_reference_key(reference).expect("validated reference"))
                    .is_some_and(|owner| owner != local_item_id)
            }) {
                return Err(StoreError::Conflict);
            }
            let item = coursework_item_mut(&mut document, local_item_id)?;
            let item_references = item
                .entry("sourceReferences".to_owned())
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .ok_or(StoreError::Invalid("source references are malformed"))?;
            for reference in &references {
                if !item_references.iter().any(|candidate| {
                    source_reference_key(candidate).expect("validated source reference")
                        == source_reference_key(reference).expect("validated source reference")
                }) {
                    item_references.push(reference.clone());
                }
            }
            let mut observations = match item.remove("fieldObservations") {
                None => Map::new(),
                Some(Value::Object(observations)) => observations,
                Some(_) => return Err(StoreError::Invalid("field observations are malformed")),
            };
            for (field, value) in fields {
                merge_source_field(
                    item,
                    &mut observations,
                    field,
                    SourceFact {
                        owner: reference.clone(),
                        value: value.clone(),
                        observed_at: observed_at.clone(),
                    },
                )?;
            }
            if !observations.is_empty() {
                item.insert("fieldObservations".to_owned(), Value::Object(observations));
            }
        } else {
            let items = document
                .get_mut("items")
                .and_then(Value::as_array_mut)
                .ok_or(StoreError::Invalid("coursework items are malformed"))?;
            if item_ids.contains(source_id) {
                return Err(StoreError::Conflict);
            }
            if reference_owners.contains_key(&source_reference_key(&reference)?) {
                return Err(StoreError::Conflict);
            }
            let mut item = Map::new();
            item.insert("id".to_owned(), Value::String(source_id.to_owned()));
            item.insert("course".to_owned(), Value::String(course.to_owned()));
            item.insert("source".to_owned(), Value::String(source.to_owned()));
            let mut new_references = vec![reference.clone()];
            for alias in aliases {
                if !reference_owners.contains_key(&source_reference_key(&alias)?) {
                    new_references.push(alias);
                }
            }
            item.insert("sourceReferences".to_owned(), Value::Array(new_references));
            let mut observations = Map::new();
            for (field, value) in fields {
                merge_source_field(
                    &mut item,
                    &mut observations,
                    field,
                    SourceFact {
                        owner: reference.clone(),
                        value: value.clone(),
                        observed_at: observed_at.clone(),
                    },
                )?;
            }
            if !observations.is_empty() {
                item.insert("fieldObservations".to_owned(), Value::Object(observations));
            }
            items.push(Value::Object(item));
        }
        document
            .get_mut("pendingSourceLinks")
            .and_then(Value::as_array_mut)
            .ok_or(StoreError::Invalid("pending source links are malformed"))?
            .remove(index);
        let bytes = node_json_bytes(&document);
        atomic_write(&self.store_dir().join("coursework.json"), &bytes)?;
        Ok(PendingLinkResult {
            version: sha256_hex(&bytes),
        })
    }

    fn mutate_item_with_hook(
        &self,
        item_id: &str,
        field: &str,
        expected: bool,
        value: bool,
        after_first_read: impl FnOnce(),
    ) -> Result<MutationResult, StoreError> {
        if item_id.is_empty()
            || item_id.len() > 200
            || !matches!(
                field,
                "done" | "discussionPostDone" | "discussionRepliesDone"
            )
        {
            return Err(StoreError::Invalid("invalid coursework mutation"));
        }
        let first = self.read_document(
            "coursework.json",
            crate::config::ReadLimits::PRODUCTION.max_document_bytes,
        )?;
        after_first_read();
        let _lock = self.write_lock()?;
        if !matches!(self.condition()?, StoreCondition::Ready(_)) {
            return Err(StoreError::Invalid("the app store is not ready for writes"));
        }
        let current = self
            .read_document(
                "coursework.json",
                crate::config::ReadLimits::PRODUCTION.max_document_bytes,
            )?
            .ok_or(StoreError::Invalid("coursework document is missing"))?;
        // Reuse the first read only when its exact bytes still match under the lock. Otherwise
        // parse the fresh locked read, then let the per-item prior value decide the conflict.
        let source = match first.as_ref() {
            Some(read) if read.digest == current.digest => &read.bytes,
            _ => &current.bytes,
        };
        let mut document: Value = serde_json::from_slice(source)
            .map_err(|_| StoreError::Invalid("coursework document is malformed"))?;
        let items = document
            .get_mut("items")
            .and_then(Value::as_array_mut)
            .ok_or(StoreError::Invalid("coursework items are malformed"))?;
        let item = items
            .iter_mut()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(item_id))
            .and_then(Value::as_object_mut)
            .ok_or(StoreError::ItemMissing)?;
        if field != "done" && item.get("kind").and_then(Value::as_str) != Some("discussion") {
            return Err(StoreError::Invalid(
                "discussion progress does not apply to this item",
            ));
        }
        let prior = item.get(field).and_then(Value::as_bool) == Some(true);
        if prior != expected {
            return Err(StoreError::ItemConflict(prior));
        }
        item.insert(field.to_owned(), Value::Bool(value));
        let now = SystemTime::now();
        if field == "done" {
            let stamp = utc_stamp(now).iso;
            let iso = format!(
                "{}.{:03}Z",
                stamp.trim_end_matches('Z'),
                now.duration_since(UNIX_EPOCH)
                    .unwrap_or(Duration::ZERO)
                    .subsec_millis()
            );
            item.insert(
                "doneAt".to_owned(),
                if value {
                    Value::String(iso)
                } else {
                    Value::Null
                },
            );
        }
        let completed = item.get("done").and_then(Value::as_bool) == Some(true);
        let completed_at = if field == "done" && value {
            Some(
                now.duration_since(UNIX_EPOCH)
                    .unwrap_or(Duration::ZERO)
                    .as_millis() as i64,
            )
        } else {
            None
        };
        let discussion_post_done =
            item.get("discussionPostDone").and_then(Value::as_bool) == Some(true);
        let discussion_replies_done =
            item.get("discussionRepliesDone").and_then(Value::as_bool) == Some(true);
        let bytes = node_json_bytes(&document);
        atomic_write(&self.store_dir().join("coursework.json"), &bytes)?;
        Ok(MutationResult {
            completed,
            completed_at,
            discussion_post_done,
            discussion_replies_done,
            version: sha256_hex(&bytes),
        })
    }

    /// Replaces a JSON document under the write lock, preserving every field of `value`.
    ///
    /// `expected` is the digest of the exact bytes the caller read, or `None` if the caller
    /// expects the document to be absent. Any difference returns [`StoreError::Conflict`] and
    /// leaves the document untouched. Returns the new digest.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn replace_json_document(
        &self,
        name: &str,
        expected: Option<&str>,
        value: &Value,
    ) -> Result<String, StoreError> {
        let relative = checked_relative(name)?;
        let _lock = self.write_lock()?;
        let target = self.store_dir().join(relative);
        let current = read_capped(&target, u64::MAX >> 1)?.map(|bytes| sha256_hex(&bytes));
        if current.as_deref() != expected {
            return Err(StoreError::Conflict);
        }
        let bytes = node_json_bytes(value);
        atomic_write(&target, &bytes)?;
        Ok(sha256_hex(&bytes))
    }

    /// Atomically adopts a fully validated staging folder as the store.
    ///
    /// Runs under the write lock. `expected` is the condition observed when the import began;
    /// any change since then aborts. An existing preview store is first renamed into
    /// `backups/store-<UTC>-<id>` (never deleted); an authoritative or damaged store is refused.
    /// Returns the archive folder name when a preview store was replaced.
    pub fn adopt_staging(
        &self,
        staging: &Path,
        expected: &StoreCondition,
    ) -> Result<Option<String>, StoreError> {
        let _lock = self.write_lock()?;
        let current = self.condition()?;
        if &current != expected {
            return Err(StoreError::StoreChanged);
        }
        let store_dir = self.store_dir();
        match current {
            StoreCondition::Empty => {
                fs::rename(staging, &store_dir)?;
                fsync_dir(&self.data_root)?;
                Ok(None)
            }
            StoreCondition::Ready(ManifestSummary {
                state: StoreState::Preview,
                ..
            }) => {
                let backups = self.backups_dir();
                create_private_dir(&backups, true)?;
                let archive = format!(
                    "store-{}-{}",
                    utc_stamp(SystemTime::now()).compact,
                    &uuid::Uuid::new_v4().simple().to_string()[..8]
                );
                let archived = backups.join(&archive);
                let journal_path = self.data_root.join(REPLACE_JOURNAL_FILE);
                atomic_write(
                    &journal_path,
                    &node_json_bytes(&serde_json::json!({ "archive": archive })),
                )?;
                fs::rename(&store_dir, &archived)?;
                fsync_dir(&backups)?;
                fsync_dir(&self.data_root)?;
                if let Err(error) = fs::rename(staging, &store_dir) {
                    fs::rename(&archived, &store_dir)?;
                    fsync_dir(&self.data_root)?;
                    fs::remove_file(&journal_path)?;
                    return Err(error.into());
                }
                fsync_dir(&self.data_root)?;
                fs::remove_file(&journal_path)?;
                fsync_dir(&self.data_root)?;
                Ok(Some(archive))
            }
            StoreCondition::Ready(_) => Err(StoreError::Invalid(
                "an authoritative store is never replaced by import",
            )),
            StoreCondition::Damaged(_) => Err(StoreError::Invalid(
                "the app store needs recovery before an import",
            )),
        }
    }
}

fn is_refresh_generation(generation: &str) -> bool {
    generation.len() == 32 && generation.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn refresh_journal_value(phase: &str, generation: &str) -> Value {
    serde_json::json!({
        "schema": 1,
        "phase": phase,
        "generation": generation,
        "staging": format!("{STAGING_PREFIX}refresh-{generation}"),
        "archive": format!("refresh-store-{generation}"),
    })
}

fn plain_directory_exists(path: &Path) -> Result<bool, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(true),
        Ok(_) => Err(StoreError::Invalid("refresh journal names a non-directory")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn remove_refresh_journal(path: &Path, data_root: &Path) -> Result<(), StoreError> {
    match fs::remove_file(path) {
        Ok(()) => fsync_dir(data_root)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn is_archive_name(name: &str) -> bool {
    name.starts_with("store-")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{assert_private_tree, TempRoot};

    fn open(root: &TempRoot) -> Store {
        Store::open(root.path(), Duration::from_millis(200)).expect("open store")
    }

    fn seed_store(store: &Store, state: &str) {
        let dir = store.store_dir();
        create_private_dir(&dir, false).expect("store dir");
        let mut manifest = new_preview_manifest(1, 10, "digest", SystemTime::now());
        manifest["state"] = Value::from(state);
        atomic_write(&dir.join(MANIFEST_FILE), &node_json_bytes(&manifest)).expect("manifest");
    }

    #[test]
    fn utc_stamp_matches_known_instants() {
        assert_eq!(utc_stamp(UNIX_EPOCH).iso, "1970-01-01T00:00:00Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400); // 2000-02-29T00:00:00Z
        assert_eq!(utc_stamp(leap).iso, "2000-02-29T00:00:00Z");
        let instant = UNIX_EPOCH + Duration::from_secs(1_790_172_296); // 2026-09-23T14:04:56Z
        let stamp = utc_stamp(instant);
        assert_eq!(stamp.iso, "2026-09-23T14:04:56Z");
        assert_eq!(stamp.compact, "20260923T140456Z");
    }

    #[test]
    fn empty_data_root_opens_private() {
        let root = TempRoot::new("store-empty");
        let store = open(&root);
        assert_eq!(store.condition().expect("condition"), StoreCondition::Empty);
        assert_private_tree(root.path());
    }

    /// A denied second open must not touch private-store metadata; only the next holder tightens
    /// a loosened data root and instance lock file.
    #[test]
    fn second_store_open_is_denied_and_changes_no_modes() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;
        #[cfg(unix)]
        let mode = |path: &Path| fs::metadata(path).expect("metadata").permissions().mode() & 0o777;
        let root = TempRoot::new("store-instance");
        let lock_file = root.path().join(crate::config::INSTANCE_LOCK_FILE);
        let first = open(&root);
        #[cfg(unix)]
        {
            fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).expect("loosen");
            fs::set_permissions(&lock_file, fs::Permissions::from_mode(0o644)).expect("loosen");
        }
        let error =
            Store::open(root.path(), Duration::from_millis(50)).expect_err("second instance");
        assert!(matches!(
            error,
            StoreError::Lock(LockError::AnotherInstance)
        ));
        #[cfg(unix)]
        {
            assert_eq!(
                mode(root.path()),
                0o755,
                "denied open left the data root alone"
            );
            assert_eq!(
                mode(&lock_file),
                0o644,
                "denied open left the lock file alone"
            );
        }
        drop(first);
        let _reopened = open(&root);
        #[cfg(unix)]
        {
            assert_eq!(
                mode(root.path()),
                0o700,
                "the holder tightened the data root"
            );
            assert_eq!(
                mode(&lock_file),
                0o600,
                "the holder tightened the lock file"
            );
        }
        #[cfg(not(unix))]
        let _ = lock_file;
    }

    #[test]
    fn unknown_fields_survive_a_store_round_trip() {
        let root = TempRoot::new("store-roundtrip");
        let store = open(&root);
        seed_store(&store, "preview");
        let original = serde_json::json!({
            "generated": "2026-09-01T12:00:00Z",
            "futureTopLevel": {"nested": [1, 2.5, {"deep": null}], "unicode": "caf\u{e9} \u{2014} \u{1F4DA}"},
            "courses": [{"key": "syn-101", "code": "SYN 101", "futureCourseField": true}],
            "items": [{"id": "a1", "course": "syn-101", "title": "Essay", "at": null, "zUnknown": "kept", "aUnknown": 0}],
        });
        let node_bytes = node_json_bytes(&original);
        atomic_write(&store.store_dir().join("coursework.json"), &node_bytes).expect("seed");
        let read = store
            .read_document("coursework.json", 1 << 20)
            .expect("read")
            .expect("present");
        assert_eq!(read.digest, sha256_hex(&node_bytes));
        let value: Value = serde_json::from_slice(&read.bytes).expect("json");
        let written = store
            .replace_json_document("coursework.json", Some(&read.digest), &value)
            .expect("write");
        let reread = store
            .read_document("coursework.json", 1 << 20)
            .expect("read")
            .expect("present");
        assert_eq!(
            reread.bytes, node_bytes,
            "an unchanged value rewrites byte-identically"
        );
        assert_eq!(reread.digest, written);
        let keys: Vec<&str> = value["items"][0]
            .as_object()
            .expect("item")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["id", "course", "title", "at", "zUnknown", "aUnknown"],
            "insertion order kept"
        );
        assert_private_tree(root.path());
    }

    #[test]
    fn per_item_mutations_merge_and_conflict_without_stale_writes() {
        let root = TempRoot::new("store-mutations");
        let store = open(&root);
        seed_store(&store, "preview");
        let file = store.store_dir().join("coursework.json");
        let initial = serde_json::json!({ "future": { "nested": 7 }, "courses": [{ "key": "synthetic" }], "items": [
            { "id": "one", "course": "synthetic", "kind": "discussion", "done": false, "discussionPostDone": false, "discussionRepliesDone": false, "unknown": [1, 2] },
            { "id": "two", "course": "synthetic", "kind": "assignment", "done": false, "unknown": true }
        ] });
        atomic_write(&file, &node_json_bytes(&initial)).unwrap();
        store
            .mutate_item("one", "discussionPostDone", false, true)
            .unwrap();
        store.mutate_item("two", "done", false, true).unwrap();
        store.mutate_item("one", "done", false, true).unwrap();
        store
            .mutate_item("one", "discussionRepliesDone", false, true)
            .unwrap();
        let before_conflict = fs::read(&file).unwrap();
        assert!(matches!(
            store.mutate_item("one", "discussionPostDone", false, false),
            Err(StoreError::ItemConflict(true))
        ));
        assert!(matches!(
            store.mutate_item("two", "discussionPostDone", false, true),
            Err(StoreError::Invalid(
                "discussion progress does not apply to this item"
            ))
        ));
        assert_eq!(fs::read(&file).unwrap(), before_conflict);
        let mut external: Value = serde_json::from_slice(&before_conflict).unwrap();
        external["future"]["external"] = Value::Bool(true);
        store
            .mutate_item_with_hook("two", "done", true, false, || {
                atomic_write(&file, &node_json_bytes(&external)).unwrap();
            })
            .unwrap();
        let final_value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            final_value["future"],
            serde_json::json!({ "nested": 7, "external": true })
        );
        assert_eq!(
            final_value["items"][0]["unknown"],
            serde_json::json!([1, 2])
        );
        assert_eq!(final_value["items"][0]["discussionPostDone"], true);
        assert_eq!(final_value["items"][0]["discussionRepliesDone"], true);
        assert_eq!(final_value["items"][0]["done"], true);
        assert_eq!(final_value["items"][1]["done"], false);
        assert_eq!(final_value["items"][1]["unknown"], true);
    }

    #[test]
    fn native_confirmation_promotes_api_facts_and_preserves_ical_and_local_fields() {
        let root = TempRoot::new("store-native-link-grade");
        let store = open(&root);
        seed_store(&store, "preview");
        let file = store.store_dir().join("coursework.json");
        let ical = serde_json::json!({"institution": "synthetic.invalid", "course": "synthetic", "source": "ical", "id": "event-1"});
        let canvas = serde_json::json!({"institution": "synthetic.invalid", "course": "synthetic", "source": "canvas", "id": "1"});
        let initial = serde_json::json!({
            "courses": [{"key": "synthetic"}],
            "items": [{
                "id": "local-1", "course": "synthetic", "kind": "assignment",
                "done": true, "notes": "local", "unknown": {"kept": true}, "grade": "iCal grade", "at": "2026-10-01T12:00:00Z",
                "sourceReferences": [ical],
                "fieldObservations": {
                    "grade": {"owner": ical, "value": "iCal grade"},
                    "at": {"owner": ical, "value": "2026-10-01T12:00:00Z", "observedAt": "2026-09-01T12:00:00Z"}
                },
                "manualGradeObservation": {"version": 1, "value": "synthetic-pdf", "source": "pdf"}
            }],
            "pendingSourceLinks": [{
                "id": "pending-1", "localId": "canvas-1", "course": "synthetic",
                "reference": canvas,
                "verifiedReferences": [{"institution": "synthetic.invalid", "course": "synthetic", "source": "canvas", "id": "alias-1"}],
                "fields": {"title": "Synthetic title", "grade": "A-", "score": 97, "at": "2026-10-02T12:00:00Z"},
                "observedAt": "2026-09-02T12:00:00Z",
                "candidateIds": ["local-1"]
            }]
        });
        atomic_write(&file, &node_json_bytes(&initial)).unwrap();
        let before = store
            .read_document("coursework.json", 1 << 20)
            .unwrap()
            .unwrap();
        let bytes_before_stale = fs::read(&file).unwrap();
        assert!(matches!(
            store.set_manual_grade("local-1", Some("A-"), &"0".repeat(64)),
            Err(StoreError::Conflict)
        ));
        assert_eq!(fs::read(&file).unwrap(), bytes_before_stale);
        assert!(matches!(
            store.resolve_pending_source_link("pending-1", "wrong-item", "confirm", &before.digest),
            Err(StoreError::Conflict)
        ));
        assert_eq!(fs::read(&file).unwrap(), bytes_before_stale);
        assert!(matches!(
            store.set_manual_grade("local-1", Some("  "), &before.digest),
            Err(StoreError::Invalid(_))
        ));
        assert_eq!(fs::read(&file).unwrap(), bytes_before_stale);
        let linked = store
            .resolve_pending_source_link("pending-1", "local-1", "confirm", &before.digest)
            .unwrap();
        let pdf_linked: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            pdf_linked["items"][0]["manualGradeObservation"],
            serde_json::json!({"version": 1, "value": "synthetic-pdf", "source": "pdf"})
        );
        let grade = store
            .set_manual_grade("local-1", Some(" A- "), &linked.version)
            .unwrap();
        assert_eq!(grade.manual_grade.as_deref(), Some("A-"));
        let after: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        let item = &after["items"][0];
        assert_eq!(item["id"], "local-1");
        assert_eq!(item["done"], true);
        assert_eq!(item["notes"], "local");
        assert_eq!(item["unknown"], serde_json::json!({"kept": true}));
        assert_eq!(
            item["manualGradeObservation"],
            serde_json::json!({"version": 1, "value": "A-"})
        );
        assert_eq!(item["title"], "Synthetic title");
        assert_eq!(item["score"], 97);
        assert_eq!(item["grade"], "A-");
        assert_eq!(item["at"], "2026-10-02T12:00:00Z");
        assert_eq!(
            item["sourceReferences"],
            serde_json::json!([ical, canvas, {"institution": "synthetic.invalid", "course": "synthetic", "source": "canvas", "id": "alias-1"}])
        );
        assert_eq!(item["fieldObservations"]["grade"]["owner"], canvas);
        assert_eq!(item["fieldObservations"]["grade"]["value"], "A-");
        assert_eq!(
            item["fieldObservations"]["grade"]["alternatives"],
            serde_json::json!([{"owner": ical, "value": "iCal grade"}])
        );
        assert_eq!(item["fieldObservations"]["at"]["owner"], canvas);
        assert_eq!(
            item["fieldObservations"]["at"]["observedAt"],
            "2026-09-02T12:00:00Z"
        );
        assert_eq!(after["pendingSourceLinks"], serde_json::json!([]));
        let bytes_before_stale = fs::read(&file).unwrap();
        assert!(matches!(
            store.resolve_pending_source_link("pending-1", "local-1", "confirm", &grade.version),
            Err(StoreError::Conflict)
        ));
        assert_eq!(fs::read(&file).unwrap(), bytes_before_stale);
    }

    #[test]
    fn native_confirmation_refuses_primary_or_alias_owned_by_another_item() {
        let root = TempRoot::new("store-native-link-collision");
        let store = open(&root);
        seed_store(&store, "preview");
        let file = store.store_dir().join("coursework.json");
        let primary = serde_json::json!({"institution": "synthetic.invalid", "course": "synthetic", "source": "canvas", "id": "1"});
        let claimed_alias = serde_json::json!({"institution": "synthetic.invalid", "course": "synthetic", "source": "canvas", "id": "alias"});
        let initial = serde_json::json!({
            "courses": [{"key": "synthetic"}],
            "items": [
                {"id": "local-1", "course": "synthetic", "done": true, "notes": "keep"},
                {"id": "other", "course": "synthetic", "sourceReferences": [claimed_alias]}
            ],
            "pendingSourceLinks": [{
                "id": "pending-1", "localId": "canvas-1", "course": "synthetic", "reference": primary,
                "verifiedReferences": [claimed_alias], "fields": {"title": "Synthetic"}, "candidateIds": ["local-1"]
            }]
        });
        atomic_write(&file, &node_json_bytes(&initial)).unwrap();
        let version = store
            .read_document("coursework.json", 1 << 20)
            .unwrap()
            .unwrap()
            .digest;
        let before = fs::read(&file).unwrap();
        assert!(matches!(
            store.resolve_pending_source_link("pending-1", "local-1", "confirm", &version),
            Err(StoreError::Conflict)
        ));
        assert_eq!(fs::read(&file).unwrap(), before);
    }

    #[test]
    fn native_keep_distinct_keeps_claimed_alias_out_and_retains_json_values() {
        let root = TempRoot::new("store-native-link-keep-distinct");
        let store = open(&root);
        seed_store(&store, "preview");
        let file = store.store_dir().join("coursework.json");
        let primary = serde_json::json!({"institution": "synthetic.invalid", "course": "synthetic", "source": "canvas", "id": "1"});
        let claimed = serde_json::json!({"institution": "synthetic.invalid", "course": "synthetic", "source": "ical", "id": "claimed"});
        let free = serde_json::json!({"institution": "synthetic.invalid", "course": "synthetic", "source": "ical", "id": "free"});
        let initial = serde_json::json!({
            "courses": [{"key": "synthetic"}],
            "items": [{"id": "other", "course": "synthetic", "sourceReferences": [claimed], "unknown": true}],
            "pendingSourceLinks": [{
                "id": "pending-1", "localId": "canvas-1", "course": "synthetic", "reference": primary,
                "verifiedReferences": [claimed, free], "fields": {"grade": "97", "score": 97}, "candidateIds": ["other"]
            }]
        });
        atomic_write(&file, &node_json_bytes(&initial)).unwrap();
        let version = store
            .read_document("coursework.json", 1 << 20)
            .unwrap()
            .unwrap()
            .digest;
        store
            .resolve_pending_source_link("pending-1", "ignored", "reject", &version)
            .unwrap();
        let after: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        let item = &after["items"][1];
        assert_eq!(item["id"], "canvas-1");
        assert_eq!(item["sourceReferences"], serde_json::json!([primary, free]));
        assert_eq!(item["grade"], "97");
        assert_eq!(item["score"], 97);
        assert_eq!(
            item["fieldObservations"]["grade"],
            serde_json::json!({"owner": primary, "value": "97"})
        );
        assert_eq!(after["items"][0]["unknown"], true);
        assert_eq!(after["pendingSourceLinks"], serde_json::json!([]));
    }

    #[test]
    fn native_keep_distinct_refuses_a_primary_owned_by_another_item() {
        let root = TempRoot::new("store-native-link-keep-distinct-collision");
        let store = open(&root);
        seed_store(&store, "preview");
        let file = store.store_dir().join("coursework.json");
        let primary = serde_json::json!({"institution": "synthetic.invalid", "course": "synthetic", "source": "canvas", "id": "1"});
        let initial = serde_json::json!({
            "courses": [{"key": "synthetic"}],
            "items": [{"id": "other", "course": "synthetic", "sourceReferences": [primary]}],
            "pendingSourceLinks": [{
                "id": "pending-1", "localId": "canvas-1", "course": "synthetic", "reference": primary,
                "fields": {"title": "Synthetic"}, "candidateIds": ["other"]
            }]
        });
        atomic_write(&file, &node_json_bytes(&initial)).unwrap();
        let version = store
            .read_document("coursework.json", 1 << 20)
            .unwrap()
            .unwrap()
            .digest;
        let before = fs::read(&file).unwrap();
        assert!(matches!(
            store.resolve_pending_source_link("pending-1", "ignored", "reject", &version),
            Err(StoreError::Conflict)
        ));
        assert_eq!(fs::read(&file).unwrap(), before);
    }

    #[test]
    fn native_pending_link_stale_state_preserves_exact_bytes() {
        let root = TempRoot::new("store-native-link-stale");
        let store = open(&root);
        seed_store(&store, "preview");
        let file = store.store_dir().join("coursework.json");
        let initial = serde_json::json!({
            "courses": [{"key": "synthetic"}],
            "items": [{"id": "local-1", "course": "synthetic", "done": false}],
            "pendingSourceLinks": [{
                "id": "pending-1", "localId": "canvas-1", "course": "synthetic",
                "reference": {"institution": "synthetic.invalid", "course": "synthetic", "source": "canvas", "id": "1"},
                "fields": {"title": "Synthetic"}, "candidateIds": ["local-1"]
            }]
        });
        atomic_write(&file, &node_json_bytes(&initial)).unwrap();
        let stale = store
            .read_document("coursework.json", 1 << 20)
            .unwrap()
            .unwrap()
            .digest;
        let mut changed = initial;
        changed["items"][0]["notes"] = Value::String("new local note".to_owned());
        atomic_write(&file, &node_json_bytes(&changed)).unwrap();
        let before = fs::read(&file).unwrap();
        assert!(matches!(
            store.resolve_pending_source_link("pending-1", "local-1", "confirm", &stale),
            Err(StoreError::Conflict)
        ));
        assert_eq!(fs::read(&file).unwrap(), before);
    }

    #[test]
    fn stale_digest_conflicts_without_writing() {
        let root = TempRoot::new("store-conflict");
        let store = open(&root);
        seed_store(&store, "preview");
        let target = store.store_dir().join("canvas-conversations.json");
        atomic_write(&target, b"{\"complete\":true}\n").expect("seed");
        let before = fs::read(&target).expect("bytes");
        let stale = sha256_hex(b"{\"complete\":false}\n");
        let error = store
            .replace_json_document(
                "canvas-conversations.json",
                Some(&stale),
                &serde_json::json!({"complete": false}),
            )
            .expect_err("conflict");
        assert!(matches!(error, StoreError::Conflict));
        assert_eq!(fs::read(&target).expect("bytes"), before);
        assert!(matches!(
            store.replace_json_document("canvas-conversations.json", None, &serde_json::json!({})),
            Err(StoreError::Conflict)
        ));
    }

    #[test]
    fn document_names_are_fixed_relative_paths() {
        let root = TempRoot::new("store-names");
        let store = open(&root);
        for name in [
            "",
            "/etc/hosts",
            "../escape.json",
            "classes/../../x.json",
            "./coursework.json",
        ] {
            assert!(
                matches!(store.read_document(name, 10), Err(StoreError::InvalidName)),
                "{name}"
            );
        }
    }

    #[test]
    fn writes_hold_the_os_write_lock() {
        let root = TempRoot::new("store-writelock");
        let store = open(&root);
        seed_store(&store, "preview");
        let held =
            WriteLock::acquire(root.path(), Duration::from_millis(50)).expect("external holder");
        let error = store
            .replace_json_document(
                "canvas-profile.json",
                None,
                &serde_json::json!({"name": "Synthetic"}),
            )
            .expect_err("blocked");
        assert!(matches!(error, StoreError::Lock(LockError::Busy)));
        drop(held);
        store
            .replace_json_document(
                "canvas-profile.json",
                None,
                &serde_json::json!({"name": "Synthetic"}),
            )
            .expect("write after release");
    }

    #[test]
    fn oversized_documents_fail_instead_of_truncating() {
        let root = TempRoot::new("store-cap");
        let store = open(&root);
        seed_store(&store, "preview");
        atomic_write(&store.store_dir().join("canvas-profile.json"), &[b' '; 64]).expect("seed");
        assert!(matches!(
            store.read_document("canvas-profile.json", 63),
            Err(StoreError::TooLarge)
        ));
        assert!(store
            .read_document("canvas-profile.json", 64)
            .expect("fits")
            .is_some());
    }

    #[test]
    fn manifest_states_are_reported_and_damage_is_detected() {
        let root = TempRoot::new("store-manifest");
        let store = open(&root);
        seed_store(&store, "authoritative");
        assert!(matches!(
            store.condition().expect("condition"),
            StoreCondition::Ready(ManifestSummary {
                state: StoreState::Authoritative,
                ..
            })
        ));
        atomic_write(
            &store.store_dir().join(MANIFEST_FILE),
            b"{\"format\":\"duegood-store\",\"version\":1,\"state\":\"live\"}\n",
        )
        .expect("damage");
        assert_eq!(
            store.condition().expect("condition"),
            StoreCondition::Damaged("store manifest state is unknown")
        );
        fs::remove_file(store.store_dir().join(MANIFEST_FILE)).expect("remove");
        assert_eq!(
            store.condition().expect("condition"),
            StoreCondition::Damaged("the store manifest is missing")
        );
    }

    #[test]
    fn state_transition_preserves_unknown_manifest_fields_and_rejects_replay() {
        let root = TempRoot::new("manifest-transition");
        let store = open(&root);
        seed_store(&store, "preview");
        let path = store.store_dir().join(MANIFEST_FILE);
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest["futureField"] = serde_json::json!({ "kept": ["synthetic", 7] });
        atomic_write(&path, &node_json_bytes(&manifest)).unwrap();
        atomic_write(
            &store.store_dir().join("materials.bin"),
            b"synthetic material",
        )
        .unwrap();
        let prior = store.condition().unwrap();
        let StoreCondition::Ready(prior_summary) = prior else {
            panic!("seeded store should be ready");
        };
        let before = crate::testutil::snapshot_tree(&store.store_dir());
        let write = store.write_lock().unwrap();
        store
            .set_state_locked(
                &write,
                StoreState::Preview,
                &prior_summary.digest,
                StoreState::Authoritative,
            )
            .unwrap();
        let after = crate::testutil::snapshot_tree(&store.store_dir());
        for (name, entry) in &before {
            if name != MANIFEST_FILE {
                assert_eq!(after.get(name), Some(entry), "non-manifest entry changed");
            }
        }
        let next: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(next["state"], "authoritative");
        assert_eq!(
            next["futureField"],
            serde_json::json!({ "kept": ["synthetic", 7] })
        );
        assert!(matches!(
            store.set_state_locked(
                &write,
                StoreState::Preview,
                &prior_summary.digest,
                StoreState::Preview,
            ),
            Err(StoreError::StoreChanged)
        ));
    }

    #[test]
    fn interrupted_replacement_is_rolled_back_on_open() {
        let root = TempRoot::new("store-recover");
        {
            let store = open(&root);
            seed_store(&store, "preview");
            fs::write(
                store.store_dir().join("coursework.json"),
                b"{\"courses\":[],\"items\":[]}\n",
            )
            .expect("doc");
            // Simulate a crash after the first rename of a replacement (store moved to backups).
            create_private_dir(&store.backups_dir(), true).expect("backups");
            let archive = "store-20260923T000000Z-deadbeef";
            atomic_write(
                &root.path().join(REPLACE_JOURNAL_FILE),
                b"{\"archive\":\"store-20260923T000000Z-deadbeef\"}\n",
            )
            .expect("journal");
            fs::rename(store.store_dir(), store.backups_dir().join(archive)).expect("archive");
            create_private_dir(&root.path().join(format!("{STAGING_PREFIX}crashed")), false)
                .expect("staging");
            fs::write(
                root.path()
                    .join(format!("{STAGING_PREFIX}crashed"))
                    .join("partial.json"),
                b"{",
            )
            .expect("partial");
        }
        let store = open(&root);
        assert!(matches!(
            store.condition().expect("condition"),
            StoreCondition::Ready(ManifestSummary {
                state: StoreState::Preview,
                ..
            })
        ));
        assert!(
            store.store_dir().join("coursework.json").is_file(),
            "prior preview restored"
        );
        assert!(!root.path().join(REPLACE_JOURNAL_FILE).exists());
        assert!(
            !root
                .path()
                .join(format!("{STAGING_PREFIX}crashed"))
                .exists(),
            "incomplete staging removed"
        );
    }

    #[test]
    fn completed_replacement_journal_is_cleared_and_backup_kept() {
        let root = TempRoot::new("store-journal-done");
        {
            let store = open(&root);
            seed_store(&store, "preview");
            create_private_dir(&store.backups_dir(), true).expect("backups");
            create_private_dir(
                &store.backups_dir().join("store-20260923T000000Z-cafef00d"),
                false,
            )
            .expect("archive");
            atomic_write(
                &root.path().join(REPLACE_JOURNAL_FILE),
                b"{\"archive\":\"store-20260923T000000Z-cafef00d\"}\n",
            )
            .expect("journal");
        }
        let store = open(&root);
        assert!(matches!(
            store.condition().expect("condition"),
            StoreCondition::Ready(_)
        ));
        assert!(
            store
                .backups_dir()
                .join("store-20260923T000000Z-cafef00d")
                .is_dir(),
            "backup never deleted"
        );
        assert!(!root.path().join(REPLACE_JOURNAL_FILE).exists());
    }

    #[test]
    fn prepared_refresh_journal_rolls_back_to_the_prior_generation() {
        let root = TempRoot::new("refresh-journal-prepared");
        let generation = "0123456789abcdef0123456789abcdef";
        let store = open(&root);
        seed_store(&store, "authoritative");
        atomic_write(&store.store_dir().join("prior.marker"), b"prior").unwrap();
        create_private_dir(&store.backups_dir(), true).unwrap();
        let archive = store
            .backups_dir()
            .join(format!("refresh-store-{generation}"));
        let staging = root
            .path()
            .join(format!("{STAGING_PREFIX}refresh-{generation}"));
        create_private_dir(&staging, false).unwrap();
        fs::rename(store.store_dir(), &archive).unwrap();
        atomic_write(
            &root.path().join(REFRESH_JOURNAL_FILE),
            &node_json_bytes(&refresh_journal_value("prepared", generation)),
        )
        .unwrap();
        drop(store);

        let recovered = open(&root);
        assert_eq!(
            fs::read(recovered.store_dir().join("prior.marker")).unwrap(),
            b"prior"
        );
        assert!(!archive.exists(), "the prior generation was restored");
        assert!(!staging.exists());
        assert!(!root.path().join(REFRESH_JOURNAL_FILE).exists());
    }

    #[test]
    fn committed_refresh_journal_keeps_the_new_generation() {
        let root = TempRoot::new("refresh-journal-committed");
        let generation = "fedcba9876543210fedcba9876543210";
        let store = open(&root);
        seed_store(&store, "authoritative");
        create_private_dir(&store.backups_dir(), true).unwrap();
        let archive = store
            .backups_dir()
            .join(format!("refresh-store-{generation}"));
        create_private_dir(&archive, false).unwrap();
        atomic_write(&archive.join("prior.marker"), b"prior").unwrap();
        atomic_write(&store.store_dir().join("new.marker"), b"complete").unwrap();
        atomic_write(
            &root.path().join(REFRESH_JOURNAL_FILE),
            &node_json_bytes(&refresh_journal_value("committed", generation)),
        )
        .unwrap();
        drop(store);

        let recovered = open(&root);
        assert_eq!(
            fs::read(recovered.store_dir().join("new.marker")).unwrap(),
            b"complete"
        );
        assert!(archive.join("prior.marker").is_file());
        assert!(!root.path().join(REFRESH_JOURNAL_FILE).exists());
    }

    #[test]
    fn malformed_refresh_journal_fails_closed_without_touching_store() {
        let root = TempRoot::new("refresh-journal-malformed");
        let store = open(&root);
        seed_store(&store, "authoritative");
        atomic_write(&store.store_dir().join("prior.marker"), b"prior").unwrap();
        let before = crate::testutil::snapshot_tree(&store.store_dir());
        atomic_write(&root.path().join(REFRESH_JOURNAL_FILE), b"{\"schema\":1\n").unwrap();
        drop(store);

        assert!(matches!(
            Store::open(root.path(), Duration::from_millis(200)),
            Err(StoreError::Invalid("refresh journal is malformed"))
        ));
        assert_eq!(
            crate::testutil::snapshot_tree(&root.path().join(STORE_DIR)),
            before
        );
        assert!(root.path().join(REFRESH_JOURNAL_FILE).is_file());
    }
}
