# Changelog

## [Unreleased]

### Added

- Reuse unchanged files from the prior validated Canvas capture archive generation during refresh, copying hash-verified prior blobs into fresh staging instead of re-downloading; any miss, change, conflict, or unsafe archive falls back to a fresh download.
- Run the app’s existing **Refresh** action through the packaged fixed browser runtime, reusing the saved Chrome profile and account binding, then attempt calendar refresh independently. Stream content-free progress, keep per-source outcomes distinct, and reload dashboard freshness after partial or failed steps.

### Fixed

- Keep timeline class-name headers visible while scrolling, align them with date and marker columns, and continue painted course dividers through the header and body.
- Move Recovery and Export into More; display date-only assignment and discussion times at 11:59 p.m. in the owner's default timezone without changing Canvas timestamps or assigning a clock to class meetings whose time is unknown.
- Wait up to five minutes for the authenticated Canvas page after the browser broker is ready; report content-free `WAITING` progress during SSO and fail closed on timeout without publishing incomplete Canvas data.
- Repair calendar-bootstrap course names and codes from validated capture metadata during import without redownloading files.
- Save calendar Activity history with the applied calendar changes, including no-change and held-event outcomes; record incomplete Canvas Activity inside the capture generation so same-generation replays do not duplicate it.
- Distinguish added from updated assignment counts, without counting new assignments as updates; retain active courses with no calendar events and refresh course names/codes only from validated Canvas capture data. Calendar deadlines may attach to linked Canvas assignments; the feed does not provide grades, messages, or files.
- Format Activity date-only due dates with the assumed 11:59 p.m. deadline on their stated calendar day and date-only graded dates without invented times, preventing UTC midnight dates from displaying on the previous evening in America/New_York while preserving instant semantics for timestamps with offsets or Z.


## [0.2.0] (release candidate)

### Added

- Import explicitly dated class sessions from captured course syllabi during Canvas refresh, retaining source provenance and personal progress.
- Read bounded weekly DOCX declarations and PDF class-date tables with separate meeting-time and semester-year fields.
- Import reviewed local class dates with owner-supplied times as personal sessions, preserving Canvas provenance and personal progress.

### Fixed

- Request syllabus content when capturing Canvas courses.

## [0.1.1] (release candidate)

### Fixed

- Restore dashboard loading for legacy native stores with canonical decimal-string Canvas course IDs.
- Accept separate child-detail coverage rows in Canvas imports while preserving optional gaps and required coverage uniqueness.
- Keep course and group calendar records separate from account profile and inbox projection during import.
- Preserve legacy field provenance and newer calendar due dates when refreshing coursework.
