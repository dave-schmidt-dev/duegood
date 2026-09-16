import { knownField, knownNullField, type SourceField } from "../import/normalize";
import { parseCanvasId } from "./id";
import type { CanvasAssignmentOverrideRaw } from "./types";

function overrideDueAt(override: CanvasAssignmentOverrideRaw): SourceField<string> {
  return override.due_at === null ? knownNullField<string>() : knownField(override.due_at);
}

/**
 * Resolves the due date that actually applies to one authenticated student: their own override's
 * `due_at` when Canvas lists them by student id in exactly one override, else the assignment's own
 * base due date, returned unchanged — never collapsed through `??`, since an applicable override
 * whose own `due_at` is `null` is a real "no due date" result, distinct from "no override applies."
 * An override naming only other students is never applied — it belongs to them, not to this
 * projection. Section/group-scoped overrides (no `student_ids`) are treated as inapplicable in
 * phase 1, a stated limitation: resolving section membership needs an enrollment lookup this
 * slice doesn't have.
 */
export function resolveEffectiveDueAt(
  baseDueAt: SourceField<string>,
  overrides: readonly CanvasAssignmentOverrideRaw[],
  studentCanvasUserId: string,
  overridesSupported: boolean,
): SourceField<string> {
  if (!overridesSupported) return baseDueAt;
  const applicable = overrides.find((override) =>
    (override.student_ids ?? []).some((id) => parseCanvasId(id).id === studentCanvasUserId),
  );
  return applicable === undefined ? baseDueAt : overrideDueAt(applicable);
}
