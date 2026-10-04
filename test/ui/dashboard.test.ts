import { describe, expect, it, vi } from "vitest";
import { dashboardEventKind, parseDashboard } from "../../src/ui/app";
import { countdownText, formatAssignmentCopyText, gradeProgress, renderDashboard, type DashboardEvent, type DashboardHandlers, type DashboardState } from "../../src/ui/pages/dashboard";
import { DASHBOARD_ROUTES } from "../../src/ui/routes";
import { DATA, DATA_FOLDER, handlers, NOW, state } from "./desktop-test-fixtures";
import { findAll, words } from "./descriptor-test-helpers";
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
    const labels = findAll(dashboard, (item) => item.attrs?.class === "lane-label");
    expect(labels.map((label) => label.children?.find((child) => child.tag === "b")?.text)).toEqual(["Security", "Data", "Policy"]);
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

  it("keeps the next assignment identity in the timeline rail instead of repeating it in the hero", () => {
    const dashboard = renderDashboard(state("timeline"), handlers);
    const hero = findAll(dashboard, (item) => item.attrs?.class === "hero")[0];
    const rail = findAll(dashboard, (item) => item.attrs?.class === "timeline-rail")[0];
    expect(findAll(hero!, (item) => item.attrs?.class === "next-deadline")).toHaveLength(0);
    expect(words(hero!)).not.toContain("Next deadline");
    expect(words(rail!)).toContain("At a glance");
    expect(findAll(rail!, (item) => item.attrs?.["data-due-item"] !== undefined).map((item) => item.attrs?.["data-due-item"])).toContain("a");
  });

  it("keeps multiple same-day assignments in their course lane", () => {
    const dashboard = renderDashboard(state("timeline"), handlers);
    const firstDay = findAll(dashboard, (item) => item.attrs?.["data-day"] === "2026-09-20")[0];
    const lane = firstDay === undefined ? undefined : findAll(firstDay, (item) => item.attrs?.["data-course-lane"] === "IT530")[0];
    expect(lane).toBeDefined();
    expect(lane === undefined ? [] : findAll(lane, (item) => (item.attrs?.class ?? "").includes("event-card"))).toHaveLength(2);
  });

  it("assumes 11:59 PM for date-only due work while class and unknown times stay honest", () => {
    const sunday: DashboardEvent = { id: "sunday", courseId: "530", courseCode: "IT530", kind: "deadline", title: "Sunday assignment", startsAt: "2026-09-27", completed: false };
    const timed: DashboardEvent = { id: "timed", courseId: "530", courseCode: "IT530", kind: "deadline", title: "Timed memo", startsAt: "2026-09-25T20:15:00-04:00", completed: false };
    const dateOnlyClass: DashboardEvent = { id: "date-only-class", courseId: "540", courseCode: "IT540", kind: "class", title: "Date-only class", startsAt: "2026-09-28", completed: false };
    const unknownEndClass: DashboardEvent = { id: "unknown-end-class", courseId: "540", courseCode: "IT540", kind: "class", title: "Open-ended class", startsAt: "2026-09-29T18:00:00-04:00", endsAt: "not-a-timestamp", completed: false };
    const now = Date.parse("2026-09-25T12:00:00-04:00");
    const data = { ...DATA, events: [sunday, timed, dateOnlyClass, unknownEndClass] };
    const dashboard = renderDashboard({ ...state("timeline"), now, data }, handlers);
    const saturday = findAll(dashboard, (item) => item.attrs?.["data-day"] === "2026-09-26")[0];
    const sundaySlot = findAll(dashboard, (item) => item.attrs?.["data-day"] === "2026-09-27")[0];
    expect(findAll(saturday!, (item) => item.attrs?.class?.includes("event-card") === true)).toHaveLength(0);
    const card = findAll(sundaySlot!, (item) => item.attrs?.class?.includes("event-card") === true)[0]!;
    const timeElement = findAll(card, (item) => item.attrs?.class === "event-time")[0]!;
    expect(words(card)).toContain("11:59 PM");
    expect(words(card)).not.toContain("Time not specified");
    expect(words(card)).not.toMatch(/8:\d\d\s*PM/);
    expect(timeElement.attrs?.datetime).toBe("2026-09-27");
    expect(timeElement.attrs?.title).toBe("No time supplied; 11:59 PM assumed.");
    const timedCard = findAll(findAll(dashboard, (item) => item.attrs?.["data-day"] === "2026-09-25")[0]!, (item) => item.attrs?.class?.includes("event-card") === true)[0]!;
    expect(words(timedCard)).toContain("8:15 PM");
    expect(words(timedCard)).not.toContain("11:59 PM");
    const classCard = findAll(findAll(dashboard, (item) => item.attrs?.["data-day"] === "2026-09-28")[0]!, (item) => item.attrs?.class?.includes("event-card") === true)[0]!;
    expect(words(classCard)).toContain("Time not specified");
    expect(words(classCard)).not.toContain("11:59 PM");
    const unknownCard = findAll(findAll(dashboard, (item) => item.attrs?.["data-day"] === "2026-09-29")[0]!, (item) => item.attrs?.class?.includes("event-card") === true)[0]!;
    expect(words(unknownCard)).toContain("6:00 PM");
    expect(words(unknownCard)).toContain("Time unknown");
    expect(words(unknownCard)).not.toContain("11:59 PM");
    expect(countdownText(now, sunday.startsAt)).toBe("Due in 2 days");
    expect(countdownText(Date.parse("2026-09-27T18:00:00-04:00"), sunday.startsAt)).toBe("Due today");
    expect(formatAssignmentCopyText(sunday)).toContain("Due date: Sep 27");
    expect(formatAssignmentCopyText(sunday)).not.toMatch(/8:\d\d\s*PM/);
    expect(words(findAll(dashboard, (item) => item.attrs?.["data-due-item"] === "sunday")[0]!)).toContain("Due in 2 days");
  });

  it("sorts date-only deadlines at 11:59 PM without inventing a class time", () => {
    const dateOnlyDeadline: DashboardEvent = { id: "date-only-deadline", courseId: "530", courseCode: "IT530", kind: "deadline", title: "Date-only deadline", startsAt: "2026-09-27", completed: false };
    const timedDeadline: DashboardEvent = { id: "timed-deadline", courseId: "530", courseCode: "IT530", kind: "deadline", title: "Timed deadline", startsAt: "2026-09-27T20:00:00-04:00", completed: false };
    const dateOnlyClass: DashboardEvent = { id: "date-only-class", courseId: "540", courseCode: "IT540", kind: "class", title: "Date-only class", startsAt: "2026-09-27", completed: false };
    const dashboard = renderDashboard({
      ...state("timeline"),
      now: Date.parse("2026-09-27T12:00:00-04:00"),
      data: { ...DATA, events: [dateOnlyDeadline, dateOnlyClass, timedDeadline] },
    }, handlers);

    const rail = findAll(dashboard, (item) => item.attrs?.class === "timeline-rail")[0]!;
    expect(findAll(rail, (item) => item.attrs?.["data-due-item"] !== undefined).map((item) => item.attrs?.["data-due-item"]))
      .toEqual(["timed-deadline", "date-only-deadline"]);
    const deadlineCard = findAll(dashboard, (item) => item.attrs?.class?.includes("event-card") === true && words(item).includes("Date-only deadline"))[0]!;
    expect(words(deadlineCard)).toContain("11:59 PM");
    const classCard = findAll(dashboard, (item) => item.attrs?.class?.includes("event-card") === true && words(item).includes("Date-only class"))[0]!;
    expect(words(classCard)).toContain("Time not specified");
    expect(words(classCard)).not.toContain("11:59 PM");
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
    const observations = findAll(dashboard, (item) => item.attrs?.class === "grade-honesty__details");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.tag).toBe("details");
    expect(observations[0]?.attrs?.open).toBeUndefined();
    expect(words(observations[0]!)).toContain("About grade observations");
    expect(words(observations[0]!)).toContain("A local observation is the selected value until you change or remove it; Canvas score and grade remain visible alongside it. Progress indicators use Canvas points only, and coverage and unknown group data stay visible.");
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

  it("keeps Timeline details visibility and disclosure state together when expanded and collapsed", () => {
    vi.clearAllMocks();
    const collapsed = renderDashboard(state("timeline"), handlers);
    const collapsedControl = findAll(collapsed, (item) => item.attrs?.class === "event-expand")[0]!;
    const detailsId = collapsedControl.attrs?.["aria-controls"];
    const collapsedDetails = findAll(collapsed, (item) => item.attrs?.id === detailsId)[0]!;
    expect(collapsedControl.attrs?.["aria-expanded"]).toBe("false");
    expect(collapsedDetails.attrs?.hidden).toBe("");
    collapsedControl.on?.click?.(new Event("click"));
    expect(handlers.onToggleEvent).toHaveBeenCalledWith("a");

    const expanded = renderDashboard({ ...state("timeline"), expandedEventIds: new Set(["a"]) }, handlers);
    const expandedControl = findAll(expanded, (item) => item.attrs?.class === "event-expand")[0]!;
    const expandedDetails = findAll(expanded, (item) => item.attrs?.id === expandedControl.attrs?.["aria-controls"])[0]!;
    expect(expandedControl.attrs?.["aria-expanded"]).toBe("true");
    expect(expandedControl.text).toBe("Hide details");
    expect(expandedDetails.attrs?.hidden).toBeUndefined();
    expandedControl.on?.click?.(new Event("click"));
    expect(handlers.onToggleEvent).toHaveBeenLastCalledWith("a");
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

  it("classes complete, partial, and failed Activity statuses distinctly", () => {
    const refreshes = ["complete", "partial", "failed"] as const;
    const dashboard = renderDashboard({
      ...state("activity"),
      data: {
        ...DATA,
        refreshes: refreshes.map((status) => ({ id: `${status}-run`, startedAt: NOW, status, summary: `${status} synthetic run`, added: 0, changed: 0, removed: 0, changes: [] })),
      },
    }, handlers);
    const statuses = findAll(dashboard, (item) => item.attrs?.class?.startsWith("refresh-status") === true);
    expect(statuses.filter((item) => item.text === "complete").every((item) => item.attrs?.class === "refresh-status")).toBe(true);
    expect(statuses.filter((item) => item.text === "partial").every((item) => item.attrs?.class === "refresh-status partial")).toBe(true);
    expect(statuses.filter((item) => item.text === "failed").every((item) => item.attrs?.class === "refresh-status failed")).toBe(true);
  });

  it("keeps refresh feedback global and course colors secondary", () => {
    const activity = renderDashboard({ ...state("activity"), refreshState: "partial", refreshDetail: "Refresh incomplete. Existing data was kept." }, handlers);
    expect(findAll(activity, (item) => item.attrs?.class?.includes("refresh-button") === true)).toHaveLength(1);
    expect(findAll(activity, (item) => item.attrs?.class === "sync-note")).toHaveLength(1);
    expect(words(activity)).toContain("Refresh incomplete. Existing data was kept.");

    const courses = renderDashboard(state("courses"), handlers);
    expect(words(courses)).toContain("Course overview");
    expect(words(courses)).not.toContain("3 active");
    expect(words(courses)).toContain("3 courses");
    expect(findAll(courses, (item) => item.attrs?.["data-course-colors"] === "true")).toHaveLength(0);

    const more = renderDashboard(state("more"), handlers);
    const colors = findAll(more, (item) => item.attrs?.["data-course-colors"] === "true")[0];
    expect(colors?.tag).toBe("details");
    expect(colors?.attrs?.open).toBeUndefined();
    expect(words(colors!)).toContain("IT 530 · Security");
  });

  it("labels calendar activity by its deadline-only scope and preserves held counts", () => {
    const calendar = parseDashboard({ ...DATA, refreshes: [{ id: "calendar-run", source: "calendar", startedAt: NOW, finishedAt: NOW, status: "partial", summary: "Calendar deadlines only · 0 added · 0 updated · 2 held", added: 0, changed: 0, removed: 0, held: 2, changes: [{ kind: "notice", title: "Calendar items held", detail: "2 changes were held for review." }] }] });
    const calendarActivity = { ...state("activity"), desktop: { ...state("activity").desktop!, refreshAvailable: false, icalRefreshAvailable: true }, data: calendar };
    const dashboard = renderDashboard(calendarActivity, handlers);
    expect(words(dashboard)).toContain("Calendar refresh ·");
    expect(words(dashboard)).toContain("Calendar refresh updates deadlines only. Grades, Inbox, and library items keep the prior Canvas capture.");
    expect(words(dashboard)).toContain("2 Held");
    expect(words(dashboard)).not.toContain("this run may not include complete Canvas history");
    expect(findAll(dashboard, (item) => Boolean(item.attrs?.class?.includes("refresh-button")))).toHaveLength(1);

    const reopened = renderDashboard({ ...state("timeline"), desktop: { ...state("timeline").desktop!, refreshAvailable: false, icalRefreshAvailable: true }, data: calendar }, handlers);
    expect(findAll(reopened, (item) => item.attrs?.class === "sync-note")[0]?.text).toContain("Calendar deadlines only");
    expect(findAll(reopened, (item) => Boolean(item.attrs?.class?.includes("refresh-button")))[0]?.attrs?.title).toContain("Calendar deadlines only");
    expect(findAll(reopened, (item) => Boolean(item.attrs?.class?.includes("refresh-button")))[0]?.text).toBe("Refresh calendar");
    const canvas = renderDashboard({ ...state("timeline"), desktop: { ...state("timeline").desktop!, refreshAvailable: true, icalRefreshAvailable: false }, data: { ...DATA, refreshAvailable: true } }, handlers);
    expect(findAll(canvas, (item) => Boolean(item.attrs?.class?.includes("refresh-button")))[0]?.text).toBe("Refresh");
    const canvasActivity = renderDashboard({ ...state("activity"), desktop: { ...state("activity").desktop!, refreshAvailable: true, icalRefreshAvailable: false }, data: { ...DATA, refreshAvailable: true } }, handlers);
    expect(findAll(canvasActivity, (item) => Boolean(item.attrs?.class?.includes("refresh-button")))).toHaveLength(1);
    expect(findAll(canvasActivity, (item) => Boolean(item.attrs?.class?.includes("refresh-button")))[0]?.text).toBe("Refresh");
    const failed = parseDashboard({ refreshes: [{ id: "failed-calendar", startedAt: NOW, source: "calendar", status: "failed" }, { id: "failed-inbox", startedAt: NOW, source: "inbox", status: "failed" }] });
    expect(failed.refreshes.map((refresh) => refresh.summary)).toEqual([
      "Calendar refresh failed; prior deadlines were kept.",
      "Inbox update failed; existing messages were kept.",
    ]);
  });

  it("keeps Canvas freshness status visible across every dashboard page", () => {
    const data = parseDashboard({ ...DATA, sourceStatus: { state: "not_synced", label: "Desktop app store", detail: "Canvas capture unverified", coursework: "not_synced", inbox: "not_synced", library: "not_synced", browserFreshness: { current: false, reason: "capture-unverified", runId: null, observedAt: null, sections: [] } } });
    expect(data.sourceStatus).toMatchObject({ coursework: "not_synced", inbox: "not_synced", library: "not_synced", browserFreshness: { current: false } });
    for (const route of DASHBOARD_ROUTES) {
      const dashboard = renderDashboard({ ...state(route.page), data }, handlers);
      const notice = findAll(dashboard, (item) => item.attrs?.["data-source-freshness"] === "stale")[0];
      expect(words(notice!)).toContain("Canvas coursework and grades, Inbox, library items may be stale or incomplete.");
      expect(words(notice!)).toContain("independent calendar and personal records remain");
    }
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
    const activityPartial = renderDashboard({ ...state("activity"), refreshState: "partial" }, handlers);
    expect(findAll(activityPartial, (item) => item.attrs?.class === "sync-note")[0]?.text).toBe("Refresh incomplete. Existing data was kept.");

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
