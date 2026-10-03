import { expect, test, type Page } from "@playwright/test";

const future = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
const NOW = new Date().toISOString();

interface Setup {
  readonly mode?: "canvas" | "calendar" | "full" | "none";
  readonly refreshError?: boolean;
  readonly fullRefreshError?: boolean;
  readonly fullGap?: boolean;
  readonly fullOmissionCount?: number;
  readonly holdFullRefresh?: boolean;
  readonly failReload?: boolean;
  readonly noCalendarChange?: boolean;
  readonly staleCapture?: boolean;
  readonly dateOnlyActivity?: boolean;
  readonly malformedCalendarConfirmation?: boolean;
}

function initialDocuments(): Record<string, unknown> {
  return {
    coursework: {
      generated: NOW,
      _calendarConfirmation: { schema: 1, eligibleGeneration: { digest: "0".repeat(64), members: [] }, retained: ["calendar-deadline", "canvas-deadline"] },
      courses: [
        { key: "101", canvasCourseId: 101, code: "SYN101", title: "Synthetic One", active: true, folder: "course-101", gradeGroups: [{ id: "projects", name: "Projects", weight: 100 }] },
        { key: "102", canvasCourseId: 102, code: "SYN102", title: "Synthetic Two", active: true, folder: "course-102", gradeGroups: [] },
        { key: "103", canvasCourseId: 103, code: "SYN103", title: "Synthetic empty course", active: true, folder: "course-103", gradeGroups: [] },
      ],
      items: [
        { id: "canvas-deadline", course: "101", kind: "assignment", source: "canvas", title: "Before Canvas deadline", at: future(10), submissionStatus: "graded", points: 10, score: 8, grade: "80%", gradedAt: NOW, assignmentGroupId: "projects", assignmentGroupName: "Projects", done: false },
        { id: "canvas-done", course: "101", kind: "assignment", source: "canvas", title: "Before done item", at: future(2), submissionStatus: "unsubmitted", done: true, doneAt: NOW },
        { id: "calendar-deadline", course: "101", kind: "assignment", source: "ical", title: "Synthetic calendar deadline", at: future(12), done: false },
        { id: "second-course-deadline", course: "102", kind: "assignment", source: "canvas", title: "Before second course", at: future(4), submissionStatus: "graded", points: 5, score: 4, grade: "80%", gradedAt: NOW, done: false },
      ],
    },
    history: [{
      id: "canvas-run-before",
      source: "canvas",
      status: "succeeded",
      sourceComplete: true,
      startedAt: "2026-10-01T12:00:00Z",
      finishedAt: "2026-10-01T12:01:00Z",
      summary: { added: 0, updated: 0, removed: 0 },
      changes: [],
    }],
    conversations: [
      { canvasConversationId: "thread-first", subject: "First synthetic thread", unread: true, starred: false, messageCount: 1, latestMessageAt: "2026-10-01T11:00:00Z", latestMessagePreview: "First preview", participants: [{ canvasUserId: "instructor-1", name: "Synthetic Instructor" }], messages: [{ canvasMessageId: "message-first", author: "Synthetic Instructor", createdAt: "2026-10-01T11:00:00Z", body: "First synthetic message" }], attachments: [] },
      { canvasConversationId: "thread-selected", subject: "Selected synthetic thread", unread: true, starred: false, messageCount: 1, latestMessageAt: "2026-10-01T12:00:00Z", latestMessagePreview: "Selected preview before refresh", participants: [{ canvasUserId: "instructor-2", name: "Another Instructor" }], messages: [{ canvasMessageId: "message-selected", author: "Another Instructor", createdAt: "2026-10-01T12:00:00Z", body: "Selected message before refresh" }], attachments: [] },
    ],
    files: [{ id: 501, display_name: "Old Canvas file.pdf" }],
    pages: [{ page_id: "old-page", title: "Old Canvas page" }],
  };
}

