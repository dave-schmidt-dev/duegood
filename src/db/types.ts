type SubmissionState = "known_submitted" | "known_not_submitted" | "unknown" | "unsupported";
type FieldState = "known" | "known_null" | "not_returned" | "unsupported";

export interface CanvasRubricRating {
  readonly description: string | null;
  readonly longDescription: string | null;
  readonly points: number | null;
}

export interface CanvasRubricCriterion {
  readonly id: string | number | null;
  readonly description: string | null;
  readonly longDescription: string | null;
  readonly points: number | null;
  readonly ratings: readonly CanvasRubricRating[];
}

export interface CanvasRubricSettings {
  readonly title: string | null;
  readonly pointsPossible: number | null;
  readonly freeFormCriterionComments: boolean | null;
}

export interface CanvasRubric {
  readonly criteria: readonly CanvasRubricCriterion[];
  readonly settings: CanvasRubricSettings | null;
  readonly useForGrading: boolean | null;
}

/** One row of the local dashboard projection with explicit states for source fields. */
export interface AssignmentListItem {
  readonly sourceItemId: string;
  readonly courseId: string;
  readonly courseCode: string | null;
  readonly courseTitle: string | null;
  readonly title: string | null;
  readonly dueAt: string | null;
  readonly dueAtState: FieldState;
  readonly calendarRetained?: boolean;
  readonly submissionState: SubmissionState;
  readonly completed: boolean;
  readonly completedAt: number | null;
  /** Null means the latest complete source capture confirmed no rubric. */
  readonly rubric?: CanvasRubric | null;
}
