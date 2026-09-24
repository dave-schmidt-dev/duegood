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

## Source-neutral acquisition (Task 1.1)

This extension is synthetic and local-only; it describes neither a live iCal feed
nor an institution endpoint. An item `id` remains the immutable local identity.
A `sourceReferences` entry scopes a source ID by institution, local course key,
source kind (`canvas` or `ical`), and optional instance. One scoped reference
cannot belong to two active or archived items.

Legacy records with `canvasId` gain a deterministic Canvas reference during an
acquisition operation without changing their local ID, completion, notes,
discussion state, unknown fields, or `canvasId`. An iCal observation never adds
or changes `canvasId`. A source observation supplies an immutable local ID, an
exact course match, a primary scoped reference, optional verified aliases, and
source-owned JSON fields. Each declared source-owned field records a selected
`{ owner, value }` and bounded alternative source facts. Verified Canvas facts
take display priority over iCal facts while both remain available; manual and
PDF display choices belong to the later grade task. Unknown item extensions,
identity, course, local progress, notes, display provenance, and Canvas identity
are not source-writable. Source references may identify future manual and PDF
observations. Manual and PDF reference kinds are representable without a fake
Canvas/iCal identity, but the Task 1.1 merger refuses them until the later
grade policy defines storage and display precedence. An optional source-provided
`observedAt` changes only with its fact; no timestamp is invented during backfill
or a repeat import.

Only an exact local ID or verified scoped reference matches automatically.
Possible cross-source candidates are bounded `pendingSourceLinks` for later
review, never title/date/kind guesses. A no-op operation retains exact document
bytes. Activity snapshots exclude reference and ownership bookkeeping, so a
backfill alone makes no Activity entry.

`test/fixtures/ical-acquisition-contract.json` covers backfill,
iCal-without-Canvas-identity, duplicate-reference refusal, ambiguous holds,
repeat-byte identity, and local mutation preservation. It does not prove live
feed parsing, course mapping, Canvas API identity, OAuth, or native cutover.

## Synthetic transition and legacy rollback rehearsal (Task 4.2)

The Task 4.2 fixture rehearses an iCal parent whose feed UID changes, separate discussion-post
and discussion-reply checkpoints, a newly introduced course, an ambiguous candidate held for
review, and a partial feed. The rehearsal then adopts the parent through a verified synthetic API
reference and repeats that input. It asserts immutable local identity, Done and discussion state,
notes, unknown fields, manual/PDF grade observations, provenance, no duplicate parent, no feed
deletion, and Activity's zero-removal result. A complete native API capture retains its separate
Canvas-only archival rule; it is not inferred from a rolling calendar omission.

The native legacy-layout export is deliberately fail-closed for any document containing source
references, field observations, pending links, or manual/PDF grade observations. The repository
has no compatibility approval switch: until an owner-side check against the private Python
reconciler proves those fields survive a refresh, a refreshable enriched export is refused before
it creates an output folder. The permitted rollback route is a write-frozen exact export after
demotion, followed by content-free equality checks on a disposable restore copy.

This is synthetic transition evidence only. Live-feed acceptance still needs the separate
`owner:ical-feed-shape` check; PDF acceptance still needs an owner-reviewed real layout; and
native cutover still needs the attended compatibility, installed-app, broker, and cutover-verifier
boundaries in `docs/DESKTOP-CUTOVER.md`.

## Native Canvas reconciliation and refresh rebase (Task 2.1)

The native reconciler uses the same immutable local item ID and scoped-reference rule. A Canvas
assignment may adopt an iCal item only when the same course has a legacy `canvasId`, a scoped
Canvas reference, or the iCal parser's exact verified `assignment:<Canvas assignment ID>` alias.
It retains the item's ID, completion, notes, unknown extensions, iCal reference, and Canvas
reference; multiple candidates fail the capture. Title, date, kind, and URL similarity are never
link evidence. Complete API captures still archive missing verified Canvas items and honor ignored
Canvas IDs, while a rolling iCal omission never archives an iCal item.

For a linked due date, the API fact stores the final capture timestamp in `observedAt`, allowing a
fresh Canvas fact to replace an older iCal fact while retaining the iCal value as an alternative.
An unchanged repeat retains the original fact timestamp and exact document bytes. Native publish
reuses only built-in progress fields and explicitly declared `localOwnedFields` under its publish
lock (a declaration cannot name identity, provenance, or source-owned fields); any concurrent
unknown or source-owned field change fails closed. Activity keys source items
by immutable local ID and reports only visible source facts, excluding local progress, references,
provenance bookkeeping, and unknown extensions.
