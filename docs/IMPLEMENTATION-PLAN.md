# Due Good local Marymount replacement plan

## 2026-09-25 bounded temporary-stage cleanup

**Confirmed:** the old stage command created an implicit `duegood-tauri-stage-*` root without reclaiming it; the macOS UI smoke also created a `duegood-tauri-ui-smoke-*` root. The smoke exit paths and backlog were inspected before remediation.

**Verification:** source audit found the smoke's previous skip-on-app-termination-failure path, and the initial dry-run found 44 matching roots, of which 39 were eligible (110,996,790,822 apparent bytes); the other five were younger than two hours. The initial exact staged tree `f4458e6530b0` passed `test:all`, then its implicit root was absent. Hours later the owner authorized `--apply`; all five had aged past the freshness floor, and the guarded run removed all 44 matching roots, measuring 101.01 GB of pre-sweep allocated footprint, with no skips or failures. Synthetic stage, smoke lifecycle, and collector tests now cover the cleanup paths. The native macOS UI smoke itself was not run.

1. Make implicit stage roots disposable on normal return, exceptions, SIGINT, and SIGTERM; retain explicit `--destination` and opt-in `--keep` roots. Update callers that require a post-command stage.
2. Audit the smoke runner's cleanup across every exit path and repair any gap.
3. Add targeted lifecycle regressions and a fail-closed, dry-run default backlog sweeper for only those two direct-child prefixes, with a two-hour freshness floor and canonical `lsof` held-path check. The original task excluded `--apply`; the owner separately authorized the later sweep.
4. Wire tests into membership, run focused checks and the authoritative staged gate, then report the dry-run eligible total separately from disk-audit estimates.

## 2026-09-25 calendar date display correction

The installed iCal-first app showed Sunday date-only assignments on Saturday at 8:00 PM in New York. A synthetic reproduction confirms that JavaScript parses `2026-09-27` as UTC midnight, while the timeline uses local date and time accessors. Keep iCal `VALUE=DATE` as a calendar day, not an instant. Correct the embedded dashboard's date parsing so date-only values render and group on their stated day without an invented 8:00 PM deadline. Preserve explicitly timed values and countdown behavior. Add focused UI and desktop regressions, then run the staged candidate gate before an installed update. Do not read or publish private coursework to diagnose this.

## 2026-09-25 correction: clean iCal first run

The owner rejected the legacy-folder import as the normal first-run path. The iCal feed is a separate BWS secret from the Canvas API token. Preserve the legacy source and any existing native store, but bootstrap a new authoritative native store directly from one validated iCal fetch when the app store is empty. Do not require a Canvas API token or legacy import. A damaged, preview, or authoritative store is never overwritten by bootstrap.

**Confirmed:** the fixed iCal BWS consumer and native receiver exist; the current normalizer requires an imported course map and the native store is empty. **Changed:** the earlier import-first cutover sequence below is superseded for a clean first run. **Not applicable:** Canvas API token as a prerequisite for calendar setup. **Not verifiable yet:** a live feed import into an installed candidate and owner acceptance; synthetic tests cannot prove either.

Implement in this order: (1) derive bounded course identities from validated links on the fixed Canvas origin and use a stable local key; hold unsupported events; (2) stage a minimal coursework document, course map, and manifest, then atomically adopt it only if the store is still empty; (3) reuse native iCal reconciliation for the first import and later refresh; (4) replace the empty-state legacy setup UI with a calendar connection action and content-free progress, while retaining recovery for damaged stores; (5) run staged Rust, UI, and headless desktop gates. Course labels may initially show Canvas course IDs because an iCal feed is not an authoritative source of course names, grades, messages, or prior student progress. The legacy source remains a private recovery reference, not an onboarding dependency. Live port handoff and installed-app acceptance remain separate gates.

## 2026-09-25 owner pivot: Tauri-only daily application

The owner has now selected the Tauri desktop application as the sole product surface and asked to remove the browser/Worker lanes and the normal-path one-time setup screen. This supersedes earlier browser and Cloudflare delivery goals below. Preserve the running local service until a verified native cutover because it currently holds the only live iCal fetch/import path and the production Tauri store is empty. A desktop WebView and `dist/public` are required Tauri assets; they are not a separate browser product.

### Reconciled findings

