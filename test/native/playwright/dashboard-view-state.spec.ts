import { expect, test, type Page } from "@playwright/test";

test.use({ timezoneId: "America/New_York" });

function installDashboardMock(): void {
  type Callback = (message: unknown) => void;
  const callbacks = new Map<number, Callback>();
  let nextId = 1;
  let refreshCalls = 0;
  let completeRefresh: (() => void) | undefined;
  const scope = window as unknown as Record<string, unknown>;
  const now = Date.now();
  let coursework = JSON.stringify({
    generated: new Date(now).toISOString(),
    courses: [
      { key: "101", code: "SYN101", title: "Synthetic One", folder: "course-101", gradeGroups: [{ id: "projects", name: "Projects", weight: 100 }] },
      { key: "102", code: "SYN102", title: "Synthetic Two", folder: "course-102" },
    ],
    items: [
      ...Array.from({ length: 120 }, (_, index) => ({
        id: `assignment-${String(index)}`, course: index % 2 === 0 ? "101" : "102", kind: "assignment",
        title: `Synthetic assignment ${String(index)}`, at: new Date(now + (index + 1) * 86_400_000).toISOString(),
        submissionStatus: "unsubmitted", points: 10, score: 8, grade: "80%", done: false,
        ...(index === 0 ? { detail: "# Main idea\n\nA paragraph with preserved spacing.\n\n1. First step\n2. Second step\n\n- Evidence\n- Reflection\n\n<img src=x onerror=alert(1)>" } : {}),
        ...(index === 0 ? { rubric: {
          criteria: [{
            id: "criterion-1", description: "Evidence", long_description: "Use two sources.", points: 5,
            ratings: [{ description: "Strong", long_description: "Clear and relevant", points: 5 }],
          }],
          settings: { title: "Synthetic rubric", pointsPossible: 5, freeFormCriterionComments: true },
          useForGrading: true,
        } } : {}),
      })),
      { id: "undated-assignment", course: "101", kind: "assignment", title: "Undated synthetic assignment", at: null, detail: "# Assignment prompt\n\nReview the rubric." },
      { id: "standalone-discussion", course: "101", kind: "discussion", title: "Standalone synthetic discussion", detail: "# Discussion prompt\n\nPost your response." },
      { id: "completed-undated", course: "101", kind: "assignment", title: "Completed synthetic assignment", at: null, detail: "# Completed prompt\n\nKeep this body available.", done: true, doneAt: new Date(now).toISOString() },
      { id: "completed-dated", course: "101", kind: "assignment", title: "Completed dated synthetic assignment", at: new Date(now + 86_400_000).toISOString(), detail: "# Dated completed prompt\n\nKeep the dated body available.", done: true, doneAt: new Date(now).toISOString() },
    ],
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
    async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
      if (command === "store_status") return {
        availability: "ready", state: "authoritative", dataFolder: "~/Library/Application Support/com.zerodelta.duegood",
        legacyRootSelected: true, importedAt: "2026-10-03T10:00:00Z", files: 5, bytes: 20_480,
        canvasRefreshEnabled: true, refreshAvailable: true, icalRefreshAvailable: false, browserRefreshAvailable: false,
        snapshotInProgress: false, snapshotProgress: null, problem: null,
      };
      if (command === "read_avatar_bytes") return null;
      if (command === "read_dashboard_documents") return {
        storeState: "authoritative", coursework: { text: coursework, version: "a".repeat(64) }, refreshHistory, conversations,
        profile: null, avatar: null, courseExports: { "course-101": { files: JSON.stringify([{ id: 101, display_name: "Resource 101.pdf" }]), pages: JSON.stringify([{ page_id: 101, title: "Resource 101 page", detail: "Detailed library resource body text", bodyHtml: "<p>Detailed library resource body text</p>", bodyEmpty: false }]), modules: "[]", announcements: "[]", quizzes: "[]", downloadManifest: "[]" }, "course-102": { files: "[]", pages: "[]", modules: "[]", announcements: "[]", quizzes: "[]", downloadManifest: "[]" } },
      };
      if (command === "open_library_resource") return null;
      if (command === "set_manual_grade") {
        const { itemId, value } = args as { itemId: string; value: string | null };
        const execute = () => {
          const doc = JSON.parse(coursework) as { items: Record<string, unknown>[] };
          const item = doc.items.find((candidate) => candidate.id === itemId);
          if (item !== undefined) {
            item.manualGrade = value;
            item.manualGradeVersion = value === null ? null : 1;
            item.manualGradeSource = value === null ? null : "manual";
          }
          coursework = JSON.stringify(doc);
          return { manualGrade: value, manualGradeVersion: value === null ? null : 1, manualGradeSource: value === null ? null : "manual", version: "b".repeat(64) };
        };
        if (scope.__holdGradeSave !== undefined) {
          return new Promise((resolve) => {
            scope.__releaseGradeSave = () => resolve(execute());
          });
        }
        return execute();
      }
      if (command === "start_canvas_refresh") {
        refreshCalls += 1;
        if (refreshCalls === 1) return { status: "complete", updatedAt: "2026-10-03T11:00:00Z" };
        return new Promise((resolve) => {
          completeRefresh = () => resolve({ status: "complete", updatedAt: "2026-10-03T12:00:00Z" });
        });
      }
      throw { code: "unexpected-command", message: `Unexpected synthetic IPC command: ${command}` };
    },
  };
  scope.completeSyntheticRefresh = () => completeRefresh?.();
}

