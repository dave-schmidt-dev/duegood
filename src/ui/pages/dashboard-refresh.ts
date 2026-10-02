import type { ElementDescriptor } from "../dom";
import type { DashboardHandlers, DashboardRefresh, DashboardState, DesktopStoreInfo } from "./dashboard";

function calendarOnlyRefresh(state: DashboardState): boolean {
  return state.desktop?.browserRefreshAvailable !== true && state.desktop?.refreshAvailable !== true && state.desktop?.icalRefreshAvailable === true;
}

export function refreshActionLabel(state: DashboardState, refreshing: boolean, surface: "topbar" | "activity"): string {
  if (refreshing) return calendarOnlyRefresh(state) ? "Refreshing calendar…" : "Refreshing…";
  if (calendarOnlyRefresh(state)) return "Refresh calendar";
  return surface === "activity" ? "Refresh now" : "Refresh";
}

function formatted(value: string | number | null | undefined, withTime = false): string {
  if (value === null || value === undefined || value === "") return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const dateOnly = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat("en-US", withTime && !dateOnly
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" }).format(date);
}

export function refreshNote(state: DashboardState, latest: DashboardRefresh | undefined): string {
  if (state.refreshState === "running") {
    const progress = state.refreshProgress;
    const calendar = calendarOnlyRefresh(state);
    if (progress === undefined) return `${calendar ? "Calendar" : "Canvas"} refresh is in progress`;
    const phase = ({ starting: "Preparing", snapshot: "Saving safety copy", fetch: "Reading Canvas data", reconcile: "Reviewing changes", stage: "Preparing changes", publish: "Saving updates", "browser-capture": "Opening Canvas", "browser-import": "Importing Canvas coursework", calendar: "Refreshing calendar deadlines", "broker-starting": "Starting secure feed", "waiting-for-calendar": "Waiting for calendar", importing: "Importing calendar", complete: "Finishing" } as Readonly<Record<string, string>>)[progress.phase] ?? "Working";
    const count = progress.total === null ? `${String(progress.completed)} completed` : `${String(progress.completed)} of ${String(progress.total)} completed`;
    const full = state.desktop?.browserRefreshAvailable === true;
    return `${full ? "Canvas and calendar" : calendar ? "Calendar" : "Canvas"} refresh · ${phase}${calendar || full ? "" : ` · ${count}${progress.bytesDone === null ? "" : ` · ${String(progress.bytesDone)} bytes received`}`}`;
  }
  if (state.refreshDetail !== undefined) return state.refreshDetail;
  if (state.refreshState === "complete") return "Refresh complete.";
  if (state.refreshState === "partial") return latest?.source === "calendar" ? latest.summary : "Refresh incomplete. Existing data was kept.";
  if (state.refreshState === "failed") return "Refresh failed. Existing data was kept.";
  if (latest?.source === "calendar") return `${latest.summary} · ${formatted(latest.finishedAt ?? latest.startedAt, true)}`;
  if (state.desktop?.storeState === "preview") return state.desktop.importedAt === null ? "Imported copy" : `Imported ${formatted(state.desktop.importedAt, true)}`;
  if (state.desktop?.lastRefreshAt) return `Updated ${formatted(state.desktop.lastRefreshAt, true)}`;
  return latest === undefined ? "Not yet refreshed" : `Updated ${formatted(latest.startedAt, true)}`;
}

export function refreshOutcome(state: DashboardState): ElementDescriptor[] {
  const feedback = state.refreshDetail;
  if (state.refreshState === "failed") return [{ tag: "p", text: feedback ?? "Refresh failed. Existing data was kept.", attrs: { class: "inline-error", role: "status", "aria-live": "polite" } }];
  if (state.refreshState === "partial") return [{ tag: "p", text: feedback ?? "Refresh incomplete. Existing data was kept; this run may not include complete Canvas history.", attrs: { class: "refresh-status partial", role: "status", "aria-live": "polite" } }];
  if (state.refreshState === "complete") return [{ tag: "p", text: feedback ?? "Refresh complete.", attrs: { class: "inline-success", role: "status", "aria-live": "polite" } }];
  return [];
}

export function canvasRefreshSettingRow(desktop: DesktopStoreInfo, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  if (desktop.browserRefreshAvailable === true) return {
    tag: "div", attrs: { class: "settings-row" }, children: [
      { tag: "div", children: [{ tag: "strong", text: "Canvas refresh" }, { tag: "span", text: "Full refresh is available. It reads Canvas through the bundled browser and then updates calendar deadlines; Canvas may ask you to sign in." }] },
    ],
  };
  const enabled = desktop.canvasRefreshEnabled === true;
  const available = desktop.refreshAvailable === true;
  return {
    tag: "label", attrs: { class: "settings-row" }, children: [
      { tag: "span", children: [{ tag: "strong", text: "Canvas refresh" }, { tag: "span", text: enabled ? (available ? "Canvas refresh can be attempted on this computer." : "Canvas refresh is unavailable on this computer.") : "Canvas refresh is off." }] },
      { tag: "input", attrs: { type: "checkbox", "aria-label": "Enable Canvas refresh", ...(enabled ? { checked: "" } : {}), ...((state.refreshSettingPending === true || state.refreshState === "running") ? { disabled: "" } : {}) }, on: { change: (event: Event) => handlers.onToggleCanvasRefresh?.((event.currentTarget as HTMLInputElement).checked) } },
    ],
  };
}