- **Confirmed:** the installed production bundle runs as `com.zerodelta.duegood`; its fixed app-data folder has no `store` directory, so Tauri shows first-run setup. Tauri embeds `dist/public` and uses native IPC for dashboard reads and writes. The loopback service owns current live iCal fetch/import and a distinct coursework file.
- **Changed:** the earlier local server and Cloudflare Worker product lanes are retired goals. Native coursework and calendar parity now precede deletion of those lanes. Setup should be a recovery or migration action only, not the default daily screen.
- **Not applicable:** public browser onboarding, Worker/D1 deployment, Cloudflare OAuth, and browser service release gates.
- **Not verifiable yet:** installed Tauri acceptance with live coursework, repeat iCal refresh into the native store, and safe termination of the old writer. No claim of those outcomes is made from tests or source review.

### Implementation phases and gates

1. **Native parity:** add a narrow `127.0.0.1:2137` POST receiver inside Tauri for the existing SHA-pinned BWS helper. Give each helper launch a fresh CSRF token; reject all other requests before reading bounded calendar bytes. Normalize and reconcile in Rust, then write only through the native store lock. Keep the existing Node listener running until the attended port handoff. Test recurrence, time zones, duplicate IDs, malformed feeds, pending links, repeat imports, and preservation of personal progress. Provide content-free progress and error states in the desktop interface. If the existing helper cannot run from Tauri or a faithful Rust normalization proves disproportionately large, prepare a new hash-pinned native IPC consumer for explicit owner approval rather than allowing a second writer.
   - Native parsing deliberately holds ambiguous and nonexistent local times at daylight saving transitions instead of choosing an instant. The former Node normalizer resolves those cases, so this is a reviewed fail-closed cutover difference; held events require source review rather than a guessed due time.
2. **Migration and setup:** rehearse import from the current private coursework root into a preview native store, prove exact source preservation and a rollback export, then make the daily dashboard the launch view once native data exists. Preserve a recovery/migration route for empty or damaged stores until an owner-attended cutover verifies the real data. Do not auto-promote a preview to authoritative or silently adopt a private source.
3. **Remove browser lanes:** after parity and cutover, stop the browser service and its writer; remove the Worker entry/config/migrations, local HTTP dashboard, browser transport, browser-only tests, scripts, and unused dependencies. Keep `src/ui`, `dist/public`, native UI tests, and any shared code they need. Revise README, status, invariants, task/history records, test membership, and public-tree inventory to match.
4. **Exact-candidate gate:** run focused source/security tests, TypeScript and Rust checks, desktop UI coverage, asset verification, staged Tauri build, installation through the project installer, bundle-ID launch, and content-free native status checks. Report mocked, staged, installed, and live-feed results separately. No public push, cloud deletion, secret grant change, or irreversible production-store operation is authorized by this pivot.

## Outcome

Replace the private Marymount coursework page with a local Due Good app. The immediate sequence is: capture the private contract read-only, build and verify the local source/server against public synthetic tests and the private document read-only, add the daily interface and fixed refresh control, then rehearse and perform a reversible launcher cutover. Cloud UI, OAuth, Cloudflare, and a separate Due Good model credential path are deferred and do not block the local replacement.

## Authority and evidence boundaries

- David's current local-replacement instruction overrides the repository's earlier cloud-first ordering. The first implementation documentation task records that override in `AGENTS.md`; it does not weaken any security, privacy, ownership, or testing rule.
- The current ship instruction authorizes committing and pushing the tested source candidate to public `main`. It does not authorize deployment, Cloudflare mutation, or the live Canvas/Task 5.1 cutover, which remains paused pending institution token access. The owner explicitly approved local retention of Canvas Inbox metadata and activation of read-only Inbox synchronization on 2026-09-20.
- `workers_dev: false` proves only that the default public route is disabled. It does not prove that production secrets, D1 rows, or credentials were deleted. This plan performs no production query or mutation; any retention, revocation, deletion, or re-enablement decision is a separate Red owner action.
- The legacy server, exporter, reconciliation script, original tests, and private coursework document are not repository evidence. Before local adapter work, an attended host-only preflight must inspect them read-only and produce only a synthetic schema/behavior contract. No real coursework, grades, names, schedules, messages, credentials, private paths, or provider responses enter Git, prompts, logs, fixtures, or container mounts.
- The untracked `main` file is owner state and remains preserved. This reviewed document is the owner-modified in-repository plan of record; Task 0.1 adopts its exact bytes into the integrity baseline before any application edit.

