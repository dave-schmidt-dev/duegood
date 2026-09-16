import { describe, expect, it, vi } from "vitest";
import fixture from "../../fixtures/canvas-phase1.json";
import { fetchCanvasPage } from "../../src/canvas/client";
import { parseCanvasId } from "../../src/canvas/id";
import type { CanvasAssignmentRaw, CanvasCourseRaw, CanvasSubmissionRaw } from "../../src/canvas/types";
import { BudgetExceededError, createBudgetTracker, createImportBudget } from "../../src/import/limits";

const CONFIG = { institutionOrigin: "https://canvas.example.invalid", accessToken: "token-1" };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "Content-Type": "application/json", ...init.headers } });
}

describe("fetchCanvasPage", () => {
  it("refuses a non-allowlisted destination without ever calling fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchCanvasPage("https://evil.example/api/v1/courses", CONFIG, createBudgetTracker(), fetchImpl),
    ).rejects.toThrow("not allowlisted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an allowlisted origin with a non-allowed path", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchCanvasPage(`${CONFIG.institutionOrigin}/api/v1/users/self`, CONFIG, createBudgetTracker(), fetchImpl),
    ).rejects.toThrow("not allowlisted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to follow a redirect response, even to an allowlisted host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: `${CONFIG.institutionOrigin}/api/v1/courses?page=2` } }),
    );
    await expect(
      fetchCanvasPage(`${CONFIG.institutionOrigin}/api/v1/courses`, CONFIG, createBudgetTracker(), fetchImpl),
    ).rejects.toThrow("refusing to follow");
  });

  it("throws on a failed page instead of returning a partial result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("service unavailable", { status: 503 }));
    await expect(
      fetchCanvasPage(`${CONFIG.institutionOrigin}/api/v1/courses`, CONFIG, createBudgetTracker(), fetchImpl),
    ).rejects.toThrow("canvas request failed");
  });

  const submission: CanvasSubmissionRaw = { workflow_state: "submitted", submitted_at: "2026-09-20T22:10:00Z" };
  const oneAssignmentPage: CanvasAssignmentRaw[] = [
    { id: 50001, course_id: 9001, name: "Network lab reflection", due_at: null, submission },
  ];
  const oneCoursePage: CanvasCourseRaw[] = [{ id: 9001, course_code: "TECH 101", name: "Introduction to Computing" }];

  it("fetches a course-list page from an allowlisted destination", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(oneCoursePage));
    const result = await fetchCanvasPage<CanvasCourseRaw>(
      `${CONFIG.institutionOrigin}/api/v1/courses`,
      CONFIG,
      createBudgetTracker(),
      fetchImpl,
    );
    expect(result.items).toEqual(oneCoursePage);
  });

  it("follows a next link that stays on the allowlisted origin and path", async () => {
    const nextUrl = `${CONFIG.institutionOrigin}/api/v1/courses?page=2`;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(oneAssignmentPage, { headers: { Link: `<${nextUrl}>; rel="next"` } }));
    const result = await fetchCanvasPage<CanvasAssignmentRaw>(
      `${CONFIG.institutionOrigin}/api/v1/courses`,
      CONFIG,
      createBudgetTracker(),
      fetchImpl,
    );
    expect(result.items).toEqual(oneAssignmentPage);
    expect(result.nextUrl).toBe(nextUrl);
  });

  it("drops a next link pointing off the allowlisted origin, instead of following it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(oneAssignmentPage, { headers: { Link: '<https://evil.example/api/v1/courses?page=2>; rel="next"' } }),
      );
    const result = await fetchCanvasPage<CanvasAssignmentRaw>(
      `${CONFIG.institutionOrigin}/api/v1/courses`,
      CONFIG,
      createBudgetTracker(),
      fetchImpl,
    );
    expect(result.nextUrl).toBeUndefined();
  });

  it("drops a next link pointing at a non-allowed path on the same origin", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(oneAssignmentPage, { headers: { Link: `<${CONFIG.institutionOrigin}/api/v1/users/self>; rel="next"` } }),
      );
    const result = await fetchCanvasPage<CanvasAssignmentRaw>(
      `${CONFIG.institutionOrigin}/api/v1/courses`,
      CONFIG,
      createBudgetTracker(),
      fetchImpl,
    );
    expect(result.nextUrl).toBeUndefined();
  });

  it("spends the Canvas-fetch budget before the network call, and never calls fetch once exhausted", async () => {
    const fetchImpl = vi.fn();
    const budget = createBudgetTracker(createImportBudget({ canvasFetchesRemaining: 0 }));
    await expect(fetchCanvasPage(`${CONFIG.institutionOrigin}/api/v1/courses`, CONFIG, budget, fetchImpl)).rejects.toThrow(
      BudgetExceededError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("parseCanvasId", () => {
  it("accepts a small, safe JSON number", () => {
    expect(parseCanvasId(9001)).toEqual({ status: "safe", id: "9001" });
  });

  it("accepts a small, safe numeric string", () => {
    expect(parseCanvasId("9001")).toEqual({ status: "safe", id: "9001" });
  });

  it("rejects a number above Number.MAX_SAFE_INTEGER", () => {
    expect(parseCanvasId(Number.MAX_SAFE_INTEGER + 2).status).toBe("unsafe");
  });

  it("rejects the fixture's deliberately-unsafe string id, even though strings don't lose precision in JSON", () => {
    expect(parseCanvasId(fixture.unsafeCourseId).status).toBe("unsafe");
  });

  it("rejects a non-numeric string, zero, and a negative number", () => {
    expect(parseCanvasId("course-9001").status).toBe("unsafe");
    expect(parseCanvasId(0).status).toBe("unsafe");
    expect(parseCanvasId(-9001).status).toBe("unsafe");
  });
});
