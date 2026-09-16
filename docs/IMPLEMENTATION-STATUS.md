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
`test/test-membership.json`'s array lengths, not hand-maintained): **34** worker test files
(`npm run test:worker`), **1** UI contract test file (`npm run test:ui`), **9** browser test files
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

- [ ] Cloudflare account creation, resource provisioning, and a live deployment.
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
