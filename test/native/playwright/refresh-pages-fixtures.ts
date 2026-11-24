import { expect, type Page } from "@playwright/test";

const future = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
export const NOW = new Date().toISOString();

export interface Setup {
  readonly mode?: "canvas" | "calendar" | "full" | "none";
  readonly autoRefreshChanges?: "none" | "coursework" | "grade" | "inbox" | "library";
  readonly initialLoadError?: boolean;
  readonly historicalChanges?: boolean;
  readonly refreshError?: boolean;
  readonly fullRefreshError?: boolean;
  readonly fullErrorCode?: string;
  readonly fullGap?: boolean;
  readonly fullGapCount?: number;
  readonly fullCalendarHeld?: number;
  readonly fullOmissionCount?: number;
  readonly holdFullRefresh?: boolean;
  readonly failReload?: boolean;
  readonly noCalendarChange?: boolean;
  readonly staleCapture?: boolean;
  readonly noDeadlines?: boolean;
  readonly verifiedEmpty?: boolean;
  readonly dateOnlyActivity?: boolean;
  readonly malformedCalendarConfirmation?: boolean;
  readonly initialHistoryStatuses?: readonly { readonly status: "succeeded" | "incomplete" | "failed"; readonly sourceComplete: boolean }[];
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
  let canvasRefreshCalls = 0;
  let calendarRefreshCalls = 0;
  let fullRefreshCalls = 0;
  if (setup.noDeadlines) (documents.coursework as { items: unknown[] }).items = [];
  if (setup.verifiedEmpty) {
    (documents.coursework as { items: unknown[] }).items = [];
    documents.conversations = [];
    documents.files = [];
    documents.pages = [];
  }
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) documents = JSON.parse(stored) as Record<string, unknown>;
  } catch { /* A fresh synthetic context uses its in-memory fixture. */ }
  const persistDocuments = (): void => { localStorage.setItem(storageKey, JSON.stringify(documents)); };
  const recordNoChange = (source: "canvas" | "calendar", id: string): void => {
    documents.history = [{ id, source, status: "succeeded", sourceComplete: source === "canvas", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: { added: 0, updated: 0, removed: 0, held: 0 }, changes: [] }, ...(documents.history as Record<string, unknown>[])];
    persistDocuments();
  };
  let failNextRead = false;
  let failInitialRead = setup.initialLoadError === true;
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
        if (failInitialRead) { failInitialRead = false; throw { code: "store-unavailable", message: "Synthetic initial read failure" }; }
        if (failNextRead) { failNextRead = false; throw { code: "store-unavailable", message: "Synthetic reload failure" }; }
        const freshness = setup.verifiedEmpty === true
          ? {
              current: true,
              reason: "verified-import",
              runId: 1,
              observedAt: now,
              sections: [
                ...[101, 102, 103].flatMap((courseId) =>
                  ["course", "assignments", "assignmentGroups", "submissions", "courseFiles", "pages", "modules", "announcements"]
                    .map((endpoint) => ({ courseId, endpoint, current: true }))),
                { courseId: null, endpoint: "inboxAll", current: true },
              ],
            }
          : setup.staleCapture === true || fullCaptureStale
          ? { current: false, reason: "capture-unverified", runId: null, observedAt: null, sections: [] }
          : undefined;
        return {
          storeState: "authoritative",
          coursework: { text: JSON.stringify(documents.coursework), version: "b".repeat(64) },
          refreshHistory: JSON.stringify({ events: documents.history }),
          conversations: JSON.stringify({ complete: true, generatedAt: documents.inboxGeneratedAt ?? now, conversations: documents.conversations, ...(documents.inboxChanges === undefined ? {} : { changes: documents.inboxChanges }) }),
          profile: null,
          avatar: null,
          courseExports: {
            "course-101": { files: JSON.stringify(documents.files), pages: JSON.stringify(documents.pages), modules: "[]", announcements: "[]", quizzes: "[]", downloadManifest: "[]" },
            "course-102": { files: "[]", pages: "[]", modules: "[]", announcements: "[]", quizzes: "[]", downloadManifest: "[]" },
            "course-103": { files: "[]", pages: "[]", modules: "[]", announcements: "[]", quizzes: "[]", downloadManifest: "[]" },
          },
          ...(freshness === undefined ? {} : { browserFreshness: freshness }),
        };
      }
      if (command === "start_canvas_refresh") {
        canvasRefreshCalls += 1;
        if (setup.autoRefreshChanges === "none" || canvasRefreshCalls === 1 && setup.autoRefreshChanges === undefined) {
          recordNoChange("canvas", `canvas-run-auto-${String(canvasRefreshCalls)}`);
          return { status: "complete", updatedAt: new Date().toISOString() };
        }
        if (canvasRefreshCalls === 1 && setup.autoRefreshChanges === "library") {
          documents.files = [...(documents.files as Record<string, unknown>[]), { id: 504, display_name: "New automatic library file.pdf" }];
          recordNoChange("canvas", "canvas-run-auto-library");
          return { status: "complete", updatedAt: new Date().toISOString() };
        }
        if (canvasRefreshCalls === 1 && setup.autoRefreshChanges === "inbox") {
          documents.conversations = [...documents.conversations as Record<string, unknown>[], { canvasConversationId: "thread-auto", subject: "Automatic inbox update", unread: true, starred: false, messageCount: 1, latestMessageAt: new Date().toISOString(), messages: [{ canvasMessageId: "auto-message", author: "Synthetic Instructor", createdAt: new Date().toISOString(), body: "Synthetic new message" }], attachments: [] }];
          documents.inboxGeneratedAt = new Date().toISOString();
          recordNoChange("canvas", "canvas-run-auto-inbox");
          return { status: "complete", updatedAt: new Date().toISOString() };
        }
        if (canvasRefreshCalls === 1 && setup.autoRefreshChanges === "grade") {
          const coursework = documents.coursework as { items: Record<string, unknown>[] };
          const grade = coursework.items.find((item) => item.id === "canvas-deadline");
          if (grade !== undefined) Object.assign(grade, { score: 9, grade: "90%" });
          documents.history = [{ id: "canvas-run-auto-grade", source: "canvas", status: "succeeded", sourceComplete: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: { added: 0, updated: 1, removed: 0 }, changes: [{ kind: "changed", title: "Synthetic grade update", detail: "Score: 8 → 9" }] }, ...(documents.history as Record<string, unknown>[])];
          persistDocuments();
          return { status: "complete", updatedAt: new Date().toISOString() };
        }
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
        calendarRefreshCalls += 1;
        if (setup.autoRefreshChanges === "none" || calendarRefreshCalls === 1 && setup.autoRefreshChanges === undefined) {
          recordNoChange("calendar", `calendar-run-auto-${String(calendarRefreshCalls)}`);
          return { status: "complete", updatedAt: new Date().toISOString(), added: 0, updated: 0, held: 0, removed: 0 };
        }
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
        fullRefreshCalls += 1;
        if (setup.autoRefreshChanges === "none" || fullRefreshCalls === 1 && setup.autoRefreshChanges === undefined) {
          recordNoChange("canvas", `canvas-run-auto-${String(fullRefreshCalls)}`);
          recordNoChange("calendar", `calendar-run-auto-${String(fullRefreshCalls)}`);
          return { status: "complete", browserStatus: "complete", calendarStatus: "complete", gapCount: 0, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0, bodyFailureReason: null, exportStatus: "disabled", exportWritten: 0, exportUnchanged: 0, exportSkippedOwnerFiles: 0, rubricCount: 0, linkedFileCount: 0, calendarAdded: 0, calendarUpdated: 0, calendarHeld: 0, updatedAt: new Date().toISOString() };
        }
        const gapCount = setup.fullGapCount ?? (setup.fullGap === true ? 2 : 0);
        const heldCount = setup.fullCalendarHeld ?? (setup.fullGap === true ? 1 : 0);
        const serialized = JSON.parse(JSON.stringify(args.onProgress)) as unknown;
        const channel = typeof serialized === "string" ? serialized.match(/^__CHANNEL__:(\d+)$/) : null;
        if (channel === null) throw { code: "invalid-channel", message: "The synthetic full-refresh channel is invalid." };
        const callback = callbacks.get(Number(channel[1]));
        let index = 0;
        const phase = (value: string): void => { callback?.({ index, message: { phase: value } }); index += 1; };
        phase("browser-capture");
        if (setup.holdFullRefresh === true) await new Promise<void>((resolve) => { scope.__releaseFullRefresh = resolve; });
        if (setup.fullErrorCode !== undefined) {
          phase("browser-import"); phase("calendar"); phase("complete"); callback?.({ index, end: true });
          return {
            status: "incomplete", browserStatus: "failed", calendarStatus: "complete",
            gapCount: 0, omissionCount: 0, bodyCount: 5, emptyBodyCount: 1, bodyFailureReason: null, exportStatus: "disabled", exportWritten: 0, exportUnchanged: 0, exportSkippedOwnerFiles: 0, rubricCount: 0, linkedFileCount: 0, calendarAdded: 0, calendarUpdated: 0, calendarHeld: 0,
            updatedAt: null, errorCode: setup.fullErrorCode,
          };
        }
        const coursework = documents.coursework as { generated: string; courses: Record<string, unknown>[]; items: Record<string, unknown>[] };
        const calendarItem = coursework.items.find((item) => item.id === "calendar-deadline");
        if (calendarItem !== undefined) calendarItem.at = futureDate(20);
        if (gapCount === 0) {
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
        const dailyOmissionCount = setup.fullOmissionCount ?? 0;
        documents.history = [{
          id: "full-run-after", source: "canvas", sourceLabel: "canvas",
          status: gapCount > 0 ? "incomplete" : "succeeded", sourceComplete: gapCount === 0,
          dailyScopeStatus: gapCount > 0 ? "incomplete" : "complete",
          dailyGapCount: gapCount,
          dailyOmissionCount,
          startedAt: new Date(Date.now() + 2_000).toISOString(), finishedAt: new Date(Date.now() + 3_000).toISOString(),
          summary: { added: 1, updated: 2, removed: 0 }, changes: [
            { kind: "changed", title: "Synthetic Canvas changes", detail: "Full refresh completed its available sections." },
            ...(gapCount > 0
              ? [{ kind: "notice", title: "Canvas refresh was incomplete", detail: `${String(gapCount)} required daily sections were incomplete; ${String(dailyOmissionCount)} optional capture omissions recorded. Existing data was kept.` },
                { kind: "notice", title: "Canvas file check", detail: "1 file: could not be verified because its contents did not match a supported file type. Existing copies were kept." },
                { kind: "notice", title: "Personal Canvas file check", detail: "1 personal file could not be verified." }]
              : [{ kind: "notice", title: "Canvas refresh completed", detail: `${String(dailyOmissionCount)} optional capture omissions recorded. Existing data was preserved.` }]),
          ],
        }, ...(documents.history as Record<string, unknown>[])];
        persistDocuments();
        phase("browser-import"); phase("calendar"); phase("complete"); callback?.({ index, end: true });
        if (setup.failReload === true) failNextRead = true;
        if (setup.fullRefreshError === true) throw { code: "full-refresh-failed", message: "Synthetic full refresh failed after writing calendar state." };
        return {
          status: gapCount > 0 || heldCount > 0 ? "incomplete" : "complete",
          browserStatus: gapCount > 0 ? "incomplete" : "complete",
          calendarStatus: heldCount > 0 ? "incomplete" : "complete",
          gapCount, omissionCount: setup.fullOmissionCount ?? 0, bodyCount: 5, emptyBodyCount: 1, bodyFailureReason: null, exportStatus: "disabled", exportWritten: 0, exportUnchanged: 0, exportSkippedOwnerFiles: 0, rubricCount: 1, linkedFileCount: 2,
          calendarAdded: 1, calendarUpdated: 1, calendarHeld: heldCount,
          updatedAt: new Date(Date.now() + 3_000).toISOString(), ...(gapCount > 0 ? { errorCode: "coverage-gap" } : {}),
        };
      }
      throw { code: "unexpected-command", message: "Unexpected synthetic IPC command: " + command };
    },
  };
}

