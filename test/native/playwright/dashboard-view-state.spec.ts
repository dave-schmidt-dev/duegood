import { expect, test, type Page } from "@playwright/test";

function installDashboardMock(): void {
  type Callback = (message: unknown) => void;
  const callbacks = new Map<number, Callback>();
  let nextId = 1;
  let completeRefresh: (() => void) | undefined;
  const scope = window as unknown as Record<string, unknown>;
  const now = Date.now();
  const coursework = JSON.stringify({
    generated: new Date(now).toISOString(),
    courses: [
      { key: "101", code: "SYN101", title: "Synthetic One", folder: "course-101" },
      { key: "102", code: "SYN102", title: "Synthetic Two", folder: "course-102" },
    ],
    items: Array.from({ length: 120 }, (_, index) => ({
      id: `assignment-${String(index)}`, course: index % 2 === 0 ? "101" : "102", kind: "assignment",
      title: `Synthetic assignment ${String(index)}`, at: new Date(now + (index + 1) * 86_400_000).toISOString(),
      submissionStatus: "unsubmitted", points: 10, score: 8, grade: "80%", done: false,
    })),
  });
  const conversations = JSON.stringify({ complete: true, conversations: [
    { canvasConversationId: "thread-default", subject: "Default synthetic thread", unread: true, starred: false, messageCount: 1, participants: [{ canvasUserId: "instructor-1", name: "First instructor" }], messages: [{ canvasMessageId: "message-default", author: "First instructor", body: "First message" }] },
    { canvasConversationId: "thread-selected", subject: "Selected synthetic thread", unread: true, starred: false, messageCount: 1, participants: [{ canvasUserId: "instructor-2", name: "Second instructor" }], messages: [{ canvasMessageId: "message-selected", author: "Second instructor", body: "Selected message" }] },
  ] });
  const refreshHistory = JSON.stringify({ events: [
    { id: "refresh-default", source: "canvas", status: "complete", startedAt: "2026-10-02T10:00:00Z", summary: { added: 0, updated: 0, removed: 0 }, changes: [] },
    { id: "refresh-selected", source: "canvas", status: "complete", startedAt: "2026-10-03T10:00:00Z", summary: { added: 1, updated: 0, removed: 0 }, changes: [] },
  ] });
  scope.isTauri = true;
  scope.__TAURI_INTERNALS__ = {
    transformCallback(callback: Callback): number { const id = nextId; nextId += 1; callbacks.set(id, callback); return id; },
    unregisterCallback(id: number): void { callbacks.delete(id); },
    async invoke(command: string): Promise<unknown> {
      if (command === "store_status") return {
        availability: "ready", state: "authoritative", dataFolder: "~/Library/Application Support/com.zerodelta.duegood",
        legacyRootSelected: true, importedAt: "2026-10-03T10:00:00Z", files: 5, bytes: 20_480,
        canvasRefreshEnabled: true, refreshAvailable: true, icalRefreshAvailable: false, browserRefreshAvailable: false,
        snapshotInProgress: false, snapshotProgress: null, problem: null,
      };
      if (command === "read_avatar_bytes") return null;
      if (command === "read_dashboard_documents") return {
        storeState: "authoritative", coursework: { text: coursework, version: "a".repeat(64) }, refreshHistory, conversations,
        profile: null, avatar: null, courseExports: { "course-101": { files: "[]", pages: "[]", modules: "[]", announcements: "[]", downloadManifest: "[]" }, "course-102": { files: "[]", pages: "[]", modules: "[]", announcements: "[]", downloadManifest: "[]" } },
      };
      if (command === "start_canvas_refresh") return new Promise((resolve) => {
        completeRefresh = () => resolve({ status: "complete", updatedAt: "2026-10-03T12:00:00Z" });
      });
      throw { code: "unexpected-command", message: `Unexpected synthetic IPC command: ${command}` };
    },
  };
  scope.completeSyntheticRefresh = () => completeRefresh?.();
}

async function openDashboard(page: Page): Promise<void> {
  await page.addInitScript(installDashboardMock);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
}

