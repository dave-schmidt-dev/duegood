use std::io::{self, Write};

use duegood_desktop::{
    read_browser_import_confirmation, run_browser_import, BrowserImportPhase,
    BrowserImportProgress, BrowserImportResult,
};

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    if std::env::args_os().len() != 1 {
        report_error("INVALID_ARGUMENTS");
        return 1;
    }
    let confirmation = match read_browser_import_confirmation(io::stdin().lock()) {
        Ok(value) => value,
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
    let result = run_browser_import(confirmation, &mut on_progress);
    drop(on_progress);
    if output_failed {
        report_error("OUTPUT_UNAVAILABLE");
        return 1;
    }
    match result {
        Ok(result) => match write_result(&mut output, &result) {
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

fn write_progress(output: &mut impl Write, value: BrowserImportProgress) -> io::Result<()> {
    writeln!(
        output,
        "{{\"type\":\"progress\",\"phase\":\"{}\",\"filesDone\":{},\"bytesDone\":{}}}",
        phase_name(value.phase),
        value.files_done,
        value.bytes_done
    )?;
    output.flush()
}

fn write_result(output: &mut impl Write, value: &BrowserImportResult) -> io::Result<()> {
    writeln!(
        output,
        "{{\"type\":\"result\",\"status\":\"complete\",\"runId\":{},\"importedCourses\":{},\"archivedCourses\":{},\"promotedBlobs\":{},\"reusedBlobs\":{},\"bytesVerified\":{},\"alreadyCurrent\":{}}}",
        value.run_id,
        value.imported_courses,
        value.archived_courses,
        value.promoted_blobs,
        value.reused_blobs,
        value.bytes_verified,
        value.already_current
    )?;
    output.flush()
}

fn phase_name(value: BrowserImportPhase) -> &'static str {
    match value {
        BrowserImportPhase::Validating => "validating",
        BrowserImportPhase::Copying => "copying",
        BrowserImportPhase::Reconciling => "reconciling",
        BrowserImportPhase::Publishing => "publishing",
        BrowserImportPhase::Complete => "complete",
    }
}

fn report_error(code: &str) {
    // All callers pass compile-time codes; never print process arguments, paths, or source errors.
    eprintln!("{code}");
}
