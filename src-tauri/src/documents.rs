//! Narrow, bounded, read-only access to the fixed-name dashboard documents.
//!
//! The webview never supplies a path. This module reads only the documents the browser
//! dashboard reads (`coursework.json`, refresh history, Inbox, profile and its avatar header,
//! and each course folder's Canvas export lists), returns their raw text, and leaves every
//! projection to the shared TypeScript module so both modes project identically. Documents over
//! a declared cap fail the read; nothing is truncated.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;

use serde::Serialize;
use serde_json::Value;

use crate::config::{ReadLimits, COURSEWORK_FILE};
use crate::import::{is_course_folder_name, is_plain_basename};
use crate::store::{Store, StoreCondition, StoreError, StoreState};

const HISTORY_FILE: &str = "coursework-refresh-history.json";
const CONVERSATIONS_FILE: &str = "canvas-conversations.json";
const PROFILE_FILE: &str = "canvas-profile.json";
const CLASSES_DIR: &str = "classes";
/// Bytes of the avatar file returned for image-signature validation (never the image itself).
pub const AVATAR_HEAD_BYTES: usize = 16;
/// Maximum avatar bytes returned to the webview, matching the shared projection.
pub const MAX_AVATAR_BYTES: u64 = 5 * 1024 * 1024;

/// Bounded avatar payload for an object URL. Never carries a filesystem path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarBytes {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// Reads only the profile-declared sibling avatar, with a supported image type and byte cap.
pub fn read_avatar_bytes(store: &Store) -> Result<Option<AvatarBytes>, DocumentsError> {
    let _read_lock = store.read_lock()?;
    if !matches!(store.condition()?, StoreCondition::Ready(_)) {
        return Err(DocumentsError::NoStore);
    }
    let Some(profile) =
        store.read_document(PROFILE_FILE, ReadLimits::PRODUCTION.max_document_bytes)?
    else {
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(&profile.bytes)
        .map_err(|_| DocumentsError::Damaged("profile document is malformed"))?;
    let Some(avatar) = value.get("avatar") else {
        return Ok(None);
    };
    let Some(name) = avatar
        .get("path")
        .and_then(Value::as_str)
        .filter(|name| is_plain_basename(name))
    else {
        return Ok(None);
    };
    let Some(content_type) = avatar
        .get("contentType")
        .and_then(Value::as_str)
        .and_then(|type_name| type_name.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|type_name| {
            matches!(
                type_name.as_str(),
                "image/jpeg" | "image/png" | "image/webp" | "image/gif"
            )
        })
    else {
        return Ok(None);
    };
    let Some(bytes) = crate::store::read_capped(&store.store_dir().join(name), MAX_AVATAR_BYTES)?
    else {
        return Ok(None);
    };
    let valid = match content_type.as_str() {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !valid {
        return Ok(None);
    }
    Ok(Some(AvatarBytes {
        content_type,
        bytes,
    }))
}

/// Exact coursework text and the SHA-256 of its bytes (the browser mode's `version`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CourseworkText {
    pub text: String,
    pub version: String,
}

/// Size and leading bytes of the profile's avatar sidecar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarHeader {
    pub size_bytes: u64,
    pub head: Vec<u8>,
}

/// Raw Canvas export lists of one course folder; `None` when a document is absent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseExportTexts {
    pub files: Option<String>,
    pub pages: Option<String>,
    pub modules: Option<String>,
    pub announcements: Option<String>,
    pub download_manifest: Option<String>,
}

/// Everything the shared projection needs, as raw text. Keys are fixed; no path is returned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardDocuments {
    pub store_state: StoreState,
    pub coursework: CourseworkText,
    pub refresh_history: Option<String>,
    pub conversations: Option<String>,
    pub profile: Option<String>,
    pub avatar: Option<AvatarHeader>,
    /// Keyed by course folder name (`classes/<name>`).
    pub course_exports: BTreeMap<String, CourseExportTexts>,
}

/// Read failure. Content-free.
#[derive(Debug)]
pub enum DocumentsError {
    /// No store has been imported yet.
    NoStore,
    /// The store needs recovery.
    Damaged(&'static str),
    /// A document or the read as a whole exceeds a declared cap.
    OverCap,
    Store(StoreError),
}

impl From<StoreError> for DocumentsError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::TooLarge => DocumentsError::OverCap,
            other => DocumentsError::Store(other),
        }
    }
}

impl From<std::io::Error> for DocumentsError {
    fn from(error: std::io::Error) -> Self {
        DocumentsError::Store(StoreError::Io(error))
    }
}

struct Reader<'a> {
    store: &'a Store,
    limits: &'a ReadLimits,
    total: u64,
}

impl Reader<'_> {
    fn text(&mut self, name: &str) -> Result<Option<String>, DocumentsError> {
        let Some(document) = self
            .store
            .read_document(name, self.limits.max_document_bytes)?
        else {
            return Ok(None);
        };
        self.count(document.bytes.len() as u64)?;
        Ok(Some(String::from_utf8_lossy(&document.bytes).into_owned()))
    }

    fn count(&mut self, bytes: u64) -> Result<(), DocumentsError> {
        self.total += bytes;
        if self.total > self.limits.max_total_bytes {
            return Err(DocumentsError::OverCap);
        }
        Ok(())
    }
}

