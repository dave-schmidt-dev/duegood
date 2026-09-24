//! Library file resolution by projection ID, with path confinement and native actions.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::Runtime;

use crate::config::ReadLimits;
use crate::import::{is_course_folder_name, is_plain_basename};
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
        return Ok(canonical_file);
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
    let path = resolve_resource_locked(store, id)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if SAFE_OPEN_TYPES.contains(&extension.as_str()) {
        handler.open_safe(&path)?;
        return Ok(ResourceAction::Opened);
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(StoreError::Invalid("invalid library filename"))?;
    let Some(destination) = handler.save_destination(name) else {
        return Ok(ResourceAction::Cancelled);
    };
    let parent = destination
        .parent()
        .ok_or(StoreError::Invalid("invalid download destination"))?;
    if !fs::symlink_metadata(parent)?.is_dir() {
        return Err(StoreError::Invalid("invalid download destination"));
    }
    let mut source = File::open(path)?;
    let mut target = create_private_file(&destination)?;
    io::copy(&mut source, &mut target)?;
    target.sync_all()?;
    Ok(ResourceAction::Downloaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MANIFEST_FILE;
    use crate::store::{atomic_write, create_private_dir, new_preview_manifest, node_json_bytes};
    use crate::testutil::TempRoot;
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime};

    struct Double {
        saved: PathBuf,
        opened: Mutex<Vec<PathBuf>>,
        save_calls: Mutex<u32>,
    }
    impl ResourceHandler for Double {
        fn save_destination(&self, _: &str) -> Option<PathBuf> {
            *self.save_calls.lock().unwrap() += 1;
            Some(self.saved.clone())
        }
        fn open_safe(&self, path: &Path) -> io::Result<()> {
            self.opened.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }
    }

    #[test]
    fn ids_are_confined_and_safe_types_use_only_the_double() {
        let temp = TempRoot::new("resources");
        let store = Store::open(temp.path(), Duration::from_millis(200)).unwrap();
        let root = store.store_dir();
        create_private_dir(&root, false).unwrap();
        atomic_write(
            &root.join(MANIFEST_FILE),
            &node_json_bytes(&new_preview_manifest(1, 1, "x", SystemTime::now())),
        )
        .unwrap();
        atomic_write(
            &root.join("coursework.json"),
            &node_json_bytes(
                &serde_json::json!({ "courses": [{ "key": "syn", "folder": "syn" }], "items": [] }),
            ),
        )
        .unwrap();
        let base = root.join("classes/syn/canvas-export");
        for dir in [
            root.join("classes"),
            root.join("classes/syn"),
            base.clone(),
            base.join("api"),
            root.join("classes/syn/materials"),
        ] {
            create_private_dir(&dir, false).unwrap();
        }
        atomic_write(
            &base.join("api/files.json"),
            &node_json_bytes(&serde_json::json!([{ "id": 1 }, { "id": 2 }, { "id": 3 }])),
        )
        .unwrap();
        atomic_write(
            &base.join("download-manifest.json"),
            &node_json_bytes(&serde_json::json!([
                { "id": 1, "status": "downloaded", "filename": "guide.pdf" },
                { "id": 2, "status": "downloaded", "filename": "archive.bin" },
                { "id": 3, "status": "downloaded", "filename": "outside.txt" }
            ])),
        )
        .unwrap();
        let materials = root.join("classes/syn/materials");
        atomic_write(&materials.join("guide.pdf"), b"%PDF synthetic").unwrap();
        atomic_write(&materials.join("archive.bin"), b"synthetic binary").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            temp.path().join("outside.txt"),
            materials.join("outside.txt"),
        )
        .unwrap();
        atomic_write(&temp.path().join("outside.txt"), b"outside").unwrap();
        let handler = Double {
            saved: temp.path().join("saved.bin"),
            opened: Mutex::new(Vec::new()),
            save_calls: Mutex::new(0),
        };
        assert_eq!(
            open_resource(&store, "syn:file:1", &handler).unwrap(),
            ResourceAction::Opened
        );
        assert_eq!(handler.opened.lock().unwrap().len(), 1);
        assert_eq!(
            open_resource(&store, "syn:file:2", &handler).unwrap(),
            ResourceAction::Downloaded
        );
        assert_eq!(fs::read(&handler.saved).unwrap(), b"synthetic binary");
        assert_eq!(*handler.save_calls.lock().unwrap(), 1);
        for id in ["syn:file:999", "../syn:file:1", "/syn:file:1", "syn:file:3"] {
            assert!(resolve_resource(&store, id).is_err());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&handler.saved).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