## Verified repository and host baseline

- The Worker exposes an authenticated, CSRF-protected `POST /api/connections/:id/courses/:courseId/import` route. Import outcomes are discriminated by the JSON body, not HTTP status alone.
- The owner-scoped course list exposes course identity and sync state. The current UI reads only the first course and has no import trigger.
- The current browser suite shares seeded Worker state, so Sync-now browser tests must intercept the client APIs rather than mutate that shared database. Worker tests exercise the real route with a mocked server-side fetch.
- `test:all` now includes the Node local-source suite. Container qualification remains an explicit host-only gate.
- OrbStack Docker is available on Apple Silicon. OpenCode CLI `1.18.30` reports `opencode-go/deepseek-v4.1-flash` with the `high` variant. The provider does not expose an immutable backing-model digest, so each run must record and compare the CLI-reported model metadata; this detects observed drift but cannot prove provider-side immutability.
- No reviewed reusable container kit or Due Good-specific OpenCode BWS consumer exists.

## Canvas iCal fallback — Task 1.1 verified scope

- **Confirmed:** `CourseworkStore` is the local JSON reader/writer; it validates immutable item IDs and preserves arbitrary document fields when it writes a personal completion or discussion mark. `captureCanvasSnapshot` currently selects `source === "canvas"` or `canvasId` records, and its Activity diff keys on local IDs. `DashboardStore` is projection-only, and the native export test round-trips the coursework JSON through `CourseworkStore`.
- **Changed:** the reviewed fallback plan names `src/local/acquisition.ts`, but that module and its focused test do not exist in this checkout. Task 1.1 will add only a synthetic, source-neutral observation merger there; it will not parse iCal, fetch a feed, or alter the browser API.
- **Not verifiable:** the private reconciler, live feed behavior, and private source shape remain unavailable and are not inspected. The source-reference contract therefore uses only synthetic fixture evidence.
- **Task 1.1 implementation boundary:** add scoped references and field-owned observations without changing local IDs; deterministically backfill references for existing `canvasId` records; reject duplicate references; hold ambiguous cross-source candidates; preserve personal and unknown fields; and make repeat imports byte-identical. Provenance-only changes do not produce Activity changes.

## Architecture decisions

