import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { AUTH_TEST_ORIGIN } from "../../playwright.config";

interface SessionFixture {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly accountId: number;
  readonly courseId: string;
}

/**
 * Proves the whole build-time seeding chain (`scripts/seed-playwright-session.ts`, wired into
 * `dev:test:auth` before this spec's server boots) actually produces a session Chromium will
 * accept and the real Worker will honor — not just that the script exits zero. `context.addCookies`
 * is used with `url` (never `domain`), since the session cookie is `__Host-` prefixed: Chromium
 * requires no `Domain` attribute on those, and `addCookies({domain, path})` would set one.
 */
test("a seeded session cookie authenticates a real request and returns the seeded assignments", async ({ page, context }) => {
  const fixtureRaw = await readFile(path.resolve("test-results", "playwright-session-fixture.json"), "utf8");
  const fixture = JSON.parse(fixtureRaw) as SessionFixture;

  await context.addCookies([
    {
      name: "__Host-duegood_session",
      value: fixture.sessionToken,
      url: AUTH_TEST_ORIGIN,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const response = await page.request.get("/api/assignments");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    assignments: { sourceItemId: string; title: string | null; courseId: string; completed: boolean }[];
  };
  expect(body.assignments.length).toBeGreaterThan(0);
  expect(body.assignments.every((item) => item.courseId === fixture.courseId)).toBe(true);
  expect(body.assignments.map((item) => item.title)).toContain("Reading response");

  const target = body.assignments.find((item) => item.title === "Reading response");
  expect(target).toBeDefined();
  expect(target?.completed).toBe(false);

  // Exercises the write path the read-only assertions above don't touch: the seeded `csrfToken`
  // must satisfy `checkMutationRequest`'s same-origin + CSRF-header guard
  // (src/auth/mutation-routes.ts), or every later completion-toggle browser test would inherit a
  // broken fixture. `page.request` shares the context's cookie jar (the session cookie added
  // above), but unlike a real page `fetch`, it never sets `Origin` on its own — confirmed
  // empirically (a first attempt without the header below got a 403) — so it's set explicitly to
  // pass the same-origin half of the guard; the CSRF header covers the other half.
  const completionResponse = await page.request.post(`/api/source-items/${target?.sourceItemId}/completion`, {
    headers: { Origin: AUTH_TEST_ORIGIN, "X-DueGood-CSRF-Token": fixture.csrfToken },
    data: { completed: true },
  });
  expect(completionResponse.status()).toBe(200);
  const completionBody = (await completionResponse.json()) as { completed: boolean; completedAt: number | null };
  expect(completionBody.completed).toBe(true);
  expect(completionBody.completedAt).not.toBeNull();
});
