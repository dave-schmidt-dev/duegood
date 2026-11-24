import { expect, test } from "@playwright/test";
import { NOW, openDashboard, selectNewestRefresh, visit } from "./refresh-pages-fixtures";

test("page panels have an accessible name while primary navigation remains available", async ({ page }) => {
  await openDashboard(page);
  await expect(page.getByRole("region", { name: "Due Good timeline page", exact: true })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("link", { name: "Timeline", exact: true })).toBeVisible();
  await visit(page, "Grades");
  await expect(page.getByRole("region", { name: "Due Good grades page", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Grades", exact: true })).toBeVisible();
});

test("Canvas refresh reloads every page from current synthetic store documents", async ({ page }) => {
  await openDashboard(page, { mode: "canvas" });
  await expect(page.getByRole("heading", { name: "Before Canvas deadline" })).toBeVisible();
  await expect(page.locator(".topbar .term-label")).toContainText("3 courses");
  await page.getByRole("button", { name: "SYN102", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Before second course" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Before Canvas deadline" })).toHaveCount(0);

  await visit(page, "Grades");
  await expect(page.locator(".grade-summary-card")).toHaveCount(3);
  await expect(page.getByText("80%", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Filter grades to SYN102" }).click();
  await visit(page, "Inbox");
  await page.getByRole("button", { name: /Selected synthetic thread/ }).click();
  await expect(page.getByText("Selected message before refresh", { exact: true })).toBeVisible();
  await visit(page, "Done");
  await expect(page.getByRole("heading", { name: "Before done item" })).toBeVisible();
  await visit(page, "Courses");
  await expect(page.getByRole("heading", { name: "Synthetic empty course" })).toBeVisible();
  await expect(page.locator(".course-card")).toHaveCount(3);
  await visit(page, "Library");
  await expect(page.getByRole("heading", { name: "Old Canvas file.pdf" })).toBeVisible();
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Old Canvas page" })).toBeVisible();
  await visit(page, "Activity");
  await expect(page.getByRole("heading", { name: /Canvas refresh ·/ })).toBeVisible();
  await visit(page, "More");
  await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Canvas refresh can be attempted on this computer.");

  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".sync-note")).toContainText("Refresh complete");
  await expect(page.locator(".topbar .term-label")).toContainText("2 courses");
  await expect(page.locator(".source-freshness-notice")).toHaveCount(0);

  await visit(page, "Timeline");
  await expect(page.getByRole("heading", { name: "After Canvas deadline" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Before second course" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "All courses", exact: true })).toHaveClass(/active/);
  await visit(page, "Grades");
  await expect(page.locator(".grade-summary-card")).toHaveCount(2);
  await expect(page.locator(".grade-summary-card__grade").filter({ hasText: "90%" })).toBeVisible();
  await expect(page.getByRole("button", { name: "All courses", exact: true })).toHaveClass(/active/);
  await visit(page, "Inbox");
  await expect(page.getByText("Selected message after refresh", { exact: true })).toBeVisible();
  await visit(page, "Done");
  await expect(page.getByRole("heading", { name: "After done item" })).toBeVisible();
  await visit(page, "Courses");
  await expect(page.getByRole("heading", { name: "Synthetic empty course" })).toBeVisible();
  await expect(page.locator(".course-card")).toHaveCount(2);
  await visit(page, "Library");
  await expect(page.getByRole("heading", { name: "New Canvas file.pdf" })).toBeVisible();
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveClass(/active/);
  await visit(page, "Activity");
  await selectNewestRefresh(page);
  await expect(page.getByRole("heading", { name: /Canvas refresh ·/ })).toBeVisible();
  await expect(page.getByText("After Canvas deadline", { exact: true })).toBeVisible();
  await visit(page, "More");
  await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Last refresh");
  const commands = await page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.map((call) => call.command));
  expect(commands.filter((command) => command === "read_dashboard_documents")).toHaveLength(3);
  expect(commands.filter((command) => command === "start_canvas_refresh")).toHaveLength(2);
  expect(commands).not.toContain("start_ical_refresh");
});

test("opening refreshes once and reports a Library-only change across pages", async ({ page }) => {
  await openDashboard(page, { mode: "canvas", autoRefreshChanges: "library" });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.filter((call) => call.command === "start_canvas_refresh").length)).toBe(1);
  const alert = page.getByRole("alert").filter({ hasText: "Refresh found changes" });
  await expect(alert).toHaveText("Refresh found changes · 1 added · 0 changed · 0 removed.Dismiss");
  await expect(page.getByRole("heading", { name: "New automatic library file.pdf" })).toHaveCount(0);
  await visit(page, "Library");
  await expect(page.getByRole("heading", { name: "New automatic library file.pdf" })).toBeVisible();
  await expect(alert).toContainText("1 added");
  await alert.getByRole("button", { name: "Dismiss refresh changes alert" }).click();
  await expect(alert).toHaveCount(0);
});

test("startup refresh does not mistake old history for new changes after an initial read failure", async ({ page }) => {
  await openDashboard(page, { mode: "canvas", initialLoadError: true, historicalChanges: true });
  await expect(page.getByRole("heading", { name: "Before Canvas deadline" })).toBeVisible();
  await expect(page.locator(".load-error")).toHaveCount(0);
  await expect(page.locator(".refresh-change-alert")).toHaveCount(0);
});

test("six-hour refresh catches up on wake and stays quiet when no source changed", async ({ page }) => {
  await page.clock.install({ time: new Date(NOW) });
  await openDashboard(page, { mode: "canvas", autoRefreshChanges: "none" });
  const calls = () => page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.filter((call) => call.command === "start_canvas_refresh").length);
  await expect.poll(calls).toBe(1);
  await expect(page.locator(".refresh-change-alert")).toHaveCount(0);

  await page.clock.fastForward(6 * 60 * 60 * 1_000 + 1);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(calls).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(calls).toBe(2);

  await page.clock.fastForward(6 * 60 * 60 * 1_000 + 1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(calls).toBe(3);
  await expect(page.locator(".refresh-change-alert")).toHaveCount(0);
});

test("Inbox changes are detected from current conversations without delta records", async ({ page }) => {
  await openDashboard(page, { mode: "canvas", autoRefreshChanges: "inbox" });
  const alert = page.getByRole("alert").filter({ hasText: "Refresh found changes" });
  await expect(alert).toContainText("1 added · 0 changed · 0 removed");
  await visit(page, "Inbox");
  await expect(alert).toBeVisible();
  await expect(page.getByRole("button", { name: /Automatic inbox update/ })).toBeVisible();
});

test("full refresh uses the bundled browser command and updates every page without losing personal completion", async ({ page }) => {
  await openDashboard(page, { mode: "full", holdFullRefresh: true, fullOmissionCount: 2 });
  await expect(page.locator(".top-actions button.refresh-button")).toHaveAccessibleName("Refresh");
  await expect(page.locator(".top-actions button.refresh-button")).toHaveAttribute("title", /calendar deadlines/);
  await visit(page, "More");
  const store = page.locator("[data-desktop-store=authoritative]");
  await expect(store).toContainText("Full refresh is available.");
  await expect(store.getByRole("checkbox", { name: "Enable Canvas refresh" })).toHaveCount(0);

  await visit(page, "Timeline");
  await page.getByRole("button", { name: "SYN102", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Before second course" })).toBeVisible();
  await visit(page, "Inbox");
  await page.getByRole("button", { name: /Selected synthetic thread/ }).click();
  await expect(page.getByText("Selected message before refresh", { exact: true })).toBeVisible();
  await visit(page, "Timeline");

  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  const refresh = page.locator(".top-actions button.refresh-button");
  await expect(page.locator(".sync-note")).toContainText("Canvas and calendar refresh · Reading Canvas and checking files");
  await expect(refresh).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.filter((call) => call.command === "start_full_refresh").length)).toBe(2);
  await page.evaluate(() => (window as unknown as { __releaseFullRefresh?: () => void }).__releaseFullRefresh?.());
  await expect(page.locator(".sync-note")).toContainText("Canvas and calendar updated.");
  await expect(page.locator(".refresh-details p")).toContainText("2 omissions recorded.");
  await expect(page.locator(".topbar .term-label")).toContainText("2 courses");

  await expect(page.getByRole("button", { name: "All courses", exact: true })).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "After full refresh deadline" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Before second course" })).toHaveCount(0);
  await visit(page, "Grades");
  await expect(page.locator(".grade-summary-card")).toHaveCount(2);
  await expect(page.locator(".grade-summary-card__grade").filter({ hasText: "90%" })).toBeVisible();
  await visit(page, "Inbox");
  await expect(page.getByText("Full refresh Inbox preview", { exact: true })).toBeVisible();
  await expect(page.getByText("First synthetic message", { exact: true })).toBeVisible();
  await visit(page, "Done");
  await expect(page.getByRole("heading", { name: "After full refresh done item" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark not done", exact: true })).toBeVisible();
  await visit(page, "Courses");
  await expect(page.locator(".course-card")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Synthetic empty course" })).toBeVisible();
  await visit(page, "Library");
  await expect(page.getByRole("heading", { name: "Full refresh Canvas file.pdf" })).toBeVisible();
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Full refresh Canvas page" })).toBeVisible();
  await visit(page, "Activity");
  await selectNewestRefresh(page);
  await expect(page.locator("#main").getByText(/Canvas refresh completed; 2 optional capture omissions recorded\. Existing data was preserved\./)).toBeVisible();
  await expect(page.locator("#main").getByText("Canvas refresh completed", { exact: true })).toBeVisible();
  await visit(page, "More");
  await expect(store).toContainText("Full refresh is available.");
  await expect(store.getByRole("checkbox", { name: "Enable Canvas refresh" })).toHaveCount(0);

  const commands = await page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.map((call) => call.command));
  expect(commands.filter((command) => command === "read_dashboard_documents")).toHaveLength(3);
  expect(commands.filter((command) => command === "start_full_refresh")).toHaveLength(2);
  expect(commands).not.toContain("start_canvas_refresh");
  expect(commands).not.toContain("start_ical_refresh");
});

test("full refresh reports sign-in verification as a terminal headless failure", async ({ page }) => {
  await openDashboard(page, { mode: "full", fullErrorCode: "canvas-verification-required" });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".refresh-details p")).toContainText(
    "Canvas requires an extra verification step. Complete it in the visible Canvas setup session, then retry refresh.",
  );
  await expect(page.locator(".sync-note")).not.toContainText("Chrome window is opening");
});

test("full refresh reports a blocking survey without opening Chrome", async ({ page }) => {
  await openDashboard(page, { mode: "full", fullErrorCode: "canvas-survey-blocking" });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".refresh-details p")).toContainText(
    "A Canvas survey is blocking refresh. Dismiss it in the visible Canvas session, then retry refresh.",
  );
});

test("full refresh reports coverage gaps, reloads freshness, and rereads after command failure", async ({ page, context }, testInfo) => {
  await openDashboard(page, { mode: "full", fullGap: true });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".refresh-details p")).toContainText("Refresh finished with items needing attention. 2 Canvas sections or files could not refresh.");
  await expect(page.locator(".refresh-details p")).toContainText("0 omissions recorded.");
  await expect(page.locator(".refresh-details p")).toContainText("1 calendar item was left unchanged");
  await expect(page.locator(".refresh-details p")).toContainText("contents did not match a supported file type");
  await expect(page.locator(".refresh-details p")).toContainText("1 personal file could not be verified.");
  await expect(page.locator(".refresh-details p")).toContainText("See Activity for details.");
  await page.screenshot({ path: testInfo.outputPath("refresh-attention.png") });
  await expect(page.locator("[data-source-freshness=stale]")).toContainText("could not be verified from the latest refresh.");
  await expect(page.getByRole("heading", { name: "Before Canvas deadline" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Synthetic calendar deadline" })).toBeVisible();
  await visit(page, "Activity");
  await selectNewestRefresh(page);
  await expect(page.locator("#main").getByText("partial", { exact: true }).first()).toBeVisible();
  await expect(page.locator("#main").getByText("Canvas refresh was incomplete", { exact: true })).toBeVisible();
  let commands = await page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.map((call) => call.command));
  expect(commands.filter((command) => command === "read_dashboard_documents")).toHaveLength(3);
  expect(commands.filter((command) => command === "start_full_refresh")).toHaveLength(2);
  expect(commands).not.toContain("start_canvas_refresh");
  expect(commands).not.toContain("start_ical_refresh");

  const failed = await context.newPage();
  await openDashboard(failed, { mode: "full", fullRefreshError: true });
  await failed.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(failed.locator(".refresh-details p")).toHaveText("Full refresh failed. Latest saved data was reloaded.");
  await expect(failed.getByRole("heading", { name: "After full refresh deadline" })).toBeVisible();
  commands = await failed.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.map((call) => call.command));
  expect(commands.filter((command) => command === "read_dashboard_documents")).toHaveLength(3);
  expect(commands.filter((command) => command === "start_full_refresh")).toHaveLength(2);
});

