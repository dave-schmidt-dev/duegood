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
        "{{\"type\":\"result\",\"status\":\"complete\",\"runId\":{},\"importedCourses\":{},\"archivedCourses\":{},\"promotedBlobs\":{},\"reusedBlobs\":{},\"bytesVerified\":{},\"alreadyCurrent\":{},\"exportStatus\":\"{}\",\"exportWritten\":{},\"exportUnchanged\":{},\"exportSkippedOwnerFiles\":{}}}",
        value.run_id,
        value.imported_courses,
        value.archived_courses,
        value.promoted_blobs,
        value.reused_blobs,
        value.bytes_verified,
        value.already_current,
        value.export_status,
        value.export_written,
        value.export_unchanged,
        value.export_skipped_owner_files
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

#[cfg(test)]
mod tests {
    use super::write_result;
    use duegood_desktop::BrowserImportResult;

    #[test]
    fn result_writer_emits_the_exact_export_summary_fields() {
        let value = BrowserImportResult {
            run_id: 42,
            imported_courses: 2,
            archived_courses: 1,
            promoted_blobs: 3,
            reused_blobs: 4,
            bytes_verified: 512,
            already_current: false,
            export_status: "complete",
            export_written: 2,
            export_unchanged: 5,
            export_skipped_owner_files: 1,
        };
        let mut output = Vec::new();
        write_result(&mut output, &value).expect("write result frame");
        let frame: serde_json::Value = serde_json::from_slice(&output).expect("valid JSON result");
        assert_eq!(frame["type"], "result");
        assert_eq!(frame["exportStatus"], "complete");
        assert_eq!(frame["exportWritten"], 2);
        assert_eq!(frame["exportUnchanged"], 5);
        assert_eq!(frame["exportSkippedOwnerFiles"], 1);
        assert_eq!(frame.as_object().expect("object").len(), 13);
    }
}
