import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

interface LocalFixture { readonly coursework: string }

async function fixture(): Promise<LocalFixture> {
  return JSON.parse(await readFile(path.resolve("test-results", "local-playwright-fixture.json"), "utf8")) as LocalFixture;
}

async function openTimeline(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
}

test.describe("local Marymount dashboard", () => {
  test("renders the synthetic Canvas profile avatar and falls back on image failure", async ({ page }) => {
    await page.route("**/api/local/profile/avatar", async (route) => {
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("not-an-image") });
    });
    await openTimeline(page);
    const avatar = page.locator(".brand-avatar");
    await expect(avatar).toHaveAttribute("alt", "Alex Student");
    await expect(avatar).toHaveAttribute("src", "/api/local/profile/avatar");
    await expect(avatar).toBeHidden();
    await expect(page.locator(".brand-initials")).toHaveText("AS");
    await page.unroute("**/api/local/profile/avatar");
  });

  test("navigates every dashboard panel against the local projection", async ({ page }) => {
    await openTimeline(page);
    const panels = [
      ["Grades", "Grades"],
      ["Inbox", "Inbox"],
      ["Done", "Completed"],
      ["Courses", "Courses"],
      ["Library", "Library"],
      ["Activity", "Activity"],
      ["More", "More"],
      ["Timeline", "Timeline"],
    ] as const;
    for (const [link, heading] of panels) {
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: link, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    }
    await page.getByRole("link", { name: "Grades", exact: true }).click();
    await expect(page.locator(".grade-summary-card")).toHaveCount(1);
    await expect(page.locator(".grade-summary-card__grade")).toBeVisible();
    await expect(page.locator(".grade-summary-card details")).toHaveCount(1);
    await expect(page.getByText("Synthetic Submitted Work", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await expect(page.getByText("Synthetic syllabus.pdf", { exact: true })).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Open", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("7001-synthetic-syllabus.pdf");
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    if (downloadPath === null) throw new Error("Library download did not produce a file path");
    await expect(readFile(downloadPath, "utf8")).resolves.toBe("synthetic local file\n");
    await page.getByRole("link", { name: "Inbox", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Synthetic inbox message", exact: true })).toBeVisible();
    await expect(page.getByText("This is a synthetic Canvas inbox message.", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Activity", exact: true }).click();
    await page.locator(".history-row").filter({ hasText: "+1 added · 1 changed · 0 removed" }).click();
    await expect(page.getByText(/Submission: Not submitted.*Submitted/)).toBeVisible();
  });

  test("aligns grade group disclosures across differently wrapped course cards", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/api/dashboard", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          courses: [
            { id: "grade-530", courseCode: "IT530", title: "Computer Security", gradeGroups: [{ id: "g530", name: "Labs and papers", weight: 100 }] },
            { id: "grade-540", courseCode: "IT540", title: "Enterprise Data Management and Analysis with Applied Exercises", gradeGroups: [{ id: "g540", name: "Weekly labs and applied exercises", weight: 100 }] },
            { id: "grade-570", courseCode: "IT570", title: "Cybersecurity Law, Policy, Ethics, and Compliance", gradeGroups: [{ id: "g570", name: "Discussions and case analyses", weight: 100 }] },
          ],
          events: [
            { id: "grade-event-530", courseId: "grade-530", courseCode: "IT530", kind: "deadline", title: "Security lab", startsAt: "2026-09-28T23:59:00Z", completed: false, points: 100, score: 92, assignmentGroupId: "g530", assignmentGroupName: "Labs and papers", assignmentGroupWeight: 100 },
            { id: "grade-event-540", courseId: "grade-540", courseCode: "IT540", kind: "deadline", title: "Applied data management exercise", startsAt: "2026-09-29T23:59:00Z", completed: false, points: 100, score: 87, assignmentGroupId: "g540", assignmentGroupName: "Weekly labs and applied exercises", assignmentGroupWeight: 100 },
            { id: "grade-event-570", courseId: "grade-570", courseCode: "IT570", kind: "deadline", title: "Policy discussion", startsAt: "2026-09-30T23:59:00Z", completed: false, points: 100, assignmentGroupId: "g570", assignmentGroupName: "Discussions and case analyses", assignmentGroupWeight: 100 },
          ],
          resources: [], conversations: [], refreshes: [], refreshAvailable: false, sourceStatus: { state: "ready" },
        }),
      });
    });
    await openTimeline(page);
    await page.getByRole("link", { name: "Grades", exact: true }).click();
    const cards = page.locator(".grade-summary-card");
    await expect(cards).toHaveCount(3);
    const disclosureTops = await page.locator(".grade-summary-groups").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
    expect(disclosureTops).toHaveLength(3);
    const spread = Math.max(...disclosureTops) - Math.min(...disclosureTops);
    expect(spread).toBeLessThanOrEqual(1);
    await page.unroute("**/api/dashboard");
  });

  test("persists discussion main post and classmate replies independently", async ({ page }) => {
    await openTimeline(page);
    const card = page.locator(".event-card", { hasText: "Synthetic Discussion Board" });
    await expect(card).toBeVisible();
    const post = card.getByRole("checkbox", { name: "Posted my response" });
    const replies = card.getByRole("checkbox", { name: "Replied to two classmates" });
    await post.check();
    await expect(post).toBeChecked();
    await expect(replies).not.toBeChecked();
    await replies.check();
    await expect(replies).toBeChecked();
    await expect(card.getByRole("checkbox", { name: "Done" })).not.toBeChecked();

    await page.reload();
    const reloaded = page.locator(".event-card", { hasText: "Synthetic Discussion Board" });
    await expect(reloaded.getByRole("checkbox", { name: "Posted my response" })).toBeChecked();
    await expect(reloaded.getByRole("checkbox", { name: "Replied to two classmates" })).toBeChecked();
    await expect(reloaded.getByRole("checkbox", { name: "Done" })).not.toBeChecked();
  });

  test("renews a stale CSRF cookie and retries a completion mutation", async ({ page, context }) => {
    await openTimeline(page);
    const card = page.locator(".event-card", { hasText: "Synthetic Pending Work" });
    const checkbox = card.getByRole("checkbox", { name: "Done" });
    let firstRequest = true;
    let renewCookieOnNextDocument = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (!renewCookieOnNextDocument || request.method() !== "GET" || new URL(request.url()).pathname !== "/") {
        await route.continue();
        return;
      }
      renewCookieOnNextDocument = false;
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "set-cookie": "duegood_local_csrf=retry-token; Path=/; SameSite=Lax" } });
    });
    await page.route("**/api/source-items/*/completion", async (route) => {
      if (!firstRequest) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ completed: true, completedAt: Date.now() }) });
        return;
      }
      firstRequest = false;
      renewCookieOnNextDocument = true;
      await context.addCookies([{ name: "duegood_local_csrf", value: "stale-token", url: page.url() }]);
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "csrf rejected" }) });
    });
    await checkbox.click();
    await expect(page.locator(".event-card", { hasText: "Synthetic Pending Work" })).toHaveCount(0);
    expect(firstRequest).toBe(false);
    await page.unroute("**/api/source-items/*/completion");
    await page.unroute("**/*");

    await expect(page.getByRole("link", { name: "Done", exact: true })).toBeVisible();
  });

  test("reloads authoritative state when a completion write returns a version conflict", async ({ page }) => {
    const localFixture = await fixture();
    await openTimeline(page);
    const card = page.locator(".event-card", { hasText: "Synthetic Pending Work" });
    await expect(card).toBeVisible();
    const document = JSON.parse(await readFile(localFixture.coursework, "utf8")) as { generated: string };
    document.generated = new Date().toISOString();
    await writeFile(localFixture.coursework, `${JSON.stringify(document, null, 2)}\n`);
    await card.getByRole("checkbox", { name: "Done" }).click();
    await expect(card.getByRole("status")).toContainText("This item changed elsewhere");
    await expect(card.getByRole("checkbox", { name: "Done" })).not.toBeChecked();
  });

  test("fills desktop width and exposes the complete mobile navigation", async ({ page }) => {
    await page.setViewportSize({ width: 2400, height: 1000 });
    await openTimeline(page);
    const mainWidth = await page.getByRole("main").evaluate((main) => main.getBoundingClientRect().width);
    expect(mainWidth).toBeGreaterThan(2000);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator(".sidebar")).toHaveCSS("position", "fixed");
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link")).toHaveCount(8);
    await expect(page.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
  });

  test("copies assignment plain text with polite feedback on timeline card and rail item, and handles copy failure", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openTimeline(page);

    // 1. Timeline non-class assignment card copy
    const card = page.locator(".event-card", { hasText: "Synthetic Pending Work" });
    await expect(card).toBeVisible();
    const copyButton = card.getByRole("button", { name: "Copy assignment" });
    await expect(copyButton).toBeVisible();
    await copyButton.click();

    // Verify "Copied" feedback appears on the polite live control
    await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Copied" })).toHaveAttribute("aria-live", "polite");

    // Verify clipboard content from card
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain("Course code: SYN-101");
    expect(clipboardText).toContain("Assignment title: Synthetic Pending Work");
    expect(clipboardText).toContain("Due date/time:");
    expect(clipboardText).toContain("Points: 10");
    expect(clipboardText).toContain("Due Good completion status: Not completed");
    expect(clipboardText).toContain("Assignment details: Invented pending detail.");

    // 2. Due Soon rail item copy shares the identical formatter
    const railRow = page.locator(".rail-due-row", { hasText: "Synthetic Pending Work" });
    await expect(railRow).toBeVisible();
    const railCopyButton = railRow.getByRole("button", { name: "Copy assignment" });
    await expect(railCopyButton).toBeVisible();
    await railCopyButton.click();
    await expect(railRow.getByRole("button", { name: "Copied" })).toBeVisible();

    const railClipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(railClipboardText).toBe(clipboardText);

    // 3. Discussion assignment copy includes Main post and Replies to classmates
    const discussionCard = page.locator(".event-card", { hasText: "Synthetic Discussion Board" });
    await expect(discussionCard).toBeVisible();
    await discussionCard.getByRole("button", { name: "Copy assignment" }).click();
    await expect(discussionCard.getByRole("button", { name: "Copied" })).toBeVisible();

    const discussionClipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(discussionClipboardText).toContain("Course code: SYN-101");
    expect(discussionClipboardText).toContain("Assignment title: Synthetic Discussion Board");
    expect(discussionClipboardText).toContain("Main post: Completed");
    expect(discussionClipboardText).toContain("Replies to classmates: Completed");
    expect(discussionClipboardText).toContain("Assignment details: Complete the main post and reply to two classmates.");

    // 4. Accessible failure state: "Could not copy" when clipboard write fails
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new Error("clipboard rejected")),
        },
      });
      document.execCommand = () => false;
    });

    await card.locator(".copy-button").click();
    await expect(card.getByRole("button", { name: "Could not copy" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Could not copy" })).toHaveAttribute("aria-live", "polite");
    await expect(card.getByRole("button", { name: "Copy assignment" })).toBeVisible({ timeout: 3_500 });
  });
});
