# Due Good Tauri screen walkthrough — 2026-09-23

**Candidate:** Signed Phase 5 native desktop build from staged tree `bffd25c8dd14`, installed locally. This walkthrough is based on the candidate UI and native command contracts, synthetic browser IPC scenarios, and a native smoke of the first-run preview flow. The owner-confirmed authority-transition dialogs, live Canvas access, and owner acceptance remain untested. No private coursework or screenshots are included.

## Startup and local setup

- **Starting:** The app checks its identifier-specific local store before showing coursework. A ready preview or authoritative store opens the dashboard. A store read error shows an alert without sample data; another open instance or unavailable app-data folder leaves the dashboard and import controls unavailable.
- **First run:** `Set up local storage` shows the fixed app-data folder and `Choose legacy folder…`. The macOS folder picker selects the legacy root for this operation. Cancel returns to setup. The selected path is not shown in the webview or retained for later discovery.
- **Dry run:** A selection runs a counts-only check. `Check again` repeats it. Inventory, byte totals, unsupported types, lock status, and named refusal counts are shown, without file names or coursework contents. Import is disabled until the report permits it; refusals keep it disabled.
- **Import:** `Import as preview copy` starts the validated copy. Progress reports phase, file counts, and bytes; selection and import controls are disabled while busy. Failure shows an alert and requires another dry run before retry. Success opens the dashboard as a writable `Preview copy`; the original folder remains untouched.
- **Replace preview:** `Replace preview copy…` exists only for a preview store. The next screen says the current preview will be archived before replacement. `Keep current preview copy` exits without replacing it. The same picker, dry run, refusal, progress, and failure states apply. An authoritative store has no replace control.
- **Damaged or unknown store:** The recovery screen explains that the store was not safely read and was not overwritten. Snapshot restore/export are offered when available; read and recovery failures stay visible.

## Shared shell and permissions

- The desktop shell has Timeline, Grades, Inbox, Done, Courses, Library, Activity, and More in the sidebar; narrow layouts use bottom navigation. The selected route is marked current. The shell shows the term, course count, and course color key.
- The top bar shows refresh status, `Recovery`, and `Export`; the `Preview copy` badge appears only for preview. `Refresh` appears only when native refresh prerequisites pass. A running refresh disables its control and reports progress. Store warnings and snapshot progress appear in the dashboard.
- This is a single local owner application, with no student/admin role switch. The operating-system account owns the local app store. Personal completion and discussion progress can be edited in preview and authoritative stores; Grades and Inbox are read-only, and there are no Canvas submission or message mutation controls. Preview does not track later changes in the source folder.
- An authoritative store can save the owner’s `Enable Canvas refresh` preference in More. The toggle is disabled while saving or refreshing. Turning it on alone does not establish readiness: if the helper or store self-check is unavailable, the status says refresh is unavailable and no Refresh button appears. Preview never refreshes.

## Dashboard screens

### Timeline

Shows consecutive day rows, color-coded course lanes, empty days, event counts, and the next-deadline summary. `All events` / `Deadlines only` and `All courses` / course buttons filter the view. Assignment and discussion cards expose `Details` / `Hide details`; class meetings remain read-only. Assignment completion and discussion `Main post`, `2 classmate replies`, and overall completion are separate personal fields. Copyable items have `Copy assignment` with pending, success, and failure feedback. The side rail shows four due items, expands with `All assignments`, and opens unread Hot inbox rows in Inbox without marking them read.

### Grades

Shows read-only Canvas grade records, bounded progress and coverage summaries, course filters, `All records` / `Graded only`, and expandable `Grade groups`. Unknown values remain unknown. The page says progress is not an official final grade. No score-edit or submission controls appear.

### Inbox

Conversation buttons select a thread; detail shows context, received date, subject, participants, messages, attachment metadata, and incomplete/truncation warnings. Empty state says conversations have not been synced. Selecting a thread does not mark it read. There are no send, reply, archive, delete, star, or mark-read controls.

### Done

Lists personally completed coursework, newest first. `Mark not done` returns an item to unfinished. Canvas submission state is shown separately. Empty state and save-pending, conflict, and failure feedback are visible; the last confirmed progress is retained on failure.

### Courses

