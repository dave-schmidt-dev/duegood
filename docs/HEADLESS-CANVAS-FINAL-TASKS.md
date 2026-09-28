<!-- capability-audit: standard-reviewed=6; downgraded-to-low=0 -->

# Private whole-account Canvas capture tasks

## Owner-selected ship checkpoint (2026-09-28)

Publish the tested v2 capture, native import, archive migration, freshness, and CLI workflow as a bounded source checkpoint. New visible Tauri controls and a new private live capture/import are deferred at the owner's request. The prototype remains design evidence; publication does not claim installed UI or new live adoption. Complete the release gates and stop feature expansion.

## Current evidence and boundaries

The schema-v2 capture-to-native-import path and its three fixed helpers are present in source: `duegood-capture-state` journals and leases capture runs, `duegood-capture-download` handles bounded file transfers, and `duegood-browser-import` validates and publishes a capture into the native store. `npm run canvas:session -- refresh` coordinates capture and import. This work remains unverified until the current staged native gate and a private live import through the installed Tauri app pass; synthetic/source evidence is not live or installed-app acceptance.

The session must remain headed because a separate headless relaunch did not recover the saved Canvas sign-in. Capture reuses the existing Canvas page and does not open a tab per file. Additional calendar/group coverage remains planned until collection passes its phase gate; existing collector endpoints or fixtures do not establish that planned coverage as complete.

## Phase 1: Guarded browser collection
- **Phase gate:** `npm run test:local && npm run test:desktop-ui && npm run typecheck && npm run lint && npm run deadcode && npm run check:public-tree && npm run test:membership`
- **Review focus:** Same-origin API allowlist, session identity, no Canvas state changes, pagination, no credential or signed-URL persistence.
- **Acceptance:** Synthetic reader and downloader pass first; a content-free owner-signed-in probe proves session continuity/API/file access before broad collector work. Current-term metadata can finish even while historical/file coverage has gaps.

### Task 1.1: Guarded browser API reader
- **Status:** accepted capture checkpoint `2a7ef5e`
- **Type:** implementation
- **Executor:** native (owner override while Switchyard work is ongoing)
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** none
- **Description:** Add a fixed-origin, audited API GET allowlist for the fixed dedicated Chrome profile outside Git, plus a content-free owner-signed-in feasibility probe. Use in-browser fetch, never Node request/cookie export; disable browser HTTP cache for capture. Validate identity against a locally confirmed account binding, safe pagination, size/item/time budgets, anti-JSON prefix, and content-free failures. Treat 401/SSO as session failure, 403 on required active-course areas as incomplete, and optional denied/disabled areas as explicit gaps. Set Inbox detail auto_mark_as_read=false. Do not navigate content pages, module item HTML, external tools, or quiz sessions. Pin the versioned capture schema for both producer and consumer tests. Update INV-5/7 and the refresh contract at first browser-lane introduction. Synthetic tests prove each gate; the captain runs live/private evidence.
- **Files:** scripts/canvas-browser-reader.mjs, scripts/canvas-browser-probe.mjs, docs/CANVAS-CAPTURE-SCHEMA.json, test/local/canvas-browser-reader.test.ts, test/native/playwright/canvas-browser-reader.spec.ts, playwright.config.ts, test/test-membership.json, package.json, INVARIANTS.md, docs/REFRESH-CONTRACT.md
- **Quick checks:** npm run test:local
- **Done when:**
  - The reader returns an identity-bound full page set for valid synthetic input.
  - The reader rejects signed-out HTML, unsafe pagination, and mismatched course IDs.
  - A regression test returns unchanged Inbox unread state after detail GET.
  - The probe returns distinct content-free results for session continuity, API shape, account identity, read state, and one file verifier/download test.
  - The focused tests and membership check exit 0.

### Task 1.2: Whole-account inventory, safe links, and capture receipt
- **Status:** accepted capture checkpoint `2a7ef5e`
- **Type:** implementation
- **Executor:** native (owner override while Switchyard work is ongoing)
- **RequiredCapability:** standard
- **Blocked by:** Task 1.1
- **External blockers:** none for metadata collection; authenticated file download remains a separate coverage gap
- **Description:** A native helper atomically increments a durable run counter and writes a running/failed attempt sidecar in the fixed app-data root before the Node collector makes any request; tests execute its actual compiled binary. Collector and dedicated profile are exclusively locked, and a visible owner Chrome conflict returns a clear status. Enumerate current-term courses first so historical/large-account budgets do not block current publication; resume concluded courses with per-course checkpoints. Include groups, My Files, and Inbox/Sent/Archived scopes. Cover course syllabus/tabs, assignments/submissions/comments, grades, pages, modules, discussions/replies, announcements, quizzes/calendar, folders/files, and attachments. Parse HTML to plain text and safe links; strip all nested signed URLs and never persist raw HTML. Stage a private 0700 bundle, rename it atomically to the fixed incoming location, write the hashed 0600 manifest last, and clean only aborted temp roots on normal/error/signal exit. The captain privately inspects Print Grades PDFs when locally available; no private bytes go to workers. A PDF parser is conditional on live need.
- **Files:** scripts/canvas-browser-capture.mjs, scripts/canvas-browser-links.mjs, src-tauri/src/bin/duegood-capture-state.rs, src-tauri/src/config.rs, test/local/canvas-browser-capture.test.ts, test/test-membership.json, package.json, README.md, INVARIANTS.md, docs/IMPLEMENTATION-PLAN.md, docs/REFRESH-CONTRACT.md
- **Quick checks:** npm run test:local
- **Done when:**
  - Synthetic tests return distinct account/course/area/link/file receipts and omit verifier URLs from every persisted field.
  - Synthetic failures return explicit gaps, persist a failed attempt receipt, and leave no temporary root.
  - A synthetic crash returns a higher persisted run ID on the next start and rejects the old incoming bundle.
  - The focused tests and membership check exit 0.

