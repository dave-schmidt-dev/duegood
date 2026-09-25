# Due Good — Implementation status

## Current Tauri-only direction (2026-09-25)

The sections below preserve historical implementation evidence and mention retired Worker and
browser files. They are not current build or launch instructions. The sole product surface is the
macOS Tauri app; `README.md`, `INVARIANTS.md`, and the top of `docs/IMPLEMENTATION-PLAN.md` define
the active workflow. The production native store is still empty at the last content-free check,
and the existing Node listener still owns the live feed port during migration. A private staged
candidate passed 159 Rust tests with 3 ignored; 44 native UI contract tests, typecheck, lint,
and dead-code checks also passed. All 46 desktop Playwright cases then passed against the staged
Tauri UI, along with 175 legacy/local rollback tests. These are synthetic/source checks, not an installed native feed
refresh or owner acceptance. The old `check:implementation-status` command has been retired with
the Worker lane.

## Phase 1 — OAuth and Cloudflare foundation

### Evidence (local only)

- [x] Task 1.1 — Reproducible TypeScript Worker/static-assets shell, pinned Wrangler, local
      Worker/D1 testing via `@cloudflare/vitest-plugin`, Playwright, the test-path membership
      manifest (`test/test-membership.json`) and its checker, Git-native hooks, staged
      public-tree/secret and baseline-integrity controls.
- [x] Task 1.2 — Account/session/connection schema with an institution-scoped identity key,
      server-only configuration boundary, authenticated-encryption key ring with lazy
      re-encryption, exact redirect/origin allowlist, one-time browser-bound OAuth state, hashed
      opaque sessions with `__Host-` cookie attributes, CSRF-guarded mutation routes, and a
      pre-auth throttle that performs no D1 write.
- [x] Task 1.3 — OAuth state machine (slice e1), CSRF + mutation-route guard + rate limiters
      (slice e2), OAuth profile/routes/wiring (slice e3); `docs/OAUTH-REQUEST-CHECKLIST.md`.
- [x] Task 1.4 — Typed synthetic Canvas adapter, course import with atomic snapshot commit,
      inventory diff/anomaly guard, import lease + connection-generation fencing, four-state
      field/submission provenance (`known`/`known_null`/`not_returned`/`unsupported`), and the
      student-scoped personal-completion record and mutation route, distinct from Canvas
      submission state.