Course cards show stable color/lane, next deadline, next class, and completed count. `View timeline` filters Timeline to that course. There are no course-edit controls; an empty state appears when no courses are available.

### Library

`All`, `Files`, `Pages`, `Links`, `Modules`, and `Announcements` filter local resource metadata. Empty and no-match states are explicit. Saved resources have `Open or save`; unavailable resources have no action. A safe local file can open in the operating system’s default app; other supported downloads use the native Save dialog. The webview does not receive the resolved file path.

### Activity

Refresh history rows select a run and show time, status, item counts, and changes. Incomplete runs say existing data was kept and history may be incomplete; failed runs say existing data was kept. When refresh is ready, `Refresh now` starts the same action as the top bar and is disabled during work. If unavailable, no refresh trigger appears. Empty state explains that there is no history.

### More

Shows store/source status, fixed app-data folder, import time, refresh setting and last-refresh time, imported data classes, and privacy text. Preview explains that its data is a copy and offers `Replace preview copy…`. `Choose and compare backup…` opens a native folder picker for a frozen backup and reports only file/byte counts. A mismatch or cancellation leaves the preview unchanged. An exact match reveals `Promote to authoritative store` and `Discard comparison`. Promotion asks for a native Yes/No confirmation, consumes the readiness proof once, rechecks the backup and preview bytes under the transition locks, and either changes the manifest state or reports a refusal without changing authority. A stale or used proof requires a new comparison.

An authoritative store offers `Return app store to preview…`. The native confirmation precedes a verified private recovery copy, refresh disablement, and demotion to preview. After demotion, `Export frozen rollback copy…` opens a native destination picker, holds the write lock for the copy and equality check, and reports a verified result or an error. Preview also offers this export after a restart; it does not imply that a rollback has already been accepted. Only an authoritative store has the refresh preference toggle. It can remain enabled while unavailable; status explains that state, and no Refresh control is exposed until prerequisites pass.

## Recovery, error, and system-owned surfaces

- **Recovery screen:** `Recovery` opens `Recover or export coursework`. Snapshot rows show type and age, not paths. `Restore snapshot` archives the current store first. Restore/export actions disable while either operation runs; `Back to dashboard` appears for a ready store. Errors remain on the screen.
- **Export:** Top-bar `Export` opens recovery and starts the same operation as `Export rollback folder…`. A native destination-folder picker chooses where to write. Progress reports counts; success, cancellation, and failure have status feedback. No destination path is returned to the webview.
- **Folder selection:** `Choose legacy folder…` enters the macOS folder picker. Cancellation leaves setup intact; successful selection leads to the dry run. No path is displayed.
- **Authority transition:** The frozen-backup and rollback-export pickers are native. The promotion and demotion confirmations are native system dialogs. Busy states show bounded file/byte progress, disable competing transition controls, and leave cancelled or failed operations with an explicit retry path. The webview receives an opaque proof and counts, never a backup path or a confirmation boolean.
- **Library handoff:** `Open or save` may hand a validated saved file to the OS default app or present the macOS Save dialog. Opened, saved, cancelled, and failed outcomes are reported in the app.
- **Clipboard:** `Copy assignment` uses the native clipboard command and reports success/failure inline; it opens no sheet.
- There is no in-app OAuth onboarding or credential form in this native flow. Refresh credentials are checked by the fixed helper broker at refresh time; local availability status is not proof that credentials or a live Canvas request work.

## Test and production identity

The production bundle identifier is `com.zerodelta.duegood`. Native GUI acceptance must use the isolated test identifier `com.zerodelta.duegood.test`, which keeps test app data separate. The production-identifier check is launch-only and must not import, refresh, or mutate coursework. The candidate UI is otherwise the same flow; a test run does not establish production-store parity or owner acceptance.

## Evidence boundary

The exact Phase 5 stage passed the integrated synthetic suite, separate Rust gate, signed asset checks, and the isolated macOS first-run/import/relaunch smoke. The installed Phase 5 production identifier passed its launch-only check. Those native checks exercised the folder picker but did not exercise the backup picker, owner confirmation, demotion, or frozen rollback export. Synthetic Canvas mocks do not establish live Canvas behavior or a BWS invocation. Owner acceptance remains pending.
