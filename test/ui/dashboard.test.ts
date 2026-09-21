import { describe, expect, it, vi } from "vitest";
import { dashboardEventKind, parseDashboard, postMutation } from "../../src/ui/app";
import type { ElementDescriptor } from "../../src/ui/dom";
import { countdownText, gradeProgress, renderDashboard, type DashboardData, type DashboardEvent, type DashboardHandlers, type DashboardState } from "../../src/ui/pages/dashboard";
import { DASHBOARD_ROUTES } from "../../src/ui/routes";

function findAll(descriptor: ElementDescriptor, predicate: (item: ElementDescriptor) => boolean): ElementDescriptor[] {
  return [...(predicate(descriptor) ? [descriptor] : []), ...(descriptor.children ?? []).flatMap((child) => findAll(child, predicate))];
}
function words(descriptor: ElementDescriptor): string { return [descriptor.text ?? "", ...(descriptor.children ?? []).map(words)].join(" "); }

const NOW = Date.parse("2026-09-20T12:00:00-04:00");
const DATA: DashboardData = {
  version: 1,
  courses: [
    { id: "570", courseCode: "IT570", title: "Policy", gradeGroups: [{ id: "570-projects", name: "Projects", weight: 70 }, { id: "570-exams", name: "Exams", weight: 30 }] },
    { id: "530", courseCode: "IT 530", title: "Security", gradeGroups: [{ id: "530-projects", name: "Projects", weight: 60 }, { id: "530-exams", name: "Exams", weight: 40 }] },
    { id: "540", courseCode: "IT540", title: "Data" },
  ],
  events: [
    { id: "a", sourceItemId: "a", courseId: "530", courseCode: "IT530", kind: "deadline", title: "Lab report", startsAt: "2026-09-20T20:00:00-04:00", completed: false, source: "canvas", points: 20, score: 18, grade: "90%", gradedAt: "2026-09-19T18:00:00-04:00", assignmentGroupId: "530-projects", assignmentGroupName: "Projects", assignmentGroupWeight: 60 },
    { id: "b", sourceItemId: "b", courseId: "530", courseCode: "IT530", kind: "deadline", title: "Reading", startsAt: "2026-09-20T23:59:00-04:00", completed: false, points: 10, score: null, grade: null, gradedAt: null, assignmentGroupId: "530-projects", assignmentGroupName: "Projects", assignmentGroupWeight: 60 },
    { id: "c", courseId: "540", courseCode: "IT540", kind: "class", title: "Workshop", startsAt: "2026-09-23T18:00:00-04:00", completed: false },
    { id: "discussion", sourceItemId: "discussion", courseId: "570", courseCode: "IT570", kind: "discussion", title: "Discussion board", startsAt: "2026-09-25T18:00:00-04:00", completed: false, discussionPostDone: true, discussionRepliesDone: false },
    { id: "d", sourceItemId: "d", courseId: "570", courseCode: "IT570", kind: "deadline", title: "Memo", startsAt: "2026-09-26T12:00:00-04:00", completed: true, completedAt: NOW },
  ],
  resources: [
    { id: "safe", courseId: "530", courseCode: "IT530", type: "File", title: "Guide", localUrl: "/api/local/resources/safe" },
    { id: "unsafe", courseId: "540", courseCode: "IT540", type: "Link", title: "Remote", localUrl: "https://example.invalid/" },
  ],
  conversations: [{ id: "message", courseCode: "IT570", sender: "Instructor", subject: "Update", body: "Read-only body", unread: true, messages: [{ id: "m1", author: "Instructor", createdAt: NOW, body: "Full thread body", attachments: [{ name: "guide.pdf" }] }], historyComplete: true }],
  refreshes: [{ id: "refresh", startedAt: NOW, status: "partial", summary: "Existing items were kept.", added: 0, changed: 0, removed: 0, changes: [{ kind: "notice", title: "IT 570 unavailable", detail: "No existing data was removed." }] }],
  profile: null,
  refreshAvailable: true,
  sourceStatus: { state: "ready", label: "Local source", detail: "Available", lastRefreshAt: NOW },
};

