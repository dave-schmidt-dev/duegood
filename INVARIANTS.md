# Invariants — Due Good

> System contract for the owner-operated local Marymount coursework dashboard.
> `area:` paths map HISTORY entries to their governing invariant.
> `area:` uses a JSON path array; `gate_test:` is a comma-separated command/path list;
> `threshold:` is the recurrence threshold for invariant triage, not a test count.

## Standing invariant

### INV-1 — Refresh work reports progress and its outcome
area: ["scripts/local-server.mjs", "src/local/refresh-supervisor.ts", "src/ui/pages/dashboard.ts", "src/ui/app.ts", "src/ui/transport.ts", "src-tauri/src/commands.rs", "src-tauri/src/refresh.rs", "src-tauri/src/snapshots.rs"]
gate_test: test/local/refresh-supervisor.test.ts, test/local/refresh-helper.test.ts, test/local/local-server.test.ts, test/ui/dashboard.test.ts, test/browser/local-dashboard.spec.ts, src-tauri/src/commands.rs, src-tauri/src/refresh.rs, src-tauri/src/snapshots.rs
threshold: 3
rationale: Refresh supervision supplies content-free bounded progress to its caller and terminates timed-out child process groups. The local dashboard presents loading, failure, partial, and recovery states rather than silently representing unfinished work as success. Native refresh, daily snapshots, and clipboard copies report progress while their local work runs.

## Project-specific invariants

### INV-2 — Private owner data stays local; credentials stay out of client, logs, and Git
area: ["scripts/check_package.py", "scripts/sync-canvas-conversations.mjs", "scripts/sync-canvas-profile.mjs", "src/local/coursework-store.ts", "src/canvas/conversation-sync.ts", "src/canvas/profile-sync.ts", "scripts/stage-tauri-candidate.mjs", "scripts/check-desktop-status.mjs", "src-tauri/src/config.rs", "src-tauri/src/import.rs", "src-tauri/src/documents.rs", "src-tauri/src/commands.rs", "src-tauri/src/resources.rs", "src-tauri/src/snapshots.rs", "src-tauri/src/export.rs", "src-tauri/src/canvas.rs", "src-tauri/src/downloads.rs", "src-tauri/src/capture.rs", "src-tauri/src/refresh.rs", "src-tauri/tauri.conf.json", "src-tauri/capabilities/default.json", "src/ui/transport.ts"]
gate_test: scripts/check_package.py, test/local/refresh-helper.test.ts, test/local/coursework-store.test.ts, test/local/canvas-conversation-entrypoint.test.ts, test/local/canvas-profile-entrypoint.test.ts, test/local/stage-tauri-candidate.test.ts, test/local/desktop-status.test.ts, test/local/tauri-export.test.ts, npm run test:tauri, test/ui/dashboard.test.ts
threshold: 1
always_active: true
rationale: Private owner coursework, grades, messages, schedules, and cached profile data remain in the local store and are excluded from Git and external-model inputs. Credentials never reach the browser client, logs, or Git. The desktop app keeps its copy in the fixed application-data folder for its bundle identifier (files `0600`, directories `0700`); the webview never supplies a path, read commands use fixed names and bounded sizes, and progress events carry counts only. Native resource actions accept projection IDs only; exports require an owner-selected local folder. The native refresh helper reads from the fixed Canvas origin and validated download hosts with a broker-injected credential. It does not send local coursework to Canvas or any other network service.

### INV-3 — Canvas reads do not overwrite local progress
area: ["src/import/course-import.ts", "src/import/snapshot-commit.ts", "src/local/coursework-store.ts", "src/planning/completion.ts", "src-tauri/src/import.rs", "src-tauri/src/store.rs", "src-tauri/src/commands.rs", "src-tauri/src/reconcile.rs", "src/shared/dashboard-projection.ts"]
gate_test: test/worker/course-import.test.ts, test/worker/personal-completion-phase1.test.ts, test/worker/submission-state.test.ts, test/local/coursework-store.test.ts, test/local/refresh-helper.test.ts, src-tauri/src/reconcile.rs, test/local/tauri-documents.test.ts, test/ui/dashboard.test.ts
threshold: 3
rationale: Imported Canvas facts, Canvas submission state, and local completion are distinct. A Canvas import is read-only toward Canvas and does not overwrite the student's local completion or discussion-progress fields, including edits made while refresh is running. Native completion and discussion post/reply controls update only the owner's local app store, using the prior value as a conflict check; they do not change Canvas submission state. The desktop legacy import copies the legacy root byte-for-byte, including local completion, discussion progress, and unknown fields, and the shared projection renders them exactly as the browser server does.

