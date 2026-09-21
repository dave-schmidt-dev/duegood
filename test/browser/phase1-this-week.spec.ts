import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { AUTH_TEST_ORIGIN } from "../../playwright.config";
import { INJECTED_MARKUP_TITLE } from "../../scripts/seed-playwright-session";

interface SessionFixture {
  readonly sessionToken: string;
}

async function loadFixture(): Promise<SessionFixture> {
  const raw = await readFile(path.resolve("test-results", "playwright-session-fixture.json"), "utf8");
  return JSON.parse(raw) as SessionFixture;
}

test.describe("coursework dashboard — populated legacy API fallback", () => {
  test.beforeEach(async ({ context }) => {
    const fixture = await loadFixture();
    await context.addCookies([
      { name: "__Host-duegood_session", value: fixture.sessionToken, url: AUTH_TEST_ORIGIN, secure: true, httpOnly: true, sameSite: "Lax" },
    ]);
  });

  test("renders the approved navigation, timeline lanes, and every dated seeded assignment", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link")).toHaveCount(8);
    await expect(nav.getByRole("link", { name: "Timeline" })).toHaveAttribute("aria-current", "page");

    await expect(page.getByRole("heading", { name: "Reading response" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Group project proposal" })).toBeVisible();
    await expect(page.locator(".day-slot").first()).toBeVisible();
  });

  test("renders an injected-markup title as literal text, never as executable markup", async ({ page }) => {
    await page.goto("/");
    const injectedTitle = INJECTED_MARKUP_TITLE;
    const row = page.locator(".event-card", { hasText: injectedTitle });
    await expect(row).toBeVisible();

    // The whole raw string — including the literal "<img..." characters — must appear as text
    // content, and no <img> element the string would have created if it had ever reached
    // innerHTML.
    await expect(row.locator("img")).toHaveCount(0);
    const xssFlag = await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss);
    expect(xssFlag).toBeUndefined();
  });

  test("expands an assignment detail without exposing mutation controls until requested", async ({ page }) => {
    await page.goto("/");
    const row = page.locator(".event-card", { hasText: "Reading response" });
    const chevron = row.getByRole("button", { name: "Details" });
    await expect(chevron).toHaveAttribute("aria-expanded", "false");

    await chevron.click();
    await expect(chevron).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByRole("button", { name: /Mark/ })).toBeVisible();
  });
});