### Task 1.3: Guarded file downloader and private archive
- **Status:** accepted capture checkpoint `2a7ef5e`
- **Type:** implementation
- **Executor:** native (owner override while Switchyard work is ongoing)
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** none
- **Description:** Resolve numeric Canvas file references to metadata, then pass in-memory verifier URLs over a private pipe to a dedicated Rust helper reusing downloads.rs allowlist and cookieless manual redirects. Never place a signed URL in process arguments, logs, or a file. Extend the existing buffered 25 MB path to bounded streaming into private staging; reject sign-in/interstitial HTML and MIME/signature mismatch. Hash staged bytes for integrity, without claiming Canvas source authenticity. Durable archive promotion belongs to Task 2.1 after manifest validation. Refused, oversized, and authentication-dependent files are explicit gaps and do not block metadata publication. Never auto-open a file; sanitise display names and set macOS quarantine when exporting a copy. Tests use synthetic bytes and URLs only.
- **Files:** src-tauri/src/bin/duegood-capture-download.rs, src-tauri/src/downloads.rs, src-tauri/src/capture_archive.rs, src-tauri/src/lib.rs, src-tauri/Cargo.toml, scripts/canvas-browser-capture.mjs, test/local/canvas-browser-capture.test.ts, test/test-membership.json, package.json, INVARIANTS.md
- **Quick checks:** npm run test:tauri
- **Done when:**
  - Native tests reject an unreviewed redirect and over-limit response before archive publication.
  - Native tests return the verified hash for saved synthetic bytes and no archive entry on failure.
  - The focused Rust and local tests exit 0.

### Task 1.4: Browser-authenticated file fallback
- **Status:** accepted capture checkpoint `2a7ef5e`
- **Type:** implementation
- **Executor:** native
- **RequiredCapability:** standard
- **Blocked by:** synthetic redirect/streaming proof
- **External blockers:** none
- **Description:** The live verifierless file sample returned `SESSION_REQUIRED` to a cookieless range request. Keep it as a file gap while a synthetic Chrome harness proves each redirected request is paused and validated before contact, browser credentials never reach another host, a permitted final response can be streamed despite CORS, and private staging enforces the byte/time cap with cleanup on failure. Only then implement the bounded browser-authenticated fallback; never export cookies or storageState.
- **Files:** test/native/playwright/canvas-browser-auth-download.spec.ts, scripts/canvas-browser-auth-download.mjs, scripts/canvas-browser-capture.mjs, src-tauri/src/capture_archive.rs
- **Quick checks:** npm run test:local && npm run test:desktop-ui && npm run test:tauri
- **Done when:**
  - Synthetic allowed and refused redirect chains, CORS, byte limit, abort, crash, and cleanup cases pass.
  - One live content-free range probe confirms the chosen path before any full file capture.
  - Refused files remain explicit coverage gaps and never enter the archive.

## Phase 2: Atomic native import and freshness
- **Phase gate:** `npm run test:tauri && npm run test:ui && npm run deadcode && npm run check:public-tree && npm run test:membership`
- **Review focus:** Manifest identity, durable failure status, store lock order, iCal recency, legacy file migration, recovery.
- **Acceptance:** Complete current-term metadata publishes atomically; incomplete attempts keep prior generation but make affected Canvas views unverified; file gaps remain separate. iCal and personal facts remain independently visible.