test("a running refresh explains temporary hiding without an error warning", async ({ page }, testInfo) => {
  await openDashboard(page, { mode: "full", staleCapture: true, holdFullRefresh: true });
  await expect(page.locator("[data-source-freshness=stale]")).toBeVisible();
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  const notice = page.locator("[data-source-freshness=refreshing]");
  await expect(notice).toContainText("Updating Canvas.");
  await expect(notice).toContainText("temporarily hidden");
  await expect(notice).not.toHaveClass(/inline-error/);
  await expect(page.locator("[data-source-freshness=stale]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Synthetic calendar deadline" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("refresh-progress.png") });
  await page.evaluate(() => (window as unknown as { __releaseFullRefresh?: () => void }).__releaseFullRefresh?.());
  await expect(page.locator(".sync-note")).toContainText("Canvas and calendar updated.");
});

test("full refresh banner keeps 125 Canvas gaps separate from a held calendar item", async ({ page }) => {
  await openDashboard(page, { mode: "full", fullGap: true, fullGapCount: 125, fullCalendarHeld: 1, fullOmissionCount: 9 });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();

  const note = page.locator(".refresh-details p");
  await expect(note).toContainText("125 Canvas sections or files could not refresh");
  await expect(note).toContainText("9 omissions recorded.");
  await expect(note).toContainText("calendar item was left unchanged");
  await expect(note).toContainText("1 calendar item was left unchanged");
  await expect(note).not.toContainText("126");
});

