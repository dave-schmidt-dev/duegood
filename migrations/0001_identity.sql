-- Institution-scoped identity: an account is the (institution, Canvas user id) pair, not the
-- Canvas user id alone, so the same id at two institutions is never treated as one account.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_origin TEXT NOT NULL,
  canvas_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (institution_origin, canvas_user_id)
);