function installNativeMock(options: { readonly setup: Setup; readonly now: string; readonly initial: Record<string, unknown> }): void {
  const { setup, now } = options;
  const futureDate = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
  type Callback = (value: unknown) => void;
  const scope = window as unknown as Record<string, unknown>;
  const callbacks = new Map<number, Callback>();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const storageKey = "duegood-refresh-pages-synthetic-documents";
  let nextId = 1;
  let documents = JSON.parse(JSON.stringify(options.initial)) as Record<string, unknown>;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) documents = JSON.parse(stored) as Record<string, unknown>;
  } catch { /* A fresh synthetic context uses its in-memory fixture. */ }
  const persistDocuments = (): void => { localStorage.setItem(storageKey, JSON.stringify(documents)); };
  let failNextRead = false;
  let fullCaptureStale = false;
  scope.__refreshCalls = calls;
  scope.isTauri = true;
  scope.__TAURI_INTERNALS__ = {
    transformCallback(callback: Callback): number { const id = nextId++; callbacks.set(id, callback); return id; },
    unregisterCallback(id: number): void { callbacks.delete(id); },
    async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ command, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
      if (command === "store_status") return {
        availability: "ready", state: "authoritative", dataFolder: "~/Library/Application Support/com.zerodelta.duegood",
        legacyRootSelected: true, importedAt: "2026-10-01T12:00:00Z", files: 5, bytes: 20_480,
        canvasRefreshEnabled: setup.mode === "canvas", refreshAvailable: setup.mode === "canvas" || setup.mode === "full",
        icalRefreshAvailable: setup.mode === "calendar" || setup.mode === "full", browserRefreshAvailable: setup.mode === "full", snapshotInProgress: false, snapshotProgress: null, problem: null,
      };
      if (command === "read_avatar_bytes") return null;
      if (command === "read_dashboard_documents") {
        if (failNextRead) { failNextRead = false; throw { code: "store-unavailable", message: "Synthetic reload failure" }; }
        const freshness = setup.staleCapture === true || fullCaptureStale
          ? { current: false, reason: "capture-unverified", runId: null, observedAt: null, sections: [] }
          : undefined;
        return {
          storeState: "authoritative",
          coursework: { text: JSON.stringify(documents.coursework), version: "b".repeat(64) },
          refreshHistory: JSON.stringify({ events: documents.history }),
          conversations: JSON.stringify({ complete: true, generatedAt: now, conversations: documents.conversations }),
          profile: null,
          avatar: null,
          courseExports: {
            "course-101": { files: JSON.stringify(documents.files), pages: JSON.stringify(documents.pages), modules: "[]", announcements: "[]", downloadManifest: "[]" },
            "course-102": { files: "[]", pages: "[]", modules: "[]", announcements: "[]", downloadManifest: "[]" },
            "course-103": { files: "[]", pages: "[]", modules: "[]", announcements: "[]", downloadManifest: "[]" },
          },
          ...(freshness === undefined ? {} : { browserFreshness: freshness }),
        };
      }
      if (command === "start_canvas_refresh") {
        if (setup.refreshError === true) throw { code: "refresh-failed", message: "Synthetic refresh failure" };
        const coursework = documents.coursework as { generated: string; courses: Record<string, unknown>[]; items: Record<string, unknown>[] };
        coursework.courses = coursework.courses.filter((course) => course.key !== "102");
        const deadline = coursework.items.find((item) => item.id === "canvas-deadline");
        if (deadline !== undefined) Object.assign(deadline, { title: "After Canvas deadline", at: futureDate(15), score: 9, grade: "90%" });
        const done = coursework.items.find((item) => item.id === "canvas-done");
        if (done !== undefined) done.title = "After done item";
        coursework.items = coursework.items.filter((item) => item.course !== "102");
        coursework.generated = new Date(Date.now() + 1_000).toISOString();
        documents.files = [{ id: 502, display_name: "New Canvas file.pdf" }];
        documents.pages = [];
        const selected = (documents.conversations as Record<string, unknown>[]).find((thread) => thread.canvasConversationId === "thread-selected");
        if (selected !== undefined) {
          selected.latestMessagePreview = "Selected preview after refresh";
          selected.latestMessageAt = new Date(Date.now() + 2_000).toISOString();
          selected.messages = [{ canvasMessageId: "message-selected", author: "Another Instructor", createdAt: selected.latestMessageAt, body: "Selected message after refresh" }];
        }
        documents.history = [{
          id: "canvas-run-after",
          source: "canvas",
          status: "succeeded",
          sourceComplete: true,
          startedAt: new Date(Date.now() + 3_000).toISOString(),
          finishedAt: new Date(Date.now() + 4_000).toISOString(),
          summary: { added: 0, updated: 1, removed: 0 },
          changes: setup.dateOnlyActivity === true
            ? [{
              kind: "changed",
              title: "Synthetic Sunday assignment",
              course: "SYN101",
              fields: [
                { field: "at", before: "2026-09-20", after: "2026-09-27" },
                { field: "gradedAt", before: null, after: "2026-09-27" },
              ],
            }]
            : [{ kind: "changed", title: "After Canvas deadline", detail: "Score: 8 → 9" }],
        }, ...(documents.history as Record<string, unknown>[])];
        persistDocuments();
        if (setup.failReload === true) failNextRead = true;
        return { status: "complete", updatedAt: new Date(Date.now() + 4_000).toISOString() };
      }
      if (command === "start_ical_refresh") {
        const coursework = documents.coursework as { items: Record<string, unknown>[] };
        if (setup.noCalendarChange !== true) {
          const due = coursework.items.find((item) => item.id === "calendar-deadline");
          if (due !== undefined) due.at = futureDate(20);
        }
        documents.history = [{
          id: setup.noCalendarChange === true ? "calendar-run-no-change" : "calendar-run-after",
          source: "calendar",
          sourceLabel: "calendar",
          status: "succeeded",
          sourceComplete: false,
          startedAt: new Date(Date.now() + 1_000).toISOString(),
          finishedAt: new Date(Date.now() + 2_000).toISOString(),
          summary: { added: 0, updated: setup.noCalendarChange === true ? 0 : 1, removed: 0, held: 0 },
          changes: setup.noCalendarChange === true ? [] : [{ kind: "changed", title: "Synthetic calendar deadline", detail: "Due date updated." }],
        }, ...(documents.history as Record<string, unknown>[])];
        persistDocuments();
        return { status: "complete", updatedAt: new Date(Date.now() + 2_000).toISOString(), added: 0, updated: setup.noCalendarChange === true ? 0 : 1, held: 0, removed: 0 };
      }
      if (command === "start_full_refresh") {
        const serialized = JSON.parse(JSON.stringify(args.onProgress)) as unknown;
        const channel = typeof serialized === "string" ? serialized.match(/^__CHANNEL__:(\d+)$/) : null;
        if (channel === null) throw { code: "invalid-channel", message: "The synthetic full-refresh channel is invalid." };
        const callback = callbacks.get(Number(channel[1]));
        let index = 0;
        const phase = (value: string): void => { callback?.({ index, message: { phase: value } }); index += 1; };
        phase("browser-capture");
        if (setup.holdFullRefresh === true) await new Promise<void>((resolve) => { scope.__releaseFullRefresh = resolve; });
        const coursework = documents.coursework as { generated: string; courses: Record<string, unknown>[]; items: Record<string, unknown>[] };
        const calendarItem = coursework.items.find((item) => item.id === "calendar-deadline");
        if (calendarItem !== undefined) calendarItem.at = futureDate(20);
        if (setup.fullGap !== true) {
          coursework.courses = coursework.courses.filter((course) => course.key !== "102");
          coursework.items = coursework.items.filter((item) => item.course !== "102");
          const deadline = coursework.items.find((item) => item.id === "canvas-deadline");
          if (deadline !== undefined) Object.assign(deadline, { title: "After full refresh deadline", at: futureDate(15), score: 9, grade: "90%" });
          const personalDone = coursework.items.find((item) => item.id === "canvas-done");
          if (personalDone !== undefined) personalDone.title = "After full refresh done item";
          documents.files = [{ id: 503, display_name: "Full refresh Canvas file.pdf" }];
          documents.pages = [{ page_id: "full-page", title: "Full refresh Canvas page" }];
          documents.conversations = (documents.conversations as Record<string, unknown>[]).filter((thread) => thread.canvasConversationId !== "thread-selected");
          const first = (documents.conversations as Record<string, unknown>[])[0];
          if (first !== undefined) first.latestMessagePreview = "Full refresh Inbox preview";
          coursework.generated = new Date(Date.now() + 1_000).toISOString();
        } else fullCaptureStale = true;
        documents.history = [{
          id: "full-run-after", source: "canvas", sourceLabel: "canvas", status: "incomplete", sourceComplete: false,
          dailyScopeStatus: setup.fullGap === true ? "incomplete" : "complete",
          dailyGapCount: setup.fullGap === true ? 2 : 0,
          dailyOmissionCount: setup.fullOmissionCount ?? 0,
          startedAt: new Date(Date.now() + 2_000).toISOString(), finishedAt: new Date(Date.now() + 3_000).toISOString(),
          summary: { added: 1, updated: 2, removed: 0 }, changes: [
            { kind: "changed", title: "Synthetic Canvas changes", detail: "Full refresh completed its available sections." },
            ...(setup.fullGap === true
              ? [{ kind: "notice", title: "Daily Canvas pages incomplete", detail: "2 required daily sections were incomplete; existing data was preserved." }]
              : [{ kind: "notice", title: "Daily Canvas pages refreshed", detail: `${setup.fullOmissionCount ?? 0} optional capture omissions recorded. Existing data was preserved.` }]),
          ],
        }, ...(documents.history as Record<string, unknown>[])];
        persistDocuments();
        phase("browser-import"); phase("calendar"); phase("complete"); callback?.({ index, end: true });
        if (setup.failReload === true) failNextRead = true;
        if (setup.fullRefreshError === true) throw { code: "full-refresh-failed", message: "Synthetic full refresh failed after writing calendar state." };
        return {
          status: setup.fullGap === true ? "incomplete" : "complete", browserStatus: setup.fullGap === true ? "incomplete" : "complete",
          calendarStatus: "complete", gapCount: setup.fullGap === true ? 2 : 0, omissionCount: setup.fullOmissionCount ?? 0,
          calendarAdded: 1, calendarUpdated: 1, calendarHeld: setup.fullGap === true ? 1 : 0,
          updatedAt: new Date(Date.now() + 3_000).toISOString(), ...(setup.fullGap === true ? { errorCode: "coverage-gap" } : {}),
        };
      }
      throw { code: "unexpected-command", message: "Unexpected synthetic IPC command: " + command };
    },
  };
}

