use super::*;
use crate::browser_bundle::{ActiveCourseCoverage, CaptureCoverage};
use crate::testutil::TempRoot;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;

fn write_private(path: &Path, bytes: &[u8]) {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).unwrap().write_all(bytes).unwrap();
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fixture(root: &TempRoot, body: &[u8], content_type: &str) -> ValidatedCaptureBundle {
    let blob_directory = root.path().join("capture-blobs");
    crate::store::create_private_dir(&blob_directory, false).unwrap();
    let sha256 = hash(body);
    write_private(&blob_directory.join(format!("{sha256}.blob")), body);
    let blob = json!({
        "fileId": 4401,
        "byteCount": body.len(),
        "sha256": sha256,
        "contentType": content_type,
        "sourceAuthenticity": "unverified"
    });
    let mut snapshot_blob = blob.clone();
    snapshot_blob["status"] = json!("archived");
    ValidatedCaptureBundle {
        run_id: 19,
        generation_id: "7bc74ef29b714260a164a74b87269bd1".to_owned(),
        user_id: 41,
        captured_at: "2026-09-27T20:00:00Z".to_owned(),
        snapshot: json!({
            "resources": [{ "endpoint": "fileBodies", "items": [snapshot_blob] }]
        }),
        manifest: json!({ "blobs": [blob] }),
        active_courses: Vec::<ActiveCourseCoverage>::new(),
        coverage: Vec::<CaptureCoverage>::new(),
        blob_directory,
    }
}

fn bundle_with_two_ids(root: &TempRoot, body: &[u8]) -> ValidatedCaptureBundle {
    let mut bundle = fixture(root, body, "application/pdf");
    let mut second_manifest_blob = bundle.manifest["blobs"][0].clone();
    second_manifest_blob["fileId"] = json!(4402);
    let mut second_snapshot_blob = bundle.snapshot["resources"][0]["items"][0].clone();
    second_snapshot_blob["fileId"] = json!(4402);
    bundle.manifest["blobs"]
        .as_array_mut()
        .unwrap()
        .push(second_manifest_blob);
    bundle.snapshot["resources"][0]["items"]
        .as_array_mut()
        .unwrap()
        .push(second_snapshot_blob);
    bundle
}

fn archive_root(root: &TempRoot) -> PathBuf {
    root.path().join(ARCHIVE_NAME).join(BLOBS_NAME)
}

#[test]
fn promotes_streamed_blob_and_reuses_it_idempotently() {
    let root = TempRoot::new("browser-resource-promote");
    let body = [b"%PDF-1.7\n".as_slice(), &vec![b'x'; 2 * CHUNK_BYTES + 17]].concat();
    let bundle = fixture(&root, &body, "application/pdf");
    let mut progress = Vec::new();
    let first = promote_capture_blobs(root.path(), &bundle, |done, total| {
        progress.push((done, total));
    })
    .unwrap();
    assert_eq!(first.promoted_blobs, 1);
    assert_eq!(first.reused_blobs, 0);
    assert_eq!(first.bytes_verified, body.len() as u64);
    assert!(progress.len() >= 3);
    assert_eq!(
        progress.last(),
        Some(&(body.len() as u64, body.len() as u64))
    );

    let second = promote_capture_blobs(root.path(), &bundle, |_, _| {}).unwrap();
    assert_eq!(second.promoted_blobs, 0);
    assert_eq!(second.reused_blobs, 1);
    assert_eq!(second.bytes_verified, body.len() as u64);
    let path = verified_blob(
        root.path(),
        &hash(&body),
        body.len() as u64,
        "application/pdf",
    )
    .unwrap();
    assert_eq!(fs::read(path).unwrap(), body);
    assert_eq!(fs::read_dir(archive_root(&root)).unwrap().count(), 1);
}

