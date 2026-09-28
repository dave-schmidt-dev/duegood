import { describe, expect, it } from "vitest";
import {
  classifyBrowserFact,
  isBrowserSectionCurrent,
  parseBrowserFreshness,
} from "../../src/shared/browser-freshness";
import { projectDashboardDocuments, type DashboardDocumentBundle } from "../../src/shared/dashboard-projection";
import { parseDashboard } from "../../src/ui/app";
import { nativeProjectionOptions, parseDocumentBundle } from "../../src/ui/transport";

const CURRENT = {
  current: true,
  reason: "verified-import",
  runId: 12,
  observedAt: "2026-09-27T20:00:00Z",
  sections: [
    { courseId: 530, endpoint: "course", current: true },
    { courseId: 530, endpoint: "assignments", current: true },
    { courseId: 530, endpoint: "assignmentGroups", current: true },
    { courseId: 530, endpoint: "submissions", current: true },
    { courseId: 530, endpoint: "courseFiles", current: true },
    { courseId: 530, endpoint: "pages", current: true },
    { courseId: 530, endpoint: "modules", current: true },
    { courseId: 530, endpoint: "announcements", current: true },
    { courseId: 530, endpoint: "fileBodies", current: false },
    { courseId: null, endpoint: "inboxAll", current: true },
  ],
} as const;

function nativeBundle(browserFreshness?: unknown): Record<string, unknown> {
  return {
    storeState: "authoritative",
    coursework: { version: "0".repeat(64), text: JSON.stringify({
      generated: "2026-09-27T20:00:00Z",
      courses: [
        { key: "it530", code: "IT530", title: "Current course", folder: "classes/it530", canvasCourseId: 530, gradeGroups: [{ id: "g1", name: "Projects", weight: 100 }] },
        { key: "archive-42", code: "OLD42", title: "Archived course", folder: "classes/archive-42", canvasCourseId: 42, active: false },
      ],
      items: [
        { id: "canvas-item", course: "it530", kind: "assignment", source: "canvas", title: "Canvas stale item", at: "2026-09-28T20:00:00Z", submissionStatus: "graded", score: 18, grade: "90%", gradedAt: "2026-09-26T20:00:00Z" },
        { id: "ical-item", course: "it530", kind: "assignment", source: "ical", title: "Calendar item", at: "2026-09-29T20:00:00Z", submissionStatus: "unsubmitted", score: 7, grade: "B", gradedAt: "2026-09-25T20:00:00Z" },
        { id: "canvas-ical-due", course: "it530", kind: "assignment", source: "canvas", title: "Canvas item with selected calendar date", at: "2026-10-01T18:00:00Z", fieldObservations: { at: { selected: { owner: { source: "ical", institution: "synthetic.invalid", course: "it530", id: "assignment:987" }, value: "2026-10-01T18:00:00Z" } } }, submissionStatus: "graded", score: 18, grade: "90%", gradedAt: "2026-09-26T20:00:00Z", done: true, doneAt: "2026-09-25T20:00:00Z", notes: "Keep this note", manualGradeObservation: { version: 1, value: "A-", source: "manual" } },
        { id: "canvas-reference-only", course: "it530", kind: "assignment", source: "canvas", title: "Reference only", at: "2026-10-03T18:00:00Z", sourceReferences: [{ source: "ical", id: "assignment:123" }] },
        { id: "manual-item", course: "it530", kind: "assignment", source: "manual", title: "Personal task", at: "2026-10-02T18:00:00Z", notes: "Keep manual event" },
        { id: "archived-item", course: "archive-42", kind: "assignment", source: "canvas", title: "Archived due date", at: "2026-09-30T20:00:00Z", submissionStatus: "graded", score: 10, grade: "A" },
      ],
    }) },
    refreshHistory: null,
    conversations: JSON.stringify({ complete: true, conversations: [{ canvasConversationId: "thread-1", subject: "Synthetic inbox item", unread: false, starred: false, messageCount: 1, participants: [], messages: [], attachments: [] }] }),
    profile: null,
    avatar: null,
    courseExports: {
      it530: { files: JSON.stringify([{ id: 501, display_name: "Current file.pdf" }]), pages: "[]", modules: "[]", announcements: "[]", downloadManifest: "[]" },
      "archive-42": { files: JSON.stringify([{ id: 4201, display_name: "Archived file.pdf" }]), pages: "[]", modules: "[]", announcements: "[]", downloadManifest: JSON.stringify([{ fileId: 4201, status: "saved", sha256: "a".repeat(64), byteCount: 4096, contentType: "application/pdf", sourceAuthenticity: "unverified" }]) },
    },
    ...(browserFreshness === undefined ? {} : { browserFreshness }),
  };
}

