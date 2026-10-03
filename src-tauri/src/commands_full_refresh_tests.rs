use super::*;
use crate::config::TEST_BUNDLE_IDENTIFIER;
use crate::testutil::TempRoot;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;

struct EmptyPicker;

impl super::super::FolderPicker for EmptyPicker {
    fn pick_folder(&self) -> Option<PathBuf> {
        None
    }
}

fn runtime_fixture(node_body: &str) -> (TempRoot, BrowserRuntime) {
    let temp = TempRoot::new("browser-runtime");
    let root = temp.path().join("browser-runtime");
    fs::create_dir_all(root.join("scripts")).unwrap();
    let node = root.join("node");
    fs::write(&node, format!("#!/bin/sh\n{node_body}\n")).unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
    let entry = root.join(RUNTIME_ENTRYPOINT);
    fs::write(&entry, b"// fixed entrypoint\n").unwrap();
    let files = ["node", RUNTIME_ENTRYPOINT]
        .into_iter()
        .map(|path| {
            let full = root.join(path);
            serde_json::json!({
                "path": path,
                "sha256": digest_file(&full).unwrap(),
                "size": fs::metadata(full).unwrap().len(),
            })
        })
        .collect::<Vec<_>>();
    let packages = PACKAGE_PINS
        .iter()
        .map(|(name, version)| serde_json::json!({"name": name, "version": version}))
        .collect::<Vec<_>>();
    fs::write(
        root.join(RUNTIME_MANIFEST),
        serde_json::to_vec(&serde_json::json!({
            "format": RUNTIME_MANIFEST_FORMAT,
            "version": 1,
            "nodeVersion": RUNTIME_NODE_VERSION,
            "nodeSource": {
                "url": "https://nodejs.org/dist/v26.10.0/node-v26.10.0-darwin-arm64.tar.gz",
                "archiveSha256": "751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9",
            },
            "entrypoint": RUNTIME_ENTRYPOINT,
            "packages": packages,
            "files": files,
        }))
        .unwrap(),
    )
    .unwrap();
    let runtime = BrowserRuntime::verify(&root).unwrap();
    (temp, runtime)
}

fn app_with_store(label: &str) -> (TempRoot, AppState) {
    let temp = TempRoot::new(label);
    let app = AppState::open(
        Ok(temp.path().join(TEST_BUNDLE_IDENTIFIER)),
        Some(temp.path()),
        Box::new(EmptyPicker),
        Settings::PRODUCTION,
    );
    (temp, app)
}

#[test]
fn browser_runtime_requires_exact_manifest_tree_hashes_and_package_pins() {
    let (temp, _) = runtime_fixture("printf '{}\\n'\nexit 0");
    let root = temp.path().join("browser-runtime");
    fs::write(root.join("unlisted.txt"), b"extra").unwrap();
    assert!(BrowserRuntime::verify(&root).is_err());
    fs::remove_file(root.join("unlisted.txt")).unwrap();

    fs::write(root.join(RUNTIME_ENTRYPOINT), b"modified\n").unwrap();
    assert!(BrowserRuntime::verify(&root).is_err());
}

#[test]
fn browser_client_uses_fixed_entrypoint_and_sanitizes_content_free_frames() {
    let result_frame = serde_json::json!({
        "type": "result", "status": "complete", "resourceCount": 3, "itemCount": 8,
        "gapCount": 0, "omissionCount": 2, "importedCourses": 3, "archivedCourses": 0, "promotedBlobs": 2,
        "reusedBlobs": 4, "bytesVerified": 1234, "alreadyCurrent": false,
    });
    let result_line = serde_json::to_string(&result_frame).unwrap();
    let node_body = format!(
        "[ \"$#\" = 1 ] && [ \"$1\" = \"{RUNTIME_ENTRYPOINT}\" ] || exit 41\n[ -z \"${{DUEGOOD_UNTRUSTED_ENV+x}}\" ] || exit 42\nprintf '%s\\n' '{{\"type\":\"progress\",\"phase\":\"capturing\"}}'\nprintf '%s\\n' '{{\"type\":\"progress\",\"phase\":\"importing\"}}'\nprintf '%s\\n' '{result_line}'\n"
    );
    let (runtime_root, runtime) = runtime_fixture(&node_body);
    let (_app_root, app) = app_with_store("full-refresh-protocol");
    app.shared.refresh_cancelled.store(false, Ordering::SeqCst);
    let phases = Mutex::new(Vec::new());
    let outcome = run_browser_client(&app.shared, &runtime, &mut |event| {
        phases.lock().unwrap().push(event.phase);
        true
    })
    .expect("well-formed helper result");
    assert_eq!(outcome, BrowserOutcome::Complete { gaps: 0, omissions: 2 });
    assert_eq!(
        *phases.lock().unwrap(),
        vec!["browser-capture", "browser-import"]
    );
    assert!(runtime_root.path().join("browser-runtime").is_dir());
}