async function openDashboard(page: Page, setup: Setup = {}): Promise<void> {
  const initial = initialDocuments();
  if (setup.malformedCalendarConfirmation === true) {
    (initial.coursework as Record<string, unknown>)._calendarConfirmation = {
      schema: 1,
      eligibleGeneration: { digest: "invalid", members: [] },
      retained: ["calendar-deadline"],
    };
  }
  await page.addInitScript(installNativeMock, { setup, now: NOW, initial });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
}

async function visit(page: Page, label: string): Promise<void> {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: label, exact: true }).click();
  await expect(page.locator("[data-page-panel]")).toBeVisible();
}

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
  await expect(page.locator(".sync-note")).toHaveText("Refresh complete.");
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
  await expect(page.getByRole("heading", { name: /Canvas refresh ·/ })).toBeVisible();
  await expect(page.getByText("After Canvas deadline", { exact: true })).toBeVisible();
  await visit(page, "More");
  await expect(page.locator("[data-desktop-store=authoritative]")).toContainText("Last refresh");
  const commands = await page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.map((call) => call.command));
  expect(commands.filter((command) => command === "read_dashboard_documents")).toHaveLength(2);
  expect(commands.filter((command) => command === "start_canvas_refresh")).toHaveLength(1);
  expect(commands).not.toContain("start_ical_refresh");
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
  await expect(page.locator(".sync-note")).toContainText("Canvas and calendar refresh · Opening Canvas");
  await expect(refresh).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.filter((call) => call.command === "start_full_refresh").length)).toBe(1);
  await page.evaluate(() => (window as unknown as { __releaseFullRefresh?: () => void }).__releaseFullRefresh?.());
  await expect(page.locator(".sync-note")).toContainText("Current Canvas pages refreshed.");
  await expect(page.locator(".sync-note")).toContainText("2 optional capture omissions recorded");
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
  await expect(page.locator("#main").getByText(/Daily Canvas pages refreshed; 2 optional capture omissions recorded\. Existing data was preserved\./)).toBeVisible();
  await expect(page.locator("#main").getByText("Daily Canvas pages refreshed", { exact: true })).toBeVisible();
  await visit(page, "More");
  await expect(store).toContainText("Full refresh is available.");
  await expect(store.getByRole("checkbox", { name: "Enable Canvas refresh" })).toHaveCount(0);

  const commands = await page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.map((call) => call.command));
  expect(commands.filter((command) => command === "read_dashboard_documents")).toHaveLength(2);
  expect(commands.filter((command) => command === "start_full_refresh")).toHaveLength(1);
  expect(commands).not.toContain("start_canvas_refresh");
  expect(commands).not.toContain("start_ical_refresh");
});

