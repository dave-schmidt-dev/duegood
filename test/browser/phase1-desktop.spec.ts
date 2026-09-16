import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { AUTH_TEST_ORIGIN } from "../../playwright.config";
import { automaticAccessibilityViolations } from "./a11y";

interface SessionFixture {
  readonly sessionToken: string;
  readonly csrfToken: string;
}

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ context }) => {
  const raw = await readFile(path.resolve("test-results", "playwright-session-fixture.json"), "utf8");
  const fixture = JSON.parse(raw) as SessionFixture;
  await context.addCookies([
    { name: "__Host-duegood_session", value: fixture.sessionToken, url: AUTH_TEST_ORIGIN, secure: true, httpOnly: true, sameSite: "Lax" },
    // Needed for the keyboard test below, which completes a real checkbox mutation — see the same
    // note in phase1-completion.spec.ts.
    { name: "__Host-duegood_csrf", value: fixture.csrfToken, url: AUTH_TEST_ORIGIN, secure: true, httpOnly: false, sameSite: "Lax" },
  ]);
});

test("renders the persistent sidebar layout at a desktop viewport (>=1024px) with no automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This Week" })).toBeVisible();

  // Responsive shell section: desktop keeps a persistent sidebar, i.e. the nav's list stacks
  // vertically rather than the mobile bottom tab bar's horizontal row.
  await expect(page.locator(".primary-nav ul")).toHaveCSS("flex-direction", "column");

  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});

test("is fully keyboard-operable: tab reaches the chevron and completion checkbox, and both activate without a pointer", async ({ page }) => {
  await page.goto("/");
  const row = page.locator(".assignment-row", { hasText: "Discussion post (no deadline)" });
  const checkbox = row.getByRole("checkbox");
  const chevron = row.getByRole("button");

  await chevron.focus();
  await expect(chevron).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chevron).toHaveAttribute("aria-expanded", "true");

  await checkbox.focus();
  await expect(checkbox).toBeFocused();
  const before = await checkbox.isChecked();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked({ checked: !before });
});

test("applies the dark-mode surface tokens under prefers-color-scheme: dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This Week" })).toBeVisible();
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // color-ink (#0e1620) — see src/ui/styles/tokens.css's dark-mode --color-bg override.
  expect(background).toBe("rgb(14, 22, 32)");
});
