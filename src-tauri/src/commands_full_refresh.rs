//! Full refresh through the one integrity-checked browser runtime, followed by native iCal import.

use super::*;
use serde::Deserialize;
#[path = "commands_full_refresh_runtime.rs"]
mod runtime;
pub(super) use runtime::BrowserRuntime;
use runtime::RUNTIME_ENTRYPOINT;
#[cfg(test)]
use runtime::{
    digest_file, PACKAGE_PINS, RUNTIME_MANIFEST, RUNTIME_MANIFEST_FORMAT, RUNTIME_NODE_VERSION,
};

const MAX_CHILD_RUNTIME: Duration = Duration::from_secs(45 * 60);
const MAX_CHILD_LINE_BYTES: usize = 8192;
const MAX_CHILD_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROGRESS_FRAMES: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FullRefreshProgress {
    pub phase: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FullRefreshResult {
    pub status: &'static str,
    pub browser_status: &'static str,
    pub calendar_status: &'static str,
    pub gap_count: u64,
    pub omission_count: u64,
    pub calendar_added: u64,
    pub calendar_updated: u64,
    pub calendar_held: u64,
    pub updated_at: Option<String>,
    pub error_code: Option<&'static str>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum RuntimeMessage {
    Progress {
        phase: String,
    },
    #[serde(rename_all = "camelCase")]
    Result {
        status: String,
        resource_count: u64,
        item_count: u64,
        gap_count: u64,
        omission_count: u64,
        imported_courses: u64,
        archived_courses: u64,
        promoted_blobs: u64,
        reused_blobs: u64,
        bytes_verified: u64,
        already_current: bool,
        #[serde(default)]
        error_code: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowserOutcome {
    Complete { gaps: u64, omissions: u64 },
    Incomplete { gaps: u64, omissions: u64 },
    Failed { code: &'static str },
}

#[derive(Debug, Clone)]
enum CalendarOutcome {
    Complete(IcalRefreshResult),
    Incomplete(IcalRefreshResult),
    Failed,
    Unavailable,
}

impl Inner {
    pub(super) fn full_refresh(
        &self,
        report: &mut dyn FnMut(FullRefreshProgress) -> bool,
    ) -> Result<FullRefreshResult, CommandError> {
        if self.refresh_shutting_down.load(Ordering::SeqCst) {
            return Err(CommandError::new(
                "refresh-cancelled",
                "Full refresh is stopping with the app.",
            ));
        }
        let _running = self
            .refresh_running
            .try_lock()
            .map_err(|_| CommandError::new("refresh-running", "A refresh is already running."))?;
        self.refresh_cancelled.store(false, Ordering::SeqCst);

        let store = self.store()?;
        let authoritative = matches!(
            store.condition(),
            Ok(StoreCondition::Ready(summary))
                if summary.state == crate::store::StoreState::Authoritative
        );
        let report = std::cell::RefCell::new(report);
        let browser = || {
            if !authoritative {
                return Ok(BrowserOutcome::Failed {
                    code: "browser-store-unavailable",
                });
            }
            let Some(runtime) = self.browser_runtime.as_ref() else {
                return Ok(BrowserOutcome::Failed {
                    code: "browser-unavailable",
                });
            };
            match run_browser_client(self, runtime, &mut |event| (report.borrow_mut())(event)) {
                Ok(result) => Ok(result),
                Err(BrowserRunError::Cancelled) => Err(()),
                Err(BrowserRunError::Failed(code)) => Ok(BrowserOutcome::Failed { code }),
            }
        };
        let calendar = || {
            if !self.ical_refresh_available(store) {
                return Ok(CalendarOutcome::Unavailable);
            }
            if !(report.borrow_mut())(FullRefreshProgress { phase: "calendar" }) {
                self.terminate_refresh_process();
                return Err(());
            }
            let result = self.refresh_ical_under_refresh_guard(&mut |_| {
                (report.borrow_mut())(FullRefreshProgress { phase: "calendar" })
            });
            match result {
                Ok(result) if result.held == 0 => Ok(CalendarOutcome::Complete(result)),
                Ok(result) => Ok(CalendarOutcome::Incomplete(result)),
                Err(error)
                    if error.code == "progress-lost" || error.code == "refresh-cancelled" =>
                {
                    Err(())
                }
                Err(_) => Ok(CalendarOutcome::Failed),
            }
        };
        let result = run_full_sequence(browser, calendar).map_err(|_| {
            CommandError::new(
                "refresh-cancelled",
                "Full refresh was stopped before it completed.",
            )
        })?;
        if !(report.borrow_mut())(FullRefreshProgress { phase: "complete" }) {
            return Err(CommandError::new(
                "refresh-cancelled",
                "Full refresh was stopped before it completed.",
            ));
        }
        Ok(result)
    }
}

fn run_full_sequence<B, C>(browser: B, calendar: C) -> Result<FullRefreshResult, ()>
where
    B: FnOnce() -> Result<BrowserOutcome, ()>,
    C: FnOnce() -> Result<CalendarOutcome, ()>,
{
    let browser = browser()?;
    let calendar = calendar()?;
    Ok(combine_outcomes(browser, calendar))
}

fn combine_outcomes(browser: BrowserOutcome, calendar: CalendarOutcome) -> FullRefreshResult {
    let (browser_status, browser_gaps, omissions, browser_error) = match browser {
        BrowserOutcome::Complete { gaps, omissions } => ("complete", gaps, omissions, None),
        BrowserOutcome::Incomplete { gaps, omissions } => ("incomplete", gaps, omissions, None),
        BrowserOutcome::Failed { code } => ("failed", 0, 0, Some(code)),
    };
    let (calendar_status, added, updated, held, updated_at, calendar_error) = match calendar {
        CalendarOutcome::Complete(result) => (
            "complete",
            result.added,
            result.updated,
            result.held,
            Some(result.updated_at),
            None,
        ),
        CalendarOutcome::Incomplete(result) => (
            "incomplete",
            result.added,
            result.updated,
            result.held,
            Some(result.updated_at),
            None,
        ),
        CalendarOutcome::Failed => ("failed", 0, 0, 0, None, Some("calendar-failed")),
        CalendarOutcome::Unavailable => {
            ("unavailable", 0, 0, 0, None, Some("calendar-unavailable"))
        }
    };
    let status = if browser_status == "complete" && calendar_status == "complete" {
        "complete"
    } else {
        "incomplete"
    };
    FullRefreshResult {
        status,
        browser_status,
        calendar_status,
        gap_count: browser_gaps.saturating_add(held),
        omission_count: omissions,
        calendar_added: added,
        calendar_updated: updated,
        calendar_held: held,
        updated_at,
        error_code: browser_error.or(calendar_error),
    }
}

#[derive(Debug)]
enum BrowserRunError {
    Cancelled,
    Failed(&'static str),
}

fn run_browser_client(
    inner: &Inner,
    runtime: &BrowserRuntime,
    report: &mut dyn FnMut(FullRefreshProgress) -> bool,
) -> Result<BrowserOutcome, BrowserRunError> {
    run_browser_client_with_timeout(inner, runtime, report, MAX_CHILD_RUNTIME)
}

fn run_browser_client_with_timeout(
    inner: &Inner,
    runtime: &BrowserRuntime,
    report: &mut dyn FnMut(FullRefreshProgress) -> bool,
    max_runtime: Duration,
) -> Result<BrowserOutcome, BrowserRunError> {
    if inner.refresh_shutting_down.load(Ordering::SeqCst) {
        return Err(BrowserRunError::Cancelled);
    }
    let runtime = BrowserRuntime::verify(&runtime.root)
        .map_err(|_| BrowserRunError::Failed("browser-runtime-invalid"))?;
    let mut command = Command::new(&runtime.node);
    command
        .arg(RUNTIME_ENTRYPOINT)
        .current_dir(&runtime.root)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| BrowserRunError::Failed("browser-start-failed"))?;
    let Some(stdout) = child.stdout.take() else {
        terminate_process_group(&mut child);
        return Err(BrowserRunError::Failed("browser-output-invalid"));
    };
    {
        let mut active = lock(&inner.refresh_child);
        if inner.refresh_shutting_down.load(Ordering::SeqCst) || active.is_some() {
            terminate_process_group(&mut child);
            return Err(BrowserRunError::Cancelled);
        }
        *active = Some(child);
    }

    let (sender, receiver) = mpsc::sync_channel::<Result<Vec<u8>, ()>>(16);
    if thread::Builder::new()
        .name("duegood-full-refresh-output".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_bounded_line(&mut reader, MAX_CHILD_LINE_BYTES) {
                    Ok(Some(line)) => {
                        if sender.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        let _ = sender.send(Err(()));
                        break;
                    }
                }
            }
        })
        .is_err()
    {
        inner.terminate_refresh_process();
        return Err(BrowserRunError::Failed("browser-output-invalid"));
    }

    let deadline = Instant::now() + max_runtime;
    let mut child_status = None;
    let mut reader_closed = false;
    let mut result = None;
    let mut bytes_read = 0usize;
    let mut progress_frames = 0usize;
    let mut last_ui_phase = None;
    let mut failed = None;
    while child_status.is_none() || !reader_closed {
        if inner.refresh_cancelled.load(Ordering::SeqCst)
            || inner.refresh_shutting_down.load(Ordering::SeqCst)
        {
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            inner.terminate_refresh_process();
            return Err(BrowserRunError::Failed("browser-timeout"));
        }
        match receiver.recv_timeout((deadline - now).min(Duration::from_millis(100))) {
            Ok(Ok(line)) => {
                bytes_read = bytes_read.saturating_add(line.len());
                if bytes_read > MAX_CHILD_OUTPUT_BYTES {
                    failed = Some("browser-output-invalid");
                    break;
                }
                match serde_json::from_slice::<RuntimeMessage>(&line) {
                    Ok(RuntimeMessage::Progress { phase }) if result.is_none() => {
                        progress_frames += 1;
                        if progress_frames > MAX_PROGRESS_FRAMES {
                            failed = Some("browser-output-invalid");
                            break;
                        }
                        let ui_phase = match phase.as_str() {
                            "broker-starting" | "waiting-for-canvas" | "capturing" => {
                                "browser-capture"
                            }
                            "importing" | "complete" => "browser-import",
                            _ => {
                                failed = Some("browser-output-invalid");
                                break;
                            }
                        };
                        if last_ui_phase != Some(ui_phase) {
                            if !report(FullRefreshProgress { phase: ui_phase }) {
                                inner.terminate_refresh_process();
                                return Err(BrowserRunError::Cancelled);
                            }
                            last_ui_phase = Some(ui_phase);
                        }
                    }
                    Ok(RuntimeMessage::Result {
                        status,
                        resource_count,
                        item_count,
                        gap_count,
                        omission_count,
                        imported_courses,
                        archived_courses,
                        promoted_blobs,
                        reused_blobs,
                        bytes_verified,
                        already_current,
                        error_code,
                    }) if result.is_none()
                        && matches!(status.as_str(), "complete" | "incomplete")
                        && resource_count <= 100_000
                        && item_count <= 100_000
                        && gap_count <= 100_000
                        && omission_count <= 100_000
                        && imported_courses <= 100_000
                        && archived_courses <= 100_000
                        && promoted_blobs <= 100_000
                        && reused_blobs <= 100_000
                        && bytes_verified <= 4 * 1024 * 1024 * 1024
                        && valid_runtime_error_code(error_code.as_deref())
                        && (status != "complete" || gap_count == 0 && error_code.is_none()) =>
                    {
                        result = Some(match (status.as_str(), error_code.as_deref()) {
                            ("complete", _) => BrowserOutcome::Complete {
                                gaps: gap_count,
                                omissions: omission_count,
                            },
                            ("incomplete", None | Some("CAPTURE_GAPS")) => {
                                BrowserOutcome::Incomplete {
                                    gaps: gap_count,
                                    omissions: omission_count,
                                }
                            }
                            ("incomplete", Some(_)) => BrowserOutcome::Failed {
                                code: "browser-failed",
                            },
                            _ => unreachable!("status was validated"),
                        });
                        let _ = already_current;
                        let _ = (promoted_blobs, bytes_verified);
                    }
                    _ => {
                        failed = Some("browser-output-invalid");
                        break;
                    }
                }
            }
            Ok(Err(())) => {
                failed = Some("browser-output-invalid");
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => reader_closed = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if child_status.is_none() {
            let mut active = lock(&inner.refresh_child);
            if let Some(child) = active.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => child_status = Some(status),
                    Ok(None) => {}
                    Err(_) => {
                        failed = Some("browser-helper-failed");
                        break;
                    }
                }
            } else {
                break;
            }
        }
    }
    if let Some(code) = failed {
        inner.terminate_refresh_process();
        return Err(BrowserRunError::Failed(code));
    }
    if inner.refresh_cancelled.load(Ordering::SeqCst)
        || inner.refresh_shutting_down.load(Ordering::SeqCst)
    {
        return Err(BrowserRunError::Cancelled);
    }
    lock(&inner.refresh_child).take();
    let Some(status) = child_status else {
        inner.terminate_refresh_process();
        return Err(BrowserRunError::Failed("browser-helper-failed"));
    };
    let expected_partial_exit = result.is_some_and(|outcome| {
        matches!(
            outcome,
            BrowserOutcome::Incomplete { .. } | BrowserOutcome::Failed { .. }
        )
    }) && status.code() == Some(1);
    if !status.success() && !expected_partial_exit {
        return Err(BrowserRunError::Failed("browser-helper-failed"));
    }
    result.ok_or(BrowserRunError::Failed("browser-output-invalid"))
}

fn valid_runtime_error_code(value: Option<&str>) -> bool {
    value.is_none_or(|code| {
        matches!(
            code,
            "BROWSER_REFRESH_FAILED"
                | "CAPTURE_GAPS"
                | "CAPTURE_STATE_UNAVAILABLE"
                | "BINDING_REQUIRED"
                | "SIGN_IN_REQUIRED"
                | "IDENTITY_MISMATCH"
                | "NATIVE_IMPORT_FAILED"
                | "INVALID_REFRESH_RESULT"
        )
    })
}

#[tauri::command]
pub(super) async fn start_full_refresh(
    state: State<'_, AppState>,
    on_progress: Channel<FullRefreshProgress>,
) -> Result<FullRefreshResult, CommandError> {
    blocking_arc(state.inner(), move |inner| {
        inner.full_refresh(&mut |event| {
            if on_progress.send(event).is_err() {
                inner.terminate_refresh_process();
                false
            } else {
                true
            }
        })
    })
    .await
}

#[cfg(test)]
#[path = "commands_full_refresh_tests.rs"]
mod tests;
