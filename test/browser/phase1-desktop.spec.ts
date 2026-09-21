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
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();

  // Responsive shell section: desktop keeps a persistent sidebar, i.e. the nav's list stacks
  // vertically rather than the mobile bottom tab bar's horizontal row.
  await expect(page.locator(".sidebar")).toHaveCSS("position", "sticky");

  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});

test("fills the available desktop workspace instead of retaining the former fixed-width cap", async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();

  const mainWidth = await page.getByRole("main").evaluate((main) => main.getBoundingClientRect().width);

  expect(mainWidth).toBeGreaterThan(2000);
  expect(mainWidth).toBeGreaterThan(2400 - 236 - 80);
});

test("is fully keyboard-operable: details and navigation activate without a pointer", async ({ page }) => {
  await page.goto("/");
  const row = page.locator(".event-card", { hasText: "Group project proposal" });
  const chevron = row.getByRole("button", { name: "Details" });

  await chevron.focus();
  await expect(chevron).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chevron).toHaveAttribute("aria-expanded", "true");

  const inbox = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Inbox" });
  await inbox.focus();
  await expect(inbox).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
});

test("uses the owner-approved dark palette by default and under system dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
  const defaultBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(defaultBackground).toBe("rgb(13, 20, 27)");

  await page.emulateMedia({ colorScheme: "dark" });
  const darkSystemBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(darkSystemBackground).toBe("rgb(13, 20, 27)");
});
