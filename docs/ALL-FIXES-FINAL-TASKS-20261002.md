<!-- capability-audit: standard-reviewed=7; downgraded-to-low=1 -->
## Phase 1: Security and data truth
- **Phase gate:** `npm run stage:tauri -- --skip-preflight --test test:all`
- **Review focus:** Same-object bounded reads, compatible dependency remediation, truthful calendar confirmation, and atomic snapshot publication.
- **Acceptance:** Staged full suite passes; security constraints, feed-confirmation behavior, and snapshot preservation are verified.

### Task 1.1: Compatible security lock updates
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** low
- **RequiredCapabilityJustification:** mechanical: lockfile updates for verified compatible fixed versions; no source behavior change.
- **Blocked by:** none
- **External blockers:** upstream-glib-compatible-bindings
- **Description:** Update compatible locked dependencies and document each alert disposition without falsely closing the unresolved glib alert.
- **Files:** src-tauri/Cargo.lock, docs/DEPENDENCY-SECURITY.md
- **Quick checks:** none
- **Done when:**
  - The lock resolves the verified compatible fixed versions and the staged full suite passes.
  - A check exits 0 after matching all five advisory dispositions, upstream constraints, and verified target exposure in the security note.

### Task 1.2: Verified import-state handle reads
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** none
- **Description:** Use safe directory-descriptor-relative traversal with no-follow and nonblocking opens, regular-file checks, and inode/device comparisons. Extend the shared capped reader to read from the same verified handle. Migrate nested import reads to that shared anchored reader. Recheck identity as a supplement to anchored traversal. Convert legacy staged deletion to validated parent handles and `unlinkat`, never pathname ancestors. Reject leaf and ancestor substitution, including swap-and-restore races, while preserving safe import behavior. Use one shared helper; do not add a redundant browser-import reader layer.
- **Files:** src-tauri/src/store.rs, src-tauri/src/store_read.rs, src-tauri/src/store_read_tests.rs, src-tauri/src/browser_import_state.rs, src-tauri/src/browser_import_inventory.rs, src-tauri/src/browser_import_tests.rs, scripts/check-test-membership.mjs, test/test-membership.json
- **Quick checks:** none
- **Done when:**
  - Synthetic tests prove bounded same-handle reads and reject symlink, leaf, ancestor, and swap-and-restore substitution without outside-file reads.
  - A bounded FIFO replacement regression exits 0 after proving nonblocking open rejects a non-regular handle without hanging.
  - Safe import, nested inventory, expiry, malformed-state, anchored staged deletion, and race regressions pass in the staged full suite.

### Task 1.3: Truthful rolling-calendar confirmation
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** none
- **Description:** Persist calendar-feed membership using stable event identity and generation data that excludes timestamps and personal state. Advance omission comparison only for a successfully parsed and applied feed with zero parser/application held entries; only this eligible zero-held result may set retained-absence state. Failures or held/incomplete results cannot infer absence. Any accepted exact positive observation clears that item's retained label, even in a feed with held entries. Explain that the rolling date window may omit retained items. Preserve personal completion/notes/history and existing version/snapshot behavior. Keep confirmation metadata outside visible source fields and separate metadata-only document changes from source-fact changes, so confirmation-only membership shifts persist provenance with zero updated items and create no pre-refresh snapshot. Identical repeat inputs preserve bytes, version, and pending snapshot contract. A dedicated `ical_confirmation.rs`/`ical_confirmation_tests.rs` seam is allowed.
- **Files:** src-tauri/src/ical_apply_merge.rs, src-tauri/src/ical_apply.rs, src-tauri/src/ical_apply_history_tests.rs, src-tauri/src/ical_confirmation.rs, src-tauri/src/ical_confirmation_tests.rs, src/db/types.ts, src/shared/coursework-types.ts, src/shared/dashboard-projection.ts, src/ui/dashboard-response.ts, src/ui/pages/dashboard.ts, src/ui/pages/timeline-event-card.ts, src/ui/styles/components.css, test/native/playwright/refresh-pages.spec.ts, scripts/check-test-membership.mjs, test/test-membership.json
- **Quick checks:** none
- **Done when:**
  - Calendar regressions exit 0 for omitted/outside-window items, reappearance during a held feed, partial/failed/held feeds, held counts, and personal-state preservation.
  - An exact positive observation regression exits 0 after proving it clears that item's retained label even when another feed item is held.
  - The identical-repeat regression exits 0 after asserting byte-identical membership, unchanged version, and unchanged pending snapshot.
  - A metadata-only membership shift regression exits 0 after asserting provenance persists with zero updated items and no snapshot rotation; source-fact changes still create snapshots.
  - Timeline assertions exit 0 for the truthful label/explanation and exact positive confirmation/reconfirmation.

### Task 1.4: Atomic snapshot publication
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** none
- **Description:** Publish snapshots by copying into a unique hidden pending directory, syncing file and directory state, then atomically renaming to the final snapshot only after success. Interrupted or partial pending copies must not be listed, deduplicated, restored, or rotated. Preserve all existing committed snapshots. Do not list the prior installed app as stopped until a validated snapshot catalog lock is held, its exact PID/path is verified, and that PID is stopped; release the lock after stop. The new app cold proof waits for snapshot activity to become idle.
- **Files:** src-tauri/src/snapshots.rs, src-tauri/src/snapshots_tests.rs, scripts/check-test-membership.mjs, test/test-membership.json
- **Quick checks:** none
- **Done when:**
  - Snapshot publication tests exit 0 after asserting only synced, atomically renamed snapshots are visible and committed snapshots are preserved.
  - Interrupted partial-copy tests exit 0 after asserting pending data is excluded from listing, deduplication, restore, and rotation.
  - Snapshot quiescence tests exit 0 for validated catalog locking, exact PID/path checks, bounded stop, and lock release.

