import { fetchCanvasPage, type CanvasFetchConfig } from "../canvas/client";
import { parseCanvasId } from "../canvas/id";
import { OVERRIDES_SUPPORTED_PHASE_1, resolveEffectiveDueAt } from "../canvas/overrides";
import { resolveSubmissionState, SUBMISSION_SUPPORTED_PHASE_1 } from "../canvas/submission";
import type { CanvasAssignmentRaw } from "../canvas/types";
import { listSourceItems } from "../db/repository";
import { compareInventory, type FetchedItem } from "./compare";
import { assessFeasibility } from "./feasibility";
import { acquireImportLease, releaseImportLease } from "./lease";
import { BudgetExceededError, createBudgetTracker } from "./limits";
import { readSourceField, type SourceField } from "./normalize";
import { commitSnapshot, LeaseFencedError } from "./snapshot-commit";

export interface ImportCourseParams {
  readonly db: D1Database;
  readonly canvasConfig: CanvasFetchConfig;
  readonly accountId: number;
  /** Internal `courses.id` (UUID) — the caller has already verified this row belongs to
   * `accountId` before calling in. This function never performs that ownership check itself. */
  readonly courseId: string;
  readonly canvasCourseId: string;
  /** The connection this import runs under, and its generation captured by the caller
   * immediately before this call — passed straight through to `commitSnapshot`'s fence. */
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly studentCanvasUserId: string;
  readonly now: number;
  readonly fetchImpl: typeof fetch;
}

type NotRefreshedReason =
  | "lease_held"
  | "blocked"
  | "anomalous"
  | "truncated"
  | "unsafe_id"
  | "budget_exceeded"
  | "fenced"
  | "canvas_fetch_failed";

export type ImportCourseResult =
  | { readonly status: "refreshed"; readonly snapshotGeneration: number }
  | { readonly status: "not_refreshed"; readonly reason: NotRefreshedReason };

function assignmentsUrl(institutionOrigin: string, canvasCourseId: string): string {
  const url = new URL(`/api/v1/courses/${canvasCourseId}/assignments`, institutionOrigin);
  url.searchParams.set("per_page", "100");
  url.searchParams.append("include[]", "overrides");
  url.searchParams.append("include[]", "submission");
  return url.toString();
}

interface NormalizedAssignment {
  readonly name: SourceField<string>;
  readonly dueAt: SourceField<string>;
  readonly pointsPossible: SourceField<number>;
  readonly submissionState: ReturnType<typeof resolveSubmissionState>;
}

/** Reads every field this app projects to the student out of one raw Canvas assignment, resolving
 * the due date that actually applies to them (after overrides) exactly once — both the change-
 * detection fingerprint and the stored display columns read from this same result, so they can
 * never diverge under an override edge case. */
function normalizeAssignment(raw: CanvasAssignmentRaw, studentCanvasUserId: string): NormalizedAssignment {
  const record = raw as unknown as Record<string, unknown>;
  const name = readSourceField<string>(record, "name", true);
  const pointsPossible = readSourceField<number>(record, "points_possible", true);
  const baseDueAt = readSourceField<string>(record, "due_at", true);
  const dueAt = resolveEffectiveDueAt(baseDueAt, raw.overrides ?? [], studentCanvasUserId, OVERRIDES_SUPPORTED_PHASE_1);
  const submissionState = resolveSubmissionState(record, SUBMISSION_SUPPORTED_PHASE_1);
  return { name, dueAt, pointsPossible, submissionState };
}

/**
 * Fingerprints the fields this app actually projects to the student: name, the due date that
 * applies after resolving overrides, and points possible. Submission state (grade, submitted-at)
 * is deliberately excluded — it changes on its own cadence, independent of the assignment's own
 * shape, and folding it in here would upsert every row on every grade change instead of only when
 * the assignment itself changes. Submission state is still stored (see `snapshot-commit.ts`), just
 * not part of what gates an upsert.
 */
function fingerprintOf(normalized: NormalizedAssignment): string {
  return JSON.stringify({ name: normalized.name, dueAt: normalized.dueAt, pointsPossible: normalized.pointsPossible });
}

