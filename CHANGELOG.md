# Changelog

## [Unreleased]

### Added

- Reuse unchanged files from the prior validated Canvas capture archive generation during refresh, copying hash-verified prior blobs into fresh staging instead of re-downloading; any miss, change, conflict, or unsafe archive falls back to a fresh download.

### Fixed

- Keep timeline class-name headers visible while scrolling, align them with date and marker columns, and continue painted course dividers through the header and body.
- Move Recovery and Export into More; display date-only assignment and discussion times at 11:59 p.m. in the owner's default timezone without changing Canvas timestamps or assigning a clock to class meetings whose time is unknown.
- Repair calendar-bootstrap course names and codes from validated capture metadata during import without redownloading files.

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
