import { Channel, invoke } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardEventKind, parseDashboard, renderDesktopSetup, resolveNativeMutationConflict, type DesktopSetupHandlers, type DesktopSetupState } from "../../src/ui/app";
import type { ElementDescriptor } from "../../src/ui/dom";
import { countdownText, formatAssignmentCopyText, gradeProgress, renderDashboard, type DashboardData, type DashboardEvent, type DashboardHandlers, type DashboardState } from "../../src/ui/pages/dashboard";
import { DASHBOARD_ROUTES } from "../../src/ui/routes";
import { projectDashboardDocuments } from "../../src/shared/dashboard-projection";
import { createNativeTransport, DesktopCommandError, nativeProjectionOptions, parseDocumentBundle, type CanvasRefreshProgress, type DesktopStoreStatus, type DryRunReport, type ImportProgress } from "../../src/ui/transport";
import { desktopRecoveryPanel } from "../../src/ui/components/recovery-panel";

function findAll(descriptor: ElementDescriptor, predicate: (item: ElementDescriptor) => boolean): ElementDescriptor[] {
  return [...(predicate(descriptor) ? [descriptor] : []), ...(descriptor.children ?? []).flatMap((child) => findAll(child, predicate))];
}
function words(descriptor: ElementDescriptor): string { return [descriptor.text ?? "", ...(descriptor.children ?? []).map(words)].join(" "); }

