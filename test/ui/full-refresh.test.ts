import { describe, expect, it } from "vitest";
import { fullRefreshFeedback } from "../../src/ui/full-refresh";
import { parseFullRefreshProgress, parseFullRefreshResult } from "../../src/ui/full-refresh-transport";

const defaultRefreshCounts = {
  bodyCount: 5,
  emptyBodyCount: 1,
  bodyFailureReason: null,
  exportStatus: "disabled" as const,
  exportWritten: 0,
  exportUnchanged: 0,
  exportSkippedOwnerFiles: 0,
};

describe("full refresh result semantics", () => {
  it("rejects removed visible-window progress and unexpected refresh reasons", () => {
    expect(parseFullRefreshProgress({ phase: "sign-in-window", reason: "VERIFICATION_REQUIRED" })).toBeNull();
    expect(parseFullRefreshProgress({ phase: "browser-capture", reason: "VERIFICATION_REQUIRED" })).toBeNull();
  });

  it("reports daily completion and bounded optional omissions without implying archive completeness", () => {
    const result = parseFullRefreshResult({
      status: "complete",
      browserStatus: "complete",
      calendarStatus: "complete",
      gapCount: 0,
      omissionCount: 3,
      ...defaultRefreshCounts, rubricCount: 2,
      linkedFileCount: 4,
      calendarAdded: 1,
      calendarUpdated: 2,
      calendarHeld: 0,
      updatedAt: "2026-10-02T12:00:00Z",
    });
    expect(result).not.toBeNull();
    const feedback = fullRefreshFeedback(result!);
    expect(feedback.state).toBe("complete");
    expect(feedback.detail).toContain("Complete. Canvas and calendar updated.");
    expect(feedback.detail).toContain("3 omissions recorded.");
    expect(feedback.detail).toContain("Bodies kept for 5 items (1 empty).");
    expect(feedback.detail).toContain("Rubrics on 2 assignments. Metadata retrieved for 4 additional linked files.");
    expect(feedback.detail).toContain("Course exports disabled.");
    expect(feedback.detail).not.toContain("everything captured");
  });

  it("surfaces a content-free body coverage failure reason", () => {
    const result = parseFullRefreshResult({
      status: "incomplete", browserStatus: "incomplete", calendarStatus: "complete",
      gapCount: 1, omissionCount: 0, bodyCount: 2, emptyBodyCount: 1,
      bodyFailureReason: "BODY_MISSING", rubricCount: 0, linkedFileCount: 0,
      exportStatus: "disabled", exportWritten: 0, exportUnchanged: 0, exportSkippedOwnerFiles: 0,
      calendarAdded: 0, calendarUpdated: 0, calendarHeld: 0, updatedAt: null,
    });
    expect(result).not.toBeNull();
    expect(fullRefreshFeedback(result!).detail).toContain("Some Canvas item bodies were missing from the response.");
    expect(parseFullRefreshResult({ ...result, bodyFailureReason: "PRIVATE_BODY" })).toBeNull();
  });

  it("rejects unbounded omission counts and leaves required gaps partial", () => {
    expect(parseFullRefreshResult({
      status: "complete", browserStatus: "complete", calendarStatus: "complete",
      gapCount: 0, omissionCount: 100_001, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 0,
      calendarHeld: 0, updatedAt: null,
    })).toBeNull();

    const partial = fullRefreshFeedback({
      status: "incomplete", browserStatus: "incomplete", calendarStatus: "complete",
      gapCount: 1, omissionCount: 2, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 0,
      calendarHeld: 0, updatedAt: null,
    });
    expect(partial.state).toBe("partial");
    expect(partial.detail).toContain("1 Canvas section or file could not refresh");
    expect(partial.detail).toContain("2 omissions recorded.");
  });

  it("requires bounded content-free rubric and linked-file counts", () => {
    const base = {
      status: "complete",
      browserStatus: "complete",
      calendarStatus: "complete",
      gapCount: 0,
      omissionCount: 0,
      ...defaultRefreshCounts, rubricCount: 1,
      linkedFileCount: 2,
      calendarAdded: 0,
      calendarUpdated: 0,
      calendarHeld: 0,
      updatedAt: null,
    };
    expect(parseFullRefreshResult(base)).not.toBeNull();
    expect(parseFullRefreshResult({ ...base, linkedFileCount: 100_001 })).toBeNull();
    expect(parseFullRefreshResult({ ...base, bodyCount: 100_001 })).toBeNull();
    expect(parseFullRefreshResult({ ...base, bodyCount: 1, emptyBodyCount: 2 })).toBeNull();
    expect(parseFullRefreshResult({ ...base, bodyFailureReason: null, exportStatus: "private" })).toBeNull();
    expect(parseFullRefreshResult({ ...base, privateData: "course title" })).toBeNull();
    expect(parseFullRefreshResult({ ...base, rubricCount: undefined })).toBeNull();
  });

  it("reports bounded export results without failing the refresh", () => {
    const result = parseFullRefreshResult({
      status: "complete", browserStatus: "complete", calendarStatus: "complete",
      gapCount: 0, omissionCount: 0, bodyCount: 2, emptyBodyCount: 0, bodyFailureReason: null, rubricCount: 0, linkedFileCount: 0,
      exportStatus: "failed", exportWritten: 1, exportUnchanged: 2, exportSkippedOwnerFiles: 3,
      calendarAdded: 0, calendarUpdated: 0, calendarHeld: 0, updatedAt: null,
    });
    expect(result?.status).toBe("complete");
    expect(result?.exportStatus).toBe("failed");
    expect(fullRefreshFeedback(result!).detail).toContain("Course exports failed.");
  });

  it("keeps a zero omission count visible for a complete refresh", () => {
    const feedback = fullRefreshFeedback({
      status: "complete", browserStatus: "complete", calendarStatus: "complete",
      gapCount: 0, omissionCount: 0, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 0,
      calendarHeld: 0, updatedAt: null,
    });

    expect(feedback.state).toBe("complete");
    expect(feedback.detail).toContain("0 omissions recorded.");
  });

  it("reports Canvas gaps separately from held calendar items", () => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "incomplete", calendarStatus: "incomplete",
      gapCount: 125, omissionCount: 9, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 58,
      calendarHeld: 1, updatedAt: null,
    });

    expect(feedback.state).toBe("partial");
    expect(feedback.detail).toContain("125 Canvas sections or files could not refresh");
    expect(feedback.detail).toContain("9 omissions recorded.");
    expect(feedback.detail).toContain("58 updated. 1 calendar item was left unchanged");
    expect(feedback.detail).not.toContain("126");
  });

  it("keeps a held calendar item partial when Canvas completed", () => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "complete", calendarStatus: "incomplete",
      gapCount: 0, omissionCount: 0, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 58,
      calendarHeld: 1, updatedAt: null,
    });

    expect(feedback.state).toBe("partial");
    expect(feedback.detail).toContain("Canvas updated.");
    expect(feedback.detail).toContain("calendar item was left unchanged");
    expect(feedback.detail).toContain("1 calendar item was left unchanged");
  });

  it("does not call a refresh complete when a held calendar item conflicts with source status", () => {
    const feedback = fullRefreshFeedback({
      status: "complete", browserStatus: "complete", calendarStatus: "complete",
      gapCount: 0, omissionCount: 0, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 58,
      calendarHeld: 1, updatedAt: null,
    });

    expect(feedback.state).toBe("partial");
    expect(feedback.detail).toContain("calendar item was left unchanged");
  });

  it("explains file failures from the current refresh and directs the user to Activity", () => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "incomplete", calendarStatus: "complete",
      gapCount: 1, omissionCount: 1, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 2, calendarHeld: 0, updatedAt: null,
    }, ["1 file could not be verified: its contents did not match its file type."]);
    expect(feedback.detail).toContain("contents did not match its file type");
    expect(feedback.detail).toContain("See Activity for details.");
  });

  it("surfaces a failed source alongside the other source's status", () => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "complete", calendarStatus: "failed",
      gapCount: 0, omissionCount: 0, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 0,
      calendarHeld: 0, updatedAt: null, errorCode: "calendar-failed",
    });

    expect(feedback.state).toBe("partial");
    expect(feedback.detail).toContain("Canvas updated.");
    expect(feedback.detail).toContain("Calendar could not refresh");
  });

  it("tells the owner how to refresh stale Canvas helpers", () => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "failed", calendarStatus: "complete",
      gapCount: 0, omissionCount: 0, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 0,
      calendarHeld: 0, updatedAt: null, errorCode: "helper-stale",
    });

    expect(feedback.state).toBe("partial");
    expect(feedback.detail).toContain("Canvas capture helpers are out of date.");
    expect(feedback.detail).toContain("npm run canvas:prepare-helper");
  });

  it.each([
    ["canvas-credentials-unavailable", "Saved Canvas sign-in details are unavailable"],
    ["canvas-sign-in-blocked", "Canvas rejected the saved sign-in details"],
    ["canvas-verification-required", "Canvas requires an extra verification step"],
    ["canvas-survey-blocking", "A Canvas survey is blocking refresh"],
    ["canvas-sign-in-page-unknown", "could not recognize the Canvas sign-in page"],
    ["canvas-sign-in-timeout", "Canvas sign-in did not finish automatically"],
    ["canvas-sign-in-required", "Canvas needs you to sign in"],
    ["headless-session-required", "A visible Canvas setup session is open"],
  ])("explains how to recover from %s without opening a refresh window", (errorCode, detail) => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "failed", calendarStatus: "complete",
      gapCount: 0, omissionCount: 0, ...defaultRefreshCounts, rubricCount: 0, linkedFileCount: 0,
      calendarAdded: 0, calendarUpdated: 0, calendarHeld: 0, updatedAt: null, errorCode,
    });
    expect(feedback.detail).toContain(detail);
    expect(feedback.detail).not.toContain("Chrome window is opening");
  });
});
