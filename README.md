# Due Good

Due Good is a macOS Tauri app for private coursework. It keeps the coursework store in the app's fixed local data folder and uses native commands for reads, edits, import, recovery, snapshots, and Canvas refresh. The embedded `src/ui` WebView is the desktop interface; there is no standalone browser product.

The dashboard provides Timeline, Grades, Inbox, Completed, Courses, Library, Activity, and More. Completion, discussion post/reply checks, and notes are local student state. Canvas submission and grades remain separate source facts. Inbox is read-only. An incomplete refresh retains existing coursework and reports the limit.

## Current state

- The installed bundle identifier is `com.zerodelta.duegood`. iCal refresh and Canvas browser capture are separate native workflows and keep independent source facts.
- The dashboard accepts both numeric and canonical decimal-string Canvas course IDs retained by earlier native stores, while rejecting malformed or unsafe IDs.
- The Canvas v2 capture-to-import workflow has separate source, synthetic, live-import, and installed-app acceptance gates. Earlier browser captures do not prove current native publication or installed behavior.

## Compatibility and versions

Patch releases preserve the existing local coursework store, Canvas capture schema v2, and the documented calendar, capture, recovery, and installation workflows. While Due Good is at `0.y.z`, incompatible changes or new features bump the minor version; compatible fixes bump the patch version. `package.json` is the authoritative version source, with npm lockfile, Cargo package/lockfile, and Tauri versions kept synchronized. Human release notes live in [`CHANGELOG.md`](CHANGELOG.md).

## First run and recovery

On an empty store, use **Connect calendar** in the native app. A successful, useful feed creates the local store without a Canvas API token or legacy-folder import. Calendar data does not contain grades, messages, or progress saved in an older Due Good folder. The older private source stays untouched. Damaged-store recovery and guarded preview replacement remain separate paths.

The private coursework, grades, messages, feed URL, credentials, and screenshots do not belong in this repository, fixtures, CI output, or public issues. Public fixtures are synthetic.

## Private Canvas capture

Canvas capture uses one headed Chrome profile under the app's private data folder. Sign in in that window, confirm the account ID reported by `identity`, and bind that ID locally. The signed-in browser stays open across commands; capture reuses its existing Canvas page for requests and does not open or close a tab per file. A separate headless relaunch did not restore the signed-in session, so this workflow relies on the headed profile and may need another attended sign-in after SSO expires.

Run `canvas:prepare-helper` once to build and install the three fixed native helpers in the private DueGood Application Support directory: `duegood-capture-state` (capture run/lease), `duegood-capture-download` (bounded file transfer), and `duegood-browser-import` (native import). Later refreshes use those installed helpers and the saved account binding:

```sh
npm run canvas:prepare-helper
npm run canvas:session -- start
npm run canvas:session -- status
npm run canvas:session -- probe
npm run canvas:session -- identity
npm run canvas:session -- bind <confirmed-numeric-user-id>
npm run canvas:session -- refresh
npm run canvas:session -- stop
```

The importer preserves separate child-detail coverage rows, including optional gaps; required course and inventory coverage must still be complete and unique.

`refresh` begins a durable run before collection, checks the saved account binding, captures a schema-v2 snapshot and hashed private archive, then invokes the native importer. The importer validates the run, account, inventory, required coverage, and file hashes before publishing coursework and projected documents together. Failed or incomplete metadata does not replace retained coursework; file gaps are tracked separately. Capture has a 30-minute budget and the client waits up to 35 minutes. Output contains only status and counts; never commit the private archive.

Canvas refresh also checks each active course’s captured syllabus body and captured syllabus documents for explicitly dated class meetings. Supported sources are HTML/text, PDF, and DOCX. The parser supports explicit full-year meeting rows, labelled bounded weekly DOCX declarations with no-class exceptions, and PDF class-date tables whose separately labelled meeting time and semester year are unambiguous. PDF syllabus discovery checks an exact first-page role heading as well as captured syllabus links and filenames. The captured course timezone applies; unsupported or conflicting formats remain unresolved. Ambiguous or unavailable schedules preserve existing sessions without inventing new ones. Repeated refreshes retain personal notes and completion and use stable meeting identities.

The native importer is not the iCal refresh. It preserves local completion, notes, and other personal fields, and keeps newer or unstamped iCal due observations selected when Canvas capture overlaps them. A newer running or failed capture makes retained Canvas-owned facts unverified in the daily view, while iCal facts and personal fields remain available. `stop` closes the browser and session broker. Canvas SSO can expire, so a later refresh may need another visible sign-in. A new private live native import and installed-app acceptance remain separate from source verification. Visible import/backup controls and a new live recapture are deferred at the owner-selected ship checkpoint.

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

The project installer is `npm run install:tauri` after the staged build and asset checks pass. Launch the installed app by bundle ID, `open -b com.zerodelta.duegood`, so LaunchServices selects the registered app. Installation, launch, and live feed acceptance are separate checks. See [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) and [`docs/DESKTOP-CUTOVER.md`](docs/DESKTOP-CUTOVER.md) for the remaining gates.

## Owner-supplied class times

For reviewed local syllabus dates whose meeting clocks are missing, the bounded `duegood-personal-sessions` native helper accepts explicit owner times as personal planning. It preserves Canvas facts and unrelated progress, checks the selected course, term and exact store version, and leaves identical replays unchanged. Build it with `npm run build:personal-sessions` after preparing the frontend assets. Its JSON input is private and must not be committed or printed; run with no arguments and provide the bounded request on standard input. Source refresh retains these manual class sessions.

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
