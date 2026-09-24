# Due Good Tauri screen walkthrough — 2026-09-23

**Candidate:** Phase 2 native desktop UI and Rust command surface in the current working tree. This walkthrough records the screen and control contract for review; the staged browser/full-suite gate and attended macOS acceptance are separate evidence. It uses only synthetic examples and makes no live Canvas, installed-app, or owner-acceptance claim.

## Startup and first run

- **Loading:** The desktop shell first asks the Rust app for store status. The dashboard appears only after the store is ready and coursework has loaded. A read failure leaves an explicit error; no sample data is substituted.
- **Empty store:** `Set up local storage` shows the fixed app-data folder and a `Choose legacy folder…` button. The native folder picker opens from Rust. The selection is used for this run, and its path is neither shown nor retained in the webview. Cancel returns to the setup screen.
- **Dry run:** A successful selection triggers the counts-only dry run. `Check again` repeats it. Counts, import caps, lock state, and named refusal counts are shown; no file names or coursework contents are previewed. `Import as preview copy` is disabled until a passing report is ready. A refusal leaves import disabled and explains the counts.
- **Import:** While the native import is running, phase and bounded file/byte progress are announced; `Choose legacy folder…` and import are disabled. A failure keeps the selection and displays an error so `Check again` can repeat the dry run. A completed import opens the dashboard in writable **Preview copy** mode.
- **Replace preview:** `Replace preview copy…` is available only for a preview store. The confirmation screen explains that the existing preview is archived before replacement. `Keep current preview copy` returns without changing it. Re-import uses the same native folder picker, dry run, refusal display, and progress states. An authoritative store never exposes the replace control.
- **Unavailable states:** If another app window owns the store, the screen says `Due Good is already open` and offers no controls. If the app-data folder is unavailable, an alert explains the problem and no import controls are shown.
- **Damaged/unknown store:** Recovery loads the generated snapshot list and presents restore/export options where possible. Store or snapshot errors appear as alerts; the current store is not silently replaced.

## Shared dashboard shell

- Desktop uses the left navigation; narrow screens use the same eight destinations in bottom navigation. The course legend and current term remain in the shell.
- The top bar shows the imported/updated status, the `Preview copy` badge only for preview state, and `Recovery` and `Export` actions. An owner-facing store warning, such as a failed daily snapshot, appears as an alert while the dashboard remains available.
- Completion writes are optimistic while pending. A native conflict triggers a fresh coursework read, keeps the latest stored value, and shows a retry message. A non-conflict failure restores the last confirmed value and reports that saving failed.
- Native `Copy assignment` sends formatted synthetic assignment text to the Rust clipboard command. The button announces `Copied` or `Could not copy`; it does not use the browser clipboard API.

## Dashboard routes

### 1. Timeline

- Shows full-day rows, course lanes, the next deadline, event count, and the `At a glance` rail. Empty days remain visible; the displayed horizon is bounded.
- `All events` / `Deadlines only` and `All courses` / course buttons filter the timeline. Assignment and discussion cards have `Details` / `Hide details`; class meetings remain read-only.
- Assignment completion and discussion progress are personal local fields, separate from Canvas submission status. Discussion cards expose separate `Posted my response`, `Replied to two classmates`, and `Overall assignment` controls. Conflicted or failed saves show an accessible status and retain the latest confirmed value.
- Each assignment/discussion card and due-soon row offers `Copy assignment`. The rail shows four due items initially; `All assignments` expands the rest. Unread `Hot inbox` rows open the selected conversation in Inbox without marking it read in Canvas.

### 2. Grades

- Course summary cards show reported grade progress and coverage. Selecting a card filters to that course. `Grade groups` disclosures show supplied group names and weights.
- `All records` / `Graded only` and `All courses` / course buttons filter the read-only table. Unknown scores, points, grades, timestamps, and group weights stay unknown instead of being inferred.
- The page states that its bounded progress indicators are not an official final course grade. No score or Canvas submission controls exist.

### 3. Inbox

- A button for each locally retained conversation selects its thread. The detail shows participants, date, messages, and attachment metadata.
- Incomplete history or a safety-truncated body has a visible warning. With no saved conversations, the page states that Inbox data has not been synced/captured.
- Inbox is read-only: there are no send, reply, delete, archive, star, or mark-read controls. Selecting a conversation does not change Canvas.

### 4. Done

- Lists coursework items marked complete, newest completion first. `Mark not done` returns an item to unfinished state.
- Save failures or conflicts are announced and preserve the last confirmed state. Canvas submission status is displayed as separate from personal completion.

### 5. Courses

- Course cards show the next deadline, next class, completion count, and stable lane position/color.
- `View timeline` applies that course filter and opens Timeline. There are no course-edit controls.

### 6. Library

- `All`, `Files`, `Pages`, `Links`, `Modules`, and `Announcements` filter locally projected Canvas metadata. A no-items or no-matches message replaces an empty list.
- A saved local file uses `Open or save`. Rust resolves its internal resource ID inside the private store. Safe document/image types are handed to the operating system's default opener; other types use a native Save dialog. Cancel reports that saving was cancelled; errors show a status. The webview never receives the resolved path, and arbitrary external links are not opened.

### 7. Activity

- Shows selected refresh history, complete/partial/failed status, item counts, and recorded changes. Selecting a history row changes the displayed run.
- Partial and failed runs state that existing data was kept. No refresh trigger is available in the Tauri candidate because native Canvas refresh is disabled in this phase. In browser/local mode, refresh controls remain governed by the existing explicit launcher configuration; that behavior is outside this native candidate walkthrough.

### 8. More

- Shows local source/store status, fixed app-data folder, import time, included data classes, and privacy statement.
- A preview store explains that it does not follow browser-folder changes and that personal progress edits stay in the copy. `Replace preview copy…` is its only store action. The authoritative store has no replace action.
- No native Refresh button appears in either store state. The app does not claim that a preview refreshes or follows later browser changes.

## Recovery, disabled states, and operating-system handoffs

- **Recovery:** The top-bar `Recovery` button opens `Recover or export coursework`. Generated snapshot IDs are presented as age/type labels only. `Restore snapshot` is disabled while another restore or export runs; selecting one archives the current store before restoring it. On error, the recovery alert is shown and the screen remains available. `Back to dashboard` is shown for ready preview/authoritative stores.
- **Export:** The top-bar `Export` button and `Export rollback folder…` open recovery and start export. Rust owns the native destination-folder picker. Progress is announced; export and restore actions are disabled while it runs. Success shows the copied file count; cancellation or error leaves an explicit message. No destination path is returned to the webview.
- **Legacy import:** `Choose legacy folder…` opens the OS folder picker. The picker result returns only whether a selection was made. Its path is not displayed or stored in TypeScript. Dry-run refusal, busy, import failure, and completion states remain within setup.
- **Library handoff:** Safe saved files may open in the OS default application. Other file types use the OS Save dialog. Due Good reports opened, downloaded, cancelled, or failure without exposing a path.
- **Clipboard handoff:** Native assignment copy runs through the Rust command boundary and has inline success/failure feedback; it opens no sheet.
- **Role boundary:** This is a single-owner local application. There is no student/admin role switch. The owner can change personal completion and discussion-progress fields in both preview and authoritative stores. Grades and Inbox are read-only; no Canvas message or submission mutation is available. Preview remains separate from the browser source until an owner-managed cutover.