test("full refresh banner stays partial when Canvas completes but calendar holds an item", async ({ page }) => {
  await openDashboard(page, { mode: "full", fullCalendarHeld: 1 });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();

  const note = page.locator(".refresh-details p");
  await expect(note).toContainText("Refresh finished with items needing attention.");
  await expect(note).toContainText("Canvas updated.");
  await expect(note).toContainText("calendar item was left unchanged");
  await expect(note).toContainText("1 calendar item was left unchanged");
});

test("full refresh gives an actionable stale-helper message", async ({ page }) => {
  await openDashboard(page, { mode: "full", fullErrorCode: "helper-stale" });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();

  const note = page.locator(".refresh-details p");
  await expect(note).toContainText("Canvas capture helpers are out of date.");
  await expect(note).toContainText("npm run canvas:prepare-helper");
});

test("calendar refresh changes only deadlines and labels its scope in Activity and after reload", async ({ page }) => {
  await openDashboard(page, { mode: "calendar" });
  await expect(page.locator(".top-actions button.refresh-button")).toHaveAttribute("title", /Calendar deadlines only/);
  await expect(page.locator(".top-actions button.refresh-button")).toHaveAccessibleName("Refresh calendar");
  await expect(page.getByRole("heading", { name: "Synthetic calendar deadline" })).toBeVisible();
  await visit(page, "Grades");
  await expect(page.getByText("80%", { exact: true }).first()).toBeVisible();
  await visit(page, "Inbox");
  await expect(page.getByText("Selected message before refresh", { exact: true })).toBeVisible();
  await visit(page, "Library");
  await expect(page.getByRole("heading", { name: "Old Canvas file.pdf" })).toBeVisible();
  await visit(page, "Activity");
  await expect(page.locator("button.refresh-button")).toHaveCount(1);
  await expect(page.locator(".sync-note")).toHaveCount(1);

  await page.locator(".top-actions").getByRole("button", { name: "Refresh calendar", exact: true }).click();
  await expect(page.locator(".refresh-details p")).toContainText("Calendar refresh complete · 0 added · 1 updated · 0 held");
  await visit(page, "Timeline");
  await expect(page.getByRole("heading", { name: "Synthetic calendar deadline" })).toBeVisible();
  await visit(page, "Grades");
  await expect(page.getByText("80%", { exact: true }).first()).toBeVisible();
  await visit(page, "Inbox");
  await expect(page.getByText("Selected message before refresh", { exact: true })).toBeVisible();
  await visit(page, "Library");
  await expect(page.getByRole("heading", { name: "Old Canvas file.pdf" })).toBeVisible();
  await visit(page, "Activity");
  await selectNewestRefresh(page);
  await expect(page.getByRole("heading", { name: /Calendar refresh ·/ })).toBeVisible();
  await expect(page.getByText("Calendar refresh updates deadlines only. Grades, Inbox, and library items keep the prior Canvas capture.")).toBeVisible();
  await expect(page.locator(".change-count").filter({ hasText: "Changed" })).toContainText("1");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.locator(".refresh-details p")).toHaveText("Calendar refresh complete · 0 added · 0 updated · 0 held");
  await visit(page, "Activity");
  await expect(page.getByText("Calendar refresh updates deadlines only.", { exact: false })).toBeVisible();
});

