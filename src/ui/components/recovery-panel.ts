import type { ElementDescriptor } from "../dom";

/**
 * The states that need an explanation plus a recovery action, rather than a passive status line
 * (`sync-status.ts` handles the passive "course is tracked and syncing normally" line). `quota_exhausted`
 * and `retrying` mirror `ImportResult.status`/reason from `src/import/course-import.ts`, so — like
 * `sync-status.ts`'s `syncing`/`partial_import` — they have no persisted backing and become
 * reachable once a later phase wires an in-page import trigger; they exist here now for contract
 * coverage and so the recovery copy is decided once, not invented ad hoc later.
 */
export type RecoveryState =
  | { readonly kind: "disconnected" }
  | { readonly kind: "no_course_selected" }
  | { readonly kind: "quota_exhausted" }
  | { readonly kind: "retrying" };

function heading(state: RecoveryState): string {
  switch (state.kind) {
    case "disconnected":
      return "No Canvas connection";
    case "no_course_selected":
      return "No course connected yet";
    case "quota_exhausted":
      return "Sync paused";
    case "retrying":
      return "Retrying sync";
  }
}

function detail(state: RecoveryState): string {
  switch (state.kind) {
    case "disconnected":
      return "Connect your Canvas account to see your assignments here.";
    case "no_course_selected":
      return "Your Canvas account is connected, but no course has been selected yet.";
    case "quota_exhausted":
      return "Canvas declined the last sync request (rate limit or quota). It will be retried automatically.";
    case "retrying":
      return "A previous sync attempt failed and is being retried now.";
  }
}

/** `role="status"`/`aria-live="polite"`, matching every other status region in this app — the
 * recovery-state browser test asserts on this exact semantic, not on visual placement. */
export function recoveryPanel(state: RecoveryState): ElementDescriptor {
  const children: ElementDescriptor[] = [
    { tag: "strong", text: heading(state) },
    { tag: "span", text: ` ${detail(state)}` },
  ];
  if (state.kind === "disconnected") {
    children.push({ tag: "a", attrs: { class: "recovery-panel__action", href: "/auth/canvas/start" }, text: "Connect to Canvas" });
  }
  return {
    tag: "div",
    attrs: { class: `recovery-panel recovery-panel--${state.kind}`, role: "status", "aria-live": "polite" },
    children,
  };
}
