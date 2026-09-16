import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/canvas-phase1.json";
import { assessFeasibility, DEFERRED_CLIENT_ORCHESTRATION_NOTE } from "../../src/import/feasibility";

describe("assessFeasibility", () => {
  it.each(["small", "typical", "large"] as const)("chooses the in-memory strategy for the %s profile", (name) => {
    const result = assessFeasibility({ assignmentCount: fixture.profiles[name].assignmentsPerCourse });
    expect(result.status).toBe("in_envelope");
    expect(result.strategy).toBe("in_memory_snapshot");
  });

  it("stays comfortably under both estimate ceilings for the large profile", () => {
    const result = assessFeasibility({ assignmentCount: fixture.profiles.large.assignmentsPerCourse });
    expect(result.estimatedCanvasFetches).toBeLessThan(50);
    expect(result.estimatedD1Queries).toBeLessThan(50);
  });

  it("blocks a course whose inventory exceeds the envelope, with no chosen strategy", () => {
    const result = assessFeasibility({ assignmentCount: 6000 });
    expect(result.status).toBe("blocked");
    expect(result.strategy).toBeUndefined();
    expect(result.reason).toBe(DEFERRED_CLIENT_ORCHESTRATION_NOTE);
  });

  it("names the deferred client-orchestration alternative, not a silent truncation", () => {
    const result = assessFeasibility({ assignmentCount: 6000 });
    expect(result.reason).toContain("server-owned resumable continuation");
  });
});
