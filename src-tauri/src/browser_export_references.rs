//! Fixed-document parsing for current and retained Canvas file references.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

use serde_json::Value;

use crate::browser_export_io::{
    read_private_document, verify_directory_identity, verify_private_directory,
};
use crate::config::{ImportLimits, ReadLimits, COURSEWORK_FILE};
use crate::import::is_course_folder_name;
use crate::store::StoreError;

use super::{invalid, MAX_BLOB_BYTES, MAX_REFERENCES};

const LEGACY_ARCHIVE_FILE: &str = "browser-legacy-resource-archive.json";

#[derive(Debug, Clone)]
pub(super) struct BlobRef {
    pub(super) byte_count: u64,
    pub(super) content_types: BTreeSet<String>,
}

pub(super) fn collect_references(
    document_root: &Path,
) -> Result<(BTreeMap<String, BlobRef>, u64), StoreError> {
    let root_identity = verify_private_directory(document_root)?;
    let coursework = read_private_document(
        document_root,
        COURSEWORK_FILE,
        &[document_root.to_path_buf()],
        ImportLimits::PRODUCTION.max_json_bytes,
    )?
    .ok_or(StoreError::Invalid("coursework document is missing"))?;
    let coursework: Value = serde_json::from_slice(&coursework)
        .map_err(|_| invalid("coursework document is malformed"))?;
    let courses = coursework
        .get("courses")
        .and_then(Value::as_array)
        .filter(|courses| courses.len() <= ReadLimits::PRODUCTION.max_course_folders)
        .ok_or(invalid("coursework courses are malformed"))?;
    let course_keys = courses
        .iter()
        .filter_map(|course| course.get("key").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let mut folders = HashSet::new();
    let mut reference_ids = HashSet::new();
    let mut references = BTreeMap::<String, BlobRef>::new();
    let mut manifest_bytes = 0_u64;
    let mut reference_count = 0_u64;

    for course in courses {
        let folder_value = match course.get("folder") {
            None | Some(Value::Null) => continue,
            Some(Value::String(folder)) => folder.as_str(),
            Some(_) => return Err(invalid("coursework course folder is malformed")),
        };
        let folder = valid_course_folder(folder_value)
            .ok_or(invalid("coursework course folder is malformed"))?;
        if !folders.insert(folder.clone()) {
            return Err(invalid("coursework course folders are duplicated"));
        }
        let manifest_path = format!("{folder}/canvas-export/download-manifest.json");
        let course_directory = document_root.join(&folder);
        let export_directory = course_directory.join("canvas-export");
        let parent_paths = [
            document_root.to_path_buf(),
            document_root.join("classes"),
            course_directory,
            export_directory,
        ];
        let Some(manifest) = read_private_document(
            document_root,
            &manifest_path,
            &parent_paths,
            ReadLimits::PRODUCTION.max_document_bytes,
        )?
        else {
            continue;
        };
        add_manifest_bytes(&mut manifest_bytes, manifest.len() as u64)?;
        let manifest: Value = serde_json::from_slice(&manifest)
            .map_err(|_| invalid("course download manifest is malformed"))?;
        let entries = manifest
            .as_array()
            .ok_or(invalid("course download manifest is malformed"))?;
        add_reference_count(&mut reference_count, entries.len() as u64)?;
        for entry in entries {
            if entry.get("status").and_then(Value::as_str) != Some("saved") {
                continue;
            }
            let file_id = positive_id(entry.get("fileId"))
                .ok_or(invalid("saved browser file reference is malformed"))?;
            if !reference_ids.insert((folder.to_owned(), file_id)) {
                return Err(invalid("saved browser file references are duplicated"));
            }
            let (hash, byte_count, content_type) = saved_reference(entry)?;
            insert_reference(&mut references, hash, byte_count, content_type)?;
        }
    }
    collect_legacy_references(
        document_root,
        &course_keys,
        &mut references,
        &mut reference_count,
        &mut manifest_bytes,
    )?;
    verify_directory_identity(document_root, root_identity)?;
    Ok((references, reference_count))
}

fn collect_legacy_references(
    document_root: &Path,
    course_keys: &HashSet<&str>,
    references: &mut BTreeMap<String, BlobRef>,
    reference_count: &mut u64,
    manifest_bytes: &mut u64,
) -> Result<(), StoreError> {
    let Some(bytes) = read_private_document(
        document_root,
        LEGACY_ARCHIVE_FILE,
        &[document_root.to_path_buf()],
        ReadLimits::PRODUCTION.max_document_bytes,
    )?
    else {
        return Ok(());
    };
    add_manifest_bytes(manifest_bytes, bytes.len() as u64)?;
    let archive: Value = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("legacy browser archive is malformed"))?;
    if archive.get("format").and_then(Value::as_str) != Some("duegood-browser-legacy-resources")
        || archive.get("version").and_then(Value::as_u64) != Some(1)
    {
        return Err(invalid("legacy browser archive is malformed"));
    }
    let entries = archive
        .get("files")
        .and_then(Value::as_array)
        .ok_or(invalid("legacy browser archive is malformed"))?;
    add_reference_count(reference_count, entries.len() as u64)?;
    let mut ids = HashSet::new();
    for entry in entries {
        let course_key = entry
            .get("courseKey")
            .and_then(Value::as_str)
            .filter(|key| course_keys.contains(key))
            .ok_or(invalid("legacy browser file course is invalid"))?;
        let file_id = positive_id(entry.get("fileId"))
            .ok_or(invalid("legacy browser file reference is malformed"))?;
        if !ids.insert((course_key, file_id)) {
            return Err(invalid("legacy browser file references are duplicated"));
        }
        match entry.get("status").and_then(Value::as_str) {
            Some("gap") => continue,
            Some("saved") => {}
            _ => return Err(invalid("legacy browser file status is malformed")),
        }
        if entry.get("source").and_then(Value::as_str) != Some("legacy")
            || entry.get("sourceAuthenticity").and_then(Value::as_str) != Some("unverified")
            || !entry.get("observedAt").is_some_and(Value::is_null)
        {
            return Err(invalid("legacy browser file provenance is malformed"));
        }
        let (hash, byte_count, content_type) = saved_reference(entry)?;
        insert_reference(references, hash, byte_count, content_type)?;
    }
    Ok(())
}

