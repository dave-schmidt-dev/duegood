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

test.describe("This Week — populated route", () => {
  test.beforeEach(async ({ context }) => {
    const fixture = await loadFixture();
    await context.addCookies([
      { name: "__Host-duegood_session", value: fixture.sessionToken, url: AUTH_TEST_ORIGIN, secure: true, httpOnly: true, sameSite: "Lax" },
    ]);
  });

  test("renders the heading, single-item nav, truthful sync status, and every seeded assignment", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "This Week" })).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link")).toHaveCount(1);
    await expect(nav.getByRole("link", { name: "This Week" })).toHaveAttribute("aria-current", "page");

    await expect(page.getByRole("status").first()).toContainText(/Connected & synced/);

    await expect(page.getByText("Reading response")).toBeVisible();
    await expect(page.getByText("Discussion post (no deadline)")).toBeVisible();
    await expect(page.getByText("Group project proposal")).toBeVisible();
  });

  test("renders an injected-markup title as literal text, never as executable markup", async ({ page }) => {
    await page.goto("/");
    const injectedTitle = INJECTED_MARKUP_TITLE;
    const row = page.locator(".assignment-row", { hasText: injectedTitle });
    await expect(row).toBeVisible();

    // The whole raw string — including the literal "<img..." characters — must appear as text
    // content, and no <img> element the string would have created if it had ever reached
    // innerHTML.
    await expect(row.locator("img")).toHaveCount(0);
    const xssFlag = await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss);
    expect(xssFlag).toBeUndefined();
  });

  test("expands an assignment's detail to show its due date and submission state distinctly", async ({ page }) => {
    await page.goto("/");
    const row = page.locator(".assignment-row", { hasText: "Reading response" });
    const chevron = row.getByRole("button");
    await expect(chevron).toHaveAttribute("aria-expanded", "false");

    await chevron.click();
    await expect(chevron).toHaveAttribute("aria-expanded", "true");
    await expect(row).toContainText("Submitted");

    const unknownRow = page.locator(".assignment-row", { hasText: "Group project proposal" });
    await unknownRow.getByRole("button").click();
    await expect(unknownRow).toContainText("Submission status unknown");
  });
});
