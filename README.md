# Due Good

Due Good is a macOS Tauri app for private coursework. It keeps the coursework store in the app's fixed local data folder and uses native commands for reads, edits, import, recovery, snapshots, and Canvas refresh. The embedded `src/ui` WebView is the desktop interface; there is no standalone browser product.

The dashboard provides Timeline, Grades, Inbox, Completed, Courses, Library, Activity, and More. Timeline checks the local date every 30 seconds and when the window resumes, so an idle view follows calendar rollover. Timeline class-name headers stay visible while scrolling and align with each day's date and marker columns; painted course dividers continue through the header and body. Recovery and Export are in More. Date-only assignment and discussion due dates display at 11:59 p.m. in the owner's default timezone; Canvas source timestamps stay unchanged, and class meetings with unknown clocks remain time-unknown. Completion, discussion post/reply checks, and notes are local student state. Canvas submission and grades remain separate source facts. Inbox is read-only. An incomplete refresh retains existing coursework and reports the limit. Refresh diagnostics preserve bounded reason counts and distinguish Canvas coverage gaps from calendar-held items. Startup and recovery reads show loading or retry states; Library file actions are scoped to one resource, and bounded local view state survives navigation and reload.

## Current state

Timeline, Inbox, Done, Courses and Library use source freshness to distinguish verified empty results from unavailable Canvas data. Retained calendar deadlines remain visible. In a narrow window, selecting an Inbox conversation opens its thread; returning to the list preserves your place. Recovery shows the selected snapshot’s local timestamp before restoring it.

- The installed bundle identifier is `com.zerodelta.duegood`. The iCal feed and Canvas browser capture remain independent sources; the app’s existing **Refresh** action attempts Canvas capture/import, then independently attempts calendar refresh and reports each source separately.
- The dashboard accepts both numeric and canonical decimal-string Canvas course IDs retained by earlier native stores, while rejecting malformed or unsafe IDs.
- The Canvas v2 capture-to-import workflow has separate source, synthetic, live-import, and installed-app acceptance gates. Earlier browser captures do not prove current native publication or installed behavior.
- Calendar refresh history is saved with the applied calendar changes, including no-change runs and held events. Browser imports record incomplete-capture Activity entries within the import generation, and repeating the same generation does not duplicate them. Activity reports distinguish added and updated assignments; new assignments are not double-counted as updates. Courses retains active courses without calendar events, while coverage status and course names/codes come from validated Canvas capture data. Calendar deadlines may attach to a linked Canvas assignment; the feed supplies deadlines, not grades, messages, or files. The **Refresh calendar** action updates calendar data only. Live institution behavior and owner acceptance are evaluated separately from source and synthetic checks.

### Current candidate work (2026-10-02)

The all-task candidate is in preparation. Planned changes include compatible Rust security-lock updates, anchored same-handle import reads and staged deletion, truthful retained-calendar labels for rolling-feed omissions, atomic snapshot publication, restoration of the existing upcoming rail, and cold installed-path plus bundle-ID launch proofs that keep rollback bytes until both proofs pass. The unresolved `glib` alert remains subject to upstream Tauri/GTK/WebKit compatibility and macOS target-exposure evidence; it is not treated as fixed by forcing an incompatible dependency.

The local UI coverage uses synthetic unit and Playwright fixtures. Installed and live populated-store acceptance remain separate milestone gates, run at a release or owner-qualification install: the verifier must attach to the running installed app, perform a full authenticated refresh, and check Timeline, Grades, Inbox, Done, Courses, Library, Activity, and More. Private expected data and raw UI evidence stay local and temporary; only content-free outcomes are retained. Source checks, installation, live refresh, owner acceptance, and legacy retirement are separate gates. See [`docs/ALL-FIXES-FINAL-PLAN-20261002.md`](docs/ALL-FIXES-FINAL-PLAN-20261002.md) and [`docs/DESKTOP-CUTOVER.md`](docs/DESKTOP-CUTOVER.md).

## Compatibility and versions

Patch releases preserve the existing local coursework store, Canvas capture schema v2, and the documented calendar, capture, recovery, and installation workflows. While Due Good is at `0.y.z`, incompatible changes or new features bump the minor version; compatible fixes bump the patch version. `package.json` is the authoritative version source, with npm lockfile, Cargo package/lockfile, and Tauri versions kept synchronized. Human release notes live in [`CHANGELOG.md`](CHANGELOG.md).

