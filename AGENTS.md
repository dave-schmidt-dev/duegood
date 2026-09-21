# Agent rules for Due Good

## Verify, plan, then implement

This is a specification handoff, not a verified read of whatever repository you now have locally. Inspect the working tree, available application code, tests, runtime, and current provider docs. Write `docs/IMPLEMENTATION-PLAN.md` before application edits. Classify inherited findings as confirmed, changed, not applicable, or not verifiable. Do not simply trust the earlier assistant's conclusions.

The source reference is incomplete: the local Python server, Canvas exporter, reconciliation script, and their original tests were not supplied. Do not invent their behavior or claim that they have been audited.

## Owner priorities

For the current owner-authorized local replacement plan, work in this order: (1) qualify the isolated local executor, (2) capture the private legacy contract without exposing private data, (3) build the local coursework source and daily interface, and (4) rehearse a reversible cutover; OAuth and Cloudflare work are deferred. Build the smallest safe vertical slice first. Do not disappear into a UI rewrite, syllabus parser, generic plugin system, agent framework, or gradebook.

## Non-negotiables

- Remain on free-tier services. Do not enable paid Workers, paid databases, R2, paid queues, domains, messaging, or AI services without new explicit owner authorization. Do not add any service merely because it has promotional credits.
- Only an institution-enabled OAuth connection is public onboarding. Never ask students to paste Canvas personal tokens.
- Keep credentials server-side. Use Worker secrets for operator keys and authenticated encryption for each student's stored OAuth credentials.
- Bind all data access to the authenticated student and institution. Enforce ownership on the server, including status, history, sync continuations, exports, and deletions.
- Reject arbitrary outbound destinations, unsafe pagination links, and redirects before sending an Authorization header.
- Imported facts, personal planning, and unaccepted suggestions are different data classes. A sync never silently overwrites student progress or notes.
- An incomplete import cannot delete tasks or announce a fully successful refresh.
- Distinguish Canvas submission state from a student's completion checkbox. Unknown data remains unknown.
- Do not put real coursework, grades, instructor messages, personal schedules, full API responses, private feed URLs, secrets, or production screenshots in commits, issues, CI output, or fixtures.
- Preserve original files privately. Use only synthetic or explicitly reviewed/redacted test data in public.
- No background synchronization claim without an actually implemented scheduler. The initial free-tier design is on-open/manual refresh with persisted checkpoints.
- Do not claim university approval, legal compliance, working OAuth, zero-cost capacity, or security certification without evidence.

## Implementation discipline

Prefer a small TypeScript Worker, static frontend, and D1 candidate architecture. This is a proposed stack, not permission to impose an unnecessary framework. Keep server modules out of the frontend bundle. Pin dependencies and commit the lockfile after checking actual versions. Do not place unpinned installation commands in automatic deployment scripts.

Use bounded request bodies, page limits, retry budgets, and concurrency. Configure an app-specific pilot limit and an operator kill switch. One account's other Cloudflare workloads also consume its account-level allowances.

For every work increment, report: files changed, tests run and actual results, assumptions resolved, remaining blockers, and the next phase. Distinguish mocked, local-runtime, staging, and live-institution tests.

If admin approval or credentials are missing, keep authentication disabled and implement/test against synthetic mocks. Continue all unblocked setup work; record the single concrete owner/admin action that is needed. Do not fabricate approval or enable a public development authentication bypass.
