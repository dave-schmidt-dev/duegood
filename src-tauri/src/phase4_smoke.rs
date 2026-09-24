//! End-to-end smoke for the desktop command layer under the isolated test bundle.

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::Manager;

    use crate::commands::{self, AppState, FolderPicker, Settings};
    use crate::config::TEST_BUNDLE_IDENTIFIER;
    use crate::testutil::{materialize_fixture, TempRoot};

    struct FixedPicker(Option<PathBuf>);

    impl FolderPicker for FixedPicker {
        fn pick_folder(&self) -> Option<PathBuf> {
            self.0.clone()
        }
    }

    fn state(temp: &TempRoot, pick: Option<PathBuf>) -> AppState {
        AppState::open(
            Ok(temp.path().join(TEST_BUNDLE_IDENTIFIER)),
            Some(temp.path()),
            Box::new(FixedPicker(pick)),
            Settings::PRODUCTION,
        )
    }

    fn invoke<W: AsRef<tauri::Webview<tauri::test::MockRuntime>>>(
        webview: &W,
        command: &str,
        body: Value,
    ) -> Result<Value, Value> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("local origin"),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("JSON response"))
    }

    fn build_app(temp: &TempRoot, pick: Option<PathBuf>) -> tauri::App<tauri::test::MockRuntime> {
        commands::register_handlers(mock_builder())
            .manage(state(temp, pick))
            .build(tauri::generate_context!(test = true))
            .expect("mock desktop app")
    }

    fn window(
        app: &tauri::App<tauri::test::MockRuntime>,
    ) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        match app.get_webview_window("main") {
            Some(window) => window,
            None => tauri::WebviewWindowBuilder::new(app, "main", Default::default())
                .build()
                .expect("mock main window"),
        }
    }

    fn wait_for_snapshot(window: &tauri::WebviewWindow<tauri::test::MockRuntime>) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = invoke(window, "store_status", json!({})).expect("store status");
            if status["snapshotInProgress"] == false {
                return;
            }
            assert!(Instant::now() < deadline, "initial snapshot should finish");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn isolated_command_smoke_imports_reads_mutates_recovers_and_reopens() {
        let temp = TempRoot::new("phase4-command-smoke");
        let source = materialize_fixture(&temp.path().join("legacy"));

        {
            let app = build_app(&temp, Some(source.clone()));
            let webview = window(&app);

            let first_run = invoke(&webview, "store_status", json!({})).expect("first-run status");
            assert_eq!(first_run["availability"], "ready");
            assert_eq!(first_run["state"], "empty");
            assert_eq!(first_run["refreshAvailable"], false);
            assert_eq!(
                first_run["dataFolder"],
                format!("~/{TEST_BUNDLE_IDENTIFIER}")
            );

            assert_eq!(
                invoke(&webview, "choose_legacy_root", json!({})).expect("choose legacy root"),
                json!({"selected": true})
            );
            let preview = invoke(
                &webview,
                "import_legacy_root",
                json!({"replacePreview": false, "onProgress": "__CHANNEL__:7"}),
            )
            .expect("synthetic first-run import");
            assert_eq!(preview["state"], "preview");

            wait_for_snapshot(&webview);

            // The same bounded command supplies the documents needed by Overview, course, and
            // Activity routes; check representative data from each area before mutating anything.
            let documents = invoke(&webview, "read_dashboard_documents", json!({}))
                .expect("dashboard documents");
            assert_eq!(documents["storeState"], "preview");
            assert!(documents["coursework"]["version"].as_str().is_some());
            assert!(documents["coursework"]["text"]
                .as_str()
                .unwrap()
                .contains("Essay draft"));
            assert!(documents["conversations"].as_str().unwrap().contains("c-1"));
            assert!(documents["profile"].as_str().unwrap().contains("Synthetic"));
            assert!(documents["refreshHistory"]
                .as_str()
                .unwrap()
                .contains("refresh-1"));
            assert!(documents["courseExports"]["syn-101"]["announcements"]
                .as_str()
                .unwrap()
                .contains("Welcome"));

            let changed = invoke(
                &webview,
                "set_item_completion",
                json!({"itemId": "syn-101-essay-1", "expected": false, "value": true}),
            )
            .expect("completion write");
            assert_eq!(changed["completed"], true);
            let after_write = invoke(&webview, "read_dashboard_documents", json!({}))
                .expect("read after completion write");
            assert!(after_write["coursework"]["text"]
                .as_str()
                .unwrap()
                .contains("\"done\": true"));

            // A preview store cannot refresh, even if the local preference is enabled.
            let refresh_setting = invoke(
                &webview,
                "set_canvas_refresh_enabled",
                json!({"enabled": true}),
            )
            .expect("set local refresh preference");
            assert_eq!(refresh_setting["refreshAvailable"], false);
            let refresh_error = invoke(
                &webview,
                "start_canvas_refresh",
                json!({"onProgress": "__CHANNEL__:8"}),
            )
            .expect_err("preview refresh remains unavailable");
            assert_eq!(refresh_error["code"], "preview-refresh");

            // Exercise the recovery route by damaging a required document, then select the
            // automatic first-run snapshot through the same commands the recovery panel uses.
            let snapshots =
                invoke(&webview, "list_snapshots", json!({})).expect("list recovery points");
            assert!(snapshots.as_array().is_some_and(|items| !items.is_empty()));
            let snapshot_id = snapshots[0]["id"].as_str().expect("snapshot id").to_owned();
            let manifest_path = temp
                .path()
                .join(TEST_BUNDLE_IDENTIFIER)
                .join("store")
                .join("duegood-store.json");
            std::fs::write(&manifest_path, b"not-json").expect("simulate damaged manifest");
            let damaged = invoke(&webview, "store_status", json!({})).expect("recovery status");
            assert_eq!(damaged["state"], "damaged");
            let read_error = invoke(&webview, "read_dashboard_documents", json!({}))
                .expect_err("damaged store must not be projected");
            assert_eq!(read_error["code"], "store-needs-recovery");
            invoke(&webview, "restore_snapshot", json!({"id": snapshot_id}))
                .expect("restore selected recovery point");
            let recovered = invoke(&webview, "read_dashboard_documents", json!({}))
                .expect("read recovered documents");
            assert!(recovered["coursework"]["text"]
                .as_str()
                .unwrap()
                .contains("Essay draft"));

            // Tauri's mock runtime stays in-process, so unmanage the app state to model the
            // lifetime lock being released by process exit before creating the next app.
            app.state::<AppState>().terminate_canvas_refresh();
            app.cleanup_before_exit();
            drop(app.unmanage::<AppState>().expect("release app state"));
            drop(webview);
            drop(app);
        }

        // A new app state represents a quit/relaunch and must reopen the recovered private store.
        let app = build_app(&temp, None);
        let webview = window(&app);
        wait_for_snapshot(&webview);
        let reopened = invoke(&webview, "store_status", json!({})).expect("relaunch status");
        assert_eq!(reopened["availability"], "ready");
        assert_eq!(reopened["state"], "preview");
        assert_eq!(reopened["refreshAvailable"], false);
        let documents = invoke(&webview, "read_dashboard_documents", json!({}))
            .expect("relaunch reads recovered store");
        assert!(documents["coursework"]["text"]
            .as_str()
            .unwrap()
            .contains("Essay draft"));
        app.cleanup_before_exit();
        drop(
            app.unmanage::<AppState>()
                .expect("release reopened app state"),
        );
        drop(webview);
        drop(app);
    }
}
