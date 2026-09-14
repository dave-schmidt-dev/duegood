# Due Good: product and engineering specification

Version 0.1 • September 13, 2026 • Specification, not implementation certification

## 1. Purpose

Due Good helps a student answer: **What do I need to do, by when, and what changed?** It begins with Marymount students using Canvas but should not assume a technical major, a specific instructor, or the owner's semester schedule. The name combines due dates and “do good,” with a light connection to Marymount's Saints identity. University approval or endorsement is not implied.

The intended product is a public, hosted, responsive website. Optional installation and offline use can follow. A student opens a link, connects Canvas, chooses courses, and sees useful work. No terminal, local server, API-key form, secrets manager, or customized LLM prompts belong in onboarding.

The owner requires **no personal recurring operating expense**. This is a design constraint, not a promise of unlimited free service. A bounded public pilot may temporarily stop new connections or fresh sync when its free resources are exhausted. Keep already saved information honest and accessible wherever technically possible.

## 2. Decision status and source boundaries

**Owner decisions:** name “Due Good”; repository slug `duegood`; public availability; Marymount first; no owner-funded recurring bill; OAuth and Cloudflare setup before optimization, generalization, and UI.

**Proposed implementation choices:** Cloudflare Workers with static assets, D1, server-side OAuth credentials, a small TypeScript backend, and an initially simple browser interface. Validate these through the phase-1 spike. They are not a report of provisioned infrastructure.

**External prerequisites:** Marymount developer-key enablement, approved scopes and callbacks, an owner-controlled Cloudflare account on the free plan, and a reviewed privacy/support plan. None has been verified as completed.

**Prototype evidence:** the uploaded HTML/CSS/JS and local launcher describe a personal timeline and a shared local server. Uploaded JSON demonstrates source tracking and personal completion decisions. The original server, Canvas exporter, reconciliation implementation, and tests are missing. The source review in `docs/06-SOURCE-REVIEW.md` distinguishes observations from proposals.

Current provider facts are attributed in `docs/SOURCES.md`; defaults and performance budgets below are recommendations to test, not provider guarantees.

## 3. Build order

### Phase 1: OAuth and Cloudflare foundation

Prepare institutional approval and establish a minimal free-plan deployment. Implement authentication, server-side credential handling, identity/ownership boundaries, basic storage, and a one-course import. First show a plain but usable course and assignment list. Prove denial/revocation and basic partial-failure handling. Do not call a mock OAuth connection “working Marymount OAuth.”

### Phase 2: Optimization and durable synchronization

Instrument the real workload, remove polling amplification, minimize unchanged writes, implement resumable bounded sync, manage throttling, and establish a tested operating envelope. Admission control must preserve the $0 requirement without undermining authentication or data integrity.

### Phase 3: Generalization and deterministic intelligence

Remove personal course/term IDs and local-folder assumptions. Support personal tasks, compound assignments, accepted rules, personal exceptions, different time zones, and course rollover. Expose missing or conflicting information instead of inventing certainty.

### Phase 4: UI, accessibility, and offline experience

Improve the daily experience, retain a semester timeline, make mobile/keyboard/screen-reader use dependable, and implement a locally durable edit queue. Optional app installation is not an onboarding prerequisite.

Security, non-destructive persistence, and correctness are phase-1 requirements. The sequence does not license an unsafe public prototype while those are “scheduled later.”

## 4. Three types of information

**Imported facts:** structured values returned for the authenticated student, such as assignment identity, published title, applicable due date, availability, and submission state. Each fact has provenance and observation context.

**Student planning:** personal tasks, notes, a display-title override, target work dates, subtasks, progress, and “not required for me.” A refresh cannot destroy or silently replace them.

**Suggestions:** possible tasks or dates inferred from instructions. They are not obligations until accepted. A deterministic rule can propose useful work without an LLM, but uncertainty must remain visible.

The central invariant is: **Canvas updates Canvas facts; student actions update student planning.** Apparent conflict creates a reviewable change, not an automatic destructive merge.

## 5. Core journeys

### Connect and choose courses

