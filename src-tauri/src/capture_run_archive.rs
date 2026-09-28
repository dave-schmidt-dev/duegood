//! Validation of the fixed v2 archive receipt before capture status is committed.

use std::collections::{HashMap, HashSet};
use std::fs::{self, Metadata, OpenOptions};
use std::io;
use std::path::Path;

use serde_json::Value;
use sha2::Digest;

use super::{
    invalid_data, read_file_bounded, read_json_file, valid_generation_id, valid_hash,
    MAX_SNAPSHOT_BYTES,
};

const CANVAS_ORIGIN: &str = "https://marymount.instructure.com";
const MAX_AVAILABILITY_SNAPSHOT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RESOURCES: usize = 10_000;
const MAX_ITEMS: usize = 100_000;
const MAX_BLOBS: usize = 10_000;
const MAX_BLOB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GENERATION_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Content-free counts from one fully linked archive generation. `user_id` is native-only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PublishedGenerationSummary {
    pub generation_id: String,
    pub user_id: u64,
    pub captured_at: String,
    pub active_course_count: usize,
    pub resource_count: usize,
    pub item_count: usize,
    pub blob_count: usize,
    pub blob_bytes: u64,
}

pub(super) fn validate_published_generation(
    archive_root: &Path,
    run_id: u64,
    generation_id: &str,
    snapshot_sha256: &str,
    user_id: u64,
) -> io::Result<()> {
    validate_generation(
        archive_root,
        run_id,
        generation_id,
        snapshot_sha256,
        user_id,
        MAX_SNAPSHOT_BYTES,
    )
    .map(|_| ())
}

/// Validates the current pointer, hashed snapshot, coverage and file-link metadata without reading
/// blob bodies. The smaller dashboard cap keeps each availability read bounded.
pub(super) fn summarize_published_generation(
    archive_root: &Path,
    run_id: u64,
    generation_id: &str,
    snapshot_sha256: &str,
    user_id: u64,
) -> io::Result<PublishedGenerationSummary> {
    validate_generation(
        archive_root,
        run_id,
        generation_id,
        snapshot_sha256,
        user_id,
        MAX_AVAILABILITY_SNAPSHOT_BYTES,
    )
}

fn validate_generation(
    archive_root: &Path,
    run_id: u64,
    generation_id: &str,
    snapshot_sha256: &str,
    user_id: u64,
    snapshot_limit: u64,
) -> io::Result<PublishedGenerationSummary> {
    if run_id == 0
        || user_id == 0
        || !valid_generation_id(generation_id)
        || !valid_hash(snapshot_sha256)
    {
        return Err(invalid_data("terminal archive identity is invalid"));
    }
    checked_directory(archive_root)?;
    let pointer: Value = read_json_file(&archive_root.join("current.json"), 4096)?;
    if pointer["format"] != "duegood-canvas-capture-current"
        || pointer["version"] != 2
        || pointer["runId"] != run_id
        || pointer["generationId"] != generation_id
        || pointer["snapshotSha256"] != snapshot_sha256
    {
        return Err(invalid_data(
            "current archive pointer does not match terminal receipt",
        ));
    }
    let generations = archive_root.join("generations");
    checked_directory(&generations)?;
    let generation = generations.join(generation_id);
    checked_directory(&generation)?;
    let manifest_path = generation.join("manifest.json");
    let manifest: Value = read_json_file(&manifest_path, 32 * 1024 * 1024)?;
    if manifest["format"] != "duegood-canvas-capture-generation"
        || manifest["version"] != 2
        || manifest["runId"] != run_id
        || manifest["generationId"] != generation_id
        || manifest["snapshotSha256"] != snapshot_sha256
        || manifest["identity"]["origin"] != CANVAS_ORIGIN
        || manifest["identity"]["userId"] != user_id
        || manifest["complete"] != false
    {
        return Err(invalid_data(
            "archive manifest does not match terminal receipt",
        ));
    }
    check_generation_entries(&generation)?;
    let snapshot_path = generation.join("snapshot.json");
    let snapshot_bytes = read_file_bounded(&snapshot_path, snapshot_limit)?;
    let digest = format!("{:x}", sha2::Sha256::digest(&snapshot_bytes));
    if digest != snapshot_sha256 || manifest["snapshotBytes"] != snapshot_bytes.len() as u64 {
        return Err(invalid_data("snapshot bytes do not match archive manifest"));
    }
    let snapshot: Value = serde_json::from_slice(&snapshot_bytes)
        .map_err(|_| invalid_data("archived snapshot is invalid"))?;
    if snapshot["schemaVersion"] != 2
        || snapshot["source"] != "canvas-browser"
        || snapshot["runId"] != run_id
        || snapshot["generationId"] != generation_id
        || snapshot["identity"]["origin"] != CANVAS_ORIGIN
        || snapshot["identity"]["userId"] != user_id
        || snapshot["complete"] != false
    {
        return Err(invalid_data(
            "archived snapshot does not match terminal receipt",
        ));
    }
    let captured_at = snapshot["capturedAt"]
        .as_str()
        .filter(|stamp| stamp.len() <= 80 && chrono::DateTime::parse_from_rfc3339(stamp).is_ok())
        .ok_or_else(|| invalid_data("snapshot observation time is invalid"))?;
    if manifest["capturedAt"].as_str() != Some(captured_at)
        || manifest["resourceCount"].as_u64().is_none()
        || manifest["itemCount"].as_u64().is_none()
    {
        return Err(invalid_data("archive summary counts do not match snapshot"));
    }
    let active_course_count = validate_snapshot_coverage(&snapshot)?;
    let (resource_count, item_count) = snapshot_counts(&snapshot)?;
    if manifest["resourceCount"] != resource_count as u64
        || manifest["itemCount"] != item_count as u64
    {
        return Err(invalid_data("archive summary counts do not match snapshot"));
    }
    let (blob_count, blob_bytes) = validate_blob_links(archive_root, &manifest, &snapshot)?;
    Ok(PublishedGenerationSummary {
        generation_id: generation_id.to_owned(),
        user_id,
        captured_at: captured_at.to_owned(),
        active_course_count,
        resource_count,
        item_count,
        blob_count,
        blob_bytes,
    })
}

