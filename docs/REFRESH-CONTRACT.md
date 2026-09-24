# Refresh contract (Task 1.1)

This document is a public, synthetic specification of what a Canvas refresh does today,
captured before designing the Tauri `duegood-refresh` Rust helper (Decision 7 of the desktop
plan). It was built by reading source code only — the private importer, the private wrapper,
the private reconciliation script, the broker, and this repo's own local-runtime code — never
by running the refresh, inspecting real coursework data, or listing files in the legacy course
root. No private path, host username, course name/ID, institution identifier, token, or real
value appears anywhere below. Generic terms are used throughout: "the private wrapper", "the
private importer", "the reconciliation script" (the task's "CLI shim"), "the legacy course
root", and `https://canvas.example.invalid` for the Canvas origin.

Every row below is a plain claim with a **Status**:

- `confirmed` — read directly in source and traced end to end.
- `unknown` — code alone cannot resolve it; the task rules forbid checking by other means
  (running the refresh, listing/opening the legacy course root, opening logs or `.env*`).
- `intentionally changed` — today's behavior is real, but the desktop plan (Decision 7) already
  commits to changing it; a reason and the plan citation are given inline.

## Course import

Today's refresh is driven entirely by the private wrapper. It is invoked with no arguments
(default/full mode) via the broker (see Broker section) and runs the private importer against
a hardcoded, small table of course entries baked into the wrapper's own source — there is no
course-discovery API call and no config file read at refresh time.

| # | Contract row | Status |
|---|---|---|
| 1 | The wrapper iterates a fixed, hardcoded list of course entries (origin, numeric Canvas course ID, and local folder name), compiled into the wrapper's own source rather than read from a config file or discovered via a Canvas "list my courses" call. | confirmed |
| 2 | Each course's Canvas course ID is used directly to build `GET {origin}/api/v1/courses/{id}` and its sub-resource paths (see next section); there is no separate "resolve course by code" step. | confirmed |
| 3 | Courses are processed **sequentially**, one at a time, not in parallel. | confirmed |
| 4 | Each course import is spawned as its own child process with roughly a 6-minute timeout; a timeout is treated as that course's failure. | confirmed |
| 5 | The wrapper verifies the course ID embedded in the importer's captured `course.json` output matches the course ID it requested, before treating that course's capture as usable. | confirmed |
| 6 | If any single course's import fails (non-zero exit, timeout, or ID-mismatch check), the wrapper aborts the **entire** refresh immediately (`process.exit(1)` from a top-level rejection handler) without attempting the remaining courses. | confirmed |
| 7 | The reconciliation script (`--apply` over the freshly captured per-course exports) is only invoked after **every** course in the fixed list has imported successfully — there is no partial-course reconciliation. | confirmed |
| 8 | Course entries are hardcoded per-institution (one Canvas origin, one small fixed course table) rather than derived from an authenticated "my courses" listing or a user-editable list. | intentionally changed — Decision 7 has the new helper derive its course/store scope without hardcoded per-course tables baked into a wrapper; course selection becomes data the helper reads, not code compiled into it. |
| 9 | Whether the fixed course table can ever include more or fewer than three courses in the live legacy configuration, or how a real course gets added to it. | unknown — resolving this would require reading the live legacy root's actual (non-synthetic) course table, which the task rules forbid. |

## canvas-export and materials

The private importer calls the Canvas REST API directly with a bearer token and writes one
`canvas-export/` directory per course plus a shared/per-course download manifest. Field mapping
into the local coursework model is performed by the reconciliation script, not the importer.

