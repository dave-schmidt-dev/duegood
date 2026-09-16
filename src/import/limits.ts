/**
 * Hard ceilings the import pipeline budgets against, drawn from the Workers/D1 Free tier limits
 * recorded in docs/02-SYNC-AND-BUDGET.md (checked 2026-09-13). These are platform limits, not
 * design choices: an import that would exceed one must abort before spending it, not discover the
 * ceiling mid-request with partial writes already made.
 */
export const CANVAS_SUBREQUESTS_PER_INVOCATION = 50;
export const D1_QUERIES_PER_INVOCATION = 50;

export class BudgetExceededError extends Error {
  constructor(resource: string) {
    super(`import budget exceeded: ${resource}`);
    this.name = "BudgetExceededError";
  }
}

export interface ImportBudget {
  readonly canvasFetchesRemaining: number;
  readonly d1QueriesRemaining: number;
}

export function createImportBudget(
  overrides: Partial<ImportBudget> = {},
): ImportBudget {
  return {
    canvasFetchesRemaining: overrides.canvasFetchesRemaining ?? CANVAS_SUBREQUESTS_PER_INVOCATION,
    d1QueriesRemaining: overrides.d1QueriesRemaining ?? D1_QUERIES_PER_INVOCATION,
  };
}

/**
 * Tracks remaining budget across one incoming request's import work. Every spend throws
 * `BudgetExceededError` instead of returning a boolean, so a caller can't accidentally proceed
 * past the ceiling by ignoring a false return value — the whole point of a hard ceiling is that
 * exceeding it aborts the import (see docs/IMPLEMENTATION-PLAN.md's "commits nothing" rule),
 * never that it degrades silently.
 */
export interface BudgetTracker {
  spendCanvasFetch(): void;
  spendD1Queries(count: number): void;
  remaining(): ImportBudget;
}

export function createBudgetTracker(initial: ImportBudget = createImportBudget()): BudgetTracker {
  let canvasFetchesRemaining = initial.canvasFetchesRemaining;
  let d1QueriesRemaining = initial.d1QueriesRemaining;

  return {
    spendCanvasFetch() {
      if (canvasFetchesRemaining <= 0) throw new BudgetExceededError("canvas_subrequests");
      canvasFetchesRemaining -= 1;
    },
    spendD1Queries(count: number) {
      if (count > d1QueriesRemaining) throw new BudgetExceededError("d1_queries");
      d1QueriesRemaining -= count;
    },
    remaining() {
      return { canvasFetchesRemaining, d1QueriesRemaining };
    },
  };
}
