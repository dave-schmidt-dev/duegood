# Due Good

Due Good is a macOS Tauri app for private coursework. It keeps the coursework store in the app's fixed local data folder and uses native commands for reads, edits, import, recovery, snapshots, and Canvas refresh. The embedded `src/ui` WebView is the desktop interface; there is no standalone browser product.

The dashboard provides Timeline, Grades, Inbox, Completed, Courses, Library, Activity, and More. Completion, discussion post/reply checks, and notes are local student state. Canvas submission and grades remain separate source facts. Inbox is read-only. An incomplete refresh retains existing coursework and reports the limit.

## Current state

- The installed bundle identifier is `com.zerodelta.duegood`. The first iCal-backed native store is live. Candidate `75ef537` corrects the reported Sunday date-only events appearing in Saturday's row at 8:00 PM; it is installed and running against the preserved native store. Owner visual acceptance of the correction remains open.
- The old local Node listener has been disabled and stopped, leaving `127.0.0.1:2137` for the native one-shot receiver. Its launchd plist and private coursework source remain for rollback.
- The native feed refresh has run in the installed app and reported a complete refresh with one held event in the owner's screenshot. Repeat-refresh identity and owner acceptance remain open.

## First run and recovery

On an empty store, use **Connect calendar** in the native app. A successful, useful feed creates the local store without a Canvas API token or legacy-folder import. Calendar data does not contain grades, messages, or progress saved in an older Due Good folder. The older private source stays untouched. Damaged-store recovery and guarded preview replacement remain separate paths.

The private coursework, grades, messages, feed URL, credentials, and screenshots do not belong in this repository, fixtures, CI output, or public issues. Public fixtures are synthetic.

## Calendar feed

The feed URL lives only in Bitwarden Secrets Manager, separate from the Canvas API token. The fixed `duegood-canvas-ical` broker consumer pins `scripts/sync-canvas-ical.mjs` and supplies the URL to that helper. The helper fetches only the reviewed Marymount Canvas calendar URL family and posts bounded calendar bytes to the native one-shot localhost receiver after the port handoff. Tauri stages a fresh store only when empty, then applies later accepted observations under its store lock; unsupported or ambiguous events are held, and rolling-window omissions never delete coursework. Course labels initially use Canvas IDs because the feed does not establish official course names.

## Build and verify

Run source checks in a private staged candidate so the current installed app and legacy listener are untouched:

```sh
npm run stage:tauri -- --skip-preflight --test test:tauri
```

The project installer is `npm run install:tauri` after the staged build and asset checks pass. Launch the installed app by bundle ID, `open -b com.zerodelta.duegood`, so LaunchServices selects the registered app. Installation, launch, and live feed acceptance are separate checks. See [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) and [`docs/DESKTOP-CUTOVER.md`](docs/DESKTOP-CUTOVER.md) for the remaining gates.

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
