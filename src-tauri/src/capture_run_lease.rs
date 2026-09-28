//! Bounded streaming protocol for holding the shared capture lease.

use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;

use super::{invalid_data, CaptureAttempt, CaptureAttemptStatus, CaptureRunGuard};

const MAX_TERMINAL_REQUEST_BYTES: usize = 4096;
const CAPTURE_LEASE_TIMEOUT: Duration = Duration::from_secs(40 * 60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalRequest {
    status: String,
    run_id: u64,
    #[serde(default)]
    generation_id: Option<String>,
    #[serde(default)]
    snapshot_sha256: Option<String>,
    #[serde(default)]
    user_id: Option<u64>,
}

/// Runs the native lease protocol: allocate, print the ID, await one bounded terminal message,
/// verify the published archive, and retain the lock until status is durably updated.
pub fn run_lease<R, W>(data_root: &Path, input: R, mut output: W) -> io::Result<CaptureAttempt>
where
    R: Read + Send + 'static,
    W: Write,
{
    let guard = CaptureRunGuard::acquire(data_root)?;
    let attempt = guard.begin()?;
    if let Err(error) = writeln!(output, "lease run={} status=running", attempt.run_id)
        .and_then(|()| output.flush())
    {
        let _ = guard.fail(attempt.run_id);
        return Err(error);
    }
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let result = read_terminal_request(input);
        let _ = sender.send(result);
    });
    let request = match receiver.recv_timeout(CAPTURE_LEASE_TIMEOUT) {
        Ok(request) => request,
        Err(_) => {
            let _ = guard.fail(attempt.run_id);
            let _ = writeln!(output, "run={} status=failed", attempt.run_id);
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "capture lease expired",
            ));
        }
    };
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            let _ = guard.fail(attempt.run_id);
            let _ = writeln!(output, "run={} status=failed", attempt.run_id);
            return Err(error);
        }
    };
    if request.run_id != attempt.run_id {
        let _ = guard.fail(attempt.run_id);
        let _ = writeln!(output, "run={} status=failed", attempt.run_id);
        return Err(invalid_data("terminal request run ID does not match"));
    }
    let terminal = match request.status.as_str() {
        "failed"
            if request.generation_id.is_none()
                && request.snapshot_sha256.is_none()
                && request.user_id.is_none() =>
        {
            guard.fail(attempt.run_id)?
        }
        "captured" => {
            let fields = (
                request.generation_id.as_deref(),
                request.snapshot_sha256.as_deref(),
                request.user_id,
            );
            let (Some(generation_id), Some(digest), Some(user_id)) = fields else {
                let _ = guard.fail(attempt.run_id);
                let _ = writeln!(output, "run={} status=failed", attempt.run_id);
                return Err(invalid_data("terminal request identity is incomplete"));
            };
            match guard.complete(attempt.run_id, generation_id, digest, user_id) {
                Ok(attempt) => attempt,
                Err(error) => {
                    let _ = guard.fail(attempt.run_id);
                    let _ = writeln!(output, "run={} status=failed", attempt.run_id);
                    return Err(error);
                }
            }
        }
        _ => {
            let _ = guard.fail(attempt.run_id);
            let _ = writeln!(output, "run={} status=failed", attempt.run_id);
            return Err(invalid_data("terminal request status is invalid"));
        }
    };
    writeln!(
        output,
        "run={} status={}",
        terminal.run_id,
        status_code(terminal.status)
    )?;
    output.flush()?;
    Ok(terminal)
}

fn status_code(status: CaptureAttemptStatus) -> &'static str {
    match status {
        CaptureAttemptStatus::Running => "running",
        CaptureAttemptStatus::Failed => "failed",
        CaptureAttemptStatus::Captured => "captured",
    }
}

fn read_terminal_request<R: Read>(input: R) -> io::Result<TerminalRequest> {
    let mut bytes = Vec::new();
    input
        .take((MAX_TERMINAL_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() > MAX_TERMINAL_REQUEST_BYTES {
        return Err(invalid_data("terminal request is empty or too large"));
    }
    let request: TerminalRequest =
        serde_json::from_slice(&bytes).map_err(|_| invalid_data("terminal request is invalid"))?;
    if request.run_id == 0 {
        return Err(invalid_data("terminal request run ID is invalid"));
    }
    Ok(request)
}