#[test]
fn repeated_file_bytes_promote_once_for_distinct_file_ids() {
    let root = TempRoot::new("browser-resource-dedup");
    let body = b"%PDF-1.7\nsynthetic";
    let bundle = bundle_with_two_ids(&root, body);
    let result = promote_capture_blobs(root.path(), &bundle, |_, _| {}).unwrap();
    assert_eq!(result.promoted_blobs, 1);
    assert_eq!(result.bytes_verified, body.len() as u64);
    assert_eq!(fs::read_dir(archive_root(&root)).unwrap().count(), 1);
}

#[test]
fn hash_mismatch_and_media_mismatch_remove_pending_file() {
    let root = TempRoot::new("browser-resource-invalid");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    let actual_hash = hash(body);
    let replacement = if actual_hash.ends_with('0') { '1' } else { '0' };
    let wrong_hash = format!("{}{replacement}", &actual_hash[..63]);
    bundle.manifest["blobs"][0]["sha256"] = json!(wrong_hash);
    bundle.snapshot["resources"][0]["items"][0]["sha256"] = json!(wrong_hash);
    fs::rename(
        bundle.blob_directory.join(format!("{actual_hash}.blob")),
        bundle.blob_directory.join(format!("{wrong_hash}.blob")),
    )
    .unwrap();
    assert_eq!(
        promote_capture_blobs(root.path(), &bundle, |_, _| {}).err(),
        Some(ResourceArchiveError::BlobMismatch)
    );
    assert_eq!(fs::read_dir(archive_root(&root)).unwrap().count(), 0);

    let second_root = TempRoot::new("browser-resource-media");
    let bad_body = b"not a PDF";
    let bad_bundle = fixture(&second_root, bad_body, "application/pdf");
    assert_eq!(
        promote_capture_blobs(second_root.path(), &bad_bundle, |_, _| {}).err(),
        Some(ResourceArchiveError::UnsupportedMedia)
    );
    assert_eq!(fs::read_dir(archive_root(&second_root)).unwrap().count(), 0);
}

#[test]
fn refuses_missing_and_symlink_sources_without_leaving_stages() {
    let root = TempRoot::new("browser-resource-source");
    let body = b"%PDF-1.7\nsynthetic";
    let bundle = fixture(&root, body, "application/pdf");
    fs::remove_file(bundle.blob_directory.join(format!("{}.blob", hash(body)))).unwrap();
    assert_eq!(
        promote_capture_blobs(root.path(), &bundle, |_, _| {}).err(),
        Some(ResourceArchiveError::MissingSource)
    );
    assert_eq!(fs::read_dir(archive_root(&root)).unwrap().count(), 0);

    let target = bundle.blob_directory.join("target");
    write_private(&target, body);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            &target,
            bundle.blob_directory.join(format!("{}.blob", hash(body))),
        )
        .unwrap();
        assert_eq!(
            promote_capture_blobs(root.path(), &bundle, |_, _| {}).err(),
            Some(ResourceArchiveError::UnsafeFile)
        );
        assert_eq!(fs::read_dir(archive_root(&root)).unwrap().count(), 0);
    }
}

#[test]
fn archive_cap_is_checked_before_any_blob_write() {
    let root = TempRoot::new("browser-resource-cap");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    let limits = Limits {
        per_blob: 1024,
        per_capture: 1024,
        archive: body.len() as u64 - 1,
    };
    assert_eq!(
        promote_with_limits(root.path(), &bundle, &mut |_, _| {}, limits).err(),
        Some(ResourceArchiveError::ArchiveLimitExceeded)
    );
    assert_eq!(fs::read_dir(archive_root(&root)).unwrap().count(), 0);
}

#[test]
fn resolver_rehashes_saved_bytes_and_rejects_tampering() {
    let root = TempRoot::new("browser-resource-resolver");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    promote_capture_blobs(root.path(), &bundle, |_, _| {}).unwrap();
    let path = archive_root(&root).join(hash(body));
    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
        .unwrap()
        .write_all(b"%PDF-1.7\nmodified")
        .unwrap();
    assert_eq!(
        verified_blob(
            root.path(),
            &hash(body),
            body.len() as u64,
            "application/pdf"
        )
        .err(),
        Some(ResourceArchiveError::BlobMismatch)
    );
}

