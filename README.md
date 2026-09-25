# Due Good

Due Good is a macOS Tauri app for private coursework. It keeps the coursework store in the app's fixed local data folder and uses native commands for reads, edits, import, recovery, snapshots, and Canvas refresh. The embedded `src/ui` WebView is the desktop interface; there is no standalone browser product.

The dashboard provides Timeline, Grades, Inbox, Completed, Courses, Library, Activity, and More. Completion, discussion post/reply checks, and notes are local student state. Canvas submission and grades remain separate source facts. Inbox is read-only. An incomplete refresh retains existing coursework and reports the limit.

## Current state

- The installed bundle identifier is `com.zerodelta.duegood`. At the last content-free check, its production store was empty. An empty or damaged store opens the native import/recovery screen. Once a preview or authoritative store exists, launch goes directly to the dashboard.
- The existing local Node service still owns the live iCal feed on `127.0.0.1:2137` during the reversible migration. Its first attended fetch on 2026-09-25 accepted 57 assignment observations and held one unverified event. Those facts are in the service's separate private store, not in the installed Tauri store.
- A Tauri-only iCal receiver and reconciler are being verified in source. Synthetic tests and a staged build do not establish an installed native feed refresh. The listener handoff, private import, and live Tauri acceptance remain attended cutover steps.

## First import and recovery

Use the native folder picker to select the existing private coursework root. A dry run reports counts and refusals before copying into a preview store. Promotion requires an exact frozen backup and owner confirmation; it enables authoritative native writes. The app never scans for or silently adopts a private source folder. The import/recovery route remains available when the store is empty or damaged.

The private coursework, grades, messages, feed URL, credentials, and screenshots do not belong in this repository, fixtures, CI output, or public issues. Public fixtures are synthetic.

## Calendar feed

The feed URL lives only in Bitwarden Secrets Manager. The fixed `duegood-canvas-ical` broker consumer pins `scripts/sync-canvas-ical.mjs` and supplies the URL to that helper. The helper fetches only the reviewed Marymount Canvas calendar URL family and posts bounded calendar bytes to the native one-shot localhost receiver after the port handoff. Tauri normalizes and applies accepted observations under its store lock; unsupported or ambiguous events are held, and rolling-window omissions never delete coursework. Native feed refresh requires an authoritative store with verified course and institution scope.

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
