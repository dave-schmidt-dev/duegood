import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { AUTH_TEST_ORIGIN } from "../../playwright.config";
import { automaticAccessibilityViolations } from "./a11y";

interface SessionFixture {
  readonly sessionToken: string;
  readonly disconnectedSessionToken: string;
  readonly noCourseSessionToken: string;
}

async function loadFixture(): Promise<SessionFixture> {
  const raw = await readFile(path.resolve("test-results", "playwright-session-fixture.json"), "utf8");
  return JSON.parse(raw) as SessionFixture;
}

async function signInAs(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([{ name: "__Host-duegood_session", value: token, url: AUTH_TEST_ORIGIN, secure: true, httpOnly: true, sameSite: "Lax" }]);
}

test("the populated This Week route, including an expanded assignment detail, has no automated accessibility violations", async ({ page, context }) => {
  const fixture = await loadFixture();
  await signInAs(context, fixture.sessionToken);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This Week" })).toBeVisible();

  // Expand a detail panel before scanning — axe should still find zero violations with the
  // dl/dt/dd detail content and the aria-expanded chevron in their "open" state.
  await page.locator(".assignment-row", { hasText: "Reading response" }).getByRole("button").click();
  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});

test("the disconnected recovery state emits an accessible status message with no automated accessibility violations", async ({ page, context }) => {
  const fixture = await loadFixture();
  await signInAs(context, fixture.disconnectedSessionToken);
  await page.goto("/");

  const status = page.getByRole("status");
  await expect(status).toContainText("No Canvas connection");
  await expect(status.getByRole("link", { name: "Connect to Canvas" })).toHaveAttribute("href", "/auth/canvas/start");
  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});

test("the no-course-selected recovery state emits a distinct accessible status message", async ({ page, context }) => {
  const fixture = await loadFixture();
  await signInAs(context, fixture.noCourseSessionToken);
  await page.goto("/");

  const status = page.getByRole("status");
  await expect(status).toContainText("No course connected yet");
  // Only the disconnected state offers the Canvas connect action (recovery-panel.ts).
  await expect(status.getByRole("link")).toHaveCount(0);
  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});