test("keeps the course count global and course colors closed in More", async ({ page }) => {
  await openDashboard(page, { mode: "canvas" });
  await visit(page, "Courses");
  await expect(page.locator(".topbar")).toContainText("3 courses");
  await expect(page.getByText("Course overview", { exact: true })).toBeVisible();
  await expect(page.locator("[data-page-panel=courses]").getByText("3 active", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-course-colors]")).toHaveCount(0);

  await visit(page, "More");
  const colors = page.locator("[data-course-colors]");
  await expect(colors).toHaveCount(1);
  await expect(colors).not.toHaveAttribute("open", "");
  await expect(colors.getByText("SYN101 · Synthetic One", { exact: true })).not.toBeVisible();
  await colors.locator("summary").click();
  await expect(colors).toHaveAttribute("open", "");
  await expect(colors.getByText("SYN101 · Synthetic One", { exact: true })).toBeVisible();
});

test("Timeline explains retained calendar items and hides the label for Canvas-backed facts", async ({ page }) => {
  await openDashboard(page, { mode: "calendar" });
  const calendarCard = page.locator(".event-card").filter({ hasText: "Synthetic calendar deadline" });
  await expect(calendarCard.getByText("Previously imported, not in the latest verified feed. The rolling calendar window may omit older items.")).toBeVisible();
  const canvasCard = page.locator(".event-card").filter({ hasText: "Before Canvas deadline" });
  await expect(canvasCard.locator(".calendar-retained-note")).toHaveCount(0);
});

test("malformed calendar confirmation metadata does not claim a retained item", async ({ page }) => {
  await openDashboard(page, { mode: "calendar", malformedCalendarConfirmation: true });
  await expect(page.locator(".calendar-retained-note")).toHaveCount(0);
});

test("a no-change calendar run stays complete and identifies deadline-only scope", async ({ page }) => {
  await openDashboard(page, { mode: "calendar", noCalendarChange: true });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh calendar", exact: true }).click();
  await expect(page.locator(".refresh-details p")).toContainText("Calendar refresh complete · 0 added · 0 updated · 0 held");
  await visit(page, "Activity");
  await selectNewestRefresh(page);
  await expect(page.getByText("Calendar refresh updates deadlines only. Grades, Inbox, and library items keep the prior Canvas capture.")).toBeVisible();
  await expect(page.getByText("This refresh recorded no item-level changes.", { exact: true })).toBeVisible();
});

test("failed refreshes and failed reloads retain the prior view and warn", async ({ page, context }) => {
  await openDashboard(page, { mode: "canvas", refreshError: true });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".refresh-details p")).toHaveText("Refresh failed. Existing data was kept.");
  await expect(page.getByRole("heading", { name: "Before Canvas deadline" })).toBeVisible();

  const second = await context.newPage();
  await openDashboard(second, { mode: "canvas", failReload: true });
  await second.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(second.locator(".sync-note")).toContainText("Showing previously saved data.");
  await expect(second.locator(".refresh-details p")).toHaveText("Refresh finished, but updated data could not be reloaded. The prior view is still shown.");
  await expect(second.getByRole("heading", { name: "Before Canvas deadline" })).toBeVisible();
});