fn validate_snapshot_coverage(snapshot: &Value) -> io::Result<usize> {
    let active = snapshot["activeCourses"]["courseIds"]
        .as_array()
        .ok_or_else(|| invalid_data("active course inventory is missing"))?;
    if active.len() > 250
        || snapshot["activeCourses"]["complete"] != true
        || snapshot["coverageRequirements"]["activeCoursesComplete"] != true
    {
        return Err(invalid_data("active course inventory is incomplete"));
    }
    let required = ["course", "assignments", "assignmentGroups", "submissions"];
    let declared = snapshot["coverageRequirements"]["perActiveCourse"]
        .as_array()
        .ok_or_else(|| invalid_data("required course coverage is missing"))?;
    if declared.len() != required.len()
        || declared
            .iter()
            .zip(required)
            .any(|(entry, expected)| entry.as_str() != Some(expected))
    {
        return Err(invalid_data("required course coverage policy is invalid"));
    }
    let mut ids = std::collections::BTreeSet::new();
    for value in active {
        let id = value
            .as_u64()
            .filter(|id| *id > 0)
            .ok_or_else(|| invalid_data("active course ID is invalid"))?;
        if !ids.insert(id) {
            return Err(invalid_data("active course ID is duplicated"));
        }
    }
    let active_resource = snapshot["resources"]
        .as_array()
        .and_then(|resources| {
            resources.iter().find(|resource| {
                resource["endpoint"] == "coursesActive" && resource["courseId"].is_null()
            })
        })
        .ok_or_else(|| invalid_data("active course resource is missing"))?;
    let resource_ids = active_resource["items"]
        .as_array()
        .ok_or_else(|| invalid_data("active course resource is invalid"))?
        .iter()
        .map(|item| {
            item["id"]
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or_else(|| invalid_data("active course resource ID is invalid"))
        })
        .collect::<io::Result<std::collections::BTreeSet<_>>>()?;
    if resource_ids != ids {
        return Err(invalid_data(
            "active course inventory does not match its resource",
        ));
    }
    let coverage = snapshot["coverage"]
        .as_array()
        .ok_or_else(|| invalid_data("endpoint coverage is missing"))?;
    let mut complete = std::collections::BTreeSet::new();
    for entry in coverage {
        if entry["status"] == "complete" {
            let endpoint = entry["endpoint"]
                .as_str()
                .ok_or_else(|| invalid_data("coverage endpoint is invalid"))?;
            let course = entry["courseId"].as_u64();
            complete.insert((endpoint.to_string(), course));
        }
    }
    if !complete.contains(&("coursesActive".to_string(), None))
        || ids.iter().any(|course_id| {
            required
                .iter()
                .any(|endpoint| !complete.contains(&(endpoint.to_string(), Some(*course_id))))
        })
    {
        return Err(invalid_data(
            "required active course endpoint coverage is incomplete",
        ));
    }
    Ok(ids.len())
}

fn snapshot_counts(snapshot: &Value) -> io::Result<(usize, usize)> {
    let resources = snapshot["resources"]
        .as_array()
        .filter(|rows| rows.len() <= MAX_RESOURCES)
        .ok_or_else(|| invalid_data("snapshot resources exceed limits"))?;
    let mut item_count = 0usize;
    for resource in resources {
        let items = resource["items"]
            .as_array()
            .ok_or_else(|| invalid_data("snapshot resource items are invalid"))?;
        item_count = item_count
            .checked_add(items.len())
            .filter(|count| *count <= MAX_ITEMS)
            .ok_or_else(|| invalid_data("snapshot items exceed limits"))?;
    }
    Ok((resources.len(), item_count))
}

