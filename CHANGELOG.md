# Changelog

## [Unreleased]

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
