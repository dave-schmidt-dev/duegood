# Ordered work tickets and acceptance gates

These are local backlog items, not GitHub issues that have already been created. The local agent should plan each change against the actual tree, implement small commits, and report real tests. No response on a GitHub issue is required by this package.

## Phase 1 — OAuth and Cloudflare

| ID | Work | Done when |
| --- | --- | --- |
| DG-001 | Inspect local source; write implementation plan | Source findings verified; dependencies/risks and first commits documented |
| DG-002 | Public-safe repository skeleton | Private JSON excluded; dedicated static directory; package checks pass; license decision recorded |
| DG-003 | Free Cloudflare foundation | Account plan/quota reviewed; HTTPS origin, Worker, D1 binding and local migrations tested without paid services |
| DG-004 | Marymount OAuth request | Correct API key/scopes/include flag/exact callbacks/support contact prepared; approval status recorded |
| DG-005 | Secure auth/session/credential layer | State binding/replay/denial tests; encrypted tokens; secure session; tenant checks; auth disabled until configured |
| DG-006 | First one-course import | All pages imported; selected student's applicable dates; basic list and personal progress survive sync |
| DG-007 | Renewal and exit paths | Token expiry/refresh, reconnect, logout, disconnect, deletion safety, and account cache separation tested |

Do not wait for DG-004 approval to implement mocks or deployment plumbing. Do not label DG-005 or DG-006 as live Canvas verified until a real approved grant was tested. Do not defer critical security to phase 4.

## Phase 2 — Optimization and durability

| ID | Work | Done when |
| --- | --- | --- |
| DG-010 | Measure and model workload | Incoming/outgoing calls, CPU, D1 reads/writes, staging and storage reported for test profiles |
| DG-011 | Remove polling/write amplification | No 750-ms polling; no-op source sync does not rewrite every assignment; other metadata writes counted |
| DG-012 | Robust pagination and retries | Validated origin/path, partial-response safety, 429 backoff, page/byte/deadline budgets, safe continuation |
| DG-013 | Atomic reconciliation and concurrency | Complete-resource commit; stale job fencing; no user-state clobber; idempotent events/actions |
| DG-014 | Quota and abuse controls | Configured pilot cap/cooldowns/kill switches; fail-closed auth; measured headroom and exhaustion behavior |

## Phase 3 — Generalization

| ID | Work | Done when |
| --- | --- | --- |
| DG-020 | Courses, terms, zones | No personal ID dependency; student course selections and time-zone tests; safe term rollover |
| DG-021 | Student tasks and exceptions | Non-Canvas tasks, subtasks, dismissed work, undo, meaningful change review |
| DG-022 | Deterministic discussion rules | Actual checkpoint capability checked; previews/acceptance; stable child identity; no double counting |
| DG-023 | Modules and suggestions | Only validated/authorized structured requirements; unsupported inference remains an optional suggestion |

## Phase 4 — UI and accessible offline use

| ID | Work | Done when |
| --- | --- | --- |
| DG-030 | This Week and timeline | Simple next-action view; arbitrary course count; long titles/mobile/keyboard tested |
| DG-031 | Changes and uncertainty | Clear source/freshness, changed dates, partial failures; no false “all done” or completeness claim |
| DG-032 | Durable offline outbox | Device-write failure, retries, duplicate delivery, conflict recovery and account switch tested |
| DG-033 | Public pilot readiness | Live approval, privacy/support/export/delete, secret scan, accessibility and workload gates recorded |

## Test matrix to implement

The package includes arithmetic tests and synthetic fixture validation only. The following application cases are requirements, **not tests already implemented**.

### Authentication and ownership

A1. Denied authorization returns a normal recovery screen; no account session is created.

A2. Missing, changed, expired, duplicate, cross-browser, or replayed OAuth state is rejected before token exchange.

A3. Callback institution/origin mismatch or unexpected redirect cannot leak a token or create the wrong account.

A4. Access-token refresh omits `refresh_token`: stored refresh credential survives. Simultaneous refreshes are coalesced/fenced.

A5. A revoked grant produces one recoverable disconnected state, not repeated requests or a confusing empty course list.

A6. Student B cannot read, mutate, sync, resume, export, acknowledge, or delete student A's resources by guessing IDs.

A7. Same numeric Canvas user/course/assignment ID at two institutions never collides.

A8. Logout/account switch clears or isolates cached tasks and outbox operations. A delayed response for the prior account cannot populate the new account's screen.

A9. Account deletion while a sync is in flight prevents any subsequent commit from re-creating its data.

### Ingestion and dates

I1. Multi-page assignment inventory is complete before unavailable-item decisions.

I2. Page 2 fails: prior committed resource survives; success is not claimed for that resource.

I3. Course A completes and course B fails: only A's freshness advances; partial result is explicit.

I4. A Link header names another origin/private destination, loops, or exceeds limits: reject safely without bearer leakage.

I5. An individual assignment extension appears only for its correct student; no shared personalized cache.

I6. A title/deadline change preserves task ID, personal title, notes, completion, and accepted children.

I7. Omitted submission data is not treated as an explicit zero/absence without capability evidence.

I8. Timed overdue status changes at the actual deadline; all-day and unknown dates are not silently converted to timed deadlines.

I9. Daylight-saving transitions, a traveling student's display zone, invalid dates, and ambiguous legacy local times behave explicitly.

I10. Same source reappears in modules/quiz/discussion relationships: one parent assignment with typed aliases, not duplicates.

I11. Empty complete inventory versus unavailable course versus truncated/filtered list are not treated as identical removals.

I12. A resumed older job cannot overwrite a newer resource generation.

### Personal state and intelligence

P1. Personal checkmark during Canvas refresh persists independently.

P2. Duplicate operation ID yields one mutation/event; lost acknowledgement is safe to retry.

P3. Concurrent note edits produce a recoverable conflict, not silent last-client-clock-wins loss.

P4. A discussion initial submission leaves uncompleted replies visible.

P5. Reapplying or editing an accepted rule does not duplicate children or reset manually edited/completed steps.

P6. A personal canceled-item exception survives source updates and can be undone.

P7. A zero-point task, unknown deadline, and non-Canvas studio reminder remain visible.

P8. A forecast or ambiguous text date never becomes an official deadline without the relevant evidence/acceptance.

P9. Parent/child progress never multiplies the parent assignment's points.

### Cost, release, and usability

R1. No-op sync measures low source writes; staging, leases, history, receipts, and cleanup are included in accounting.

R2. Background-tab loops, duplicate tabs, repeated clicks, and malicious sync requests cannot multiply unconstrained work.

R3. Free-tier CPU or subrequest exhaustion does not commit incomplete state. Pausing/retrying is honest.

R4. Quota exhaustion preserves pending edits locally when possible and never bypasses authentication.

R5. Static artifact scan excludes data, maps containing secrets, production exports, and reference code from deployment.

R6. The real Cloudflare environment is benchmarked; Node wall time is not presented as Workers CPU.

R7. Nontechnical pilot users complete core journeys; keyboard focus, screen-reader state, large text, mobile layout, and reduced motion tested.

R8. Recovery/export/deletion and a documented incident procedure are exercised, not just described.

## Evidence labels

Use `not started`, `mock-tested`, `local-runtime-tested`, `cloudflare-staging-tested`, `live-Marymount-tested`, and `blocked: <specific prerequisite>`. Record exact commands and results. A screenshot of a synthetic demo is not evidence of API integration.