#[test]
fn rejects_inconsistent_manifest_and_snapshot_references() {
    let root = TempRoot::new("browser-resource-crosscheck");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    bundle.snapshot["resources"][0]["items"][0]["byteCount"] = json!(body.len() + 1);
    assert_eq!(
        promote_capture_blobs(root.path(), &bundle, |_, _| {}).err(),
        Some(ResourceArchiveError::InvalidBundle)
    );
}

#[test]
fn rejects_untrusted_native_archive_entries() {
    let root = TempRoot::new("browser-resource-archive-symlink");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    let archive = ensure_private_child(root.path(), ARCHIVE_NAME).unwrap();
    let directory = ensure_private_child(&archive, BLOBS_NAME).unwrap();
    #[cfg(unix)]
    {
        let outside = root.path().join("outside");
        write_private(&outside, body);
        std::os::unix::fs::symlink(&outside, directory.join(hash(body))).unwrap();
        assert_eq!(
            promote_capture_blobs(root.path(), &bundle, |_, _| {}).err(),
            Some(ResourceArchiveError::UnsafeFile)
        );
    }
}

#[test]
fn no_blob_references_reports_zero_without_reading_unrelated_data() {
    let root = TempRoot::new("browser-resource-empty");
    let blob_directory = root.path().join("capture-blobs");
    crate::store::create_private_dir(&blob_directory, false).unwrap();
    let bundle = ValidatedCaptureBundle {
        run_id: 19,
        generation_id: "7bc74ef29b714260a164a74b87269bd1".to_owned(),
        user_id: 41,
        captured_at: "2026-09-27T20:00:00Z".to_owned(),
        snapshot: json!({ "resources": [] }),
        manifest: json!({ "blobs": [] }),
        active_courses: Vec::<ActiveCourseCoverage>::new(),
        coverage: Vec::<CaptureCoverage>::new(),
        blob_directory,
    };
    assert_eq!(
        promote_capture_blobs(root.path(), &bundle, |_, _| {}).unwrap(),
        PromotionResult {
            promoted_blobs: 0,
            reused_blobs: 0,
            bytes_verified: 0,
        }
    );
}

#[test]
fn archive_inventory_rejects_non_hash_names() {
    let root = TempRoot::new("browser-resource-name");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    let archive = ensure_private_child(root.path(), ARCHIVE_NAME).unwrap();
    let directory = ensure_private_child(&archive, BLOBS_NAME).unwrap();
    write_private(&directory.join("unexpected"), b"private");
    assert_eq!(
        promote_capture_blobs(root.path(), &bundle, |_, _| {}).err(),
        Some(ResourceArchiveError::UnsafeFile)
    );
}

