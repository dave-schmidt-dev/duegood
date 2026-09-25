type SubmissionState = "known_submitted" | "known_not_submitted" | "unknown" | "unsupported";
type FieldState = "known" | "known_null" | "not_returned" | "unsupported";

/** One row of the local dashboard projection with explicit states for source fields. */
export interface AssignmentListItem {
  readonly sourceItemId: string;
  readonly courseId: string;
  readonly courseCode: string | null;
  readonly courseTitle: string | null;
  readonly title: string | null;
  readonly dueAt: string | null;
  readonly dueAtState: FieldState;
  readonly submissionState: SubmissionState;
  readonly completed: boolean;
  readonly completedAt: number | null;
}
