import { describe, expect, it } from "vitest";
import { summarizeCanvasCaptureOutcome, summarizeCanvasRefreshScope } from "../../scripts/canvas-browser-refresh-scope.mjs";

const COURSE_ID = 17;
const ACCOUNT_LISTS = ["inbox", "inboxAll", "conversationsSent", "conversationsArchived"];
const COURSE_LISTS = [
  "course", "assignments", "assignmentGroups", "submissions",
  "pages", "modules", "announcements", "courseFiles",
];

interface SyntheticResource {
  endpoint: string;
  courseId: number | null;
  groupId?: number;
  contextCode?: string;
  items: Record<string, unknown>[];
}

interface SyntheticCoverage {
  endpoint: string;
  courseId: number | null;
  groupId?: number;
  contextCode?: string;
  status: string;
  reason?: string;
}

interface SyntheticSnapshot {
  activeCourses: { courseIds: number[] };
  resources: SyntheticResource[];
  coverage: SyntheticCoverage[];
}

interface SyntheticCaptureSnapshot extends SyntheticSnapshot {
  identity: { origin: string; userId: number; accountId: number };
}

function completeSnapshot(): SyntheticSnapshot {
  const resources: SyntheticResource[] = [
    ...COURSE_LISTS.map((endpoint) => ({
      endpoint, courseId: COURSE_ID, items: endpoint === "courseFiles" ? [{ id: 61 }] : [],
    })),
    ...ACCOUNT_LISTS.map((endpoint) => ({
      endpoint, courseId: null, items: endpoint === "inboxAll" ? [{ id: 91 }] : [],
    })),
    { endpoint: "conversation", courseId: null, items: [{ id: 91 }] },
    { endpoint: "fileBodies", courseId: null, items: [{
      fileId: 61, status: "archived", byteCount: 12, sha256: "a".repeat(64),
      contentType: "application/pdf", sourceAuthenticity: "unverified",
    }] },
  ];
  const coverage: SyntheticCoverage[] = [
    ...COURSE_LISTS.map((endpoint) => ({ endpoint, courseId: COURSE_ID, status: "complete" })),
    ...ACCOUNT_LISTS.map((endpoint) => ({ endpoint, courseId: null, status: "complete" })),
    { endpoint: "conversation", courseId: null, status: "complete" },
    { endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" },
  ];
  return { activeCourses: { courseIds: [COURSE_ID] }, resources, coverage };
}

describe("Canvas daily refresh scope", () => {
  it("accepts structurally valid archived file receipts and rejects missing, damaged, or failed receipts", () => {
    expect(summarizeCanvasRefreshScope(completeSnapshot())).toEqual({ requiredGapCount: 0, omissionCount: 0 });

    const missing = completeSnapshot();
    missing.resources.find((row) => row.endpoint === "fileBodies")!.items = [];
    expect(summarizeCanvasRefreshScope(missing)).toEqual({ requiredGapCount: 1, omissionCount: 0 });

    const damaged = completeSnapshot();
    damaged.resources.find((row) => row.endpoint === "fileBodies")!.items[0]!.sha256 = "damaged";
    expect(summarizeCanvasRefreshScope(damaged)).toEqual({ requiredGapCount: 1, omissionCount: 0 });

    const failed = completeSnapshot();
    failed.resources.find((row) => row.endpoint === "fileBodies")!.items[0] = {
      fileId: 61, status: "gap", reason: "HELPER_DOWNLOAD_REQUEST_FAILED",
    };
    expect(summarizeCanvasRefreshScope(failed)).toEqual({ requiredGapCount: 1, omissionCount: 0 });
  });

  it("separates the immutable partial archive marker from complete daily coverage", () => {
    const snapshot = completeSnapshot();
    snapshot.coverage.push({ endpoint: "calendar", courseId: COURSE_ID, status: "gap", reason: "unsupported" });
    snapshot.coverage.push({ endpoint: "calendarEvents", courseId: null, status: "incomplete", reason: "pagination-budget" });
    expect(summarizeCanvasRefreshScope(snapshot)).toEqual({ requiredGapCount: 0, omissionCount: 0 });
  });

  it("treats explicit locked child content as omitted, while list access failure blocks readiness", () => {
    const locked = completeSnapshot();
    locked.coverage.push({ endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "locked" });
    expect(summarizeCanvasRefreshScope(locked)).toEqual({ requiredGapCount: 0, omissionCount: 1 });

    const optionalDetail = completeSnapshot();
    optionalDetail.coverage.push(
      { endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "not-found" },
      { endpoint: "moduleItems", courseId: COURSE_ID, status: "gap", reason: "forbidden-optional" },
    );
    expect(summarizeCanvasRefreshScope(optionalDetail)).toEqual({ requiredGapCount: 0, omissionCount: 2 });

    const expectedInboxDetail = completeSnapshot();
    expectedInboxDetail.coverage.push({ endpoint: "conversation", courseId: null, status: "gap", reason: "not-found" });
    expect(summarizeCanvasRefreshScope(expectedInboxDetail).requiredGapCount).toBeGreaterThan(0);

    const unavailableList = completeSnapshot();
    unavailableList.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    unavailableList.coverage.find((row) => row.endpoint === "pages")!.reason = "forbidden-optional";
    unavailableList.resources = unavailableList.resources.filter((row) => row.endpoint !== "pages");
    expect(summarizeCanvasRefreshScope(unavailableList)).toEqual({ requiredGapCount: 0, omissionCount: 1 });
  });

  it("classifies locked, unpublished, and not-applicable records as visible omissions", () => {
    const snapshot = completeSnapshot();
    snapshot.coverage.push(
      { endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "locked" },
      { endpoint: "quiz", courseId: COURSE_ID, status: "gap", reason: "unpublished" },
      { endpoint: "submission", courseId: COURSE_ID, status: "gap", reason: "not-applicable" },
    );
    expect(summarizeCanvasRefreshScope(snapshot)).toEqual({ requiredGapCount: 0, omissionCount: 3 });
  });

  it("treats not-found pages and their children as omissions, while failed parents keep children as gaps", () => {
    const unavailablePages = completeSnapshot();
    unavailablePages.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    unavailablePages.coverage.find((row) => row.endpoint === "pages")!.reason = "not-found";
    unavailablePages.resources = unavailablePages.resources.filter((row) => row.endpoint !== "pages");
    unavailablePages.coverage.push({
      endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "parent-unavailable",
    });
    expect(summarizeCanvasRefreshScope(unavailablePages)).toEqual({ requiredGapCount: 0, omissionCount: 2 });

    const failedPages = completeSnapshot();
    failedPages.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    failedPages.coverage.find((row) => row.endpoint === "pages")!.reason = "request-failed";
    failedPages.resources = failedPages.resources.filter((row) => row.endpoint !== "pages");
    failedPages.coverage.push({
      endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "parent-unavailable",
    });
    expect(summarizeCanvasRefreshScope(failedPages)).toEqual({ requiredGapCount: 2, omissionCount: 0 });

    const ambiguousParent = completeSnapshot();
    ambiguousParent.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    ambiguousParent.coverage.find((row) => row.endpoint === "pages")!.reason = "not-found";
    ambiguousParent.coverage.push({
      endpoint: "pages", courseId: COURSE_ID, status: "gap", reason: "request-failed",
    }, {
      endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "parent-unavailable",
    });
    ambiguousParent.resources = ambiguousParent.resources.filter((row) => row.endpoint !== "pages");
    expect(summarizeCanvasRefreshScope(ambiguousParent)).toEqual({ requiredGapCount: 2, omissionCount: 1 });

    const contradictoryList = completeSnapshot();
    contradictoryList.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    contradictoryList.coverage.find((row) => row.endpoint === "pages")!.reason = "not-found";
    expect(summarizeCanvasRefreshScope(contradictoryList)).toEqual({ requiredGapCount: 1, omissionCount: 0 });
  });

  it("counts locked file receipts only when they belong to an active course file", () => {
    const activeLocked = completeSnapshot();
    activeLocked.resources.find((row) => row.endpoint === "fileBodies")!.items[0] = {
      fileId: 61, status: "gap", reason: "locked",
    };
    expect(summarizeCanvasRefreshScope(activeLocked)).toEqual({ requiredGapCount: 0, omissionCount: 1 });

    const archivedLocked = completeSnapshot();
    archivedLocked.resources.push({ endpoint: "courseFiles", courseId: 18, items: [{ id: 62 }] });
    archivedLocked.resources.find((row) => row.endpoint === "fileBodies")!.items.push({
      fileId: 62, status: "gap", reason: "locked",
    });
    expect(summarizeCanvasRefreshScope(archivedLocked)).toEqual({ requiredGapCount: 0, omissionCount: 0 });
  });

  it("rejects an unattempted daily detail caused by a request cap", () => {
    const snapshot = completeSnapshot();
    snapshot.coverage.push({ endpoint: "conversation", courseId: null, status: "gap", reason: "detail-budget" });
    expect(summarizeCanvasRefreshScope(snapshot).requiredGapCount).toBe(1);
  });

  it("counts only allowed non-required access failures as optional omission records", () => {
    const snapshot = completeSnapshot();
    snapshot.coverage.push(
      { endpoint: "discussionEntries", courseId: COURSE_ID, status: "gap", reason: "forbidden-optional" },
      { endpoint: "quiz", courseId: COURSE_ID, status: "gap", reason: "not-found" },
    );
    expect(summarizeCanvasRefreshScope(snapshot)).toEqual({ requiredGapCount: 0, omissionCount: 2 });
  });

  it("requires Inbox detail identifiers to match the listed conversations", () => {
    const snapshot = completeSnapshot();
    snapshot.resources.find((row) => row.endpoint === "conversation")!.items[0]!.id = 92;
    expect(summarizeCanvasRefreshScope(snapshot).requiredGapCount).toBeGreaterThan(0);
  });

  it("keeps active optional budget and network failures blocking while ignoring archived-course gaps", () => {
    const snapshot = completeSnapshot();
    snapshot.activeCourses.courseIds.push(18);
    snapshot.coverage.push(
      { endpoint: "discussionEntries", courseId: COURSE_ID, status: "incomplete", reason: "pagination-budget" },
      { endpoint: "quiz", courseId: COURSE_ID, status: "gap", reason: "request-failed" },
      { endpoint: "modules", courseId: 99, status: "gap", reason: "parent-unavailable" },
    );
    expect(summarizeCanvasRefreshScope(snapshot).requiredGapCount).toBe(10);
  });
});

function completeCaptureSnapshot(): SyntheticCaptureSnapshot {
  const snapshot = completeSnapshot() as unknown as SyntheticCaptureSnapshot;
  snapshot.identity = { origin: "https://canvas.example.edu", userId: 41, accountId: 42 };
  snapshot.resources.push(
    { endpoint: "profile", courseId: null, items: [{ id: 41 }] },
    { endpoint: "coursesActive", courseId: null, items: [{ id: COURSE_ID }] },
    { endpoint: "coursesCompleted", courseId: null, items: [] },
    { endpoint: "groups", courseId: null, items: [] },
    { endpoint: "personalFiles", courseId: null, items: [] },
    { endpoint: "personalFolders", courseId: null, items: [] },
    ...["courseTabs", "discussions", "quizzes", "folders"].map((endpoint) => ({
      endpoint, courseId: COURSE_ID, items: [],
    })),
    ...["user_41", "account_42"].map((contextCode) => ({
      endpoint: "calendarEvents", courseId: null, contextCode, items: [],
    })),
    { endpoint: "calendarEvents", courseId: COURSE_ID, contextCode: `course_${COURSE_ID}`, items: [] },
  );
  snapshot.coverage.push(
    ...["profile", "coursesActive", "coursesCompleted", "groups", "personalFiles", "personalFolders"]
      .map((endpoint) => ({ endpoint, courseId: null, status: "complete" })),
    ...["courseTabs", "discussions", "quizzes", "folders"].map((endpoint) => ({
      endpoint, courseId: COURSE_ID, status: "complete",
    })),
    ...["user_41", "account_42"].map((contextCode) => ({
      endpoint: "calendarEvents", courseId: null, contextCode, status: "complete",
    })),
    { endpoint: "calendarEvents", courseId: COURSE_ID, contextCode: `course_${COURSE_ID}`, status: "complete" },
  );
  snapshot.coverage = snapshot.coverage.filter((row: SyntheticCoverage) => row.endpoint !== "fileBodies");
  snapshot.resources.find((row: SyntheticResource) => row.endpoint === "fileBodies")!.items = [{
    fileId: 61, status: "staged", expectedSize: 12, byteCount: 12, sha256: "a".repeat(64),
    contentType: "application/pdf", stagedFile: "b".repeat(32) + ".blob", sourceAuthenticity: "unverified",
  }];
  return snapshot;
}

describe("Canvas capture completion outcome", () => {
  it("accepts a staged capture with verified endpoint and calendar coverage", () => {
    const outcome = summarizeCanvasCaptureOutcome(completeCaptureSnapshot());
    expect(outcome).toMatchObject({
      requiredGapCount: 0, failureGapCount: 0, omissionCount: 0,
      fileBodiesIncomplete: false, personalFileBodyFailureCount: 0,
    });
  });

  it("keeps one locked detail as an omission beside another captured page", () => {
    const snapshot = completeCaptureSnapshot();
    snapshot.resources.push({ endpoint: "page", courseId: COURSE_ID, items: [{ page_id: 1 }] });
    snapshot.coverage.push(
      { endpoint: "page", courseId: COURSE_ID, status: "complete" },
      { endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "locked" },
    );
    expect(summarizeCanvasCaptureOutcome(snapshot)).toMatchObject({
      requiredGapCount: 0, failureGapCount: 0, omissionCount: 1, fileBodiesIncomplete: false,
    });
  });

  it("accepts confirmed disabled course lists and omits their unattempted children", () => {
    const snapshot = completeCaptureSnapshot();
    snapshot.coverage.find((row: SyntheticCoverage) => row.endpoint === "courseFiles")!.status = "gap";
    snapshot.coverage.find((row: SyntheticCoverage) => row.endpoint === "courseFiles")!.reason = "forbidden-optional";
    snapshot.resources = snapshot.resources.filter((row: SyntheticResource) => row.endpoint !== "courseFiles");
    snapshot.coverage = snapshot.coverage.filter((row: SyntheticCoverage) => row.endpoint !== "fileBodies");
    snapshot.resources = snapshot.resources.filter((row: SyntheticResource) => row.endpoint !== "fileBodies");
    snapshot.coverage.push({ endpoint: "file", courseId: COURSE_ID, status: "gap", reason: "parent-unavailable" });
    expect(summarizeCanvasCaptureOutcome(snapshot)).toMatchObject({
      requiredGapCount: 0, failureGapCount: 0, omissionCount: 2, fileBodiesIncomplete: false,
    });
  });

  it("accepts one confirmed missing Inbox detail only with exact row and ID accounting", () => {
    const omittedConversation = completeCaptureSnapshot();
    omittedConversation.resources = omittedConversation.resources.filter((row) => row.endpoint !== "conversation");
    omittedConversation.coverage.find((row) => row.endpoint === "conversation")!.status = "gap";
    omittedConversation.coverage.find((row) => row.endpoint === "conversation")!.reason = "not-found";
    expect(summarizeCanvasRefreshScope(omittedConversation)).toEqual({ requiredGapCount: 0, omissionCount: 1 });
    expect(summarizeCanvasCaptureOutcome(omittedConversation)).toMatchObject({
      requiredGapCount: 0, failureGapCount: 0, omissionCount: 1, fileBodiesIncomplete: false,
    });

    const ambiguousConversation = structuredClone(omittedConversation);
    ambiguousConversation.coverage.push({ endpoint: "conversation", courseId: null, status: "complete" });
    expect(summarizeCanvasRefreshScope(ambiguousConversation).requiredGapCount).toBeGreaterThan(0);
  });

  it("keeps request failures, pagination limits, unattempted bodies, and personal MIME failures partial", () => {
    for (const row of [
      { endpoint: "calendarEvents", courseId: null, contextCode: "user_41", status: "gap", reason: "request-failed" },
      { endpoint: "calendarEvents", courseId: null, contextCode: "user_41", status: "incomplete", reason: "pagination-budget" },
      { endpoint: "calendarEvents", courseId: null, contextCode: "user_41", status: "incomplete", reason: "capture-budget" },
      { endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" },
    ]) {
      const snapshot = completeCaptureSnapshot();
      const target = snapshot.coverage.find((candidate: SyntheticCoverage) => candidate.endpoint === row.endpoint
        && candidate.contextCode === row.contextCode);
      if (target) Object.assign(target, row);
      else snapshot.coverage.push(row);
      expect(summarizeCanvasCaptureOutcome(snapshot).failureGapCount).toBeGreaterThan(0);
    }

    const personalFile = completeCaptureSnapshot();
    personalFile.resources.find((row: SyntheticResource) => row.endpoint === "personalFiles")!.items = [{ id: 77 }];
    personalFile.resources.find((row: SyntheticResource) => row.endpoint === "fileBodies")!.items.push({
      fileId: 77, status: "gap", reason: "HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH",
    });
    personalFile.coverage.push({
      endpoint: "fileBodies", courseId: null, status: "gap", reason: "request-failed",
    });
    const outcome = summarizeCanvasCaptureOutcome(personalFile);
    expect(outcome.fileBodiesIncomplete).toBe(true);
    expect(outcome.personalFileBodyFailureCount).toBe(1);
    expect(outcome.failureGapCount).toBe(1);
  });

  it.each(["not-applicable", "empty"])("counts a %s body as omitted and a dangerous MIME mismatch as failure", (reason) => {
    const benign = completeCaptureSnapshot();
    benign.resources.find((row: SyntheticResource) => row.endpoint === "fileBodies")!.items[0] = {
      fileId: 61, status: "gap", reason,
    };
    if (reason === "empty") {
      benign.resources.find((row: SyntheticResource) => row.endpoint === "courseFiles")!.items[0] = { id: 61, size: 0 };
      benign.coverage.push({ endpoint: "fileBodies", courseId: null, status: "gap", reason });
    }
    expect(summarizeCanvasCaptureOutcome(benign)).toMatchObject({
      failureGapCount: 0, omissionCount: 1, fileBodiesIncomplete: false,
    });

    const dangerous = completeCaptureSnapshot();
    dangerous.resources.find((row: SyntheticResource) => row.endpoint === "fileBodies")!.items[0] = {
      fileId: 61, status: "gap", reason: "HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH",
    };
    dangerous.coverage.push({ endpoint: "fileBodies", courseId: null, status: "gap", reason: "request-failed" });
    expect(summarizeCanvasCaptureOutcome(dangerous)).toMatchObject({
      failureGapCount: 1, fileBodiesIncomplete: true,
    });
  });
});
