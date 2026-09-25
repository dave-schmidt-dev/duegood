import type { AssignmentListItem } from "../db/types";
import type { PendingSourceLink } from "./pending-links";

/** Shapes of the validated native coursework document after dashboard projection. */
export interface LocalCourse {
  readonly id: string;
  readonly courseCode: string | null;
  readonly title: string | null;
  readonly color: string | null;
  readonly folder: string | null;
  readonly lastSuccessfulCheckAt: number | null;
  readonly gradeGroups?: readonly { readonly id: string | null; readonly name: string | null; readonly weight: number | null }[];
  readonly syncing: false;
}

interface LocalGradeRecord extends AssignmentListItem {
  readonly source: string | null;
  readonly points: number | null;
  readonly score: number | null;
  readonly grade: string | null;
  readonly manualGrade: string | null;
  readonly manualGradeVersion: 1 | null;
  readonly manualGradeSource: "manual" | "pdf" | null;
  readonly gradedAt: string | null;
  readonly assignmentGroupId: string | null;
  readonly assignmentGroupName: string | null;
  readonly assignmentGroupWeight: number | null;
}

interface LocalTimelineEvent extends LocalGradeRecord {
  readonly type: "deadline" | "class";
  readonly kind: string | null;
  readonly detail: string | null;
  readonly place: string | null;
  readonly notes: string | null;
  readonly discussionPostDone: boolean;
  readonly discussionRepliesDone: boolean;
}

export interface LocalSnapshot {
  readonly version: string;
  readonly courses: readonly LocalCourse[];
  readonly assignments: readonly LocalGradeRecord[];
  readonly events: readonly LocalTimelineEvent[];
  readonly pendingSourceLinks: readonly PendingSourceLink[];
}
