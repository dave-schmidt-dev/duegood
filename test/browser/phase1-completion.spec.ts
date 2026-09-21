import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { AUTH_TEST_ORIGIN } from "../../playwright.config";

interface SessionFixture {
  readonly sessionToken: string;
  readonly csrfToken: string;
}

test.beforeEach(async ({ context }) => {
  const raw = await readFile(path.resolve("test-results", "playwright-session-fixture.json"), "utf8");
  const fixture = JSON.parse(raw) as SessionFixture;
  await context.addCookies([
    { name: "__Host-duegood_session", value: fixture.sessionToken, url: AUTH_TEST_ORIGIN, secure: true, httpOnly: true, sameSite: "Lax" },
    // Not HttpOnly, matching `buildCsrfCookie` — `src/ui/csrf.ts` reads this via `document.cookie`
    // for every real page click that mutates completion state. Without it, `readCsrfToken()`
    // returns `undefined` and the app correctly, silently declines to mutate — an honest failure
    // in the app, but the wrong one to hit in a test exercising the success path.
    { name: "__Host-duegood_csrf", value: fixture.csrfToken, url: AUTH_TEST_ORIGIN, secure: true, httpOnly: false, sameSite: "Lax" },
  ]);
});

/**
 * Exercises the one control bound to the personal-completion route through a real browser click,
 * not just the seeded API call `session-seed.spec.ts` already covers — this asserts the value
 * survives a full page reload (proving it's actually persisted, not just held in page state), and
 * that an injected Worker mutation failure produces the honest, accessible retry state the
 * checkbox must show rather than silently reverting with no explanation.
 *
 * Reads the checkbox's *current* state before acting rather than assuming it starts unchecked —
 * `test/browser/session-seed.spec.ts` toggles a different fixture item ("Reading response") but
 * shares this same seeded account, and `playwright.config.ts` runs every spec file sequentially
 * (`workers: 1`) rather than isolating fixture state per file.
 */
test("persists a completion toggle across reload, and recovers honestly from an injected mutation failure", async ({ page }) => {
  await page.goto("/");
  const row = page.locator(".event-card", { hasText: "Group project proposal" });
  await row.getByRole("button", { name: "Details" }).click();
  await row.getByRole("button", { name: "Mark complete" }).click();
  await page.getByRole("link", { name: "Done" }).click();
  await expect(page.locator(".completed-row", { hasText: "Group project proposal" })).toBeVisible();

  await page.reload();
  await page.getByRole("link", { name: "Done" }).click();
  const reloadedRow = page.locator(".completed-row", { hasText: "Group project proposal" });
  await expect(reloadedRow).toBeVisible();

  let interceptedOnce = false;
  await page.route("**/api/source-items/*/completion", async (route) => {
    if (!interceptedOnce) {
      interceptedOnce = true;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "injected_failure" }) });
      return;
    }
    await route.continue();
  });

  await reloadedRow.getByRole("button", { name: "Mark not done" }).click();
  await expect(reloadedRow.getByRole("status")).toContainText(/Could not save/i);
  await expect(reloadedRow).toBeVisible();
  await reloadedRow.getByRole("button", { name: "Mark not done" }).click();
  await expect(reloadedRow).toHaveCount(0);
});
