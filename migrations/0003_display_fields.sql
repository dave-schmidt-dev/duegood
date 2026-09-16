-- Adds the structured display fields the This Week page renders (Task 1.5): title, resolved due
-- date, and Canvas's own submission state. `source_items` previously stored only an opaque
-- `fingerprint` for change detection (src/import/course-import.ts's fingerprintOf) — never
-- intended as a display-data source — so nothing here changes what the fingerprint means or
-- contains; these columns are populated alongside it, not derived from it.
--
-- `due_at`/`due_at_state` mirror src/import/normalize.ts's `SourceField` four-state contract
-- (known / known_null / not_returned / unsupported) rather than collapsing to one nullable
-- column: a due date Canvas explicitly reports as absent ("No Deadline") must never be confused
-- with a due date this app simply doesn't know yet. `submission_state` is a derived, already-
-- interpreted enum (src/canvas/submission.ts) rather than a raw SourceField mirror, since it comes
-- from mapping Canvas's `workflow_state` values, not a direct field passthrough.
ALTER TABLE source_items ADD COLUMN title TEXT;
ALTER TABLE source_items ADD COLUMN due_at TEXT;
ALTER TABLE source_items ADD COLUMN due_at_state TEXT NOT NULL DEFAULT 'not_returned'
  CHECK (due_at_state IN ('known', 'known_null', 'not_returned', 'unsupported'));
ALTER TABLE source_items ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK (submission_state IN ('known_submitted', 'known_not_submitted', 'unknown', 'unsupported'));
