import type { ElementDescriptor } from "../dom";
import type { DesktopSnapshot } from "../transport";

/** Recovery choices are supplied by Rust, newest first; no snapshot path enters the webview. */
export interface DesktopRecoveryState {
  readonly snapshots: readonly DesktopSnapshot[];
  readonly importedAt: string | null;
  readonly busy: boolean;
  readonly message?: string;
  readonly filesDone?: number;
  readonly loading?: boolean;
  readonly error?: string;
  /** The selected snapshot stays local until the user confirms the archive-and-restore action. */
  readonly pendingRestoreId?: string;
}
export interface DesktopRecoveryHandlers {
  readonly onRestore: (id: string) => void;
  readonly onConfirmRestore?: () => void;
  readonly onCancelRestore?: () => void;
  readonly onExport: () => void;
  readonly onBack?: () => void;
  readonly onRetry?: () => void;
}

function age(value: string, now: number): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "age unknown";
  const days = Math.max(0, Math.floor((now - at) / 86_400_000));
  return days === 0 ? "today" : days === 1 ? "1 day ago" : `${String(days)} days ago`;
}

/** Renders native recovery with snapshots before the age-labeled legacy import. */
export function desktopRecoveryPanel(state: DesktopRecoveryState, handlers: DesktopRecoveryHandlers, now = Date.now()): ElementDescriptor {
  const pendingRestore = state.pendingRestoreId === undefined ? undefined : state.snapshots.find((snapshot) => snapshot.id === state.pendingRestoreId);
  const rows: ElementDescriptor[] = state.snapshots.map((snapshot, index) => ({
    tag: "li", attrs: { class: "recovery-snapshot" }, children: [
      { tag: "span", text: `${snapshot.kind === "daily" ? "Daily snapshot" : "Before refresh"} · ${age(snapshot.createdAt, now)}` },
      { tag: "button", attrs: { type: "button", class: "more-action", "data-recovery-restore-index": String(index), ...(state.busy ? { disabled: "" } : {}) }, text: "Restore snapshot", on: { click: () => handlers.onRestore(snapshot.id) } },
    ],
  }));
  if (state.importedAt !== null) rows.push({ tag: "li", attrs: { class: "recovery-legacy" }, text: `Legacy import · ${age(state.importedAt, now)}` });
  const pendingList = state.loading === true || state.error !== undefined;
  return { tag: "section", attrs: { class: "setup-report", "aria-label": "Recovery points" }, children: [
    { tag: "h2", text: "Recovery points" },
    ...(pendingRestore === undefined ? [{ tag: "p", text: "Restoring a snapshot archives the current store first. Existing backups are never deleted." }] : []),
    { tag: "ol", children: rows.length > 0 ? rows : pendingList ? [] : [{ tag: "li", text: "No recovery points are available yet." }] },
    ...(state.loading === true ? [{ tag: "p", attrs: { class: "recovery-loading", role: "status", "aria-live": "polite", "aria-busy": "true" }, text: "Finding recovery points…" }] : []),
    ...(state.error === undefined ? [] : [{ tag: "p", attrs: { class: "recovery-error", role: "alert" }, text: state.error }]),
    ...(state.error === undefined || handlers.onRetry === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "more-action", ...(state.loading === true ? { disabled: "" } : {}) }, text: "Retry recovery points", on: { click: handlers.onRetry } }]),
    { tag: "button", attrs: { type: "button", class: "more-action", ...(state.busy ? { disabled: "" } : {}) }, text: "Export rollback folder…", on: { click: handlers.onExport } },
    ...(handlers.onBack === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "setup-secondary", ...(state.busy ? { disabled: "" } : {}) }, text: "Back to dashboard", on: { click: handlers.onBack } }]),
    ...(pendingRestore === undefined ? [] : [{ tag: "section", attrs: { role: "dialog", "aria-label": "Confirm snapshot restore", class: "setup-report" }, children: [
      { tag: "h3", text: "Restore this snapshot?" },
      { tag: "p", text: "Due Good archives the current app store before restoring this recovery point. Existing backups are never deleted." },
      { tag: "p", text: "Cancel leaves the current app store unchanged." },
      { tag: "div", attrs: { class: "setup-actions" }, children: [
        { tag: "button", attrs: { type: "button", class: "setup-secondary", "data-recovery-confirm-cancel": "true", ...(state.busy ? { disabled: "" } : {}) }, text: "Cancel", on: { click: () => handlers.onCancelRestore?.() } },
        { tag: "button", attrs: { type: "button", class: "sync-button", ...(state.busy ? { disabled: "", "aria-busy": "true" } : {}) }, text: state.busy ? "Restoring selected snapshot…" : "Restore selected snapshot", on: { click: () => handlers.onConfirmRestore?.() } },
      ] },
    ] }]),
    ...(state.message === undefined ? [] : [{ tag: "p", attrs: { role: "status", "aria-live": "polite" }, text: state.message }]),
    ...(state.filesDone === undefined ? [] : [{ tag: "p", attrs: { role: "status", "aria-live": "polite" }, text: `${String(state.filesDone)} files copied` }]),
  ] };
}
