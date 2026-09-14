# Due Good master implementation plan

## Outcome

Build a small, public, responsive student assignment tracker for Marymount Canvas that begins with one safe, consented course import and expands only after its persistence, sync, and student-state guarantees are proven. This is one four-phase plan. Each phase ends in a local commit; the commits are pushed once, after phase 4 and the complete pre-push suite pass.

## Current baseline

- The repository contains a specification handoff, synthetic fixtures, a legacy UI reference, and offline validation utilities. It has no application runtime, cloud resource, OAuth credential, or live Canvas proof.
- The supplied design-reference PNGs are local-only creative input. They are not source assets, test baselines, or public repository content. Do not commit them without a separate publication decision.
- Current provider research is captured here because the supplied handoff is not implementation evidence:
  - Canvas developer keys are institution-scoped, can be endpoint-scoped, and must be enabled by an account administrator; requested scopes must be a subset of the key's scopes. [Canvas developer keys](https://canvas.instructure.com/doc/api/file.developer_keys.html)
  - Canvas' authorization-code flow requires the application client secret, returns an authorization code to the registered redirect URI, and recommends an `Authorization` header for API calls. [Canvas OAuth2](https://canvas.instructure.com/doc/api/file.oauth.html)
  - Workers Free has bounded CPU, request, and subrequest limits; D1 reads and writes have enforceable daily limits. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)
  - Cloudflare's current Worker test integration is `@cloudflare/vitest-plugin`, which replaces the pool package and supports local Worker/D1 tests. [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
  - The accessibility target is WCAG 2.2 AA, tested by automation and keyboard/screen-reader review rather than claimed by visual similarity alone. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

## Scope and exclusions

Included: a TypeScript Worker with static assets and D1 candidate architecture; server-held credentials; student-scoped reads and writes; a complete, non-destructive Canvas import; student-owned planning; responsive light/dark interface; local, mocked, and browser tests.

Excluded until separately authorized: Cloudflare account changes, database creation, deployments, domains, paid services, Marymount developer-key submission or use, real OAuth credentials, production Canvas calls, a public pilot, course-wide/gradebook data, Canvas writes, LLM features, notification services, and multi-institution discovery.

## Delivery and quality rules

1. Establish the Node/TypeScript toolchain and committed lockfile in phase 1. Use Git-native `.githooks/` rather than a hidden machine-only hook configuration. The bootstrap task sets `core.hooksPath` through an explicit `npm run hooks:install` command and verifies it.
2. Every normal commit runs `npm run lint` and `npm run deadcode` through `.githooks/pre-commit`. Neither hook is bypassed.
3. `.githooks/pre-push` runs `npm run test:all`, which includes type checking, linting, dead-code analysis, Worker unit/integration tests, browser tests, package checks, and an asset/secret scan. Before *every* local commit, the captain also runs a staged-diff/public-history scan and secret scan; this is a mandatory commit procedure, not an extra slow pre-commit hook. GitHub secret-scanning push protection remains an independent final guard. No push occurs until phase 4 is accepted and this exact command passes.
4. Make cohesive local task commits plus a phase-boundary commit on `main`; retain all commits locally until the final push. Before each commit, run the applicable focused checks, pre-commit checks, staged hygiene procedure, and integrity update/check. Do not amend or rewrite history in normal work. If a staged/history scan or push protection detects a secret or private record, stop, do not push or bypass it, rotate any exposed secret, and obtain owner direction for a clean local-history repair.
5. No remote operation, sync, browser run, or long command may be silent. The application reports user-visible progress without logging credentials, callback query strings, student data, or complete Canvas responses.

## Design direction derived from the supplied references

### Identity and theme

