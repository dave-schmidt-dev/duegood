import type { ElementDescriptor } from "../dom";

/**
 * The This Week page's "truthful sync-status line" (`docs/DESIGN-SYSTEM.md`'s content-model
 * section) for a course that IS actively tracked — `connected_synced`/`never_synced`/`stale` are
 * derived from `GET /api/courses`' persisted fields, so they are correct on every page load,
 * including a cold reload. `syncing` and `partial_import` have no persisted backing (`importLeaseToken`
 * only proves a lease is held, and `ImportResult.status` only exists for the instant after a
 * `POST .../import` call returns) — phase 1 has no in-page control that triggers an import, so
 * those two variants exist for completeness/contract-test coverage today and become reachable
 * once a later phase adds a sync-now action. Rendering the wrong state on load is never
 * acceptable, so `never_synced` is a distinct, honestly-worded state rather than being folded
 * into `stale` or a fake timestamp.
 */
export type SyncStatusState =
  | { readonly kind: "connected_synced"; readonly lastSyncedAt: number }
  | { readonly kind: "never_synced" }
  | { readonly kind: "stale"; readonly lastSyncedAt: number }
  | { readonly kind: "syncing" }
  | { readonly kind: "partial_import" };

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusText(state: SyncStatusState): string {
  switch (state.kind) {
    case "connected_synced":
      return `Connected & synced ${formatTimestamp(state.lastSyncedAt)}`;
    case "never_synced":
      return "Connected. Not yet synced.";
    case "stale":
      return `Last synced ${formatTimestamp(state.lastSyncedAt)} — this may be out of date.`;
    case "syncing":
      return "Syncing…";
    case "partial_import":
      return "Partial import — some assignments may be missing or out of date.";
  }
}

/** `role="status"`/`aria-live="polite"` per the Accessibility primitives section — no status
 * region anywhere in this app may be a bare color change. */
export function syncStatus(state: SyncStatusState): ElementDescriptor {
  return {
    tag: "p",
    attrs: { class: `sync-status sync-status--${state.kind}`, role: "status", "aria-live": "polite" },
    text: statusText(state),
  };
}
