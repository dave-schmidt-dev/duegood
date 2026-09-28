//! Narrow Tauri command for adopting the current native Canvas browser capture.

use tauri::ipc::Channel;
use tauri::State;

use crate::browser_import::{BrowserImportError, BrowserImportProgress, BrowserImportResult};

impl super::Inner {
    fn export_native_store(
        &self,
        progress: &mut dyn FnMut(crate::export::ExportProgress),
    ) -> Result<crate::export::ExportProgress, super::CommandError> {
        let store = self.store()?;
        let parent = self.picker.pick_export_folder().ok_or_else(|| {
            super::CommandError::new("cancelled", "No export folder was selected.")
        })?;
        Ok(crate::export::export_native_store(
            store, &parent, progress,
        )?)
    }

    fn import_browser_capture(
        &self,
        confirm_first_account: bool,
        progress: &mut dyn FnMut(BrowserImportProgress),
    ) -> Result<BrowserImportResult, super::CommandError> {
        let _running = match self.import_running.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(super::CommandError::new(
                    "import-running",
                    "An import is already running.",
                ));
            }
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        };
        let store = self.store()?;
        let archive_root =
            crate::config::canvas_capture_archive_root(store.data_root()).map_err(|_| {
                super::CommandError::new(
                    "capture-archive-unavailable",
                    "The current Canvas browser capture is unavailable.",
                )
            })?;
        crate::browser_import::import_current_capture_confirmed(
            store,
            &archive_root,
            confirm_first_account,
            progress,
        )
        .map_err(import_error)
    }
}

#[tauri::command]
pub(super) async fn export_native_store(
    state: State<'_, super::AppState>,
    on_progress: Channel<crate::export::ExportProgress>,
) -> Result<crate::export::ExportProgress, super::CommandError> {
    super::blocking(state.inner(), move |inner| {
        inner.export_native_store(&mut |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

fn import_error(error: BrowserImportError) -> super::CommandError {
    let code = error.code();
    super::CommandError::new(
        code,
        "The current Canvas browser capture could not be imported.",
    )
}

#[tauri::command]
pub(super) async fn import_browser_capture(
    state: State<'_, super::AppState>,
    confirm_first_account: bool,
    on_progress: Channel<BrowserImportProgress>,
) -> Result<BrowserImportResult, super::CommandError> {
    super::blocking_arc(state.inner(), move |inner| {
        inner.import_browser_capture(confirm_first_account, &mut |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

#[cfg(test)]
#[path = "commands_browser_tests.rs"]
mod tests;
