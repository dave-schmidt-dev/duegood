import { describe, expect, it } from "vitest";
import { resolveEffectiveDueAt } from "../../src/canvas/overrides";
import type { CanvasAssignmentOverrideRaw } from "../../src/canvas/types";
import { knownField, knownNullField, notReturnedField } from "../../src/import/normalize";

const STUDENT = "5001";
const OTHER_STUDENT = "5002";

describe("resolveEffectiveDueAt", () => {
  it("returns the base due date unchanged when no override applies", () => {
    const base = knownField("2026-10-01T23:59:00Z");
    expect(resolveEffectiveDueAt(base, [], STUDENT, true)).toEqual(base);
  });

  it("returns the extension only for its authenticated student", () => {
    const base = knownField("2026-10-01T23:59:00Z");
    const overrides: CanvasAssignmentOverrideRaw[] = [{ id: 1, student_ids: [Number(STUDENT)], due_at: "2026-10-08T23:59:00Z" }];
    expect(resolveEffectiveDueAt(base, overrides, STUDENT, true)).toEqual(knownField("2026-10-08T23:59:00Z"));
  });

  it("never applies an override naming only a different student", () => {
    const base = knownField("2026-10-01T23:59:00Z");
    const overrides: CanvasAssignmentOverrideRaw[] = [{ id: 1, student_ids: [Number(OTHER_STUDENT)], due_at: "2026-10-08T23:59:00Z" }];
    expect(resolveEffectiveDueAt(base, overrides, STUDENT, true)).toEqual(base);
  });

  it("returns known_null for an applicable override whose own due_at is null, not the base value", () => {
    const base = knownField("2026-10-01T23:59:00Z");
    const overrides: CanvasAssignmentOverrideRaw[] = [{ id: 1, student_ids: [Number(STUDENT)], due_at: null }];
    expect(resolveEffectiveDueAt(base, overrides, STUDENT, true)).toEqual(knownNullField());
  });

  it("picks the override naming this student out of several, ignoring the others", () => {
    const base = knownField("2026-10-01T23:59:00Z");
    const overrides: CanvasAssignmentOverrideRaw[] = [
      { id: 1, student_ids: [Number(OTHER_STUDENT)], due_at: "2026-10-05T23:59:00Z" },
      { id: 2, student_ids: [Number(STUDENT)], due_at: "2026-10-08T23:59:00Z" },
    ];
    expect(resolveEffectiveDueAt(base, overrides, STUDENT, true)).toEqual(knownField("2026-10-08T23:59:00Z"));
  });

  it("treats a section-scoped override (no student_ids) as inapplicable, per phase-1 limitation", () => {
    const base = knownField("2026-10-01T23:59:00Z");
    const overrides: CanvasAssignmentOverrideRaw[] = [{ id: 1, due_at: "2026-10-08T23:59:00Z" }];
    expect(resolveEffectiveDueAt(base, overrides, STUDENT, true)).toEqual(base);
  });

  it("never matches an override whose student id is unsafe", () => {
    const base = knownField("2026-10-01T23:59:00Z");
    const overrides: CanvasAssignmentOverrideRaw[] = [
      { id: 1, student_ids: [`${Number.MAX_SAFE_INTEGER}99`], due_at: "2026-10-08T23:59:00Z" },
    ];
    expect(resolveEffectiveDueAt(base, overrides, STUDENT, true)).toEqual(base);
  });

  it("ignores overrides entirely when the institution doesn't support the overrides include", () => {
    const base = notReturnedField();
    const overrides: CanvasAssignmentOverrideRaw[] = [{ id: 1, student_ids: [Number(STUDENT)], due_at: "2026-10-08T23:59:00Z" }];
    expect(resolveEffectiveDueAt(base, overrides, STUDENT, false)).toEqual(base);
  });
});
