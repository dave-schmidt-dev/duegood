# Durable sync and a strict zero-dollar operating budget

## Provider facts checked for this handoff

As checked September 13, 2026, Workers Free documents 100,000 incoming requests/day, 10 ms CPU/request, 50 external subrequests/invocation, and six simultaneous outgoing connections. Network waiting is separate from CPU. These are account/runtime constraints, not an app-capacity guarantee [F1].

Static-asset requests are free; outbound subrequests are not separately billed as incoming Worker requests. Routing every asset through dynamic code can still create unnecessary Worker invocations [F2, F5].

D1 Free documents 5 million rows read/day, 100,000 rows written/day, and 5 GB total storage. Its per-database free limit is smaller (500 MB in the checked limits). Scanned rows and index maintenance matter; batching is not a discount on row writes [F3, F4].

D1 also limits queries per free Worker invocation (50 in the checked documentation); chunking must respect database-query limits as well as external fetch counts [F4].

Re-check these before deployment. Other projects on the owner's Cloudflare account share relevant quotas. A free-tier failure can stop backend reads as well as writes; browser caches cannot be guaranteed on a device that has never loaded the app.

## What one sync costs

Model Canvas traffic as:

```text
course-list pages, when refreshed
+ sum(assignment pages for each selected course)
+ optional token refresh
+ approved enrichment calls/pages
+ bounded retries
```

With five courses, one assignment page each, and a one-page course list, the basic count is 6–7 Canvas calls. A working page size of 100 is an assumption, not a guaranteed server maximum. Follow Link headers [C4, C5]. A course-list cache hit can remove that discovery call. Initial onboarding, large courses, and deep imports cost more.

The earlier “10 Canvas calls and six app requests” is an illustrative planning allowance. It is not a measurement and should not hardcode the implementation. The included estimator exposes these assumptions.

```text
1,000 students × 4 syncs/day × 6 incoming app requests = 24,000 app requests/day
1,000 students × 4 syncs/day × 200 assignment rewrites = 800,000 base row writes/day
```

The second design is unacceptable on this free tier. Even a nominal no-change sync costs reads, job bookkeeping, leases, token/session work, and possibly staging inserts/deletes. Count all of them. “Write only changes” does not mean “sync is free.”

## Design defaults to benchmark, not guarantees

Proposed starting settings: small pilot cap (25 connected students); one active sync per connection; on-open/manual refresh; a 15-minute normal cooldown; slower course discovery; at most two concurrent Canvas fetches; no recurring background job per student. Allow bounded user-requested retry after a real failed sync without defeating service-wide limits.

Use a modest app-level soft request/write budget below provider limits, and reserve headroom for login, logout, deletion, recovery, student edits, and other account workloads. Prefer measured headroom to a theoretical maximum-student headline. A single global database counter written on every request can itself become an expensive hot spot; design accounting without pretending eventually consistent or per-isolate counters are strict global rate limits.

Reject unauthorized sync before outbound work. Enforce connection ownership, maximum selected courses, payload size, task count, page count, total bytes, retry count, and job age. Defer safely at a limit instead of treating the truncated set as complete.

## Algorithm and commit safety

1. Authenticate, validate selected course IDs against the account's saved enrollment/selection, and coalesce concurrent jobs.
2. Acquire a bounded per-connection/per-resource lease with fencing/version semantics. Lease expiration alone must not allow an old worker to overwrite a newer commit.
3. Fetch and validate each page using an allowlisted institution origin and allowed API paths. Follow pagination only after validating its destination. Bound redirect behavior; never forward bearer tokens to another host.
4. Normalize only needed fields. Keep source-field presence distinct from explicit nulls. Stage an uncommitted resource snapshot or a compact delta, without touching personal rows.
5. Mark the resource complete only after all authoritative inventory pages succeeded. Validate deduplication, identity, expected resource shape, and terminal pagination. An anomalous sudden empty set should require recheck rather than immediate bulk removal.
6. Compare the complete normalized inventory against the committed version. Compute the exact added/updated/unavailable changes and preflight the remaining operation budget.
7. Commit the resource changes and its current version atomically using mechanisms actually supported by D1. `batch()` has documented transaction semantics; do not assume a long-lived SQL transaction can span multiple Worker HTTP requests [F7].
8. Preserve student state and create bounded change events. Update freshness at resource level. Cleanup staging under an explicit quota/retention budget.

**Important design tension:** writing every full snapshot into D1 staging on every sync can erase all savings from changed-only live writes. First benchmark a bounded in-memory complete-course snapshot. If it does not fit the CPU/payload envelope, design checkpointed staging that stores only necessary candidate changes and compact seen-ID inventories. Include their writes, reads, storage, and cleanup in the model. Do not solve this by dropping atomicity or assuming a bigger paid plan.

A failed page leaves the previous committed course snapshot in place. Successful complete courses can commit independently and produce “Updated 3 of 4 courses.” Do not show successful freshness for the failed resource.

## Bounded execution, not pretend background work

Begin with a request/response or bounded streaming import. For large work, persist an authenticated job continuation and resume on subsequent authorized requests. Closing the page may pause the job; resume later without redoing completed pages unnecessarily. If a provider page expires or the inventory may have changed during a long pause, restart that resource safely.

`waitUntil()` is not an unbounded job system: the checked Worker documentation gives it a limited post-response/disconnection window [F1]. Do not return “job queued” unless durable state exists. Do not add a paid queue or Durable Object as a casual fix. Any future scheduled design requires an explicit free-eligibility and workload review.

## Eliminate amplification

The prototype polls status every 750 ms. Replace it with a returned result, progress stream, or limited/backed-off status reads. A 30-second job should not need approximately 40 extra requests solely for status. Coalesce duplicate tabs and repeated clicks server-side, not only by disabling a button.

Do not call `/healthz` before every checkbox save in the hosted app. The save response establishes success/failure. Do not refresh the Canvas course list on every app navigation. Do not log complete assignment bodies.

Do not assume a generic Canvas incremental `updated_since` endpoint exists for every relevant resource. Do not depend on ETags or conditional retrieval until verified for the specific route, scope, and deployment. A due-date-only window is not a complete inventory and misses older submission/grade changes.

## Required telemetry

Per bounded sync: incoming request count; Canvas fetch count/pages/retries; bytes fetched; wall time; deployed CPU metrics; D1 meta rows read/written; staging overhead; assignments changed; resource completeness; throttle events; and auth failures by safe reason code. Do not record content, credentials, callback query parameters, or raw account identifiers in public logs.

Benchmark small, typical, and large synthetic profiles, then a consented real profile privately. Record warm/cold execution and partial-failure recovery. Node wall-clock microbenchmarks are not Workers CPU measurements. Release admission limits only after these measurements.

## Capacity failure behavior

Have server-side `SYNC_ENABLED` and `REGISTRATION_ENABLED` controls. Stop optional enrichments and reduce refresh frequency first. If backend capacity fails entirely, an existing offline cache should show its timestamp and queue student actions only after successful local persistence. A brand-new device may show an unavailable screen instead; do not imply it can recover data it never cached.

Never fail open around authentication to preserve uptime. Stop at the free tier, reduce admitted load, or seek an explicitly approved sponsor. The owner has not authorized paying for demand.
