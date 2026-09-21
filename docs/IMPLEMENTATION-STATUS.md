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

Test counts as of this section (verified by `check:implementation-status` against
`test/test-membership.json`'s array lengths, not hand-maintained): **37** worker test files
(`npm run test:worker`), **2** UI contract test files (`npm run test:ui`), **10** browser test files
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

### External gates (not evidenced by this repository, and never claimed here)

- [ ] Cloudflare account creation, resource provisioning, and a live deployment. (Deliberately left
      unchecked — `check:implementation-status` hard-fails if this box is ever checked, since none
      of these four gates may be claimed done by an agent. This local replacement candidate has no
      current deployment evidence and leaves the cloud Worker offline.)
- [ ] Marymount Canvas OAuth developer-key submission and approval.
- [ ] Any live call to a real Canvas instance (every import in this repository's tests uses a
      synthetic `fetchImpl`).
- [ ] Human screen-reader review and a nontechnical-student pilot (the Playwright accessibility
      batch runs automated axe rules and accessibility-tree/keyboard checks only, per
      `docs/IMPLEMENTATION-PLAN.md`'s own distinction between those evidence classes).

These four remain exactly as scoped in `docs/IMPLEMENTATION-PLAN.md`'s evidence-boundary lines for
every phase — none of them is a phase-1-specific gap, and none is authorized to be marked done by
an agent. Cloudflare account setup and Marymount OAuth approval are the repository owner's own
actions.

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
      files, 37 local Node tests, a built-server smoke, the public-tree scan, and
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
