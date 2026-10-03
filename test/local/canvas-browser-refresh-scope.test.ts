import { describe, expect, it } from "vitest";
import { summarizeCanvasRefreshScope } from "../../scripts/canvas-browser-refresh-scope.mjs";

const COURSE_ID = 17;
const ACCOUNT_LISTS = ["inbox", "inboxAll", "conversationsSent", "conversationsArchived"];
const COURSE_LISTS = [
  "course", "assignments", "assignmentGroups", "submissions",
  "pages", "modules", "announcements", "courseFiles",
];

interface SyntheticResource {
  endpoint: string;
  courseId: number | null;
  items: Record<string, unknown>[];
}

interface SyntheticCoverage {
  endpoint: string;
  courseId: number | null;
  status: string;
  reason?: string;
}

interface SyntheticSnapshot {
  activeCourses: { courseIds: number[] };
  resources: SyntheticResource[];
  coverage: SyntheticCoverage[];
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
    { endpoint: "fileBodies", courseId: null, items: [{ fileId: 61, status: "staged" }] },
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
    expect(summarizeCanvasRefreshScope(unavailableList)).toEqual({ requiredGapCount: 1, omissionCount: 0 });
  });

  it("keeps a failed course-file download incomplete and disclosed", () => {
    const snapshot = completeSnapshot();
    snapshot.resources.find((row) => row.endpoint === "fileBodies")!.items[0] = {
      fileId: 61, status: "gap", reason: "HELPER_DOWNLOAD_REQUEST_FAILED",
    };
    expect(summarizeCanvasRefreshScope(snapshot)).toEqual({ requiredGapCount: 1, omissionCount: 0 });
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
