use super::*;
use crate::config::TEST_BUNDLE_IDENTIFIER;
use crate::testutil::{materialize_fixture, snapshot_tree, TempRoot};
use std::path::PathBuf;

struct EmptyPicker;

impl super::super::FolderPicker for EmptyPicker {
    fn pick_folder(&self) -> Option<PathBuf> {
        None
    }
}

struct ExportPicker(PathBuf);

impl super::super::FolderPicker for ExportPicker {
    fn pick_folder(&self) -> Option<PathBuf> {
        Some(self.0.clone())
    }

    fn pick_export_folder(&self) -> Option<PathBuf> {
        Some(self.0.clone())
    }
}

#[test]
fn missing_capture_returns_content_free_error_without_changing_store() {
    let root = TempRoot::new("commands-browser-import-missing");
    let data_root = root.path().join(TEST_BUNDLE_IDENTIFIER);
    let app = super::super::AppState::open(
        Ok(data_root.clone()),
        Some(root.path()),
        Box::new(EmptyPicker),
        super::super::Settings::PRODUCTION,
    );
    let store = app.shared.store().expect("test store opened");
    let store_dir = store.store_dir();
    let before = snapshot_tree(&store_dir);

    let error = app
        .shared
        .import_browser_capture(false, &mut |_| {})
        .expect_err("no capture receipt exists");

    assert_eq!(error.code, "CAPTURE_ATTEMPT_UNAVAILABLE");
    assert_eq!(
        error.message,
        "The current Canvas browser capture could not be imported."
    );
    assert_eq!(snapshot_tree(&store_dir), before);
}

#[test]
fn explicit_first_account_confirmation_still_uses_native_capture_validation() {
    let root = TempRoot::new("commands-browser-import-confirmation");
    let data_root = root.path().join(TEST_BUNDLE_IDENTIFIER);
    let app = super::super::AppState::open(
        Ok(data_root),
        Some(root.path()),
        Box::new(EmptyPicker),
        super::super::Settings::PRODUCTION,
    );

    let error = app
        .shared
        .import_browser_capture(true, &mut |_| {})
        .expect_err("confirmation without a validated capture must fail");

    assert_eq!(error.code, "CAPTURE_ATTEMPT_UNAVAILABLE");
}

#[test]
fn native_export_uses_owner_picker_for_a_nonlegacy_store() {
    use crate::config::COURSEWORK_FILE;
    use crate::import::{self, ImportOptions};
    use crate::store::{atomic_write, node_json_bytes, Store};
    use serde_json::Value;

    let root = TempRoot::new("commands-browser-native-export");
    let fixture = materialize_fixture(&root.path().join("synthetic-legacy"));
    let data_root = root.path().join(TEST_BUNDLE_IDENTIFIER);
    let destination = root.path().join("owner-selected-export-folder");
    crate::store::create_private_dir(&destination, false).unwrap();
    let settings = super::super::Settings::PRODUCTION;
    let store = Store::open(&data_root, settings.write_lock_timeout).unwrap();
    import::import_legacy_root(
        &store,
        &fixture,
        &ImportOptions {
            limits: settings.import_limits,
            legacy_lock_timeout: settings.legacy_lock_timeout,
            replace_preview: false,
        },
        &mut |_| {},
    )
    .unwrap();
    let coursework = store.store_dir().join(COURSEWORK_FILE);
    let mut document: Value = serde_json::from_slice(&std::fs::read(&coursework).unwrap()).unwrap();
    document["pendingSourceLinks"] = serde_json::json!([]);
    atomic_write(&coursework, &node_json_bytes(&document)).unwrap();
    let original_coursework = std::fs::read(&coursework).unwrap();
    assert!(crate::export::ensure_legacy_refreshable_export_compatible(&store).is_err());
    drop(store);

    let app = super::super::AppState::open_with_handlers(
        Ok(data_root),
        Some(root.path()),
        Box::new(ExportPicker(destination.clone())),
        Box::new(crate::clipboard::SystemClipboard),
        None,
        settings,
    );
    app.shared.wait_for_snapshots();
    let mut progress = crate::export::ExportProgress::default();
    let result = app
        .shared
        .export_native_store(&mut |event| progress = event)
        .expect("native export should support current native coursework");

    assert_eq!(result, progress);
    assert!(result.files_done > 0);
    assert!(result.bytes_done > 0);
    let exports: Vec<_> = std::fs::read_dir(&destination)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(exports.len(), 1);
    assert!(exports[0].join(COURSEWORK_FILE).is_file());
    assert_eq!(
        std::fs::read(exports[0].join(COURSEWORK_FILE)).unwrap(),
        original_coursework
    );
}