## First run and recovery

On an empty store, use **Connect calendar** in the native app. A successful, useful feed creates the local store without a Canvas API token or legacy-folder import. Calendar data does not contain grades, messages, or progress saved in an older Due Good folder. The older private source stays untouched. Restoring a recovery point requires explicit confirmation; cancellation leaves the current app store unchanged. Damaged-store recovery and guarded preview replacement remain separate paths.

The private coursework, grades, messages, feed URL, credentials, and screenshots do not belong in this repository, fixtures, CI output, or public issues. Public fixtures are synthetic.

## Private Canvas capture

Open **Timeline → Details** to read an item's Canvas instructions with paragraphs, line breaks and lists. Undated items appear under **No due date**. Completed items have a **Details** disclosure on **Done**. When a graded discussion has a distinct assignment description, the details and the Markdown export include both texts. Library details show the available bodies for pages, quizzes and announcements. A refresh counts bodies Canvas supplied, including explicitly empty bodies. A missing or unreadable body makes the refresh partial.

To keep readable copies, create `class-folders.json` in the Due Good app data root. For example, this synthetic mapping assigns one Canvas course to a local folder:

```json
{"schemaVersion":1,"courses":{"123":"/absolute/path/to/example-class"}}
```

Both app Refresh and `npm run canvas:session -- refresh` export after native import. Look under `assignments/<title-slug>/source/README.md` for the item title, source metadata, timestamps in Eastern time and UTC, rubric and formatted instructions. Due Good replaces its marked copies only when content changes. Keep personal notes in a separate file, or remove the first-line generator marker to keep a copy under your control. A missing or invalid mapping disables export. Export problems leave the import in place.

Manual, scheduled, launch and CLI refreshes use headless Chrome. When Canvas needs your help, refresh reports the reason and stops. For interactive setup, stop any current broker with `npm run canvas:session -- stop`, then start the dedicated profile explicitly with `--headed`. Finish sign-in and stop the visible session before refreshing. See [Okta sign-in setup](docs/OKTA-AUTO-SIGN-IN.md).

The desktop installer prepares three native helpers in the private DueGood Application Support directory: `duegood-capture-state` (capture run/lease), `duegood-capture-download` (bounded file transfer), and `duegood-browser-import` (native import). For CLI-only setup, run `npm run canvas:prepare-helper` from the source checkout before binding the account. After desktop installation, start with the session command below.

```sh
npm run canvas:session -- start --headed
npm run canvas:session -- status
npm run canvas:session -- probe
npm run canvas:session -- identity
npm run canvas:session -- bind <confirmed-numeric-user-id>
npm run canvas:session -- stop
npm run canvas:session -- refresh
```

The CLI `canvas:session -- refresh` remains a Canvas capture/import command. In the app, the existing **Refresh** action runs Canvas capture/import and then independently attempts the calendar update. Due Good also refreshes when the authoritative dashboard opens and every six hours while it stays open. An accessible banner reports verified additions and updates, and reports removals only after a complete source read. It stays visible while navigating until dismissed. App refresh uses the packaged fixed Node runtime, the saved owner Chrome profile and account binding, and the validated unchanged-file archive; it does not depend on a source checkout or shell `PATH`, and remains available when Canvas API refresh is disabled. If Canvas SSO expires, refresh attempts automatic sign-in and reports any challenge that requires interactive setup. Cookies stay in the private Chrome profile. Progress contains status and counts only, source results remain distinct, and dashboard data and freshness reload after partial or failed steps.

The importer preserves separate child-detail coverage rows, including optional gaps; required course and inventory coverage must still be complete and unique. Full refresh completion covers all accessible Canvas data, including personal file bodies. Canvas-confirmed access restrictions and inapplicable items are recorded as counted omissions. Failed reads, exhausted limits, and unverified downloads keep the full refresh partial even when daily coursework is available. A capture’s completion flag alone never authorizes deletion. Calendar readiness is reported independently. A rejected `._` macOS companion counts as optional metadata only when exactly one matching document in the same folder was successfully archived; other validation failures remain required gaps. Generation-bound all-day event identities can resolve feed events with or without a matching Canvas URL, while mismatched courses, dates, and duplicate events remain held. During refresh, temporary freshness loss is shown as progress; Activity records file-check reasons and explains calendar holds.

