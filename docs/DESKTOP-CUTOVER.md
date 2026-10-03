# Due Good Tauri cutover

**Current candidate status (2026-10-02): implementation and acceptance are in progress.** The
all-task candidate requires its own staged checks, cold installation proofs, and populated-store
live refresh. Earlier installation and refresh evidence below is historical; it does not establish
that the current candidate passed or is installed. Preserve private rollback material indefinitely
by default. Owner acceptance is required before retiring obsolete public listener entrypoints.

## Current candidate acceptance

1. Run the staged full suite against the exact candidate. Include compatible dependency updates,
   anchored bounded import reads and deletion, calendar confirmation, atomic snapshots, desktop
   rail geometry, and installer regressions. Keep the `glib` advisory open unless upstream-compatible
   bindings and target exposure are verified; do not force an incompatible GTK/WebKit dependency.
2. Install through the project installer. Verify the signed bundle and embedded assets, then prove
   a cold launch from the exact installed path and a separate cold launch by bundle ID. Before
   stopping the verified candidate between proofs, wait for snapshot activity to become idle while
   holding the validated snapshot catalog lock. Retain owned backup bytes until both proofs pass;
   on failure, stop only the verified candidate PID and restore the owned backup.
3. Attach the populated-store macOS verifier to the running installed app. Perform a full authenticated
   refresh and verify Timeline, Grades, Inbox, Done, Courses, Library, Activity, and More against
   private expected data. Confirm source freshness, held-item dispositions, and content-free
   before/after store and snapshot inventories. Do not pass private expected values in process
   arguments or environment variables. Keep raw XCTest and UI artifacts in an owned private
   temporary directory, extract only content-free outcomes, and remove the raw artifacts on every
   exit path. The verifier must leave the app running and avoid first-run cleanup.
4. Treat automated acceptance, owner acceptance, and legacy retirement as distinct decisions.
   Keep unsupported or ambiguous calendar items held. Rolling-feed omissions retain coursework
   and are labeled as previously imported with an explanation that the feed's date window may omit
   items. Preserve the private rollback source indefinitely unless the owner later directs otherwise.

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

1. Only after explicit owner acceptance of the current native candidate, stop the old Node listener
   and writer while retaining their launchd plist and private store for rollback. Verify
   `127.0.0.1:2137` is free and no legacy writer remains active.
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
- Retire obsolete listener entrypoints only after the owner accepts the native dashboard and full
  authenticated refresh across all eight pages. Preserve the private backup indefinitely by default.
  Do not claim an installed, launched, live, or accepted result from synthetic tests alone.

## Historical evidence (2026-09-25)

The earlier Tauri candidate created a native coursework store from iCal, and the old local Node
listener was disabled and stopped while its launchd plist and private source remained available.
The owner's screenshot showed one held event and exposed the date-only UTC display bug. Candidate
`75ef537` passed that period's staged gate, was installed with signature and embedded asset checks,
and launched against the preserved native store. Owner visual acceptance remained open. This is
historical evidence and does not replace the current-candidate checks above.

The cutover verifier, `npm run verify:cutover -- --help`, provides content-free equality and
service-state checks for an attended rehearsal. Its exit result must be recorded before any
rehearsal or final-cutover claim.
