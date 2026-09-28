//! Library file resolution by projection ID, with path confinement and native actions.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::Runtime;

use crate::config::ReadLimits;
use crate::import::{is_course_folder_name, is_plain_basename};
use crate::resources_save::{
    copy_verified_archive_file, ensure_destination_is_open_file, quarantine_saved_copy,
    remove_destination_if_same_file, ArchivedReceipt,
};
use crate::store::{create_private_file, Store, StoreError};

/// The types explicitly allowed to open through the system handler.
pub const SAFE_OPEN_TYPES: &[&str] = &["pdf", "png", "jpg", "jpeg", "txt"];

/// Native resource action, without a path in the webview response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceAction {
    Opened,
    Downloaded,
    Cancelled,
}

/// Narrow native boundary. Tests substitute this and never launch an opener or dialog.
pub trait ResourceHandler: Send + Sync + 'static {
    fn save_destination(&self, suggested_name: &str) -> Option<PathBuf>;
    fn open_safe(&self, path: &Path) -> io::Result<()>;
}

/// OS dialog and opener, both called only by Rust.
pub struct NativeResourceHandler<R: Runtime> {
    app: tauri::AppHandle<R>,
}
impl<R: Runtime> NativeResourceHandler<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}
impl<R: Runtime> ResourceHandler for NativeResourceHandler<R> {
    fn save_destination(&self, suggested_name: &str) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        self.app
            .dialog()
            .file()
            .set_title("Save a library file")
            .set_file_name(suggested_name)
            .blocking_save_file()?
            .into_path()
            .ok()
    }
    fn open_safe(&self, path: &Path) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("/usr/bin/open");
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new("explorer.exe");
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let mut command = std::process::Command::new("xdg-open");
        let status = command.arg(path).status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other("system opener failed"))
        }
    }
}

fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Resolves a saved file only when its ID is present in the current coursework, file list, and
/// download manifest. Paths and symlink targets must stay under this course's materials root.
pub fn resolve_resource(store: &Store, id: &str) -> Result<PathBuf, StoreError> {
    let _read_lock = store.read_lock()?;
    resolve_resource_locked(store, id)
}

fn resolve_resource_locked(store: &Store, id: &str) -> Result<PathBuf, StoreError> {
    Ok(resolve_named_resource_locked(store, id)?.path)
}

struct ResolvedResource {
    path: PathBuf,
    name: String,
    archived: bool,
    archive_receipt: Option<ArchivedReceipt>,
}

