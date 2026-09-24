//! Fixed identities, store layout names, and declared limits.
//!
//! The store location is not configurable: production resolves the Tauri application-data
//! directory for [`PRODUCTION_BUNDLE_IDENTIFIER`]. Only builds with the `test-overrides` Cargo
//! feature read an explicit data root, and such builds refuse to fall back to the real directory.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

/// Bundle identifier of the released application. Must equal `tauri.conf.json`'s `identifier`.
pub const PRODUCTION_BUNDLE_IDENTIFIER: &str = "com.zerodelta.duegood";

/// Bundle identifier every test and staged smoke uses, so no test resolves the production store.
#[cfg(any(test, feature = "test-overrides"))]
pub const TEST_BUNDLE_IDENTIFIER: &str = "com.zerodelta.duegood.test";

/// Environment variable naming the explicit data root; read only under `test-overrides`.
#[cfg(feature = "test-overrides")]
pub const TEST_DATA_ROOT_ENV: &str = "DUEGOOD_TEST_DATA_ROOT";

/// Directory, inside the data root, that holds the store in the legacy on-disk layout.
pub const STORE_DIR: &str = "store";
/// Directory, inside the data root, that holds never-deleted archives of replaced preview stores.
pub const BACKUPS_DIR: &str = "backups";
/// Versioned manifest file inside the store directory. Not part of the legacy layout.
pub const MANIFEST_FILE: &str = "duegood-store.json";
/// Lock file held for the whole app lifetime; a second instance cannot acquire it.
pub const INSTANCE_LOCK_FILE: &str = "duegood.instance.lock";
/// Lock file held briefly around every store document write.
pub const WRITE_LOCK_FILE: &str = "duegood.write.lock";
/// Private app-data setting that enables owner-requested Canvas refresh. Missing means disabled.
pub const CANVAS_REFRESH_SETTING_FILE: &str = "canvas-refresh-enabled.json";
/// Journal recording an in-flight preview replacement, used for crash recovery on open.
pub const REPLACE_JOURNAL_FILE: &str = "replace-journal.json";
/// Prefix of the import staging directory created inside the data root.
pub const STAGING_PREFIX: &str = ".import-staging-";

/// Legacy coursework document; its directory is the legacy root.
pub const COURSEWORK_FILE: &str = "coursework.json";
/// Legacy writer's adjacent directory lock, `${coursework.json}.duegood-lock`.
pub const LEGACY_LOCK_DIR: &str = "coursework.json.duegood-lock";

/// Manifest format marker and version.
pub const MANIFEST_FORMAT: &str = "duegood-store";
pub const MANIFEST_VERSION: u64 = 1;

/// Legacy lock wait, matching the Node writer's 5 s acquisition timeout.
pub const LEGACY_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
/// Short OS write-lock wait for a single document write.
pub const WRITE_LOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// Declared import caps. Anything over a cap refuses the import with a named count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLimits {
    /// Largest single file (materials, sidecars, documents).
    pub max_file_bytes: u64,
    /// Largest JSON document; JSON is parsed and validated, so it has a tighter cap.
    pub max_json_bytes: u64,
    /// Largest total of all imported files.
    pub max_total_bytes: u64,
    /// Most files and directories in the imported tree.
    pub max_entries: u64,
    /// Deepest directory nesting below a course `materials` folder.
    pub max_material_depth: u64,
}

impl ImportLimits {
    /// Production caps.
    pub const PRODUCTION: ImportLimits = ImportLimits {
        max_file_bytes: 256 * 1024 * 1024,
        max_json_bytes: 32 * 1024 * 1024,
        max_total_bytes: 4 * 1024 * 1024 * 1024,
        max_entries: 100_000,
        max_material_depth: 16,
    };
}

/// Declared caps for the read-only document commands. Over-cap documents fail; nothing is truncated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadLimits {
    pub max_document_bytes: u64,
    pub max_course_folders: usize,
    pub max_total_bytes: u64,
}

impl ReadLimits {
    /// Production caps. The JSON cap matches [`ImportLimits::PRODUCTION`].
    pub const PRODUCTION: ReadLimits = ReadLimits {
        max_document_bytes: 32 * 1024 * 1024,
        max_course_folders: 500,
        max_total_bytes: 256 * 1024 * 1024,
    };
}

