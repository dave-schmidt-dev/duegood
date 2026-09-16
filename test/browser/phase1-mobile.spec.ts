import { readFile } from "node:fs/promises";
import path from "node:path";
import { devices, expect, test } from "@playwright/test";
import { AUTH_TEST_ORIGIN } from "../../playwright.config";
import { automaticAccessibilityViolations } from "./a11y";

interface SessionFixture {
  readonly sessionToken: string;
}

// A Chromium-based device, not devices["iPhone 13"] (WebKit) — this project only installs the
// Chromium browser binary (see `scripts/install-test-browser.mjs`).
test.use({ ...devices["Pixel 5"] });

test.beforeEach(async ({ context }) => {
  const raw = await readFile(path.resolve("test-results", "playwright-session-fixture.json"), "utf8");
  const fixture = JSON.parse(raw) as SessionFixture;
  await context.addCookies([
    { name: "__Host-duegood_session", value: fixture.sessionToken, url: AUTH_TEST_ORIGIN, secure: true, httpOnly: true, sameSite: "Lax" },
  ]);
});

test("renders the fixed bottom tab bar at a mobile viewport (<768px) with no automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This Week" })).toBeVisible();

  // Responsive shell section: mobile collapses the sidebar into a fixed bottom tab bar — same nav
  // markup as desktop (`src/ui/routes.ts`'s `primaryNav`), only the CSS position changes.
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toHaveCSS("position", "fixed");
  await expect(page.locator(".primary-nav ul")).not.toHaveCSS("flex-direction", "column");

  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});

test("phase 1's mobile shell has a single tab, matching the deferred-navigation inventory", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link")).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "This Week" })).toBeVisible();
});

test("every interactive control has a tap-equivalent target of at least 44x44px", async ({ page }) => {
  await page.goto("/");
  const row = page.locator(".assignment-row").first();
  const checkboxBox = await row.getByRole("checkbox").boundingBox();
  const chevronBox = await row.getByRole("button").boundingBox();
  expect(checkboxBox?.width).toBeGreaterThanOrEqual(44);
  expect(checkboxBox?.height).toBeGreaterThanOrEqual(44);
  expect(chevronBox?.width).toBeGreaterThanOrEqual(44);
  expect(chevronBox?.height).toBeGreaterThanOrEqual(44);
});
