//! Due Good desktop shell (Tauri 2).
//!
//! Rust owns all store I/O. The webview gets narrow commands
//! (`commands::COMMAND_NAMES`) for store status, import, bounded reads, personal mutations,
//! native resources and clipboard, snapshots, and rollback export.
//! The store lives in the fixed application-data folder for the bundle identifier.

mod canvas;
mod capture;
mod clipboard;
mod commands;
mod config;
mod documents;
mod downloads;
mod export;
mod history;
pub mod ical;
mod ical_apply;
pub mod ical_receiver;
mod import;
mod locking;
mod reconcile;
mod refresh;
mod resources;
mod snapshots;
mod store;

#[cfg(test)]
mod phase4_smoke;

use tauri::Manager;

const FRONTEND_MANIFEST_PATH: &str = "asset-manifest.json";
const FRONTEND_MANIFEST_FORMAT: &str = "duegood-frontend-assets";
const FRONTEND_MANIFEST_MAX_BYTES: usize = 1024 * 1024;
const FRONTEND_MANIFEST_MAX_FILES: usize = 10_000;
const FRONTEND_INDEX_HTML: &[u8] = include_bytes!("../../dist/public/index.html");

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FrontendAssetManifest {
    format: String,
    version: u32,
    files: Vec<FrontendAssetEntry>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FrontendAssetEntry {
    path: String,
    sha256: String,
}

fn generated_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

/// Checks the exact decompressed frontend bytes Tauri exposes to its production asset protocol.
///
/// This is also the no-window release-build verification path. It reads only embedded assets and
/// prints no paths, contents, or user data.
pub fn verify_embedded_assets() -> Result<usize, &'static str> {
    let context = generated_context();
    verify_embedded_asset_set(context.assets(), context.config())
}

#[cfg(test)]
mod embedded_asset_tests;

fn verify_embedded_asset_set(
    assets: &dyn tauri::Assets<tauri::Wry>,
    config: &tauri_utils::config::Config,
) -> Result<usize, &'static str> {
    use sha2::{Digest, Sha256};
    use std::collections::BTreeSet;
    use tauri::utils::assets::AssetKey;

    let manifest_key = AssetKey::from(FRONTEND_MANIFEST_PATH);
    let manifest_bytes = assets
        .get(&manifest_key)
        .ok_or("embedded frontend manifest is missing")?;
    if manifest_bytes.len() > FRONTEND_MANIFEST_MAX_BYTES {
        return Err("embedded frontend manifest exceeds the size limit");
    }
    let manifest: FrontendAssetManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "embedded frontend manifest is invalid")?;
    if manifest.format != FRONTEND_MANIFEST_FORMAT
        || manifest.version != 1
        || manifest.files.is_empty()
        || manifest.files.len() > FRONTEND_MANIFEST_MAX_FILES
    {
        return Err("embedded frontend manifest has an unsupported format");
    }

    let mut expected = BTreeSet::new();
    expected.insert(String::from(manifest_key));
    let mut index_html_seen = false;
    for entry in &manifest.files {
        if entry.path.is_empty()
            || entry.path.len() > 1024
            || entry.path.starts_with('/')
            || entry.path.contains('\\')
            || entry
                .path
                .split('/')
                .any(|component| component.is_empty() || component == "." || component == "..")
        {
            return Err("embedded frontend manifest contains an unsafe asset path");
        }
        if entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("embedded frontend manifest contains an invalid digest");
        }
        let key = AssetKey::from(entry.path.as_str());
        if !expected.insert(String::from(key.clone())) {
            return Err("embedded frontend manifest contains a duplicate asset");
        }
        let bytes = assets
            .get(&key)
            .ok_or("an embedded frontend asset is missing")?;
        if entry.path.to_ascii_lowercase().ends_with(".html") {
            if entry.path != "index.html" || index_html_seen {
                return Err("embedded frontend contains an unexpected HTML asset");
            }
            index_html_seen = true;
            let source_digest = format!("{:x}", Sha256::digest(FRONTEND_INDEX_HTML));
            if source_digest != entry.sha256 {
                return Err("the raw frontend HTML digest does not match the manifest");
            }
            let expected_html = if config.app.security.csp.is_some() {
                let document = tauri_utils::html2::parse_doc(
                    String::from_utf8_lossy(FRONTEND_INDEX_HTML).into_owned(),
                );
                tauri_utils::html2::inject_nonce_token(
                    &document,
                    &config.app.security.dangerous_disable_asset_csp_modification,
                );
                tauri_utils::html2::serialize_doc(&document)
            } else {
                FRONTEND_INDEX_HTML.to_vec()
            };
            if bytes.as_ref() != expected_html.as_slice() {
                return Err("embedded frontend HTML differs from its configured Tauri transform");
            }
        } else {
            let digest = format!("{:x}", Sha256::digest(bytes.as_ref()));
            if digest != entry.sha256 {
                return Err("an embedded frontend asset digest does not match");
            }
        }
    }
    if !index_html_seen {
        return Err("the raw frontend index HTML is missing from the manifest");
    }

    let actual: BTreeSet<String> = assets.iter().map(|(key, _)| key.into_owned()).collect();
    if actual != expected {
        return Err("embedded frontend asset set differs from its manifest");
    }
    Ok(manifest.files.len())
}

