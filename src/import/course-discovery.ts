import { fetchCanvasPage, type CanvasFetchConfig, type CanvasPageResult } from "../canvas/client";
import { parseCanvasId } from "../canvas/id";
import type { CanvasCourseRaw } from "../canvas/types";
import { findOrCreateCourse } from "../db/repository";
import { createBudgetTracker } from "./limits";

function coursesUrl(institutionOrigin: string): string {
  const url = new URL("/api/v1/courses", institutionOrigin);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("enrollment_state", "active");
  return url.toString();
}

export interface DiscoverCoursesParams {
  readonly db: D1Database;
  readonly canvasConfig: CanvasFetchConfig;
  readonly accountId: number;
  readonly now: number;
  readonly fetchImpl: typeof fetch;
}

export interface DiscoverCoursesResult {
  readonly courseIds: readonly string[];
  /** `true` when discovery stopped before Canvas's own course list was exhausted (budget ceiling,
   * a failed fetch, or a dropped next-link) — a caller must not read `courseIds` as "every active
   * enrollment," only as "these, so far." */
  readonly truncated: boolean;
}

/**
 * Best-effort: finds-or-creates a `courses` row for every one of the account's active Canvas
 * enrollments (`GET /api/v1/courses?enrollment_state=active`). Never throws — this runs inline
 * with token connect (see `handleConnectToken`), where a partial or empty course list must never
 * fail the connection itself; the token was already verified before this is ever called. An
 * unsafe Canvas course id is skipped rather than aborting the whole discovery, unlike
 * `importCourse`'s assignment ids: a skipped course is simply invisible until Canvas fixes the id
 * on its side, not a data-integrity risk the way a wrongly-dropped assignment row would be.
 */
export async function discoverCourses(params: DiscoverCoursesParams): Promise<DiscoverCoursesResult> {
  const budget = createBudgetTracker();
  const courseIds: string[] = [];
  let url: string | undefined = coursesUrl(params.canvasConfig.institutionOrigin);

  try {
    while (url !== undefined) {
      const page: CanvasPageResult<CanvasCourseRaw> = await fetchCanvasPage<CanvasCourseRaw>(url, params.canvasConfig, budget, params.fetchImpl);

      for (const raw of page.items) {
        const parsedId = parseCanvasId(raw.id);
        if (parsedId.status !== "safe" || parsedId.id === undefined) continue;

        budget.spendD1Queries(1);
        const course = await findOrCreateCourse(params.db, {
          id: crypto.randomUUID(),
          accountId: params.accountId,
          canvasCourseId: parsedId.id,
          courseCode: raw.course_code ?? null,
          title: raw.name ?? null,
          term: raw.term?.name ?? null,
          now: params.now,
        });
        courseIds.push(course.id);
      }

      if (page.nextLinkDropped) return { courseIds, truncated: true };
      url = page.nextUrl;
    }
  } catch {
    // Budget ceiling or a failed Canvas fetch — either way, stop and report what was found so far.
    return { courseIds, truncated: true };
  }

  return { courseIds, truncated: false };
}
