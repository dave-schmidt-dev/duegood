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

test("the populated Timeline route, including an expanded assignment detail, has no automated accessibility violations", async ({ page, context }) => {
  const fixture = await loadFixture();
  await signInAs(context, fixture.sessionToken);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();

  // Expand a detail panel before scanning — axe should still find zero violations with the
  // dl/dt/dd detail content and the aria-expanded chevron in their "open" state.
  await page.locator(".event-card", { hasText: "Group project proposal" }).getByRole("button", { name: "Details" }).click();
  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});

test("the disconnected fallback remains truthful and accessible", async ({ page, context }) => {
  const fixture = await loadFixture();
  await signInAs(context, fixture.disconnectedSessionToken);
  await page.goto("/");

  await page.getByRole("link", { name: "More" }).click();
  await expect(page.getByText("No active Canvas connection.")).toBeVisible();
  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});

test("the no-course fallback emits a distinct accessible source state", async ({ page, context }) => {
  const fixture = await loadFixture();
  await signInAs(context, fixture.noCourseSessionToken);
  await page.goto("/");

  await page.getByRole("link", { name: "More" }).click();
  await expect(page.getByText("No course has been selected.")).toBeVisible();
  expect(await automaticAccessibilityViolations(page)).toEqual([]);
});
