<!-- capability-audit: standard-reviewed=6; downgraded-to-low=2 -->

## Phase 1: Security and data truth
- **Phase gate:** `npm run stage:tauri -- --skip-preflight --test test:tauri`
- **Review focus:** Same-object bounded reads and truthful successful-feed provenance.
- **Acceptance:** Focused regressions and staged Rust suite pass; upstream advisory constraints are recorded.

### Task 1.1: Compatible security lock updates
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** low
- **RequiredCapabilityJustification:** mechanical: update rustls-webpki to 0.103.13 and rand to 0.9.3, preserve manifest pins, record glib upstream constraint.
- **Blocked by:** none
- **External blockers:** upstream-glib-compatible-bindings
- **Description:** Apply compatible lock updates and record advisory target exposure without falsely closing glib.
- **Files:** src-tauri/Cargo.lock, docs/DEPENDENCY-SECURITY.md
- **Quick checks:** none
- **Done when:**
  - The lock resolves the two fixed versions and locked Rust checks pass.
  - docs/DEPENDENCY-SECURITY.md contains each advisory disposition and verified target constraint.

### Task 1.2: Verified import-state handle reads
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** none
- **Description:** Bind validation and bounded read to one no-follow file handle; detect leaf and ancestor substitution deterministically and fail closed, preserving safe import behavior.
- **Files:** src-tauri/src/browser_import_state.rs, src-tauri/src/browser_import_tests.rs, test/test-membership.json
- **Quick checks:** none
- **Done when:**
  - Synthetic same-object and ancestor replacement tests pass with outside-file reads rejected.
  - Synthetic race, expiry, malformed-state, and safe import tests pass and are in runner membership.

### Task 1.3: Truthful rolling-calendar confirmation
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** none
- **Description:** Persist item-specific successful-feed confirmation and latest complete-feed comparison; visibly label retained calendar-only facts not reconfirmed. Partial, held/incomplete, and failed feeds must not infer absence. Preserve personal completion, notes, history and exact identity matching.
- **Files:** src-tauri/src/ical_apply_merge.rs, src-tauri/src/ical_apply.rs, src-tauri/src/ical_apply_history_tests.rs, src/shared/coursework-types.ts, src/shared/dashboard-projection.ts, src/ui/dashboard-response.ts, src/ui/pages/dashboard.ts, src/ui/styles/components.css, test/native/playwright/refresh-pages.spec.ts, test/test-membership.json
- **Quick checks:** none
- **Done when:**
  - npm run test:tauri exits 0 with successful-feed omission, reappearance, partial and failed-feed regressions.
  - Timeline label assertions pass and personal-state preservation tests pass.

## Phase 2: Desktop usability and installer identity
- **Phase gate:** `npm run stage:tauri -- --skip-preflight --test test:all`
- **Review focus:** Accurate rail geometry and owned rollback-safe app launch.
- **Acceptance:** Installer regressions and desktop/narrow geometry pass with aligned Timeline columns.

### Task 2.1: Restore existing upcoming rail
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** low
- **RequiredCapabilityJustification:** mechanical: replace the stacking breakpoint for the existing approved rail and add representative geometry assertions.
- **Blocked by:** none
- **External blockers:** none
- **Description:** Restore side-by-side upcoming work at 1280px and readable stacking at 390px, preserving existing course labels and column alignment.
- **Files:** src/ui/styles/components.css, test/native/playwright/timeline-course-names.spec.ts, test/test-membership.json
- **Quick checks:** none
- **Done when:**
  - Desktop and narrow Playwright geometry assertions pass.
  - Playwright due-order and course/date label assertions pass.

### Task 2.2: Rollback-safe installed path launch
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **RequiredCapability:** standard
- **Blocked by:** none
- **External blockers:** installed-macos-proof
- **Description:** Launch/verify the exact installed bundle while rollback remains, clean only owned backups, and verify bounded bundle-ID launch resolution. Preserve signature, ownership, and rollback safeguards.
- **Files:** scripts/install-desktop-app.mjs, scripts/check-production-launch.mjs, test/local/install-desktop-app.test.ts, test/test-membership.json
- **Quick checks:** none
- **Done when:**
  - Wrong-path launch fails; rollback succeeds without deleting an unowned app.
  - Order and failure regressions pass, with real macOS proof delegated to Phase 3.

## Phase 3: Integrated native acceptance and safe retirement
- **Phase gate:** `npm run stage:tauri -- --skip-preflight --test test:all`
- **Review focus:** Installed bytes, private source truth, and reversible cutover.
- **Acceptance:** Exact candidate passes full suite and installed launch/live evidence; owner-only acceptance remains explicit.

### Task 3.1: Native install and private refresh verification
- **Status:** pending
- **Type:** implementation
- **Executor:** native
- **RequiredCapability:** standard
- **Blocked by:** Task 1.1, Task 1.2, Task 1.3, Task 2.1, Task 2.2
- **External blockers:** authenticated-chrome, owner-acceptance
- **Description:** Build/install through project tooling, prove path/PID/assets, full-refresh all eight pages, classify held events using exact private source identity, and prepare reversible legacy retirement after owner acceptance. Host-only authentication/LaunchServices proof is unavailable in isolated Switchyard. No private content output or source deletion before gates.
- **Files:** docs/DESKTOP-CUTOVER.md, docs/IMPLEMENTATION-PLAN.md, README.md, CHANGELOG.md, TASKS.md, HISTORY.md
- **Quick checks:** none
- **Done when:**
  - The delivery record contains content-free installed-candidate and live verification evidence.
  - The delivery record contains held-item disposition and explicit owner and retirement gate results.