`refresh` begins a durable run before collection, checks the saved account binding, captures a schema-v2 snapshot and hashed private archive, then invokes the native importer. The importer validates the run, account, inventory, required coverage, and file hashes before publishing coursework and projected documents together. It repairs calendar-bootstrap course names and codes from validated captured course metadata without downloading files again. Failed or incomplete metadata does not replace retained coursework; file gaps are tracked separately. Capture has a 30-minute budget and the client waits up to 35 minutes. Output contains only status and counts; never commit the private archive.

Each browser refresh captures assignment and graded-discussion rubrics in the private archive. Expand an assignment in Timeline to see the rubric criteria and ratings. Refresh also checks files attached to or linked from assignments, discussions and their entries and replies, pages, and announcements. A hidden course Files tab can prevent listing files while still allowing individual downloads.

During a refresh, a file whose ID, size, content type, and `modified_at`/`updated_at` revision stamps are unchanged from the prior archive generation is copied from that generation's content-addressed blob into the new run's staging directory instead of downloaded again. The prior generation is accepted only through the same pointer, manifest, and snapshot-hash safeguards the archive writer uses, and only for the same confirmed account; the copied bytes are hash-verified against the prior receipt before staging. A missing, corrupt, or unsafe prior blob, a new or changed file (including same-size changes), missing or inconsistent revision evidence, restricted files, or an unusable archive simply downloads fresh bytes. Reuse copies keep `sourceAuthenticity: "unverified"`; a local hash proves byte integrity only, never Canvas origin.

Canvas refresh also checks each active course’s captured syllabus body and captured syllabus documents for explicitly dated class meetings. Supported sources are HTML/text, PDF, and DOCX. The parser supports explicit full-year meeting rows, labelled bounded weekly DOCX declarations with no-class exceptions, and PDF class-date tables whose separately labelled meeting time and semester year are unambiguous. PDF syllabus discovery checks an exact first-page role heading as well as captured syllabus links and filenames. The captured course timezone applies; unsupported or conflicting formats remain unresolved. Ambiguous or unavailable schedules preserve existing sessions without inventing new ones. Repeated refreshes retain personal notes and completion and use stable meeting identities.

Canvas import and iCal apply remain separate source updates. The app Refresh action orchestrates them in sequence, preserving local completion, notes, and other personal fields. A newer running or failed Canvas capture makes retained Canvas-owned facts unverified in the daily view, while iCal facts and personal fields remain available. `stop` closes the browser and session broker. Backup controls remain a separate owner-flow operation.

The first real-store import requires explicit confirmation in Tauri. The confirmation is a boolean; native code derives the Canvas account identity from the validated capture.

Full native backups include referenced browser-resource blobs and the native store's enriched iCal/personal fields. A frozen legacy rollback export preserves the selected legacy tree for byte-for-byte comparison and recovery; it is distinct from a refresh-compatible legacy export, which may be refused for enriched data. Older migrated file receipts retain `source: "legacy"`, `sourceAuthenticity: "unverified"`, and no observation timestamp; a local hash proves byte integrity only, not Canvas origin.

File checks establish local byte integrity and compatibility with reviewed MIME types: known binary formats use prefix signatures, while declared text formats use UTF-8 and non-HTML checks. They do not prove complete file grammar, Office container structure, or Canvas source authenticity. Archived files are not automatically opened.

## Calendar feed

The feed URL lives only in Bitwarden Secrets Manager, separate from the Canvas API token. The fixed `duegood-canvas-ical` broker consumer pins `scripts/sync-canvas-ical.mjs` and supplies the URL to that helper. The helper fetches only the reviewed Marymount Canvas calendar URL family and posts bounded calendar bytes to the native one-shot localhost receiver after the port handoff. Tauri stages a fresh store only when empty, then applies later accepted observations under its store lock; unsupported or ambiguous events are held, and rolling-window omissions never delete coursework. Course labels initially use Canvas IDs because the feed does not establish official course names.

## Build and verify

Run source checks in a private staged candidate so the current installed app and legacy listener are untouched:

