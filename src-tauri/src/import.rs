//! Strict import of a whole legacy root into the app store as a labeled `preview`.
//!
//! The importer accepts only the Node-written layout: the known root documents, history and its
//! quarantine files, Inbox, profile and avatar sidecar, and `classes/<folder>/` with
//! `canvas-export`, `materials`, and the generated Markdown reports. Anything else, anything over
//! a declared cap, and any unsafe symlink refuses the import with named counts; nothing is
//! silently dropped. The copy runs under the legacy writer's adjacent directory lock, verifies
//! each file's digest as it copies, and requires identical source tree digests before and after.
//! The staged copy is validated and adopted atomically. The source is only read (the legacy lock
//! directory is the one entry the protocol itself creates and removes).
//!
//! The dry run shares the scan but takes no lock, copies nothing, and reports counts only.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::{
    ImportLimits, COURSEWORK_FILE, LEGACY_LOCK_DIR, MANIFEST_FILE, STAGING_PREFIX,
};
use crate::locking::{LegacyLock, LockError};
use crate::store::{
    atomic_write, create_private_dir, create_private_file, fsync_dir, hex, new_preview_manifest,
    node_json_bytes, Store, StoreCondition, StoreError, StoreState,
};

const HISTORY_FILE: &str = "coursework-refresh-history.json";
const PROFILE_FILE: &str = "canvas-profile.json";
const INBOX_FILES: [&str; 2] = ["canvas-conversations.json", "canvas-inbox.json"];
const COURSE_CONFIG_FILE: &str = "courses.json";
const CLASSES_DIR: &str = "classes";
const EXPORT_DIR: &str = "canvas-export";
const API_DIR: &str = "api";
const MATERIALS_DIR: &str = "materials";
const COURSE_REPORTS: [&str; 2] = ["coursework.md", "canvas-course-report.md"];
const OS_METADATA: &str = ".DS_Store";
const COPY_BUFFER: usize = 256 * 1024;
const DUPLICATE_KEY_MARKER: &str = "duegood-duplicate-json-key";

/// Content-free progress, emitted through a channel or callback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub phase: ImportPhase,
    pub files_done: u64,
    pub files_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportPhase {
    Locking,
    Scanning,
    Hashing,
    Copying,
    Rechecking,
    Validating,
    Adopting,
    Complete,
}

/// Counts of what a legacy root contains. No names, paths, or content.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub coursework_documents: u64,
    pub history_documents: u64,
    pub history_quarantine_files: u64,
    pub inbox_documents: u64,
    pub profile_documents: u64,
    pub avatar_files: u64,
    pub course_config_documents: u64,
    pub course_folders: u64,
    pub export_documents: u64,
    pub course_reports: u64,
    pub material_files: u64,
    pub material_folders: u64,
    pub material_symlinks_followed: u64,
    pub ignored_os_metadata_files: u64,
    pub files: u64,
    pub directories: u64,
    pub bytes: u64,
}

/// Content-free, read-only dry-run report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunReport {
    pub caps: ImportLimits,
    pub inventory: Inventory,
    /// Named refusal counts; the import proceeds only when this is empty.
    pub refusals: BTreeMap<&'static str, u64>,
    /// Unsupported entries by coarse type class.
    pub unsupported_types: BTreeMap<&'static str, u64>,
    pub legacy_lock_present: bool,
    pub would_import: bool,
}

/// Successful import summary. Carries no source path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub state: StoreState,
    pub files: u64,
    pub bytes: u64,
    pub replaced_preview: bool,
}

/// Import failure. Every variant is content-free.
#[derive(Debug)]
pub enum ImportError {
    /// The source failed strict validation; the counts name every reason.
    Refused {
        refusals: BTreeMap<&'static str, u64>,
        unsupported_types: BTreeMap<&'static str, u64>,
    },
    /// The chosen folder is not a directory.
    SourceUnavailable,
    /// The source and the app data folder overlap.
    SourceOverlapsStore,
    /// The legacy writer holds its lock.
    LegacyLockBusy,
    /// A source file changed while it was copied.
    ChangedDuringCopy,
    /// An authoritative store can never be replaced by import.
    AuthoritativeStore,
    /// A preview store exists and the owner did not confirm replacing it.
    PreviewExists,
    /// The store folder is damaged; import will not touch it.
    StoreNeedsRecovery,
    /// The staged copy failed validation.
    StagingInvalid,
    Store(StoreError),
    Io(io::Error),
}

impl ImportError {
    /// Stable machine-readable code for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            ImportError::Refused { .. } => "refused",
            ImportError::SourceUnavailable => "source-unavailable",
            ImportError::SourceOverlapsStore => "source-overlaps-store",
            ImportError::LegacyLockBusy => "legacy-lock-busy",
            ImportError::ChangedDuringCopy => "changed-during-copy",
            ImportError::AuthoritativeStore => "authoritative-store",
            ImportError::PreviewExists => "preview-exists",
            ImportError::StoreNeedsRecovery => "store-needs-recovery",
            ImportError::StagingInvalid => "staging-invalid",
            ImportError::Store(_) => "store-error",
            ImportError::Io(_) => "io-error",
        }
    }
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImportError::Refused { refusals, .. } => {
                let named: Vec<String> = refusals
                    .iter()
                    .map(|(name, count)| format!("{name}: {count}"))
                    .collect();
                write!(
                    f,
                    "The legacy folder was not imported. Reasons: {}.",
                    named.join(", ")
                )
            }
            ImportError::SourceUnavailable => write!(f, "The chosen folder is not available."),
            ImportError::SourceOverlapsStore => {
                write!(f, "The chosen folder overlaps the app data folder.")
            }
            ImportError::LegacyLockBusy => {
                write!(f, "The browser app is writing coursework right now. Nothing was copied; try again shortly.")
            }
            ImportError::ChangedDuringCopy => {
                write!(
                    f,
                    "The legacy folder changed during the copy. Nothing was imported; try again."
                )
            }
            ImportError::AuthoritativeStore => write!(
                f,
                "The app store is authoritative and is never replaced by import."
            ),
            ImportError::PreviewExists => write!(
                f,
                "A preview copy already exists. Confirm replacing it to import again."
            ),
            ImportError::StoreNeedsRecovery => {
                write!(f, "The app store needs recovery; import did not change it.")
            }
            ImportError::StagingInvalid => write!(
                f,
                "The staged copy failed validation. Nothing was imported."
            ),
            ImportError::Store(error) => write!(f, "{error}"),
            ImportError::Io(error) => write!(f, "Import input/output failed ({}).", error.kind()),
        }
    }
}

impl From<io::Error> for ImportError {
    fn from(error: io::Error) -> Self {
        ImportError::Io(error)
    }
}

impl From<StoreError> for ImportError {
    fn from(error: StoreError) -> Self {
        ImportError::Store(error)
    }
}

/// How a planned file is validated after it is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Validation {
    Opaque,
    Json,
    Coursework,
}

