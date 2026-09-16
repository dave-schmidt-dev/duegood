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
  const row = page.locator(".assignment-row", { hasText: "Group project proposal" });
  const checkbox = row.getByRole("checkbox");
  await expect(checkbox).toBeVisible();

  const before = await checkbox.isChecked();
  await checkbox.click();
  await expect(checkbox).toBeChecked({ checked: !before });

  await page.reload();
  const reloadedRow = page.locator(".assignment-row", { hasText: "Group project proposal" });
  const reloadedCheckbox = reloadedRow.getByRole("checkbox");
  await expect(reloadedCheckbox).toBeChecked({ checked: !before });

  let interceptedOnce = false;
  await page.route("**/api/source-items/*/completion", async (route) => {
    if (!interceptedOnce) {
      interceptedOnce = true;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "injected_failure" }) });
      return;
    }
    await route.continue();
  });

  const persisted = !before;
  await reloadedCheckbox.click();
  await expect(reloadedRow.getByRole("status")).toContainText(/retry/i);
  // Reverted to the last known-good (persisted) value — never left "stuck" on the optimistic one.
  await expect(reloadedCheckbox).toBeChecked({ checked: persisted });

  await reloadedRow.getByRole("button", { name: "Retry" }).click();
  await expect(reloadedCheckbox).toBeChecked({ checked: !persisted });
  await expect(reloadedRow.getByRole("status")).toHaveCount(0);
});
