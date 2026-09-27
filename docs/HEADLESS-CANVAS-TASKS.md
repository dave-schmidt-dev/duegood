<!-- capability-audit: standard-reviewed=6; downgraded-to-low=0 -->

# Private whole-account Canvas capture tasks

## Phase 1: Guarded browser collection
- **Phase gate:** `npm run test:local && npm run typecheck && npm run lint && npm run deadcode && npm run check:public-tree && npm run test:membership`
- **Review focus:** Same-origin API allowlist, session identity, no Canvas state changes, pagination, no credential or signed-URL persistence.
- **Acceptance:** Synthetic collection inventories the account and produces exact course/area/link/file coverage with explicit gaps; a signed-out profile writes no private facts.

### Task 1.1: Guarded browser API reader
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** none
- **Description:** Add a fixed-origin, audited API GET allowlist for a dedicated signed-in Chrome profile. Use in-browser fetch, never Node request/cookie export. Validate account identity, safe pagination, size/item/time budgets, anti-JSON prefix, and content-free failures. Set Inbox detail auto_mark_as_read=false. Do not navigate content pages, module item HTML, external tools, or quiz sessions. Use synthetic responses only; the captain handles private PDFs and live session evidence.
- **Files:** scripts/canvas-browser-reader.mjs, test/local/canvas-browser-reader.test.ts, test/test-membership.json, package.json, INVARIANTS.md
- **Quick checks:** npm run test:local
- **Done when:**
  - The reader returns an identity-bound full page set for valid synthetic input.
  - The reader rejects signed-out HTML, unsafe pagination, and mismatched course IDs.
  - A regression test returns unchanged Inbox unread state after detail GET.
  - The focused tests and membership check exit 0.

### Task 1.2: Whole-account inventory, safe links, and capture receipt
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** Task 1.1
- **External blockers:** none
- **Description:** Enumerate all accessible courses including historical, account Inbox/profile/My Files and accessible groups. Cover course syllabus/tabs, assignments/submissions/comments, grades, pages, modules, discussions/replies, announcements, quizzes/calendar, folders/files, and attachments. Record unsupported areas and safe link references; strip signed URLs from nested HTML and metadata. Write a 0600 versioned manifest last in a 0700 temporary root, with monotonic run ID and per-area completion, and clean aborted roots on normal/error/signal exit. The captain privately inspects Print Grades PDFs; no private PDF bytes or content go to the worker. A PDF parser is conditional on live need.
- **Files:** scripts/canvas-browser-capture.mjs, scripts/canvas-browser-links.mjs, test/local/canvas-browser-capture.test.ts, test/test-membership.json, package.json, README.md, INVARIANTS.md, docs/IMPLEMENTATION-PLAN.md
- **Quick checks:** npm run test:local
- **Done when:**
  - Synthetic tests return distinct account/course/area/link/file receipts and omit verifier URLs from every persisted field.
  - Synthetic failures return explicit gaps and leave no temporary root.
  - The focused tests and membership check exit 0.

### Task 1.3: Guarded file downloader and private archive
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** Task 1.2
- **External blockers:** none
- **Description:** Resolve numeric Canvas file references to metadata, then pass in-memory verifier URLs over a private pipe to a dedicated Rust helper reusing downloads.rs allowlist and cookieless manual redirects. Never place a signed URL in process arguments, logs, or a file. Stream within per-file and total disk caps; hash and atomically place verified blobs in a private content-addressed archive with one writer. Refused, oversized, and authentication-dependent files remain explicit gaps and do not block metadata publication. Never auto-open a file; sanitise display names and set macOS quarantine when exporting a copy. Tests use synthetic bytes and URLs only.
- **Files:** src-tauri/src/bin/duegood-capture-download.rs, src-tauri/src/downloads.rs, src-tauri/src/capture_archive.rs, src-tauri/src/lib.rs, src-tauri/Cargo.toml, scripts/canvas-browser-capture.mjs, test/local/canvas-browser-capture.test.ts, test/test-membership.json, package.json, INVARIANTS.md
- **Quick checks:** npm run test:tauri
- **Done when:**
  - Native tests reject an unreviewed redirect and over-limit response before archive publication.
  - Native tests return the verified hash for saved synthetic bytes and no archive entry on failure.
  - The focused Rust and local tests exit 0.

