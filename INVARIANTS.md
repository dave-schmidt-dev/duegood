# Invariants — Due Good

> System contract for the owner-operated local Marymount coursework dashboard.
> `area:` paths map HISTORY entries to their governing invariant.
> `area:` uses a JSON path array; `gate_test:` is a comma-separated command/path list;
> `threshold:` is the recurrence threshold for invariant triage, not a test count.

## Standing invariant

### INV-1 — Refresh work reports progress and its outcome
area: ["scripts/local-server.mjs", "src/local/refresh-supervisor.ts", "src/ui/pages/dashboard.ts"]
gate_test: test/local/refresh-supervisor.test.ts, test/local/local-server.test.ts, test/ui/dashboard.test.ts, test/browser/local-dashboard.spec.ts
threshold: 3
rationale: Refresh supervision supplies bounded progress to its caller and terminates timed-out child process groups. The local dashboard presents loading, failure, partial, and recovery states rather than silently representing an unfinished refresh as success.

## Project-specific invariants

### INV-2 — Private owner data stays local; credentials stay out of client, logs, and Git
area: ["scripts/check_package.py", "scripts/sync-canvas-conversations.mjs", "scripts/sync-canvas-profile.mjs", "src/local/coursework-store.ts", "src/canvas/conversation-sync.ts", "src/canvas/profile-sync.ts"]
gate_test: scripts/check_package.py, test/local/coursework-store.test.ts, test/local/canvas-conversation-entrypoint.test.ts, test/local/canvas-profile-entrypoint.test.ts
threshold: 1
always_active: true
rationale: Private owner coursework, grades, messages, schedules, and cached profile data may display in the local loopback browser, but remain local and are excluded from Git and external-model inputs. Credentials never reach the browser client, logs, or Git. Private files use the local storage boundary and repository checks reject public-tree leakage.

### INV-3 — Canvas reads do not overwrite local progress
area: ["src/import/course-import.ts", "src/import/snapshot-commit.ts", "src/local/coursework-store.ts", "src/planning/completion.ts"]
gate_test: test/worker/course-import.test.ts, test/worker/personal-completion-phase1.test.ts, test/worker/submission-state.test.ts, test/local/coursework-store.test.ts
threshold: 3
rationale: Imported Canvas facts, Canvas submission state, and local completion are distinct. A Canvas import is read-only toward Canvas and does not overwrite the student's local completion or discussion-progress fields.

### INV-4 — Incomplete syncs retain existing records and never claim full success
area: ["src/import/course-import.ts", "src/import/snapshot-commit.ts", "src/canvas/conversation-sync.ts", "src/canvas/conversations.ts", "src/local/refresh-history.ts"]
gate_test: test/worker/import-delete-fence.test.ts, test/worker/pagination-failure.test.ts, test/worker/course-import.test.ts, test/worker/canvas-conversation-sync.test.ts, test/local/refresh-history.test.ts
threshold: 3
rationale: An incomplete sync may retain safe partial additions, but cannot delete retained records or claim full success. Failed, unsafe, fenced, timed-out, or bounded imports preserve the prior committed data; refresh history and the dashboard identify incomplete results.

### INV-5 — Local browser mutations are loopback- and CSRF-protected
area: ["scripts/local-server.mjs", "src/ui/csrf.ts", "src/ui/pages/dashboard.ts"]
gate_test: test/local/local-server.test.ts, test/ui/dashboard.test.ts, test/browser/local-dashboard.spec.ts
threshold: 1
rationale: The local server validates loopback Host and Origin context, bounds request and static-file handling, and requires launch-scoped CSRF protection for local progress mutations.

### INV-6 — Private local writes are durable and preserve unmanaged data
area: ["src/local/coursework-store.ts", "src/local/refresh-history.ts", "src/canvas/profile-sync.ts"]
gate_test: test/local/coursework-store.test.ts, test/local/refresh-history.test.ts, test/local/canvas-profile-entrypoint.test.ts
threshold: 3
rationale: Coursework writes use an exact-source precondition, an advisory lock, and atomic replacement. The local store preserves unknown fields; private refresh/profile outputs are written through their bounded local storage paths.

### INV-7 — Public Worker activation and OAuth remain deferred
area: ["wrangler.jsonc", "src/config.ts", "docs/IMPLEMENTATION-PLAN.md", "docs/IMPLEMENTATION-STATUS.md"]
gate_test: test/worker/config-template.test.ts, scripts/check-implementation-status.mjs
threshold: 1
always_active: true
rationale: The production D1 database is provisioned and remains bound in configuration. The public Worker route is offline because `workers_dev` is false; public reactivation and institution OAuth remain deferred pending their separate owner/admin gates. Repository tests remain synthetic and do not establish public cloud readiness.
