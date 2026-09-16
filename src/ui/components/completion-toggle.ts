import type { ElementDescriptor } from "../dom";

export interface CompletionToggleProps {
  readonly sourceItemId: string;
  readonly title: string;
  readonly completed: boolean;
  /** A request is currently in flight — checkbox and retry button are disabled while true. */
  readonly pending: boolean;
  /** The most recent mutation attempt failed — renders the retry affordance and an accessible
   * status message, never a silently-reverted checkbox with no explanation. */
  readonly failed: boolean;
  /** Fires on both a checkbox click and a retry-button click; the caller (the This Week page)
   * owns the actual `POST /api/source-items/:id/completion` call, the optimistic/revert state
   * transitions, and the re-render — this component only describes what's currently true. */
  readonly onToggle: () => void;
}

/**
 * The *only* control bound to the personal-completion route (see `assignment-row.ts`'s doc
 * comment). On a failed request the checkbox is left showing the pre-toggle value (the page
 * recomputes `completed` back to the server-confirmed state before re-rendering) and a `role="status"`
 * message plus a "Retry" button appear — an honest failure the student can act on, never a value
 * that silently "sticks" in the optimistic state.
 */
export function completionToggle(props: CompletionToggleProps): ElementDescriptor {
  const checkboxId = `completion-${props.sourceItemId}`;
  const children: ElementDescriptor[] = [
    {
      tag: "input",
      attrs: {
        type: "checkbox",
        id: checkboxId,
        class: "completion-toggle__input",
        "aria-label": `Mark "${props.title}" complete`,
        ...(props.completed ? { checked: "" } : {}),
        ...(props.pending ? { disabled: "" } : {}),
      },
      on: { change: props.onToggle },
    },
  ];

  if (props.failed) {
    children.push(
      { tag: "span", attrs: { class: "completion-toggle__status", role: "status", "aria-live": "polite" }, text: "Save failed. Retry?" },
      {
        tag: "button",
        attrs: { type: "button", class: "completion-toggle__retry", ...(props.pending ? { disabled: "" } : {}) },
        text: "Retry",
        on: { click: props.onToggle },
      },
    );
  }

  return { tag: "span", attrs: { class: "completion-toggle" }, children };
}