export async function openDashboard(page: Page, setup: Setup = {}): Promise<void> {
  const initial = initialDocuments();
  if (setup.initialHistoryStatuses !== undefined) {
    initial.history = setup.initialHistoryStatuses.map((receipt, index) => ({
      id: `${receipt.status}-run-${String(index)}`, source: "canvas", sourceLabel: "canvas", status: receipt.status, sourceComplete: receipt.sourceComplete,
      startedAt: `2026-10-0${String(index + 1)}T12:00:00Z`, finishedAt: `2026-10-0${String(index + 1)}T12:01:00Z`,
      summary: { added: 0, updated: 0, removed: 0 }, changes: [],
    }));
  }
  if (setup.historicalChanges === true) {
    initial.history = [{ id: "historic-with-changes", source: "canvas", status: "succeeded", sourceComplete: true, startedAt: "2026-09-01T12:00:00Z", finishedAt: "2026-09-01T12:01:00Z", summary: { added: 2, updated: 1, removed: 0 }, changes: [{ kind: "changed", title: "Earlier item", detail: "Historical update." }] }, ...(initial.history as Record<string, unknown>[])];
  }
  if (setup.malformedCalendarConfirmation === true) {
    (initial.coursework as Record<string, unknown>)._calendarConfirmation = {
      schema: 1,
      eligibleGeneration: { digest: "invalid", members: [] },
      retained: ["calendar-deadline"],
    };
  }
  await page.addInitScript(installNativeMock, { setup, now: NOW, initial });
  await page.goto("/");
  if (setup.initialLoadError !== true) await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
  if (setup.mode !== undefined && setup.mode !== "none") await expect(page.locator(".top-actions .refresh-button")).toBeEnabled();
}

export async function visit(page: Page, label: string): Promise<void> {
  const link = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: label, exact: true });
  const target = await link.getAttribute("href");
  if (target === null || !target.startsWith("#")) throw new Error(`Expected a page hash for ${label}`);
  await link.click();
  await expect(page.locator(`[data-page-panel="${target.slice(1)}"]`)).toBeVisible();
}

export async function selectNewestRefresh(page: Page): Promise<void> {
  const history = page.locator(".history-row");
  expect(await history.count()).toBeGreaterThan(1);
  // Reload preserves the oldest selected run when it remains available.
  await expect(history.first()).not.toHaveClass(/active/);
  await expect(history.last()).toHaveClass(/active/);
  await history.first().click();
  await expect(history.first()).toHaveClass(/active/);
}
