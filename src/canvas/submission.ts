import { readSourceField } from "../import/normalize";
import type { CanvasSubmissionRaw } from "./types";

/**
 * Phase 1 has no per-institution capability probe for the `submission` include, so every import
 * treats it as supported. Replace with a real probe (or a config-driven flag) once an institution
 * is found where requesting `include[]=submission` fails or is silently ignored.
 */
export const SUBMISSION_SUPPORTED_PHASE_1 = true;

export type SubmissionState = "known_submitted" | "known_not_submitted" | "unknown" | "unsupported";

/**
 * Derives the phase-1 submission chip state from Canvas's raw `submission.workflow_state`.
 * `"unsubmitted"` is the only value this app treats as unambiguously not-submitted; every other
 * recognized state (`submitted`, `graded`, `pending_review`) reads as submitted, and anything else
 * — including a workflow_state this app has never seen, a `known_null` submission, or a submission
 * key Canvas didn't return — falls through to `unknown`, never defaulting to "not submitted". That
 * default direction matters: guessing not-submitted for an unrecognized state would be exactly the
 * false negative the phase-1 content model forbids (docs/DESIGN-SYSTEM.md's States section).
 */
export function resolveSubmissionState(record: Record<string, unknown>, supported: boolean): SubmissionState {
  const field = readSourceField<CanvasSubmissionRaw | null>(record, "submission", supported);
  if (field.state === "unsupported") return "unsupported";
  if (field.state !== "known" || field.value === null) return "unknown";
  switch (field.value.workflow_state) {
    case "unsubmitted":
      return "known_not_submitted";
    case "submitted":
    case "graded":
    case "pending_review":
      return "known_submitted";
    default:
      return "unknown";
  }
}
