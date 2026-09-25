# Desktop utilities

Run from the repository root. Build and test Tauri in a private staged candidate so the installed app and the still-running legacy listener are untouched:

```sh
npm run stage:tauri -- --skip-preflight --test test:tauri
```

The generated stage is disposable by default. Add `--keep` to retain it for inspection, or pass `--destination /absolute/private/path` when a later command needs the same stage. `npm run sweep:temp` is a dry-run backlog report for old Due Good stage and macOS UI-smoke roots; its `--apply` option is never part of build or test scripts.

`scripts/build-tauri.mjs` prepares the embedded desktop assets and refresh sidecar. `scripts/install-desktop-app.mjs` verifies the staged app and installs it by the project workflow. `scripts/sync-canvas-ical.mjs` is the SHA-pinned, BWS-launched calendar fetch helper; never run it with a URL argument or print its injected environment.

The Python package checker validates synthetic fixtures and public-source hygiene. It does not establish live-feed, installed-app, or private-data acceptance.