#[derive(Debug, Clone)]
struct PlannedFile {
    /// Relative path in the legacy layout (also the store path).
    relative: PathBuf,
    /// Path actually read: the entry itself, or a material symlink's confined target.
    source: PathBuf,
    /// Whether `source` is a resolved material symlink target (opened with symlinks allowed).
    followed: bool,
    size: u64,
    validation: Validation,
}

#[derive(Debug, Default)]
struct Scan {
    inventory: Inventory,
    refusals: BTreeMap<&'static str, u64>,
    unsupported_types: BTreeMap<&'static str, u64>,
    legacy_lock_present: bool,
    directories: Vec<PathBuf>,
    files: Vec<PlannedFile>,
}

impl Scan {
    fn refuse(&mut self, reason: &'static str) {
        *self.refusals.entry(reason).or_insert(0) += 1;
    }

    fn unsupported(&mut self, reason: &'static str, file_type: &fs::FileType, name: &str) {
        self.refuse(reason);
        *self
            .unsupported_types
            .entry(type_class(file_type, name))
            .or_insert(0) += 1;
    }
}

/// Coarse, fixed-vocabulary type class for an unsupported entry.
fn type_class(file_type: &fs::FileType, name: &str) -> &'static str {
    if file_type.is_symlink() {
        return "symlink";
    }
    if file_type.is_dir() {
        return "directory";
    }
    if !file_type.is_file() {
        return "special";
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("json") => "json",
        Some("md" | "markdown") => "markdown",
        Some("sh" | "command" | "zsh" | "bash") => "script",
        Some("html" | "htm") => "html",
        Some("css") => "css",
        Some("js" | "mjs" | "cjs" | "ts") => "javascript",
        Some("txt" | "log") => "text",
        Some("pdf") => "pdf",
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "svg") => "image",
        Some("tmp" | "bak") => "temporary",
        None => "no-extension",
        Some(_) => "other",
    }
}

fn is_leftover_temp(name: &str) -> bool {
    name.len() > 5 && name.starts_with('.') && (name.ends_with(".tmp") || name.ends_with(".bak"))
}

fn is_stale_lock_remnant(name: &str) -> bool {
    name.len() > LEGACY_LOCK_DIR.len() + 7
        && name.starts_with(&format!("{LEGACY_LOCK_DIR}."))
        && name.ends_with(".stale")
}

