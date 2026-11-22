import { describe, expect, it, vi } from "vitest";
import { sanitizeCanvasCaptureItem } from "../../scripts/canvas-browser-capture-sanitize.mjs";
import { hydrateDiscussionAssignmentRubrics } from "../../scripts/canvas-browser-capture-rubrics.mjs";

type EvaluatePage = (reader: unknown, input: { html: string; options: { source: string; baseUrl: string } }) => Promise<unknown>;

async function sanitize(item: Record<string, unknown>, endpoint: string, evaluatePage: EvaluatePage = async () => {}) {
  return sanitizeCanvasCaptureItem(item, {
    endpoint, courseId: 101, itemIndex: 0, htmlReader: () => {}, evaluatePage,
  });
}

describe("Canvas assignment rubrics", () => {
  it("keeps the rubric contract and drops unapproved fields", async () => {
    const evaluatePage = vi.fn(async (_reader: unknown, input: { html: string }) => ({
      text: input.html.replace(/<[^>]*>/gu, ""), textTruncated: false, linksTruncated: false, links: [],
    }));
    const assignment = await sanitize({
      id: 501,
      rubric: [{
        id: "criterion-1", description: "Evidence", long_description: "<p>Use one source.</p>", points: 5,
        ratings: [{ description: "Strong", long_description: "Clear support.", points: 5, hidden: "drop" }],
        hidden: "drop",
      }],
      rubric_settings: { title: "Essay rubric", points_possible: 5, free_form_criterion_comments: true, hidden: "drop" },
      use_rubric_for_grading: true,
      rubric_assessment: { private_comment: "drop" },
      settings: { custom_title: "Keep this sibling value." },
    }, "assignments", evaluatePage) as Record<string, unknown>;

    expect(assignment).toMatchObject({
      rubric: [{
        id: "criterion-1", description: "Evidence", long_description: "Use one source.", points: 5,
        ratings: [{ description: "Strong", long_description: "Clear support.", points: 5 }],
      }],
      rubric_settings: { title: "Essay rubric", points_possible: 5, free_form_criterion_comments: true },
      use_rubric_for_grading: true,
    });
    expect(assignment).not.toHaveProperty("rubric_assessment");
    expect((assignment.rubric as Array<Record<string, unknown>>)[0]).not.toHaveProperty("hidden");
    expect(assignment.rubric_settings as Record<string, unknown>).not.toHaveProperty("hidden");
    expect(assignment.settings).toEqual({ custom_title: "Keep this sibling value." });
    expect(evaluatePage).toHaveBeenCalledTimes(3);
  });

  it("marks an assignment with no rubric as known absent", async () => {
    await expect(sanitize({ id: 502 }, "assignments")).resolves.toHaveProperty("rubric", null);
    await expect(sanitize({
      id: 503, rubric: [],
    }, "assignments")).resolves.toHaveProperty("rubric", null);
  });

  it("rejects malformed rubric shapes instead of copying nested unknown data", async () => {
    await expect(sanitize({ id: 504, rubric: { hidden: "drop" } }, "assignments"))
      .rejects.toMatchObject({ code: "INVALID_RESOURCE_ITEM" });
    await expect(sanitize({ id: 505, rubric: [{ description: { secret: "drop" }, points: 3 }] }, "assignments"))
      .rejects.toMatchObject({ code: "INVALID_RESOURCE_ITEM" });
  });

  it("copies canonical rubric data onto graded discussions and flags unmatched links", () => {
    const result = hydrateDiscussionAssignmentRubrics([
      { id: 700, assignment_id: 501, assignment: { id: 501, name: "Discussion" } },
      { id: 701, assignment: { id: 502, name: "Unmatched discussion" } },
      { id: 702, title: "Ungraded discussion" },
    ], [
      { id: 501, rubric: [{ id: "criterion-1", description: "Discussion quality", points: 3 }],
        rubric_settings: { title: "Discussion rubric", points_possible: 3 }, use_rubric_for_grading: true },
    ]);

    expect(result.items[0]).toMatchObject({
      assignment: {
        id: 501, name: "Discussion", rubric: [{ id: "criterion-1", description: "Discussion quality", points: 3 }],
        rubric_settings: { title: "Discussion rubric", points_possible: 3 }, use_rubric_for_grading: true,
      },
    });
    expect(result.items[1]?.assignment).toMatchObject({ id: 502, name: "Unmatched discussion" });
    expect(result.items[1]?.assignment).not.toHaveProperty("rubric");
    expect(result.items[2]).not.toHaveProperty("assignment");
    expect(result.unmatchedCount).toBe(1);

    const noRubric = hydrateDiscussionAssignmentRubrics(
      [{ id: 703, assignment_id: 503 }], [{ id: 503, rubric: null }],
    );
    expect(noRubric.items[0]).toMatchObject({ assignment: { id: 503, rubric: null } });
    expect(noRubric.unmatchedCount).toBe(0);
  });

  it("uses nested rubric evidence when the canonical row omits it", () => {
    const result = hydrateDiscussionAssignmentRubrics([
      { id: 704, assignment_id: 504, assignment: {
        id: 504, rubric: [{ id: "criterion-2", description: "Participation", points: 4 }],
        rubric_settings: { title: "Participation rubric", points_possible: 4 },
        use_rubric_for_grading: true,
      } },
    ], [{ id: 504 }]);

    expect(result.assignmentsUpdated).toBe(true);
    expect(result.assignments[0]).toMatchObject({
      id: 504, rubric: [{ id: "criterion-2", description: "Participation", points: 4 }],
      rubric_settings: { title: "Participation rubric", points_possible: 4 }, use_rubric_for_grading: true,
    });
    expect(result.items[0]?.assignment).toMatchObject({
      rubric: result.assignments[0]?.rubric, rubric_settings: result.assignments[0]?.rubric_settings,
      use_rubric_for_grading: true,
    });
    expect(result.unmatchedCount).toBe(0);
  });
});
