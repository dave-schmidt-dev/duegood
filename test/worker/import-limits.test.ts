import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  CANVAS_SUBREQUESTS_PER_INVOCATION,
  D1_QUERIES_PER_INVOCATION,
  createBudgetTracker,
  createImportBudget,
} from "../../src/import/limits";
import {
  isKnownValue,
  knownField,
  knownNullField,
  notReturnedField,
  readSourceField,
  unsupportedField,
} from "../../src/import/normalize";

describe("createBudgetTracker", () => {
  it("starts at the platform ceilings by default", () => {
    const tracker = createBudgetTracker();
    expect(tracker.remaining()).toEqual({
      canvasFetchesRemaining: CANVAS_SUBREQUESTS_PER_INVOCATION,
      d1QueriesRemaining: D1_QUERIES_PER_INVOCATION,
    });
  });

  it("decrements on each spend", () => {
    const tracker = createBudgetTracker(createImportBudget({ canvasFetchesRemaining: 2, d1QueriesRemaining: 10 }));
    tracker.spendCanvasFetch();
    tracker.spendD1Queries(4);
    expect(tracker.remaining()).toEqual({ canvasFetchesRemaining: 1, d1QueriesRemaining: 6 });
  });

  it("throws instead of going negative on a Canvas fetch", () => {
    const tracker = createBudgetTracker(createImportBudget({ canvasFetchesRemaining: 0 }));
    expect(() => tracker.spendCanvasFetch()).toThrow(BudgetExceededError);
  });

  it("throws instead of partially spending a D1 query batch that would exceed the ceiling", () => {
    const tracker = createBudgetTracker(createImportBudget({ d1QueriesRemaining: 3 }));
    expect(() => tracker.spendD1Queries(4)).toThrow(BudgetExceededError);
    // Rejected spend must not partially apply.
    expect(tracker.remaining().d1QueriesRemaining).toBe(3);
  });
});

describe("SourceField four-state normalization", () => {
  it("reads a present, non-null value as known", () => {
    const field = readSourceField<string>({ title: "Essay" }, "title", true);
    expect(field).toEqual(knownField("Essay"));
    expect(isKnownValue(field)).toBe(true);
  });

  it("reads a present null as known_null, distinct from an absent key", () => {
    expect(readSourceField({ grade: null }, "grade", true)).toEqual(knownNullField());
    expect(readSourceField({}, "grade", true)).toEqual(notReturnedField());
  });

  it("reads as unsupported regardless of payload shape when the field isn't supported", () => {
    expect(readSourceField({ submission: { workflow_state: "submitted" } }, "submission", false)).toEqual(
      unsupportedField(),
    );
    expect(readSourceField({}, "submission", false)).toEqual(unsupportedField());
  });

  it("treats every non-known state as not a submission, never a false negative", () => {
    for (const field of [knownNullField(), notReturnedField(), unsupportedField()]) {
      expect(isKnownValue(field)).toBe(false);
    }
  });
});
