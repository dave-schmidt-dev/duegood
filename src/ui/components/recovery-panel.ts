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
  | { readonly kind: "disconnected"; readonly oauthConfigured: boolean }
  | { readonly kind: "no_course_selected" }
  | { readonly kind: "quota_exhausted" }
  | { readonly kind: "retrying" };

/** State for the Personal-Access-Token connect form, rendered only when `disconnected` and OAuth
 * isn't configured — see `docs/OAUTH-REQUEST-CHECKLIST.md`. Owned and mutated by `src/ui/app.ts`,
 * same as `AssignmentUiState`; this component only describes what's currently true. */
export interface TokenConnectState {
  readonly value: string;
  readonly pending: boolean;
  /** Set from the connect request's rejection reason — never the token itself. */
  readonly error: string | undefined;
}

export interface TokenConnectHandlers {
  readonly onTokenInput: (value: string) => void;
  readonly onTokenSubmit: () => void;
}

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

const TOKEN_INPUT_ID = "canvas-personal-token";

/** Owner-only escape hatch around the OAuth admin-approval dependency (TASKS.md) — rendered only
 * when `/api/auth/status` reports no OAuth client is configured. `type="password"` so the pasted
 * token isn't shown on screen or picked up by a shoulder-surf/screen-share, same reasoning as any
 * other credential field; `autocomplete="off"` since this isn't a login the browser should offer
 * to save on the app's own behalf (the user's own password manager can still fill it manually). */
function tokenConnectForm(tokenConnect: TokenConnectState, handlers: TokenConnectHandlers): ElementDescriptor {
  const children: ElementDescriptor[] = [
    { tag: "label", attrs: { for: TOKEN_INPUT_ID, class: "recovery-panel__label" }, text: "Canvas Personal Access Token" },
    {
      tag: "input",
      attrs: {
        type: "password",
        id: TOKEN_INPUT_ID,
        class: "recovery-panel__token-input",
        autocomplete: "off",
        value: tokenConnect.value,
        ...(tokenConnect.pending ? { disabled: "" } : {}),
      },
      on: { input: (event) => handlers.onTokenInput((event.target as HTMLInputElement).value) },
    },
    {
      tag: "button",
      attrs: { type: "submit", class: "recovery-panel__action", ...(tokenConnect.pending ? { disabled: "" } : {}) },
      text: tokenConnect.pending ? "Connecting…" : "Connect",
    },
  ];
  if (tokenConnect.error !== undefined) {
    children.push({ tag: "span", attrs: { class: "recovery-panel__error", role: "status", "aria-live": "polite" }, text: tokenConnect.error });
  }
  return {
    tag: "form",
    attrs: { class: "recovery-panel__token-form" },
    children,
    on: {
      submit: (event) => {
        event.preventDefault();
        handlers.onTokenSubmit();
      },
    },
  };
}

/** `role="status"`/`aria-live="polite"`, matching every other status region in this app — the
 * recovery-state browser test asserts on this exact semantic, not on visual placement.
 * `tokenConnect`/`handlers` are required only for the `disconnected`+no-OAuth-client case; every
 * other state (and `disconnected` with OAuth configured) ignores them. */
export function recoveryPanel(state: RecoveryState, tokenConnect?: TokenConnectState, handlers?: TokenConnectHandlers): ElementDescriptor {
  const children: ElementDescriptor[] = [
    { tag: "strong", text: heading(state) },
    { tag: "span", text: ` ${detail(state)}` },
  ];
  if (state.kind === "disconnected") {
    if (state.oauthConfigured) {
      children.push({ tag: "a", attrs: { class: "recovery-panel__action", href: "/auth/canvas/start" }, text: "Connect to Canvas" });
    } else if (tokenConnect !== undefined && handlers !== undefined) {
      children.push(tokenConnectForm(tokenConnect, handlers));
    }
  }
  return {
    tag: "div",
    attrs: { class: `recovery-panel recovery-panel--${state.kind}`, role: "status", "aria-live": "polite" },
    children,
  };
}