/// Reads the dashboard documents of an imported store.
pub fn read_dashboard_documents(
    store: &Store,
    limits: &ReadLimits,
) -> Result<DashboardDocuments, DocumentsError> {
    let _read_lock = store.read_lock()?;
    let store_state = match store.condition()? {
        StoreCondition::Empty => return Err(DocumentsError::NoStore),
        StoreCondition::Damaged(reason) => return Err(DocumentsError::Damaged(reason)),
        StoreCondition::Ready(summary) => summary.state,
    };
    let mut reader = Reader {
        store,
        limits,
        total: 0,
    };
    let coursework = store
        .read_document(COURSEWORK_FILE, limits.max_document_bytes)?
        .ok_or(DocumentsError::Damaged(
            "the store has no coursework document",
        ))?;
    reader.count(coursework.bytes.len() as u64)?;
    let coursework = CourseworkText {
        text: String::from_utf8_lossy(&coursework.bytes).into_owned(),
        version: coursework.digest,
    };
    let refresh_history = reader.text(HISTORY_FILE)?;
    let conversations = reader.text(CONVERSATIONS_FILE)?;
    let profile = reader.text(PROFILE_FILE)?;
    let avatar = avatar_header(store, profile.as_deref())?;
    let mut course_exports = BTreeMap::new();
    for folder in course_folders(store, limits)? {
        let base = format!("{CLASSES_DIR}/{folder}/canvas-export");
        let texts = CourseExportTexts {
            files: reader.text(&format!("{base}/api/files.json"))?,
            pages: reader.text(&format!("{base}/api/pages.json"))?,
            modules: reader.text(&format!("{base}/api/modules.json"))?,
            announcements: reader.text(&format!("{base}/api/announcements.json"))?,
            download_manifest: reader.text(&format!("{base}/download-manifest.json"))?,
        };
        course_exports.insert(folder, texts);
    }
    Ok(DashboardDocuments {
        store_state,
        coursework,
        refresh_history,
        conversations,
        profile,
        avatar,
        course_exports,
    })
}

/// Course folder names under `classes/`, sorted; over the cap is an error, not a truncation.
fn course_folders(store: &Store, limits: &ReadLimits) -> Result<Vec<String>, DocumentsError> {
    let classes = store.store_dir().join(CLASSES_DIR);
    let entries = match fs::read_dir(&classes) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut folders = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if entry.file_type()?.is_dir() && is_course_folder_name(&name) {
            folders.push(name);
            if folders.len() > limits.max_course_folders {
                return Err(DocumentsError::OverCap);
            }
        }
    }
    folders.sort();
    Ok(folders)
}