const NOW = Date.parse("2026-09-20T12:00:00-04:00");
const DATA: DashboardData = {
  version: "a".repeat(64),
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
  pendingSourceLinks: [],
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
  onNavigate: vi.fn(), onEventMode: vi.fn(), onCourseFilter: vi.fn(), onGradeCourseFilter: vi.fn(), onGradeMode: vi.fn(), onResourceFilter: vi.fn(), onToggleEvent: vi.fn(), onToggleCompletion: vi.fn(), onToggleDiscussion: vi.fn(), onEditManualGrade: vi.fn(), onManualGradeDraft: vi.fn(), onSaveManualGrade: vi.fn(), onCancelManualGrade: vi.fn(), onSelectConversation: vi.fn(), onSelectRefresh: vi.fn(), onRefresh: vi.fn(), onCopyAssignment: vi.fn(),
};
function state(page: DashboardState["page"]): DashboardState {
  return { page, loading: false, data: DATA, now: NOW, eventMode: "all", courseFilter: "all", gradeCourseFilter: "all", gradeMode: "all", resourceFilter: "all", expandedEventIds: new Set(), pendingCompletionIds: new Set(), failedCompletionIds: new Set(), pendingDiscussionIds: new Set(), failedDiscussionIds: new Set(), pendingManualGradeIds: new Set(), failedManualGradeIds: new Set(), selectedConversationId: "message", selectedRefreshId: "refresh", refreshState: "idle", desktop: { storeState: "preview", dataFolder: "~/Library/Application Support/com.zerodelta.duegood", importedAt: null } };
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

  it("renders a bounded pending-link comparison and requires an explicit decision", () => {
    const link = {
      id: JSON.stringify(["marymount", "530", "canvas", "8421", null]), localId: "canvas-8421", courseId: "530",
      reference: { source: "canvas", id: "8421", institution: "marymount", course: "530" },
      fields: { title: '"Threat Modeling Brief"', at: '"2026-10-09T08:00:00Z"', points: "25" },
      observedAt: "2026-10-01T12:00:00Z", candidateIds: ["a"], reason: "ambiguous-match" as const,
    };
    const pendingHandlers: DashboardHandlers = { ...handlers, onSelectPendingLink: vi.fn(), onOpenPendingLinkDecision: vi.fn(), onCancelPendingLinkDecision: vi.fn(), onResolvePendingLink: vi.fn() };
    const review = renderDashboard({ ...state("more"), data: { ...DATA, pendingSourceLinks: [link] } }, pendingHandlers);
    expect(words(review)).toContain("Canvas and iCal records remain separate until you decide.");
    expect(words(review)).toContain("Due Good ID a");
    expect(words(review)).toContain("Source reference 8421");
    expect(words(review)).toContain('"Threat Modeling Brief"');
    const confirm = findAll(review, (item) => item.tag === "button" && item.text === "Confirm link")[0];
    confirm?.on?.click?.(new Event("click"));
    expect(pendingHandlers.onOpenPendingLinkDecision).toHaveBeenCalledWith("confirm");

    const decision = renderDashboard({ ...state("more"), data: { ...DATA, pendingSourceLinks: [link] }, pendingLinkDecision: "confirm" }, pendingHandlers);
    expect(findAll(decision, (item) => item.attrs?.role === "dialog")).toHaveLength(1);
    expect(words(decision)).toContain("The existing Due Good item keeps its immutable ID, Done state, notes, grades, and unknown fields.");
    const cancel = findAll(decision, (item) => item.tag === "button" && item.text === "Cancel")[0];
    cancel?.on?.click?.(new Event("click"));
    expect(pendingHandlers.onCancelPendingLinkDecision).toHaveBeenCalledTimes(1);
  });

  it("shows older source holds while disabling decisions until a fresh observation", () => {
    const link = {
      id: JSON.stringify(["marymount", "530", "ical", "old-uid", null]), localId: "", courseId: "530",
      reference: { source: "ical", id: "old-uid", institution: "marymount", course: "530" },
      fields: {}, candidateIds: ["a"], reason: "ambiguous-match" as const, needsRefresh: true as const,
    };
    expect(parseDashboard({ pendingSourceLinks: [{ ...link, course: link.courseId }] }).pendingSourceLinks).toMatchObject([{ needsRefresh: true }]);
    const review = renderDashboard({ ...state("more"), data: { ...DATA, pendingSourceLinks: [link] } }, handlers);
    expect(words(review)).toContain("needs a fresh coursework import before it can be reviewed");
    expect(findAll(review, (item) => item.tag === "button" && (item.text === "Confirm link" || item.text === "Keep distinct")).every((item) => item.attrs?.disabled === "")).toBe(true);
  });

  it("requires an explicit local choice for a multi-candidate link while keeping a distinct decision available", () => {
    const link = {
      id: JSON.stringify(["marymount", "530", "canvas", "8422", null]), localId: "canvas-8422", courseId: "530",
      reference: { source: "canvas", id: "8422", institution: "marymount", course: "530" }, fields: { title: '"Source observation"' },
      candidateIds: ["a", "b"], reason: "ambiguous-match" as const,
    };
    const pendingHandlers: DashboardHandlers = { ...handlers, onSelectPendingLinkCandidate: vi.fn(), onOpenPendingLinkDecision: vi.fn() };
    const unselected = renderDashboard({ ...state("more"), data: { ...DATA, pendingSourceLinks: [link] } }, pendingHandlers);
    expect(words(unselected)).toContain("Choose the Due Good item to compare before confirming");
    expect(findAll(unselected, (item) => item.text === "Confirm link")[0]?.attrs?.disabled).toBe("");
    findAll(unselected, (item) => item.tag === "button" && item.text === "Keep distinct")[0]?.on?.click?.(new Event("click"));
    expect(pendingHandlers.onOpenPendingLinkDecision).toHaveBeenCalledWith("reject");
    findAll(unselected, (item) => item.tag === "input" && item.attrs?.value === "b")[0]?.on?.change?.(new Event("change"));
    expect(pendingHandlers.onSelectPendingLinkCandidate).toHaveBeenCalledWith("b");

    const selected = renderDashboard({ ...state("more"), selectedPendingLinkCandidateId: "b", data: { ...DATA, pendingSourceLinks: [link] } }, pendingHandlers);
    expect(words(selected)).toContain("Reading");
    expect(findAll(selected, (item) => item.text === "Confirm link")[0]?.attrs?.disabled).toBeUndefined();
    findAll(selected, (item) => item.tag === "button" && item.text === "Confirm link")[0]?.on?.click?.(new Event("click"));
    expect(pendingHandlers.onOpenPendingLinkDecision).toHaveBeenCalledWith("confirm");

    expect(parseDashboard({ pendingSourceLinks: [{ ...link, course: link.courseId, candidateIds: [] }] }).pendingSourceLinks).toHaveLength(1);
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
    expect(words(dashboard)).toContain("Canvas grade");
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
    const gradeCards = findAll(dashboard, (item) => item.attrs?.class === "grade-summary-card");
    expect(gradeCards.every((card) => card.children?.at(-1)?.attrs?.class === "grade-summary-groups")).toBe(true);
    expect(findAll(dashboard, (item) => item.attrs?.["aria-pressed"] === "true")).toHaveLength(2);
    expect(findAll(dashboard, (item) => item.tag === "table")).toHaveLength(1);
    const gradedOnly = renderDashboard({ ...state("grades"), gradeMode: "graded" }, handlers);
    expect(words(gradedOnly)).not.toContain("Reading");
    const letterGrade = { ...DATA.events[1]!, grade: "Pass", source: "manual" } as const;
    const withLetterGrade = renderDashboard({ ...state("grades"), gradeMode: "graded", data: { ...DATA, events: [DATA.events[0]!, letterGrade] } }, handlers);
    expect(words(withLetterGrade)).toContain("Reading");
    expect(words(withLetterGrade)).toContain("Pass");
  });

  it("renders local grade editing with selected-value provenance and cancelable keyboard controls", () => {
    vi.clearAllMocks();
    const local = { ...DATA.events[0]!, manualGrade: "A-", manualGradeVersion: 1 as const };
    const dashboard = renderDashboard({ ...state("grades"), data: { ...DATA, events: [local, ...DATA.events.slice(1)] } }, handlers);
    expect(words(dashboard)).toContain("Canvas score");
    expect(words(dashboard)).toContain("Canvas grade");
    expect(words(dashboard)).toContain("Selected value");
    expect(words(dashboard)).toContain("Local observation · v1");
    const pdfDashboard = renderDashboard({ ...state("grades"), data: { ...DATA, events: [{ ...local, manualGradeSource: "pdf" }, ...DATA.events.slice(1)] } }, handlers);
    expect(words(pdfDashboard)).toContain("User-confirmed PDF · v1");
    const edit = findAll(dashboard, (item) => item.tag === "button" && item.attrs?.["aria-label"] === "Edit local grade for Lab report")[0];
    edit?.on?.click?.(new Event("click"));
    expect(handlers.onEditManualGrade).toHaveBeenCalledWith("a");

    const editing = renderDashboard({ ...state("grades"), editingManualGrade: { id: "a", draft: "A-" } }, handlers);
    const input = findAll(editing, (item) => item.tag === "input" && item.attrs?.["aria-label"] === "Local grade for Lab report")[0];
    input?.on?.input?.({ currentTarget: { value: "A" } } as unknown as Event);
    expect(handlers.onManualGradeDraft).toHaveBeenCalledWith("A");
    input?.on?.keydown?.({ key: "Escape", preventDefault: vi.fn() } as unknown as Event);
    expect(handlers.onCancelManualGrade).toHaveBeenCalledOnce();
    const form = findAll(editing, (item) => item.tag === "form" && item.attrs?.class === "grade-editor")[0];
    form?.on?.submit?.({ preventDefault: vi.fn() } as unknown as Event);
    expect(handlers.onSaveManualGrade).toHaveBeenCalledWith("a");
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
    expect(runningNote?.text).toBe("Canvas refresh is in progress");
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

  it("formats assignment copy text with clear labels, omitting unknown points or submission states", () => {
    const textA = formatAssignmentCopyText({
      ...DATA.events[0]!,
      submissionState: "known_submitted",
      detail: "Write a summary of network protocols.",
    });
    expect(textA).toBe([
      "Course code: IT 530",
      "Assignment title: Lab report",
      "Due date/time: Sep 20, 8:00 PM",
      "Points: 20",
      "Canvas submission status: Submitted",
      "Due Good completion status: Not completed",
      "Assignment details: Write a summary of network protocols.",
    ].join("\n"));

    const textB = formatAssignmentCopyText({
      id: "no-pts",
      courseId: "530",
      courseCode: "IT 530",
      kind: "deadline",
      title: "Reading",
      startsAt: "2026-09-20T23:59:00-04:00",
      completed: false,
      points: null,
      submissionState: "unknown",
      detail: "",
    });
    expect(textB).toBe([
      "Course code: IT 530",
      "Assignment title: Reading",
      "Due date/time: Sep 20, 11:59 PM",
      "Due Good completion status: Not completed",
      "Assignment details: No additional details were supplied.",
    ].join("\n"));

    const textDiscussion = formatAssignmentCopyText(DATA.events[3]!);
    expect(textDiscussion).toBe([
      "Course code: IT 570",
      "Assignment title: Discussion board",
      "Due date/time: Sep 25, 6:00 PM",
      "Due Good completion status: Not completed",
      "Main post: Completed",
      "Replies to classmates: Not completed",
      "Assignment details: No additional details were supplied.",
    ].join("\n"));
  });

  it("renders the Copy assignment action on deadline and discussion cards and rail items, excluding class meetings", () => {
    vi.clearAllMocks();
    const dashboard = renderDashboard(state("timeline"), handlers);
    const timelineCards = findAll(dashboard, (item) => item.attrs?.class?.includes("event-card") === true);
    expect(timelineCards).toHaveLength(4);
    const copyButtonsOnCards = timelineCards.flatMap((card) => findAll(card, (item) => item.tag === "button" && item.attrs?.class?.includes("copy-button") === true));
    expect(copyButtonsOnCards).toHaveLength(3);

    const classCard = timelineCards.find((card) => card.attrs?.class?.includes("class-meeting") === true);
    expect(classCard).toBeDefined();
    expect(findAll(classCard!, (item) => item.tag === "button" && item.attrs?.class?.includes("copy-button") === true)).toHaveLength(0);

    const rail = findAll(dashboard, (item) => item.attrs?.class === "timeline-rail")[0];
    expect(rail).toBeDefined();
    const railCopyButtons = findAll(rail!, (item) => item.tag === "button" && item.attrs?.class?.includes("copy-button") === true);
    expect(railCopyButtons).toHaveLength(3);

    copyButtonsOnCards[0]?.on?.click?.(new Event("click"));
    expect(handlers.onCopyAssignment).toHaveBeenCalledWith("a");

    railCopyButtons[0]?.on?.click?.(new Event("click"));
    expect(handlers.onCopyAssignment).toHaveBeenCalledWith("a");
  });

  it("renders accessible feedback on copied or failed buttons without duplicate live content", () => {
    const copiedState: DashboardState = {
      ...state("timeline"),
      copyFeedback: { a: "copied", b: "failed" },
    };
    const dashboard = renderDashboard(copiedState, handlers);
    const cardA = findAll(dashboard, (item) => item.attrs?.class?.includes("event-card") === true && words(item).includes("Lab report"))[0];
    const buttonA = findAll(cardA!, (item) => item.attrs?.class?.includes("copy-button") === true)[0];
    expect(buttonA?.attrs?.class).toContain("copied");
    expect(buttonA?.text).toBe("Copied");
    expect(buttonA?.attrs?.["aria-live"]).toBe("polite");
    expect(findAll(buttonA!, (item) => item.attrs?.role === "status")).toHaveLength(0);

    const cardB = findAll(dashboard, (item) => item.attrs?.class?.includes("event-card") === true && words(item).includes("Reading"))[0];
    const buttonB = findAll(cardB!, (item) => item.attrs?.class?.includes("copy-button") === true)[0];
    expect(buttonB?.attrs?.class).toContain("failed");
    expect(buttonB?.text).toBe("Could not copy");
    expect(buttonB?.attrs?.["aria-live"]).toBe("polite");
    expect(findAll(buttonB!, (item) => item.attrs?.role === "status")).toHaveLength(0);
  });

  it("shows pending native copy and changing snapshot byte counts accessibly", () => {
    const pendingCopy = renderDashboard({ ...state("timeline"), copyFeedback: { a: "pending" } }, handlers);
    const card = findAll(pendingCopy, (item) => item.attrs?.class?.includes("event-card") === true && words(item).includes("Lab report"))[0];
    const copy = findAll(card!, (item) => item.attrs?.class?.includes("copy-button") === true)[0];
    expect(copy?.text).toBe("Copying…");
    expect(copy?.attrs).toMatchObject({ "aria-live": "polite", "aria-busy": "true", disabled: "" });

    const saving = renderDashboard({ ...state("timeline"), desktop: { storeState: "preview", dataFolder: DATA_FOLDER, importedAt: null, snapshotInProgress: true, snapshotProgress: { filesDone: 3, bytesDone: 2400 } } }, handlers);
    expect(findAll(saving, (item) => item.attrs?.role === "status").map(words)).toContain("Saving today’s private recovery snapshot… 3 files · 2400 bytes copied.");
  });
});

// --- Desktop (Tauri) mode ---------------------------------------------------------------------

interface MockInternals { runCallback(id: number, data: unknown): void }
const DATA_FOLDER = "~/Library/Application Support/com.zerodelta.duegood";
const DIGEST = "a".repeat(64);

function withMockWindow(): MockInternals {
  // `@tauri-apps/api` reads `window.__TAURI_INTERNALS__`; the UI suite runs in plain Node.
  (globalThis as { window?: unknown }).window = globalThis;
  return new Proxy({} as MockInternals, { get: (_target, key) => (globalThis as unknown as { __TAURI_INTERNALS__: Record<string | symbol, unknown> }).__TAURI_INTERNALS__[key] });
}

function nativeTransport() {
  return createNativeTransport((command, args) => invoke(command, args), (onMessage) => new Channel<unknown>(onMessage));
}

function storeStatus(overrides: Partial<DesktopStoreStatus> = {}): DesktopStoreStatus {
  return { availability: "ready", state: "empty", dataFolder: DATA_FOLDER, legacyRootSelected: false, importedAt: null, files: null, bytes: null, refreshAvailable: false, icalRefreshAvailable: false, canvasRefreshEnabled: false, snapshotInProgress: false, snapshotProgress: null, problem: null, ...overrides };
}

function dryRun(overrides: Partial<DryRunReport> = {}): DryRunReport {
  return { caps: { totalBytes: 1024 }, inventory: { courseworkDocuments: 1, courseFolders: 2, materialFiles: 3, files: 9, directories: 4, bytes: 4096 }, refusals: {}, unsupportedTypes: {}, legacyLockPresent: false, wouldImport: true, ...overrides };
}

function nativeBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storeState: "preview",
    coursework: {
      text: JSON.stringify({ generated: "2026-09-20T12:00:00Z", courses: [{ key: "syn-101", code: "SYN 101", title: "Synthetic Studies", color: "#3a6ea5", folder: "syn-101" }], items: [{ id: "syn-101-essay-1", course: "syn-101", kind: "assignment", title: "Essay draft", at: "2026-09-25T23:59" }] }),
      version: DIGEST,
    },
    refreshHistory: null,
    conversations: null,
    profile: JSON.stringify({ name: "Synthetic Learner", avatar: { path: "canvas-avatar.png", contentType: "image/png" } }),
    avatar: { sizeBytes: 69, head: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    courseExports: {
      "syn-101": {
        files: JSON.stringify([{ id: 1, display_name: "Syllabus", updated_at: "2026-09-01T00:00:00Z" }, { id: 2, display_name: "Handout", updated_at: "2026-09-02T00:00:00Z" }]),
        pages: null, modules: null, announcements: null,
        downloadManifest: JSON.stringify([{ id: 1, status: "downloaded", filename: "syllabus.pdf" }]),
      },
    },
    ...overrides,
  };
}

