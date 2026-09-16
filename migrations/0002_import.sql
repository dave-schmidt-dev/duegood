-- A course an account has connected. `id` is app-generated (a UUID) before insert, like
-- `connections.id`, so `source_items` can reference it. Ownership always flows through
-- `account_id`, matching every other table in this schema.
CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  canvas_course_id TEXT NOT NULL,
  course_code TEXT,
  title TEXT,
  term TEXT,
  -- Bumped exactly once per successful import commit (src/import/snapshot-commit.ts); doubles as
  -- this course's freshness/version marker and as the fencing counter a lease captures at
  -- acquisition time and a commit must present unchanged.
  snapshot_generation INTEGER NOT NULL DEFAULT 0,
  -- An import lease is a single opaque token + expiry inline on the course, not a separate table:
  -- only one import may run per course at a time, and nothing else ever references a lease by id.
  import_lease_token TEXT,
  import_lease_expires_at INTEGER,
  last_successful_check_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, canvas_course_id)
);

CREATE INDEX courses_account_id_idx ON courses (account_id);

-- One normalized Canvas assignment. A row is never deleted on a re-import — a missing-from-
-- inventory item is marked `available = 0` (never removed), so personal state attached to it
-- (added by a later migration slice, once the completion route needs it) survives.
-- `last_seen_generation` records which course `snapshot_generation` last confirmed this row
-- present or absent, so a stale generation can never be mistaken for the current view.
CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  course_id TEXT NOT NULL REFERENCES courses(id),
  canvas_item_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  last_seen_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (course_id, canvas_item_id)
);

CREATE INDEX source_items_course_id_idx ON source_items (course_id);
CREATE INDEX source_items_account_id_idx ON source_items (account_id);
