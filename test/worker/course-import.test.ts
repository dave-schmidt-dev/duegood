import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../fixtures/canvas-phase1.json";
import type { CanvasAssignmentRaw } from "../../src/canvas/types";
import { createConnection, findOrCreateAccount, findOrCreateCourse, getCourseById, revokeConnection } from "../../src/db/repository";
import { importCourse } from "../../src/import/course-import";
import { acquireImportLease } from "../../src/import/lease";

const INSTITUTION = "https://marymount.instructure.com";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "Content-Type": "application/json", ...init.headers } });
}

let seq = 0;
async function makeFixture(canvasUserId?: string) {
  seq += 1;
  const account = await findOrCreateAccount(env.DB, INSTITUTION, canvasUserId ?? `student-${String(seq)}`, 1000);
  const course = await findOrCreateCourse(env.DB, {
    id: crypto.randomUUID(),
    accountId: account.id,
    canvasCourseId: String(9000 + seq),
    courseCode: "TECH 101",
    title: "Introduction to Computing",
    term: "Fall 2026",
    now: 1000,
  });
  const connection = await createConnection(env.DB, {
    id: crypto.randomUUID(),
    accountId: account.id,
    keyVersion: 1,
    encryptedAccessToken: "envelope",
    encryptedRefreshToken: null,
    accessTokenExpiresAt: null,
    now: 1000,
  });
  return { account, course, connection };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

function baseParams(fixture: Fixture, fetchImpl: typeof fetch, now = 2000) {
  return {
    db: env.DB,
    canvasConfig: { institutionOrigin: INSTITUTION, accessToken: "token" },
    accountId: fixture.account.id,
    courseId: fixture.course.id,
    canvasCourseId: fixture.course.canvasCourseId,
    connectionId: fixture.connection.id,
    connectionGeneration: fixture.connection.generation,
    studentCanvasUserId: fixture.account.canvasUserId,
    now,
    fetchImpl,
  };
}

async function sourceItemsFor(courseId: string) {
  const result = await env.DB.prepare(
    `SELECT canvas_item_id, fingerprint, available, title, due_at, due_at_state, submission_state FROM source_items WHERE course_id = ?1`,
  )
    .bind(courseId)
    .all<{
      canvas_item_id: string;
      fingerprint: string;
      available: number;
      title: string | null;
      due_at: string | null;
      due_at_state: string;
      submission_state: string;
    }>();
  return result.results;
}

describe("importCourse", () => {
  it("commits a single page of assignments and bumps the snapshot generation", async () => {
    const fx = await makeFixture();
    const page: CanvasAssignmentRaw[] = [{ id: 50001, name: "Reading response", due_at: "2026-09-20T22:00:00Z", points_possible: 10 }];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(page));

    const result = await importCourse(baseParams(fx, fetchImpl));

    expect(result).toEqual({ status: "refreshed", snapshotGeneration: 1 });
    const rows = await sourceItemsFor(fx.course.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.canvas_item_id).toBe("50001");
    expect(rows[0]?.available).toBe(1);
    expect(rows[0]?.title).toBe("Reading response");
    const stored = await getCourseById(env.DB, fx.course.id);
    expect(stored?.snapshotGeneration).toBe(1);
    expect(stored?.importLeaseToken).toBeNull();
  });

  it("stores the resolved due date and Canvas submission state alongside the fingerprint", async () => {
    const fx = await makeFixture();
    const page: CanvasAssignmentRaw[] = [
      { id: 51001, name: "Submitted work", due_at: "2026-09-20T22:00:00Z", points_possible: 10, submission: { workflow_state: "submitted" } },
      { id: 51002, name: "No deadline", due_at: null, points_possible: 5, submission: { workflow_state: "unsubmitted" } },
      { id: 51003, name: "No submission data", due_at: "2026-09-21T22:00:00Z", points_possible: 5 },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(page));

    await importCourse(baseParams(fx, fetchImpl));

    const rows = await sourceItemsFor(fx.course.id);
    const byId = new Map(rows.map((row) => [row.canvas_item_id, row]));
    expect(byId.get("51001")).toMatchObject({ title: "Submitted work", due_at: "2026-09-20T22:00:00Z", due_at_state: "known", submission_state: "known_submitted" });
    expect(byId.get("51002")).toMatchObject({ title: "No deadline", due_at: null, due_at_state: "known_null", submission_state: "known_not_submitted" });
    expect(byId.get("51003")).toMatchObject({ title: "No submission data", due_at_state: "known", submission_state: "unknown" });
  });

  it("follows pagination and commits every page's items", async () => {
    const fx = await makeFixture();
    const page1: CanvasAssignmentRaw[] = [{ id: 60001, name: "A", due_at: null, points_possible: 5 }];
    const page2: CanvasAssignmentRaw[] = [{ id: 60002, name: "B", due_at: null, points_possible: 5 }];
    const nextUrl = `${INSTITUTION}/api/v1/courses/${fx.course.canvasCourseId}/assignments?page=2`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1, { headers: { Link: `<${nextUrl}>; rel="next"` } }))
      .mockResolvedValueOnce(jsonResponse(page2));

    const result = await importCourse(baseParams(fx, fetchImpl));

    expect(result).toEqual({ status: "refreshed", snapshotGeneration: 1 });
    const rows = await sourceItemsFor(fx.course.id);
    expect(rows.map((row) => row.canvas_item_id).sort()).toEqual(["60001", "60002"]);
  });

  it("reports truncated and writes nothing when a next link is dropped", async () => {
    const fx = await makeFixture();
    const page: CanvasAssignmentRaw[] = [{ id: 70001, name: "A", due_at: null, points_possible: 5 }];
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(page, { headers: { Link: '<https://evil.example/api/v1/courses/1/assignments>; rel="next"' } }));

    const result = await importCourse(baseParams(fx, fetchImpl));

    expect(result).toEqual({ status: "not_refreshed", reason: "truncated" });
    expect(await sourceItemsFor(fx.course.id)).toHaveLength(0);
    const stored = await getCourseById(env.DB, fx.course.id);
    expect(stored?.importLeaseToken).toBeNull();
  });

  it("aborts the whole import on an unsafe id, committing none of the page's otherwise-safe items", async () => {
    const fx = await makeFixture();
    const page: CanvasAssignmentRaw[] = [
      { id: 80001, name: "Safe", due_at: null, points_possible: 5 },
      { id: fixture.unsafeCourseId, name: "Unsafe", due_at: null, points_possible: 5 },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(page));

    const result = await importCourse(baseParams(fx, fetchImpl));

    expect(result).toEqual({ status: "not_refreshed", reason: "unsafe_id" });
    expect(await sourceItemsFor(fx.course.id)).toHaveLength(0);
  });

  it("reports anomalous and commits nothing when the fetch looks like a suspected partial read", async () => {
    const fx = await makeFixture();
    const firstPage: CanvasAssignmentRaw[] = Array.from({ length: 4 }, (_, index) => ({
      id: 90001 + index,
      name: `Item ${String(index)}`,
      due_at: null,
      points_possible: 5,
    }));
    await importCourse(baseParams(fx, vi.fn().mockResolvedValue(jsonResponse(firstPage)), 2000));

    const emptyFetch = vi.fn().mockResolvedValue(jsonResponse([]));
    const result = await importCourse(baseParams(fx, emptyFetch, 3000));

    expect(result).toEqual({ status: "not_refreshed", reason: "anomalous" });
    const rows = await sourceItemsFor(fx.course.id);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.available === 1)).toBe(true);
  });

  it("reports lease_held and never touches Canvas when another import already holds the lease", async () => {
    const fx = await makeFixture();
    await acquireImportLease(env.DB, fx.course.id, 1500);
    const fetchImpl = vi.fn();

    const result = await importCourse(baseParams(fx, fetchImpl, 2000));

    expect(result).toEqual({ status: "not_refreshed", reason: "lease_held" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports fenced and writes nothing when the connection's generation moved before the commit", async () => {
    const fx = await makeFixture();
    const staleGeneration = fx.connection.generation;
    await revokeConnection(env.DB, fx.connection.id, 1500);
    const page: CanvasAssignmentRaw[] = [{ id: 100001, name: "A", due_at: null, points_possible: 5 }];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(page));

    const result = await importCourse({ ...baseParams(fx, fetchImpl, 2000), connectionGeneration: staleGeneration });

    expect(result).toEqual({ status: "not_refreshed", reason: "fenced" });
    expect(await sourceItemsFor(fx.course.id)).toHaveLength(0);
  });

  it("reports budget_exceeded and writes nothing when pagination would exceed the Canvas-fetch ceiling", async () => {
    const fx = await makeFixture();
    const fetchImpl = vi.fn().mockImplementation(() => {
      const page: CanvasAssignmentRaw[] = [{ id: 110001, name: "A", due_at: null, points_possible: 5 }];
      const nextUrl = `${INSTITUTION}/api/v1/courses/${fx.course.canvasCourseId}/assignments?page=next`;
      return Promise.resolve(jsonResponse(page, { headers: { Link: `<${nextUrl}>; rel="next"` } }));
    });

    const result = await importCourse(baseParams(fx, fetchImpl, 2000));

    expect(result).toEqual({ status: "not_refreshed", reason: "budget_exceeded" });
    expect(fetchImpl).toHaveBeenCalledTimes(50);
    expect(await sourceItemsFor(fx.course.id)).toHaveLength(0);
  });

  it("reports blocked and never touches Canvas when the committed inventory exceeds the phase-1 envelope", async () => {
    const fx = await makeFixture();
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5001)
       INSERT INTO source_items (id, account_id, course_id, canvas_item_id, fingerprint, available, last_seen_generation, created_at, updated_at)
       SELECT lower(hex(randomblob(16))), ?1, ?2, 'seed-' || n, 'fp', 1, 0, 1000, 1000 FROM seq`,
    )
      .bind(fx.account.id, fx.course.id)
      .run();
    const fetchImpl = vi.fn();

    const result = await importCourse(baseParams(fx, fetchImpl, 2000));

    expect(result).toEqual({ status: "not_refreshed", reason: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const stored = await getCourseById(env.DB, fx.course.id);
    expect(stored?.importLeaseToken).toBeNull();
  });

  it("threads an authenticated student's applicable override into the committed fingerprint", async () => {
    const fx = await makeFixture("800100");
    const withOverride: CanvasAssignmentRaw[] = [
      {
        id: 120001,
        name: "Extended assignment",
        due_at: "2026-09-20T22:00:00Z",
        points_possible: 10,
        overrides: [{ id: 1, student_ids: ["800100"], due_at: "2026-09-27T22:00:00Z" }],
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(withOverride));

    await importCourse(baseParams(fx, fetchImpl, 2000));

    const rows = await sourceItemsFor(fx.course.id);
    expect(rows[0]?.fingerprint).toContain("2026-09-27T22:00:00Z");
    expect(rows[0]?.fingerprint).not.toContain("2026-09-20T22:00:00Z");
  });
});
