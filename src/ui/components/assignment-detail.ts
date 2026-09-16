import type { AssignmentListItem } from "../../db/types";
import type { ElementDescriptor } from "../dom";
import { formatDueAt } from "./assignment-row";

/**
 * `AssignmentListItem` carries no description or link field — the This Week read
 * (`listAssignmentsForAccount`) never fetched or stored Canvas description/body content, so
 * there is nothing here to sanitize or render as text beyond what the row already shows. This
 * detail disclosure exists to render the two fields the row omits for space: the full Canvas
 * submission four-state and the due-date four-state, each spelled out distinctly per
 * `docs/DESIGN-SYSTEM.md`'s States section — `unknown`/`unsupported` must never collapse into a
 * false "not submitted".
 */
export function submissionStateText(state: AssignmentListItem["submissionState"]): string {
  switch (state) {
    case "known_submitted":
      return "Submitted";
    case "known_not_submitted":
      return "Not submitted";
    case "unknown":
      return "Submission status unknown";
    case "unsupported":
      return "Submission status not available from this Canvas instance";
  }
}

export interface AssignmentDetailProps {
  readonly item: AssignmentListItem;
  readonly id: string;
  readonly hidden: boolean;
}

export function assignmentDetail(props: AssignmentDetailProps): ElementDescriptor {
  const { item } = props;
  return {
    tag: "div",
    attrs: {
      id: props.id,
      class: "assignment-detail",
      ...(props.hidden ? { hidden: "" } : {}),
    },
    children: [
      {
        tag: "dl",
        children: [
          { tag: "dt", text: "Due" },
          { tag: "dd", text: formatDueAt(item.dueAt, item.dueAtState) },
          { tag: "dt", text: "Submission" },
          { tag: "dd", text: submissionStateText(item.submissionState) },
        ],
      },
    ],
  };
}