describe("browser freshness projection", () => {
  it("treats legacy bundles without a report as unverified", () => {
    const freshness = parseBrowserFreshness(undefined);
    expect(freshness).toEqual({ current: false, reason: "not-reported", runId: null, observedAt: null, sections: [] });
    expect(classifyBrowserFact(freshness, "canvas", 530, "assignments")).toBe("unknown");
  });

  it("rejects malformed identities, endpoints, duplicate coverage, and inconsistent current flags", () => {
    expect(() => parseBrowserFreshness(null)).toThrow();
    expect(() => parseBrowserFreshness({ ...CURRENT, sections: [{ courseId: 530, endpoint: "arbitrary", current: true }] })).toThrow();
    expect(() => parseBrowserFreshness({ ...CURRENT, sections: [CURRENT.sections[0], CURRENT.sections[0]] })).toThrow();
    expect(() => parseBrowserFreshness({ ...CURRENT, runId: null })).toThrow();
  });

  it("parses only safe capture counts and never returns a captured account ID", () => {
    const availability = {
      available: true,
      reason: "confirmation-required",
      runId: 13,
      observedAt: "2026-09-27T20:00:00Z",
      activeCourseCount: 2,
      resourceCount: 8,
      itemCount: 24,
      blobCount: 3,
      blobBytes: 900,
      accountConfirmationNeeded: true,
      userId: 7001,
    };
    const parsed = parseBrowserFreshness({ ...CURRENT, captureAvailability: availability });
    expect(parsed.captureAvailability).toEqual({
      available: true,
      reason: "confirmation-required",
      runId: 13,
      observedAt: "2026-09-27T20:00:00Z",
      activeCourseCount: 2,
      resourceCount: 8,
      itemCount: 24,
      blobCount: 3,
      blobBytes: 900,
      accountConfirmationNeeded: true,
    });
    expect(() => parseBrowserFreshness({ ...CURRENT, captureAvailability: { ...availability, accountConfirmationNeeded: false } })).toThrow();
    expect(() => parseBrowserFreshness({ ...CURRENT, captureAvailability: { ...availability, blobBytes: -1 } })).toThrow();
  });

  it("keeps explicit current coursework verified when a separate file-body section has a gap", () => {
    const freshness = parseBrowserFreshness(CURRENT);
    expect(isBrowserSectionCurrent(freshness, 530, "assignments")).toBe(true);
    expect(isBrowserSectionCurrent(freshness, 530, "fileBodies")).toBe(false);
    expect(classifyBrowserFact(freshness, "canvas", 530, "assignments")).toBe("current");
    expect(classifyBrowserFact(freshness, "canvas", 530, "fileBodies")).toBe("stale");
    expect(classifyBrowserFact(freshness, "canvas", 530, "file")).toBe("unknown");
  });

  it("marks retained Canvas facts stale after a failed or newer capture", () => {
    for (const reason of ["capture-unverified", "newer-or-inconsistent-attempt"] as const) {
      const freshness = parseBrowserFreshness({ current: false, reason, runId: null, observedAt: null, sections: [] });
      expect(classifyBrowserFact(freshness, "canvas", 530, "submissions")).toBe("stale");
      expect(isBrowserSectionCurrent(freshness, 530, "submissions")).toBe(false);
    }
  });

  it("leaves iCal and personal grade facts independent of Canvas capture freshness", () => {
    const missing = parseBrowserFreshness(undefined);
    expect(classifyBrowserFact(missing, "ical", 530, "assignments")).toBe("independent");
    expect(classifyBrowserFact(missing, "manual", 530, "submissions")).toBe("independent");
    expect(classifyBrowserFact(missing, "pdf", 530, "submissions")).toBe("independent");
  });

  it("links current imported documents to the reported capture receipt", () => {
    const bundle = parseDocumentBundle(nativeBundle(CURRENT));
    const dashboard = projectDashboardDocuments(bundle, nativeProjectionOptions(bundle.storeState));
    expect(dashboard.sourceStatus.browserFreshness?.runId).toBe(12);
    expect(dashboard.sourceStatus.coursework).toBe("synced");
    expect(dashboard.sourceStatus.inbox).toBe("synced");
    expect(dashboard.sourceStatus.library).toBe("synced");
    expect(dashboard.events.find((event) => event.sourceItemId === "canvas-item")?.grade).toBe("90%");
    expect(dashboard.resources.some((resource) => resource.title === "Current file.pdf")).toBe(true);
    expect(parseDashboard(dashboard).sourceStatus.browserFreshness).toEqual(CURRENT);
  });

  it("hides stale Canvas grade, Inbox, and active library facts while preserving iCal, personal state, and archives", () => {
    const freshness = { current: false, reason: "capture-unverified", runId: null, observedAt: null, sections: [] };
    const bundle = parseDocumentBundle(nativeBundle(freshness));
    const dashboard = projectDashboardDocuments(bundle, nativeProjectionOptions(bundle.storeState));
    const canvas = dashboard.events.find((event) => event.sourceItemId === "canvas-item");
    const selectedCalendarDue = dashboard.events.find((event) => event.sourceItemId === "canvas-ical-due");
    const ical = dashboard.events.find((event) => event.sourceItemId === "ical-item");
    expect(canvas).toBeUndefined();
    expect(dashboard.events.some((event) => event.sourceItemId === "canvas-reference-only")).toBe(false);
    expect(selectedCalendarDue).toMatchObject({ dueAt: "2026-10-01T18:00:00Z", submissionState: "unknown", score: null, grade: null, gradedAt: null, assignmentGroupId: null, manualGrade: "A-", completed: true, notes: "Keep this note" });
    expect(ical).toMatchObject({ dueAt: "2026-09-29T20:00:00Z", score: 7, grade: "B", submissionState: "known_not_submitted" });
    expect(dashboard.events.find((event) => event.sourceItemId === "manual-item")?.notes).toBe("Keep manual event");
    expect(dashboard.events.some((event) => event.sourceItemId === "archived-item")).toBe(false);
    expect(dashboard.conversations).toEqual([]);
    expect(dashboard.sourceStatus).toMatchObject({ coursework: "not_synced", inbox: "not_synced", library: "not_synced", lastRefreshAt: null });
    expect(dashboard.resources.map((resource) => resource.title)).toEqual(["Archived file.pdf"]);
    expect(dashboard.resources[0]).toMatchObject({ savedLocally: true, courseId: "archive-42" });
  });

  it("keeps legacy bundle projection behavior when no freshness field exists", () => {
    const raw = nativeBundle();
    const parsed: DashboardDocumentBundle = parseDocumentBundle(raw);
    expect(parsed.browserFreshness).toBeUndefined();
    const dashboard = projectDashboardDocuments(parsed, nativeProjectionOptions(parsed.storeState));
    expect(dashboard.sourceStatus.coursework).toBe("synced");
    expect(dashboard.sourceStatus.browserFreshness).toBeUndefined();
    expect(dashboard.conversations).toHaveLength(1);
    expect(dashboard.events.some((event) => event.sourceItemId === "canvas-item")).toBe(true);
  });
});