#[test]
fn browser_timeout_terminates_and_reaps_the_child() {
    let (_temp, runtime) = runtime_fixture("exec /bin/sleep 10");
    let (_app_root, app) = app_with_store("full-refresh-timeout");
    app.shared.refresh_cancelled.store(false, Ordering::SeqCst);
    let started = Instant::now();
    let error = run_browser_client_with_timeout(
        &app.shared,
        &runtime,
        &mut |_| true,
        Duration::from_millis(100),
    )
    .expect_err("stalled helper times out");
    assert!(matches!(error, BrowserRunError::Failed("browser-timeout")));
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(lock(&app.shared.refresh_child).is_none());
}

#[test]
fn malformed_or_oversized_helper_output_fails_closed() {
    let (_temp, runtime) =
        runtime_fixture("printf '%s\\n' '{\"type\":\"unexpected\",\"secret\":\"private\"}'");
    let (_app_root, app) = app_with_store("full-refresh-malformed");
    app.shared.refresh_cancelled.store(false, Ordering::SeqCst);
    let error = run_browser_client(&app.shared, &runtime, &mut |_| true)
        .expect_err("unknown frame type rejected");
    assert!(matches!(
        error,
        BrowserRunError::Failed("browser-output-invalid")
    ));

    let body = "i=0; while [ $i -lt 9000 ]; do printf x; i=$((i+1)); done; printf '\\n'";
    let (temp, _) = runtime_fixture(body);
    let runtime = BrowserRuntime::verify(&temp.path().join("browser-runtime")).unwrap();
    app.shared.refresh_cancelled.store(false, Ordering::SeqCst);
    let error = run_browser_client(&app.shared, &runtime, &mut |_| true)
        .expect_err("oversized line rejected");
    assert!(matches!(
        error,
        BrowserRunError::Failed("browser-output-invalid")
    ));
}

#[test]
fn incomplete_capture_gaps_are_distinct_from_browser_import_failure() {
    let frame = serde_json::json!({
        "type": "result", "status": "incomplete", "resourceCount": 3, "itemCount": 8,
        "gapCount": 2, "omissionCount": 3, "importedCourses": 3, "archivedCourses": 0, "promotedBlobs": 2,
        "reusedBlobs": 4, "bytesVerified": 1234, "alreadyCurrent": false,
        "errorCode": "CAPTURE_GAPS",
    });
    let body = format!(
        "printf '%s\\n' '{}'\nexit 1",
        serde_json::to_string(&frame).unwrap()
    );
    let (_temp, runtime) = runtime_fixture(&body);
    let (_app_root, app) = app_with_store("full-refresh-gaps");
    let outcome = run_browser_client(&app.shared, &runtime, &mut |_| true)
        .expect("partial capture is a valid result");
    assert_eq!(outcome, BrowserOutcome::Incomplete { gaps: 2, omissions: 3 });

    let failed = combine_outcomes(
        BrowserOutcome::Failed {
            code: "browser-failed",
        },
        CalendarOutcome::Unavailable,
    );
    assert_eq!(failed.browser_status, "failed");
    assert_eq!(failed.error_code, Some("browser-failed"));
}

#[test]
fn browser_partial_or_failed_outcomes_still_attempt_calendar_and_keep_calendar_counts() {
    let mut calendar_called = false;
    let result = run_full_sequence(
        || Ok(BrowserOutcome::Incomplete { gaps: 3, omissions: 2 }),
        || {
            calendar_called = true;
            Ok(CalendarOutcome::Complete(IcalRefreshResult {
                status: "complete",
                updated_at: "2026-10-02T10:00:00Z".into(),
                added: 1,
                updated: 4,
                held: 0,
                removed: 0,
            }))
        },
    )
    .unwrap();
    assert!(calendar_called);
    assert_eq!(result.status, "incomplete");
    assert_eq!(result.browser_status, "incomplete");
    assert_eq!(result.calendar_status, "complete");
    assert_eq!(result.gap_count, 3);
    assert_eq!(result.omission_count, 2);
    assert_eq!(result.calendar_added, 1);
    assert_eq!(result.calendar_updated, 4);

    let failed = run_full_sequence(
        || {
            Ok(BrowserOutcome::Failed {
                code: "browser-failed",
            })
        },
        || {
            calendar_called = true;
            Ok(CalendarOutcome::Incomplete(IcalRefreshResult {
                status: "complete",
                updated_at: "2026-10-02T10:00:00Z".into(),
                added: 0,
                updated: 0,
                held: 1,
                removed: 0,
            }))
        },
    )
    .unwrap();
    assert!(calendar_called);
    assert_eq!(failed.browser_status, "failed");
    assert_eq!(failed.calendar_status, "incomplete");
    assert_eq!(failed.calendar_held, 1);
    assert_eq!(failed.error_code, Some("browser-failed"));
}

#[test]
fn fatal_cancellation_skips_the_calendar_phase() {
    let mut calendar_called = false;
    let result = run_full_sequence(
        || Err(()),
        || {
            calendar_called = true;
            Ok(CalendarOutcome::Unavailable)
        },
    );
    assert!(result.is_err());
    assert!(!calendar_called);
}

#[test]
fn full_refresh_uses_the_shared_gate_and_rejects_overlap() {
    let (_app_root, app) = app_with_store("full-refresh-concurrency");
    let _existing_refresh = lock(&app.shared.refresh_running);
    let error = app
        .shared
        .full_refresh(&mut |_| true)
        .expect_err("an existing refresh owns the shared gate");
    assert_eq!(error.code, "refresh-running");
}