test("Activity gives complete, partial, and failed refreshes their accepted status colors", async ({ page }) => {
  await openDashboard(page, { initialHistoryStatuses: [
    { status: "succeeded", sourceComplete: true },
    { status: "incomplete", sourceComplete: false },
    { status: "failed", sourceComplete: false },
  ] });
  await visit(page, "Activity");
  const statusStyles = await page.locator(".refresh-status").evaluateAll((statuses) => {
    const resolve = (variable: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${variable})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      sage: resolve("--sage"), clay: resolve("--clay"),
      statuses: statuses.map((status) => ({ text: status.textContent, className: status.className, color: getComputedStyle(status).color })),
    };
  });
  const status = (text: string) => statusStyles.statuses.find((item) => item.text === text);
  expect(status("complete")).toMatchObject({ className: "refresh-status", color: statusStyles.sage });
  expect(status("partial")).toMatchObject({ className: "refresh-status partial", color: statusStyles.clay });
  expect(status("failed")).toMatchObject({ className: "refresh-status failed", color: statusStyles.clay });
});

test("unverified empty coursework never claims nothing is due", async ({ page }, testInfo) => {
  await openDashboard(page, { mode: "canvas", staleCapture: true, noDeadlines: true });
  const rail = page.locator(".timeline-rail");
  await expect(rail).toContainText("Due soon · Unverified");
  await expect(rail).toContainText("Coursework could not be verified. Refresh to check what is due.");
  await expect(rail).toContainText("Inbox could not be verified.");
  await expect(rail).not.toContainText("No unfinished assignments are due.");
  await expect(rail).not.toContainText("No unread Canvas messages.");
  await expect(page.locator(".hero-copy")).toContainText("Empty rows may have unverified coursework.");
  await expect(page.locator(".open-day").first()).toHaveText("Coursework unverified");
  await page.screenshot({ path: testInfo.outputPath("unverified-empty.png") });
});

