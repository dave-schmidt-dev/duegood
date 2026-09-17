import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findOrCreateAccount, listCoursesForAccount } from "../../src/db/repository";
import { discoverCourses } from "../../src/import/course-discovery";

const INSTITUTION = "https://marymount.instructure.com";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "Content-Type": "application/json", ...init.headers } });
}

let seq = 0;
async function freshAccount() {
  seq += 1;
  return findOrCreateAccount(env.DB, INSTITUTION, `discovery-student-${String(seq)}`, 1000);
}

function baseParams(accountId: number, fetchImpl: typeof fetch) {
  return { db: env.DB, canvasConfig: { institutionOrigin: INSTITUTION, accessToken: "token" }, accountId, now: 2000, fetchImpl };
}

describe("discoverCourses", () => {
  it("finds-or-creates a course row per active enrollment", async () => {
    const account = await freshAccount();
    const page = [
      { id: 5001, course_code: "TECH 101", name: "Introduction to Computing", term: { name: "Fall 2026" } },
      { id: 5002, course_code: "MATH 201", name: "Calculus II" },
    ];
    const fetchImpl = (async () => jsonResponse(page)) as unknown as typeof fetch;

    const result = await discoverCourses(baseParams(account.id, fetchImpl));

    expect(result.truncated).toBe(false);
    expect(result.courseIds).toHaveLength(2);
    const courses = await listCoursesForAccount(env.DB, account.id);
    expect(courses.map((c) => c.canvasCourseId).sort()).toEqual(["5001", "5002"]);
    expect(courses.find((c) => c.canvasCourseId === "5001")?.term).toBe("Fall 2026");
  });

  it("is idempotent — re-running discovery never creates duplicate rows", async () => {
    const account = await freshAccount();
    const page = [{ id: 6001, course_code: "ENG 101", name: "Composition" }];
    const fetchImpl = (async () => jsonResponse(page)) as unknown as typeof fetch;

    await discoverCourses(baseParams(account.id, fetchImpl));
    await discoverCourses(baseParams(account.id, fetchImpl));

    const courses = await listCoursesForAccount(env.DB, account.id);
    expect(courses).toHaveLength(1);
  });

  it("follows pagination across multiple pages", async () => {
    const account = await freshAccount();
    const nextUrl = `${INSTITUTION}/api/v1/courses?page=2`;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse([{ id: 7001, course_code: "A", name: "A" }], { headers: { Link: `<${nextUrl}>; rel="next"` } });
      return jsonResponse([{ id: 7002, course_code: "B", name: "B" }]);
    }) as unknown as typeof fetch;

    const result = await discoverCourses(baseParams(account.id, fetchImpl));

    expect(result.truncated).toBe(false);
    expect(result.courseIds).toHaveLength(2);
  });

  it("skips an unsafe course id rather than aborting discovery entirely", async () => {
    const account = await freshAccount();
    const page = [
      { id: Number.MAX_SAFE_INTEGER + 10, course_code: "BAD", name: "Unsafe id" },
      { id: 8001, course_code: "GOOD", name: "Safe id" },
    ];
    const fetchImpl = (async () => jsonResponse(page)) as unknown as typeof fetch;

    const result = await discoverCourses(baseParams(account.id, fetchImpl));

    expect(result.courseIds).toHaveLength(1);
    const courses = await listCoursesForAccount(env.DB, account.id);
    expect(courses.map((c) => c.canvasCourseId)).toEqual(["8001"]);
  });

  it("reports truncated rather than throwing when Canvas is unreachable", async () => {
    const account = await freshAccount();
    const fetchImpl = (async () => new Response("service unavailable", { status: 503 })) as unknown as typeof fetch;

    const result = await discoverCourses(baseParams(account.id, fetchImpl));

    expect(result).toEqual({ courseIds: [], truncated: true });
  });

  it("reports truncated when the request itself throws, and never propagates the error", async () => {
    const account = await freshAccount();
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(discoverCourses(baseParams(account.id, fetchImpl))).resolves.toEqual({ courseIds: [], truncated: true });
  });

  it("reports truncated when a next-link is dropped for landing off the allowlist", async () => {
    const account = await freshAccount();
    const page = [{ id: 9001, course_code: "C", name: "C" }];
    const fetchImpl = (async () =>
      jsonResponse(page, { headers: { Link: '<https://evil.example/api/v1/courses?page=2>; rel="next"' } })) as unknown as typeof fetch;

    const result = await discoverCourses(baseParams(account.id, fetchImpl));

    expect(result.truncated).toBe(true);
    expect(result.courseIds).toHaveLength(1);
  });
});
