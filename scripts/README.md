# Desktop utilities

Run from the repository root. Build and test Tauri in the owned project-local `.stage/tauri` candidate so the installed app and legacy data are untouched. Stage builds share `.cache/cargo-target` across candidates:

```sh
npm run stage:tauri -- --skip-preflight --test test:tauri
```

The fixed stage is removed after the command. Add `--keep` to retain it for inspection. When a later installer command needs the stage, pass `--destination "$PWD/.stage/installer"`; this is a direct child of the owned `.stage` namespace, is retained as a handoff after a successful run, and the installer consumes and removes it. A repeated use resets that same purpose directory and concurrent reuse is rejected while its lock is held. Stages never use `/tmp` or `$TMPDIR`. `npm run check:stage-budget` counts both stages and their build scratch roots. `npm run sweep:temp` is a dry-run backlog report for stale direct-child `duegood-*` roots in the system temp directory and `/private/tmp`; its `--apply` option is never part of build or test scripts.
Reusable Python caches belong in the ignored project paths `.cache/uv` and `.cache/harvest-uv`; set `UV_CACHE_DIR` to the corresponding absolute path for each command.
The pre-push hook runs `test:all` inside a disposable staged candidate, as the Tauri packaging checks require a stage receipt.

`scripts/build-tauri.mjs` prepares the embedded desktop assets and native sidecars. `scripts/install-desktop-app.mjs` verifies the staged app and installs it by the project workflow. `scripts/sync-canvas-ical.mjs` is the SHA-pinned, BWS-launched calendar fetch helper; never run it with a URL argument or print its injected environment.

The Python package checker validates synthetic fixtures and public-source hygiene. It does not establish live-feed, installed-app, or private-data acceptance.