test("stale browser freshness masks Canvas facts and explains the gap on each page", async ({ page }) => {
  await openDashboard(page, { mode: "canvas", staleCapture: true });
  await expect(page.getByRole("heading", { name: "Before Canvas deadline" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Synthetic calendar deadline" })).toBeVisible();
  await expect(page.locator(".timeline-rail")).toContainText("Canvas coursework is unverified. These are retained calendar deadlines.");
  await expect(page.locator(".timeline-rail .rail-due-list")).toContainText("Synthetic calendar deadline");
  for (const label of ["Timeline", "Grades", "Inbox", "Done", "Courses", "Library", "Activity", "More"]) {
    if (label !== "Timeline") await visit(page, label);
    await expect(page.locator("[data-source-freshness=stale]")).toContainText("could not be verified from the latest refresh.");
    await expect(page.locator("[data-source-freshness=stale]")).toContainText("retained calendar deadlines and personal records remain available");
  }
});

test.describe("Activity date-only timezone regression", () => {
  test.use({ timezoneId: "America/New_York" });

  test("Activity displays date-only deadline at 11:59 PM on stated Sunday and not Saturday 8:00 PM after refresh", async ({ page }) => {
    await openDashboard(page, { mode: "canvas", dateOnlyActivity: true });
    await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".sync-note")).toContainText("Refresh complete");

    await visit(page, "Activity");
    await selectNewestRefresh(page);
    await expect(page.getByRole("heading", { name: /Canvas refresh ·/ })).toBeVisible();
    await expect(page.getByText("Synthetic Sunday assignment", { exact: true })).toBeVisible();

    const changeItem = page.locator(".change-item").filter({ hasText: "Synthetic Sunday assignment" });
    await expect(changeItem).toContainText("Due date: Sep 20, 2026, 11:59 PM → Sep 27, 2026, 11:59 PM");
    await expect(changeItem).toContainText("Graded at: Unavailable → Sep 27, 2026");
    await expect(changeItem).not.toContainText("8:00 PM");
    await expect(changeItem).not.toContainText("Sep 26, 2026");

    await expect(page.locator(".change-list")).not.toContainText("8:00 PM");
    await expect(page.locator(".change-list")).not.toContainText("Sep 26, 2026");
    await expect(page.getByText(/8:00\s*PM/)).toHaveCount(0);
  });
});