async function openDashboard(page: Page): Promise<void> {
  await page.addInitScript(installDashboardMock);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
  await expect(page.locator(".refresh-button")).toBeEnabled();
}

test("shows captured rubric details for an assignment", async ({ page }) => {
  await openDashboard(page);
  const firstCard = page.locator(".timeline .event-card").first();
  await firstCard.getByRole("button", { name: "Details", exact: true }).click();
  const rubric = firstCard.locator(".event-rubric");
  await expect(rubric.getByRole("heading", { name: "Rubric", exact: true })).toBeVisible();
  await expect(rubric).toContainText("Synthetic rubric");
  await expect(rubric).toContainText("Evidence");
  await expect(rubric).toContainText("Strong");
  await expect(rubric).toContainText("Clear and relevant");
});

test("shows formatted Canvas body text without interpreting markup", async ({ page }) => {
  await openDashboard(page);
  const firstCard = page.locator(".timeline .event-card").first();
  await firstCard.getByRole("button", { name: "Details", exact: true }).click();
  const body = firstCard.locator(".event-body");
  await expect(body.locator("h3")).toHaveText("Main idea");
  await expect(body.locator("p")).toHaveText(["A paragraph with preserved spacing.", "<img src=x onerror=alert(1)>"]);
  await expect(body.locator("ol li")).toHaveText(["First step", "Second step"]);
  await expect(body.locator("ul li")).toHaveText(["Evidence", "Reflection"]);
  await expect(body).toContainText("<img src=x onerror=alert(1)>");
  await expect(body.locator("img, script, iframe")).toHaveCount(0);
});

test("keeps undated Canvas assignments and standalone discussions reachable", async ({ page }) => {
  await openDashboard(page);
  const undated = page.locator(".undated-events");
  await expect(undated.getByRole("heading", { name: "No due date", exact: true })).toBeVisible();
  const assignment = undated.locator(".event-card").filter({ hasText: "Undated synthetic assignment" });
  await expect(assignment.locator(".event-time--undated")).toHaveText("No due date");
  await expect(assignment.locator("time")).toHaveCount(0);
  await assignment.getByRole("button", { name: "Details", exact: true }).click();
  await expect(assignment.locator(".event-body h3")).toHaveText("Assignment prompt");

  const discussion = undated.locator(".event-card").filter({ hasText: "Standalone synthetic discussion" });
  await expect(discussion.locator(".event-time--undated")).toHaveText("No due date");
  await discussion.getByRole("button", { name: "Details", exact: true }).click();
  await expect(discussion.locator(".event-body h3")).toHaveText("Discussion prompt");

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Done", exact: true }).click();
  const completed = page.locator(".completed-row").filter({ hasText: "Completed synthetic assignment" });
  await completed.locator(".completed-body-details summary").click();
  await expect(completed.locator(".event-body h3")).toHaveText("Completed prompt");
  const completedDated = page.locator(".completed-row").filter({ hasText: "Completed dated synthetic assignment" });
  await completedDated.locator(".completed-body-details summary").click();
  await expect(completedDated.locator(".event-body h3")).toHaveText("Dated completed prompt");
});

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
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("com.zerodelta.duegood.dashboard-view-state.v1:~%2FLibrary%2FApplication%20Support%2Fcom.zerodelta.duegood") ?? "{}");
    return stored.scrollPositions?.timeline;
  })).toBeCloseTo(refreshTarget, 1);
  const navigationFrame = await page.evaluate(async () => {
    const timeline = document.querySelector<HTMLAnchorElement>("nav a[href='#timeline']");
    if (timeline === null) throw new Error("Timeline navigation was not rendered");
    timeline.click();
    return await new Promise<number>((resolve) => requestAnimationFrame(() => resolve(window.scrollY)));
  });
  expect(navigationFrame).toBeGreaterThan(2000);
  expect(Math.abs(navigationFrame - refreshTarget)).toBeLessThanOrEqual(0.5);
});


