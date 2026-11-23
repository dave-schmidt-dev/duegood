import { describe, expect, it } from "vitest";
import {
  summarizeCanvasCaptureOutcome,
  summarizeCanvasRefreshScope,
  validCanvasRefreshScopeSummary,
} from "../../scripts/canvas-browser-refresh-scope.mjs";

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
  it("strictly validates body count fields and bounds", () => {
    expect(validCanvasRefreshScopeSummary({
      requiredGapCount: 0, omissionCount: 1, bodyCount: 4, emptyBodyCount: 1,
    })).toBe(true);
    expect(validCanvasRefreshScopeSummary({
      requiredGapCount: 0, omissionCount: 1, bodyCount: 1, emptyBodyCount: 2,
    })).toBe(false);
    expect(validCanvasRefreshScopeSummary({
      requiredGapCount: 0, omissionCount: 1, bodyCount: 4, emptyBodyCount: 1, privateText: "x",
    })).toBe(false);
  });

  it("counts known body envelopes once and treats missing or failed bodies as coverage gaps", () => {
    const snapshot = completeCaptureSnapshot();
    snapshot.resources.find((row) => row.endpoint === "assignments")!.items = [
      { id: 31, _canvasBody: { html: "<p>Work</p>", text: "Work", empty: false } },
      { id: 32, _canvasBody: { html: "", text: "", empty: true } },
      { id: 33, _canvasBodyReason: "BODY_MISSING" },
      { id: 34, _canvasBodyReason: "BODY_SANITIZE_FAILED" },
    ];
    snapshot.resources.find((row) => row.endpoint === "pages")!.items = [
      { page_id: 51, _canvasBodyReason: "BODY_MISSING" },
    ];
    snapshot.resources.find((row) => row.endpoint === "quizzes")!.items = [{ id: 61, locked: true }];
    snapshot.coverage.push({ endpoint: "quiz", courseId: COURSE_ID, status: "gap", reason: "locked" });
    snapshot.resources.push(
      { endpoint: "page", courseId: COURSE_ID, items: [
        { page_id: 51, _canvasBody: { html: "<h2>Guide</h2>", text: "Guide", empty: false } },
        { page_id: 52, _canvasBodyReason: "BODY_MISSING" },
      ] },
      { endpoint: "quiz", courseId: COURSE_ID, items: [{ id: 62, _canvasBodyReason: "BODY_MISSING" }] },
    );

    const scope = summarizeCanvasRefreshScope(snapshot);
    expect(scope).toMatchObject({ requiredGapCount: 4, bodyCount: 3, emptyBodyCount: 1 });
    const outcome = summarizeCanvasCaptureOutcome(snapshot);
    expect(outcome).toMatchObject({
      failureGapCount: 4,
      bodyCount: 3,
      emptyBodyCount: 1,
      bodyFailureReason: "BODY_SANITIZE_FAILED",
    });
  });

  it("reports absent and malformed envelopes with content-free body reasons", () => {
    const missing = completeSnapshot();
    missing.resources.find((row) => row.endpoint === "assignments")!.items = [{ id: 71 }];
    expect(summarizeCanvasCaptureOutcome(missing)).toMatchObject({
      requiredGapCount: 1,
      bodyCount: 0,
      emptyBodyCount: 0,
      bodyFailureReason: "BODY_MISSING",
    });

    const failed = completeSnapshot();
    failed.resources.find((row) => row.endpoint === "assignments")!.items = [
      { id: 71, _canvasBody: { html: null, text: "", empty: true } },
    ];
    expect(summarizeCanvasCaptureOutcome(failed)).toMatchObject({
      requiredGapCount: 1,
      bodyCount: 0,
      emptyBodyCount: 0,
      bodyFailureReason: "BODY_SANITIZE_FAILED",
    });

    const unknownReason = completeCaptureSnapshot();
    unknownReason.resources.find((row) => row.endpoint === "assignments")!.items = [{
      id: 72,
      _canvasBodyReason: "unexpected",
      _canvasBody: { html: "<p>Work</p>", text: "Work", empty: false },
    }];
    expect(summarizeCanvasCaptureOutcome(unknownReason)).toMatchObject({
      requiredGapCount: 1, bodyCount: 0, bodyFailureReason: "BODY_SANITIZE_FAILED",
    });

    const oversized = completeCaptureSnapshot();
    oversized.resources.find((row) => row.endpoint === "assignments")!.items = [{
      id: 73,
      _canvasBody: { html: "é".repeat(262_145), text: "", empty: false },
    }];
    expect(summarizeCanvasCaptureOutcome(oversized)).toMatchObject({
      requiredGapCount: 1, bodyCount: 0, bodyFailureReason: "BODY_SANITIZE_FAILED",
    });

    const individuallyBounded = completeCaptureSnapshot();
    individuallyBounded.resources.find((row) => row.endpoint === "assignments")!.items = [{
      id: 74,
      _canvasBody: { html: "é".repeat(250_000), text: "é".repeat(30_000), empty: false },
    }];
    expect(summarizeCanvasCaptureOutcome(individuallyBounded)).toMatchObject({
      requiredGapCount: 0, bodyCount: 1, bodyFailureReason: null,
    });
  });

  it("counts listing bodies, honors only coverage-bound omissions, and keeps locked summaries out", () => {
    const availableListing = completeCaptureSnapshot();
    availableListing.resources.find((row) => row.endpoint === "pages")!.items = [
      { page_id: 73, _canvasBody: { html: "<p>Visible</p>", text: "Visible", empty: false } },
    ];
    availableListing.coverage.push({ endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "locked" });
    expect(summarizeCanvasRefreshScope(availableListing)).toMatchObject({
      requiredGapCount: 0, bodyCount: 1, emptyBodyCount: 0,
    });

    const confirmedOmission = completeCaptureSnapshot();
    confirmedOmission.resources.find((row) => row.endpoint === "pages")!.items = [
      { page_id: 74, _canvasBodyReason: "BODY_MISSING", _canvasBodyOmissionReason: "unpublished" },
    ];
    confirmedOmission.coverage.push({ endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "unpublished" });
    expect(summarizeCanvasCaptureOutcome(confirmedOmission)).toMatchObject({
      requiredGapCount: 0, failureGapCount: 0, bodyCount: 0, bodyFailureReason: null,
    });

    const unboundMarker = completeCaptureSnapshot();
    unboundMarker.resources.find((row) => row.endpoint === "pages")!.items = [
      { page_id: 75, _canvasBodyReason: "BODY_MISSING", _canvasBodyOmissionReason: "locked" },
    ];
    expect(summarizeCanvasCaptureOutcome(unboundMarker)).toMatchObject({
      requiredGapCount: 1, bodyFailureReason: "BODY_MISSING",
    });

    const lockedListing = completeCaptureSnapshot();
    lockedListing.resources.find((row) => row.endpoint === "pages")!.items = [
      { page_id: 76, published: false, _canvasBody: { html: "<p>Hidden</p>", text: "Hidden", empty: false } },
    ];
    lockedListing.coverage.push({ endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "unpublished" });
    expect(summarizeCanvasRefreshScope(lockedListing)).toMatchObject({
      requiredGapCount: 0, bodyCount: 0, emptyBodyCount: 0,
    });

    const lockedGroupPage = completeCaptureSnapshot();
    lockedGroupPage.resources.find((row) => row.endpoint === "groups")!.items = [
      { id: 88, course_id: COURSE_ID },
    ];
    lockedGroupPage.resources.push({
      endpoint: "pages", courseId: null, groupId: 88,
      items: [{ page_id: 89, published: false, _canvasBodyReason: "BODY_MISSING" }],
    });
    lockedGroupPage.coverage.push({
      endpoint: "page", courseId: null, groupId: 88, status: "gap", reason: "unpublished",
    });
    expect(summarizeCanvasCaptureOutcome(lockedGroupPage)).toMatchObject({
      bodyCount: 0, bodyFailureReason: null,
    });
  });

  it("accepts structurally valid archived file receipts and rejects missing, damaged, or failed receipts", () => {
    expect(summarizeCanvasRefreshScope(completeSnapshot())).toEqual({ requiredGapCount: 0, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0 });

    const missing = completeSnapshot();
    missing.resources.find((row) => row.endpoint === "fileBodies")!.items = [];
    expect(summarizeCanvasRefreshScope(missing)).toEqual({ requiredGapCount: 1, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0 });

    const damaged = completeSnapshot();
    damaged.resources.find((row) => row.endpoint === "fileBodies")!.items[0]!.sha256 = "damaged";
    expect(summarizeCanvasRefreshScope(damaged)).toEqual({ requiredGapCount: 1, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0 });

    const failed = completeSnapshot();
    failed.resources.find((row) => row.endpoint === "fileBodies")!.items[0] = {
      fileId: 61, status: "gap", reason: "HELPER_DOWNLOAD_REQUEST_FAILED",
    };
    expect(summarizeCanvasRefreshScope(failed)).toEqual({ requiredGapCount: 1, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0 });
  });

  it("separates the immutable partial archive marker from complete daily coverage", () => {
    const snapshot = completeSnapshot();
    snapshot.coverage.push({ endpoint: "calendar", courseId: COURSE_ID, status: "gap", reason: "unsupported" });
    snapshot.coverage.push({ endpoint: "calendarEvents", courseId: null, status: "incomplete", reason: "pagination-budget" });
    expect(summarizeCanvasRefreshScope(snapshot)).toEqual({ requiredGapCount: 0, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0 });
  });

  it("treats explicit locked child content as omitted, while list access failure blocks readiness", () => {
    const locked = completeSnapshot();
    locked.coverage.push({ endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "locked" });
    expect(summarizeCanvasRefreshScope(locked)).toEqual({ requiredGapCount: 0, omissionCount: 1, bodyCount: 0, emptyBodyCount: 0 });

    const optionalDetail = completeSnapshot();
    optionalDetail.coverage.push(
      { endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "not-found" },
      { endpoint: "moduleItems", courseId: COURSE_ID, status: "gap", reason: "forbidden-optional" },
    );
    expect(summarizeCanvasRefreshScope(optionalDetail)).toEqual({ requiredGapCount: 0, omissionCount: 2, bodyCount: 0, emptyBodyCount: 0 });

    const expectedInboxDetail = completeSnapshot();
    expectedInboxDetail.coverage.push({ endpoint: "conversation", courseId: null, status: "gap", reason: "not-found" });
    expect(summarizeCanvasRefreshScope(expectedInboxDetail).requiredGapCount).toBeGreaterThan(0);

    const unavailableList = completeSnapshot();
    unavailableList.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    unavailableList.coverage.find((row) => row.endpoint === "pages")!.reason = "forbidden-optional";
    unavailableList.resources = unavailableList.resources.filter((row) => row.endpoint !== "pages");
    expect(summarizeCanvasRefreshScope(unavailableList)).toEqual({ requiredGapCount: 0, omissionCount: 1, bodyCount: 0, emptyBodyCount: 0 });
  });

  it("classifies locked, unpublished, and not-applicable records as visible omissions", () => {
    const snapshot = completeSnapshot();
    snapshot.coverage.push(
      { endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "locked" },
      { endpoint: "quiz", courseId: COURSE_ID, status: "gap", reason: "unpublished" },
      { endpoint: "submission", courseId: COURSE_ID, status: "gap", reason: "not-applicable" },
    );
    expect(summarizeCanvasRefreshScope(snapshot)).toEqual({ requiredGapCount: 0, omissionCount: 3, bodyCount: 0, emptyBodyCount: 0 });
  });

  it("treats not-found pages and their children as omissions, while failed parents keep children as gaps", () => {
    const unavailablePages = completeSnapshot();
    unavailablePages.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    unavailablePages.coverage.find((row) => row.endpoint === "pages")!.reason = "not-found";
    unavailablePages.resources = unavailablePages.resources.filter((row) => row.endpoint !== "pages");
    unavailablePages.coverage.push({
      endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "parent-unavailable",
    });
    expect(summarizeCanvasRefreshScope(unavailablePages)).toEqual({ requiredGapCount: 0, omissionCount: 2, bodyCount: 0, emptyBodyCount: 0 });

    const failedPages = completeSnapshot();
    failedPages.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    failedPages.coverage.find((row) => row.endpoint === "pages")!.reason = "request-failed";
    failedPages.resources = failedPages.resources.filter((row) => row.endpoint !== "pages");
    failedPages.coverage.push({
      endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "parent-unavailable",
    });
    expect(summarizeCanvasRefreshScope(failedPages)).toEqual({ requiredGapCount: 2, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0 });

    const ambiguousParent = completeSnapshot();
    ambiguousParent.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    ambiguousParent.coverage.find((row) => row.endpoint === "pages")!.reason = "not-found";
    ambiguousParent.coverage.push({
      endpoint: "pages", courseId: COURSE_ID, status: "gap", reason: "request-failed",
    }, {
      endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "parent-unavailable",
    });
    ambiguousParent.resources = ambiguousParent.resources.filter((row) => row.endpoint !== "pages");
    expect(summarizeCanvasRefreshScope(ambiguousParent)).toEqual({ requiredGapCount: 2, omissionCount: 1, bodyCount: 0, emptyBodyCount: 0 });

    const contradictoryList = completeSnapshot();
    contradictoryList.coverage.find((row) => row.endpoint === "pages")!.status = "gap";
    contradictoryList.coverage.find((row) => row.endpoint === "pages")!.reason = "not-found";
    expect(summarizeCanvasRefreshScope(contradictoryList)).toEqual({ requiredGapCount: 1, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0 });
  });

  it("counts locked file receipts only when they belong to an active course file", () => {
    const activeLocked = completeSnapshot();
    activeLocked.resources.find((row) => row.endpoint === "fileBodies")!.items[0] = {
      fileId: 61, status: "gap", reason: "locked",
    };
    expect(summarizeCanvasRefreshScope(activeLocked)).toEqual({ requiredGapCount: 0, omissionCount: 1, bodyCount: 0, emptyBodyCount: 0 });

    const archivedLocked = completeSnapshot();
    archivedLocked.resources.push({ endpoint: "courseFiles", courseId: 18, items: [{ id: 62 }] });
    archivedLocked.resources.find((row) => row.endpoint === "fileBodies")!.items.push({
      fileId: 62, status: "gap", reason: "locked",
    });
    expect(summarizeCanvasRefreshScope(archivedLocked)).toEqual({ requiredGapCount: 0, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0 });
  });

  it("requires active linked file bodies and ignores group or completed-course failures", () => {
    const linked = completeSnapshot();
    linked.coverage.find((row) => row.endpoint === "courseFiles")!.status = "gap";
    linked.coverage.find((row) => row.endpoint === "courseFiles")!.reason = "forbidden-optional";
    linked.resources = linked.resources.filter((row) => row.endpoint !== "courseFiles");
    linked.resources.push(
      { endpoint: "file", courseId: COURSE_ID, items: [{ id: 62 }] },
      { endpoint: "fileBodies", courseId: null, items: [{
        fileId: 62, status: "archived", byteCount: 12, sha256: "b".repeat(64),
        contentType: "application/pdf", sourceAuthenticity: "unverified",
      }] },
    );
    linked.coverage.push({ endpoint: "file", courseId: COURSE_ID, status: "complete" });
    expect(summarizeCanvasRefreshScope(linked)).toEqual({ requiredGapCount: 0, omissionCount: 1, bodyCount: 0, emptyBodyCount: 0 });

    const missingBody = structuredClone(linked);
    for (const resource of missingBody.resources.filter((row) => row.endpoint === "fileBodies")) {
      resource.items = resource.items.filter((item) => item.fileId !== 62);
    }
    expect(summarizeCanvasRefreshScope(missingBody).requiredGapCount).toBe(1);

    const inaccessible = completeSnapshot();
    inaccessible.coverage.push(
      { endpoint: "file", courseId: COURSE_ID, status: "gap", reason: "forbidden-optional" },
      { endpoint: "file", courseId: COURSE_ID, status: "gap", reason: "not-found" },
    );
    expect(summarizeCanvasRefreshScope(inaccessible)).toEqual({ requiredGapCount: 0, omissionCount: 2, bodyCount: 0, emptyBodyCount: 0 });

    const failed = completeSnapshot();
    failed.coverage.push({ endpoint: "file", courseId: COURSE_ID, status: "incomplete", reason: "request-failed" });
    failed.coverage.push({ endpoint: "file", courseId: COURSE_ID, status: "gap", reason: "detail-budget" });
    expect(summarizeCanvasRefreshScope(failed).requiredGapCount).toBe(2);

    const outsideDaily = completeSnapshot();
    outsideDaily.resources.push(
      { endpoint: "file", courseId: 99, items: [{ id: 63 }] },
      { endpoint: "file", courseId: null, groupId: 91, items: [{ id: 64 }] },
      { endpoint: "personalFile", courseId: null, items: [{ id: 65 }] },
      { endpoint: "fileBodies", courseId: null, items: [
        { fileId: 63, status: "gap", reason: "request-failed" },
        { fileId: 64, status: "gap", reason: "request-failed" },
        { fileId: 65, status: "gap", reason: "request-failed" },
      ] },
    );
    outsideDaily.coverage.push(
      { endpoint: "file", courseId: 99, status: "incomplete", reason: "request-failed" },
      { endpoint: "file", courseId: null, groupId: 91, status: "incomplete", reason: "request-failed" },
      { endpoint: "personalFile", courseId: null, status: "incomplete", reason: "request-failed" },
    );
    expect(summarizeCanvasRefreshScope(outsideDaily)).toEqual({ requiredGapCount: 0, omissionCount: 0, bodyCount: 0, emptyBodyCount: 0 });
  });

  it("flags duplicate linked metadata and receipt IDs instead of counting one successful detail", () => {
    const duplicate = completeSnapshot();
    duplicate.resources.push(
      { endpoint: "file", courseId: COURSE_ID, items: [{ id: 62 }] },
      { endpoint: "file", courseId: COURSE_ID, items: [{ id: 62 }] },
      { endpoint: "fileBodies", courseId: null, items: [
        { fileId: 62, status: "archived", byteCount: 12, sha256: "b".repeat(64),
          contentType: "application/pdf", sourceAuthenticity: "unverified" },
        { fileId: 62, status: "archived", byteCount: 12, sha256: "b".repeat(64),
          contentType: "application/pdf", sourceAuthenticity: "unverified" },
      ] },
    );
    duplicate.coverage.push(
      { endpoint: "file", courseId: COURSE_ID, status: "complete" },
      { endpoint: "file", courseId: COURSE_ID, status: "complete" },
    );
    expect(summarizeCanvasRefreshScope(duplicate).requiredGapCount).toBeGreaterThan(0);
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
    expect(summarizeCanvasRefreshScope(snapshot)).toEqual({ requiredGapCount: 0, omissionCount: 2, bodyCount: 0, emptyBodyCount: 0 });
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
    snapshot.resources.push({ endpoint: "page", courseId: COURSE_ID, items: [{
      page_id: 1, _canvasBody: { html: "<p>Available</p>", text: "Available", empty: false },
    }] });
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
    expect(summarizeCanvasRefreshScope(omittedConversation)).toEqual({ requiredGapCount: 0, omissionCount: 1, bodyCount: 0, emptyBodyCount: 0 });
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