fn saved_reference(entry: &Value) -> Result<(String, u64, String), StoreError> {
    let byte_count = entry
        .get("byteCount")
        .and_then(Value::as_u64)
        .filter(|count| (1..=MAX_BLOB_BYTES).contains(count))
        .ok_or(invalid("saved browser file size is invalid"))?;
    let hash = entry
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|value| is_hash(value))
        .ok_or(invalid("saved browser file digest is invalid"))?
        .to_owned();
    let content_type = entry
        .get("contentType")
        .and_then(Value::as_str)
        .filter(|value| is_content_type(value))
        .ok_or(invalid("saved browser file type is invalid"))?
        .to_owned();
    Ok((hash, byte_count, content_type))
}

fn insert_reference(
    references: &mut BTreeMap<String, BlobRef>,
    hash: String,
    byte_count: u64,
    content_type: String,
) -> Result<(), StoreError> {
    match references.get_mut(&hash) {
        Some(existing) if existing.byte_count != byte_count => {
            Err(invalid("browser file digest has conflicting sizes"))
        }
        Some(existing) => {
            existing.content_types.insert(content_type);
            Ok(())
        }
        None => {
            references.insert(
                hash,
                BlobRef {
                    byte_count,
                    content_types: BTreeSet::from([content_type]),
                },
            );
            Ok(())
        }
    }
}

fn add_manifest_bytes(total: &mut u64, bytes: u64) -> Result<(), StoreError> {
    *total = total.checked_add(bytes).ok_or(StoreError::TooLarge)?;
    if *total > ReadLimits::PRODUCTION.max_total_bytes {
        return Err(StoreError::TooLarge);
    }
    Ok(())
}

fn add_reference_count(total: &mut u64, count: u64) -> Result<(), StoreError> {
    *total = total.checked_add(count).ok_or(StoreError::TooLarge)?;
    if *total > MAX_REFERENCES {
        return Err(StoreError::TooLarge);
    }
    Ok(())
}

fn valid_course_folder(value: &str) -> Option<String> {
    let leaf = value.strip_prefix("classes/").unwrap_or(value);
    if leaf.contains('/') || !is_course_folder_name(leaf) {
        return None;
    }
    Some(format!("classes/{leaf}"))
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    let id = value.and_then(Value::as_u64).or_else(|| {
        value
            .and_then(Value::as_str)
            .and_then(|text| text.parse().ok())
    })?;
    (id > 0).then_some(id)
}

fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_content_type(value: &str) -> bool {
    value.len() <= 127
        && value
            .split_once('/')
            .is_some_and(|(kind, subtype)| !kind.is_empty() && !subtype.is_empty())
        && value.matches('/').count() == 1
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'+' | b'-'))
}
