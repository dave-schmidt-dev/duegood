# Due Good Tauri screen walkthrough — 2026-09-23

**Candidate:** Phase 3 Tauri UI in the current source tree. This is a source-candidate walkthrough based on `src/ui/app.ts`, `src/ui/pages/dashboard.ts`, and the synthetic IPC scenarios in `test/browser/desktop-first-run.spec.ts`. It is pending final integration review. No installed app, live Canvas connection, BWS operation, owner acceptance, or signed build is claimed. Examples and test data are synthetic.

## Startup and store states

- **Loading:** Tauri reads app-store status before selecting a screen. A ready preview or authoritative store loads the coursework dashboard. A store read failure shows `Due Good could not reach its app store` and an alert; the dashboard is not populated with sample data.
- **Empty store:** `Set up local storage` shows the fixed app-data folder and `Choose legacy folder…`. The native folder picker supplies a one-run selection; the selection status does not reveal its path. Cancel leaves the setup screen unchanged. After selection, a counts-only dry run runs. `Check again` repeats the dry run. The report shows bounded inventory counts, byte total, unsupported type counts, legacy-lock status, and refusal counts. `Import as preview copy` is enabled only when the dry run allows import.
- **Import progress and failure:** During import, progress reports phase, file counts, and byte counts. Folder selection and import controls are disabled while work is active. If import fails, the error and any refusal counts are shown; the original folder is preserved and import must pass a fresh dry run before retry. A completed import opens a writable **Preview copy**.
- **Replace preview:** `Replace preview copy…` appears only in More for a preview store. The setup screen explains that the current preview is archived before replacement. `Keep current preview copy` exits without replacing it. Choosing a legacy folder, checking it, and importing use the same dry-run and progress states. The authoritative store has no replace control.
- **Another instance or unavailable folder:** `Due Good is already open` explains that another window owns the store and offers no controls. `App data folder unavailable` shows the returned error and fixed folder and offers no import controls.
- **Damaged or unknown store:** `The app store needs recovery` says no change or import was made over it. Recovery and export are offered when available; read errors remain visible. Store contents are not silently replaced.

## Shared dashboard shell and store differences

- The left navigation has eight destinations: Timeline, Grades, Inbox, Done, Courses, Library, Activity, and More. At narrow widths, the same destinations use bottom navigation. The current route is marked as current. The shell also shows the term, course count, and course-color legend.
- The top bar shows refresh status and, for a preview only, a `Preview copy` badge. `Recovery` opens recovery. `Export` opens recovery and starts rollback export. `Refresh` appears only when native refresh is available; while it runs the control changes to `Refreshing…` and is disabled. Progress appears in the top status area. A dashboard store warning appears as an alert; an in-progress daily snapshot reports file and byte counts.
- **Preview:** coursework is copied from the legacy folder. The browser folder remains the source until cutover; the preview does not follow later browser changes and cannot Canvas-refresh. Personal completion and discussion-progress edits are writable in the preview. `Replace preview copy…` is available in More.
- **Authoritative:** the app store is labeled authoritative and import cannot replace it. Its owner can turn native Canvas refresh on or off in More. Enabling it records the setting but does not promise a working credential: if the helper is not installed, the toggle can be on while the status says refresh is unavailable and no Refresh control appears. When the helper is installed and the store self-check passes, the status says a refresh can be attempted. Neither store offers a student/admin role switch.
- **Completion saves:** personal completion and discussion progress are separate from Canvas submission state. A save is shown as pending; a conflict reloads current stored coursework and keeps its latest value. Other failures restore the last confirmed value and announce the error. Native `Copy assignment` reports `Copied` or `Could not copy` inline.

## Dashboard routes

### 1. Timeline

- Shows a bounded daily timeline with course lanes, empty days, matching-event count, and a next-deadline summary. `All events` / `Deadlines only` and `All courses` / individual course buttons filter the view.
- Assignment and discussion cards have `Details` / `Hide details`. Assignment completion can be changed with its checkbox or the detail action. Discussion cards have separate `Posted my response`, `Replied to two classmates`, and `Overall assignment` controls. Class meetings have no completion or copy control. Copyable coursework has `Copy assignment` with pending/success/failure feedback.
- The rail lists due items, with `Done` checkboxes and copy actions; `All assignments` expands additional due items. Hot inbox rows open a selected conversation in Inbox without marking it read. Empty and no-unread states are shown when applicable.

### 2. Grades

- Course summary cards show reported graded progress, points, coverage, and whole-course progress with an explicit warning that these indicators are not official final grades. Selecting a summary card filters to that course. `Grade groups` disclosures expand supplied group names and weights.
- `All records` / `Graded only` and `All courses` / course buttons filter the read-only records table. Missing values remain unknown or unavailable. There are no score-edit or Canvas-submission controls.

### 3. Inbox

- Each retained conversation is a selectable button. The detail view shows context, received date, subject, participants, message count, messages, and attachment metadata. Selecting a row does not mark it read or change Canvas.
- Incomplete history and safety-truncated message bodies show warnings. Empty state says conversations have not been synced. Inbox has no send, reply, delete, archive, star, or mark-read controls.