test("idle Timeline advances at local midnight and preserves filters and scroll", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-02T23:59:50-05:00") });
  await openDashboard(page);
  await expect(page.locator(".day-slot.today")).toHaveAttribute("data-day", "2026-11-02");
  await page.getByRole("button", { name: "SYN102", exact: true }).click();
  await page.evaluate(() => window.scrollTo({ top: 1500, behavior: "instant" }));
  const position = await page.evaluate(() => window.scrollY);
  await page.clock.runFor(30_000);
  await expect(page.locator(".day-slot.today")).toHaveAttribute("data-day", "2026-11-03");
  await expect(page.getByRole("button", { name: "SYN102", exact: true })).toHaveClass(/active/);
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(position, 0);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: ".logs/date-rollover/timeline.png" });
});

for (const event of ["focus", "pageshow", "visibilitychange"]) {
  test(`Timeline catches up after multi-day suspension on ${event}`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-11-02T12:00:00-05:00") });
    await openDashboard(page);
    await expect(page.locator(".day-slot.today")).toHaveAttribute("data-day", "2026-11-02");
    await page.clock.setSystemTime(new Date("2026-11-05T09:00:00-05:00"));
    await page.evaluate((name) => (name === "visibilitychange" ? document : window).dispatchEvent(new Event(name)), event);
    await expect(page.locator(".day-slot.today")).toHaveAttribute("data-day", "2026-11-05");
  });
}

test("same-day clock checks leave the current DOM untouched", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-02T12:00:00-05:00") });
  await openDashboard(page);
  await expect(page.locator(".day-slot.today")).toHaveAttribute("data-day", "2026-11-02");
  await page.locator(".day-slot.today").evaluate((node) => node.setAttribute("data-retained", "yes"));
  await page.clock.runFor(60_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".day-slot.today")).toHaveAttribute("data-retained", "yes");
});

test("CR2: protects a grade draft when editing another row and completing delayed save", async ({ page }) => {
  await openDashboard(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Grades", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Grades" })).toBeVisible();

  // Find edit buttons for first and second graded assignment
  const rowA = page.locator(".grade-table tbody tr").nth(0);
  const rowB = page.locator(".grade-table tbody tr").nth(1);
  await rowA.getByRole("button", { name: /Edit local grade|Add local grade/ }).click();
  const inputA = rowA.locator("input[type='text']");
  await inputA.fill("95");

  // Open second row while row A has unsaved draft "95"
  await rowB.getByRole("button", { name: /Edit local grade|Add local grade/ }).click();
  const inputB = rowB.locator("input[type='text']");
  await inputB.fill("88");

  // Both open editors retain their separate drafts.
  await expect(inputA).toHaveValue("95");

  // Hold set_manual_grade IPC to simulate delayed network save
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__holdGradeSave = true;
  });

  // Submit row A save
  await rowA.locator("button[type='submit']").click();

  // Row B remains open while row A save is in-flight.
  await expect(inputB).toHaveValue("88");

  // Complete row A save in background
  await page.evaluate(() => {
    const release = (window as unknown as Record<string, (() => void) | undefined>).__releaseGradeSave;
    release?.();
  });

  // Row B editor must remain open and draft "88" preserved
  await expect(inputB).toBeVisible();
  await expect(inputB).toHaveValue("88");
});

test("CR6: keeps opened reading sections open during redraws and navigation", async ({ page }) => {
  await openDashboard(page);

  // 1. Done page completed details
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Completed" })).toBeVisible();
  const completedDetails = page.locator(".completed-body-details").first();
  await completedDetails.locator("summary").click();
  await expect(completedDetails).toHaveAttribute("open", "");

  // 2. Library page resource body
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  const libraryDetails = page.locator(".resource-row").filter({ hasText: "Resource 101 page" }).locator(".resource-body");
  await libraryDetails.locator("summary").click();
  await expect(libraryDetails).toHaveAttribute("open", "");

  // 3. Grades page grade groups
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Grades", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Grades" })).toBeVisible();
  const gradeGroups = page.locator(".grade-summary-groups").first();
  await gradeGroups.locator("summary").click();
  await expect(gradeGroups).toHaveAttribute("open", "");

  // Trigger refresh progress (or complete refresh) to cause a redraw
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await page.evaluate(() => (window as unknown as { completeSyntheticRefresh?: () => void }).completeSyntheticRefresh?.());
  await expect(gradeGroups).toHaveAttribute("open", "");

  // Navigate away to Timeline, then return to each page to verify persisted disclosure state
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Timeline", exact: true }).click();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Done", exact: true }).click();
  await expect(page.locator(".completed-body-details").first()).toHaveAttribute("open", "");

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Library", exact: true }).click();
  await expect(page.locator(".resource-body").first()).toHaveAttribute("open", "");

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Grades", exact: true }).click();
  await expect(page.locator(".grade-summary-groups").first()).toHaveAttribute("open", "");
});