| # | Contract row | Status |
|---|---|---|
| 10 | Every Canvas call uses a bearer `Authorization` header built from the token the broker/keychain supplies to the importer process; the importer never persists the token to disk. | confirmed |
| 11 | Endpoints called per course: `GET /api/v1/courses/{id}`, `.../tabs`, `.../pages`, `.../modules` (with `include[]=items`), `.../assignment_groups`, `.../assignments` (with `include[]=submission`), `.../discussion_topics`, `/api/v1/announcements` (context-scoped), `.../files`, `.../folders`. | confirmed |
| 12 | Allowed path prefix for these calls: none beyond "on the configured Canvas origin" — the importer does not restrict requests to an `/api/v1/courses` (or any other) path prefix; it will call whatever path it is given, including the initial per-endpoint URL and any pagination `next` link, as long as the origin matches. | confirmed |
| 13 | Pagination: the importer follows the RFC 5988 `Link` response header's `rel="next"` URL, one page at a time, until no `next` relation is present, up to a **100-page cap** per endpoint (after which it stops and keeps what it has). | confirmed |
| 14 | Pagination `next`-link validation: only the origin is checked against the configured Canvas origin before the link is followed; there is no path-prefix allowlist check on the `next` link (same gap as row 12). | confirmed |
| 15 | `per_page` and `include[]` query parameters are set on the *initial* request per endpoint; the `next` link from the `Link` header is followed as returned by Canvas (its own query string), not rebuilt by the importer. | confirmed |
| 16 | File downloads: the importer allowlists specific download **hosts** (the configured Canvas origin plus Canvas's known file-storage/CDN host pattern) before issuing a file download request. | confirmed |
| 17 | File downloads use `redirect: "follow"` (the underlying fetch follows redirects automatically); the importer does not manually validate the destination host of an intermediate redirect hop, only the *initial* request's host. | confirmed |
| 18 | File downloads are capped: at most 100 files per course per run, plus per-request timeout (60s) and retry (2 attempts) budgets. | confirmed |
| 19 | Materials are written under a per-course `materials/`-style local layout with filenames derived from the numeric Canvas file ID plus the filename Canvas reports at download time (`Content-Disposition`), not the original `display_name` field verbatim. | confirmed |
| 20 | A `download-manifest.json`-equivalent record is written per course listing each file's Canvas file ID, the derived local filename, reported size/`updated_at`, and a status of `downloaded`, `reused` (fingerprint match against the prior manifest: ID + filename + size + `updated_at`, plus the local copy existing at the expected size), a bare HTTP status number on download failure, or `missing-download-url` when Canvas reports no download URL for that file. | confirmed |
| 21 | Any URL persisted into `canvas-export/*.json` (including file `url` fields and the per-endpoint request-manifest entries) has its query string stripped before being written — verifier tokens and other query params used for the live request never land in the on-disk export. | confirmed |
| 22 | Known/likely-sensitive substrings (a `token=`-shaped pattern) are redacted from captured text fields (e.g. `syllabus_body`, message bodies) before any `canvas-export/*.json` file is written. | confirmed |
| 23 | Each Canvas API response object is reduced to a fixed allowlisted subset of fields before being written (e.g. assignment submissions are narrowed to workflow state, timestamps, grade, score, excused/missing/late flags) — raw upstream response bodies are never written verbatim. | confirmed |
| 24 | Per-course write set: `canvas-export/api/{course,tabs,pages,modules,assignment_groups,assignments,discussions,announcements,files,folders}.json`, `canvas-export/download-manifest.json`, `canvas-export/request-manifest.json`, a combined `canvas-export/course-inventory.json`, one or more downloaded material files, and a generated `canvas-course-report.md` summary — all under that course's local folder. | confirmed |
| 25 | Within one course's `canvas-export/`, the importer stages every file in a temporary location first and performs a **best-effort atomic install** (temp write + rename per file) with a rollback path if any file in the batch fails to install; it is not a single all-or-nothing directory swap. | confirmed |
| 26 | The reconciliation script maps each captured `assignments.json` entry into a local coursework item keyed by **Canvas assignment ID** (never by title); title, due date, points, submission/grade state, and assignment-group name/weight are the tracked fields. | confirmed |
| 27 | `kind` (paper / assignment / discussion / quiz / exam / lab / session / milestone / reading, etc.) is inferred by the reconciliation script from the assignment's name and `submission_types` via a fixed keyword/heuristic order, falling back to a generic `assignment` kind when nothing matches. | confirmed |
| 28 | Due-date conversion from Canvas's UTC `due_at` to the locally displayed date/time is a wall-clock conversion into `America/New_York`, sensitive to DST — the same UTC instant renders as a different local clock time depending on the time of year. | confirmed |
| 29 | A course can list specific Canvas assignment IDs to **ignore**; ignored IDs are skipped before any NEW/CHANGED/etc. finding is produced for them, and they never appear in `coursework.json`. | confirmed |
| 30 | Reconciliation never modifies a retained item's own `done`/`doneAt` completion fields — those are student-owned local state, untouched regardless of what Canvas reports. | confirmed |
| 31 | An item that is Canvas-sourced (has a `canvasId`) but Canvas no longer reports as live is not hard-deleted; it is moved out of the active items list into an archive/forecast list, preserving its content. | confirmed |
| 32 | `coursework.json` is rewritten via an atomic replace, and only when at least one change was actually found (`applied > 0`); a no-op reconciliation run leaves the file's mtime and `lastSync` untouched. | confirmed |
| 33 | The generated per-course `coursework.md` summary is written **unconditionally** on every `--apply` run, via a direct overwrite with no temp file and no rename — the one non-atomic write in the whole chain. | confirmed |
| 34 | Whether the origin-only file-download host allowlist (row 16) and the origin-only pagination check (row 14) are later tightened, following the plan's Worker-side pattern that also validates an explicit `/api/v1/courses` path prefix on both the initial request and every followed `next` link. | intentionally changed — Decision 7 directs the new helper toward the stricter origin+path-prefix validation and (for downloads) credentialed/host-scoped redirect handling already used by this repo's dormant Worker Canvas client, instead of today's origin-only checks and unauthenticated `redirect:"follow"`. |
| 35 | Whether course exports are committed to the local store one course at a time as each finishes, or staged for all courses and committed together at the end. | intentionally changed — Decision 7 moves from today's confirmed per-course/per-file best-effort install (row 25) to a stage-everything-then-commit-together model with a single content-addressed-storage-style commit point, rather than incremental per-course partial commits. |
| 36 | Exact byte-for-byte schema (key names/ordering) of `canvas-export/course-inventory.json` and `canvas-course-report.md` beyond the fields enumerated above. | unknown — confirmed structurally from code, but full key enumeration was not exhaustively traced for every optional field; treated as unknown rather than guessed. |

## Inbox

A separate public CLI shim (`sync-canvas-conversations.mjs` in this repo) captures Canvas
Inbox conversations; the private wrapper invokes it as one stage of the full refresh, after all
course imports succeed.

| # | Contract row | Status |
|---|---|---|
| 37 | The Inbox sync hardcodes its Canvas origin in its own source rather than accepting it as a parameter. | confirmed |
| 38 | Each single-conversation detail GET includes `auto_mark_as_read=false`, so loading a thread's messages does not mark it read on Canvas; the list-conversations GET does not send this parameter. | confirmed |
| 39 | `nextLink()` pagination validates **both** origin and an allowed path prefix before following a `Link: rel="next"` URL; a next-link that fails either check is rejected (throws) rather than silently skipped. | confirmed |
| 40 | The top-level conversation-list fetch is not wrapped in a try/catch; a failure there aborts the whole Inbox sync with no partial output. | confirmed |
| 41 | Fetching each conversation's full message detail (after the list call) **is** wrapped per-thread; one thread's detail-fetch failure does not abort the others, and the sync can complete with some threads represented only by their list-level summary. | confirmed |
| 42 | Message bodies are sanitized before being written: HTML tags are stripped outright (not escaped), and known credential-shaped substrings (e.g. `access_token=...`) are redacted. | confirmed |
| 43 | Output includes per-conversation participants, latest-message preview, unread/starred flags, message count, full per-message bodies (post-sanitization) with attachment metadata (name/content-type/size, not attachment bytes), and a `changes` block of added/changed/removed conversation IDs relative to the previous capture. | confirmed |
| 44 | `latestMessageAt` in the output reflects the newest message actually captured for that thread, not Canvas's own list-level `last_message_at` summary field. | confirmed |
| 45 | The write target is supplied by the wrapper via a CLI flag (or an environment variable fallback) rather than being hardcoded inside the Inbox shim itself; the write itself is an atomic temp-file+rename. | confirmed |
| 46 | The exact on-disk filename the private wrapper passes as that write target in the live legacy layout, versus the filename this repo's dashboard code (`dashboard-store.ts` and its related resources/refreshes/conversations readers) actually reads. Source review found these referring to two different literal names; which one is authoritative for the live refresh path could not be resolved without reading the private wrapper's argument or the legacy root's actual file listing, both out of scope for this task. | unknown — flagged as a real filename-mismatch risk for the helper design; the expected-store fixture in this task picks the name the dashboard code consumes and notes the discrepancy rather than silently resolving it. |

## Profile

A second public CLI shim (`sync-canvas-profile.mjs`) captures the student's own Canvas profile
and avatar; the wrapper invokes it last, after Inbox sync, still only on a fully successful
run.

| # | Contract row | Status |
|---|---|---|
| 47 | The Profile sync fetches the authenticated user's own profile via the Canvas API using the same bearer token as the course import. | confirmed |
| 48 | Avatar image download is a **separate, unauthenticated** request (no bearer token sent) to the URL Canvas's profile response supplies. | confirmed |
| 49 | The avatar request validates its host against an allowlist and caps redirect-following at 3 hops; it does not use unrestricted `redirect:"follow"` the way the course-file downloader does. | confirmed |
| 50 | Downloaded avatar bytes are verified by magic-byte/content-type sniffing before being trusted as an image, not by trusting the declared `Content-Type` header alone. | confirmed |
| 51 | Profile JSON and the avatar file are committed together as a staged multi-file write with a backup-and-rollback path if either write fails partway. | confirmed |
| 52 | The avatar file is written with restrictive permissions (mode `0600`), not the default file-creation mode. | confirmed |
| 53 | Both the profile JSON path and the avatar output path are supplied to the shim via CLI flags from the wrapper, not hardcoded in the shim. | confirmed |

## Broker

The private wrapper is not run directly by the orchestration layer; it is invoked through the
BWS fixed-consumer broker (`bws-secret-exec <consumer> -- ...`), which resolves a named
consumer entry, verifies the target executable, and injects the Canvas API token into that
child process's environment.

| # | Contract row | Status |
|---|---|---|
| 54 | **Digest-pin semantics**: the broker's consumer table pins the private wrapper's executable to a specific SHA-256 content digest recorded in the broker's own consumer registry. Before executing, the broker reads the target file's actual bytes, computes SHA-256, and compares it to the pinned digest (and checks the file is a regular, mode-`0755` executable at the expected path); a mismatch aborts before any secret is touched. This is content pinning, not merely path pinning — replacing the file's bytes without updating the broker's registry entry breaks the pin and blocks execution. | confirmed |
| 55 | **Stdout passthrough**: the broker execs the pinned target via `os.execve()`, replacing the broker process image in place rather than spawning-and-relaying through Python. Because `execve()` preserves inherited file descriptors, the target process's stdout/stderr are the *same* stream file descriptors the broker's own caller already holds — there is no line-buffering, no chunking, and no Python-side relay/copy step in between. Output streams through as if the caller had invoked the target directly. | confirmed |
| 56 | **Non-secret consumer-existence check**: there is no separate subcommand or flag to ask "does consumer X exist / is it executable / is its pin valid" without touching secret material. `execute_consumer()` (the one path that does the pin/permission validation) performs that validation internally as a precondition of the *same* call that also resolves and injects the secret — validation and secret access are not split into two independently callable steps. | confirmed |
| 57 | **Fallback when no non-secret existence check exists**: since row 56 confirms there is no such check, the Rust `duegood-refresh` helper cannot pre-flight "is the consumer callable" independently of a real invocation. The helper's fallback must be to attempt the real broker invocation and treat any broker-side failure (non-zero exit before the child's own output begins, or a broker error message on stderr) as "consumer unavailable/misconfigured," surfaced as a generic operator-facing error — never by parsing broker internals, never by attempting an unpinned direct call to the private executable as a bypass. | confirmed |
| 58 | Only one broker consumer name is involved in today's refresh chain (the one behind the private wrapper); the Inbox and Profile shims are invoked directly by the wrapper as plain child processes after the broker call returns, not as separate broker consumers each. | confirmed |
| 59 | The broker call always requests the wrapper's default/full mode; today's orchestration layer never passes wrapper-level mode flags (`--dry-run`, `--inbox-only`, `--profile-only`) through the broker invocation. | confirmed |
| 60 | Today's wrapper still accepts `--dry-run`/`--inbox-only`/`--profile-only` flags even though nothing in the current orchestration chain passes them. | intentionally changed — Decision 7/11 retire these modes for the new helper; the helper is designed to always run the full sequence with no partial-mode flags, matching what the live orchestration already exercises. |