- Use a scholarly, restrained navy-and-gold identity. The reference palette anchors are Scholar Navy `#0E2A47`, Classic Gold `#B08D57`, Sage `#6A7F56`, Warm Stone `#F4F1E9`, Charcoal `#1F2937`, and Alert Red `#D64545`.
- Define semantic CSS tokens, not page-specific hex values: canvas, surface, elevated surface, text, muted text, border, focus, primary action, success, warning, danger, information, and course accents. Light and dark themes must use the same semantic names.
- Use Playfair Display only for brand/display headings and Inter for controls, metadata, and body text. The implementation must use a privacy-conscious, licensed font delivery strategy selected and verified when font assets enter scope; no unreviewed third-party font request is part of the first deployment.
- Treat the supplied DG monogram and quoted copy as visual inspiration only. Create no claim of Marymount endorsement, reuse of university marks, or copied quotation without an explicit asset/content decision.

### Information architecture

- Desktop uses a persistent side navigation, a compact top utility bar, and a responsive content workspace. The contextual rail is optional and collapses before primary content does.
- Mobile uses a compact header and five-item bottom navigation: Today, Timeline, Attention, Courses, and More. It contains only routes that are implemented and available to the current student.
- The initial usable slice is This Week, course selection, assignment list, assignment detail, and connection/sync recovery. Timeline, Needs Attention, Courses, Completed, search, personal greeting, quick actions, and personalization are full phase-4 screens unless needed as an accessible route to phase-1 work.
- Assignment detail keeps Overview, Steps, Notes, and History distinct. Canvas submission is a source fact; personal completion and steps are student-owned planning. Their controls, labels, filters, and announcements never imply one another.

### Component and accessibility constraints

- Provide design tokens, an accessible button/input/dialog/list primitive set, course identity chip, assignment row, status badge, segmented/tab control, empty state, loading state, and error/recovery panel. Do not build a generic component platform.
- Status always has text and an icon or other non-color cue. Due, overdue, partial import, stale data, disconnected Canvas, quota exhaustion, and retrying sync have truthful distinct copy and programmatic status announcements where the state changes.
- Keyboard order follows visual order; focus is visible and unobscured; target size, contrast, reflow, reduced motion, headings, labels, and status messages are tested at the component and browser levels.
- Desktop and mobile screenshots test layout regression against repository-owned synthetic fixtures. The supplied PNGs are not golden images. The supplied reference files are committed to neither the tree nor its history; their explicit local ignore entries land with this planning checkpoint.

## Phase 1 — OAuth and Cloudflare foundation

### Goal

Create a secure local Worker/D1 vertical slice using synthetic Canvas responses. Authentication stays disabled unless every required configuration value is present; it never becomes a token-paste fallback.

### Work

1. Bootstrap TypeScript, Wrangler, local Worker/D1 testing, Playwright, linting, dead-code analysis, `.githooks/`, explicit scripts, and a checked-in lockfile. Build static UI source only into a dedicated asset directory configured in Wrangler; prove server modules cannot enter that browser bundle and no repository root directory is served. The test runner recognizes each added test file and the clean install prepares its pinned browser runtime.
2. Implement the minimum student/account/session/connection schema with an institution-scoped identity key from day one, server-only configuration boundary, authenticated encryption envelope with key version and account/connection/format associated data, exact redirect/origin allowlist, one-time browser-bound OAuth state, opaque session plus CSRF protection for every state-changing route, an auth-start rate bound, logout, disconnect, a deletion fence, and owner-scoped query layer. Set restrictive response headers, including a CSP that supports the static application without unsafe inline content, no-store/no-referrer for callback responses, frame protection, and MIME sniffing prevention. Prove cross-student access is rejected. Disconnect attempts the validated configured provider revocation while the credential is present, then destroys it and blocks refresh; it retains an authenticated student's planner locally. The owner must confirm that proposed product policy before any public pilot.
3. Implement a typed Canvas adapter with synthetic responses only: course discovery, selected-course assignment import with student-specific date overrides, lossless external-ID handling, validated pagination, staging, completeness checks, comparison, and commit. First compare bounded in-memory complete-snapshot and durable-staging strategies using synthetic small/typical/large profiles, then record the selected strategy. A complete snapshot becomes visible only by an atomic active-snapshot pointer swap; staging may span bounded requests, but a failed snapshot has no projection removal. Persist field presence and submission state as explicit supplied, null, unknown, or unsupported variants rather than inferring a non-submission. Phase 1 enforces configuration-derived request/page/query/row bounds, one resource lease and generation fence, and fails closed before an import needs an unsupported continuation. Anomalous/empty inventory follows a complete-versus-filtered/recheck guard before anything is marked unavailable. A malformed, partial, over-budget, unauthorized, or interrupted import preserves the last committed view and announces partial state.
4. Add the limited responsive visual foundation needed to understand connection, sync, course selection, assignment list/detail, personal completion, Canvas submission including unknown/unsupported state, and every recovery state. Render imported content as text only; do not accept rich Canvas HTML. It uses the design direction above but defers nonessential feature screens and decorative polish.

