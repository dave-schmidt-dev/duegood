import { describe, expect, it } from "vitest";
import { resolveSubmissionState } from "../../src/canvas/submission";

describe("resolveSubmissionState", () => {
  it("reads known_not_submitted only from workflow_state unsubmitted", () => {
    expect(resolveSubmissionState({ submission: { workflow_state: "unsubmitted" } }, true)).toBe("known_not_submitted");
  });

  it.each(["submitted", "graded", "pending_review"])("reads known_submitted from workflow_state %s", (workflowState) => {
    expect(resolveSubmissionState({ submission: { workflow_state: workflowState } }, true)).toBe("known_submitted");
  });

  it("never defaults an unrecognized workflow_state to not-submitted", () => {
    expect(resolveSubmissionState({ submission: { workflow_state: "some_future_canvas_state" } }, true)).toBe("unknown");
  });

  it("reads unknown when the submission key is absent", () => {
    expect(resolveSubmissionState({}, true)).toBe("unknown");
  });

  it("reads unknown when Canvas returns an explicit null submission", () => {
    expect(resolveSubmissionState({ submission: null }, true)).toBe("unknown");
  });

  it("reads unsupported when the institution/request doesn't support the include, regardless of payload", () => {
    expect(resolveSubmissionState({ submission: { workflow_state: "submitted" } }, false)).toBe("unsupported");
  });
});