/// The avatar named by the profile, when it is a plain sibling regular file.
fn avatar_header(
    store: &Store,
    profile: Option<&str>,
) -> Result<Option<AvatarHeader>, DocumentsError> {
    let Some(name) = profile
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| {
            value
                .get("avatar")?
                .get("path")?
                .as_str()
                .map(str::to_owned)
        })
        .filter(|name| is_plain_basename(name))
    else {
        return Ok(None);
    };
    let path = store.store_dir().join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        _ => return Ok(None),
    };
    let mut head = Vec::with_capacity(AVATAR_HEAD_BYTES);
    File::open(&path)?
        .take(AVATAR_HEAD_BYTES as u64)
        .read_to_end(&mut head)?;
    Ok(Some(AvatarHeader {
        size_bytes: metadata.len(),
        head,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ImportLimits;
    use crate::import::{import_legacy_root, ImportOptions};
    use crate::store::{atomic_write, node_json_bytes, sha256_hex};
    use crate::testutil::{materialize_fixture, TempRoot};
    use std::path::Path;
    use std::time::Duration;

    fn imported_store(temp: &TempRoot) -> (Store, std::path::PathBuf) {
        let source = materialize_fixture(&temp.path().join("legacy"));
        let store = Store::open(
            &temp.path().join(crate::config::TEST_BUNDLE_IDENTIFIER),
            Duration::from_millis(200),
        )
        .expect("store");
        let options = ImportOptions {
            limits: ImportLimits::PRODUCTION,
            legacy_lock_timeout: Duration::from_millis(200),
            replace_preview: false,
        };
        import_legacy_root(&store, &source, &options, &mut |_| {}).expect("import");
        (store, source)
    }

    fn source_text(source: &Path, relative: &str) -> Option<String> {
        fs::read(source.join(relative))
            .ok()
            .map(|bytes| String::from_utf8(bytes).expect("fixture is UTF-8"))
    }

    #[test]
    fn bundle_matches_the_fixed_name_documents_of_the_imported_fixture() {
        let temp = TempRoot::new("documents-bundle");
        let (store, source) = imported_store(&temp);
        let bundle = read_dashboard_documents(&store, &ReadLimits::PRODUCTION).expect("bundle");
        assert_eq!(bundle.store_state, StoreState::Preview);
        let coursework_bytes = fs::read(source.join(COURSEWORK_FILE)).expect("coursework");
        assert_eq!(
            bundle.coursework.text.as_bytes(),
            coursework_bytes.as_slice()
        );
        assert_eq!(
            bundle.coursework.version,
            sha256_hex(&coursework_bytes),
            "version is the exact-byte digest"
        );
        assert_eq!(bundle.refresh_history, source_text(&source, HISTORY_FILE));
        assert_eq!(
            bundle.conversations,
            source_text(&source, CONVERSATIONS_FILE)
        );
        assert_eq!(bundle.profile, source_text(&source, PROFILE_FILE));
        assert!(
            bundle.refresh_history.is_some()
                && bundle.conversations.is_some()
                && bundle.profile.is_some()
        );

        let avatar_bytes = fs::read(source.join("canvas-avatar.png")).expect("avatar");
        let avatar = bundle.avatar.as_ref().expect("avatar header");
        assert_eq!(avatar.size_bytes, avatar_bytes.len() as u64);
        assert_eq!(
            avatar.head,
            avatar_bytes[..AVATAR_HEAD_BYTES.min(avatar_bytes.len())]
        );

        assert_eq!(
            bundle.course_exports.keys().collect::<Vec<_>>(),
            ["syn-101", "syn-202"]
        );
        for (folder, texts) in &bundle.course_exports {
            let base = format!("classes/{folder}/canvas-export");
            assert_eq!(
                texts.files,
                source_text(&source, &format!("{base}/api/files.json")),
                "{folder} files"
            );
            assert_eq!(
                texts.pages,
                source_text(&source, &format!("{base}/api/pages.json")),
                "{folder} pages"
            );
            assert_eq!(
                texts.modules,
                source_text(&source, &format!("{base}/api/modules.json")),
                "{folder} modules"
            );
            assert_eq!(
                texts.announcements,
                source_text(&source, &format!("{base}/api/announcements.json")),
                "{folder} announcements"
            );
            assert_eq!(
                texts.download_manifest,
                source_text(&source, &format!("{base}/download-manifest.json")),
                "{folder} manifest"
            );
        }
        assert!(bundle.course_exports["syn-101"].download_manifest.is_some());

        // The serialized bundle uses only fixed keys and carries no filesystem path.
        let json = serde_json::to_value(&bundle).expect("json");
        let keys: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "storeState",
                "coursework",
                "refreshHistory",
                "conversations",
                "profile",
                "avatar",
                "courseExports"
            ]
        );
        let text = serde_json::to_string(&json).expect("text");
        assert!(
            !text.contains(&*temp.path().to_string_lossy()),
            "no absolute path leaks"
        );
    }

    #[test]
    fn an_empty_or_damaged_store_has_no_documents() {
        let temp = TempRoot::new("documents-empty");
        let store = Store::open(temp.path(), Duration::from_millis(100)).expect("store");
        assert!(matches!(
            read_dashboard_documents(&store, &ReadLimits::PRODUCTION),
            Err(DocumentsError::NoStore)
        ));
        crate::store::create_private_dir(&store.store_dir(), false).expect("store dir");
        assert!(matches!(
            read_dashboard_documents(&store, &ReadLimits::PRODUCTION),
            Err(DocumentsError::Damaged(_))
        ));
    }

    #[test]
    fn over_cap_reads_fail_instead_of_truncating() {
        let temp = TempRoot::new("documents-caps");
        let (store, _) = imported_store(&temp);
        let tight_document = ReadLimits {
            max_document_bytes: 256,
            ..ReadLimits::PRODUCTION
        };
        assert!(matches!(
            read_dashboard_documents(&store, &tight_document),
            Err(DocumentsError::OverCap)
        ));
        let tight_folders = ReadLimits {
            max_course_folders: 1,
            ..ReadLimits::PRODUCTION
        };
        assert!(matches!(
            read_dashboard_documents(&store, &tight_folders),
            Err(DocumentsError::OverCap)
        ));
        let tight_total = ReadLimits {
            max_total_bytes: 50_000,
            ..ReadLimits::PRODUCTION
        };
        assert!(matches!(
            read_dashboard_documents(&store, &tight_total),
            Err(DocumentsError::OverCap)
        ));
    }

    #[test]
    fn avatar_names_outside_the_store_root_are_ignored() {
        let temp = TempRoot::new("documents-avatar");
        let (store, _) = imported_store(&temp);
        for name in ["../outside.png", "classes/syn-101/coursework.md", "", "."] {
            let profile = serde_json::json!({"name": "Synthetic Student", "avatar": {"path": name, "contentType": "image/png"}});
            atomic_write(
                &store.store_dir().join(PROFILE_FILE),
                &node_json_bytes(&profile),
            )
            .expect("profile");
            let bundle = read_dashboard_documents(&store, &ReadLimits::PRODUCTION).expect("bundle");
            assert!(bundle.avatar.is_none(), "{name}");
        }
    }
}