1. **Host orchestration and source boundary.** Sol remains the host orchestrator. For each Linux-safe task, the host records the accepted tracked working tree as an immutable Git tree object using a host-controlled temporary index, excluding untracked owner files, then materializes that exact tree with `git archive` into a new disposable source directory. This requires no commit and carries accepted output between tasks. The mounted source contains no `.git` directory or file. Host-owned clean and changed trees are compared with system/global Git configuration disabled, external diff and textconv disabled, and no project-controlled executable invoked.
2. **Executor identity.** Build a Linux/arm64 image from digest-pinned bases with OpenCode `1.18.30`. Run the executor with a fixed non-root UID/GID, no supplementary groups, all capability sets empty, `NoNewPrivs=1`, seccomp enabled, a read-only root filesystem, and writable tmpfs only where proven necessary. The exact model and `high` variant are explicit; autoupdate, sharing, default plugins, tool-driven web access, subagents, external directories, and interactive questions are disabled.
3. **Network boundary.** Build Stripe Smokescreen from a pinned source revision in a digest-pinned Go build image; do not depend on an unreviewed third-party container. Run it non-root and capability-free. The executor joins only an internal Docker network; Smokescreen alone is dual-homed. Runtime policy is enforce-mode hostname allowlisting, port 443 only, plus default non-public-address denial and injected denies for every discovered host, Docker/OrbStack gateway, DNS, LAN, VPN, and global IPv6 address. A separate preparation policy permits only lockfile-declared HTTPS registries and source hosts. Direct executor egress, SOCKS, arbitrary TCP, HTTP port 80, TLS interception, and proxy administration are absent.
4. **Persistent concerns.** Source is disposable. Credential, per-project session, and dependency-cache volumes are separate. Credentials mount read-only during an agent run. Caches are namespaced by executor-image and lockfile digests, contain only package-manager content-addressed data, undergo integrity verification, and never supply executable helper paths.
5. **Execution route.** The project-contained executor remains credential-free evidence. The now-working owner-approved Switchyard/PlanRun route handles later bounded implementation tasks; a separate Due Good model credential is no longer a local-app prerequisite.
6. **Progress, stop, and recovery.** The runner emits sanitized heartbeats, records attempt/deadline state, sends bounded graceful then forced termination, proves the container is gone, and preserves only bounded session/recovery evidence. It checks free disk before launch and removes expired disposable sources, task caches, and layers after verified patch export.
7. **Patch handoff.** The host exporter rejects empty patches when changes are required; symlinks, submodules, special files, absolute or traversing paths, out-of-scope paths, unsafe patch headers, unexpected file-count deltas, and any source whose baseline tree OID differs from the task contract. Integration requires the canonical tracked-tree OID, recomputed through the same temporary-index procedure, to equal the recorded baseline exactly; a merely cleanly applying patch is insufficient. Untracked owner files remain excluded and untouched. Host tests run again after explicit integration.
8. **Local UI contract.** The local server presents the existing source-neutral assignment and completion API to the browser, so the daily interface uses the verified local document without cloud authentication or Worker import calls. The fixed refresh control exists only when the launcher explicitly enables it.
9. **Local concurrency.** The local document version is the SHA-256 of the exact bytes read, never a field added to the private file and never mtime. Completion and refresh commits take the same advisory lock on a dedicated persistent lockfile adjacent to the coursework document; the lockfile is never the atomically replaced data file. A write re-reads and compares the hash, creates its temp file beside the target on the same filesystem, fsyncs the file, atomically renames it, then fsyncs the parent directory. The local server binds the contract-selected loopback port so both servers cannot run concurrently. Port exclusion covers servers only; the private preflight identifies every non-server writer, cutover disables standalone writers, and the byte-hash conflict path detects an unexpected write.
10. **Refresh supervision.** A fixed host supervisor owns the shared lock, subprocess group, bounded progress, deadline, staged refresh output, and terminal receipt. The refresh child never writes the authoritative document directly; the supervisor validates and commits its staged output under the same lock as completion changes. The OS releases the lock on supervisor death; a restarted server can distinguish an active supervisor from an abandoned receipt without deleting a live lock. The attended private preflight verifies the real broker and fixed-consumer identity. Before the legacy server stops, the attended cutover proves the exact non-TTY spawn shape and failure handling against the disposable copy; a real Canvas refresh remains separately Red-authorized.
11. **Local browser boundary.** The local server accepts only the injected loopback Host value, rejects cross-origin `Origin` and non-local `Sec-Fetch-Site` requests, and requires a launch-scoped CSRF token for every mutation. Tests cover DNS rebinding, hostile browser origins, missing/invalid CSRF, and valid same-origin requests.
12. **Approved dashboard contract.** The owner-approved mockups are the production target: a dark-default interface, equal-height consecutive calendar days, stable course lanes, multiple same-day items, directly visible assignment completion, discussion-specific post/reply checks, and eight reachable pages (Timeline, Grades, Inbox, Completed, Courses, Library, Activity, More). Assignments, class sessions, Canvas-reported scores, library metadata, refresh history, and local progress state come from the private local source. Grades remains read-only and never infers a weighted or final course grade. Synthetic records never appear in the live UI.
13. **Read-only Inbox.** Canvas Conversations are fetched account-wide; each single-conversation detail GET sends `auto_mark_as_read=false` (the list-conversations GET does not send this parameter). Due Good implements no send, reply, delete, archive, star, or mark-read mutation. Same-origin pagination, request/time/count limits, inert-text normalization, credential-value redaction, explicit safety-limit flags, and incomplete-snapshot merge prevent credential disclosure, silent clipping, and false removal while preserving ordinary URLs as visible text. Activation uses the existing fixed BWS consumer only after the private wrapper and every imported sync source are hash-pinned.

## Phase 0 — Qualify the isolated executor (complete, not a cutover dependency)

Adopt this file's exact reviewed bytes into `SHA256SUMS`, then implement the project-contained image, Smokescreen policy, host runner, lifecycle controls, safe exporter, disk retention, and automated isolation suite. The Switchyard worker authors the files without Docker access; the host captain alone builds images and runs container/network qualification. Add a named `test:container` runner, a concrete executor-receipt verifier, and a `container` membership category. Every later executor task checks a lightweight environment fingerprint; any image, proxy, route, DNS, VPN, LAN, OrbStack, Docker, model-metadata, or policy change requires the route-sensitive qualification suite again.

Gate: the credential-free containment suite passes. A live model request is deferred because Switchyard/PlanRun is the active implementation route.

