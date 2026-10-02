//! Integrity checks for the fixed browser runtime embedded in the signed app bundle.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) const RUNTIME_MANIFEST: &str = "manifest.json";
pub(super) const RUNTIME_MANIFEST_FORMAT: &str = "duegood-browser-runtime";
pub(super) const RUNTIME_ENTRYPOINT: &str = "scripts/canvas-browser-app-refresh.mjs";
pub(super) const RUNTIME_NODE_VERSION: &str = "26.10.0";
const NODE_SOURCE_URL: &str = "https://nodejs.org/dist/v26.10.0/node-v26.10.0-darwin-arm64.tar.gz";
const NODE_SOURCE_SHA256: &str = "751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9";
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RUNTIME_FILES: usize = 15_000;
const MAX_RUNTIME_BYTES: u64 = 256 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES: u64 = 256 * 1024 * 1024;

pub(super) const PACKAGE_PINS: [(&str, &str); 4] = [
    ("playwright-core", "1.63.0"),
    ("@esbuild/darwin-arm64", "0.28.2"),
    ("esbuild", "0.28.2"),
    ("pdfjs-dist", "6.3.289"),
];

#[derive(Debug, Clone)]
pub(in crate::commands) struct BrowserRuntime {
    pub(super) root: PathBuf,
    pub(super) node: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeManifest {
    format: String,
    version: u32,
    node_version: String,
    node_source: NodeSource,
    entrypoint: String,
    packages: Vec<PackagePin>,
    files: Vec<RuntimeFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeSource {
    url: String,
    archive_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackagePin {
    name: String,
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeFile {
    path: String,
    sha256: String,
    size: u64,
}

impl BrowserRuntime {
    pub(in crate::commands) fn discover(executable: &Path) -> Result<Self, ()> {
        #[cfg(target_os = "macos")]
        {
            let root = crate::config::bundled_browser_runtime_dir(executable).ok_or(())?;
            Self::verify(&root)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = executable;
            Err(())
        }
    }

    pub(super) fn verify(root: &Path) -> Result<Self, ()> {
        let root_metadata = fs::symlink_metadata(root).map_err(|_| ())?;
        if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
            return Err(());
        }
        let manifest_path = root.join(RUNTIME_MANIFEST);
        let manifest_metadata = fs::symlink_metadata(&manifest_path).map_err(|_| ())?;
        if !manifest_metadata.is_file()
            || manifest_metadata.file_type().is_symlink()
            || manifest_metadata.len() == 0
            || manifest_metadata.len() > MAX_MANIFEST_BYTES
        {
            return Err(());
        }
        let mut manifest_file = open_readonly_nofollow(&manifest_path)?;
        let mut manifest_bytes = Vec::with_capacity(manifest_metadata.len() as usize);
        manifest_file
            .read_to_end(&mut manifest_bytes)
            .map_err(|_| ())?;
        if manifest_bytes.len() as u64 != manifest_metadata.len() {
            return Err(());
        }
        let manifest: RuntimeManifest = serde_json::from_slice(&manifest_bytes).map_err(|_| ())?;
        if manifest.format != RUNTIME_MANIFEST_FORMAT
            || manifest.version != 1
            || manifest.node_version != RUNTIME_NODE_VERSION
            || manifest.node_source.url != NODE_SOURCE_URL
            || manifest.node_source.archive_sha256 != NODE_SOURCE_SHA256
            || manifest.entrypoint != RUNTIME_ENTRYPOINT
            || !valid_package_pins(&manifest.packages)
            || manifest.files.is_empty()
            || manifest.files.len() > MAX_RUNTIME_FILES
        {
            return Err(());
        }

        let mut declared = BTreeMap::new();
        let mut previous = None;
        let mut total_bytes = 0u64;
        for entry in &manifest.files {
            if !safe_relative_path(&entry.path)
                || !valid_sha256(&entry.sha256)
                || entry.size == 0
                || entry.size > MAX_RUNTIME_FILE_BYTES
                || previous
                    .as_deref()
                    .is_some_and(|last| last >= entry.path.as_str())
            {
                return Err(());
            }
            previous = Some(entry.path.as_str());
            total_bytes = total_bytes.checked_add(entry.size).ok_or(())?;
            if total_bytes > MAX_RUNTIME_BYTES {
                return Err(());
            }
            let path = root.join(&entry.path);
            let metadata = fs::symlink_metadata(&path).map_err(|_| ())?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() != entry.size
            {
                return Err(());
            }
            if digest_file(&path)? != entry.sha256 {
                return Err(());
            }
            declared.insert(entry.path.clone(), entry.size);
        }

        let mut actual = BTreeSet::new();
        collect_runtime_files(root, root, &mut actual, 0)?;
        if actual != declared.keys().cloned().collect() {
            return Err(());
        }
        let node = root.join("node");
        let entrypoint = root.join(RUNTIME_ENTRYPOINT);
        if !declared.contains_key("node")
            || !declared.contains_key(RUNTIME_ENTRYPOINT)
            || !super::super::is_executable_file(&node)
            || !entrypoint.is_file()
        {
            return Err(());
        }
        Ok(Self {
            root: root.to_path_buf(),
            node,
        })
    }
}

fn valid_package_pins(packages: &[PackagePin]) -> bool {
    if packages.len() != PACKAGE_PINS.len() {
        return false;
    }
    let actual: BTreeMap<_, _> = packages
        .iter()
        .map(|pin| (pin.name.as_str(), pin.version.as_str()))
        .collect();
    let expected: BTreeMap<_, _> = PACKAGE_PINS.into_iter().collect();
    actual == expected
}

fn safe_relative_path(value: &str) -> bool {
    if value.is_empty() || value.contains('\\') || value.starts_with('/') {
        return false;
    }
    let path = Path::new(value);
    path.components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
        && path.to_str().is_some_and(|normalized| normalized == value)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn digest_file(path: &Path) -> Result<String, ()> {
    let mut file = open_readonly_nofollow(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| ())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn open_readonly_nofollow(path: &Path) -> Result<File, ()> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| ())?;
    if !file.metadata().map_err(|_| ())?.is_file() {
        return Err(());
    }
    Ok(file)
}

fn collect_runtime_files(
    root: &Path,
    directory: &Path,
    files: &mut BTreeSet<String>,
    depth: usize,
) -> Result<(), ()> {
    if depth > 24 || files.len() > MAX_RUNTIME_FILES {
        return Err(());
    }
    for item in fs::read_dir(directory).map_err(|_| ())? {
        let item = item.map_err(|_| ())?;
        let path = item.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| ())?;
        if metadata.file_type().is_symlink() {
            return Err(());
        }
        if metadata.is_dir() {
            collect_runtime_files(root, &path, files, depth + 1)?;
        } else if metadata.is_file() {
            if path == root.join(RUNTIME_MANIFEST) {
                continue;
            }
            let relative = path.strip_prefix(root).map_err(|_| ())?;
            let relative = relative
                .to_str()
                .ok_or(())?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if !safe_relative_path(&relative) || !files.insert(relative) {
                return Err(());
            }
        } else {
            return Err(());
        }
    }
    Ok(())
}
