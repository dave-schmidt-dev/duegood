import { CANVAS_SUBREQUESTS_PER_INVOCATION, D1_BATCH_ROWS, D1_QUERIES_PER_INVOCATION } from "./limits";

type ImportStrategy = "in_memory_snapshot" | "durable_staging";

export interface CourseSizeEstimate {
  readonly assignmentCount: number;
}

export interface FeasibilityResult {
  readonly status: "in_envelope" | "blocked";
  readonly strategy?: ImportStrategy;
  readonly reason?: string;
  readonly estimatedCanvasFetches: number;
  readonly estimatedD1Queries: number;
}

/** Conservative ceiling on assignments a single bounded incoming request may hold in memory at
 * once for one course. Comfortably above the "large" synthetic profile in
 * fixtures/canvas-phase1.json (200/course) and chosen alongside the other two envelope checks
 * below so all three line up near the same real bottleneck — see
 * docs/IMPORT-STRATEGY-DECISION.md for why 5000 rather than an arbitrarily bigger number. */
const MAX_IN_MEMORY_ASSIGNMENTS = 5000;
const CANVAS_PAGE_SIZE = 100;

/** Repeated verbatim on every blocked result: there is no durable cross-request continuation in
 * phase 1, so a course that doesn't fit gets no partial import, not a silently-truncated one. */
export const DEFERRED_CLIENT_ORCHESTRATION_NOTE =
  "blocked: this course's inventory exceeds the phase-1 bounded in-memory strategy's envelope. " +
  "A client-driven multi-request continuation is deliberately not implemented here — a lost tab " +
  "can't guarantee completion. Phase 2's server-owned resumable continuation (Task 2.1) is the " +
  "first durable alternative.";

/**
 * A bounded, structural, request-time check: given how many assignments the selected course
 * reports, decide whether the phase-1 bounded in-memory strategy can complete inside one incoming
 * request's budget. Pure and synchronous — no I/O — so it runs before spending any Canvas fetch or
 * D1 query, per docs/02-SYNC-AND-BUDGET.md step 6 ("preflight the remaining operation budget").
 * The D1 estimate assumes the worst case (every assignment changed), since the actual change count
 * isn't known until after the fetch this check must run before. Returns `blocked` rather than
 * throwing: the caller decides how to surface it, but must never fetch or write after a blocked
 * result.
 */
export function assessFeasibility(estimate: CourseSizeEstimate): FeasibilityResult {
  const estimatedCanvasFetches = Math.max(1, Math.ceil(estimate.assignmentCount / CANVAS_PAGE_SIZE));
  const estimatedD1Queries = Math.ceil(estimate.assignmentCount / D1_BATCH_ROWS) + 1;

  if (
    estimate.assignmentCount > MAX_IN_MEMORY_ASSIGNMENTS ||
    estimatedCanvasFetches > CANVAS_SUBREQUESTS_PER_INVOCATION ||
    estimatedD1Queries > D1_QUERIES_PER_INVOCATION
  ) {
    return {
      status: "blocked",
      reason: DEFERRED_CLIENT_ORCHESTRATION_NOTE,
      estimatedCanvasFetches,
      estimatedD1Queries,
    };
  }

  return {
    status: "in_envelope",
    strategy: "in_memory_snapshot",
    estimatedCanvasFetches,
    estimatedD1Queries,
  };
}
