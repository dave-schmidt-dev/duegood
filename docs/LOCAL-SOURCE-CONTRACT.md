# Local coursework source contract

This contract was derived by attended, read-only structural inspection of the
owner's existing local tracker. Private values, paths, schedules, grades,
messages, feed URLs, and full responses were excluded. The public fixture is
hand-authored synthetic data.

## Document shape

The document is one JSON object with these established top-level fields:
`schema`, `generated`, `source`, `timezone`, `term`, `sync`, `courses`, `items`,
and `archivedForecastItems`. Courses and items are arrays. Unknown fields may
appear at every level and must survive a read-modify-write unchanged.

A course uses `key` as its stable local identity and may contain `code`,
`title`, `color`, `folder`, `instructor`, `meets`, `canvas`, `canvasCourseId`,
`weights`, `flags`, and `ignoredCanvasAssignmentIds`.

An item uses string `id` as its stable identity and may contain `course`,
`kind`, `title`, `at`, `points`, `source`, `confidence`, `flags`, `detail`,
`url`, `canvasId`, `submissionStatus`, `grade`, `score`, `submittedAt`,
`gradedAt`, `done`, `doneAt`, and `keepTitle`. A Canvas refresh matches imported
items by course key plus `canvasId`; it must preserve `done` and `doneAt`.
Canvas submission state and personal completion remain separate.

The adapter must preserve array order, nulls, and unknown fields. It must reject
missing or duplicate item IDs rather than guessing identity.

## Writers and concurrency

The completion endpoint and refresh process are independent writers, so every
authoritative write is serialized by one recoverable adjacent lock directory
owned by the local `CourseworkStore`. The lock records its owning PID and token;
an owner that has exited (including SIGKILL) can be recovered without manual
cleanup. Both paths replace the document atomically and use exact-byte SHA-256
version checks where a whole-document conflict is meaningful. Discussion
checklist mutations are field-specific and merge against the current document,
so a stale tab changing the post mark cannot overwrite the replies mark (or
vice versa). The local server passes the full refresh capture, recovery, child
execution, and history-write operation through that same lock boundary. The
external refresh child remains the existing source writer and must only be
launched by that supervisor boundary; it is never an independent endpoint.

The approved local profile import writes `canvas-profile.json` and
`canvas-profile-avatar` beside the coursework document with mode `600`. The
profile endpoint is fixed to the current authenticated Canvas user. Avatar
downloads carry no Authorization header, accept only documented Canvas/Gravatar
HTTPS hosts and image signatures, and are bounded to 5 MB. The loopback server
revalidates the local metadata and image before exposing the fixed
`/api/local/profile/avatar` path.

The current server already limits itself to loopback and checks Host and Origin.
The replacement additionally requires an externally supplied loopback port,
strict injected Host matching, `Sec-Fetch-Site` enforcement, and a launch-scoped
CSRF token for mutations. No personal path or port is stored in this repository.

## Component disposition

| Legacy component | Cutover disposition |
| --- | --- |
| Launcher | Rollback only until owner acceptance, then replaced by the Due Good launcher |
| Static HTML, CSS, and JavaScript | Retired as the served interface; the redacted public reference remains test evidence |
| Python HTTP server | Retired after accepted cutover; rollback only |
| Canvas reconciliation process | Supervised child only, with staged output and no authoritative direct write |
| Standalone refresh entry points | Retired during cutover |
| Per-course derivative writes | Disabled or staged under the same supervisor before cutover |

## Verified boundary

Read-only legacy verification passed 15 Python tests. The JavaScript suite passed
42 tests and had one stale calendar-count expectation; this is recorded as
legacy test debt, not evidence against the structural contract. The replacement
does not depend on that count.

The redacted preflight receipt records pass/fail booleans only. The synthetic
fixture is the sole private-contract input allowed in executor prompts, source,
tests, and commits.