const handlers: DashboardHandlers = {
  onNavigate: vi.fn(), onEventMode: vi.fn(), onCourseFilter: vi.fn(), onGradeCourseFilter: vi.fn(), onGradeMode: vi.fn(), onResourceFilter: vi.fn(), onToggleEvent: vi.fn(), onToggleCompletion: vi.fn(), onToggleDiscussion: vi.fn(), onSelectConversation: vi.fn(), onSelectRefresh: vi.fn(), onRefresh: vi.fn(),
};
function state(page: DashboardState["page"]): DashboardState {
  return { page, loading: false, data: DATA, now: NOW, eventMode: "all", courseFilter: "all", gradeCourseFilter: "all", gradeMode: "all", resourceFilter: "all", expandedEventIds: new Set(), pendingCompletionIds: new Set(), failedCompletionIds: new Set(), pendingDiscussionIds: new Set(), failedDiscussionIds: new Set(), selectedConversationId: "message", selectedRefreshId: "refresh", refreshState: "idle" };
}

describe("dashboard production UI contract", () => {
  it("parses a local profile fail-closed and renders avatar fallback initials", () => {
    const parsed = parseDashboard({ profile: { displayName: "Alex Student", avatarPath: "/api/local/profile/avatar" } });
    expect(parsed.profile).toEqual({ displayName: "Alex Student", avatarPath: "/api/local/profile/avatar" });
    const dashboard = renderDashboard({ ...state("timeline"), data: { ...DATA, profile: parsed.profile } }, handlers);
    const image = findAll(dashboard, (item) => item.tag === "img" && item.attrs?.class === "brand-avatar")[0];
    expect(image?.attrs).toMatchObject({ src: "/api/local/profile/avatar", alt: "Alex Student" });
    expect(words(findAll(dashboard, (item) => item.attrs?.class === "brand-initials")[0]!)).toBe("AS");
    const target = { setAttribute: vi.fn() };
    image?.on?.error?.({ currentTarget: target } as unknown as Event);
    expect(target.setAttribute).toHaveBeenCalledWith("hidden", "");
    expect(parseDashboard({ profile: { displayName: "Alex Student", avatarPath: "https://external.invalid/avatar" } }).profile).toEqual({ displayName: "Alex Student", avatarPath: null });
    expect(findAll(renderDashboard({ ...state("timeline"), data: { ...DATA, profile: null } }, handlers), (item) => item.tag === "img")).toHaveLength(0);
  });
  it("keeps zero-weight groups out of both indicators and exposes partial coverage", () => {
    const course = {
      id: "course",
      courseCode: "IT 999",
      title: "Synthetic",
      gradeGroups: [
        { id: "graded", name: "Graded", weight: 60 },
        { id: "absent", name: "Absent", weight: 40 },
        { id: "extra", name: "Extra credit", weight: 0 },
      ],
    } as const;
    const records: DashboardEvent[] = [
      { id: "scored", courseId: "course", courseCode: "IT 999", kind: "deadline", title: "Scored", startsAt: "2026-09-20", completed: false, points: 10, score: 8, assignmentGroupId: "graded" },
      { id: "ungraded", courseId: "course", courseCode: "IT 999", kind: "deadline", title: "Ungraded", startsAt: "2026-09-21", completed: false, points: 10, score: null, assignmentGroupId: "graded" },
      { id: "extra", courseId: "course", courseCode: "IT 999", kind: "deadline", title: "Extra", startsAt: "2026-09-22", completed: false, points: 0, score: 100, assignmentGroupId: "extra" },
    ];

    expect(gradeProgress(course, records)).toEqual({ graded: 80, gradedCoverage: 60, wholeCourse: 24, publishedCoverage: 60 });
    expect(gradeProgress(course, records.filter((record) => record.id !== "scored"))).toEqual({ graded: null, gradedCoverage: 0, wholeCourse: 0, publishedCoverage: 60 });
  });

  it("keeps projected sessions out of assignment and grade views", () => {
    expect(dashboardEventKind("session", "class")).toBe("class");
    expect(dashboardEventKind("session", "")).toBe("class");
  });

  it("exposes the approved eight-page navigation", () => {
    expect(DASHBOARD_ROUTES.map((route) => route.page)).toEqual(["timeline", "grades", "inbox", "completed", "courses", "library", "activity", "more"]);
    for (const route of DASHBOARD_ROUTES) {
      const dashboard = renderDashboard(state(route.page), handlers);
      expect(findAll(dashboard, (item) => item.attrs?.["data-page-panel"] === route.page)).toHaveLength(1);
    }
    const dashboard = renderDashboard(state("timeline"), handlers);
    expect(findAll(dashboard, (item) => item.attrs?.["aria-current"] === "page")[0]?.attrs?.href).toBe("#timeline");
  });

  it("renews the local CSRF token once and retries refresh through the mutation helper", async () => {
    let cookie = "duegood_local_csrf=stale-token";
    Object.defineProperty(globalThis, "document", { configurable: true, value: { get cookie() { return cookie; } } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockImplementationOnce(async () => { cookie = "duegood_local_csrf=renewed-token"; return new Response("", { status: 200 }); })
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await postMutation("/api/local/refresh");
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/local/refresh");
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-DueGood-CSRF-Token": "stale-token" });
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/");
      expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/local/refresh");
      expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ "X-DueGood-CSRF-Token": "renewed-token" });
    } finally {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("renders consecutive day slots beyond September 25 and stable IT530/IT540/IT570 lanes", () => {
    const dashboard = renderDashboard(state("timeline"), handlers);
    const labels = findAll(dashboard, (item) => item.attrs?.class === "lane-label").map(words);
    expect(labels.map((label) => label.match(/IT \d+/)?.[0])).toEqual(["IT 530", "IT 540", "IT 570"]);
    const days = findAll(dashboard, (item) => item.attrs?.["data-day"] !== undefined).map((item) => item.attrs?.["data-day"]);
    expect(days).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"]);
    expect(words(dashboard)).toContain("Open day");
  });

  it("renders the approved Due soon and Hot inbox rail from canonical dashboard data", () => {
    vi.clearAllMocks();
    const dashboard = renderDashboard(state("timeline"), handlers);
    expect(findAll(dashboard, (item) => item.attrs?.class === "timeline-layout")).toHaveLength(1);
    const rail = findAll(dashboard, (item) => item.attrs?.class === "timeline-rail")[0];
    expect(rail).toBeDefined();
    expect(words(rail!)).toContain("At a glance");
    expect(words(rail!)).toContain("Due soon · 3");
    expect(words(rail!)).toContain("Hot inbox 1");
    expect(findAll(rail!, (item) => item.attrs?.["data-due-item"] !== undefined).map((item) => item.attrs?.["data-due-item"])).toEqual(["a", "b", "discussion"]);
    const completionControls = findAll(rail!, (item) => item.tag === "input" && item.attrs?.["aria-label"]?.startsWith("Mark ") === true);
    expect(completionControls).toHaveLength(3);
    completionControls[0]?.on?.change?.(new Event("change"));
    expect(handlers.onToggleCompletion).toHaveBeenCalledWith("a");
    const discussionControls = findAll(rail!, (item) => item.tag === "input" && (item.attrs?.["aria-label"] === "Posted my response" || item.attrs?.["aria-label"] === "Replied to two classmates"));
    expect(discussionControls).toHaveLength(2);
    discussionControls[0]?.on?.change?.(new Event("change"));
    discussionControls[1]?.on?.change?.(new Event("change"));
    expect(handlers.onToggleDiscussion).toHaveBeenNthCalledWith(1, "discussion", "post");
    expect(handlers.onToggleDiscussion).toHaveBeenNthCalledWith(2, "discussion", "replies");

    const messageControls = findAll(rail!, (item) => item.attrs?.["data-conversation-id"] === "message");
    expect(messageControls).toHaveLength(1);
    messageControls[0]?.on?.click?.(new Event("click"));
    expect(handlers.onSelectConversation).toHaveBeenCalledWith("message");
    expect(handlers.onNavigate).toHaveBeenCalledWith("inbox");
  });

  it("keeps multiple same-day assignments in their course lane", () => {
    const dashboard = renderDashboard(state("timeline"), handlers);
    const firstDay = findAll(dashboard, (item) => item.attrs?.["data-day"] === "2026-09-20")[0];
    const lane = firstDay === undefined ? undefined : findAll(firstDay, (item) => item.attrs?.["data-course-lane"] === "IT530")[0];
    expect(lane).toBeDefined();
    expect(lane === undefined ? [] : findAll(lane, (item) => (item.attrs?.class ?? "").includes("event-card"))).toHaveLength(2);
  });

  it("shows a real duration to the next deadline", () => {
    expect(countdownText(NOW, "2026-09-21T23:59:00-04:00")).toBe("1d 11h");
    expect(words(renderDashboard(state("timeline"), handlers))).toContain("8h 0m");
  });

  it("keeps Inbox read-only while allowing local selection", () => {
    const dashboard = renderDashboard(state("inbox"), handlers);
    expect(words(dashboard)).toContain("Read-only Canvas conversations");
    expect(findAll(dashboard, (item) => typeof item.text === "string" && /reply|archive|delete/i.test(item.text))).toHaveLength(0);
    expect(findAll(dashboard, (item) => item.attrs?.class?.includes("message-row") ?? false)).toHaveLength(1);
  });

  it("renders honest grade summaries and graded-only filtering", () => {
    const dashboard = renderDashboard(state("grades"), handlers);
    expect(words(dashboard)).toContain("Graded points are not a final course grade.");
    expect(words(dashboard)).toContain("18 / 20");
    expect(words(dashboard)).toContain("canvas");
    expect(words(dashboard)).toContain("1 of 2 listed items graded · 1 awaiting");
    expect(words(dashboard)).toContain("Projects");
    expect(words(dashboard)).toContain("60%");
    expect(words(dashboard)).toContain("Graded work");
    expect(words(dashboard)).toContain("90%");
    expect(words(dashboard)).toContain("Whole-course progress");
    expect(words(dashboard)).toContain("36%");
    expect(words(dashboard)).toContain("Projects · 60%");
    expect(findAll(dashboard, (item) => item.attrs?.class === "grade-summary-card")).toHaveLength(3);
    expect(findAll(dashboard, (item) => item.attrs?.class === "grade-groups-card")).toHaveLength(0);
    expect(findAll(dashboard, (item) => item.attrs?.class === "grade-summary-groups")).toHaveLength(3);
    expect(findAll(dashboard, (item) => item.attrs?.class === "grade-summary-card__grade").map((item) => words(item).trim())).toEqual(["90% Graded work", "Unknown No numeric score", "Unknown No numeric score"]);
    expect(words(dashboard)).not.toContain("Unknown 0%");
    expect(findAll(dashboard, (item) => item.attrs?.["aria-pressed"] === "true")).toHaveLength(2);
    expect(findAll(dashboard, (item) => item.tag === "table")).toHaveLength(1);
    const gradedOnly = renderDashboard({ ...state("grades"), gradeMode: "graded" }, handlers);
    expect(words(gradedOnly)).not.toContain("Reading");
    const letterGrade = { ...DATA.events[1]!, grade: "Pass", source: "manual" } as const;
    const withLetterGrade = renderDashboard({ ...state("grades"), gradeMode: "graded", data: { ...DATA, events: [DATA.events[0]!, letterGrade] } }, handlers);
    expect(words(withLetterGrade)).toContain("Reading");
    expect(words(withLetterGrade)).toContain("Pass");
  });

  it("shows direct completion and discussion checklist controls on timeline cards", () => {
    const dashboard = renderDashboard(state("timeline"), handlers);
    const timelineCards = findAll(dashboard, (item) => item.attrs?.class?.includes("event-card") === true);
    expect(timelineCards.flatMap((card) => findAll(card, (item) => item.tag === "input" && item.attrs?.["aria-label"] === "Done"))).toHaveLength(3);
    expect(timelineCards.flatMap((card) => findAll(card, (item) => item.tag === "input" && item.attrs?.["aria-label"] === "Posted my response"))).toHaveLength(1);
    expect(timelineCards.flatMap((card) => findAll(card, (item) => item.tag === "input" && item.attrs?.["aria-label"] === "Replied to two classmates"))).toHaveLength(1);
    const discussionCard = timelineCards.find((card) => card.attrs?.class?.includes("discussion-card") === true);
    expect(discussionCard).toBeDefined();
    expect(words(discussionCard!).replace(/\s+/g, " ")).toContain("Discussion requirements Main post Complete your original response Replies Respond to 2 classmates Overall assignment Done");
    expect(findAll(discussionCard!, (item) => item.attrs?.["data-discussion-step"] !== undefined).map((item) => item.attrs?.["data-discussion-step"])).toEqual(["post", "replies"]);
    expect(words(renderDashboard(state("inbox"), handlers))).toContain("Full thread body");
  });

  it("surfaces a specific local save recovery message", () => {
    const dashboard = renderDashboard({ ...state("timeline"), failedDiscussionIds: new Set(["discussion"]), mutationError: { id: "discussion", message: "This discussion changed elsewhere. Latest state reloaded; try again." } }, handlers);
    expect(words(dashboard)).toContain("This discussion changed elsewhere. Latest state reloaded; try again.");
  });

  it("only renders supplied local resource links", () => {
    const dashboard = renderDashboard(state("library"), handlers);
    const links = findAll(dashboard, (item) => item.tag === "a" && item.attrs?.class === "more-action");
    expect(links.map((link) => link.attrs?.href)).toEqual(["/api/local/resources/safe"]);
    expect(words(dashboard)).toContain("No local copy");
  });

  it("renders partial refresh history without implying deletion", () => {
    const dashboard = renderDashboard(state("activity"), handlers);
    expect(words(dashboard)).toContain("PARTIAL");
    expect(words(dashboard)).toContain("No existing data was removed.");
  });

  it("keeps refresh progress and terminal feedback in the top bar on every page", () => {
    const running = renderDashboard({ ...state("timeline"), refreshState: "running" }, handlers);
    const runningNote = findAll(running, (item) => item.attrs?.class === "sync-note")[0];
    expect(runningNote?.text).toBe("Canvas refresh is in progress and may take under a minute");
    expect(runningNote?.attrs?.["aria-live"]).toBe("polite");
    const runningButtons = findAll(running, (item) => item.tag === "button" && item.attrs?.class?.includes("refresh-button") === true);
    expect(runningButtons).toHaveLength(1);
    expect(runningButtons[0]?.attrs).toMatchObject({ disabled: "", "aria-busy": "true" });
    expect(runningButtons[0]?.attrs?.class).toContain("refreshing");

    const complete = renderDashboard({ ...state("inbox"), refreshState: "complete" }, handlers);
    expect(findAll(complete, (item) => item.attrs?.class === "sync-note")[0]?.text).toBe("Refresh complete.");
    expect(findAll(complete, (item) => item.tag === "button" && item.attrs?.class?.includes("refresh-button") === true)[0]?.attrs).toMatchObject({ "aria-busy": "false" });

    const partial = renderDashboard({ ...state("timeline"), refreshState: "partial" }, handlers);
    expect(findAll(partial, (item) => item.attrs?.class === "sync-note")[0]?.text).toBe("Refresh incomplete. Existing data was kept.");
    expect(words(renderDashboard({ ...state("activity"), refreshState: "partial" }, handlers))).toContain("Refresh incomplete. Existing data was kept; this run may not include complete Canvas history.");

    const failed = renderDashboard({ ...state("grades"), refreshState: "failed" }, handlers);
    expect(findAll(failed, (item) => item.attrs?.class === "sync-note")[0]?.text).toBe("Refresh failed. Existing data was kept.");
  });

  it("uses truthful empty states instead of synthetic records", () => {
    const emptyData = { ...DATA, courses: [], events: [], resources: [], conversations: [], refreshes: [] };
    const dashboard = renderDashboard({ ...state("inbox"), data: emptyData }, handlers);
    expect(words(dashboard)).toContain("Canvas conversations have not been synced yet.");
    expect(words(dashboard)).not.toContain("Instructor");
  });
});