A student chooses “Connect Marymount Canvas,” authorizes on the institutional Canvas domain, returns to Due Good, and selects courses from the fetched list. Prefer current student enrollments while exposing an “Other courses” view for ambiguous/old shells. Preserve the student's selections; do not automatically hide a course with outstanding tasks just because a term ended.

Canvas credentials stay on the backend. The browser gets only a Due Good session. Identity is the institution plus Canvas user ID, not an email address or display name. Another Canvas school is a separate configured integration, not an arbitrary URL field.

### Open the tracker

Show the last saved tasks immediately when available, with a truthful freshness label. Trigger an on-open refresh only when the relevant cooldown has elapsed. A refresh of another course need not block viewing saved work. The initial product does not promise unattended all-day sync or instant notification of changes.

### Work through a task

The student can mark a personal state, add a note, create a subtask, or choose a planned work date without changing Canvas. “I finished this” and “Canvas received a submission” are visibly different facts. Online success is shown only after persistence; later offline work is shown as device-saved and pending.

### Resolve an exception

“Instructor canceled it,” “Not required for me,” and “Personal deadline” are student-owned actions with optional notes and an undo path. A refresh must not resurrect dismissed work as unexplained unfinished work. Material changes after dismissal produce a review notice, without overriding the dismissal.

### Disconnect or leave

Logout removes the app session; disconnect stops Canvas access and removes/revokes the connection; account deletion removes stored personal content and credentials. These are distinct actions. Explain whether saved coursework remains after disconnect. Offer export before destructive deletion. Cached device data must not leak into another person's account.

## 6. Import contract

Begin with structured course and assignment endpoints, including the current student's submission when supported. Apply the requesting student's assignment-date overrides. Include every pagination page before claiming a complete resource snapshot. Do not use titles or dates as primary identifiers. The Canvas API details and include-parameter caveat are recorded in the setup and source documents [C1–C5].

A stable source key is `(institution, connected student, course, resource type, source ID)`. Separate typed aliases can connect assignments, module items, quizzes, and discussion topics. Do not deduplicate by “looks similar.” Do not share student-specific assignment snapshots as public class data, even when course IDs match.

A sync resource goes through **fetch → stage → validate → compare → commit**. Completeness applies per course and endpoint, not just to one whole-account boolean. A failed page, malformed response, rate limit, authorization failure, size cap, or interrupted continuation leaves the previous committed snapshot intact.

An item missing from a genuinely complete current inventory may be marked “no longer available in Canvas.” Its task, notes, and history survive. Never infer removal from a filtered upcoming-only list, a rolling calendar feed, or an incomplete fetch. Do not label unavailability “canceled by instructor” without evidence.

Compare a stable projection of meaningful fields. Exclude local fetched timestamps and irrelevant ordering from hashes. Write changed source records only, plus bounded metadata. Record no-op sync freshness at resource level rather than updating every task's timestamp.

Use bounded retries for transient failures, with a finite request budget, cancellation, and backoff. Do not retry invalid authorization indefinitely. If a job cannot finish in one request, use an authenticated, server-validated continuation with persistent state. A browser tab is not a guaranteed background worker.

## 7. Deadline and status rules

Store timed deadlines as instants with the original source timestamp and relevant IANA time-zone context. Represent all-day dates and unknown dates explicitly. Do not reinterpret a timezone-free legacy string as UTC. Ambiguous old local times must be resolved or retained as legacy data pending confirmation.

Keep `due_at`, `unlock_at`, and `lock_at` separate. A deadline is not automatically the submission closing time. For timed tasks, overdue uses the actual current instant; it does not wait for the next calendar day.

A missing field is not always an explicit null. Capability flags and source contracts must decide whether omission means “not supplied,” “not applicable,” or absence of a submission. Do not manufacture a zero grade or “not submitted” from unsupported data.

Zero points does not mean optional. No due date does not mean “whenever.” A discussion submission does not prove that all replies are done. A task can be finished locally but still not submitted to Canvas.

## 8. Intelligence without a model

Use structured relationships, completion requirements where available, explicit checkpoints, and accepted templates. Examples:

