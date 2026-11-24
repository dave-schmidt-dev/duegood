import { expect, test } from "@playwright/test";
import { openDesktop, scenario } from "./desktop-first-run-fixtures";

test("CR7: selecting a conversation at 720px brings thread into view and return button restores list", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 700 });
  const syntheticConversations = Array.from({ length: 25 }, (_, i) => ({
    canvasConversationId: `conv-${i}`,
    subject: `Synthetic Thread ${i}`,
    unread: false,
    starred: false,
    messageCount: 2,
    latestMessageAt: new Date(Date.now() - i * 3600_000).toISOString(),
    latestMessagePreview: `Preview snippet for thread ${i}`,
    participants: [{ canvasUserId: `user-${i}`, name: `Instructor ${i}` }],
    messages: [{ canvasMessageId: `msg-${i}`, author: `Instructor ${i}`, body: `Detailed thread content for conversation ${i}` }],
  }));
  const conversationsJson = JSON.stringify({ complete: true, conversations: syntheticConversations });

  await openDesktop(page, scenario({ state: "authoritative", conversationsJson }));
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

  const conv20 = page.locator(".message-list .message-row").filter({ hasText: "Synthetic Thread 20" });
  await expect(page.locator(".message-row")).toHaveCount(25);
  await conv20.scrollIntoViewIfNeeded();
  await expect(conv20).toBeVisible();
  const listScrollY = await page.evaluate(() => window.scrollY);
  expect(listScrollY).toBeGreaterThan(0);
  await conv20.click();

  // Thread view opens immediately and start of thread is in view
  const threadHeading = page.locator(".message-detail h2");
  await expect(threadHeading).toBeVisible();
  await expect(threadHeading).toHaveText("Synthetic Thread 20");
  await expect.poll(() => threadHeading.evaluate((heading) => {
    const bounds = heading.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  })).toBe(true);

  // Back button is visible on narrow screens
  const backButton = page.locator(".inbox-back-button");
  await expect(backButton).toBeVisible();
  await backButton.click();

  // Returns to conversation list, conv-20 remains selected and in view
  await expect(conv20).toBeVisible();
  await expect(conv20).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(listScrollY);
  await expect.poll(() => conv20.evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  })).toBe(true);
});

test("CR8: labels possible source matches with recognizable coursework", async ({ page }) => {
  const courseworkWithLinks = JSON.stringify({
    generated: new Date().toISOString(),
    courses: [
      { key: "syn-101", code: "SYN 101", title: "Synthetic Studies 1", color: "#3a6ea5", folder: "syn-101" },
      { key: "syn-102", code: "SYN 102", title: "Synthetic Studies 2", color: "#e28448", folder: "syn-102" },
    ],
    items: [
      { id: "item-1", course: "syn-101", kind: "assignment", title: "Final Project", at: "2026-12-15T23:59:00Z", submissionStatus: "unsubmitted", done: false },
      { id: "item-2", course: "syn-102", kind: "assignment", title: "Final Project", at: "2026-12-18T23:59:00Z", submissionStatus: "unsubmitted", done: false },
      { id: "item-3", course: "syn-101", kind: "assignment", title: "Untitled Task", at: null, submissionStatus: "unsubmitted", done: false },
    ],
    pendingSourceLinks: [
      {
        id: JSON.stringify(["mu", "syn-101", "canvas", "canvas-assign-1", null]),
        localId: "item-1",
        course: "syn-101",
        reference: { institution: "mu", course: "syn-101", source: "canvas", id: "canvas-assign-1" },
        verifiedReferences: [],
        fields: { kind: "assignment", title: "Final Project", at: "2026-12-15T23:59:00Z" },
        candidateIds: ["item-1"],
        reason: "ambiguous-match",
      },
      {
        id: JSON.stringify(["mu", "syn-102", "canvas", "canvas-assign-2", null]),
        localId: "item-2",
        course: "syn-102",
        reference: { institution: "mu", course: "syn-102", source: "canvas", id: "canvas-assign-2" },
        verifiedReferences: [],
        fields: { kind: "assignment", title: "Final Project", at: "2026-12-18T23:59:00Z" },
        candidateIds: ["item-2"],
        reason: "ambiguous-match",
      },
      {
        id: JSON.stringify(["mu", "syn-101", "canvas", "canvas-assign-3", null]),
        localId: "item-3",
        course: "syn-101",
        reference: { institution: "mu", course: "syn-101", source: "canvas", id: "canvas-assign-3" },
        verifiedReferences: [],
        fields: { kind: "assignment" },
        candidateIds: ["item-3"],
        reason: "ambiguous-match",
      },
    ],
  });

  await openDesktop(page, scenario({ state: "authoritative", coursework: courseworkWithLinks }));
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();

  const queue = page.locator(".pending-link-queue");
  await expect(queue).toBeVisible();

  // Check button text for recognizable coursework details
  const buttons = queue.locator("button");
  await expect(buttons).toHaveCount(3);

  const text0 = await buttons.nth(0).innerText();
  const text1 = await buttons.nth(1).innerText();
  const text2 = await buttons.nth(2).innerText();

  // Repeated title "Final Project" in different courses are recognizable and distinguished
  expect(text0).toContain("Final Project");
  expect(text0).toContain("SYN 101");
  expect(text0).toMatch(/Due .*Dec 15/);
  expect(text1).toContain("Final Project");
  expect(text1).toContain("SYN 102");
  expect(text1).toMatch(/Due .*Dec 18/);
  expect(text0).not.toEqual(text1);

  // Untitled task has explicit fallback
  expect(text2).toContain("Untitled coursework");

  // Source ID is preserved in comparison card
  const comparison = page.locator(".pending-link-comparison");
  await expect(comparison).toBeVisible();
  await expect(comparison).toContainText("canvas-assign-1");
});