```sh
npm run stage:tauri -- --skip-preflight --test test:tauri
```

Stages use a fixed, gitignored `.stage/<purpose>` directory and share the project’s gitignored `.cache/cargo-target`. A test stage is removed when the command ends, including on failure or interruption. Use `--destination "$PWD/.stage/install"` only for a build that the installer will consume and remove; `--keep` explicitly retains a diagnostic stage. The stage command rejects destinations outside `.stage`. `npm run check:stage-budget` enforces the stage count and size limit. `npm run sweep:temp` dry-runs guarded cleanup of old Due Good roots in both `$TMPDIR` and `/private/tmp`; `--apply` is a separate owner-authorized action.

Keep reusable Python caches in `.cache/uv` and `.cache/harvest-uv` by setting `UV_CACHE_DIR` to the matching absolute project path when running those tools. Do not create cache directories in `/private/tmp`.

The project installer is `npm run install:tauri` after the staged build and asset checks pass. It also rebuilds the three external Canvas helpers for that candidate, reports compile progress, and checks their provenance. A successful installation needs no separate helper preparation. If Refresh later reports that the helpers are out of date, run `npm run canvas:prepare-helper` in the original source checkout matching the installed build. If the checkout has changed, stage and install the new candidate. Launch the installed app by bundle ID, `open -b com.zerodelta.duegood`, so LaunchServices selects the registered app. Installation, launch, and live feed acceptance are separate checks. See [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) and [`docs/DESKTOP-CUTOVER.md`](docs/DESKTOP-CUTOVER.md) for the remaining gates.

## Validation cadence

Day-to-day work and phase gates are headless. The pre-commit hook runs lint and dead-code checks; the pre-push hook runs `test:all` in a disposable staged candidate. `test:all` covers type, lint, unit, model, render, Rust, and headless Playwright checks against the local test server, and it never opens the desktop app.

Checks that take over the screen run only at a milestone: before a release, at an install for owner qualification, or for a walkthrough. These are `npm run install:tauri` (cold-launch proofs), `npm run check:production-launch`, `npm run test:tauri:macos`, and the populated-store `npm run check:live-native` verifier. No hook or phase gate runs them or requires a record that they ran. Keep this native suite small: launch, quit, and one or two end-to-end journeys; move view- or model-only assertions to headless tests.

## Permission and consent testing

For permission-related signing, staging, and prompt troubleshooting, follow the Apple Development & Testing Permissions Guide in the sibling `apple_developer/documents/apple-development-permissions.md` checkout. Automated tests and synthetic permission-state fixtures check app behavior but do not establish OS consent or access to the protected resource. Record any real permission-positive check as separate owner-attended acceptance evidence; this reference does not claim a workflow correction or live qualification.

## Owner-supplied class times

For reviewed local syllabus dates whose meeting clocks are missing, the bounded `duegood-personal-sessions` native helper accepts explicit owner times as personal planning. It preserves Canvas facts and unrelated progress, checks the selected course, term and exact store version, and leaves identical replays unchanged. Build it with `npm run build:personal-sessions` after preparing the frontend assets. Its JSON input is private and must not be committed or printed; run with no arguments and provide the bounded request on standard input. Source refresh retains these manual class sessions. For an owner-confirmed erroneous meeting, the same helper accepts `removeSessionIds` alongside `sessions: []`: it removes only exact owned personal-session identities, rejects stale versions and ownership conflicts, and reports a removed count. Retain a private rollback copy before a correction; never infer off-week dates from a weekday alone.

## Repository map

| Path | Role |
| --- | --- |
| `src-tauri/` | Native store, import, refresh, calendar handling, and Tauri shell |
| `src/ui/`, `src/shared/` | Embedded desktop interface and its projections |
| `scripts/build-tauri.mjs`, `scripts/install-desktop-app.mjs` | Desktop build and installer |
| `test/native/`, `test/ui/` | Synthetic desktop UI and native acceptance coverage |
| `fixtures/` | Synthetic contracts only |
| `docs/IMPLEMENTATION-STATUS.md`, `HISTORY.md`, `TASKS.md` | Evidence, completed work, and current queue |

Due Good is an independent project and is not endorsed by Marymount University. Licensed under [MIT](LICENSE).
