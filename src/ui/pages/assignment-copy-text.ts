import type { DashboardEvent } from "./dashboard";

export interface AssignmentCopyFormatters {
  readonly code: (value: string) => string;
  readonly isDateOnly: (value: string | number | null | undefined) => boolean;
  readonly formatted: (value: string | number | null | undefined, withTime?: boolean) => string;
}

function formatSubmissionState(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "unknown" || normalized === "unsupported") return undefined;
  if (["known_not_submitted", "not_submitted", "unsubmitted"].includes(normalized)) return "Not submitted";
  if (["known_submitted", "submitted", "pending", "pending_review", "late"].includes(normalized)) return "Submitted";
  if (["known_graded", "graded"].includes(normalized)) return "Graded";
  const readable = trimmed.replace(/[_-]+/g, " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

export function formatAssignmentCopyText(event: DashboardEvent, formatters: AssignmentCopyFormatters): string {
  const lines = [
    `Course code: ${formatters.code(event.courseCode)}`,
    `Assignment title: ${event.title}`,
    event.startsAt === null
      ? "Due date: No due date"
      : `Due ${formatters.isDateOnly(event.startsAt) ? "date" : "date/time"}: ${formatters.formatted(event.startsAt, true)}`,
  ];
  if (typeof event.points === "number" && Number.isFinite(event.points)) lines.push(`Points: ${String(event.points)}`);
  const submissionStatus = formatSubmissionState(event.submissionState);
  if (submissionStatus !== undefined) lines.push(`Canvas submission status: ${submissionStatus}`);
  lines.push(`Due Good completion status: ${event.completed ? "Completed" : "Not completed"}`);
  if (event.kind === "discussion") {
    lines.push(`Main post: ${event.discussionPostDone === true ? "Completed" : "Not completed"}`);
    lines.push(`Replies to classmates: ${event.discussionRepliesDone === true ? "Completed" : "Not completed"}`);
  }
  const detail = typeof event.detail === "string" && event.detail.trim().length > 0
    ? event.detail.replace(/\r\n?/gu, "\n").trim()
    : undefined;
  const assignmentDetail = typeof event.assignmentDetail === "string" && event.assignmentDetail.trim().length > 0
    ? event.assignmentDetail.replace(/\r\n?/gu, "\n").trim()
    : undefined;
  if (detail === undefined && assignmentDetail === undefined) {
    lines.push("Assignment details: No additional details were supplied.");
  } else if (detail !== undefined) {
    const label = event.kind === "discussion" && assignmentDetail !== undefined && assignmentDetail !== detail
      ? "Discussion prompt"
      : "Assignment details";
    lines.push(`${label}: ${detail}`);
  }
  if (assignmentDetail !== undefined && assignmentDetail !== detail) {
    lines.push(`Assignment instructions: ${assignmentDetail}`);
  }
  return lines.join("\n");
}