## Phase 1 — Cloud Sync now interaction (deferred)

This cloud-facing increment is outside the local replacement path. It remains available for later product work but no local task depends on it.

## Phase 2 — Capture the local legacy contract (implemented)

In an attended host-only, read-only preflight, inspect the current private launcher/server/exporter/reconciler, document shape, stable identifiers, all server and non-server writers, refresh broker, bind address/socket options, and rollback command. Generate a reviewed synthetic contract fixture with no derived personal values. Establish that a private loopback port is externally injected without recording its value, and record which legacy components are retired, retained only as supervised children, or used only for rollback. If the stable ID, completion-field, writer, refresh-consumer, or preservation assumptions differ, revise the plan before local-adapter edits.

Gate: private sources remain outside Git and provider prompts; a redacted receipt identifies only checks passed/failed; the synthetic fixture and contract tests are owner-reviewed.

## Phase 3 — Build the local source adapter and server (implemented vertical slice)

Add a Node build pipeline, Node-specific Vitest config, `local` membership category, and `test:local` in `test:all`. Implement the byte-hash concurrency token, shared adjacent lockfile, same-directory temp replacement including parent-directory fsync, unknown-field/order preservation, externally required loopback port with no personal default, Host/Origin/fetch-metadata/CSRF enforcement, body/static-path limits, and crash-recoverable refresh supervisor. Automated tests inject an ephemeral port. The local API implements the `CourseworkSource` contract and never accepts arbitrary paths or commands.

Current gate evidence: built-server launch, 22 local tests, exact-byte conflicts, duplicate IDs, unknown-field preservation, same-directory atomic replacement with file/directory synchronization, Host and CSRF rejection, private-document read-only compatibility, refresh failure/recovery, launcher exclusion, and headless completion/discussion walkthroughs all pass.

## Phase 4 — Run the interface on the local source (implemented vertical slice)

The local server supplies the existing source-neutral browser API, with no cloud authentication or Worker import call. The UI renders current assignments, truthful sync age, personal completion, and an explicitly enabled fixed refresh control on desktop and mobile.

Gate: focused UI tests and one accumulated Playwright batch cover every reachable state/control on desktop and mobile; existing Canvas-source tests remain valid; local tests are present in membership and `test:all`; milestone-specific evidence checks pass.

## Phase 5 — Rehearse and cut over reversibly

Current status: live Canvas/Task 5.1 cutover work remains paused pending institution token access. The ship instruction covers committing and pushing the tested source candidate to public `main`; it does not clear this live-data gate.

Run mutation and refresh tests only against a disposable private copy. While the legacy server is still running, prove a Due Good launch on the captured bind address/port fails, then stop it and prove Due Good alone can bind. Prove the fixed refresh consumer can be spawned by the local supervisor in its non-TTY process context and that failure is bounded and redacted; do not perform a real Canvas refresh without its separate authority. Disable every standalone writer identified by the private contract; retained refresh code runs only as a supervised child producing staged output. Then run the real-file walkthrough read-only. After exact-candidate owner acceptance, update the private launcher and retain an inverse exclusive rollback command.

Gate: disposable-copy before/after preservation, two-process port exclusion, byte-hash conflict, power-loss limitation documented, refresh-supervisor recovery, exact-candidate full suite, working-tree public scan plus candidate-byte scan through a throwaway Git index, read-only real-data walkthrough, rollback proof, and owner acceptance.

## Phase 6 — Approved coursework dashboard and Canvas Inbox

Replace the vertical-slice This Week screen with the approved dark-default eight-page dashboard. Project the existing class sessions and assignments into real calendar-day rows and stable course lanes; expose assignment completion and discussion post/reply progress directly on cards; show Canvas-reported scores and points in a read-only Grades page without calculating a final course grade; project the already-sanitized course exports into Library; project the private refresh ledger into Activity; preserve the local coursework document as the sole progress authority. Add a bounded Canvas Conversations sync and private full-thread snapshot that never changes Canvas state, silently clips ordinary content, or removes retained threads after an incomplete fetch.

Gate: descriptor tests, local store/server tests, Canvas conversation normalization/sync tests, test-membership coverage, typecheck, lint, browser tests for every route at desktop/mobile widths, public-tree scan, read-only live-source walkthrough, and explicit owner approval before account-wide Inbox capture is enabled or run. Owner approval was recorded and the protected live sync completed on 2026-09-20 with 10 threads and zero rejected records.