/**
 * Imports one course's assignment inventory from Canvas: acquires the per-course import lease,
 * paginates every assignment page within this request's budget, normalizes and fingerprints each
 * assignment, diffs against what's already committed, and atomically commits the result.
 *
 * Never partially applies a result. Any failure between lease acquisition and commit — the budget
 * running out, a dropped pagination link, an id this app refuses to trust, a fetch that looks like
 * a suspected partial read, a raw Canvas request failure, or the connection/lease fence itself
 * tripping during the fetch — releases the lease and reports `not_refreshed`, leaving every
 * previously committed row untouched. An unsafe id aborts the whole import rather than being
 * skipped: silently dropping one assignment from the fetched set would make `compareInventory`
 * read it as genuinely gone from Canvas, marking a real row unavailable for a reason that was
 * actually "this app refused to parse an id," not "the assignment disappeared."
 */
export async function importCourse(params: ImportCourseParams): Promise<ImportCourseResult> {
  const lease = await acquireImportLease(params.db, params.courseId, params.now);
  if (lease === undefined) return { status: "not_refreshed", reason: "lease_held" };

  const budget = createBudgetTracker();
  budget.spendD1Queries(1);
  const committed = await listSourceItems(params.db, params.courseId);

  // No per-institution capability probe exists yet for the true assignment count, so phase 1
  // estimates off what was last committed (0 on a first-ever import). An underestimate here isn't
  // a safety gap: it only defers enforcement to the live budget tracker below, which is the actual
  // hard ceiling regardless of what this preflight predicted.
  const feasibility = assessFeasibility({ assignmentCount: committed.length });
  if (feasibility.status === "blocked") {
    await releaseImportLease(params.db, params.courseId, lease.token);
    return { status: "not_refreshed", reason: "blocked" };
  }

  const fetched: FetchedItem[] = [];
  let url: string | undefined = assignmentsUrl(params.canvasConfig.institutionOrigin, params.canvasCourseId);
  while (url !== undefined) {
    let page;
    try {
      page = await fetchCanvasPage<CanvasAssignmentRaw>(url, params.canvasConfig, budget, params.fetchImpl);
    } catch (error) {
      await releaseImportLease(params.db, params.courseId, lease.token);
      if (error instanceof BudgetExceededError) return { status: "not_refreshed", reason: "budget_exceeded" };
      return { status: "not_refreshed", reason: "canvas_fetch_failed" };
    }

    if (page.nextLinkDropped) {
      await releaseImportLease(params.db, params.courseId, lease.token);
      return { status: "not_refreshed", reason: "truncated" };
    }

    for (const raw of page.items) {
      const idResult = parseCanvasId(raw.id);
      if (idResult.status !== "safe" || idResult.id === undefined) {
        await releaseImportLease(params.db, params.courseId, lease.token);
        return { status: "not_refreshed", reason: "unsafe_id" };
      }
      const normalized = normalizeAssignment(raw, params.studentCanvasUserId);
      fetched.push({
        canvasItemId: idResult.id,
        fingerprint: fingerprintOf(normalized),
        title: normalized.name.state === "known" ? normalized.name.value : null,
        dueAt: normalized.dueAt.state === "known" ? normalized.dueAt.value : null,
        dueAtState: normalized.dueAt.state,
        submissionState: normalized.submissionState,
      });
    }
    url = page.nextUrl;
  }

  const diff = compareInventory(committed, fetched);
  if (diff.anomalous) {
    await releaseImportLease(params.db, params.courseId, lease.token);
    return { status: "not_refreshed", reason: "anomalous" };
  }

  try {
    budget.spendD1Queries(diff.upserts.length + diff.newlyUnavailableCanvasItemIds.length + 1);
  } catch (error) {
    await releaseImportLease(params.db, params.courseId, lease.token);
    if (error instanceof BudgetExceededError) return { status: "not_refreshed", reason: "budget_exceeded" };
    throw error;
  }

  try {
    const newGeneration = await commitSnapshot(
      params.db,
      {
        accountId: params.accountId,
        lease,
        connectionId: params.connectionId,
        expectedConnectionGeneration: params.connectionGeneration,
        upserts: diff.upserts,
        newlyUnavailableCanvasItemIds: diff.newlyUnavailableCanvasItemIds,
      },
      params.now,
    );
    return { status: "refreshed", snapshotGeneration: newGeneration };
  } catch (error) {
    if (error instanceof LeaseFencedError) {
      await releaseImportLease(params.db, params.courseId, lease.token);
      return { status: "not_refreshed", reason: "fenced" };
    }
    throw error;
  }
}