### Task 2.1: Validate and publish browser metadata
- **Status:** in progress — v2 run linkage, native import, and freshness
- **Type:** implementation
- **Executor:** native (owner override while Switchyard work is ongoing)
- **RequiredCapability:** standard
- **Blocked by:** Task 1.2, Task 1.3
- **External blockers:** none
- **Description:** Reject browser import for empty/preview stores. Validate the complete manifest, account binding, monotonic run ID, symlinks, and staged blob hashes, then promote blobs under the native archive lock and merge metadata against the latest generation. Current-term keys come from the authoritative iCal store; browser-only courses get stable validated keys/folders and remain archival until owner activation. Promote folderless iCal courses; preserve personal fields and newer iCal due facts. An unstamped legacy iCal due fact remains selected until a verified iCal refresh supplies a comparable timestamp. Publish current-term metadata atomically, bind per-course/section coverage and the native attempt-status sidecar to run ID/generation, and mark success only after publication. A newer running/failed capture suppresses retained Canvas-owned facts while preserving iCal and personal state. Full native backup includes referenced resource blobs; frozen legacy rollback remains byte-preserving and separate from legacy refresh compatibility. Extract clean seams from touched legacy over-800-line modules in a separate commit, or record a concrete reason if impossible.
- **Files:** src-tauri/src/browser_capture.rs, src-tauri/src/lib.rs, src-tauri/src/refresh.rs, src-tauri/src/reconcile.rs, src-tauri/src/capture.rs, src-tauri/src/documents.rs, src-tauri/src/config.rs, src/shared/dashboard-projection.ts, test/ui/dashboard.test.ts, test/test-membership.json, INVARIANTS.md, docs/REFRESH-CONTRACT.md
- **Quick checks:** npm run test:tauri
- **Done when:**
  - Native tests return the prior generation ID and identical personal fields after partial or invalid capture.
  - Native tests return the newer iCal due observation after a capture that started before iCal committed.
  - UI tests return `current=false` after a failed attempt despite retained prior facts.

### Task 2.2: Archive migration, resource resolution, and recovery
- **Status:** pending
- **Type:** implementation
- **Executor:** native (owner override while Switchyard work is ongoing)
- **RequiredCapability:** standard
- **Blocked by:** Task 2.1
- **External blockers:** none
- **Description:** Copy/hash existing generation materials once into the content-addressed archive, marking prior un-hashed bytes as locally integral but not Canvas-source-verified. Omit bulk bytes from new generations while preserving old ones. Resolve by validated blob IDs, reject missing/hash-mismatched blobs and unsupported file signatures, and quarantine saved copies. Native snapshots hold references only; full owner exports include referenced blobs. Defer garbage collection and enforce a declared total disk cap. After snapshot restore, report a missing resource rather than opening an unverified path.
- **Files:** src-tauri/src/capture_archive.rs, src-tauri/src/resources.rs, src-tauri/src/export.rs, src-tauri/src/snapshots.rs, src-tauri/src/refresh.rs, src-tauri/src/config.rs, src-tauri/src/browser_capture.rs, INVARIANTS.md, README.md
- **Quick checks:** npm run test:tauri
- **Done when:**
  - Native tests return matching bytes from the archive while the new generation contains no copied blob.
  - Native tests reject missing, altered, or executable disguised blobs before open or save.
  - Native tests return a recoverable missing-resource status after restoring a snapshot without its blob.

## Phase 3: Personal Tauri workflow
- **Phase gate:** `npm run stage:tauri -- --skip-preflight --test test:all`
- **Review focus:** Distinct iCal/capture actions, content-free progress, stale labels, exact installed candidate.
- **Acceptance:** Tauri imports a validated fixed-location private bundle and shows coverage/files/links/gaps; live acceptance waits for owner sign-in and the installed candidate gate.

### Task 3.1: Tauri import and coverage controls
- **Status:** pending
- **Type:** implementation
- **Executor:** native (owner override while Switchyard work is ongoing)
- **RequiredCapability:** standard
- **Blocked by:** Task 2.2
- **External blockers:** none
- **Description:** Add a Tauri action to import the fixed-location private bundle produced by the personal CLI, without executing mutable checkout scripts. Require explicit confirmation for the first real-store import; send only the confirmation boolean and derive account identity from the validated capture in native code. Show per-course/section observation, metadata freshness, incomplete file/link gaps, and safe logged links; keep iCal Refresh distinct. Hide stale current-term facts from the daily view. Provide content-free progress and desktop tests for success, expiry, partial capture, and stale views. Extract clean seams from app.ts/dashboard.ts in a separate commit. Update INV-5/7/9/12 and REFRESH-CONTRACT for the personal browser collector. Do not enable public onboarding.
- **Files:** src-tauri/src/commands.rs, src-tauri/src/lib.rs, src-tauri/src/resources.rs, src/ui/transport.ts, src/ui/app.ts, src/ui/pages/dashboard.ts, src/ui/styles/components.css, test/native/playwright/desktop-first-run.spec.ts, test/ui/dashboard.test.ts, test/test-membership.json, scripts/check-refresh-contract.mjs, README.md, INVARIANTS.md, docs/REFRESH-CONTRACT.md
- **Quick checks:** npm run test:ui
- **Done when:**
  - Desktop tests return synthetic capture facts and leave the native store unchanged after login expiry.
  - UI tests return distinct labels for verified facts, stale retained facts, file gaps, and safe links.
  - The staged full gate exits 0.