### Phase gate and commit

- Gate: local Worker/D1 integration tests cover OAuth/CSRF/rate-limit rejection, ownership boundaries including identical provider IDs at distinct institutions, disabled-auth behavior, encrypted credential storage, revocation ordering, exact outbound origin checks, restrictive headers, configured import ceilings, lease fencing, complete-vs-partial import behavior, lossless ID preservation, per-student date overrides, unknown/unsupported submission states, and assignment-state separation. Playwright covers responsive phase-1 journeys, text-only untrusted-content rendering, keyboard, axe-based automated checks, and accessibility-tree assertions. These are not a claim of human screen-reader verification.
- Commit: `Phase 1: safe Canvas foundation`.
- Evidence boundary: mocked and local Worker/D1/browser checks only. Cloudflare deployment and Marymount OAuth remain unverified.

## Phase 2 — Sync durability and budget controls

### Goal

Make refresh bounded, idempotent, resumable, and honest under free-tier limits without promising background synchronization.

### Work

1. Add source snapshots, stable projections, change history, resource-level freshness, resumable continuations, bounded retries, durable lease/generation fencing, safe encryption-key rotation, and opportunistic expiry cleanup for abandoned staging/checkpoint rows. Maintenance cleanup may delete only expired, uncommitted rows by a server-side predicate, returns no other student's data, and is independently tested for tenant opacity. An old job cannot overwrite a newer commit. User-visible in-flight sync progress uses one bounded server-to-client status stream; it does not poll or multiply refreshes across tabs.
2. Add per-profile synthetic workload reports and documented-ceiling request/row/storage accounting, bounded retention for snapshots and history, a small pilot admission cap, no-op minimization, on-open/manual refresh cooldowns, explicit new-auth and sync kill switches, and a read-safe quota-exhaustion state. Reconcile assumptions with the existing estimator. Local tests validate conservative admission behavior only; they do not measure Cloudflare CPU or certify account capacity. Do not add cron, queues, or paid services.
3. Test duplicate work prevention, cancellation/deletion races, refresh-token omission preservation, pagination failure, quota exhaustion, connection loss, and concurrent personal actions during a refresh.

### Phase gate and commit

- Gate: deterministic local concurrency and failure tests demonstrate that an incomplete import never deletes tasks or reports a full refresh, that abandoned staging is bounded and cleaned opportunistically, and that budget exhaustion cannot become a silent data-corruption path. Live Cloudflare measurement remains a public-pilot gate.
- Commit: `Phase 2: durable bounded sync`.
- Evidence boundary: local measured scenarios only; account-level Cloudflare quota and live Canvas behavior remain unverified.

## Phase 3 — Generalization and student planning

### Goal

Remove personal-course assumptions while preserving the distinction between imported facts, student planning, and unaccepted suggestions.

### Work

