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

## Private Canvas capture

Canvas capture uses one headed Chrome profile under the app's private data folder. Sign in in that window once, confirm the account ID reported by `identity`, and bind that ID locally. The download helper is built once from a staged production candidate. Later refreshes reuse the installed helper and account binding:

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

The browser stays open across commands. `refresh` checks the saved account binding, then writes a private, hashed archive generation and a latest capture snapshot in Application Support. File transfers use the existing Canvas page without opening, navigating, or closing a tab for each file. Capture has a 30-minute budget and the client waits up to 35 minutes. A partial response keeps prior generations available and names gaps in the private snapshot; it does not make the Tauri dashboard current. This capture path has not yet been imported into the native coursework store. `stop` closes the browser and broker. Canvas SSO can expire, so a later refresh may return `SIGN_IN_REQUIRED` and need a visible sign-in again. Output contains only status and counts; never commit the private archive.

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