fn resolve_named_resource_locked(store: &Store, id: &str) -> Result<ResolvedResource, StoreError> {
    if id.len() > 300 || !id.contains(":file:") {
        return Err(StoreError::Invalid("unknown library resource"));
    }
    let coursework = store
        .read_document("coursework.json", ReadLimits::PRODUCTION.max_document_bytes)?
        .ok_or(StoreError::Invalid("coursework document is missing"))?;
    let document: Value = serde_json::from_slice(&coursework.bytes)
        .map_err(|_| StoreError::Invalid("coursework document is malformed"))?;
    let courses = document
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(StoreError::Invalid("coursework courses are malformed"))?;
    for course in courses {
        let Some(course_id) = course.get("key").and_then(Value::as_str) else {
            continue;
        };
        let Some(file_id) = id.strip_prefix(&format!("{course_id}:file:")) else {
            continue;
        };
        let Some(folder) = course.get("folder").and_then(Value::as_str) else {
            continue;
        };
        let folder = folder.strip_prefix("classes/").unwrap_or(folder);
        if !is_course_folder_name(folder) {
            continue;
        }
        let base = format!("classes/{folder}/canvas-export");
        let files = store.read_document(
            &format!("{base}/api/files.json"),
            ReadLimits::PRODUCTION.max_document_bytes,
        )?;
        let manifest = store.read_document(
            &format!("{base}/download-manifest.json"),
            ReadLimits::PRODUCTION.max_document_bytes,
        )?;
        let (Some(files), Some(manifest)) = (files, manifest) else {
            continue;
        };
        let files: Value = serde_json::from_slice(&files.bytes)
            .map_err(|_| StoreError::Invalid("library files are malformed"))?;
        let manifest: Value = serde_json::from_slice(&manifest.bytes)
            .map_err(|_| StoreError::Invalid("library manifest is malformed"))?;
        let known = files.as_array().is_some_and(|list| {
            list.iter().take(1000).any(|entry| {
                entry
                    .get("id")
                    .and_then(id_text)
                    .is_some_and(|value| value.chars().take(100).collect::<String>() == file_id)
            })
        });
        if !known {
            continue;
        }
        if let Some(entry) = manifest.as_array().and_then(|entries| {
            entries.iter().find(|entry| {
                entry.get("fileId").and_then(id_text).as_deref() == Some(file_id)
                    && entry["status"] == "saved"
            })
        }) {
            let hash = entry["sha256"]
                .as_str()
                .ok_or(StoreError::Invalid("invalid archive reference"))?;
            let size = entry["byteCount"]
                .as_u64()
                .ok_or(StoreError::Invalid("invalid archive reference"))?;
            let content_type = entry["contentType"]
                .as_str()
                .ok_or(StoreError::Invalid("invalid archive reference"))?;
            let path = crate::browser_resources::verified_blob(
                store.data_root(),
                hash,
                size,
                content_type,
            )
            .map_err(|_| StoreError::Invalid("archived library file is missing or unverified"))?;
            let name = entry
                .get("name")
                .or_else(|| entry.get("filename"))
                .and_then(Value::as_str)
                .filter(|name| is_plain_basename(name))
                .unwrap_or("canvas-file")
                .to_owned();
            return Ok(ResolvedResource {
                path,
                name,
                archived: true,
                archive_receipt: Some(ArchivedReceipt {
                    sha256: hash.to_owned(),
                    byte_count: size,
                }),
            });
        }
        let Some(name) = manifest.as_array().and_then(|list| {
            list.iter().find_map(|entry| {
                if entry.get("id").and_then(id_text).as_deref() != Some(file_id)
                    || !matches!(
                        entry.get("status").and_then(Value::as_str),
                        Some("downloaded" | "reused")
                    )
                {
                    return None;
                }
                entry.get("filename").and_then(Value::as_str)
            })
        }) else {
            continue;
        };
        if !is_plain_basename(name) {
            return Err(StoreError::Invalid("unsafe library filename"));
        }
        let materials = store
            .store_dir()
            .join("classes")
            .join(folder)
            .join("materials");
        for directory in [
            store.store_dir().join("classes"),
            store.store_dir().join("classes").join(folder),
            materials.clone(),
        ] {
            if !fs::symlink_metadata(&directory)?.file_type().is_dir() {
                return Err(StoreError::Invalid(
                    "library materials root is not a plain folder",
                ));
            }
        }
        let canonical_store = fs::canonicalize(store.store_dir())?;
        let canonical_root = fs::canonicalize(&materials)?;
        if !canonical_root.starts_with(&canonical_store) {
            return Err(StoreError::Invalid("library materials leave the app store"));
        }
        let canonical_file = fs::canonicalize(materials.join(name))?;
        if !canonical_file.starts_with(&canonical_root) || !fs::metadata(&canonical_file)?.is_file()
        {
            return Err(StoreError::Invalid("library file leaves materials"));
        }
        return Ok(ResolvedResource {
            path: canonical_file,
            name: name.to_owned(),
            archived: false,
            archive_receipt: None,
        });
    }
    Err(StoreError::Invalid("unknown library resource"))
}

/// Opens a safe file type, or saves a new private copy through the native dialog.
pub fn open_resource(
    store: &Store,
    id: &str,
    handler: &dyn ResourceHandler,
) -> Result<ResourceAction, StoreError> {
    let _read_lock = store.read_lock()?;
    let resource = resolve_named_resource_locked(store, id)?;
    let extension = resource
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !resource.archived && SAFE_OPEN_TYPES.contains(&extension.as_str()) {
        handler.open_safe(&resource.path)?;
        return Ok(ResourceAction::Opened);
    }
    let Some(destination) = handler.save_destination(&resource.name) else {
        return Ok(ResourceAction::Cancelled);
    };
    let parent = destination
        .parent()
        .ok_or(StoreError::Invalid("invalid download destination"))?;
    if !fs::symlink_metadata(parent)?.is_dir() {
        return Err(StoreError::Invalid("invalid download destination"));
    }
    let mut legacy_source = if resource.archived {
        None
    } else {
        Some(File::open(&resource.path)?)
    };
    let mut target = create_private_file(&destination)?;
    let copied = (|| -> Result<(), StoreError> {
        if resource.archived {
            let receipt = resource
                .archive_receipt
                .as_ref()
                .ok_or(StoreError::Invalid("archived library receipt is missing"))?;
            copy_verified_archive_file(&resource.path, receipt, &mut target)?;
        } else if let Some(source) = legacy_source.as_mut() {
            io::copy(source, &mut target)?;
        }
        target.sync_all()?;
        if resource.archived {
            ensure_destination_is_open_file(&destination, &target)?;
            quarantine_saved_copy(&target)
                .map_err(|_| StoreError::Invalid("saved library file could not be quarantined"))?;
            target.sync_all()?;
            ensure_destination_is_open_file(&destination, &target)?;
        }
        Ok(())
    })();
    if let Err(error) = copied {
        let target_metadata = target.metadata().ok();
        drop(target);
        if let Some(metadata) = target_metadata {
            remove_destination_if_same_file(&destination, &metadata);
        }
        return Err(error);
    }
    Ok(ResourceAction::Downloaded)
}

#[cfg(test)]
#[path = "resources_tests.rs"]
mod tests;
