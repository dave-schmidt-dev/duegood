# Due Good local dashboard walkthrough — 2026-09-21

Candidate: the local build produced from the current working tree. This walkthrough covers the owner-only loopback app. It does not claim cloud deployment or institution approval.

## Shared shell

- Desktop: persistent left navigation, current-term summary, refresh timestamp, optional Refresh control, fixed course colors, and dark mode by default.
- Mobile: the same eight destinations appear in a fixed bottom navigation bar.
- Loading: a live status region appears until the local dashboard response arrives.
- Failure: the app states that coursework could not be loaded and never substitutes sample data.
- Keyboard and automated accessibility checks cover navigation, event details, completion, contrast, and mobile target sizes.

## Timeline

- Shows one equal-height row for every consecutive calendar day from today through the latest upcoming event, capped at 120 days.
- IT 530 remains the left blue lane, IT 540 the center gold lane, and IT 570 the right green lane.
- Empty days remain visible. Multiple same-day assignments expand their course lane without creating a nested lane scrollbar, so the page has one continuous vertical scroll.
- Controls: All events/Deadlines only, per-course filters, Details, a directly visible `Done` checkbox on every deadline card, and a one-click `Copy assignment` button on all non-class timeline cards and Due soon rail items. Class meetings exclude copy actions and remain read-only.
- One-click copy uses a shared plain text formatter across timeline cards and rail items with labeled fields: `Course code`, `Assignment title`, `Due date/time`, `Points` (omitted when null/unknown), `Canvas submission status` (omitted when unknown), `Due Good completion status`, separate `Main post` and `Replies to classmates` progress for discussions, and `Assignment details` (falling back to `"No additional details were supplied."` when empty).
- Copy attempts use `navigator.clipboard.writeText` when available and a synchronous textarea/`document.execCommand` fallback when the Clipboard API is unavailable. The clicked button provides brief inline feedback (`Copied` on success, `Could not copy` on failure) through a single polite live control that auto-resets after 2.5 seconds without opening a modal.
- Completion is optimistic only while the request is pending; a failed write restores the last confirmed state and displays an accessible error.
- Discussion cards visibly split `Main post` and `Replies` into two full-width requirement rows. Each row has its own persisted checkbox, while `Overall assignment` completion remains separate. The Due soon rail presents the same two requirements.
- Class meetings are read-only. Canvas submission state is never changed by the personal completion control.
- Desktop: the workspace fills all horizontal space left by navigation. The `At a glance` rail stays bounded while the timeline receives every remaining pixel instead of being compressed by a fixed page cap. The rail shows unfinished non-class work in chronological order; the first four items are visible and `All assignments` expands the remainder. Its `Done` and `Copy assignment` controls use the same persisted completion path and failure recovery as timeline cards.
- The rail's `Hot inbox` section shows unread locally synced Canvas conversations newest first. Selecting one opens Inbox with that conversation selected; it does not mark the conversation read in Canvas.
- Narrow screens stack the rail below the timeline and retain the same controls without an independent rail scrollbar.

## Inbox

- Lists locally retained Canvas conversations and renders each complete thread with author, time, full inert-text body, and attachment metadata.
- Ordinary URLs remain visible as text. If Canvas returns incomplete history or an explicit safety ceiling is reached, the thread shows a visible warning instead of silently clipping.
- Selecting a thread is local-only and does not mark it read in Canvas.
- No send, reply, delete, archive, star, or mark-read controls exist.
- When no snapshot exists, the page explicitly says Canvas conversations have not been synced.

## Grades

- Shows reported scores, points possible, grade labels, grading timestamps, and each item's provenance from the private coursework source.
- Shows Canvas's assignment-group names and weights for every active class, plus each assignment's group in the grade table.
- Each course summary separates `Graded work` from `Whole-course progress`. Graded work uses only Canvas-scored assignments and renormalizes the represented positive group weights. Whole-course progress uses all currently returned positive-point assignments and treats ungraded work as zero.
- Coverage and awaiting/unavailable counts remain visible; a class with no numeric scores shows an unknown graded-work value instead of a fabricated zero grade.
- Desktop course cards pin the collapsed `Grade groups` disclosure to a shared bottom row, so its divider and label align across all three cards even when course titles wrap differently.
- Controls: All records/Graded only and per-course filters. Score-only, letter-grade, and grading-timestamp records count as reported even when they cannot enter a numeric points total.
- The page explicitly states that these progress indicators are not an official final course grade. Current Canvas assignment groups contain no drop rules; the UI does not infer unpublished work or instructor policy.
- Grades is read-only. It cannot change a score or submission in Canvas.

## Completed

- Lists assignments marked complete by the owner, newest completion first.
- Control: Mark not done.
- A failed write restores the row and presents an accessible error rather than silently removing it.

## Courses

- Shows the three active class cards with their stable lane positions, next deadline, next class, and completed count.
- Control: View timeline, which applies the matching course filter and returns to Timeline.
- Non-course university calendar containers are not rendered as course lanes.

## Library

- Filters: All, Files, Pages, Links, Modules, Announcements.
- Displays only sanitized metadata from private local Canvas exports.
- Open appears only for a manifested file beneath the matching private course materials directory. Pages and arbitrary external links are not opened by Due Good.
- The browser owns the resulting download UI; Due Good serves it as a no-store attachment with content sniffing disabled.

## Activity

- Shows refresh history, complete/partial/failed state, added/changed/removed counts, and per-run changes. Changed fields display their stored old and new values, such as `Submission: Not submitted → Submitted`; missing historical values remain `Unknown` or `Unavailable` rather than being inferred.
- Every successful Due Good refresh now records its own bounded, atomic before/after audit event, including grade-only changes while excluding local completion and notes. One explicitly partial recovery entry identifies grade updates missed by the earlier broken audit path without claiming a complete original diff.
- A partial refresh never reports removals and states that existing data was kept.
- Control: Refresh, available only when the launcher explicitly enables the fixed local refresh consumer.
- While running, every Refresh control becomes disabled, shows a motion-sensitive activity indicator, and exposes `aria-busy`; success and failure are announced without displaying subprocess output.

## More

- Shows local source status, last refresh, included Canvas item classes, and privacy mode.
- Control: Refresh when enabled.
- Inbox status remains distinct from coursework and Library status.

## Role and permission boundary

- One local owner role exists. There is no student/admin role switch in this local replacement.
- Completion and discussion-progress checks are the only normal authoritative coursework mutations; Grades is read-only.
- Refresh is launcher-gated and secret-backed outside the browser.
- Inbox activation was separately owner-approved because it expands private retained data; all Canvas message actions remain absent.