test("retains per-page scroll, filters, draft, and non-default selections across navigation, refresh, and reload", async ({ page }) => {
  await openDashboard(page);
  await page.getByRole("button", { name: "SYN102", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 3903));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Grades", exact: true }).click();
  const gradeObservations = page.locator("details.grade-honesty__details");
  await expect(gradeObservations).not.toHaveAttribute("open", "");
  await gradeObservations.locator("summary").click();
  await expect(gradeObservations).toHaveAttribute("open", "");
  await expect(gradeObservations).toContainText("A local observation is the selected value until you change or remove it; Canvas score and grade remain visible alongside it. Progress indicators use Canvas points only, and coverage and unknown group data stay visible.");
  await page.getByRole("button", { name: "Filter grades to SYN102" }).click();
  await page.getByRole("button", { name: "Edit local grade for Synthetic assignment 1", exact: true }).click();
  await page.getByRole("textbox", { name: "Local grade for Synthetic assignment 1", exact: true }).fill("92%");
  await page.waitForTimeout(200);

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Inbox", exact: true }).click();
  await page.getByRole("button", { name: /Selected synthetic thread/ }).click();
  await expect(page.locator(".message-row.active")).toContainText("Selected synthetic thread");

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Activity", exact: true }).click();
  const historyRows = page.locator(".history-row");
  await historyRows.nth(1).click();
  await expect(page.locator(".history-row.active")).toHaveCount(1);
  const selectedRefreshId = "refresh-default";
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("com.zerodelta.duegood.dashboard-view-state.v1:~%2FLibrary%2FApplication%20Support%2Fcom.zerodelta.duegood") ?? "{}").selectedRefreshId)).toBe(selectedRefreshId);

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Timeline", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
  await expect(page.locator(".topbar")).toHaveCSS("position", "sticky");
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Refreshing/ })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Canvas refresh is in progress");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Grades", exact: true }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Timeline", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
  await page.evaluate(() => {
    const complete = (window as unknown as Record<string, (() => void) | undefined>).completeSyntheticRefresh;
    if (complete === undefined) throw new Error("Synthetic refresh completion was not installed");
    complete();
  });
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);

  await page.reload();
  await expect(page.getByRole("button", { name: "SYN102", exact: true })).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Grades", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Local grade for Synthetic assignment 1", exact: true })).toHaveValue("92%");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page.locator(".message-row.active")).toContainText("Selected synthetic thread");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Activity", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("com.zerodelta.duegood.dashboard-view-state.v1:~%2FLibrary%2FApplication%20Support%2Fcom.zerodelta.duegood") ?? "{}").selectedRefreshId)).toBe(selectedRefreshId);
  await page.goBack();
  await expect(page.locator(".message-row.active")).toContainText("Selected synthetic thread");
  await page.goForward();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("com.zerodelta.duegood.dashboard-view-state.v1:~%2FLibrary%2FApplication%20Support%2Fcom.zerodelta.duegood") ?? "{}").selectedRefreshId)).toBe(selectedRefreshId);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Timeline", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.waitForTimeout(200);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Grades", exact: true }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Timeline", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("restores deep Timeline scroll in the first normal-motion frame after refresh redraw and navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openDashboard(page);
  await page.getByRole("button", { name: "SYN102", exact: true }).click();
  await page.evaluate(() => window.scrollTo({ top: 3903, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
  const refreshTarget = await page.evaluate(() => window.scrollY);

  const refreshFrame = await page.evaluate(async () => {
    const refresh = document.querySelector<HTMLButtonElement>(".refresh-button");
    if (refresh === null) throw new Error("Refresh control was not rendered");
    refresh.click();
    return await new Promise<number>((resolve) => requestAnimationFrame(() => resolve(window.scrollY)));
  });
  expect(refreshFrame).toBeGreaterThan(2000);
  expect(Math.abs(refreshFrame - refreshTarget)).toBeLessThanOrEqual(0.5);
  await expect(page.getByRole("button", { name: /^Refreshing/ })).toBeDisabled();
  await page.evaluate(() => {
    const complete = (window as unknown as Record<string, (() => void) | undefined>).completeSyntheticRefresh;
    if (complete === undefined) throw new Error("Synthetic refresh completion was not installed");
    complete();
  });
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Grades", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const savedTimelinePosition = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("com.zerodelta.duegood.dashboard-view-state.v1:~%2FLibrary%2FApplication%20Support%2Fcom.zerodelta.duegood") ?? "{}");
    return stored.scrollPositions?.timeline;
  });
  expect(savedTimelinePosition).toBeCloseTo(refreshTarget, 1);
  const navigationFrame = await page.evaluate(async () => {
    const timeline = document.querySelector<HTMLAnchorElement>("nav a[href='#timeline']");
    if (timeline === null) throw new Error("Timeline navigation was not rendered");
    timeline.click();
    return await new Promise<number>((resolve) => requestAnimationFrame(() => resolve(window.scrollY)));
  });
  expect(navigationFrame).toBeGreaterThan(2000);
  expect(Math.abs(navigationFrame - savedTimelinePosition)).toBeLessThanOrEqual(0.5);
});