fn validate_blob_links(
    archive_root: &Path,
    manifest: &Value,
    snapshot: &Value,
) -> io::Result<(usize, u64)> {
    let receipts = manifest["blobs"]
        .as_array()
        .filter(|rows| rows.len() <= MAX_BLOBS)
        .ok_or_else(|| invalid_data("archive blob receipts are invalid"))?;
    if manifest["blobCount"].as_u64() != Some(receipts.len() as u64) {
        return Err(invalid_data("archive blob count is inconsistent"));
    }
    let mut by_file = HashMap::new();
    let mut hashes = HashMap::new();
    let mut total_bytes = 0u64;
    for receipt in receipts {
        let file_id = receipt["fileId"]
            .as_u64()
            .filter(|id| *id > 0)
            .ok_or_else(|| invalid_data("archive file ID is invalid"))?;
        let byte_count = receipt["byteCount"]
            .as_u64()
            .filter(|bytes| *bytes > 0 && *bytes <= MAX_BLOB_BYTES)
            .ok_or_else(|| invalid_data("archive blob size is invalid"))?;
        let digest = receipt["sha256"]
            .as_str()
            .filter(|hash| valid_hash(hash))
            .ok_or_else(|| invalid_data("archive blob hash is invalid"))?;
        let content_type = receipt["contentType"]
            .as_str()
            .filter(|value| valid_content_type(value))
            .ok_or_else(|| invalid_data("archive blob content type is invalid"))?;
        if receipt["sourceAuthenticity"] != "unverified"
            || by_file
                .insert(file_id, (byte_count, digest, content_type))
                .is_some()
            || hashes
                .insert(digest, byte_count)
                .is_some_and(|prior| prior != byte_count)
        {
            return Err(invalid_data("archive blob receipt is inconsistent"));
        }
        total_bytes = total_bytes
            .checked_add(byte_count)
            .filter(|bytes| *bytes <= MAX_GENERATION_BYTES)
            .ok_or_else(|| invalid_data("archive blob bytes exceed limits"))?;
    }
    if manifest["blobBytes"].as_u64() != Some(total_bytes) {
        return Err(invalid_data("archive blob byte count is inconsistent"));
    }

    let mut archived = HashSet::new();
    for resource in snapshot["resources"]
        .as_array()
        .ok_or_else(|| invalid_data("snapshot resources are invalid"))?
        .iter()
        .filter(|resource| resource["endpoint"] == "fileBodies")
    {
        for item in resource["items"]
            .as_array()
            .ok_or_else(|| invalid_data("file body links are invalid"))?
        {
            match item["status"].as_str() {
                Some("archived") => {
                    let file_id = item["fileId"]
                        .as_u64()
                        .filter(|id| *id > 0)
                        .ok_or_else(|| invalid_data("archived file ID is invalid"))?;
                    if item.get("stagedFile").is_some() || !archived.insert(file_id) {
                        return Err(invalid_data("archived file link is inconsistent"));
                    }
                    let expected = by_file
                        .get(&file_id)
                        .ok_or_else(|| invalid_data("archived file receipt is missing"))?;
                    if item["byteCount"].as_u64() != Some(expected.0)
                        || item["sha256"].as_str() != Some(expected.1)
                        || item["contentType"].as_str() != Some(expected.2)
                        || item["sourceAuthenticity"] != "unverified"
                    {
                        return Err(invalid_data(
                            "archived file metadata does not match receipt",
                        ));
                    }
                }
                Some("staged") => return Err(invalid_data("staged file remains in snapshot")),
                _ => {}
            }
        }
    }
    if archived.len() != by_file.len() {
        return Err(invalid_data("archive blob links are incomplete"));
    }
    let blob_directory = archive_root.join("blobs");
    if !by_file.is_empty() {
        checked_directory(&blob_directory)?;
        for (byte_count, digest) in hashes.iter().map(|(digest, bytes)| (*bytes, *digest)) {
            check_private_blob(&blob_directory.join(format!("{digest}.blob")), byte_count)?;
        }
    }
    Ok((receipts.len(), total_bytes))
}

fn valid_content_type(value: &str) -> bool {
    let Some((major, minor)) = value.split_once('/') else {
        return false;
    };
    [major, minor].iter().all(|part| {
        !part.is_empty()
            && part.len() <= 64
            && part.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-.+".contains(&byte)
            })
    })
}

fn checked_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || fs::canonicalize(path)? != path {
        return Err(invalid_data("archive directory is unsafe"));
    }
    Ok(())
}

fn check_generation_entries(path: &Path) -> io::Result<()> {
    let names = fs::read_dir(path)?
        .map(|entry| entry.map(|value| value.file_name().to_string_lossy().into_owned()))
        .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
    if names != std::collections::BTreeSet::from(["manifest.json".into(), "snapshot.json".into()]) {
        return Err(invalid_data("archive generation has unexpected entries"));
    }
    Ok(())
}

fn check_private_blob(path: &Path, expected_size: u64) -> io::Result<()> {
    let before = fs::symlink_metadata(path)?;
    if !private_file(&before) || before.len() != expected_size {
        return Err(invalid_data("archive blob metadata is unsafe"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    if !private_file(&opened) || !same_file(&before, &opened) {
        return Err(invalid_data("archive blob changed while opening"));
    }
    Ok(())
}

fn private_file(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o7777 == 0o600
            && metadata.nlink() == 1
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino() && left.len() == right.len()
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right);
        false
    }
}

#[cfg(test)]
#[path = "capture_run_archive_tests.rs"]
mod tests;