/// Starts the desktop app.
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_root = config::resolve_data_root(app.path().app_data_dir().ok());
            let home = app.path().home_dir().ok();
            let picker = commands::DialogPicker::new(app.handle().clone());
            let state = commands::AppState::open_with_handlers(
                data_root,
                home.as_deref(),
                Box::new(picker),
                Box::new(clipboard::SystemClipboard),
                Some(Box::new(resources::NativeResourceHandler::new(
                    app.handle().clone(),
                ))),
                commands::Settings::PRODUCTION,
            );
            app.manage(state);
            Ok(())
        });
    let app = commands::register_handlers(builder)
        .build(generated_context())
        .expect("error while building Due Good");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle
                .state::<commands::AppState>()
                .terminate_canvas_refresh();
        }
    });
}

/// Runs the bundled refresh helper without starting the desktop webview.
pub fn run_refresh_helper() -> Result<(), String> {
    commands::run_refresh_helper()
}

/// Reports the helper's fixed app-data folder for a launch-only installation check. This does
/// not read the store, start a refresh, contact Canvas, or invoke the credential broker.
pub fn refresh_helper_store_root() -> Result<std::path::PathBuf, String> {
    config::resolve_helper_data_root()
}

#[cfg(test)]
pub(crate) mod testutil {
    //! Test-only helpers: private temp roots under the test bundle identifier, tree snapshots,
    //! mode assertions, and the synthetic legacy fixture materializer.

    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::Value;

    use crate::config::TEST_BUNDLE_IDENTIFIER;
    use crate::store::node_json_bytes;

    /// Synthetic legacy tree described as JSON (shared with the TypeScript parity test).
    const FIXTURE: &str = include_str!("../../test/fixtures/tauri-legacy-source.json");

    /// A private temporary directory removed on drop.
    pub struct TempRoot {
        path: PathBuf,
    }

