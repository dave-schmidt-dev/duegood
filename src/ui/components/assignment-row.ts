import type { AssignmentListItem } from "../../db/types";
import type { ElementDescriptor } from "../dom";
import { completionToggle } from "./completion-toggle";

/** Renders the due date/time exactly as the row primitive's field list requires — plain text, no
 * chip (see `docs/DESIGN-SYSTEM.md`'s phase-1 scope note under Status). `known_null` and
 * `not_returned`/`unsupported` read as distinct, honest phrases rather than collapsing to one
 * "no date" string, matching the four-state contract the row's due-date field is drawn from. */
export function formatDueAt(dueAt: string | null, dueAtState: AssignmentListItem["dueAtState"]): string {
  if (dueAtState === "known" && dueAt !== null) {
    return new Date(dueAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  if (dueAtState === "known_null") return "No deadline set";
  return "Due date unknown";
}

export interface AssignmentRowProps {
  readonly item: AssignmentListItem;
  readonly expanded: boolean;
  readonly detailId: string;
  readonly detail: ElementDescriptor;
  readonly completionPending: boolean;
  readonly completionFailed: boolean;
  readonly onToggleDetail: () => void;
  readonly onToggleCompletion: () => void;
}

/**
 * Icon + title + course code + due date/time + chevron + completion checkbox, per the Assignment
 * row primitive in `docs/DESIGN-SYSTEM.md`. The chevron expands/collapses `detail`
 * (`assignment-detail.ts`'s output), nested inside this row's own `<li>` rather than rendered as a
 * sibling `<div>` — a `<ul>`'s only valid direct child is `<li>`. The checkbox from
 * `completion-toggle.ts` is the *only* control wired to the personal-completion route — the row
 * itself carries no click-to-complete handler anywhere else.
 */
export function assignmentRow(props: AssignmentRowProps): ElementDescriptor {
  const { item } = props;
  const title = item.title ?? "Untitled assignment";
  const course = item.courseCode ?? item.courseTitle ?? "Unknown course";

  return {
    tag: "li",
    attrs: { class: "assignment-row" },
    children: [
      completionToggle({
        sourceItemId: item.sourceItemId,
        title,
        completed: item.completed,
        pending: props.completionPending,
        failed: props.completionFailed,
        onToggle: props.onToggleCompletion,
      }),
      {
        tag: "div",
        attrs: { class: "assignment-row__body" },
        children: [
          { tag: "span", attrs: { class: "assignment-row__title" }, text: title },
          {
            tag: "span",
            attrs: { class: "assignment-row__meta" },
            text: `${course} · ${formatDueAt(item.dueAt, item.dueAtState)}`,
          },
        ],
      },
      {
        tag: "button",
        attrs: {
          type: "button",
          class: "assignment-row__chevron",
          "aria-expanded": String(props.expanded),
          "aria-controls": props.detailId,
          "aria-label": `${props.expanded ? "Hide" : "Show"} details for ${title}`,
        },
        text: props.expanded ? "▲" : "▼",
        on: { click: props.onToggleDetail },
      },
      props.detail,
    ],
  };
}