1. Generalize identifiers, institutions, courses, terms, deadline representations, source aliases, time zones, and unknown/omitted fields without a destructive migration. The phase-1 institution-scoped key remains stable. Any unavoidable SQLite/D1 table rebuild uses a local-tested programmatic migration runner with replacement table, bounded copy, verified count/foreign-key checks, a migration journal, and retained original rows until verification succeeds.
2. Add personal tasks, notes, display-title overrides, target work dates, subtasks, dismissals/exceptions, undo, reviewable changes, operation IDs, expected versions, and mutation receipts. Canvas refreshes cannot overwrite these fields; replayed or stale personal mutations cannot duplicate or overwrite them.
3. Add deterministic accepted rules/checkpoints only where their inputs, source, scope, and exceptions are visible. Re-running or editing an accepted rule must preserve stable children, student edits, and parent/child progress without double counting. Support safe term rollover without hiding an ended-term course that has outstanding work. Do not parse arbitrary syllabus prose into mandatory work.
4. Expand the local/browser suite with different course loads, date zones, submission states, personal exceptions, source removals, and two-user isolation cases. Account-isolated offline pending writes remain a phase-4 feature.

### Phase gate and commit

- Gate: tests prove that a deadline/source update preserves student notes and that conflicting facts/plans produce a review state rather than destructive merge.
- Commit: `Phase 3: generalized student planning`.
- Evidence boundary: synthetic multi-course data only; no claim of multi-institution or live Canvas support.

## Phase 4 — UI, accessibility, and offline experience

### Goal

Apply the complete design direction to the proven data and sync behaviors, then validate every screen and state on desktop and mobile.

### Work

1. Complete light/dark theme tokens, the restrained typography and course/status system, responsive shell, search, settings, and accessibility primitives. Pin the browser/rendering environment and a reviewed self-hosted-or-system font strategy before committing visual baselines. Preserve the phase-1 state vocabulary and never turn stale/partial data into reassuring but false copy.
2. Implement Timeline, Needs Attention, Courses, Completed, daily/weekly views, assignment detail tabs, guided personal steps, quick actions, and status/history affordances from the reference direction.
3. Implement a locally durable edit queue with account isolation, bounded storage, visible pending state, quota/eviction detection, CSRF/session revalidation before replay, replay/conflict recovery, logout cleanup, and no browser storage of Canvas credentials. Offer an account-scoped export before deletion without making export success a deletion prerequisite; test export, deletion, disconnect, and retained planner policy using synthetic data only.
4. Add Playwright coverage for every reachable desktop/mobile screen, control, role/permission state, disabled/recovery state, focus path, reduced-motion behavior, and synthetic visual regression baseline. Produce the dated candidate-current screen-by-screen walkthrough before any deployment trigger; record human screen-reader and nontechnical-pilot checks as external public-pilot evidence, not automated-test claims.

### Phase gate and final commit

- Gate: `npm run test:all` passes locally, including full browser coverage; the secret/asset scan is clean; the walkthrough covers the exact candidate; and the final code review records remaining external gates.
- Commit: `Phase 4: accessible student workspace`.
- Only after this gate does the pre-push hook run. If it passes, push all four phase commits once to `main`.

## Red preflight: external gates

These do not block local mocked development. They block staging and live OAuth/deployment:

1. Cloudflare account and free-plan confirmation, stable HTTPS origin, and any D1/Worker creation are owner-authorized external changes.
2. Marymount developer-key approval, exact redirect URI, endpoint scopes, and credential delivery are institution/owner authority. Credentials must enter only through the approved secret broker and remain out of source, tests, logs, and chat.
3. A privacy/support/retention policy, owner confirmation of post-disconnect planner access, export/deletion evidence, human accessibility walkthrough, nontechnical-pilot feedback, live OAuth test, and real Cloudflare free-tier workload evidence are required before any public pilot.

## Definition of done for this plan

The plan is complete when the four phases are accepted in order, each has its local commits and evidence boundary, the final pre-push suite is green, the single final push succeeds, and outstanding Cloudflare/Marymount/public-pilot gates are reported separately rather than claimed complete.