/// Resolves the data root for this process.
///
/// Release builds always return `app_data_dir` (the Tauri application-data directory, whose
/// final component is the bundle identifier) and refuse any other folder. `test-overrides`
/// builds require an explicit absolute data root named for [`TEST_BUNDLE_IDENTIFIER`] and never
/// fall back to the real directory.
pub fn resolve_data_root(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    #[cfg(feature = "test-overrides")]
    {
        let _ = app_data_dir;
        let value = std::env::var_os(TEST_DATA_ROOT_ENV)
            .ok_or_else(|| "test build requires an explicit data root".to_string())?;
        explicit_data_root(Path::new(&value))
    }
    #[cfg(not(feature = "test-overrides"))]
    {
        let folder =
            app_data_dir.ok_or_else(|| "application data folder is unavailable".to_string())?;
        if folder.file_name() != Some(std::ffi::OsStr::new(PRODUCTION_BUNDLE_IDENTIFIER)) {
            return Err("application data folder does not match the bundle identifier".into());
        }
        Ok(folder)
    }
}

/// Resolves the same fixed app-data root for the standalone helper that Tauri resolves for the
/// application. The helper accepts no root argument. Test builds use only their explicit test
/// root, and release refresh is currently available on macOS only.
pub fn resolve_helper_data_root() -> Result<PathBuf, String> {
    #[cfg(feature = "test-overrides")]
    {
        let value = std::env::var_os(TEST_DATA_ROOT_ENV)
            .ok_or_else(|| "test build requires an explicit data root".to_string())?;
        explicit_data_root(Path::new(&value))
    }
    #[cfg(all(not(feature = "test-overrides"), target_os = "macos"))]
    {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| "the application data folder is unavailable".to_string())?;
        Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(PRODUCTION_BUNDLE_IDENTIFIER))
    }
    #[cfg(all(not(feature = "test-overrides"), not(target_os = "macos")))]
    {
        Err("Canvas refresh is available only on macOS".into())
    }
}

/// Fixed sibling path for the bundled helper executable, derived from the running app binary.
/// This local check says only that the helper is installed and executable; it does not check the
/// BWS consumer, its pin, or credential availability.
pub fn refresh_helper_path(app_executable: &Path) -> Option<PathBuf> {
    app_executable
        .parent()
        .map(|parent| parent.join("duegood-refresh"))
}

/// Fixed BWS broker executable path for the desktop host. The app never searches `PATH` or uses a
/// shell, and the consumer name remains a literal at the call site. The account home comes from
/// the process UID's system account record; `HOME` is not trusted for locating the broker.
pub fn bws_secret_exec_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        bws_secret_exec_path_for_home(current_account_home()?)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn bws_secret_exec_path_for_home(home: PathBuf) -> Option<PathBuf> {
    if !home.is_absolute() {
        return None;
    }
    Some(home.join(".agent").join("bin").join("bws-secret-exec"))
}

#[cfg(target_os = "macos")]
fn current_account_home() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStringExt;

    let uid = unsafe { libc::getuid() };
    let mut record: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buffer = vec![0_u8; 16 * 1024];
    loop {
        let mut result = std::ptr::null_mut();
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                &mut record,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE {
            if buffer.len() >= 1024 * 1024 {
                return None;
            }
            buffer.resize(buffer.len() * 2, 0);
            continue;
        }
        if status != 0 || result.is_null() || record.pw_dir.is_null() {
            return None;
        }

        let home = unsafe { CStr::from_ptr(record.pw_dir) }.to_bytes().to_vec();
        let home = PathBuf::from(std::ffi::OsString::from_vec(home));
        return home.is_absolute().then_some(home);
    }
}

/// Returns the fixed owner-setting path under the already resolved private app-data root.
pub fn canvas_refresh_setting_path(data_root: &Path) -> PathBuf {
    data_root.join(CANVAS_REFRESH_SETTING_FILE)
}

/// Validates an explicit data root (tests and staged smokes only): absolute, named for the test
/// bundle identifier, and never inside a folder named for the production identifier.
#[cfg(feature = "test-overrides")]
pub fn explicit_data_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("explicit data root must be absolute".into());
    }
    if path.file_name() != Some(std::ffi::OsStr::new(TEST_BUNDLE_IDENTIFIER)) {
        return Err("explicit data root must be named for the test bundle identifier".into());
    }
    if path
        .components()
        .any(|part| part.as_os_str() == PRODUCTION_BUNDLE_IDENTIFIER)
    {
        return Err("explicit data root must not be inside the production data folder".into());
    }
    Ok(path.to_path_buf())
}

