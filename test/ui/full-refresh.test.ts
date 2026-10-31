import { describe, expect, it } from "vitest";
import { fullRefreshFeedback } from "../../src/ui/full-refresh";
import { parseFullRefreshResult } from "../../src/ui/full-refresh-transport";

describe("full refresh result semantics", () => {
  it("reports daily completion and bounded optional omissions without implying archive completeness", () => {
    const result = parseFullRefreshResult({
      status: "complete",
      browserStatus: "complete",
      calendarStatus: "complete",
      gapCount: 0,
      omissionCount: 3,
      calendarAdded: 1,
      calendarUpdated: 2,
      calendarHeld: 0,
      updatedAt: "2026-10-02T12:00:00Z",
    });
    expect(result).not.toBeNull();
    const feedback = fullRefreshFeedback(result!);
    expect(feedback.state).toBe("complete");
    expect(feedback.detail).toContain("Canvas and calendar updated.");
    expect(feedback.detail).toContain("3 optional items were unavailable or skipped");
    expect(feedback.detail).not.toContain("everything captured");
  });

  it("rejects unbounded omission counts and leaves required gaps partial", () => {
    expect(parseFullRefreshResult({
      status: "complete", browserStatus: "complete", calendarStatus: "complete",
      gapCount: 0, omissionCount: 100_001, calendarAdded: 0, calendarUpdated: 0,
      calendarHeld: 0, updatedAt: null,
    })).toBeNull();

    const partial = fullRefreshFeedback({
      status: "incomplete", browserStatus: "incomplete", calendarStatus: "complete",
      gapCount: 1, omissionCount: 2, calendarAdded: 0, calendarUpdated: 0,
      calendarHeld: 0, updatedAt: null,
    });
    expect(partial.state).toBe("partial");
    expect(partial.detail).toContain("1 Canvas section or file could not refresh");
  });

  it("reports Canvas gaps separately from held calendar items", () => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "incomplete", calendarStatus: "incomplete",
      gapCount: 125, omissionCount: 9, calendarAdded: 0, calendarUpdated: 58,
      calendarHeld: 1, updatedAt: null,
    });

    expect(feedback.state).toBe("partial");
    expect(feedback.detail).toContain("125 Canvas sections or files could not refresh");
    expect(feedback.detail).toContain("9 optional items were unavailable or skipped");
    expect(feedback.detail).toContain("58 updated. 1 calendar item was left unchanged");
    expect(feedback.detail).not.toContain("126");
  });

  it("keeps a held calendar item partial when Canvas completed", () => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "complete", calendarStatus: "incomplete",
      gapCount: 0, omissionCount: 0, calendarAdded: 0, calendarUpdated: 58,
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
      gapCount: 0, omissionCount: 0, calendarAdded: 0, calendarUpdated: 58,
      calendarHeld: 1, updatedAt: null,
    });

    expect(feedback.state).toBe("partial");
    expect(feedback.detail).toContain("calendar item was left unchanged");
  });

  it("explains file failures from the current refresh and directs the user to Activity", () => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "incomplete", calendarStatus: "complete",
      gapCount: 1, omissionCount: 1, calendarAdded: 0, calendarUpdated: 2, calendarHeld: 0, updatedAt: null,
    }, ["1 file could not be verified: its contents did not match its file type."]);
    expect(feedback.detail).toContain("contents did not match its file type");
    expect(feedback.detail).toContain("See Activity for details.");
  });

  it("surfaces a failed source alongside the other source's status", () => {
    const feedback = fullRefreshFeedback({
      status: "incomplete", browserStatus: "complete", calendarStatus: "failed",
      gapCount: 0, omissionCount: 0, calendarAdded: 0, calendarUpdated: 0,
      calendarHeld: 0, updatedAt: null, errorCode: "calendar-failed",
    });

    expect(feedback.state).toBe("partial");
    expect(feedback.detail).toContain("Canvas updated.");
    expect(feedback.detail).toContain("Calendar could not refresh");
  });
});
