//! Fixed-root stdin/stdout helper for reviewed personal class-session clocks.

use std::io::{self, Write};

use duegood_desktop::{
    read_personal_session_request, run_personal_sessions, PersonalSessionProgress,
    PersonalSessionResult,
};

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    if std::env::args_os().len() != 1 {
        report_error("INVALID_ARGUMENTS");
        return 1;
    }
    let request = match read_personal_session_request(io::stdin().lock()) {
        Ok(request) => request,
        Err(error) => {
            report_error(error.code());
            return 1;
        }
    };
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut output_failed = false;
    let mut on_progress = |progress| {
        if write_progress(&mut output, progress).is_err() {
            output_failed = true;
        }
    };
    let result = run_personal_sessions(request, &mut on_progress);
    drop(on_progress);
    if output_failed {
        report_error("OUTPUT_UNAVAILABLE");
        return 1;
    }
    match result {
        Ok(result) => match write_result(&mut output, result) {
            Ok(()) => 0,
            Err(_) => {
                report_error("OUTPUT_UNAVAILABLE");
                1
            }
        },
        Err(error) => {
            report_error(error.code());
            1
        }
    }
}

fn write_progress(output: &mut impl Write, progress: PersonalSessionProgress) -> io::Result<()> {
    match progress {
        PersonalSessionProgress::Writing => {
            writeln!(output, "{}", r#"{"type":"progress","phase":"writing"}"#)?
        }
    }
    output.flush()
}

fn write_result(output: &mut impl Write, result: PersonalSessionResult) -> io::Result<()> {
    writeln!(
        output,
        "{{\"type\":\"result\",\"status\":\"complete\",\"added\":{},\"updated\":{},\"unchanged\":{}}}",
        result.added, result.updated, result.unchanged
    )?;
    output.flush()
}

fn report_error(code: &str) {
    eprintln!("{code}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn progress_output_is_sanitized_json() {
        let mut output = Vec::new();
        write_progress(&mut output, PersonalSessionProgress::Writing).unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"type":"progress","phase":"writing"})
        );
    }

    #[test]
    fn result_output_is_sanitized_json_with_counts_only() {
        let mut output = Vec::new();
        write_result(
            &mut output,
            PersonalSessionResult {
                added: 2,
                updated: 1,
                unchanged: false,
            },
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type":"result", "status":"complete", "added":2, "updated":1,
                "unchanged":false
            })
        );
    }
}