test("full refresh reports coverage gaps, reloads freshness, and rereads after command failure", async ({ page, context }) => {
  await openDashboard(page, { mode: "full", fullGap: true });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".sync-note")).toContainText("Full refresh partial. Canvas incomplete (2 coverage gaps; no optional capture omissions); calendar complete");
  await expect(page.locator("[data-source-freshness=stale]")).toContainText("Capture status: capture unverified.");
  await expect(page.getByRole("heading", { name: "Before Canvas deadline" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Synthetic calendar deadline" })).toBeVisible();
  await visit(page, "Activity");
  await expect(page.locator("#main").getByText("partial", { exact: true }).first()).toBeVisible();
  await expect(page.locator("#main").getByText("Daily Canvas pages incomplete", { exact: true })).toBeVisible();
  let commands = await page.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.map((call) => call.command));
  expect(commands.filter((command) => command === "read_dashboard_documents")).toHaveLength(2);
  expect(commands.filter((command) => command === "start_full_refresh")).toHaveLength(1);
  expect(commands).not.toContain("start_canvas_refresh");
  expect(commands).not.toContain("start_ical_refresh");

  const failed = await context.newPage();
  await openDashboard(failed, { mode: "full", fullRefreshError: true });
  await failed.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(failed.locator(".sync-note")).toHaveText("Full refresh failed. Latest saved data was reloaded.");
  await expect(failed.getByRole("heading", { name: "After full refresh deadline" })).toBeVisible();
  commands = await failed.evaluate(() => (window as unknown as { __refreshCalls: { command: string }[] }).__refreshCalls.map((call) => call.command));
  expect(commands.filter((command) => command === "read_dashboard_documents")).toHaveLength(2);
  expect(commands.filter((command) => command === "start_full_refresh")).toHaveLength(1);
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
  await expect(page.locator(".more-action.refresh-button")).toHaveAccessibleName("Refresh calendar");

  await page.locator(".top-actions").getByRole("button", { name: "Refresh calendar", exact: true }).click();
  await expect(page.locator(".sync-note")).toContainText("Calendar refresh complete · 0 added · 1 updated · 0 held");
  await visit(page, "Timeline");
  await expect(page.getByRole("heading", { name: "Synthetic calendar deadline" })).toBeVisible();
  await visit(page, "Grades");
  await expect(page.getByText("80%", { exact: true }).first()).toBeVisible();
  await visit(page, "Inbox");
  await expect(page.getByText("Selected message before refresh", { exact: true })).toBeVisible();
  await visit(page, "Library");
  await expect(page.getByRole("heading", { name: "Old Canvas file.pdf" })).toBeVisible();
  await visit(page, "Activity");
  await expect(page.getByRole("heading", { name: /Calendar refresh ·/ })).toBeVisible();
  await expect(page.getByText("Calendar refresh updates deadlines only. Grades, Inbox, and library items keep the prior Canvas capture.")).toBeVisible();
  await expect(page.locator(".change-count").filter({ hasText: "Changed" })).toContainText("1");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.locator(".sync-note")).toContainText("Calendar deadlines only");
  await visit(page, "Activity");
  await expect(page.getByText("Calendar refresh updates deadlines only.", { exact: false })).toBeVisible();
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
  await expect(page.locator(".sync-note")).toContainText("Calendar refresh complete · 0 added · 0 updated · 0 held");
  await visit(page, "Activity");
  await expect(page.getByText("Calendar refresh updates deadlines only. Grades, Inbox, and library items keep the prior Canvas capture.")).toBeVisible();
  await expect(page.getByText("This refresh recorded no item-level changes.", { exact: true })).toBeVisible();
});

