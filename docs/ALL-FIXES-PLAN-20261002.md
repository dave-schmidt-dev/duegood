# Due Good: all remaining task fixes

Owner authorization: “ok plan and fix them all”. Base: 322056b, initially clean.

## Outcome and order
Fix all eight queued outcomes. First update compatible Rust dependencies and close the private import-state read race; then add truthful calendar confirmation and restore the approved desktop rail; then correct installer launch identity, build/install the exact candidate, classify held events privately, and verify full refresh across all eight pages. Retire only obsolete Node listener entrypoints after owner acceptance and the documented rollback gate. Shared native projection/parsing code stays.

## Verified findings
Task 3: five current GitHub alerts, four resolved by rustls-webpki 0.103.13 and rand 0.9.3. glib 0.20 is incompatible with Tauri 2.11.6 GTK/WebKit dependencies on 0.18; record upstream constraint and verify macOS target exposure rather than force incompatible bindings.
Task 11: browser_import_state.rs validates then reopens by pathname. Read through a no-follow verified handle, enforce cap and regular-file identity, and recheck ancestor identities. Deterministic symlink and ancestor substitution tests must fail closed.
Task 2: successful rolling-calendar omissions retain facts. Persist provenance from successfully applied complete feeds; show previously imported facts as unconfirmed, preserving personal state and history. Partial, held/incomplete, and failed feeds cannot infer absence; absence is never cancellation. Repeated successful feeds reconfirm reappearing items.
Task 19: installer currently opens by bundle ID before owned backup cleanup. Launch and validate the installed exact path while rollback exists; safely clean owned backups; then verify bundle-ID process identity with bounded retry. Launch failures restore rollback, never delete an unowned bundle.
Task 17: existing upcoming rail is stacked at 861–1400px. Restore side-by-side at ordinary desktop widths and stack on narrow screens; preserve title wrapping and aligned columns.
Tasks 1/5: installed bytes lag source; live private refresh and held classification have not been verified. Use authenticated existing Chrome and private content-free evidence. No guessed mapping or private public fixtures.
Task 4: source retirement needs Task 1 owner acceptance and rollback period. Preparing a narrow removal patch and reversible rehearsal is safe; deletion before those gates is excluded.

## Scope and safety
Use existing Tauri/TypeScript architecture and project installer. No new services, providers, credentials, paid resources, Canvas writes, private public data, arbitrary architecture migration, or global cleanup. Preserve verified incremental file reuse. Public push requires exact candidate authority. Unresolved upstream and owner gates remain explicit, not falsely completed.

## Execution and rollback
Independent bounded workers handle lock updates, handle reads, CSS/tests, and installer/tests. Calendar provenance follows its exact store/UI contract. Switchyard handles eligible low/standard work; host-only checks and verified capability failures use authorized native fallback. Each task includes its causal tests, manifest membership, and relevant documentation. Restore individual source commits for code rollback; installer preserves the private store and verified app backup through launch proof. No whole-store reset.

## Gates and acceptance
Run focused Rust, installer, and Playwright regressions on their phases, update runner membership, then staged test:all, lint/dead-code, integrity/package checks. Build/sign/install through project tooling; verify expected bundle path/PID and candidate assets. Live refresh must distinguish Canvas/calendar outcomes and show accurate Timeline, Grades, Inbox, Done, Courses, Library, Activity, More. Classification uses exact UID and canonical source identity only. Owner acceptance and rollback retirement remain separate from automated proof. Record exact tests, candidate tree, installed assets, live outcome, upstream constraints, and pending gates in one delivery record; update README/CHANGELOG/implementation plan plus private TASKS/HISTORY.

## Self-review corrections
Do not claim glib fixed merely because macOS excludes GTK. Do not downgrade omission confirmation on partial/held feeds. Do not delete shared src/local code or private rollback material. Do not use a mocked launch as macOS proof or automated page checks as owner acceptance.