### INV-4 — Incomplete syncs retain existing records and never claim full success
area: ["src/import/course-import.ts", "src/import/snapshot-commit.ts", "src/canvas/conversation-sync.ts", "src/canvas/conversations.ts", "src/local/refresh-history.ts", "src-tauri/src/refresh.rs", "src-tauri/src/history.rs"]
gate_test: test/worker/import-delete-fence.test.ts, test/worker/pagination-failure.test.ts, test/worker/course-import.test.ts, test/worker/canvas-conversation-sync.test.ts, test/local/refresh-history.test.ts, test/local/refresh-helper.test.ts, src-tauri/src/refresh.rs
threshold: 3
rationale: An incomplete sync may retain safe partial additions, but cannot delete retained records or claim full success. Native refresh stages the complete capture and commits it as one validated transaction; failed, unsafe, fenced, timed-out, or bounded captures preserve the prior committed data. Refresh history and the dashboard identify incomplete results.

### INV-5 — Local browser mutations are loopback- and CSRF-protected
area: ["scripts/local-server.mjs", "src/ui/csrf.ts", "src/ui/pages/dashboard.ts"]
gate_test: test/local/local-server.test.ts, test/ui/dashboard.test.ts, test/browser/local-dashboard.spec.ts
threshold: 1
rationale: The local server validates loopback Host and Origin context, bounds request and static-file handling, and requires launch-scoped CSRF protection for local progress mutations.

### INV-6 — Private local writes are durable and preserve unmanaged data
area: ["src/local/coursework-store.ts", "src/local/refresh-history.ts", "src/canvas/profile-sync.ts", "src-tauri/src/store.rs", "src-tauri/src/locking.rs", "src-tauri/src/import.rs", "src-tauri/src/snapshots.rs", "src-tauri/src/export.rs"]
gate_test: test/local/coursework-store.test.ts, test/local/refresh-history.test.ts, test/local/canvas-profile-entrypoint.test.ts, test/local/tauri-export.test.ts, src-tauri/src/store.rs, src-tauri/src/locking.rs, src-tauri/src/import.rs, src-tauri/src/snapshots.rs, src-tauri/src/export.rs
threshold: 3
rationale: Coursework writes use an exact-source precondition, an advisory lock, and atomic replacement. The local store preserves unknown fields; private refresh/profile outputs are written through their bounded local storage paths. The desktop store detects change by exact-byte SHA-256, writes by temp file, fsync, rename, and directory fsync, and preserves unknown fields. Its legacy import holds the legacy `${file}.duegood-lock` for the whole copy, requires identical source digests before and after, never mutates the source, and stages and validates before adopting atomically. Desktop daily snapshots remain in the private app data root and restore archives the current store before replacement. Legacy export copies the coursework layout to a new owner-selected folder while excluding desktop-only manifest and recovery metadata.

### INV-7 — Public Worker activation and OAuth remain deferred
area: ["wrangler.jsonc", "src/config.ts", "docs/IMPLEMENTATION-PLAN.md", "docs/IMPLEMENTATION-STATUS.md"]
gate_test: test/worker/config-template.test.ts, scripts/check-implementation-status.mjs
threshold: 1
always_active: true
rationale: The production D1 database is provisioned and remains bound in configuration. The public Worker route is offline because `workers_dev` is false; public reactivation and institution OAuth remain deferred pending their separate owner/admin gates. Repository tests remain synthetic and do not establish public cloud readiness.