    impl TempRoot {
        pub fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "{TEST_BUNDLE_IDENTIFIER}-{label}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            crate::store::create_private_dir(&path, false).expect("create temp root");
            let path = fs::canonicalize(&path).expect("canonical temp root");
            TempRoot { path }
        }

        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// One entry of a tree snapshot.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Entry {
        Dir,
        File(Vec<u8>),
        Symlink(String),
    }

    /// Every entry below `root` (relative, `/`-separated) with exact bytes; empty when absent.
    pub fn snapshot_tree(root: &Path) -> BTreeMap<String, Entry> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Entry>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries {
                let entry = entry.expect("entry");
                let path = entry.path();
                let relative = path
                    .strip_prefix(root)
                    .expect("relative")
                    .to_string_lossy()
                    .replace('\\', "/");
                let file_type = entry.file_type().expect("type");
                if file_type.is_symlink() {
                    let target = fs::read_link(&path).expect("link");
                    out.insert(
                        relative,
                        Entry::Symlink(target.to_string_lossy().into_owned()),
                    );
                } else if file_type.is_dir() {
                    out.insert(relative, Entry::Dir);
                    walk(root, &path, out);
                } else {
                    out.insert(relative, Entry::File(fs::read(&path).expect("bytes")));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    /// Asserts every directory below and including `root` is `0700` and every file `0600`.
    pub fn assert_private_tree(root: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fn check(path: &Path) {
                let metadata = fs::symlink_metadata(path).expect("metadata");
                assert!(
                    !metadata.file_type().is_symlink(),
                    "no symlinks in app data"
                );
                let mode = metadata.permissions().mode() & 0o777;
                if metadata.is_dir() {
                    assert_eq!(mode, 0o700, "directory mode");
                    for entry in fs::read_dir(path).expect("read dir") {
                        check(&entry.expect("entry").path());
                    }
                } else {
                    assert_eq!(mode, 0o600, "file mode");
                }
            }
            check(root);
        }
        #[cfg(not(unix))]
        let _ = root;
    }

    fn decode_hex(text: &str) -> Vec<u8> {
        let digits: Vec<u8> = text
            .bytes()
            .filter(|byte| !byte.is_ascii_whitespace())
            .collect();
        assert!(digits.len().is_multiple_of(2), "hex length");
        digits
            .chunks(2)
            .map(|pair| {
                u8::from_str_radix(std::str::from_utf8(pair).expect("ascii"), 16)
                    .expect("hex digit")
            })
            .collect()
    }

    /// Replaces `{n}` in strings with `n`; the exact string `{n#}` becomes the number `n`.
    fn instantiate(template: &Value, n: u64) -> Value {
        match template {
            Value::String(text) if text == "{n#}" => Value::from(n),
            Value::String(text) => Value::from(text.replace("{n}", &n.to_string())),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| instantiate(item, n)).collect())
            }
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), instantiate(value, n)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// Materializes the synthetic legacy tree into `dest` and returns its canonical path.
    pub fn materialize_fixture(dest: &Path) -> PathBuf {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture JSON");
        fs::create_dir_all(dest).expect("fixture root");
        for entry in fixture["entries"].as_array().expect("entries") {
            let relative = entry["path"].as_str().expect("path");
            assert!(
                !relative.starts_with('/') && !relative.contains(".."),
                "fixture paths stay inside"
            );
            let target = dest.join(relative);
            fs::create_dir_all(target.parent().expect("parent")).expect("parents");
            if let Some(value) = entry.get("json") {
                fs::write(&target, node_json_bytes(value)).expect("json entry");
            } else if let Some(text) = entry.get("text").and_then(Value::as_str) {
                fs::write(&target, text).expect("text entry");
            } else if let Some(hex) = entry.get("hex").and_then(Value::as_str) {
                fs::write(&target, decode_hex(hex)).expect("hex entry");
            } else if let Some(repeat) = entry.get("jsonRepeat") {
                let count = repeat["count"].as_u64().expect("count");
                let items: Vec<Value> = (1..=count)
                    .map(|n| instantiate(&repeat["template"], n))
                    .collect();
                fs::write(&target, node_json_bytes(&Value::Array(items))).expect("repeat entry");
            } else if let Some(link) = entry.get("symlink").and_then(Value::as_str) {
                #[cfg(unix)]
                std::os::unix::fs::symlink(link, &target).expect("symlink entry");
                #[cfg(not(unix))]
                let _ = link;
            } else {
                panic!("unknown fixture entry kind for {relative}");
            }
        }
        fs::canonicalize(dest).expect("canonical fixture root")
    }
}