## Phase 2: Atomic native import and freshness
- **Phase gate:** `npm run test:tauri && npm run test:ui && npm run deadcode && npm run check:public-tree && npm run test:membership`
- **Review focus:** Manifest identity, durable failure status, store lock order, iCal recency, legacy file migration, recovery.
- **Acceptance:** Complete current-term metadata publishes atomically; incomplete attempts keep prior generation but make affected views unverified; file gaps remain separate.

### Task 2.1: Validate and publish browser metadata
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** Task 1.3
- **External blockers:** none
- **Description:** Validate a complete manifest and monotonic run ID, reject symlinks and hash mismatch, and merge against the latest native generation under existing locks. Promote verified folderless iCal courses; preserve newer iCal due observations and all personal fields. Publish all configured current-term course metadata in one transaction, historical metadata in the private archive. Persist per-course/section coverage and an app-data attempt-status sidecar written before capture and on failure, outside the generation. Extract clean seams from touched legacy over-800-line modules in a separate commit, or record a concrete reason if impossible.
- **Files:** src-tauri/src/browser_capture.rs, src-tauri/src/lib.rs, src-tauri/src/refresh.rs, src-tauri/src/reconcile.rs, src-tauri/src/capture.rs, src-tauri/src/documents.rs, src-tauri/src/config.rs, src/shared/dashboard-projection.ts, test/ui/dashboard.test.ts, test/test-membership.json, INVARIANTS.md, docs/REFRESH-CONTRACT.md
- **Quick checks:** npm run test:tauri
- **Done when:**
  - Native tests return the prior generation ID and identical personal fields after partial or invalid capture.
  - Native tests return the newer iCal due observation after a capture that started before iCal committed.
  - UI tests return `current=false` after a failed attempt despite retained prior facts.

### Task 2.2: Archive migration, resource resolution, and recovery
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** Task 2.1
- **External blockers:** none
- **Description:** Migrate existing generation materials to verified content-addressed blobs once, then omit copies from subsequent generations. Resolve by validated blob IDs, reject missing/hash-mismatched blobs and unsupported file signatures, and quarantine saved copies. Include archive references and required blobs in owner exports/snapshot recovery; defer garbage collection and enforce a declared total disk cap. Preserve old generations and report a missing resource after restoration rather than opening an unverified path.
- **Files:** src-tauri/src/capture_archive.rs, src-tauri/src/resources.rs, src-tauri/src/export.rs, src-tauri/src/snapshots.rs, src-tauri/src/refresh.rs, src-tauri/src/config.rs, src-tauri/src/browser_capture.rs, INVARIANTS.md, README.md
- **Quick checks:** npm run test:tauri
- **Done when:**
  - Native tests return matching bytes from the archive while the new generation contains no copied blob.
  - Native tests reject missing, altered, or executable disguised blobs before open or save.
  - Native tests return a recoverable missing-resource status after restoring a snapshot without its blob.

## Phase 3: Personal Tauri workflow
- **Phase gate:** `npm run stage:tauri -- --skip-preflight --test test:all`
- **Review focus:** Distinct iCal/capture actions, content-free progress, stale labels, exact installed candidate.
- **Acceptance:** Tauri imports a validated fixed-location private bundle and shows coverage/files/links/gaps; live acceptance waits for owner sign-in.

### Task 3.1: Tauri import and coverage controls
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** Task 2.2
- **External blockers:** none
- **Description:** Add a Tauri action to import the fixed-location private bundle produced by the personal CLI, without executing mutable checkout scripts. Show per-course/section observation, metadata freshness, incomplete file/link gaps, and safe logged links; keep iCal Refresh distinct. Provide content-free progress and desktop tests for success, expiry, partial capture, and stale views. Do not enable public onboarding.
- **Files:** src-tauri/src/commands.rs, src-tauri/src/lib.rs, src-tauri/src/resources.rs, src/ui/transport.ts, src/ui/app.ts, src/ui/pages/dashboard.ts, src/ui/styles/components.css, test/native/playwright/desktop-first-run.spec.ts, test/ui/dashboard.test.ts, test/test-membership.json, scripts/check-refresh-contract.mjs, README.md, INVARIANTS.md
- **Quick checks:** npm run test:ui
- **Done when:**
  - Desktop tests return synthetic capture facts and leave the native store unchanged after login expiry.
  - UI tests return distinct labels for verified facts, stale retained facts, file gaps, and safe links.
  - The staged full gate exits 0.