const setupHandlers = (): DesktopSetupHandlers => ({ onChoose: vi.fn(), onRecheck: vi.fn(), onImport: vi.fn(), onCancel: vi.fn() });
function setup(overrides: Partial<DesktopSetupState> = {}): DesktopSetupState {
  return { status: storeStatus(), replacePreview: false, step: "idle", ...overrides };
}
function buttons(descriptor: ElementDescriptor): ElementDescriptor[] { return findAll(descriptor, (item) => item.tag === "button"); }
function button(descriptor: ElementDescriptor, label: string): ElementDescriptor | undefined { return buttons(descriptor).find((item) => item.text === label); }

describe("desktop transport and first-run screen", () => {
  afterEach(() => {
    const scope = globalThis as { window?: unknown; __TAURI_INTERNALS__?: unknown; __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown };
    if (scope.window === undefined) return;
    clearMocks();
    delete scope.__TAURI_INTERNALS__;
    delete scope.__TAURI_EVENT_PLUGIN_INTERNALS__;
    delete scope.window;
  });

  it("keeps DashboardData.version a string for both the digest and older numeric bodies", () => {
    expect(parseDashboard({ version: DIGEST }).version).toBe(DIGEST);
    expect(parseDashboard({ version: 7 }).version).toBe("7");
    expect(parseDashboard({ version: Number.NaN }).version).toBe("");
    expect(parseDashboard({}).version).toBe("");
  });

  it("calls only the fixed read commands through mocked Tauri IPC and never sends a path", async () => {
    withMockWindow();
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === "store_status") return storeStatus({ state: "preview", legacyRootSelected: true, importedAt: "2026-09-22T12:00:00Z", files: 9, bytes: 4096 });
      if (command === "choose_legacy_root") return { selected: true };
      if (command === "dry_run_import") return dryRun();
      if (command === "read_dashboard_documents") return nativeBundle();
      throw new Error(`unexpected command ${command}`);
    });
    const transport = nativeTransport();
    await expect(transport.storeStatus()).resolves.toMatchObject({ availability: "ready", state: "preview", dataFolder: DATA_FOLDER, refreshAvailable: false });
    await expect(transport.chooseLegacyRoot()).resolves.toBe(true);
    await expect(transport.dryRunImport()).resolves.toEqual(dryRun());
    const body = await transport.loadDashboardBody(false);
    expect(calls.map(([command]) => command)).toEqual(["store_status", "choose_legacy_root", "dry_run_import", "read_dashboard_documents"]);
    for (const [, args] of calls) expect(args).toEqual({});

    expect(body.version).toBe(DIGEST);
    expect(body.refreshAvailable).toBe(false);
    expect(body.sourceStatus.label).toBe("Desktop preview copy");
    expect(body.profile).toEqual({ displayName: "Synthetic Learner" });
    expect(body.resources.map((item) => [item.title, item.openPath, item.savedLocally])).toEqual([["Handout", null, undefined], ["Syllabus", null, true]]);
    const parsed = parseDashboard(body);
    expect(parsed.version).toBe(DIGEST);
    expect(parsed.resources.find((item) => item.title === "Syllabus")).toMatchObject({ savedLocally: true });
    expect(parsed.resources.every((item) => item.localUrl === undefined)).toBe(true);
    const library = renderDashboard({ ...state("library"), data: parsed, desktop: { storeState: "preview", dataFolder: DATA_FOLDER, importedAt: null } }, handlers);
    expect(words(library)).toContain("Saved locally");
    expect(findAll(library, (item) => item.tag === "a" && item.attrs?.class === "more-action")).toHaveLength(0);
  });

  it("validates native Canvas refresh status, owner setting, progress, and result over narrow IPC", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    let receiveProgress: ((message: unknown) => void) | undefined;
    const channel = { channel: "synthetic" };
    const progress: CanvasRefreshProgress[] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      if (command === "store_status") return storeStatus({ state: "authoritative", canvasRefreshEnabled: true, refreshAvailable: true });
      if (command === "set_canvas_refresh_enabled") return { canvasRefreshEnabled: args?.enabled === true, refreshAvailable: args?.enabled === true };
      if (command === "start_canvas_refresh") {
        receiveProgress?.({ phase: "fetch", completed: 2, total: null, bytesDone: 4096 });
        receiveProgress?.({ phase: "<private course name>", completed: 99, total: 100, bytesDone: 2 });
        return { status: "incomplete", updatedAt: "2026-09-23T12:00:00Z" };
      }
      throw new Error(`unexpected command ${command}`);
    }, (onMessage) => { receiveProgress = onMessage; return channel; });

    await expect(transport.storeStatus()).resolves.toMatchObject({ canvasRefreshEnabled: true, refreshAvailable: true });
    await expect(transport.setCanvasRefreshEnabled(false)).resolves.toEqual({ canvasRefreshEnabled: false, refreshAvailable: false });
    await expect(transport.startCanvasRefresh((event) => progress.push(event))).resolves.toEqual({ status: "incomplete", updatedAt: "2026-09-23T12:00:00Z" });
    expect(progress).toEqual([{ phase: "fetch", completed: 2, total: null, bytesDone: 4096 }]);
    expect(calls).toEqual([
      ["store_status", undefined],
      ["set_canvas_refresh_enabled", { enabled: false }],
      ["start_canvas_refresh", { onProgress: channel }],
    ]);
  });

  it("validates the native calendar refresh result and keeps calendar progress content-free", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    let receiveProgress: ((message: unknown) => void) | undefined;
    const phases: string[] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      if (command === "start_ical_refresh") {
        receiveProgress?.({ phase: "waiting-for-calendar" });
        receiveProgress?.({ phase: "private coursework title" });
        return { status: "complete", updatedAt: "2026-09-25T12:00:00Z", added: 2, updated: 1, held: 3, removed: 0 };
      }
      throw new Error(`unexpected ${command}`);
    }, (onMessage) => { receiveProgress = onMessage; return { channel: "calendar" }; });
    await expect(transport.startIcalRefresh((progress) => phases.push(progress.phase))).resolves.toMatchObject({ added: 2, updated: 1, held: 3, removed: 0 });
    expect(phases).toEqual(["waiting-for-calendar"]);
    expect(calls).toEqual([["start_ical_refresh", { onProgress: { channel: "calendar" } }]]);
  });

  it("validates native promotion, demotion, and frozen-export commands without accepting paths or confirmation shortcuts", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const channel = { channel: "transition-progress" };
    const progress: { filesDone: number; bytesDone: number }[] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      if (typeof args?.onProgress === "function") (args.onProgress as (event: unknown) => void)({ filesDone: 2, bytesDone: 4096 });
      if (command === "prepare_store_promotion") return { proofId: "proof-opaque", files: 4, bytes: 8192 };
      if (command === "confirm_store_promotion") return { state: "authoritative", files: 4, bytes: 8192 };
      if (command === "demote_store_for_rollback") return { state: "preview", recoveryFiles: 5, recoveryBytes: 9000 };
      if (command === "export_frozen_for_rollback") return { files: 7, bytes: 16_384, equal: true };
      throw new Error(`unexpected command ${command}`);
    }, (receive) => {
      // The injected channel is represented as a callable in this focused transport test.
      return Object.assign((event: unknown) => receive(event), channel);
    });

    const onProgress = (event: { filesDone: number; bytesDone: number }): void => { progress.push(event); };
    await expect(transport.prepareStorePromotion(onProgress)).resolves.toEqual({ proofId: "proof-opaque", files: 4, bytes: 8192 });
    await expect(transport.confirmStorePromotion("proof-opaque", onProgress)).resolves.toEqual({ state: "authoritative", files: 4, bytes: 8192 });
    await expect(transport.demoteStoreForRollback(onProgress)).resolves.toEqual({ state: "preview", recoveryFiles: 5, recoveryBytes: 9000 });
    await expect(transport.exportFrozenForRollback(onProgress)).resolves.toEqual({ files: 7, bytes: 16_384, equal: true });
    expect(calls).toEqual([
      ["prepare_store_promotion", { onProgress: expect.any(Function) }],
      ["confirm_store_promotion", { proofId: "proof-opaque", onProgress: expect.any(Function) }],
      ["demote_store_for_rollback", { onProgress: expect.any(Function) }],
      ["export_frozen_for_rollback", { onProgress: expect.any(Function) }],
    ]);
    expect(progress).toEqual(Array.from({ length: 4 }, () => ({ filesDone: 2, bytesDone: 4096 })));
    expect(calls.every(([, args]) => !Object.hasOwn(args ?? {}, "confirmed"))).toBe(true);

    const malformed = createNativeTransport(async (command) => command === "prepare_store_promotion"
      ? { proofId: "/private/legacy", files: 4, bytes: 8192 }
      : undefined, (receive) => Object.assign((event: unknown) => receive(event), channel));
    await expect(malformed.prepareStorePromotion(() => undefined)).rejects.toMatchObject({ code: "malformed-response" });
  });

  it("never claims the imported desktop copy is synced", () => {
    const inbox = (complete: boolean): string => JSON.stringify({ complete, generatedAt: "2026-09-20T12:05:00Z", conversations: [] });
    const project = (conversations: string | null, options = nativeProjectionOptions("preview")) => projectDashboardDocuments(parseDocumentBundle(nativeBundle({ conversations })), options);

    const imported = project(inbox(true));
    expect(imported.sourceStatus.detail).toContain("Inbox imported");
    expect(project(inbox(false)).sourceStatus.detail).toContain("Inbox partial");
    expect(project(null).sourceStatus.detail).toContain("Inbox not captured");
    for (const status of [imported, project(inbox(false)), project(null), project(inbox(true), nativeProjectionOptions("authoritative"))].map((body) => body.sourceStatus)) {
      expect(status.label).not.toMatch(/synced/i);
      expect(status.detail).not.toMatch(/synced/i);
    }
    const more = renderDashboard({ ...state("more"), data: parseDashboard(imported), desktop: { storeState: "preview", dataFolder: DATA_FOLDER, importedAt: null } }, handlers);
    expect(words(more)).toContain("Inbox imported");
    expect(words(more)).not.toMatch(/synced/i);
  });

  it("streams validated, content-free import progress through a mocked Tauri channel", async () => {
    const internals = withMockWindow();
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command !== "import_legacy_root") throw new Error(`unexpected command ${command}`);
      const channel = (args as { onProgress: Channel<unknown> }).onProgress;
      const send = (index: number, message: unknown): void => internals.runCallback(channel.id, { index, message });
      // Out of order on purpose: the channel restores order by index.
      send(1, { phase: "copying", filesDone: 1, filesTotal: 3, bytesDone: 10, bytesTotal: 30 });
      send(0, { phase: "scanning", filesDone: 0, filesTotal: 3, bytesDone: 0, bytesTotal: 30 });
      send(2, { phase: "copying", filesDone: 3, filesTotal: 3, bytesDone: 30, bytesTotal: 30, name: "never-surfaced.json" });
      send(3, { phase: "exploding", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
      send(4, { phase: "validating", filesDone: -1, filesTotal: 3, bytesDone: 30, bytesTotal: 30 });
      send(5, { phase: "complete", filesDone: 3, filesTotal: 3, bytesDone: 30, bytesTotal: 30 });
      internals.runCallback(channel.id, { index: 6, end: true });
      return { state: "preview", files: 3, bytes: 30, replacedPreview: true };
    });
    const events: ImportProgress[] = [];
    await expect(nativeTransport().importLegacyRoot(true, (event) => events.push(event))).resolves.toEqual({ state: "preview", files: 3, bytes: 30, replacedPreview: true });
    expect(events.map((event) => [event.phase, event.filesDone, event.bytesDone])).toEqual([["scanning", 0, 0], ["copying", 1, 10], ["copying", 3, 30], ["complete", 3, 30]]);
    for (const event of events) expect(Object.keys(event).sort()).toEqual(["bytesDone", "bytesTotal", "filesDone", "filesTotal", "phase"]);
    expect(JSON.stringify(events)).not.toContain("never-surfaced");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.[1])).toMatch(/^\{"replacePreview":true,"onProgress":"__CHANNEL__:\d+"\}$/);
  });

  it("maps structured command errors, including named refusal counts, and rejects malformed results", async () => {
    withMockWindow();
    let bundle: Record<string, unknown> = nativeBundle();
    let status: unknown = storeStatus();
    mockIPC((command) => {
      if (command === "import_legacy_root") throw { code: "refused", message: "The legacy folder cannot be imported as it is.", refusals: { escapingMaterialSymlinks: 1, malformedJson: 2 }, unsupportedTypes: { script: 1 } };
      if (command === "dry_run_import") throw "no legacy folder";
      if (command === "store_status") return status;
      if (command === "read_dashboard_documents") return bundle;
      if (command === "choose_legacy_root") return { selected: "yes" };
      throw new Error(`unexpected command ${command}`);
    });
    const transport = nativeTransport();
    const refused = await transport.importLegacyRoot(false, () => undefined).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DesktopCommandError);
    expect(refused).toMatchObject({ code: "refused", refusals: { escapingMaterialSymlinks: 1, malformedJson: 2 }, unsupportedTypes: { script: 1 } });
    await expect(transport.dryRunImport()).rejects.toMatchObject({ code: "ipc", message: "no legacy folder" });
    await expect(transport.chooseLegacyRoot()).rejects.toMatchObject({ code: "malformed-response" });

    status = { ...storeStatus(), canvasRefreshEnabled: "yes" };
    await expect(transport.storeStatus()).rejects.toMatchObject({ code: "malformed-response" });
    status = { ...storeStatus(), state: "syncing" };
    await expect(transport.storeStatus()).rejects.toMatchObject({ code: "malformed-response" });

    bundle = nativeBundle({ coursework: { text: "{}", version: "not-a-digest" } });
    await expect(transport.loadDashboardBody(false)).rejects.toMatchObject({ code: "malformed-response" });
    bundle = nativeBundle({ courseExports: { "../escape": { files: null, pages: null, modules: null, announcements: null, downloadManifest: null } } });
    await expect(transport.loadDashboardBody(false)).rejects.toMatchObject({ code: "malformed-response" });
    bundle = nativeBundle({ avatar: { sizeBytes: 69, head: new Array(17).fill(0) } });
    await expect(transport.loadDashboardBody(false)).rejects.toMatchObject({ code: "malformed-response" });
    bundle = nativeBundle({ coursework: { text: "{\"courses\": [", version: DIGEST } });
    await expect(transport.loadDashboardBody(false)).rejects.toMatchObject({ code: "invalid-coursework" });
  });

  it("renders the first-run screen with the fixed app-data folder, a legacy-folder picker, and the preview-copy label", () => {
    const actions = setupHandlers();
    const screen = renderDesktopSetup(setup(), actions);
    const text = words(screen);
    expect(text).toContain("Import existing coursework");
    expect(text).toContain(DATA_FOLDER);
    expect(text).toContain("It cannot be changed.");
    expect(text).toContain("Preview copy");
    expect(text).toContain("It does not follow later changes in the legacy local source. Personal progress edits stay in this copy.");
    expect(text).not.toMatch(/change storage location/i);
    expect(findAll(screen, (item) => item.attrs?.class === "preview-badge")).toHaveLength(1);
    const choose = button(screen, "Choose legacy folder…");
    expect(choose?.attrs?.disabled).toBeUndefined();
    choose?.on?.click?.(new Event("click"));
    expect(actions.onChoose).toHaveBeenCalledOnce();
    expect(button(screen, "Import as preview copy")?.attrs?.disabled).toBe("");
    expect(button(screen, "Check again")).toBeUndefined();
    expect(button(screen, "Keep current preview copy")).toBeUndefined();
  });

  it("shows dry-run counts and enables import only for an importable folder", () => {
    const actions = setupHandlers();
    const ready = renderDesktopSetup(setup({ status: storeStatus({ legacyRootSelected: true }), step: "ready", report: dryRun() }), actions);
    expect(words(ready)).toContain("Counts only; nothing was copied.");
    expect(words(ready)).toContain("Material files");
    const importButton = button(ready, "Import as preview copy");
    expect(importButton?.attrs?.disabled).toBeUndefined();
    importButton?.on?.click?.(new Event("click"));
    expect(actions.onImport).toHaveBeenCalledOnce();
    button(ready, "Check again")?.on?.click?.(new Event("click"));
    expect(actions.onRecheck).toHaveBeenCalledOnce();

    const refused = renderDesktopSetup(setup({ status: storeStatus({ legacyRootSelected: true }), step: "ready", report: dryRun({ wouldImport: false, legacyLockPresent: true, refusals: { escapingMaterialSymlinks: 2 }, unsupportedTypes: { script: 1 } }) }), actions);
    expect(button(refused, "Import as preview copy")?.attrs?.disabled).toBe("");
    const refusalRows = findAll(refused, (item) => item.attrs?.class === "setup-counts setup-refusals")[0];
    expect(words(refusalRows!).replace(/\s+/g, " ").trim()).toBe("Material links that leave the materials folder 2");
    expect(words(refused)).toContain("Nothing is dropped silently");
    expect(words(refused)).toContain("The legacy local source is being written right now. The import waits for that write to finish.");
    expect(words(refused)).toContain("script");
  });

  it("shows streamed import progress, errors with refusals, and the replace-preview variant", () => {
    const actions = setupHandlers();
    const importing = renderDesktopSetup(setup({ status: storeStatus({ legacyRootSelected: true }), step: "importing", report: dryRun(), progress: { phase: "copying", filesDone: 4, filesTotal: 9, bytesDone: 2048, bytesTotal: 4096 } }), actions);
    const bar = findAll(importing, (item) => item.tag === "progress")[0];
    expect(bar?.attrs).toMatchObject({ max: "9", value: "4" });
    expect(words(importing)).toContain("Copying files");
    expect(words(importing)).toContain("4 of 9 files · 2.0 KB of 4.0 KB");
    expect(buttons(importing).every((item) => item.attrs?.disabled === "")).toBe(true);

    const failed = renderDesktopSetup(setup({ status: storeStatus({ legacyRootSelected: true }), error: { message: "The legacy folder changed during the copy. Nothing was changed.", refusals: { malformedJson: 1 }, unsupportedTypes: {} } }), actions);
    const alert = findAll(failed, (item) => item.attrs?.role === "alert")[0];
    expect(words(alert!)).toContain("The legacy folder changed during the copy.");
    expect(words(alert!)).toContain("Malformed JSON documents");

    const replace = renderDesktopSetup(setup({ status: storeStatus({ state: "preview", legacyRootSelected: true }), replacePreview: true, step: "ready", report: dryRun() }), actions);
    expect(words(replace)).toContain("Replace the preview copy");
    expect(words(replace)).toContain("timestamped backup that is never deleted");
    expect(button(replace, "Archive and replace preview copy")?.attrs?.disabled).toBeUndefined();
    button(replace, "Keep current preview copy")?.on?.click?.(new Event("click"));
    expect(actions.onCancel).toHaveBeenCalledOnce();
  });

  it("renders the another-instance, unavailable, and recovery screens without any import control", () => {
    const actions = setupHandlers();
    const other = renderDesktopSetup(setup({ status: storeStatus({ availability: "another-instance", state: "unknown" }) }), actions);
    expect(words(other)).toContain("Due Good is already open");
    const unavailable = renderDesktopSetup(setup({ status: storeStatus({ availability: "unavailable", state: "unknown", problem: "The app data folder could not be created." }) }), actions);
    expect(words(unavailable)).toContain("The app data folder could not be created.");
    const damaged = renderDesktopSetup(setup({ status: storeStatus({ state: "damaged", problem: "The store manifest is invalid." }) }), actions);
    expect(words(damaged)).toContain("The app store needs recovery");
    expect(words(damaged)).toContain("nothing will be imported over it");
    for (const screen of [other, unavailable, damaged]) {
      expect(buttons(screen)).toHaveLength(0);
      expect(words(screen)).toContain(DATA_FOLDER);
    }
  });

  it("renders a writable preview dashboard with a truthful store card and a replace action", () => {
    const onReplacePreview = vi.fn();
    const desktop = { storeState: "preview" as const, dataFolder: DATA_FOLDER, importedAt: "2026-09-22T12:00:00Z" };
    const timeline = renderDashboard({ ...state("timeline"), desktop }, { ...handlers, onReplacePreview });
    const inputs = findAll(timeline, (item) => item.tag === "input" && item.attrs?.type === "checkbox");
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.some((item) => item.attrs?.disabled === undefined)).toBe(true);
    expect(findAll(timeline, (item) => item.attrs?.class === "complete-button").some((item) => item.attrs?.disabled === undefined)).toBe(true);
    expect(words(findAll(timeline, (item) => item.attrs?.class === "top-actions")[0]!)).toContain("Preview copy");
    expect(findAll(timeline, (item) => item.attrs?.class === "sync-note")[0]?.text).toMatch(/^Imported /);

    const more = renderDashboard({ ...state("more"), desktop }, { ...handlers, onReplacePreview });
    const card = findAll(more, (item) => item.attrs?.["data-desktop-store"] === "preview")[0];
    expect(words(card!)).toContain("It does not follow later source changes.");
    expect(words(card!)).toContain(DATA_FOLDER);
    expect(words(more)).not.toContain("remains the authoritative writable source");
    button(card!, "Replace preview copy…")?.on?.click?.(new Event("click"));
    expect(onReplacePreview).toHaveBeenCalledOnce();

    const authoritative = renderDashboard({ ...state("more"), desktop: { ...desktop, storeState: "authoritative" } }, handlers);
    expect(words(authoritative)).toContain("Import never replaces it.");
    expect(button(authoritative, "Replace preview copy…")).toBeUndefined();
    expect(words(findAll(renderDashboard({ ...state("timeline"), desktop: { ...desktop, storeState: "authoritative" } }, handlers), (item) => item.attrs?.class === "top-actions")[0]!)).not.toContain("Preview copy");

    const native = renderDashboard(state("timeline"), handlers);
    expect(findAll(native, (item) => item.tag === "input" && item.attrs?.type === "checkbox").some((item) => item.attrs?.disabled === undefined)).toBe(true);
  });

  it("shows the preview promotion review counts without exposing the opaque proof and separates both confirmations", () => {
    const onPreparePromotion = vi.fn();
    const onConfirmPromotion = vi.fn();
    const onCancelPromotion = vi.fn();
    const desktop = { storeState: "preview" as const, dataFolder: DATA_FOLDER, importedAt: "2026-09-22T12:00:00Z" };
    const idle = renderDashboard({ ...state("more"), desktop }, { ...handlers, onPreparePromotion, onConfirmPromotion, onCancelPromotion });
    const idleCard = findAll(idle, (item) => item.attrs?.["data-desktop-store"] === "preview")[0]!;
    button(idleCard, "Choose and compare backup…")?.on?.click?.(new Event("click"));
    expect(onPreparePromotion).toHaveBeenCalledOnce();

    const reviewed = renderDashboard({
      ...state("more"), desktop,
      storeTransition: { phase: "ready", proof: { proofId: "proof-opaque-test-only", files: 12, bytes: 4096 } },
    }, { ...handlers, onPreparePromotion, onConfirmPromotion, onCancelPromotion });
    const reviewCard = findAll(reviewed, (item) => item.attrs?.["data-desktop-store"] === "preview")[0]!;
    expect(words(reviewCard)).toContain("Exact comparison passed: 12 files · 4.0 KB");
    expect(words(reviewCard)).toContain("native dialog");
    expect(words(reviewCard)).not.toContain("proof-opaque-test-only");
    button(reviewCard, "Promote to authoritative store")?.on?.click?.(new Event("click"));
    expect(onConfirmPromotion).toHaveBeenCalledWith("proof-opaque-test-only");
    button(reviewCard, "Discard comparison")?.on?.click?.(new Event("click"));
    expect(onCancelPromotion).toHaveBeenCalledOnce();
  });

  it("offers native-confirmed demotion on authoritative stores and frozen rollback export in preview", () => {
    const onDemoteStore = vi.fn();
    const onExportFrozenRollback = vi.fn();
    const desktop = { storeState: "authoritative" as const, dataFolder: DATA_FOLDER, importedAt: null };
    const more = renderDashboard({ ...state("more"), desktop }, { ...handlers, onDemoteStore, onExportFrozenRollback });
    const card = findAll(more, (item) => item.attrs?.["data-desktop-store"] === "authoritative")[0]!;
    button(card, "Return app store to preview…")?.on?.click?.(new Event("click"));
    expect(onDemoteStore).toHaveBeenCalledOnce();
    expect(button(card, "Promote to authoritative store")).toBeUndefined();
    expect(button(card, "Export frozen rollback copy…")).toBeUndefined();
    const preview = renderDashboard({ ...state("more"), desktop: { ...desktop, storeState: "preview" } }, { ...handlers, onDemoteStore, onExportFrozenRollback });
    const previewCard = findAll(preview, (item) => item.attrs?.["data-desktop-store"] === "preview")[0]!;
    button(previewCard, "Export frozen rollback copy…")?.on?.click?.(new Event("click"));
    expect(onExportFrozenRollback).toHaveBeenCalledOnce();
    const busy = renderDashboard({ ...state("more"), desktop, storeTransition: { phase: "demoting" } }, { ...handlers, onDemoteStore, onExportFrozenRollback });
    const busyCard = findAll(busy, (item) => item.attrs?.["data-desktop-store"] === "authoritative")[0]!;
    expect(button(busyCard, "Returning to preview…")?.attrs?.disabled).toBe("");
    const progressing = renderDashboard({
      ...state("more"), desktop: { ...desktop, storeState: "preview" },
      storeTransition: { phase: "exporting", progress: { filesDone: 3, bytesDone: 2048 } },
    }, { ...handlers, onDemoteStore, onExportFrozenRollback });
    expect(findAll(progressing, (item) => item.attrs?.role === "status").map(words)).toContain("3 files · 2048 bytes processed.");
  });

  it("shows the native owner toggle separately from availability and renders native progress", () => {
    const onToggleCanvasRefresh = vi.fn();
    const desktop = { storeState: "authoritative" as const, dataFolder: DATA_FOLDER, importedAt: null, canvasRefreshEnabled: true, refreshAvailable: false };
    const unavailable = renderDashboard({ ...state("more"), desktop, data: { ...DATA, refreshAvailable: false } }, { ...handlers, onToggleCanvasRefresh });
    const toggle = findAll(unavailable, (item) => item.tag === "input" && item.attrs?.["aria-label"] === "Enable Canvas refresh")[0];
    expect(toggle?.attrs).toMatchObject({ checked: "" });
    expect(words(unavailable)).toContain("Canvas refresh is unavailable on this computer.");
    expect(findAll(unavailable, (item) => item.tag === "button" && item.attrs?.class?.includes("refresh-button") === true)).toHaveLength(0);
    toggle?.on?.change?.({ currentTarget: { checked: false } } as unknown as Event);
    expect(onToggleCanvasRefresh).toHaveBeenCalledWith(false);

    const running = renderDashboard({
      ...state("timeline"), desktop: { ...desktop, refreshAvailable: true }, data: { ...DATA, refreshAvailable: true }, refreshState: "running",
      refreshProgress: { phase: "fetch", completed: 2, total: 4, bytesDone: 4096 },
    }, handlers);
    expect(findAll(running, (item) => item.attrs?.class === "sync-note")[0]?.text).toBe("Canvas refresh · Reading Canvas data · 2 of 4 completed · 4096 bytes received");
    expect(findAll(running, (item) => item.tag === "button" && item.attrs?.class?.includes("refresh-button") === true)[0]?.attrs).toMatchObject({ disabled: "", "aria-busy": "true" });
    const calendar = renderDashboard({ ...state("timeline"), desktop: { ...desktop, icalRefreshAvailable: true }, data: { ...DATA, refreshAvailable: true }, refreshState: "running", refreshProgress: { phase: "waiting-for-calendar", completed: 0, total: null, bytesDone: null } }, handlers);
    expect(findAll(calendar, (item) => item.attrs?.class === "sync-note")[0]?.text).toBe("Calendar refresh · Waiting for calendar");
  });

  it("routes native mutations, avatar bytes, resource IDs, clipboard, and snapshots through narrow commands", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      if (command === "set_item_completion") return { completed: true, completedAt: NOW, discussionPostDone: false, discussionRepliesDone: false, version: DIGEST };
      if (command === "set_discussion_field") throw { code: "item-conflict", message: "Changed elsewhere", currentValue: true };
      if (command === "resolve_pending_source_link") return { version: DIGEST };
      if (command === "set_manual_grade") return { manualGrade: "A-", manualGradeVersion: 1, version: DIGEST };
      if (command === "read_avatar_bytes") return { contentType: "image/png", bytes: [137, 80, 78, 71] };
      if (command === "open_library_resource") return args?.id === "syn:file:2" ? "downloaded" : "opened";
      if (command === "copy_assignment_text" || command === "restore_snapshot") return null;
      if (command === "list_snapshots") return [{ id: "daily-20260923T120000Z-1234abcd", createdAt: "2026-09-23T12:00:00Z", kind: "daily" }];
      throw new Error(`unexpected ${command}`);
    }, () => ({}));
    await expect(transport.setCompletion("item-1", false, true)).resolves.toMatchObject({ completed: true });
    await expect(transport.setDiscussionField("item-1", "post", false, true)).rejects.toMatchObject({ code: "item-conflict", currentValue: true });
    await expect(transport.resolvePendingSourceLink("pending-1", "item-1", "confirm", DIGEST)).resolves.toEqual({ version: DIGEST });
    await expect(transport.setManualGrade("item-1", "A-", DIGEST)).resolves.toEqual({ manualGrade: "A-", manualGradeVersion: 1, version: DIGEST });
    await expect(transport.readAvatar()).resolves.toEqual({ contentType: "image/png", bytes: Uint8Array.from([137, 80, 78, 71]) });
    await expect(transport.openResource("syn:file:1")).resolves.toBe("opened");
    await expect(transport.openResource("syn:file:2")).resolves.toBe("downloaded");
    await transport.copyText("Synthetic assignment");
    await expect(transport.listSnapshots()).resolves.toHaveLength(1);
    await transport.restoreSnapshot("daily-20260923T120000Z-1234abcd");
    expect(calls).toEqual([
      ["set_item_completion", { itemId: "item-1", expected: false, value: true }],
      ["set_discussion_field", { itemId: "item-1", field: "post", expected: false, value: true }],
      ["resolve_pending_source_link", { pendingId: "pending-1", localItemId: "item-1", decision: "confirm", expectedVersion: DIGEST }],
      ["set_manual_grade", { itemId: "item-1", value: "A-", expectedVersion: DIGEST }],
      ["read_avatar_bytes", undefined],
      ["open_library_resource", { id: "syn:file:1" }],
      ["open_library_resource", { id: "syn:file:2" }],
      ["copy_assignment_text", { text: "Synthetic assignment" }],
      ["list_snapshots", undefined],
      ["restore_snapshot", { id: "daily-20260923T120000Z-1234abcd" }],
    ]);
  });

  it("reloads native documents before showing a per-item conflict notice", async () => {
    const reload = vi.fn(async () => true);
    await expect(resolveNativeMutationConflict(new DesktopCommandError("item-conflict", "Changed", {}, {}, true), reload, "item")).resolves.toEqual({ reloaded: true, message: "This item changed elsewhere. Latest state reloaded; try again." });
    expect(reload).toHaveBeenCalledOnce();
    await expect(resolveNativeMutationConflict(new DesktopCommandError("item-conflict", "Changed"), async () => false, "discussion")).resolves.toEqual({ reloaded: false, message: "This discussion changed elsewhere. Reload the page and try again." });
  });

  it("offers snapshots before the age-labeled legacy import and renders native resource actions", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    const onRestore = vi.fn();
    const recovery = desktopRecoveryPanel({ snapshots: [{ id: "new", kind: "daily", createdAt: "2026-09-23T11:00:00Z" }, { id: "older", kind: "pre-refresh", createdAt: "2026-09-21T11:00:00Z" }], importedAt: "2026-09-20T11:00:00Z", busy: false }, { onRestore, onExport: vi.fn() }, now);
    const labels = findAll(recovery, (item) => item.tag === "li").map(words);
    expect(labels[0]).toContain("Daily snapshot · today");
    expect(labels[1]).toContain("Before refresh · 2 days ago");
    expect(labels[2]).toContain("Legacy import · 3 days ago");
    button(recovery, "Restore snapshot")?.on?.click?.(new Event("click"));
    expect(onRestore).toHaveBeenCalledWith("new");
    const onOpenResource = vi.fn();
    const data = { ...DATA, resources: [{ id: "syn:file:1", courseId: "530", courseCode: "IT530", type: "File", title: "Synthetic PDF", savedLocally: true }] };
    const library = renderDashboard({ ...state("library"), data, desktop: { storeState: "preview", dataFolder: DATA_FOLDER, importedAt: null } }, { ...handlers, onOpenResource });
    button(library, "Open or save")?.on?.click?.(new Event("click"));
    expect(onOpenResource).toHaveBeenCalledWith("syn:file:1");
    const avatar = renderDashboard({ ...state("timeline"), data: { ...DATA, profile: { displayName: "Synthetic Learner", avatarPath: "blob:synthetic" } } }, handlers);
    expect(findAll(avatar, (item) => item.tag === "img")[0]?.attrs?.src).toBe("blob:synthetic");
  });

  it("keeps a preview dashboard visible when a daily snapshot fails and shows the warning", () => {
    const warning = "A daily snapshot could not be saved. Coursework remains available; check storage before relying on recovery.";
    const screen = renderDashboard({ ...state("timeline"), desktop: { storeState: "preview", dataFolder: DATA_FOLDER, importedAt: null, warning } }, handlers);
    expect(findAll(screen, (item) => item.attrs?.role === "alert").map(words)).toContain(warning);
    expect(findAll(screen, (item) => item.tag === "input" && item.attrs?.type === "checkbox").length).toBeGreaterThan(0);
  });
});
