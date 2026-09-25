import type { ElementDescriptor } from "../dom";
import type { DesktopSnapshot } from "../transport";

/** Recovery choices are supplied by Rust, newest first; no snapshot path enters the webview. */
export interface DesktopRecoveryState {
  readonly snapshots: readonly DesktopSnapshot[];
  readonly importedAt: string | null;
  readonly busy: boolean;
  readonly message?: string;
  readonly filesDone?: number;
}
export interface DesktopRecoveryHandlers {
  readonly onRestore: (id: string) => void;
  readonly onExport: () => void;
  readonly onBack?: () => void;
}

function age(value: string, now: number): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "age unknown";
  const days = Math.max(0, Math.floor((now - at) / 86_400_000));
  return days === 0 ? "today" : days === 1 ? "1 day ago" : `${String(days)} days ago`;
}

/** Renders native recovery with snapshots before the age-labeled legacy import. */
export function desktopRecoveryPanel(state: DesktopRecoveryState, handlers: DesktopRecoveryHandlers, now = Date.now()): ElementDescriptor {
  const rows: ElementDescriptor[] = state.snapshots.map((snapshot) => ({
    tag: "li", attrs: { class: "recovery-snapshot" }, children: [
      { tag: "span", text: `${snapshot.kind === "daily" ? "Daily snapshot" : "Before refresh"} · ${age(snapshot.createdAt, now)}` },
      { tag: "button", attrs: { type: "button", ...(state.busy ? { disabled: "" } : {}) }, text: "Restore snapshot", on: { click: () => handlers.onRestore(snapshot.id) } },
    ],
  }));
  if (state.importedAt !== null) rows.push({ tag: "li", attrs: { class: "recovery-legacy" }, text: `Legacy import · ${age(state.importedAt, now)}` });
  return { tag: "section", attrs: { class: "setup-report", "aria-label": "Recovery points" }, children: [
    { tag: "h2", text: "Recovery points" },
    { tag: "p", text: "Restoring a snapshot archives the current store first. Existing backups are never deleted." },
    { tag: "ol", children: rows.length > 0 ? rows : [{ tag: "li", text: "No recovery points are available yet." }] },
    { tag: "button", attrs: { type: "button", ...(state.busy ? { disabled: "" } : {}) }, text: "Export rollback folder…", on: { click: handlers.onExport } },
    ...(handlers.onBack === undefined ? [] : [{ tag: "button", attrs: { type: "button", ...(state.busy ? { disabled: "" } : {}) }, text: "Back to dashboard", on: { click: handlers.onBack } }]),
    ...(state.message === undefined ? [] : [{ tag: "p", attrs: { role: "status", "aria-live": "polite" }, text: state.message }]),
    ...(state.filesDone === undefined ? [] : [{ tag: "p", attrs: { role: "status", "aria-live": "polite" }, text: `${String(state.filesDone)} files copied` }]),
  ] };
}