/// `coursework-refresh-history.json.corrupt-<ms>-<8 hex>.json` (Node's quarantine name).
fn is_history_quarantine(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("coursework-refresh-history.json.corrupt-") else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(".json") else {
        return false;
    };
    let Some((millis, suffix)) = rest.split_once('-') else {
        return false;
    };
    !millis.is_empty()
        && millis.bytes().all(|byte| byte.is_ascii_digit())
        && suffix.len() == 8
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `courseDirectory`'s folder rule: `^[a-z0-9-]+$`.
pub fn is_course_folder_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Plain sidecar basename: one path component, not `.`/`..`, no separators.
pub fn is_plain_basename(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

fn sorted_entries(dir: &Path) -> io::Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

struct Scanner<'a> {
    root: &'a Path,
    limits: &'a ImportLimits,
    scan: Scan,
}

impl Scanner<'_> {
    fn plan_file(
        &mut self,
        relative: PathBuf,
        file_type: &fs::FileType,
        validation: Validation,
    ) -> io::Result<()> {
        let source = self.root.join(&relative);
        if !file_type.is_file() {
            let name = relative
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_owned();
            if file_type.is_symlink() {
                self.scan
                    .unsupported("symlinksOutsideMaterials", file_type, &name);
            } else {
                self.scan.unsupported("specialFiles", file_type, &name);
            }
            return Ok(());
        }
        let size = fs::symlink_metadata(&source)?.len();
        self.add_file(PlannedFile {
            relative,
            source,
            followed: false,
            size,
            validation,
        });
        Ok(())
    }

    fn add_file(&mut self, file: PlannedFile) {
        self.scan.inventory.files += 1;
        self.scan.inventory.bytes += file.size;
        if file.size > self.limits.max_file_bytes {
            self.scan.refuse("filesOverPerFileCap");
        }
        if file.validation != Validation::Opaque && file.size > self.limits.max_json_bytes {
            self.scan.refuse("jsonDocumentsOverCap");
        }
        self.scan.files.push(file);
    }

    fn add_dir(&mut self, relative: PathBuf) {
        self.scan.inventory.directories += 1;
        self.scan.directories.push(relative);
    }

    fn entry_name(&mut self, entry: &fs::DirEntry) -> Option<String> {
        match entry.file_name().into_string() {
            Ok(name) => Some(name),
            Err(_) => {
                self.scan.refuse("nonUtf8Names");
                None
            }
        }
    }

    fn avatar_name(&self) -> Option<String> {
        let path = self.root.join(PROFILE_FILE);
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !metadata.file_type().is_file() || metadata.len() > self.limits.max_json_bytes {
            return None;
        }
        let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        let name = value.get("avatar")?.get("path")?.as_str()?;
        (is_plain_basename(name) && name != COURSEWORK_FILE).then(|| name.to_owned())
    }

    fn scan_root(&mut self) -> io::Result<()> {
        let avatar = self.avatar_name();
        let mut saw_coursework = false;
        for entry in sorted_entries(self.root)? {
            let Some(name) = self.entry_name(&entry) else {
                continue;
            };
            let file_type = entry.file_type()?;
            let relative = PathBuf::from(&name);
            match name.as_str() {
                LEGACY_LOCK_DIR if file_type.is_dir() => self.scan.legacy_lock_present = true,
                OS_METADATA if file_type.is_file() => {
                    self.scan.inventory.ignored_os_metadata_files += 1
                }
                COURSEWORK_FILE => {
                    saw_coursework = file_type.is_file();
                    self.scan.inventory.coursework_documents += u64::from(file_type.is_file());
                    self.plan_file(relative, &file_type, Validation::Coursework)?;
                }
                HISTORY_FILE => {
                    self.scan.inventory.history_documents += u64::from(file_type.is_file());
                    self.plan_file(relative, &file_type, Validation::Json)?;
                }
                PROFILE_FILE => {
                    self.scan.inventory.profile_documents += u64::from(file_type.is_file());
                    self.plan_file(relative, &file_type, Validation::Json)?;
                }
                COURSE_CONFIG_FILE => {
                    self.scan.inventory.course_config_documents += u64::from(file_type.is_file());
                    self.plan_file(relative, &file_type, Validation::Json)?;
                }
                name if INBOX_FILES.contains(&name) => {
                    self.scan.inventory.inbox_documents += u64::from(file_type.is_file());
                    self.plan_file(relative, &file_type, Validation::Json)?;
                }
                name if is_history_quarantine(name) => {
                    // Quarantined history is corrupt by definition: preserved byte-for-byte, not parsed.
                    self.scan.inventory.history_quarantine_files += u64::from(file_type.is_file());
                    self.plan_file(relative, &file_type, Validation::Opaque)?;
                }
                CLASSES_DIR if file_type.is_dir() => {
                    self.add_dir(relative.clone());
                    self.scan_classes(&relative)?;
                }
                name if avatar.as_deref() == Some(name) => {
                    self.scan.inventory.avatar_files += u64::from(file_type.is_file());
                    self.plan_file(relative, &file_type, Validation::Opaque)?;
                }
                name if is_leftover_temp(name) => {
                    self.scan
                        .unsupported("leftoverTemporaryFiles", &file_type, name)
                }
                name if is_stale_lock_remnant(name) => {
                    self.scan.unsupported("staleLockRemnants", &file_type, name)
                }
                name if file_type.is_symlink() => {
                    self.scan
                        .unsupported("symlinksOutsideMaterials", &file_type, name)
                }
                name => self
                    .scan
                    .unsupported("unsupportedRootEntries", &file_type, name),
            }
        }
        if !saw_coursework {
            self.scan.refuse("missingCourseworkDocument");
        }
        Ok(())
    }

    fn scan_classes(&mut self, classes: &Path) -> io::Result<()> {
        for entry in sorted_entries(&self.root.join(classes))? {
            let Some(name) = self.entry_name(&entry) else {
                continue;
            };
            let file_type = entry.file_type()?;
            let relative = classes.join(&name);
            if file_type.is_dir() && is_course_folder_name(&name) {
                self.scan.inventory.course_folders += 1;
                self.add_dir(relative.clone());
                self.scan_course(&relative)?;
            } else if file_type.is_dir() {
                self.scan
                    .unsupported("invalidCourseFolderNames", &file_type, &name);
            } else if name == OS_METADATA && file_type.is_file() {
                self.scan.inventory.ignored_os_metadata_files += 1;
            } else if file_type.is_symlink() {
                self.scan
                    .unsupported("symlinksOutsideMaterials", &file_type, &name);
            } else if is_leftover_temp(&name) {
                self.scan
                    .unsupported("leftoverTemporaryFiles", &file_type, &name);
            } else {
                self.scan
                    .unsupported("unsupportedCourseEntries", &file_type, &name);
            }
        }
        Ok(())
    }

    fn scan_course(&mut self, course: &Path) -> io::Result<()> {
        for entry in sorted_entries(&self.root.join(course))? {
            let Some(name) = self.entry_name(&entry) else {
                continue;
            };
            let file_type = entry.file_type()?;
            let relative = course.join(&name);
            match name.as_str() {
                EXPORT_DIR if file_type.is_dir() => {
                    self.add_dir(relative.clone());
                    self.scan_export(&relative, false)?;
                }
                MATERIALS_DIR if file_type.is_dir() => {
                    self.add_dir(relative.clone());
                    let materials_root = fs::canonicalize(self.root.join(&relative))?;
                    self.scan_materials(&relative, &materials_root, 0)?;
                }
                name if COURSE_REPORTS.contains(&name) && file_type.is_file() => {
                    self.scan.inventory.course_reports += 1;
                    self.plan_file(relative, &file_type, Validation::Opaque)?;
                }
                OS_METADATA if file_type.is_file() => {
                    self.scan.inventory.ignored_os_metadata_files += 1
                }
                name if file_type.is_symlink() => {
                    self.scan
                        .unsupported("symlinksOutsideMaterials", &file_type, name)
                }
                name if is_leftover_temp(name) => {
                    self.scan
                        .unsupported("leftoverTemporaryFiles", &file_type, name)
                }
                name => self
                    .scan
                    .unsupported("unsupportedCourseEntries", &file_type, name),
            }
        }
        Ok(())
    }

    fn scan_export(&mut self, export: &Path, is_api: bool) -> io::Result<()> {
        for entry in sorted_entries(&self.root.join(export))? {
            let Some(name) = self.entry_name(&entry) else {
                continue;
            };
            let file_type = entry.file_type()?;
            let relative = export.join(&name);
            if file_type.is_file() && name.ends_with(".json") && !name.starts_with('.') {
                self.scan.inventory.export_documents += 1;
                self.plan_file(relative, &file_type, Validation::Json)?;
            } else if !is_api && file_type.is_dir() && name == API_DIR {
                self.add_dir(relative.clone());
                self.scan_export(&relative, true)?;
            } else if !is_api && file_type.is_file() && name == "canvas-course-report.md" {
                self.scan.inventory.course_reports += 1;
                self.plan_file(relative, &file_type, Validation::Opaque)?;
            } else if name == OS_METADATA && file_type.is_file() {
                self.scan.inventory.ignored_os_metadata_files += 1;
            } else if file_type.is_symlink() {
                self.scan
                    .unsupported("symlinksOutsideMaterials", &file_type, &name);
            } else if is_leftover_temp(&name) {
                self.scan
                    .unsupported("leftoverTemporaryFiles", &file_type, &name);
            } else {
                self.scan
                    .unsupported("unsupportedExportEntries", &file_type, &name);
            }
        }
        Ok(())
    }

    fn scan_materials(&mut self, dir: &Path, materials_root: &Path, depth: u64) -> io::Result<()> {
        for entry in sorted_entries(&self.root.join(dir))? {
            let Some(name) = self.entry_name(&entry) else {
                continue;
            };
            let file_type = entry.file_type()?;
            let relative = dir.join(&name);
            if name == OS_METADATA && file_type.is_file() {
                self.scan.inventory.ignored_os_metadata_files += 1;
            } else if is_leftover_temp(&name) {
                self.scan
                    .unsupported("leftoverTemporaryFiles", &file_type, &name);
            } else if file_type.is_file() {
                self.scan.inventory.material_files += 1;
                self.plan_file(relative, &file_type, Validation::Opaque)?;
            } else if file_type.is_dir() {
                if depth + 1 > self.limits.max_material_depth {
                    self.scan.refuse("materialsNestedTooDeep");
                    continue;
                }
                self.scan.inventory.material_folders += 1;
                self.add_dir(relative.clone());
                self.scan_materials(&relative, materials_root, depth + 1)?;
            } else if file_type.is_symlink() {
                self.follow_material_symlink(relative, materials_root, &file_type, &name)?;
            } else {
                self.scan.unsupported("specialFiles", &file_type, &name);
            }
        }
        Ok(())
    }

    fn follow_material_symlink(
        &mut self,
        relative: PathBuf,
        materials_root: &Path,
        file_type: &fs::FileType,
        name: &str,
    ) -> io::Result<()> {
        let Ok(target) = fs::canonicalize(self.root.join(&relative)) else {
            self.scan
                .unsupported("brokenMaterialSymlinks", file_type, name);
            return Ok(());
        };
        if target == materials_root || !target.starts_with(materials_root) {
            self.scan
                .unsupported("escapingMaterialSymlinks", file_type, name);
            return Ok(());
        }
        let metadata = fs::metadata(&target)?;
        if !metadata.is_file() {
            self.scan
                .unsupported("materialSymlinksToNonFiles", file_type, name);
            return Ok(());
        }
        self.scan.inventory.material_files += 1;
        self.scan.inventory.material_symlinks_followed += 1;
        self.add_file(PlannedFile {
            relative,
            source: target,
            followed: true,
            size: metadata.len(),
            validation: Validation::Opaque,
        });
        Ok(())
    }
}