test("failed refreshes and failed reloads retain the prior view and warn", async ({ page, context }) => {
  await openDashboard(page, { mode: "canvas", refreshError: true });
  await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".sync-note")).toHaveText("Refresh failed. Existing data was kept.");
  await expect(page.getByRole("heading", { name: "Before Canvas deadline" })).toBeVisible();

  const second = await context.newPage();
  await openDashboard(second, { mode: "canvas", failReload: true });
  await second.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(second.locator(".sync-note")).toHaveText("Refresh finished, but updated data could not be reloaded. The prior view is still shown.");
  await expect(second.getByRole("heading", { name: "Before Canvas deadline" })).toBeVisible();
});

test("stale browser freshness masks Canvas facts and explains the gap on each page", async ({ page }) => {
  await openDashboard(page, { mode: "canvas", staleCapture: true });
  await expect(page.getByRole("heading", { name: "Before Canvas deadline" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Synthetic calendar deadline" })).toBeVisible();
  for (const label of ["Timeline", "Grades", "Inbox", "Done", "Courses", "Library", "Activity", "More"]) {
    if (label !== "Timeline") await visit(page, label);
    await expect(page.locator("[data-source-freshness=stale]")).toContainText("Capture status: capture unverified.");
    await expect(page.locator("[data-source-freshness=stale]")).toContainText("independent calendar and personal records remain");
  }
});

test.describe("Activity date-only timezone regression", () => {
  test.use({ timezoneId: "America/New_York" });

  test("Activity displays date-only deadline at 11:59 PM on stated Sunday and not Saturday 8:00 PM after refresh", async ({ page }) => {
    await openDashboard(page, { mode: "canvas", dateOnlyActivity: true });
    await page.locator(".top-actions").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".sync-note")).toHaveText("Refresh complete.");

    await visit(page, "Activity");
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