- [x] Task 1.5 — `docs/DESIGN-SYSTEM.md` token/behavior inventory; a `GET /api/courses` read
      (added beyond Task 1.5's own file list because no existing route exposed the persisted
      sync-status fields the design doc's truthful status line requires); the descriptor/`render()`
      component architecture (`src/ui/dom.ts`); the This Week
      route (`src/ui/app.ts`, `src/ui/pages/this-week.ts`, `src/ui/routes.ts`) and its five
      primitives (`assignment-row`, `assignment-detail`, `completion-toggle`, `sync-status`,
      `recovery-panel`); light/dark theme tokens and the responsive shell
      (`src/ui/styles/{tokens,shell,components}.css`); a non-browser UI contract test
      (`test/ui/phase1-trust-interface.test.ts`) plus five Playwright specs covering desktop/mobile
      viewports, keyboard operability, the completion round trip (including an injected mutation
      failure and its accessible retry state), and automated accessibility rules against both the
      populated route and two real recovery states.

Test counts as of this section (each hand-written figure is validated by
`check:implementation-status` against `test/test-membership.json`'s array lengths): **38** worker test files
(`npm run test:worker`), **2** UI contract test files (`npm run test:ui`), **11** browser test files
(`npm run test:browser`, run once as part of `npm run test:all`).

### Post-phase-1: Canvas Personal Access Token connect path

Owner-only escape hatch around the Marymount OAuth admin-approval dependency above — David hit the
"I need the admin to enable OAuth first" wall and chose a Personal Access Token path for his own
use rather than waiting on institutional approval. `AUTH_MODE=enabled` no longer requires an OAuth
`clientId`/`clientSecret` (`src/config.ts`); `POST /auth/canvas/connect-token`
(`src/auth/routes.ts`) verifies a pasted token via `GET /api/v1/users/self`
(`src/auth/personal-token.ts`) and connects it the same way `handleCallback` connects an OAuth
grant, minus a refresh token and a real expiry (both stored `null` — a PAT has neither). The OAuth
state machine, its routes, and this document's Task 1.3 evidence above are unchanged; nothing was
removed. A Personal Access Token is **not** scope-limited the way `CANVAS_REQUIRED_SCOPE` is — see
`src/auth/personal-token.ts`'s doc comment — which is the documented reason this stays a
single-owner path rather than general onboarding.

### Verified historical external evidence

| Evidence class | Verified state |
| --- | --- |
| Repository Canvas tests | Synthetic only; mocked `fetchImpl` calls do not establish live Canvas access. |
| Owner-local Canvas integration | Local read-only operation is documented in `README.md`; Inbox and profile approval and activation are recorded there, while live outcomes remain private external evidence that this repository cannot independently verify. |
| Production D1 configuration | A production database binding is present in `wrangler.jsonc`; the repository does not independently prove live provisioning or deployment. |
| Public Worker deployment | Not established; the public Worker remains offline. |
| Public Canvas OAuth | Not established; institution approval remains outstanding. |

### Remaining external gates

- [ ] Public Worker activation/deployment plus attended production acceptance remains outstanding.
- [ ] Marymount Canvas OAuth developer-key approval remains outstanding.
- [ ] Human screen-reader review and nontechnical-student pilot remain outstanding.

The production D1 database remains configured in `wrangler.jsonc`; the public Worker is offline
because `workers_dev` is false. Repository suites remain synthetic, and completed attended local
reads do not establish public OAuth onboarding or public cloud readiness. These three open items
remain owner/admin or human-review boundaries.

## Local Marymount replacement

### Canvas iCal fallback — Task 1.1

- [x] The local source contract now records scoped Canvas/iCal references and per-field source
      ownership without changing immutable local IDs or legacy `canvasId` values.
- [x] Legacy Canvas records are deterministically backfilled, duplicate scoped references are
      refused, and possible cross-source matches become bounded pending links instead of an
      automatic merge.
- [x] The source merge preserves completion, notes extensions, discussion state, and arbitrary
      unknown fields. No-op imports retain the exact local bytes, and Activity ignores provenance
      bookkeeping.
- Evidence is synthetic only: `test/local/acquisition.test.ts`,
      `test/local/coursework-store.test.ts`, `test/local/refresh-history.test.ts`, and
      `test/fixtures/ical-acquisition-contract.json`. This neither parses a feed nor establishes
      Canvas identity, live source compatibility, OAuth, or native cutover acceptance.

### Canvas iCal fallback — Task 1.2

- [x] A bounded local parser normalizes complete RFC 5545 calendar text into typed assignment
      parents, explicitly verified discussion checkpoints, and other calendar events. It maps
      courses through validated numeric Canvas course IDs or a bounded owner-supplied UID-to-course
      and stable-identity mapping. Unmapped changed UIDs stay held. Exact-origin resource links give
      stable identity across changed feed UIDs. The observed Canvas calendar-view form requires
      a matching course context, numeric resource UID, and resource fragment before constructing
      a canonical assignment or event link. It never assigns `canvasId` or fetches a URL.
- [x] Unknown or duplicate course identities, uncertain events, floating times, cancellations,
      and recurrence overrides are held. The result explicitly authorizes zero deletions;
      missing feed entries never imply removed coursework. Invalid timezones and incomplete or
      oversized calendars fail with content-free errors. The final parser passed synthetic tests
      and a disposable-copy live feed probe.
- [x] A content-free local shape check verified the live assignment UID, calendar-view URL,
      fragment, date, and course-context forms. The first live import accepted 57 assignments.
      One calendar event remains held because its classification was not independently verified.
      The private feed and credential-bearing URL stayed outside this repository and its logs.

### Canvas iCal fallback — Task 1.4 (guarded host fetcher)

- [x] A separate, disabled-by-default local trigger runs only the fixed
      `duegood-canvas-ical` BWS consumer. The executable rejects caller arguments,
      accepts the feed URL only in its injected environment, confines it to the
      expected HTTPS Canvas calendar path, rejects redirects, and bounds time and
      response bytes. Its broker-fixed loopback origin must match the service's
      launch origin before it fetches. Errors and progress contain codes/counts only.
- [x] Synthetic local tests passed in a private staged candidate. The same stage
      passed native, membership, lint, type, integrity, and other pre-browser gates;
      Playwright passed 76/76 with the host permissions Chromium needs.
- [x] The owner granted the exact hash-pinned BWS consumer. The private launchd service now
      has the iCal flags and three verified course mappings. A 2026-09-25 attended live fetch
      succeeded: 57 assignments persisted with iCal references, one unverified event stayed
      held, and the service remained healthy. The serving checkout required `npm ci` for its
      pinned runtime dependency before activation. Same-user loopback port occupation remains
      outside this local service's isolation boundary.

### Canvas iCal fallback — Task 2.1 (synthetic staged validation)

- Native Canvas reconciliation adopts only an exact legacy/scoped Canvas identity or an
      iCal `assignment:<Canvas-ID>` alias, retaining the existing immutable local ID, personal
      fields, extensions, and both scoped source facts. Conflicting candidates fail closed.
- A complete Canvas capture continues to archive missing Canvas work and respect ignored IDs;
      rolling iCal omissions remain active. Fresh API due facts include capture-time provenance,
      repeat captures are byte-stable, and native publish rebases only declared local-owned edits.
- Activity now keys source changes by local ID and exposes only visible source fields.
      Evidence is synthetic Rust coverage in `reconcile.rs`, `refresh.rs`, and `history.rs`; it
      does not establish a live feed, Canvas access, installed app, or cutover acceptance.
- A later disposable stage restored the pinned dependency cache and passed UI, type, integrity,
      membership, and Rust checks. This is local synthetic validation, not live cutover acceptance.

### Canvas iCal fallback — Task 3.2

- [x] The loopback Grades page accepts only an explicitly selected local PDF, bounds bytes before parsing and pages, text, rows, and processing time during parsing, and never stores the PDF, filename, or raw extracted text.
- [x] The pinned local PDF parser accepts only the deliberately narrow synthetic grade-report layout. Exact course-and-item matches are selectable preview proposals; unmatched or ambiguous rows require manual entry. Each confirmation saves one versioned local observation with PDF provenance while Canvas facts remain visible.
- Evidence is synthetic only: `test/local/grades.test.ts`, `test/ui/dashboard.test.ts`, and `test/browser/local-dashboard.spec.ts`. This does not parse a real Canvas report, establish Canvas grade compatibility, or alter a Canvas grade.

### Canvas iCal fallback — Task 4.2 (synthetic rehearsal; native cutover gated)

- The synthetic transition fixture covers override UID continuity, separate discussion
      checkpoints, a new course, an ambiguous held link, partial-feed retention, local manual/PDF
      grade observations, API adoption, repeat-byte idempotence, Activity, and the separate
      complete-API-capture archival rule.
- An enriched native layout now refuses the refreshable legacy export before it creates an output
      folder. A disposable native rehearsal instead demotes, creates a write-frozen exact export,
      restores that export into a separate disposable copy, and compares actual written bytes.
- This does not clear `owner:legacy-reconciler-compatibility`, `owner:ical-feed-shape`, a real
      PDF-layout acceptance, or the owner-attended native cutover. No live feed, PDF, credential,
      legacy Python code, or live coursework was used.

### Implemented and verified

- [x] Attended read-only inspection captured stable IDs, completion fields,
      writer inventory, refresh consumer, server boundary, rollback disposition,
      and the complete public field vocabulary without retaining private values.
- [x] `fixtures/local-coursework-contract.json` provides a wholly invented
      contract fixture with completion, submission, archive, null, ordering, and
      unknown-field preservation cases.
- [x] `CourseworkStore` reads the legacy document, validates unique identities,
      projects local assignments, checks the exact-byte SHA-256 before mutation,
      preserves unknown fields, and atomically replaces the document after file
      and parent-directory synchronization.
- [x] The required-port loopback server serves the existing Due Good interface,
      rejects hostile Host/Origin/fetch-site requests, uses a launch-scoped CSRF
      token, bounds request bodies/static paths, and supports read-only launches.
- [x] The local UI renders assignments and personal completion, plus the fixed
      `canvas-course-refresh` control only when explicitly enabled. The control
      was rendered but not invoked against Canvas.
- [x] **38** worker test files, **2** UI contract test files, **10** browser test
      files, 38 local Node tests, a built-server smoke, the public-tree scan, and
      private-document read-only compatibility pass.

### Daily dashboard expansion

- [x] The approved eight-page interface is implemented: Timeline, Grades, Inbox,
      Done, Courses, Library, Activity, and More.
- [x] Timeline days use consecutive visible slots, stable color-coded course lanes,
      and one continuous page scroll; multiple same-day items expand their day
      without nested lane scrolling.
- [x] Dark mode is the default regardless of operating-system preference. Every
      deadline card exposes a direct `Done` checkbox; discussion cards visibly split
      independently persisted `Main post` and `Replies` requirements from overall
      completion.
- [x] Grades projects Canvas-reported score, points, grade, grading time, assignment
      groups, and group weights from the private source. It is read-only and shows
      separate weighted indicators for graded work and whole-course progress while
      explicitly declining to label either indicator an official final grade.
- [x] The dashboard projects 100 dated items across three active courses, 187
      Canvas resources, and 17 refresh-history entries from the existing private
      local export without copying private content into this repository.
- [x] Canvas conversation normalization and bounded read-only synchronization are
      implemented and tested with synthetic fixtures. After explicit owner approval,
      the protected live sync completed with 10 threads, zero rejected records, an
      owner-only local snapshot, and no Canvas message mutation.
- [x] The private Inbox snapshot now retains all 21 messages across those 10 threads.
      No thread or message reached its explicit safety limit, ordinary URLs remain
      visible as inert text, and the mode-`600` file remains outside Git.
- [x] The owner-approved Canvas profile picture is imported read-only through the
      fixed broker, stored outside Git with mode `600`, and served to the sidebar
      only through a validated loopback path with initials fallback.
- [x] The candidate-current walkthrough in
      `docs/2026-09-21-DASHBOARD-WALKTHROUGH.md` covers every route, control,
      recovery state, mobile layout, and system-owned file handoff.

### Remaining cutover gates

- [x] Rehearse refresh supervision success, failure, progress bounding, and
      process-group timeout without invoking the real Canvas consumer.
- [x] Prove single-port exclusion, the exact candidate full suite, a persistent
      local service, an intact separate funding service, and a one-command dated
      rollback launcher.
- [x] Replace the private coursework launcher and open Due Good against the
      private document. The launch itself performed no authoritative write.
- [x] Owner acceptance followed use of the live page, persisted local progress,
      and real Canvas refresh history. This authorizes the attended repository
      publication checkpoint; it does not authorize cloud deployment.

## Desktop Phase 1

### Evidence

- [x] Task 1.0 — Establish a safe candidate build and repair baseline:
      `scripts/stage-tauri-candidate.mjs` (`npm run stage:tauri`) builds a
      scanned, exact-byte candidate set in a private `0700` staging directory,
      commits it in a throwaway Git repository with a fixed author/committer/
      date, and records a per-file SHA-256 and tree-digest receipt; its
      Playwright preflight fails early naming any missing pinned browser build
      without downloading one. `scripts/check-desktop-status.mjs`
      (`npm run check:desktop-status`) validates this section and the
      `docs/IMPLEMENTATION-PLAN.md` `## Phase 7` absence checks. The single
      stale `## Phase 7` section was replaced with the single-authority
      Phase 7 plan; the Red boundaries and completion boundary were scoped to
      it. Baseline repairs: `scripts/check_package.py` ignores `target/`,
      `.gitignore` excludes `src-tauri/target/` and `src-tauri/gen/`,
      `scripts/check-public-tree.mjs` allows `.png` under `src-tauri/icons/`,
      `scripts/check-baseline-integrity.mjs`'s `.gitignore` message is
      accurate, and `test/test-membership.json` gained a `fixtures` section
      plus both new local test files. Evidence: `npm run typecheck`,
      `npm run lint`, `npm run test:membership`, `npm run test:local`,
      `npm run check:package`, `npm run check:public-tree`,
      `npm run integrity:baseline`, and `npm run check:desktop-status` all
      exit 0.
- [x] Task 1.1 — Added the Tauri 2 shell and typed browser/native transport;
      implemented the Rust coursework store in the legacy layout, its
      `preview`/`authoritative` manifest, adjacent locking and second-instance
      denial, and strict legacy import with replace-preview archiving. Evidence:
      `src-tauri/`, `src/ui/transport.ts`, `src/local/dashboard-store.ts`,
      `test/local/tauri-documents.test.ts`, and commit `f7d4289`.
- [x] Task 1.2 — Added the read-only refresh contract and supervision, the
      content-free import dry run, five narrowly scoped desktop commands, mocked
      Tauri UI coverage, and the shared dashboard projection; Node/Rust store
      parity is covered by the synthetic fixture suite. Evidence:
      `docs/REFRESH-CONTRACT.md`, `src-tauri/src/commands.rs`,
      `src/shared/dashboard-projection.ts`, `test/browser/desktop-first-run.spec.ts`,
      `test/fixtures/`, and commit `f7d4289`.

Phase 1 acceptance evidence: the final fresh-stage `npm run test:all` gate
exited 0 at stage tree `5ff5d3aadd75`: 291 unit, 72 UI, 83 local, 47 Rust
tests plus 1 ignored child-helper test, and 39 browser tests; membership,
public-tree, integrity, desktop-status, and implementation-status checks also
passed. Afterward, the `eslint.config.js` `spikes/**` ignore and regenerated
`SHA256SUMS` passed lint, integrity, and the pre-commit hook before barrier
commit `f7d4289` (tree `dbdee5e4`). Repository Canvas coverage uses synthetic
fixtures. The attended host dry run opened the real legacy root and reported
counts only; it refused the root because it also contains unsupported project
entries, and copied and persisted no coursework. No live Canvas request or
refresh was performed for Desktop Phase 1.

## Desktop Phase 2 — Native local interactions

### Task 4.1 — Native source-link and local-grade parity

- [x] Native commands now resolve an explicitly selected pending source link or keep it distinct,
      only under the exact coursework-document digest the student reviewed. Confirmation retains
      the existing immutable local ID, Done state, notes, manual/PDF observations, and unknown
      fields; stale or invalid decisions leave the document unchanged.
- [x] Native local-grade edits write only a versioned `manualGradeObservation`; Canvas `grade` and
      `score` stay source facts. Canvas refresh preserves manual and future PDF observations.
- [x] The generated Tauri permission manifest, Rust handler list, typed transport, and dashboard
      controls expose the same explicit candidate selection and keep-distinct path in native mode.
      Evidence is synthetic Rust/UI coverage only; no live iCal feed or PDF was accepted.

### Task 2.1 — Local implementation

The accepted source candidate adds native assignment completion and discussion
post/reply progress writes to the fixed app store, with conflict checks against
the expected prior field value. These are personal local fields and do not
change Canvas submission state. Library actions accept resource IDs from the
dashboard projection, resolve only listed and manifested files under the
course materials root, open the supported safe file types with the system
handler, and use a native save dialog for other types. No webview-provided path
is accepted.

The app starts one private daily snapshot per UTC day in a background thread
when opening a ready store and after a successful import, retaining at most 14
snapshots. The dashboard stays readable and polls content-free files and bytes
copied counts until the snapshot completes or warns. Restore
validates the generated snapshot ID and archives the current store before
replacement. A snapshot failure leaves coursework available and shows a
content-free warning. Full-fidelity export copies the coursework layout and file bytes,
including unknown fields, to a new timestamped subfolder under an
owner-selected local folder; it excludes the desktop manifest, snapshots,
backups, staging data, and lock metadata. These commands do not make Canvas
requests, modify Canvas state, or send data off-device; refresh is unavailable.

Candidate evidence is limited to source and synthetic fixtures:
`src-tauri/src/commands.rs`, `src-tauri/src/resources.rs`,
`src-tauri/src/snapshots.rs`, `src-tauri/src/export.rs`,
`test/local/tauri-export.test.ts`, and the synthetic Rust test modules. The
phase gate and checkpoint review are recorded in the delivery record. The
exact staged source tree `16c83bb796b0` passed `npm ci`, `npm run test:all`,
and a separate `npm run test:tauri` on 2026-09-23: 291 worker, 77 UI,
84 local, 54 active Rust (2 ignored), and 53 browser tests. The staged tree
was clean under `git diff --check`. The live browser service remained on
PID 67821, and its public/local build digest remained
`3ddfca6f2306f0d6aa1f8ad5793e9614c22d75bfbd9c739651d29997f8d88370`.
One initial and one targeted remediation checkpoint review were completed;
the final source fixes cover snapshot failure visibility, browser command
coverage, a bounded native clipboard call, and export staging-file exclusion.
No real
coursework or private export was used as test evidence or copied into the
repository; source tests do not establish an installed app or live coursework
acceptance. The candidate-current screen and state walkthrough is
[`docs/2026-09-23-TAURI-PHASE2-WALKTHROUGH.md`](2026-09-23-TAURI-PHASE2-WALKTHROUGH.md);
it documents source candidate behavior and is not installed-app acceptance.

## Desktop Phase 3 — Rust Canvas refresh

### Task 3.1 — Local source candidate

The native app has a pathless, no-argument `duegood-refresh` helper. It reads
Canvas through a fixed-origin API client, validates pagination before attaching
the credential, and downloads allowed files and the profile image without
forwarding the credential. It captures course exports, materials, Inbox, and
profile into a bounded staged generation. The transaction takes a pre-refresh
snapshot, preserves local personal progress, records a history diff, and
publishes a generation through a journaled swap. A failed capture leaves the
store unchanged. An incomplete capture keeps prior items, suppresses removals,
and records an incomplete Activity event. The app starts the helper through the fixed
`duegood-desktop-refresh` BWS broker and forwards content-free progress; a
preview store cannot refresh. The availability check establishes local
prerequisites only and does not prove that a BWS consumer or Canvas credential
exists.

Evidence is limited to source and synthetic mock tests. No real Canvas request,
BWS invocation, live coursework import, installed app, or owner cutover has been
performed for this phase. Staged tree `52cc5f4f3a52` passed `npm run test:all`
(291 worker, 79 UI, 93 local, 113 active Rust, 59 browser), plus separate
`npm run test:tauri` and `npm run test:refresh` (9 synthetic cases). The
targeted remediation review found no remaining High or Medium issue. The
candidate-current source walkthrough is
[`docs/2026-09-23-TAURI-PHASE3-WALKTHROUGH.md`](2026-09-23-TAURI-PHASE3-WALKTHROUGH.md).

## Desktop Phase 4 — Signed local installation (native GUI gate passed)

The private staged Phase 4 tree `4212d03193be` passed `npm ci`, `npm run
test:all` (291 worker, 79 UI, 122 local, 115 active Rust with 3 ignored, and
59 browser tests), and a separate `npm run test:tauri`. A release build and
`npm run verify:tauri-assets` verified four frontend assets in both the bundle
and Tauri's runtime embedded table. The final app and bundled helper have the
configured Developer ID Application authority and pass strict `codesign`
verification. The corrected installer copied that app to `/Applications/Due
Good.app`, verified the copied signatures/assets/helper digest, registered its
production bundle identifier, and `open -b` returned successfully. The app
process started and created its empty production data root. No coursework was
imported or refreshed. The browser service remains on PID 67821 and the
combined `dist/public` and `dist/local` digest remains
`3ddfca6f2306f0d6aa1f8ad5793e9614c22d75bfbd9c739651d29997f8d88370`.

On an unlocked desktop, the isolated XCUITest passed folder selection, dry run,
preview import, Grades and Timeline navigation, a persisted completion edit,
unavailable refresh, Recovery, and relaunch using synthetic coursework. The
installed production-identifier launch-only XCUITest also passed first-run
setup, its canonical root report, and unavailable refresh. It removed only
three empty lock files and the phase-owned empty app-data directory after the
app exited. These gates used no live coursework or Canvas account. The Phase 4
GUI gate is clear; the installed Phase 4 app is still a local candidate, not a
live coursework cutover. The corresponding screen inventory is
[`docs/2026-09-23-TAURI-PHASE4-WALKTHROUGH.md`](2026-09-23-TAURI-PHASE4-WALKTHROUGH.md).

## Desktop Phase 5 — Attended authority transition (installed local candidate)

The source candidate adds a Rust-owned backup picker, exact portable-tree
comparison, one-use in-memory proof, native owner confirmation, guarded
promotion, private recovery copy before demotion, and a write-frozen rollback
export with equality verification. The app UI exposes these operations without
accepting a path or confirmation flag from the webview. A staged focused Rust
run passed 123 active tests with 3 ignored; focused UI tests passed 42 cases,
and installer upgrade tests passed 12 cases. A read-only specialist review
reported no High or Medium issue in the state transition. A targeted cutover
verifier review found two Medium gaps; synthetic tests now require layout
anchors and the app's fixed BWS broker path, with 12 focused cases passing.
The fresh exact Phase 5 stage `bffd25c8dd14` passed the integrated full suite
(291 worker, 82 UI, 130 local, 123 active Rust with 3 ignored, and 71 browser
tests), a separate Rust run, an isolated synthetic macOS UI smoke, signed
release build, embedded-asset verification, and strict app/helper signatures.
The reversible installer upgraded `/Applications/Due Good.app`, retained the
prior signed bundle, and verified the installed candidate metadata and helper
digest. A production-identifier launch-only XCUITest passed against the
upgraded app and removed only its empty first-run data root. The live browser
service and build digest stayed unchanged.

A content-free private preflight copied 146 layout files from the real legacy
source into an ignored private folder, omitting 43 unsupported root entries,
19 unsupported course entries, and 5 OS metadata files. The source was
unchanged during the copy; the Rust dry run refused the original and accepted
the prepared copy. This is preparatory evidence only: the owner-attended frozen
backup, credential broker, native transition dialogs, live Canvas refresh,
rollback drill, and final cutover remain open. No live Canvas request occurred.
