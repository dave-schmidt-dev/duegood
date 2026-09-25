# Due Good Tauri cutover

**Status (2026-09-25): pending.** The installed production app has no native store manifest at
the last content-free check. The existing local Node service owns the live calendar port
`127.0.0.1:2137` and its own private coursework store. The revised Tauri-only source has passed
synthetic tests, but it has not been installed, refreshed from the live feed, or accepted by the
owner. Keep the old service and its private files until the steps below pass.

## Prepare a clean calendar store

1. Verify the production native store is still empty without reading or printing private files.
   Keep the existing private coursework folder and Node service as a rollback source.
2. Install the exact tested candidate. Its first-run screen offers **Connect calendar**, with no
   legacy-folder picker or Canvas API token request. Do not paste a feed URL or token into the app.
3. After the port handoff below, connect the calendar. A useful validated feed atomically creates
   the authoritative local store. Confirm assignment counts and representative owner-selected
   records; grades, messages, and prior local completion are not supplied by iCal.

## Qualify the Tauri-only candidate

1. Run the complete synthetic checks in a private staged candidate. Require the staged source
   tree, bundled UI assets, Rust tests, membership, and public-tree checks to pass. A test result
   is not evidence that the installed app contains those bytes.
2. Build and install using the project's staged build and installer. Verify the bundle ID
   `com.zerodelta.duegood`, signed candidate bytes, and embedded asset hashes. Launch by bundle
   ID using `open -b com.zerodelta.duegood`. Confirm the dashboard opens directly when the
   native store exists; calendar connection appears for an empty store and recovery for damage.
3. Confirm the authoritative native store after the first feed. Compare content-free counts and
   representative owner-selected records. Do not substitute an older preview or another root.

## Hand off the calendar port

1. With the owner present, stop the old Node listener and writer while retaining their launchd
   plist and private store for rollback. Verify `127.0.0.1:2137` is free and no legacy writer
   remains active.
2. Verify the fixed `duegood-canvas-ical` BWS consumer still pins the installed helper. Never
   display the feed URL or invoke a secret-printing BWS command. The native receiver binds
   loopback before the helper starts, accepts one bounded POST, and applies observations only
   after the helper exits successfully.
3. In the installed app, connect the calendar, then run one repeat refresh. Require complete results, content-free
   counts, preserved student progress, and no unexpected duplicate identities. Ambiguous events
   must be held; rolling-window omissions must remove zero records. Inspect the dashboard with
   the owner before considering the handoff accepted.

## Rollback and acceptance

- On a failed native check, stop native writes. Keep the old service files. Preserve the new
  native store for diagnosis and explicitly select which source to resume; never overwrite either
  private copy implicitly.
- Only after the owner accepts the native dashboard and live calendar refresh should the legacy
  launchd service and source lane be retired. Preserve the private backup through the agreed
  rollback period. Do not claim an installed, launched, live, or accepted result from synthetic
  tests alone.

The cutover verifier, `npm run verify:cutover -- --help`, provides content-free equality and
service-state checks for an attended rehearsal. Its exit result must be recorded before any
rehearsal or final-cutover claim.