## Phase 7 — Tauri desktop application (single authority)

The owner approved a single-authority design on 2026-09-22: after this phase's attended, reversible
cutover, the Developer ID-signed macOS Tauri 2 desktop application is the only writer of the owner's coursework
data and its Canvas refresh. Source stays structurally portable to Windows and Linux; refresh remains
unavailable on those platforms until a native synchronization path exists there. Browser mode keeps its
existing HTTP, Host/Origin, and CSRF behavior; desktop mode uses narrow Rust commands instead.

The desktop app owns a fixed application-data store keyed to its bundle identifier — not a configurable
location — holding the coursework document in the existing legacy on-disk layout plus a versioned store
manifest whose state is either `preview` or `authoritative`. Import reads only from a legacy root the
owner selects through a native folder picker for that run; it never remembers or reuses a prior
selection and never discovers a source by scanning. Import takes the same adjacent advisory lock the
legacy launcher uses, records before/after source digests, applies strict schema and identity
validation, and enforces caps that refuse the import outright and name the exact offending counts when
exceeded. A `preview` store is archived and then replaced by a passing import; an `authoritative` store
is never replaced by an import.

Promotion from `preview` to `authoritative` happens only as an explicit owner-confirmed action, and only
inside an attended cutover window with the browser service stopped. The rehearsal promotes the imported
store, runs one live refresh, and verifies it; a rollback drill then demotes that store to `preview` and
verifies refresh is unavailable. The final cutover re-imports through the archive-then-replace action and
promotes again.

Rust owns every mutating and privileged concern: file I/O, the adjacent lock, atomic writes, coursework
mutations, snapshots, full-fidelity rollback export, and the refresh subprocess. TypeScript projections
run only in the webview, over the raw bounded documents Rust commands return, and hold no independent
write path. Avatar bytes, library files, and clipboard operations go through bounded native commands
that resolve local resources by ID under the store root; nothing resolves a path supplied by the webview
directly.

The macOS refresh helper is a bundled Rust binary launched through a new dedicated fixed BWS consumer,
pinned to both its absolute path and its content digest. It enforces an origin and path allowlist,
bounded pagination and retry budgets, and credential-stripped, validated redirects; it performs only
read-only Canvas Inbox capture; and it refuses to run at all unless the store is `authoritative`.

All builds and all tests for this phase run against a staged copy produced by
`scripts/stage-tauri-candidate.mjs`; nothing here builds, tests, signs, or writes inside the live
checkout that serves the running browser app.

The phase ends with that attended cutover: rehearsal, rollback drill, final cutover, and retirement of
the legacy refresh consumer and its launcher entry points once the desktop app is accepted.

Gate: the staged full suite plus the Rust test suite pass; the live checkout's `dist` digests and
service PID are unchanged across every staged gate run; a headless smoke and a GUI smoke both pass under
a dedicated test bundle identifier, plus a launch-only check of the production identifier; and the owner
accepts the result.
Notarization, certification, deployment/publication, trust installation, and Windows and Linux installers stay outside this phase; any Windows build is unsigned. The current owner instruction separately authorizes committing and pushing the tested source candidate to public `main`.

## Red boundaries

- Any authoritative private-file write outside the already accepted completion workflow, except the
  desktop app's writes to its own store after owner-confirmed promotion to `authoritative` in Phase 7.
- Expanding the approved read-only Inbox capture to message mutations, additional data classes, or external storage.
- Any production query, credential revocation, D1 deletion, Cloudflare change, or re-enablement.
- Replacing the private launcher, except inside this plan's attended Phase 7 cutover authorized by the owner on 2026-09-22.
- Deployment or publication. Committing and pushing the tested source candidate to public `main` are authorized by the current owner instruction; this does not authorize the live Canvas/Task 5.1 cutover.

## Completion boundary

Completion requires the verified local contract, local source/server, daily interface, disposable-copy refresh rehearsal, exclusive launcher, rollback proof, and owner acceptance as the daily replacement. It does not require the deferred cloud Sync now increment or a separate Due Good model credential, and it does not establish cloud, OAuth, or public-pilot readiness.

Phase 7 completes when the desktop application is the owner-accepted daily replacement after its
attended cutover, with the rollback path proven. It does not require the deferred cloud Sync now
increment or a separate Due Good model credential, and it does not establish cloud, OAuth, or
public-pilot readiness.
