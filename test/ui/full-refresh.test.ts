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
    expect(feedback.detail).toContain("Current Canvas pages refreshed.");
    expect(feedback.detail).toContain("3 optional capture omissions recorded");
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
    expect(partial.detail).toContain("1 coverage gap");
  });
});