/// Walks and classifies the legacy root. Reads directory entries and JSON documents only.
fn scan(root: &Path, limits: &ImportLimits) -> io::Result<Scan> {
    let mut scanner = Scanner {
        root,
        limits,
        scan: Scan::default(),
    };
    scanner.scan_root()?;
    let mut scan = scanner.scan;
    if scan.inventory.files + scan.inventory.directories > limits.max_entries {
        scan.refuse("entriesOverCap");
    }
    if scan.inventory.bytes > limits.max_total_bytes {
        scan.refuse("totalBytesOverCap");
    }
    Ok(scan)
}

/// Reads and validates every JSON document the scan planned (skipping ones already over cap).
fn validate_documents(root_scan: &mut Scan, limits: &ImportLimits) {
    let mut reasons = Vec::new();
    for file in &root_scan.files {
        if file.validation == Validation::Opaque || file.size > limits.max_json_bytes {
            continue;
        }
        match read_limited(&file.source, limits.max_json_bytes, file.followed) {
            Ok(bytes) => {
                if let Err(reason) = validate_json(&bytes, file.validation) {
                    reasons.push(reason);
                }
            }
            Err(_) => reasons.push("unreadableEntries"),
        }
    }
    for reason in reasons {
        root_scan.refuse(reason);
    }
}

fn open_source(path: &Path, followed: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    if !followed {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    let _ = followed;
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    Ok(file)
}

fn read_limited(path: &Path, cap: u64, followed: bool) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_source(path, followed)?
        .take(cap + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > cap {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(bytes)
}

/// Accepts any JSON value while rejecting objects that repeat a key.
struct NoDuplicateKeys;

impl<'de> Deserialize<'de> for NoDuplicateKeys {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NoDuplicateKeysVisitor)
    }
}

struct NoDuplicateKeysVisitor;

impl<'de> Visitor<'de> for NoDuplicateKeysVisitor {
    type Value = NoDuplicateKeys;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
        Ok(NoDuplicateKeys)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
        Ok(NoDuplicateKeys)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
        Ok(NoDuplicateKeys)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
        Ok(NoDuplicateKeys)
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
        Ok(NoDuplicateKeys)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(NoDuplicateKeys)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element::<NoDuplicateKeys>()?.is_some() {}
        Ok(NoDuplicateKeys)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut keys = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(de::Error::custom(DUPLICATE_KEY_MARKER));
            }
            map.next_value::<NoDuplicateKeys>()?;
        }
        Ok(NoDuplicateKeys)
    }
}

/// Strict JSON validation; returns a refusal name on failure.
fn validate_json(bytes: &[u8], validation: Validation) -> Result<(), &'static str> {
    if let Err(error) = serde_json::from_slice::<NoDuplicateKeys>(bytes) {
        return Err(if error.to_string().contains(DUPLICATE_KEY_MARKER) {
            "duplicateJsonKeys"
        } else {
            "malformedJson"
        });
    }
    if validation == Validation::Coursework {
        let value: Value = serde_json::from_slice(bytes).map_err(|_| "malformedJson")?;
        validate_coursework(&value)?;
    }
    Ok(())
}

/// The Node store's `validateAndProject` acceptance rules (the store refuses what it would reject).
fn validate_coursework(document: &Value) -> Result<(), &'static str> {
    let document = document.as_object().ok_or("invalidCourseworkDocument")?;
    let courses = document
        .get("courses")
        .and_then(Value::as_array)
        .ok_or("invalidCourseworkDocument")?;
    let items = document
        .get("items")
        .and_then(Value::as_array)
        .ok_or("invalidCourseworkDocument")?;
    let mut course_keys = HashSet::new();
    for course in courses {
        let course = course.as_object().ok_or("invalidCourseworkDocument")?;
        let key = course
            .get("key")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .ok_or("invalidCourseworkDocument")?;
        if !course_keys.insert(key) {
            return Err("duplicateCourseKeys");
        }
        if let Some(groups) = course.get("gradeGroups").and_then(Value::as_array) {
            if !groups.iter().all(Value::is_object) {
                return Err("invalidCourseworkDocument");
            }
        }
    }
    let mut item_ids = HashSet::new();
    for item in items {
        let item = item.as_object().ok_or("invalidCourseworkDocument")?;
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("invalidCourseworkDocument")?;
        if !item_ids.insert(id) {
            return Err("duplicateItemIds");
        }
        let course = item
            .get("course")
            .and_then(Value::as_str)
            .ok_or("invalidCourseworkDocument")?;
        if !course_keys.contains(course) {
            return Err("invalidCourseworkDocument");
        }
        if item.get("kind").and_then(Value::as_str) == Some("milestone") {
            continue;
        }
        if let Some(at) = item.get("at") {
            if !at.is_null() && !at.is_string() {
                return Err("invalidCourseworkDocument");
            }
        }
    }
    Ok(())
}

/// Content-free, read-only dry run: no lock, no copy, no names or data in the output.
pub fn dry_run(source_root: &Path, limits: &ImportLimits) -> Result<DryRunReport, ImportError> {
    let root = canonical_source(source_root)?;
    let mut scan = scan(&root, limits)?;
    validate_documents(&mut scan, limits);
    Ok(DryRunReport {
        caps: *limits,
        would_import: scan.refusals.is_empty(),
        inventory: scan.inventory,
        refusals: scan.refusals,
        unsupported_types: scan.unsupported_types,
        legacy_lock_present: scan.legacy_lock_present,
    })
}

fn canonical_source(source_root: &Path) -> Result<PathBuf, ImportError> {
    let root = fs::canonicalize(source_root).map_err(|_| ImportError::SourceUnavailable)?;
    if !fs::metadata(&root)
        .map_err(|_| ImportError::SourceUnavailable)?
        .is_dir()
    {
        return Err(ImportError::SourceUnavailable);
    }
    Ok(root)
}

/// Per-file digests keyed by relative path, plus directories: the source tree identity.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TreeDigest {
    directories: Vec<PathBuf>,
    files: BTreeMap<PathBuf, (u64, String)>,
}

impl TreeDigest {
    fn hex(&self) -> String {
        let mut hasher = Sha256::new();
        for directory in &self.directories {
            hasher.update(directory.to_string_lossy().as_bytes());
            hasher.update(b"/\n");
        }
        for (path, (size, digest)) in &self.files {
            hasher.update(path.to_string_lossy().as_bytes());
            hasher.update(format!("\0{size}\0{digest}\n").as_bytes());
        }
        hex(&hasher.finalize())
    }
}

fn hash_file(path: &Path, followed: bool) -> io::Result<(u64, String)> {
    let mut file = open_source(path, followed)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; COPY_BUFFER];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((size, hex(&hasher.finalize())))
}

fn digest_tree(scan: &Scan) -> Result<TreeDigest, ImportError> {
    let mut files = BTreeMap::new();
    for file in &scan.files {
        let (size, digest) =
            hash_file(&file.source, file.followed).map_err(|_| ImportError::ChangedDuringCopy)?;
        if size != file.size {
            return Err(ImportError::ChangedDuringCopy);
        }
        files.insert(file.relative.clone(), (size, digest));
    }
    let mut directories = scan.directories.clone();
    directories.sort();
    Ok(TreeDigest { directories, files })
}

