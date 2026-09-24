# Due Good — Implementation status

Durable, factual record of what has actually been built and verified, phase by phase, against
`docs/IMPLEMENTATION-PLAN.md`. This file is append-only across phases — a later phase adds its own
section rather than rewriting an earlier one — and every claim here must be backed by a check
someone can actually run locally (`npm run test:phase1` / `npm run test:all`), never a description
of intended behavior. `npm run check:implementation-status -- --phase <n>` enforces the two things
most likely to silently drift: that a phase's task list has no unfinished item left checked off
early, and that the test counts quoted below match what the test-membership manifest actually
lists — so this document cannot go stale next to the suite without the check catching it.

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