### INV-8 — The desktop app store has a single writer
area: ["src-tauri/src/locking.rs", "src-tauri/src/store.rs", "src-tauri/src/commands.rs", "src-tauri/src/refresh.rs"]
gate_test: npm run test:tauri, test/local/refresh-helper.test.ts, src-tauri/src/locking.rs, src-tauri/src/store.rs, src-tauri/src/commands.rs, src-tauri/src/refresh.rs
threshold: 1
always_active: true
rationale: One app instance owns the store through an exclusive OS lock; a second app instance is denied. The refresh helper uses a separate single-refresh lease and joins the short operation-level store lock. Every store write takes that short OS `flock`; OS locks release when the holder exits or crashes.

### INV-9 — A preview store never refreshes
area: ["src-tauri/src/commands.rs", "src-tauri/capabilities/default.json", "src/ui/transport.ts", "src/ui/app.ts", "src/ui/pages/dashboard.ts"]
gate_test: src-tauri/src/commands.rs, src-tauri/src/config.rs, test/ui/dashboard.test.ts
threshold: 1
always_active: true
rationale: A `preview` store is a local copy of the legacy folder that never refreshes or follows later browser changes. The native refresh command refuses it even when the owner toggle is enabled; `store_status` reports `refreshAvailable: false`, and the desktop dashboard labels the copy as a preview while allowing personal completion and discussion-progress edits in that copy.

### INV-10 — Import never replaces an authoritative store
area: ["src-tauri/src/import.rs", "src-tauri/src/store.rs"]
gate_test: src-tauri/src/import.rs, src-tauri/src/store.rs
threshold: 1
always_active: true
rationale: Import refuses when the store is `authoritative`. Replacing a `preview` store first archives it into a timestamped backup that is never deleted, and an interrupted replacement is rolled back on the next open.

### INV-11 — Installed desktop bytes match the tested candidate
area: ["scripts/build-tauri.mjs", "scripts/verify-tauri-assets.mjs", "scripts/install-desktop-app.mjs", "scripts/smoke-tauri-macos.mjs", "scripts/check-production-launch.mjs", "src-tauri/tauri.conf.json", "src-tauri/build.rs"]
gate_test: test/local/verify-tauri-assets.test.ts, test/local/install-desktop-app.test.ts, npm run test:tauri, npm run test:tauri:macos, npm run check:production-launch
threshold: 1
always_active: true
rationale: The app and fixed helper are built in a private staged candidate, not the checkout serving the browser app. The released bundle is Developer ID signed after its source revision, candidate tree, and frontend hash manifest are embedded; both executables lack the test override feature. Installation verifies those exact signed bytes and bundle identity. Native UI tests use a separate test identifier and never import into the production store.

### INV-12 — A store changes authority only through the guarded owner flow
area: ["src-tauri/src/commands.rs", "src-tauri/src/store.rs", "src-tauri/src/export.rs", "src-tauri/capabilities/default.json", "src/ui/app.ts", "src/ui/transport.ts", "src/ui/pages/dashboard.ts"]
gate_test: npm run test:tauri, test/ui/dashboard.test.ts, test/browser/desktop-first-run.spec.ts
threshold: 1
always_active: true
rationale: Promotion requires a Rust-selected frozen backup whose complete portable layout equals the preview store byte-for-byte, an in-memory one-use proof, native owner confirmation, and a repeat comparison under the import, refresh, lease, and write guards. Demotion retains a verified private recovery copy, disables refresh, and returns the store to preview before a write-frozen, equality-checked rollback export. The webview cannot supply a filesystem path or confirmation flag.

### INV-13 — Source identity never replaces local identity or progress
area: ["src/local/acquisition.ts", "src/local/coursework-store.ts", "src/local/refresh-history.ts"]
gate_test: test/local/acquisition.test.ts, test/local/coursework-store.test.ts, test/local/refresh-history.test.ts, test/local/tauri-export.test.ts
threshold: 1
always_active: true
rationale: Source facts are scoped references and field-owned observations. Existing local IDs, completion, notes, discussion state, Canvas identity, and unknown fields survive source backfill and observation updates. Duplicate references fail closed; unverified cross-source candidates are held rather than guessed; and provenance-only changes do not create Activity history.