#[test]
fn validates_full_blob_inventory_before_removing_pending_files() {
    let oversized_root = TempRoot::new("browser-resource-pending-limit");
    let oversized_archive = ensure_private_child(oversized_root.path(), ARCHIVE_NAME).unwrap();
    let oversized_directory = ensure_private_child(&oversized_archive, BLOBS_NAME).unwrap();
    for index in 0..129 {
        write_private(
            &oversized_directory.join(format!(".pending-{index:032x}.tmp")),
            b"interrupted copy",
        );
    }
    assert_eq!(
        crate::browser_resources_io::inventory_blobs(&oversized_directory, 1024).err(),
        Some(ResourceArchiveError::UnsafeFile)
    );
    assert_eq!(fs::read_dir(&oversized_directory).unwrap().count(), 129);

    let invalid_root = TempRoot::new("browser-resource-pending-invalid-inventory");
    let invalid_archive = ensure_private_child(invalid_root.path(), ARCHIVE_NAME).unwrap();
    let invalid_directory = ensure_private_child(&invalid_archive, BLOBS_NAME).unwrap();
    let pending_path = invalid_directory.join(".pending-0123456789abcdef0123456789abcdef.tmp");
    let invalid_path = invalid_directory.join("unexpected");
    write_private(&pending_path, b"interrupted copy");
    write_private(&invalid_path, b"invalid inventory entry");
    let pending_entry = (
        pending_path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned(),
        pending_path.clone(),
    );
    let invalid_entry = ("unexpected".to_owned(), invalid_path);
    for candidates in [
        vec![pending_entry.clone(), invalid_entry.clone()],
        vec![invalid_entry.clone(), pending_entry.clone()],
    ] {
        assert_eq!(
            crate::browser_resources_io::inventory_blob_entries(
                &invalid_directory,
                candidates.into_iter().map(Ok),
                1024,
            )
            .err(),
            Some(ResourceArchiveError::UnsafeFile)
        );
        assert!(pending_path.exists());
    }

    let root = TempRoot::new("browser-resource-pending-recovery");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    let archive = ensure_private_child(root.path(), ARCHIVE_NAME).unwrap();
    let directory = ensure_private_child(&archive, BLOBS_NAME).unwrap();
    write_private(
        &directory.join(".pending-0123456789abcdef0123456789abcdef.tmp"),
        b"interrupted copy",
    );
    let result = promote_capture_blobs(root.path(), &bundle, |_, _| {}).unwrap();
    assert_eq!(result.promoted_blobs, 1);
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
}

#[test]
fn source_receipt_content_type_must_match_snapshot() {
    let root = TempRoot::new("browser-resource-mime-crosscheck");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    bundle.snapshot["resources"][0]["items"][0]["contentType"] = json!("application/zip");
    assert_eq!(
        promote_capture_blobs(root.path(), &bundle, |_, _| {}).err(),
        Some(ResourceArchiveError::InvalidBundle)
    );
}

#[test]
fn manifest_source_authenticity_must_remain_unverified() {
    let root = TempRoot::new("browser-resource-authenticity");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    bundle.manifest["blobs"][0]["sourceAuthenticity"] = json!("verified");
    assert_eq!(
        promote_capture_blobs(root.path(), &bundle, |_, _| {}).err(),
        Some(ResourceArchiveError::InvalidReceipt)
    );
}

#[test]
fn rejects_over_limit_capture_before_creating_a_pending_file() {
    let root = TempRoot::new("browser-resource-capture-limit");
    let body = b"%PDF-1.7\nsynthetic";
    let bundle = bundle_with_two_ids(&root, body);
    let limits = Limits {
        per_blob: 1024,
        per_capture: body.len() as u64,
        archive: 1024,
    };
    assert_eq!(
        promote_with_limits(root.path(), &bundle, &mut |_, _| {}, limits).err(),
        Some(ResourceArchiveError::CaptureTooLarge)
    );
    assert!(!archive_root(&root).exists());
}

#[test]
fn duplicate_hash_with_different_media_types_validates_each_declaration() {
    let root = TempRoot::new("browser-resource-duplicate-mime");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = bundle_with_two_ids(&root, body);
    bundle.manifest["blobs"][1]["contentType"] = json!("application/zip");
    bundle.snapshot["resources"][0]["items"][1]["contentType"] = json!("application/zip");
    assert_eq!(
        promote_capture_blobs(root.path(), &bundle, |_, _| {}).err(),
        Some(ResourceArchiveError::UnsupportedMedia)
    );
    assert_eq!(fs::read_dir(archive_root(&root)).unwrap().count(), 0);
}

#[test]
fn validates_canonical_only_file_name_not_user_facing_names() {
    let root = TempRoot::new("browser-resource-path");
    let body = b"%PDF-1.7\nsynthetic";
    let mut bundle = fixture(&root, body, "application/pdf");
    promote_capture_blobs(root.path(), &bundle, |_, _| {}).unwrap();
    let stored = fs::read_dir(archive_root(&root))
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(stored.file_name().to_str(), Some(hash(body).as_str()));
    assert!(!stored.file_name().to_string_lossy().contains("4401"));
}
