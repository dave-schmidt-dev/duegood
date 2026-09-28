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
    expected_name: Option<&'static str>,
}

enum SaveTimeMutation {
    Replace(Vec<u8>),
    #[cfg(unix)]
    Symlink(PathBuf),
}

struct MutatingDouble {
    saved: PathBuf,
    source: PathBuf,
    mutation: SaveTimeMutation,
}

impl ResourceHandler for MutatingDouble {
    fn save_destination(&self, _suggested_name: &str) -> Option<PathBuf> {
        match &self.mutation {
            SaveTimeMutation::Replace(bytes) => atomic_write(&self.source, bytes).unwrap(),
            #[cfg(unix)]
            SaveTimeMutation::Symlink(target) => {
                fs::remove_file(&self.source).unwrap();
                std::os::unix::fs::symlink(target, &self.source).unwrap();
            }
        }
        Some(self.saved.clone())
    }

    fn open_safe(&self, _path: &Path) -> io::Result<()> {
        unreachable!("archived resources are always saved")
    }
}
impl ResourceHandler for Double {
    fn save_destination(&self, name: &str) -> Option<PathBuf> {
        if let Some(expected) = self.expected_name {
            assert_eq!(name, expected);
        }
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
        expected_name: None,
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

#[test]
fn archived_resources_save_named_copies_and_refuse_changed_or_missing_blobs() {
    let temp = TempRoot::new("archive-resource");
    let store = Store::open(temp.path(), Duration::from_millis(200)).unwrap();
    let root = store.store_dir();
    let base = root.join("classes/syn/canvas-export");
    let blobs = temp.path().join("canvas-resource-archive/blobs");
    for directory in [
        &root,
        &root.join("classes"),
        &root.join("classes/syn"),
        &base,
        &base.join("api"),
        &temp.path().join("canvas-resource-archive"),
        &blobs,
    ] {
        create_private_dir(directory, false).unwrap();
    }
    let bytes = b"%PDF-1.7\nsynthetic";
    let hash = crate::store::sha256_hex(bytes);
    atomic_write(
        &root.join("coursework.json"),
        &node_json_bytes(
            &serde_json::json!({"courses":[{"key":"syn","folder":"classes/syn"}],"items":[]}),
        ),
    )
    .unwrap();
    atomic_write(
        &base.join("api/files.json"),
        &node_json_bytes(&serde_json::json!([{"id":1}])),
    )
    .unwrap();
    atomic_write(&base.join("download-manifest.json"), &node_json_bytes(&serde_json::json!([{"fileId":1,"status":"saved","sha256":hash,"byteCount":bytes.len(),"contentType":"application/pdf","name":"guide.pdf","sourceAuthenticity":"unverified"}]))).unwrap();
    let blob = blobs.join(&hash);
    atomic_write(&blob, bytes).unwrap();
    let handler = Double {
        saved: temp.path().join("copy.pdf"),
        opened: Mutex::new(Vec::new()),
        save_calls: Mutex::new(0),
        expected_name: Some("guide.pdf"),
    };
    assert_eq!(
        open_resource(&store, "syn:file:1", &handler).unwrap(),
        ResourceAction::Downloaded
    );
    assert_eq!(fs::read(&handler.saved).unwrap(), bytes);
    assert!(handler.opened.lock().unwrap().is_empty());
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let saved = std::ffi::CString::new(handler.saved.as_os_str().as_bytes()).unwrap();
        let length = unsafe {
            libc::getxattr(
                saved.as_ptr(),
                b"com.apple.quarantine\0".as_ptr().cast(),
                std::ptr::null_mut(),
                0,
                0,
                0,
            )
        };
        assert!(length > 0, "saved archive copy must carry quarantine");
    }

    let mut replaced_bytes = bytes.to_vec();
    replaced_bytes[0] ^= 1;
    let replacement = MutatingDouble {
        saved: temp.path().join("replaced-copy.pdf"),
        source: blob.clone(),
        mutation: SaveTimeMutation::Replace(replaced_bytes),
    };
    assert!(open_resource(&store, "syn:file:1", &replacement).is_err());
    assert!(!replacement.saved.exists());

    atomic_write(&blob, bytes).unwrap();
    #[cfg(unix)]
    {
        let symlink_target = temp.path().join("symlink-target.pdf");
        atomic_write(&symlink_target, bytes).unwrap();
        let symlinked = MutatingDouble {
            saved: temp.path().join("symlink-copy.pdf"),
            source: blob.clone(),
            mutation: SaveTimeMutation::Symlink(symlink_target),
        };
        assert!(open_resource(&store, "syn:file:1", &symlinked).is_err());
        assert!(!symlinked.saved.exists());
    }

    atomic_write(&blob, bytes).unwrap();
    atomic_write(&blob, b"changed").unwrap();
    assert!(resolve_resource(&store, "syn:file:1").is_err());
    fs::remove_file(blob).unwrap();
    assert!(resolve_resource(&store, "syn:file:1").is_err());
}