/// Formats a folder for display, replacing the home prefix with `~` so screenshots of the
/// first-run screen never carry an account name.
pub fn display_folder(path: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home {
        if let Ok(rest) = path.strip_prefix(home) {
            return if rest.as_os_str().is_empty() {
                "~".into()
            } else {
                format!("~/{}", rest.display())
            };
        }
    }
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_identifier_matches_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(config["identifier"], PRODUCTION_BUNDLE_IDENTIFIER);
        assert_ne!(PRODUCTION_BUNDLE_IDENTIFIER, TEST_BUNDLE_IDENTIFIER);
        assert!(TEST_BUNDLE_IDENTIFIER.ends_with(".test"));
    }

    #[test]
    fn tauri_config_is_strict() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let csp = config["app"]["security"]["csp"].as_str().expect("csp");
        for directive in [
            "default-src 'self'",
            "script-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
            "connect-src ipc: http://ipc.localhost",
        ] {
            assert!(csp.contains(directive), "missing CSP directive {directive}");
        }
        assert!(!csp.contains("unsafe-eval"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
        assert!(!csp.contains("http:// ") && !csp.contains("https:"));
        assert_eq!(config["build"]["frontendDist"], "../dist/public");
        assert_eq!(config["mainBinaryName"], "duegood-desktop");
        assert!(
            config["build"].get("devUrl").is_none(),
            "no remote or dev URL"
        );
        assert_eq!(config["app"]["withGlobalTauri"], false);
        assert_eq!(config["bundle"]["active"], true);
        assert_eq!(
            config["bundle"]["externalBin"],
            serde_json::json!(["binaries/duegood-refresh"]),
            "only the fixed refresh helper is bundled"
        );
    }

    #[test]
    fn capabilities_grant_only_our_commands() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).expect("capability");
        let granted: Vec<&str> = capability["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .map(|value| value.as_str().expect("string permission"))
            .collect();
        let expected: Vec<String> = crate::commands::COMMAND_NAMES
            .iter()
            .map(|name| format!("allow-{}", name.replace('_', "-")))
            .collect();
        assert_eq!(
            granted,
            expected.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert!(
            capability.get("remote").is_none(),
            "no remote URL may reach commands"
        );
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        let build_script = include_str!("../build.rs");
        for name in crate::commands::COMMAND_NAMES {
            assert!(
                build_script.contains(&format!("\"{name}\"")),
                "build.rs lacks {name}"
            );
        }
    }

    #[cfg(feature = "test-overrides")]
    #[test]
    fn test_data_root_is_explicit_and_uses_test_identifier() {
        let base = std::env::temp_dir().join(TEST_BUNDLE_IDENTIFIER);
        assert_eq!(explicit_data_root(&base).expect("absolute"), base);
        assert!(explicit_data_root(Path::new("relative/com.zerodelta.duegood.test")).is_err());
        assert!(
            explicit_data_root(&std::env::temp_dir().join("other-root")).is_err(),
            "must use the test identifier"
        );
        let inside_production = std::env::temp_dir()
            .join(PRODUCTION_BUNDLE_IDENTIFIER)
            .join(TEST_BUNDLE_IDENTIFIER);
        assert!(
            explicit_data_root(&inside_production).is_err(),
            "never inside the production folder"
        );
        // With the feature on, resolution never falls back to the application-data folder.
        if std::env::var_os(TEST_DATA_ROOT_ENV).is_none() {
            assert!(resolve_data_root(Some(PathBuf::from("/nonexistent/app-data"))).is_err());
        }
    }

    #[test]
    fn display_folder_hides_the_home_prefix() {
        let home = Path::new("/synthetic-home");
        assert_eq!(
            display_folder(
                Path::new("/synthetic-home/Library/Application Support/com.zerodelta.duegood"),
                Some(home)
            ),
            "~/Library/Application Support/com.zerodelta.duegood"
        );
        assert_eq!(
            display_folder(Path::new("/opt/data"), Some(home)),
            "/opt/data"
        );
        assert_eq!(display_folder(Path::new("/opt/data"), None), "/opt/data");
    }

    #[test]
    fn bws_broker_path_is_fixed_under_an_absolute_account_home() {
        assert_eq!(
            bws_secret_exec_path_for_home(PathBuf::from("/synthetic-home")),
            Some(PathBuf::from("/synthetic-home/.agent/bin/bws-secret-exec"))
        );
        assert_eq!(
            bws_secret_exec_path_for_home(PathBuf::from("relative-home")),
            None,
            "a relative home must not select a broker"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bws_broker_path_uses_the_current_system_account_home() {
        let home = current_account_home().expect("system account home");
        assert_eq!(bws_secret_exec_path(), bws_secret_exec_path_for_home(home));
    }

    #[test]
    fn production_limits_are_declared_and_ordered() {
        let limits = ImportLimits::PRODUCTION;
        assert!(limits.max_json_bytes <= limits.max_file_bytes);
        assert!(limits.max_file_bytes <= limits.max_total_bytes);
        assert_eq!(
            ReadLimits::PRODUCTION.max_document_bytes,
            limits.max_json_bytes
        );
    }
}
