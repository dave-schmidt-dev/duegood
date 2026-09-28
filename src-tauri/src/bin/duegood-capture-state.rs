//! Private Canvas capture-state and capture-lease helper.
//!
//! Production roots are fixed by the library. Test builds require the explicit `.test` root;
//! this executable accepts no root override. `lease` holds the shared lock through collection,
//! archive publication, and terminal receipt validation.

use std::io;

use duegood_desktop::capture_run::{
    read_attempt, run_lease, CaptureAttemptStatus, CaptureRunGuard,
};
use duegood_desktop::refresh_helper_store_root;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Begin,
    Fail(u64),
    Status,
    Lease,
}

fn parse_command(args: &[std::ffi::OsString]) -> Result<Command, ()> {
    match args {
        [verb] if verb == "begin" => Ok(Command::Begin),
        [verb] if verb == "status" => Ok(Command::Status),
        [verb] if verb == "lease" => Ok(Command::Lease),
        [verb, run_id] if verb == "fail" => {
            let value = run_id.to_str().ok_or(())?;
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(());
            }
            let run_id = value.parse::<u64>().map_err(|_| ())?;
            if run_id == 0 {
                return Err(());
            }
            Ok(Command::Fail(run_id))
        }
        _ => Err(()),
    }
}

fn status_line(run_id: u64, status: &str) -> String {
    format!("run={run_id} status={status}")
}

fn run_command(command: Command, data_root: &std::path::Path) -> io::Result<String> {
    match command {
        Command::Begin => {
            let guard = CaptureRunGuard::acquire(data_root)?;
            let attempt = guard.begin()?;
            Ok(status_line(attempt.run_id, "running"))
        }
        Command::Fail(run_id) => {
            let guard = CaptureRunGuard::acquire(data_root)?;
            let attempt = guard.fail(run_id)?;
            let status = match attempt.status {
                CaptureAttemptStatus::Running => "running",
                CaptureAttemptStatus::Failed => "failed",
                CaptureAttemptStatus::Captured => "captured",
            };
            Ok(status_line(attempt.run_id, status))
        }
        Command::Status => {
            let attempt = read_attempt(data_root)?;
            Ok(match attempt {
                Some(attempt) => {
                    let status = match attempt.status {
                        CaptureAttemptStatus::Running => "running",
                        CaptureAttemptStatus::Failed => "failed",
                        CaptureAttemptStatus::Captured => "captured",
                    };
                    status_line(attempt.run_id, status)
                }
                None => status_line(0, "none"),
            })
        }
        Command::Lease => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "lease uses streaming I/O",
        )),
    }
}

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let result = parse_command(&args).map_err(|_| ()).and_then(|command| {
        let data_root = refresh_helper_store_root().map_err(|_| ())?;
        if command == Command::Lease {
            run_lease(&data_root, io::stdin(), io::stdout().lock())
                .map(|_| String::new())
                .map_err(|_| ())
        } else {
            run_command(command, &data_root).map_err(|_| ())
        }
    });
    match result {
        Ok(line) if !line.is_empty() => println!("{line}"),
        Ok(_) => {}
        Err(()) => {
            eprintln!("Capture state operation failed.");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn args(parts: &[&str]) -> Vec<OsString> {
        parts.iter().map(OsString::from).collect()
    }

    #[test]
    fn cli_contract_accepts_lease_and_rejects_unsafe_arguments() {
        assert_eq!(parse_command(&args(&["begin"])), Ok(Command::Begin));
        assert_eq!(parse_command(&args(&["status"])), Ok(Command::Status));
        assert_eq!(parse_command(&args(&["lease"])), Ok(Command::Lease));
        assert_eq!(parse_command(&args(&["fail", "12"])), Ok(Command::Fail(12)));
        assert!(parse_command(&args(&["fail", "0"])).is_err());
        assert!(parse_command(&args(&["fail", "1x"])).is_err());
        assert!(parse_command(&args(&["lease", "extra"])).is_err());
    }
}