/// Options for [`import_legacy_root`].
#[derive(Debug, Clone, Copy)]
pub struct ImportOptions {
    pub limits: ImportLimits,
    pub legacy_lock_timeout: Duration,
    /// Owner confirmation to archive and replace an existing preview store.
    pub replace_preview: bool,
}

struct StagingGuard {
    path: PathBuf,
    adopted: bool,
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if !self.adopted {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// Imports the whole legacy root into the store as `preview`.
///
/// On any failure the source and the existing app data are unchanged (an incomplete staging
/// folder is removed). `progress` receives content-free events.
pub fn import_legacy_root(
    store: &Store,
    source_root: &Path,
    options: &ImportOptions,
    progress: &mut dyn FnMut(ImportProgress),
) -> Result<ImportSummary, ImportError> {
    let limits = &options.limits;
    let mut emit = |phase, files_done, files_total, bytes_done, bytes_total| {
        progress(ImportProgress {
            phase,
            files_done,
            files_total,
            bytes_done,
            bytes_total,
        })
    };
    let root = canonical_source(source_root)?;
    let data_root = fs::canonicalize(store.data_root())?;
    if root.starts_with(&data_root) || data_root.starts_with(&root) {
        return Err(ImportError::SourceOverlapsStore);
    }
    let expected = store.condition()?;
    match &expected {
        StoreCondition::Empty => {}
        StoreCondition::Ready(summary) if summary.state == StoreState::Authoritative => {
            return Err(ImportError::AuthoritativeStore)
        }
        StoreCondition::Ready(_) if !options.replace_preview => {
            return Err(ImportError::PreviewExists)
        }
        StoreCondition::Ready(_) => {}
        StoreCondition::Damaged(_) => return Err(ImportError::StoreNeedsRecovery),
    }

    emit(ImportPhase::Locking, 0, 0, 0, 0);
    let legacy_lock =
        LegacyLock::acquire(&root, options.legacy_lock_timeout).map_err(|error| match error {
            LockError::Busy => ImportError::LegacyLockBusy,
            LockError::Io(error) => ImportError::Io(error),
            LockError::AnotherInstance => ImportError::LegacyLockBusy,
        })?;

    emit(ImportPhase::Scanning, 0, 0, 0, 0);
    let mut planned = scan(&root, limits)?;
    validate_documents(&mut planned, limits);
    if !planned.refusals.is_empty() {
        return Err(ImportError::Refused {
            refusals: planned.refusals,
            unsupported_types: planned.unsupported_types,
        });
    }
    let files_total = planned.files.len() as u64;
    let bytes_total = planned.inventory.bytes;

    emit(ImportPhase::Hashing, 0, files_total, 0, bytes_total);
    let before = digest_tree(&planned)?;

    let staging = StagingGuard {
        path: data_root.join(format!("{STAGING_PREFIX}{}", uuid::Uuid::new_v4().simple())),
        adopted: false,
    };
    create_private_dir(&staging.path, false)?;
    for directory in &before.directories {
        create_private_dir(&staging.path.join(directory), false)?;
    }
    let mut bytes_done = 0u64;
    emit(ImportPhase::Copying, 0, files_total, 0, bytes_total);
    for (index, file) in planned.files.iter().enumerate() {
        let expected_digest = &before.files[&file.relative];
        let copied = copy_verified(file, &staging.path.join(&file.relative))?;
        if &copied != expected_digest {
            return Err(ImportError::ChangedDuringCopy);
        }
        bytes_done += file.size;
        emit(
            ImportPhase::Copying,
            index as u64 + 1,
            files_total,
            bytes_done,
            bytes_total,
        );
    }

    emit(
        ImportPhase::Rechecking,
        files_total,
        files_total,
        bytes_done,
        bytes_total,
    );
    let after_scan = scan(&root, limits)?;
    if !after_scan.refusals.is_empty() || digest_tree(&after_scan)? != before {
        return Err(ImportError::ChangedDuringCopy);
    }
    legacy_lock.release()?;

    emit(
        ImportPhase::Validating,
        files_total,
        files_total,
        bytes_done,
        bytes_total,
    );
    for file in &planned.files {
        let target = staging.path.join(&file.relative);
        let (size, digest) = hash_file(&target, false).map_err(|_| ImportError::StagingInvalid)?;
        if (size, digest) != before.files[&file.relative] {
            return Err(ImportError::StagingInvalid);
        }
        if file.validation != Validation::Opaque {
            let bytes = read_limited(&target, limits.max_json_bytes, false)
                .map_err(|_| ImportError::StagingInvalid)?;
            validate_json(&bytes, file.validation).map_err(|_| ImportError::StagingInvalid)?;
        }
    }
    let manifest = new_preview_manifest(files_total, bytes_total, &before.hex(), SystemTime::now());
    atomic_write(
        &staging.path.join(MANIFEST_FILE),
        &node_json_bytes(&manifest),
    )?;
    let mut directories = before.directories.clone();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in &directories {
        fsync_dir(&staging.path.join(directory))?;
    }
    fsync_dir(&staging.path)?;

    emit(
        ImportPhase::Adopting,
        files_total,
        files_total,
        bytes_done,
        bytes_total,
    );
    let mut staging = staging;
    let archived = store.adopt_staging(&staging.path, &expected)?;
    staging.adopted = true;
    emit(
        ImportPhase::Complete,
        files_total,
        files_total,
        bytes_done,
        bytes_total,
    );
    Ok(ImportSummary {
        state: StoreState::Preview,
        files: files_total,
        bytes: bytes_total,
        replaced_preview: archived.is_some(),
    })
}

/// Streams one source file into a new private staging file, hashing as it copies.
fn copy_verified(file: &PlannedFile, target: &Path) -> Result<(u64, String), ImportError> {
    let mut source =
        open_source(&file.source, file.followed).map_err(|_| ImportError::ChangedDuringCopy)?;
    let mut output = create_private_file(target)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; COPY_BUFFER];
    let mut size = 0u64;
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| ImportError::ChangedDuringCopy)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > file.size {
            return Err(ImportError::ChangedDuringCopy);
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }
    output.sync_all()?;
    Ok((size, hex(&hasher.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{BACKUPS_DIR, STORE_DIR};
    use crate::testutil::{assert_private_tree, materialize_fixture, snapshot_tree, TempRoot};

    fn limits() -> ImportLimits {
        ImportLimits::PRODUCTION
    }

    fn options(replace_preview: bool) -> ImportOptions {
        ImportOptions {
            limits: limits(),
            legacy_lock_timeout: Duration::from_millis(150),
            replace_preview,
        }
    }

    fn open_store(root: &TempRoot) -> Store {
        Store::open(
            &root.path().join(crate::config::TEST_BUNDLE_IDENTIFIER),
            Duration::from_millis(200),
        )
        .expect("store")
    }

    fn run(
        store: &Store,
        source: &Path,
        options: &ImportOptions,
    ) -> (Result<ImportSummary, ImportError>, Vec<ImportProgress>) {
        let mut events = Vec::new();
        let result = import_legacy_root(store, source, options, &mut |event| events.push(event));
        (result, events)
    }

    /// Imports refused for `reason` leave the source and the app data byte-identical.
    fn assert_refused_without_mutation(
        source: &Path,
        store: &Store,
        expect: impl Fn(&ImportError) -> bool,
    ) {
        let source_before = snapshot_tree(source);
        let data_before = snapshot_tree(store.data_root());
        let (result, _) = run(store, source, &options(true));
        let error = result.expect_err("import must be refused");
        assert!(expect(&error), "unexpected refusal: {error:?}");
        assert_eq!(snapshot_tree(source), source_before, "source unchanged");
        assert_eq!(
            snapshot_tree(store.data_root()),
            data_before,
            "app data unchanged"
        );
    }

    fn refusal(name: &'static str) -> impl Fn(&ImportError) -> bool {
        move |error| matches!(error, ImportError::Refused { refusals, .. } if refusals.contains_key(name))
    }

    #[test]
    fn imports_the_synthetic_legacy_root_as_preview() {
        let temp = TempRoot::new("import-ok");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let store = open_store(&temp);
        let source_before = snapshot_tree(&source);
        let (result, events) = run(&store, &source, &options(false));
        let summary = result.expect("import succeeds");
        assert_eq!(summary.state, StoreState::Preview);
        assert!(!summary.replaced_preview);
        assert_eq!(
            snapshot_tree(&source),
            source_before,
            "the source is never mutated"
        );
        assert!(
            !source.join(LEGACY_LOCK_DIR).exists(),
            "legacy lock released"
        );

        // Every legacy file is present byte-for-byte; material symlinks are copied as files.
        let store_dir = store.store_dir();
        let imported = snapshot_tree(&store_dir);
        for (relative, entry) in &source_before {
            if relative.ends_with(".DS_Store") {
                continue;
            }
            let copied = imported
                .get(relative)
                .unwrap_or_else(|| panic!("missing {relative}"));
            match entry {
                crate::testutil::Entry::Symlink(_) => {
                    let target = fs::read(fs::canonicalize(source.join(relative)).expect("target"))
                        .expect("bytes");
                    assert_eq!(copied, &crate::testutil::Entry::File(target));
                }
                other => assert_eq!(copied, other, "{relative}"),
            }
        }
        match store.condition().expect("condition") {
            StoreCondition::Ready(summary) => {
                assert_eq!(summary.state, StoreState::Preview);
                assert_eq!(summary.files, Some(summary_files(&source_before)));
            }
            other => panic!("unexpected condition {other:?}"),
        }
        assert_private_tree(store.data_root());

        // Progress is content-free, ordered, and ends complete.
        let phases: Vec<ImportPhase> = events.iter().map(|event| event.phase).collect();
        assert_eq!(phases.first(), Some(&ImportPhase::Locking));
        assert_eq!(phases.last(), Some(&ImportPhase::Complete));
        for phase in [
            ImportPhase::Scanning,
            ImportPhase::Hashing,
            ImportPhase::Copying,
            ImportPhase::Rechecking,
            ImportPhase::Validating,
            ImportPhase::Adopting,
        ] {
            assert!(phases.contains(&phase), "missing {phase:?}");
        }
        let last = events.last().expect("events");
        assert_eq!(last.files_done, last.files_total);
        assert_eq!(last.bytes_done, summary.bytes);
        let copying: Vec<u64> = events
            .iter()
            .filter(|event| event.phase == ImportPhase::Copying)
            .map(|event| event.files_done)
            .collect();
        assert!(
            copying.windows(2).all(|pair| pair[1] == pair[0] + 1),
            "one event per copied file"
        );
        let serialized = serde_json::to_string(&events).expect("json");
        for leak in [
            "coursework",
            "syn-",
            "materials",
            "Synthetic",
            "legacy",
            "/",
        ] {
            assert!(!serialized.contains(leak), "progress leaked {leak}");
        }
    }

    fn summary_files(tree: &BTreeMap<String, crate::testutil::Entry>) -> u64 {
        tree.iter()
            .filter(|(path, entry)| {
                !path.ends_with(".DS_Store") && !matches!(entry, crate::testutil::Entry::Dir)
            })
            .count() as u64
    }

    #[test]
    fn absent_source_is_refused() {
        let temp = TempRoot::new("import-absent");
        let store = open_store(&temp);
        let data_before = snapshot_tree(store.data_root());
        let (result, events) = run(&store, &temp.path().join("does-not-exist"), &options(false));
        assert!(matches!(result, Err(ImportError::SourceUnavailable)));
        assert!(events.is_empty());
        assert_eq!(snapshot_tree(store.data_root()), data_before);

        let empty = temp.path().join("empty-legacy");
        fs::create_dir(&empty).expect("empty");
        assert_refused_without_mutation(&empty, &store, refusal("missingCourseworkDocument"));
    }

    #[test]
    fn malformed_json_is_refused() {
        let temp = TempRoot::new("import-malformed");
        let source = materialize_fixture(&temp.path().join("legacy"));
        fs::write(
            source.join("classes/syn-101/canvas-export/api/pages.json"),
            b"[{\"title\": ",
        )
        .expect("corrupt");
        let store = open_store(&temp);
        assert_refused_without_mutation(&source, &store, refusal("malformedJson"));
    }

    #[test]
    fn duplicate_keys_and_ids_are_refused() {
        let temp = TempRoot::new("import-duplicate");
        let source = materialize_fixture(&temp.path().join("legacy"));
        fs::write(
            source.join("canvas-profile.json"),
            b"{\"name\":\"A\",\"name\":\"B\"}\n",
        )
        .expect("dup key");
        let store = open_store(&temp);
        assert_refused_without_mutation(&source, &store, refusal("duplicateJsonKeys"));

        let other = materialize_fixture(&temp.path().join("legacy-ids"));
        let coursework = other.join(COURSEWORK_FILE);
        let mut value: Value =
            serde_json::from_slice(&fs::read(&coursework).expect("read")).expect("json");
        let first = value["items"][0].clone();
        value["items"].as_array_mut().expect("items").push(first);
        fs::write(&coursework, node_json_bytes(&value)).expect("write");
        assert_refused_without_mutation(&other, &store, refusal("duplicateItemIds"));
    }

    #[test]
    fn oversized_sources_are_refused_with_named_counts() {
        let temp = TempRoot::new("import-oversized");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let store = open_store(&temp);
        let tiny = ImportLimits {
            max_file_bytes: 64,
            ..limits()
        };
        let data_before = snapshot_tree(store.data_root());
        let source_before = snapshot_tree(&source);
        let (result, _) = run(
            &store,
            &source,
            &ImportOptions {
                limits: tiny,
                ..options(false)
            },
        );
        match result {
            Err(ImportError::Refused { refusals, .. }) => {
                assert!(
                    refusals["filesOverPerFileCap"] > 1,
                    "every oversized file is counted"
                );
            }
            other => panic!("expected refusal, got {other:?}"),
        }
        let json_cap = ImportLimits {
            max_json_bytes: 64,
            ..limits()
        };
        let (result, _) = run(
            &store,
            &source,
            &ImportOptions {
                limits: json_cap,
                ..options(false)
            },
        );
        match result {
            Err(ImportError::Refused { refusals, .. }) => {
                assert!(
                    refusals["jsonDocumentsOverCap"] > 1,
                    "every oversized JSON document is counted"
                );
                assert!(!refusals.contains_key("filesOverPerFileCap"));
            }
            other => panic!("expected refusal, got {other:?}"),
        }
        let shallow = ImportLimits {
            max_material_depth: 0,
            ..limits()
        };
        let (result, _) = run(
            &store,
            &source,
            &ImportOptions {
                limits: shallow,
                ..options(false)
            },
        );
        assert!(refusal("materialsNestedTooDeep")(
            &result.expect_err("depth cap")
        ));
        let total = ImportLimits {
            max_total_bytes: 1_000,
            ..limits()
        };
        let (result, _) = run(
            &store,
            &source,
            &ImportOptions {
                limits: total,
                ..options(false)
            },
        );
        assert!(refusal("totalBytesOverCap")(
            &result.expect_err("total cap")
        ));
        let entries = ImportLimits {
            max_entries: 5,
            ..limits()
        };
        let (result, _) = run(
            &store,
            &source,
            &ImportOptions {
                limits: entries,
                ..options(false)
            },
        );
        assert!(refusal("entriesOverCap")(&result.expect_err("entry cap")));
        assert_eq!(snapshot_tree(&source), source_before);
        assert_eq!(snapshot_tree(store.data_root()), data_before);
    }

    #[cfg(unix)]
    #[test]
    fn escaping_and_unsupported_symlinks_are_refused() {
        use std::os::unix::fs::symlink;
        let temp = TempRoot::new("import-symlink");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let outside = temp.path().join("outside-secret.txt");
        fs::write(&outside, b"outside the materials root").expect("outside");
        symlink(
            &outside,
            source.join("classes/syn-101/materials/escape.txt"),
        )
        .expect("symlink");
        let store = open_store(&temp);
        assert_refused_without_mutation(&source, &store, refusal("escapingMaterialSymlinks"));

        let other = materialize_fixture(&temp.path().join("legacy-root-link"));
        symlink(
            other.join("classes/syn-101/materials"),
            other.join("classes/syn-101/canvas-export/api/linked.json"),
        )
        .expect("link");
        assert_refused_without_mutation(&other, &store, refusal("symlinksOutsideMaterials"));

        let sibling = materialize_fixture(&temp.path().join("legacy-sibling"));
        // A symlink into another course's materials escapes this course's materials root.
        symlink(
            sibling.join("classes/syn-202/materials/200-lab-guide.txt"),
            sibling.join("classes/syn-101/materials/borrowed.txt"),
        )
        .expect("cross-course link");
        assert_refused_without_mutation(&sibling, &store, refusal("escapingMaterialSymlinks"));
    }

    #[test]
    fn unsupported_entries_are_refused_not_dropped() {
        let temp = TempRoot::new("import-unsupported");
        let source = materialize_fixture(&temp.path().join("legacy"));
        fs::write(source.join("launcher.sh"), b"#!/bin/sh\n").expect("script");
        fs::write(source.join(".coursework.json.0000.tmp"), b"{}").expect("temp");
        fs::create_dir(source.join("classes/Not_Valid")).expect("bad folder");
        let store = open_store(&temp);
        let source_before = snapshot_tree(&source);
        let (result, _) = run(&store, &source, &options(false));
        match result {
            Err(ImportError::Refused {
                refusals,
                unsupported_types,
            }) => {
                assert_eq!(refusals["unsupportedRootEntries"], 1);
                assert_eq!(refusals["leftoverTemporaryFiles"], 1);
                assert_eq!(refusals["invalidCourseFolderNames"], 1);
                assert_eq!(unsupported_types["script"], 1);
                assert_eq!(unsupported_types["temporary"], 1);
                assert_eq!(unsupported_types["directory"], 1);
            }
            other => panic!("expected refusal, got {other:?}"),
        }
        assert_eq!(snapshot_tree(&source), source_before);
    }

    #[test]
    fn a_held_legacy_lock_refuses_the_import() {
        let temp = TempRoot::new("import-locked");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let lock_dir = source.join(LEGACY_LOCK_DIR);
        fs::create_dir(&lock_dir).expect("lock");
        fs::write(
            lock_dir.join("owner.json"),
            format!(
                "{{\"pid\":{},\"token\":\"browser-app\",\"createdAt\":1}}\n",
                std::process::id()
            ),
        )
        .expect("owner");
        let store = open_store(&temp);
        assert_refused_without_mutation(&source, &store, |error| {
            matches!(error, ImportError::LegacyLockBusy)
        });
        assert!(
            lock_dir.join("owner.json").exists(),
            "the browser app's lock is left in place"
        );
    }

    #[test]
    fn a_source_changed_during_the_copy_is_refused() {
        // `coursework.json` sorts after the other root documents: the first variant changes it
        // before it is copied (caught by the per-file digest), the second after every file has
        // been copied (caught by the after-copy tree digest).
        for already_copied in [false, true] {
            let temp = TempRoot::new("import-changed");
            let source = materialize_fixture(&temp.path().join("legacy"));
            let store = open_store(&temp);
            let data_before = snapshot_tree(store.data_root());
            let target = source.join(COURSEWORK_FILE);
            let mut events = Vec::new();
            let mut mutated = false;
            let result = import_legacy_root(&store, &source, &options(false), &mut |event| {
                events.push(event);
                let at = if already_copied { event.files_total } else { 1 };
                if event.phase == ImportPhase::Copying
                    && event.files_done == at
                    && event.files_total > 0
                    && !mutated
                {
                    mutated = true;
                    let mut bytes = fs::read(&target).expect("read");
                    bytes.extend_from_slice(b" ");
                    fs::write(&target, bytes).expect("concurrent writer");
                }
            });
            assert!(mutated);
            assert!(
                matches!(result, Err(ImportError::ChangedDuringCopy)),
                "already copied {already_copied}: {result:?}"
            );
            assert!(
                !events
                    .iter()
                    .any(|event| event.phase == ImportPhase::Adopting),
                "never adopted"
            );
            assert_eq!(
                snapshot_tree(store.data_root()),
                data_before,
                "no partial store"
            );
            assert!(
                !source.join(LEGACY_LOCK_DIR).exists(),
                "legacy lock released on failure"
            );
        }
    }

    #[test]
    fn replace_preview_archives_the_prior_store_and_authoritative_rejects_import() {
        let temp = TempRoot::new("import-replace");
        let source = materialize_fixture(&temp.path().join("legacy"));
        let store = open_store(&temp);
        run(&store, &source, &options(false))
            .0
            .expect("first import");
        let first_store = snapshot_tree(&store.store_dir());

        // Without owner confirmation a second import is refused and nothing changes.
        assert_refused_without_mutation_with(&source, &store, false, |error| {
            matches!(error, ImportError::PreviewExists)
        });

        // With confirmation the prior store is archived (never deleted) and replaced.
        fs::write(
            source.join("classes/syn-101/coursework.md"),
            b"# Updated synthetic summary\n",
        )
        .expect("edit source");
        let (result, _) = run(&store, &source, &options(true));
        assert!(result.expect("replace").replaced_preview);
        let archives: Vec<_> = fs::read_dir(store.data_root().join(BACKUPS_DIR))
            .expect("backups")
            .map(|entry| entry.expect("entry").path())
            .collect();
        assert_eq!(archives.len(), 1);
        let name = archives[0]
            .file_name()
            .and_then(|name| name.to_str())
            .expect("name")
            .to_owned();
        // store-YYYYMMDDTHHMMSSZ-xxxxxxxx
        let parts: Vec<&str> = name.split('-').collect();
        assert_eq!(parts.len(), 3, "{name}");
        assert_eq!(parts[0], "store");
        assert!(
            parts[1].len() == 16 && parts[1].as_bytes()[8] == b'T' && parts[1].ends_with('Z'),
            "{name}"
        );
        assert!(
            parts[2].len() == 8 && parts[2].bytes().all(|byte| byte.is_ascii_hexdigit()),
            "{name}"
        );
        assert_eq!(
            snapshot_tree(&archives[0]),
            first_store,
            "archive holds the prior store byte-for-byte"
        );
        assert_eq!(
            fs::read(store.store_dir().join("classes/syn-101/coursework.md")).expect("new"),
            b"# Updated synthetic summary\n"
        );
        assert_private_tree(store.data_root());

        // An authoritative store is never replaced by import, even with confirmation.
        let manifest_path = store.data_root().join(STORE_DIR).join(MANIFEST_FILE);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("manifest")).expect("json");
        manifest["state"] = Value::from("authoritative");
        atomic_write(&manifest_path, &node_json_bytes(&manifest)).expect("promote");
        assert_refused_without_mutation(&source, &store, |error| {
            matches!(error, ImportError::AuthoritativeStore)
        });
    }

    fn assert_refused_without_mutation_with(
        source: &Path,
        store: &Store,
        replace: bool,
        expect: impl Fn(&ImportError) -> bool,
    ) {
        let source_before = snapshot_tree(source);
        let data_before = snapshot_tree(store.data_root());
        let (result, events) = run(store, source, &options(replace));
        assert!(expect(&result.expect_err("refused")));
        assert!(events.is_empty(), "refused before any lock or copy");
        assert_eq!(snapshot_tree(source), source_before);
        assert_eq!(snapshot_tree(store.data_root()), data_before);
    }

    #[test]
    fn a_source_inside_the_app_data_folder_is_refused() {
        let temp = TempRoot::new("import-overlap");
        let store = open_store(&temp);
        let inside = materialize_fixture(&store.data_root().join("nested-legacy"));
        let (result, _) = run(&store, &inside, &options(false));
        assert!(matches!(result, Err(ImportError::SourceOverlapsStore)));
    }

    #[test]
    fn dry_run_is_read_only_and_content_free() {
        let temp = TempRoot::new("import-dry-run");
        let source = materialize_fixture(&temp.path().join("legacy"));
        fs::write(source.join("launcher.sh"), b"#!/bin/sh\n").expect("unsupported");
        let before = snapshot_tree(&source);
        let report = dry_run(&source, &limits()).expect("dry run");
        assert_eq!(
            snapshot_tree(&source),
            before,
            "no lock, no copy, no mutation"
        );
        assert!(!report.would_import);
        assert_eq!(report.refusals["unsupportedRootEntries"], 1);
        assert_eq!(report.unsupported_types["script"], 1);
        assert_eq!(report.inventory.coursework_documents, 1);
        assert_eq!(report.inventory.course_folders, 2);
        assert!(report.inventory.material_symlinks_followed >= 1);
        assert_eq!(report.caps, limits());
        assert!(!report.legacy_lock_present);

        // Output carries only numbers, booleans, and fixed vocabulary keys.
        let json = serde_json::to_value(&report).expect("json");
        fn walk(value: &Value, keys: &mut Vec<String>) {
            match value {
                Value::Object(map) => {
                    for (key, child) in map {
                        keys.push(key.clone());
                        walk(child, keys);
                    }
                }
                Value::Number(_) | Value::Bool(_) => {}
                other => panic!("dry run emitted non-count value {other}"),
            }
        }
        let mut keys = Vec::new();
        walk(&json, &mut keys);
        let text = serde_json::to_string(&json).expect("text");
        for leak in [
            "syn-",
            "Synthetic",
            "launcher",
            ".sh",
            "coursework.json",
            "materials/",
            "/",
        ] {
            assert!(!text.contains(leak), "dry run leaked {leak}");
        }
        fs::remove_file(source.join("launcher.sh")).expect("cleanup");
        assert!(dry_run(&source, &limits()).expect("dry run").would_import);
    }

    /// Invoked only by the synthetic preparation integration test. Paths are supplied by its
    /// temporary fixture and the test emits only a fixed content-free marker.
    #[cfg(feature = "test-overrides")]
    #[test]
    #[ignore = "invoked by prepare-legacy-root synthetic integration"]
    fn prepare_legacy_root_dry_run_helper() {
        let source =
            std::env::var_os("DUEGOOD_PREPARE_SOURCE").expect("synthetic source path is required");
        let prepared = std::env::var_os("DUEGOOD_PREPARE_DESTINATION")
            .expect("synthetic destination path is required");
        let source_report = dry_run(Path::new(&source), &limits()).expect("source dry run");
        assert!(
            !source_report.would_import,
            "unprepared source must be refused"
        );
        assert!(source_report
            .refusals
            .contains_key("unsupportedRootEntries"));
        assert!(source_report
            .refusals
            .contains_key("unsupportedCourseEntries"));

        let prepared_report = dry_run(Path::new(&prepared), &limits()).expect("prepared dry run");
        assert!(
            prepared_report.would_import,
            "prepared source must have no refusals"
        );
        println!("legacy-root-dry-run: unprepared-refused prepared-importable");
    }

    #[test]
    fn history_quarantine_and_lock_names_follow_node() {
        assert!(is_history_quarantine(
            "coursework-refresh-history.json.corrupt-1790000000000-0a1b2c3d.json"
        ));
        assert!(!is_history_quarantine(
            "coursework-refresh-history.json.corrupt-17900-0A1B2C3D.json"
        ));
        assert!(!is_history_quarantine(
            "coursework-refresh-history.json.corrupt--0a1b2c3d.json"
        ));
        assert!(is_stale_lock_remnant(
            "coursework.json.duegood-lock.4b1d3c2a-0000-4000-8000-000000000000.stale"
        ));
        assert!(is_leftover_temp(".coursework.json.4b1d3c2a.tmp"));
        assert!(!is_leftover_temp(".tmp"));
        assert!(
            is_course_folder_name("syn-101")
                && !is_course_folder_name("Syn_101")
                && !is_course_folder_name("")
        );
    }
}
