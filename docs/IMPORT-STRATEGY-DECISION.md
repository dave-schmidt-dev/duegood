# Import strategy decision

**Decision: bounded in-memory complete-course snapshot, not durable D1 staging, for phase 1.**

## What was compared

`docs/02-SYNC-AND-BUDGET.md` names the tension directly: writing every full snapshot into D1
staging on every sync can erase all the savings from changed-only live writes, so a bounded
in-memory complete-course snapshot must be benchmarked first; durable checkpointed staging is only
worth designing if that fails the CPU/payload envelope.

- **Bounded in-memory complete-snapshot**: fetch the selected course's full assignment inventory
  into memory within one incoming request, diff it against the last committed version, and issue
  writes only for what actually changed plus one atomic pointer/version bump. No intermediate
  staging round-trip.
- **Durable staging**: write the fetched candidate rows to D1 as an uncommitted staging area
  (possibly across several bounded batches within the request, or in principle across requests),
  then swap a pointer once the full inventory is staged and validated.

## Method, and what this is not

`src/import/feasibility.ts` runs a bounded, structural, synchronous check against
`fixtures/canvas-phase1.json`'s `small` (1 course / 3 assignments), `typical` (5 courses / 30
assignments each), and `large` (12 courses / 200 assignments each) profiles. Import is a
one-selected-course pipeline, so each check operates on one course's assignment count; `large`'s
course count (12) describes how many courses a student might have, not the size of any single
import.

For a given assignment count it estimates:

- Canvas fetch pages needed (page size 100), against the 50-subrequest/invocation ceiling.
- D1 `batch()` calls needed for the worst-case commit (every assignment changed, `D1_BATCH_ROWS =
  100` rows/batch, plus one for the pointer/version bump), against the 50-query/invocation
  ceiling.
- A flat 5,000-assignment in-memory ceiling, chosen with headroom over `large` (200/course) while
  staying well below where the fetch/D1 estimates above would themselves exceed their ceilings
  (both land near N ≈ 4,900–5,000 for the same reason — that's the real bottleneck, not an
  arbitrary round number).

This runs inside the project's `@cloudflare/vitest-plugin` pool, i.e. actually executing on
**workerd**, not Node — closer to the truth than a bare Node microbenchmark. It is still **not** a
deployed Workers CPU measurement. Per `docs/02-SYNC-AND-BUDGET.md`: "Node wall-clock microbenchmarks
are not Workers CPU measurements," and the same caveat extends to a local, non-deployed workerd run
— it has no real network latency, no shared-isolate contention, and no deployed CPU-time metering.
Before raising any pilot admission limit past the 25-connected-student cap, that doc's own required
telemetry (deployed CPU metrics, wall time, D1 meta rows) must be measured against a consented real
profile privately. This document records a structural, synthetic-fixture result only.

## Result

All three profiles (`small`, `typical`, `large`) return `status: "in_envelope"` with
`strategy: "in_memory_snapshot"` and wide margin — `large` (200 assignments) estimates 2 Canvas
fetch pages and 3 D1 batch calls, against ceilings of 50 and 50 respectively. **Durable staging is
not implemented in phase 1.** The bounded interface a later phase would need to add it (a distinct
staging path behind the same commit contract) is deferred until a real course actually exceeds the
in-memory envelope — building it now against untested assumptions is exactly the premature-staging
cost this benchmark exists to avoid.

## Blocked path

A course whose assignment count exceeds the envelope (any of: >5,000 assignments, >50 estimated
Canvas pages, >50 estimated D1 batches) gets `status: "blocked"` and the fixed
`DEFERRED_CLIENT_ORCHESTRATION_NOTE` (`src/import/feasibility.ts`): no Canvas fetch, no D1 write, no
partial/truncated import. A client-driven multi-request continuation is deliberately not
implemented — a lost tab can't guarantee completion — so the only durable alternative is a
server-owned resumable continuation, which is Task 2.1's job, not phase 1's.

## No `src/import/strategy.ts` file

Task 1.4's master file list names `src/import/strategy.ts`, written before this benchmark ran. With
exactly one strategy chosen and durable staging explicitly not implemented, a `strategy.ts`
exporting a single hardcoded value would have no second implementation to abstract over and no
consumer needing the indirection — knip's "no consumer, no export" discipline applies to a whole
file, not just an unused symbol inside one. `src/import/feasibility.ts`'s `FeasibilityResult`
already carries `strategy: "in_memory_snapshot"` as the one real value this phase produces;
`src/import/course-import.ts` consumes that result directly. Add the file when a second strategy
actually exists to select between, not before.