## Phase 2: Desktop usability and installer identity
- **Phase gate:** `npm run stage:tauri -- --skip-preflight --test test:all`
- **Review focus:** Existing rail geometry and owned rollback-safe app launch.
- **Acceptance:** Desktop and narrow geometry pass; launch proof is bound to the owned installed path and PID.

### Task 2.1: Restore existing upcoming rail
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** Task 1.3
- **External blockers:** none
- **Description:** Restore the approved upcoming rail beside the Timeline at ordinary desktop widths and stack it safely at narrower widths. At 1040px and 1160px, test compact rail geometry with three and five synthetic courses, title wrapping, aligned columns, due order, and no viewport overflow while retaining course labels.
- **Files:** src/ui/styles/components.css, test/native/playwright/timeline-course-names.spec.ts, test/native/playwright/timeline-headers.spec.ts, test/test-membership.json
- **Quick checks:** none
- **Done when:**
  - Both Timeline Playwright specs exit 0 at 1040px and 1160px with three and five synthetic courses, verifying bounded rail geometry, aligned headers/body columns, title wrapping, and narrower stacking without overflow.
  - Due-order and course/date-label assertions exit 0 in the staged full suite.

### Task 2.2: Rollback-safe installed path launch
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** installed-macos-proof
- **Description:** Perform a cold exact-path proof, then safely stop that verified candidate while snapshot activity is quiescent before the cold bundle-ID proof; never satisfy either proof by activating an already-running process. Hold the validated snapshot catalog lock, verify exact PID/path, stop only that process with a bounded wait, and release the lock. Unregister owned backup bundle registrations while retaining bytes through both proofs; delete owned backup bytes only after both proofs succeed. On rollback, stop only the verified launched PID whose bundle URL/executable matches the installed owned candidate; fail closed for any other process. Preserve signatures and unowned app safeguards.
- **Files:** scripts/install-desktop-app.mjs, scripts/check-production-launch.mjs, scripts/install-desktop-launch.mjs, test/local/install-desktop-app.test.ts, test/local/install-desktop-launch.test.ts, test/test-membership.json
- **Quick checks:** none
- **Done when:**
  - Synthetic installer and launcher regressions exit 0 for cold-launch ordering, exact path/PID identity, snapshot quiescence, bounded termination, rollback, unowned apps, and retained backup bytes through both identity proofs.
  - Real macOS installed-path and bundle-ID proof passes in Phase 3.

## Phase 3: Integrated native acceptance and safe retirement
- **Phase gate:** `npm run stage:tauri -- --skip-preflight --test test:all`
- **Review focus:** Exact installed candidate, private source truth, and reversible cutover.
- **Acceptance:** Full suite and bounded live evidence pass; owner-only acceptance and retirement gates are recorded separately.

### Task 3.1: Native install and private refresh verification
- **Status:** pending
- **Type:** implementation
- **Executor:** native
- **RequiredCapability:** standard
- **Blocked by:** Task 1.1, Task 1.2, Task 1.3, Task 1.4, Task 2.1, Task 2.2
- **External blockers:** authenticated-chrome, owner-acceptance
- **Description:** Build and install through project tooling, then verify candidate path/PID/assets. Add a populated-store path/PID-only host verifier that attaches to the live app without terminating it and does not call first-run marker/root cleanup or alter the store. Pass only the private expected-file path to the runner, never expected values through environment variables. Keep raw XCTest logs and xcresult bundles only in an owned mode-0700 temporary directory; extract content-free outcomes and remove raw artifacts on every exit path. Emit generic failure codes and never send raw logs or private values to providers. Perform a full authenticated refresh and verify all eight pages using private local comparisons and content-free recorded evidence. Classify held items only by exact UID and canonical source identity; keep unsupported/ambiguous items held. Capture content-free before/after store and snapshot inventories and prove store/rollback preservation. Preserve private rollback assets indefinitely. Run the accumulated screen-seizing UI test once. Owner acceptance is required before retiring obsolete public listener entrypoints. The captain owns SHA256SUMS: stage every exact scoped new file before gates and update checksums once per accepted phase after worker quiescence.
- **Files:** test/native/macos/DueGoodDesktopUITests.swift, scripts/check-live-native.mjs, test/local/check-live-native.test.ts, scripts/check-test-membership.mjs, test/test-membership.json, package.json, docs/DESKTOP-CUTOVER.md, docs/IMPLEMENTATION-PLAN.md, README.md, CHANGELOG.md, TASKS.md, HISTORY.md, SHA256SUMS
- **Quick checks:** none
- **Done when:**
  - The staged full suite and the single accumulated screen-seizing host UI test pass; path/PID-only runner regressions prove the populated store remains intact.
  - The delivery record contains content-free installed-candidate, source-freshness, per-page eight-page refresh, held-item disposition, and before/after store/snapshot inventory evidence.
  - The delivery record contains `privateRollbackPreserved=true`.
  - The delivery record contains separate `ownerAcceptance` and `legacyRetirement` gate fields.