### 4. Done

- Lists personally completed coursework, newest completion first. `Mark not done` returns an item to unfinished state. Canvas submission status is displayed separately. Empty state says nothing is completed. Save conflicts and failures report status while retaining the last confirmed state.

### 5. Courses

- Course cards show stable course color/lane, next deadline, next scheduled class, and completed-item count. `View timeline` applies the selected course filter and navigates to Timeline. Empty state says no courses have synced. There are no course-edit controls.

### 6. Library

- `All`, `Files`, `Pages`, `Links`, `Modules`, and `Announcements` filter locally projected resource metadata. Empty and no-match states are explicit. A saved local resource has `Open or save`; unavailable resources have no action.
- The native command resolves a saved resource by its internal ID. Supported document/image files may open in the operating system's default app. Other files use a native Save dialog. Cancellation and failures produce status feedback. No arbitrary external URL is opened and no resolved local path is shown in the webview.

### 7. Activity

- Shows refresh-history details, status, added/changed/removed counts, and item-level changes. Selecting a history row switches the displayed run. Empty state says there is no refresh history. When refresh is available, `Refresh now` starts the same refresh action as the top bar. During refresh it is disabled and labeled `Refreshing…`.
- A completed run reports completion. An incomplete run says existing data was kept and may not include complete Canvas history. A failed run says existing data was kept; private helper diagnostics are not displayed. If refresh is unavailable, the page has no refresh trigger.

### 8. More

- Shows source/store status, fixed app-data folder, import time, refresh setting, last refresh time when present, import behavior, supported Canvas item classes, and privacy text.
- For a preview, the page explains that the browser folder remains the source and offers `Replace preview copy…`; it states that Canvas refresh is unavailable for preview. For an authoritative store, the owner can toggle `Enable Canvas refresh`. While the setting saves or a refresh runs, the toggle is disabled. A failed setting save is announced. The status distinguishes off, available, and enabled-but-unavailable. No Refresh button is shown here for the Tauri store card.

## Refresh states

- **Off:** In More, the authoritative owner toggle is unchecked; the status says `Canvas refresh is off.` No Refresh button appears in the shell or Activity.
- **Enabled but unavailable:** The owner may enable refresh even when no helper is configured. The checked toggle remains visible, status says `Canvas refresh is unavailable on this computer.`, and there is no Refresh button. A failed attempt to save the setting reports that it could not be saved.
- **Ready to attempt:** With an authoritative store, enabled setting, installed helper, and passing store self-check, `Refresh` appears in the top bar and `Refresh now` in Activity. The broker consumer and credential are verified only when a refresh is attempted. Preview never reaches this state.
- **Progress:** A running refresh disables its action. The top status reports phase, completed/total work, and received bytes when supplied. When complete, the dashboard reloads. More shows the last refresh timestamp when available.
- **Incomplete:** The UI says the refresh was incomplete and existing data was kept. Activity warns that the run may not include complete Canvas history.
- **Failure:** The UI says refresh failed and existing data was kept. Helper error details are not shown. Existing coursework remains visible. If the refresh completed but the subsequent dashboard read fails, the shell reports that updated coursework could not be reloaded.

## Recovery, export, and operating-system handoffs

- **Recovery:** Top-bar `Recovery` opens `Recover or export coursework` and loads generated snapshot labels. A recovery point can be selected with `Restore snapshot`; while restoring, restore/export actions are disabled and status explains that the current store is archived before restore. Success returns to the dashboard. Errors remain visible on the recovery screen. `Back to dashboard` is available when a preview or authoritative store is ready.
- **Export:** Top-bar `Export` opens recovery and begins rollback export; `Export rollback folder…` starts the same action from the recovery screen. The native folder picker selects the destination. Progress reports files and bytes; success reports the copied file count; cancellation or failure is shown as a message. Restore and export controls are disabled while an operation is running. Destination paths are not returned to the webview.
- **Legacy import:** `Choose legacy folder…` opens the operating-system folder picker. Only selection status is shown; the path is not displayed or retained in the UI. Cancel returns to setup. Dry-run, refusal, import progress, and failure remain on the setup screen.
- **Library:** `Open or save` hands a safe saved resource to the default OS app or opens the native Save dialog for other file types. The UI reports opened, downloaded, cancelled, or failed without showing a resolved path.
- **Clipboard:** `Copy assignment` uses the native clipboard command and shows inline pending/success/failure feedback; it opens no system sheet.

## Evidence boundary

The browser scenario mocks Tauri IPC and uses synthetic coursework to cover route rendering, store differences, refresh enablement/availability/progress/incomplete/failure, and recovery/export command flows. It is not a running Tauri shell and does not prove native picker behavior, Canvas connectivity, BWS use, signed packaging, installation, or owner acceptance. Confirm all screens and controls against the integrated candidate before any deployment review.
