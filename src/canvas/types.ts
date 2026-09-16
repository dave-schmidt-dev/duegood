/**
 * Raw Canvas API JSON shapes, as documented — not this app's normalized model
 * (src/import/normalize.ts). `id`/`course_id` are typed `number | string` because Canvas returns
 * ids as bare JSON numbers on most endpoints; parsing them is `src/canvas/id.ts`'s job, never done
 * inline here. `submission` is optional (Canvas omits it entirely unless the `submission` include
 * is requested and supported) and separately nullable (a requested-but-absent submission is JSON
 * `null`) — both are distinct from a present submission object, per `readSourceField`.
 */
export interface CanvasCourseRaw {
  readonly id: number | string;
  readonly course_code?: string;
  readonly name?: string;
  readonly term?: { readonly name?: string };
}

export interface CanvasSubmissionRaw {
  readonly workflow_state?: string;
  readonly submitted_at?: string | null;
}

export interface CanvasAssignmentRaw {
  readonly id: number | string;
  readonly course_id?: number | string;
  readonly name?: string;
  readonly due_at: string | null;
  readonly points_possible?: number | null;
  readonly submission?: CanvasSubmissionRaw | null;
  /** Present only when requested via `include[]=overrides`. */
  readonly overrides?: readonly CanvasAssignmentOverrideRaw[];
}

/**
 * One entry from an assignment's `overrides` list (returned only when requested via
 * `include[]=overrides`). `student_ids` names exactly which students this override applies to —
 * an override naming other students only must never be applied to the caller's own projection.
 * `due_at` follows the assignment's own present-but-nullable shape.
 */
export interface CanvasAssignmentOverrideRaw {
  readonly id: number | string;
  readonly student_ids?: readonly (number | string)[];
  readonly due_at: string | null;
}