## Orchestration

The Node local-runtime layer (`local-server.mjs` and its supporting modules) is what actually
calls the broker, and is responsible for locking, history capture, and surfacing failures to
the dashboard.

| # | Contract row | Status |
|---|---|---|
| 61 | A refresh request acquires the store's exclusive lock (a `${file}.duegood-lock` directory-based advisory lock with an `owner.json` of `{pid, token, createdAt}`) before the broker is invoked, and holds it for the **entire** external refresh (broker call through reconciliation), not just for the final local write. | confirmed |
| 62 | Stale-lock recovery: a lock is considered stale and reclaimable if its owning PID fails a `process.kill(pid, 0)` liveness probe, or if the lock directory's mtime exceeds a staleness threshold — whichever check trips first. | confirmed |
| 63 | The broker/wrapper invocation is wrapped with a fixed **180-second** timeout at the orchestration layer, independent of the wrapper's own internal per-course ~6-minute child timeout; the orchestration-level timeout is the one enforced against the *whole* wrapper run. | intentionally changed — noted here because it is a real observed inconsistency in the current code (the per-course budget alone can exceed the orchestration-level ceiling for a multi-course run), which the desktop helper's own timeout model must resolve rather than reproduce; see Decision 7's lease-based model in row 66. | 
| 64 | Merged stdout/stderr from the broker/wrapper invocation is captured up to a 65,536-byte cap for local logging only; it is never relayed verbatim to the dashboard UI — only a generic success/failure status and message are. | confirmed |
| 65 | On any refresh failure (broker error, timeout, reconciliation error), the orchestration layer surfaces a generic failure message to the dashboard; it does not surface raw child-process output or broker internals to the UI. | confirmed |
| 66 | The store lock in today's design is coarse: one lock covers acquiring the external data *and* writing it locally, held by the same process for the whole duration. | intentionally changed — Decision 7 replaces this with a short local write lock plus a separate lease/CAS-style commit step, so a slow external fetch does not hold the store lock for its full duration. |
| 67 | History capture (`captureCanvasSnapshot`/`diffCanvasSnapshots`) only tracks items where `source === "canvas"` **and** `canvasId` is set; manual/session/milestone items and archived-forecast items (row 31) are invisible to the refresh-history diff regardless of what the reconciliation script did to them. | confirmed |
| 68 | Refresh-history events are capped at 100 retained events, written atomically, with a corruption-quarantine path if the history file is unreadable/invalid on load (quarantine the bad file, start a fresh history rather than crash the refresh). | confirmed |
| 69 | A `recoverMissedGradeHistory()`-style pass exists to backfill a grade-change history event when a grade changed between refreshes without an intervening history write (e.g. after a gap in refresh cadence); this does not re-fetch Canvas, it only reconciles locally stored snapshots. | confirmed |
| 70 | An incomplete/aborted refresh (any course failed, broker timeout, or reconciliation error) leaves `coursework.json` **unmodified** from before the run — because the wrapper only invokes the reconciliation script's `--apply` after all course imports succeed (row 7), a failed run never reaches the write-if-changed step at all. Any already-completed course's `canvas-export/` output for that run may still exist on disk (row 25's per-course best-effort install can succeed for earlier courses in the fixed list before a later course fails), but it is orphaned data no reconciliation step has consumed. | confirmed |
| 71 | An incomplete/aborted refresh does not append a "succeeded" refresh-history event (none is written until `runRefresh()`'s wrapping completes without throwing); whether a distinct "failed" history event type is recorded today, versus the failure only surfacing as the generic dashboard message (row 65), was not resolved from source alone. | unknown — the failure/error path in `local-server.mjs` was traced for lock release and dashboard messaging, but not exhaustively for every history-writing branch; recording as unknown rather than asserting either way. |
