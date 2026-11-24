import { expect, test } from "@playwright/test";
import { openDashboard, visit } from "./refresh-pages-fixtures";

test("CR1: verified empty sources report 0 unread/items/done without claiming unsynced", async ({ page }) => {
  await openDashboard(page, { mode: "canvas", verifiedEmpty: true });
  await visit(page, "Inbox");
  await expect(page.locator(".subpage-heading .page-count")).toHaveText("0 unread");
  await expect(page.locator(".empty-state")).toHaveText("No conversations in your Canvas inbox.");
  await expect(page.locator(".empty-state")).not.toContainText("have not been synced yet");

  await visit(page, "Library");
  await expect(page.locator(".subpage-heading .page-count")).toHaveText("0 items");
  await expect(page.locator(".empty-state")).toHaveText("No Canvas library items were found in the verified refresh.");
  await expect(page.locator(".empty-state")).not.toContainText("have not been synced yet");

  await visit(page, "Done");
  await expect(page.locator(".subpage-heading .page-count")).toHaveText("0 complete");
  await expect(page.locator(".empty-state")).toHaveText("Nothing completed yet.");

  await visit(page, "Courses");
  await expect(page.locator(".course-card .course-fact dd").first()).toHaveText("Nothing upcoming");
});

test("CR1: unavailable Canvas data produces unverified labels and retains calendar deadline", async ({ page }) => {
  await openDashboard(page, { mode: "canvas", staleCapture: true, noDeadlines: false });
  await visit(page, "Inbox");
  await expect(page.locator(".subpage-heading .page-count")).toHaveText("Inbox unverified");
  await expect(page.locator(".empty-state")).not.toContainText("have not been synced yet");

  await visit(page, "Library");
  await expect(page.locator(".subpage-heading .page-count")).toHaveText("Items unverified");
  await expect(page.locator(".empty-state")).toContainText("could not be verified");

  await visit(page, "Done");
  await expect(page.locator(".subpage-heading .page-count")).toHaveText("Completion unverified");
  await expect(page.locator(".empty-state")).toContainText("could not be verified");

  await visit(page, "Courses");
  await expect(page.locator(".course-card .course-fact dd").first()).toHaveText("Synthetic calendar deadline");

  await visit(page, "Timeline");
  await expect(page.locator(".source-freshness-notice")).toContainText("retained calendar deadlines and personal records remain available");
  await expect(page.locator(".timeline-rail")).toContainText("Synthetic calendar deadline");
});

for (const width of [720, 1280] as const) {
  test(`CR4: refresh outcome remains visible beside refresh at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 700 });
    await openDashboard(page, { mode: "canvas" });
    const syncNote = page.locator(".sync-note");
    await expect(syncNote).toBeVisible();

    await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(syncNote).toBeVisible();
    await expect(syncNote).toHaveText("Refresh complete");
    await page.screenshot({ path: testInfo.outputPath(`refresh-complete-${width}.png`) });
  });

  test(`CR4 & CR5: sign-in verification failure outcome and interactive recovery at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 700 });
    await openDashboard(page, { mode: "full", fullErrorCode: "canvas-verification-required" });
    const syncNote = page.locator(".sync-note");
    await expect(syncNote).toBeVisible();

    await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(syncNote).toBeVisible();
    await expect(syncNote).toContainText("Canvas needs an extra verification step");
    await expect(page.locator(".canvas-setup-dialog")).toHaveCount(0);

    const details = page.locator(".top-actions .refresh-details");
    await details.locator("summary").click();
    const diagnostics = details.locator("p");
    await expect(diagnostics).toBeVisible();
    await expect(diagnostics).toContainText(/verification/i);
    const diagnosticBounds = await diagnostics.boundingBox();
    expect(diagnosticBounds).not.toBeNull();
    expect(diagnosticBounds!.x).toBeGreaterThanOrEqual(0);
    expect(diagnosticBounds!.x + diagnosticBounds!.width).toBeLessThanOrEqual(width);
    expect(diagnosticBounds!.y).toBeGreaterThanOrEqual(0);
    expect(diagnosticBounds!.y + diagnosticBounds!.height).toBeLessThanOrEqual(700);
    await page.screenshot({ path: testInfo.outputPath(`refresh-details-${width}.png`) });
    await details.locator("summary").click();

    const setupBtn = page.locator(".setup-instructions-btn");
    await expect(setupBtn).toBeVisible();
    await setupBtn.click();

    const dialog = page.locator(".canvas-setup-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Visible Canvas setup session" })).toBeVisible();
    await expect(dialog.locator(".setup-steps-list li")).toHaveCount(5);
    await page.screenshot({ path: testInfo.outputPath(`canvas-setup-${width}.png`) });

    const returnBtn = dialog.locator('[data-return-to-refresh="true"]');
    await expect(returnBtn).toBeVisible();
    await returnBtn.click();

    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".top-actions .refresh-button")).toBeFocused();
  });
}