- A discussion with separately exposed initial-response and reply requirements becomes one parent assignment with separately trackable child obligations.
- When only prose gives the split, a student can preview and accept “initial post Wednesday of the due week; two replies by the Canvas deadline.” The rule records its author, scope, time zone, week anchor, and exceptions.
- A studio student adds “Bring charcoal,” and a policy student adds “Find three primary sources.” Neither task needs a Canvas assignment ID.
- A new official checkpoint may supersede a template only after reconciling identities and preserving accepted/student-edited work. Conflicting personal evidence becomes a review item.

Do not parse every resource into homework. Do not promote syllabi or lab catalogs into mandatory work merely because they list activities. Later syllabus extraction may identify explicit candidates and source excerpts, but requires confirmation for ambiguity. It is not part of the setup milestone.

## 9. Architecture and zero-cost boundary

Proposed system: public static shell + authenticated Worker API + D1 + server-held secrets. A small codebase is preferred over a microservice platform. The browser never calls Canvas with an application-managed bearer token.

Use one stable HTTPS origin for the shell, API, and callback to simplify session handling. Assets contain code and synthetic demonstrations, never a student's JSON. Route authentication and API paths through the Worker even when the frontend has fallback routing.

Treat incoming Worker requests, external Canvas fetches, CPU, D1 rows read/written, staging writes, and storage as different budgets. A single fetch to Canvas is not another incoming Worker invocation, but it still consumes an outbound request allowance and Canvas-side capacity. Official free limits and the calculator assumptions are in `docs/02-SYNC-AND-BUDGET.md` [F1–F4].

Start with on-open/manual refresh and a configurable cooldown. Course-list discovery can run less often than assignment refresh. Deep module/syllabus enrichment is opt-in or infrequent. Do not attach an always-on job per student.

Set a deliberately small pilot admission cap. Keep service-wide kill switches, bounded history retention, limits on task sizes/counts, and abuse protection. No security guard should depend solely on a browser-controlled counter. No paid-plan switch, custom domain purchase, billable queue, or paid notification service is authorized.

When free capacity is reached, preserve saved data and show stale/offline status; an actual provider-wide failure may prevent API reads too. A cached browser can help but is not guaranteed backup. Do not promise that the app can always show a custom message after the provider stops executing requests.

## 10. UI principles

Default to **This Week**, retain **Timeline**, and offer **Needs attention** for changes and unresolved items. Show title, course, deadline, and what remains before grades or metadata. Place details behind accessible expansion. Keep source and freshness explicit when they affect trust.

Use “No deadline listed,” “Saved on this device; waiting to sync,” “Updated 3 of 4 courses,” and “No published assignments found.” Avoid “You have no work,” “All up to date” after a partial sync, or “Saved” before a write succeeds.

Separate work from class meetings and university dates. Course colors supplement text labels, never replace them. Accommodate long titles, many courses, narrow screens, large text, keyboard navigation, and reduced motion. Reuse useful original interface ideas rather than requiring a framework rewrite.

## 11. Non-goals for the first release

No Canvas submissions or other coursework writes; no university-wide admin token; no classmate data; no LMS replacement; no grade prediction; no LLM-required pipeline; no syllabus omniscience; no public sharing of student plans; no native app requirement; no paid push/SMS/email system; no multi-institution auto-discovery before a second approved institution exists.

A calendar-only fallback may be considered separately if OAuth approval is delayed. It is not equivalent to full Canvas sync and must not derail OAuth/Cloudflare setup. Development can proceed against synthetic mocks.

## 12. Success and release gates

The product succeeds when an ordinary student can connect, choose courses, identify upcoming work, add a non-Canvas obligation, understand a changed deadline, and recover from a stale/disconnected state without technical instructions.

Engineering gates: two users cannot access each other's records; a failed page cannot remove tasks; repeated sync cannot duplicate work; a deadline update cannot erase notes; token refresh preserves a refresh token omitted from the response; stale jobs cannot overwrite a newer commit; canceled jobs cannot revive a deleted account; budget exhaustion cannot become silent data corruption.

Before public use: validate live institutional OAuth, tenant isolation, session and credential handling, deletion/export behavior, dependency/secrets review, accessibility basics, workload measurements, and a realistic free-tier admission policy. Evidence belongs in a release checklist, not in an unsupported “production ready” claim.

See the ordered tickets and detailed cases in `docs/05-ROADMAP-AND-TESTS.md`.
