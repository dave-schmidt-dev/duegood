import type { AssignmentListItem } from "../db/types";
import type { RecoveryState } from "./components/recovery-panel";
import { STALE_AFTER_MS, type SyncStatusState } from "./components/sync-status";
import { CSRF_HEADER_NAME, readCsrfToken } from "./csrf";
import { render, type ElementDescriptor } from "./dom";
import { type AssignmentUiState, renderThisWeekPage, type ThisWeekPageHandlers, type ThisWeekPageState } from "./pages/this-week";

const DEFAULT_ASSIGNMENT_UI: AssignmentUiState = { expanded: false, pending: false, failed: false };

function element(tag: string, attrs: Record<string, string> = {}, text?: string): ElementDescriptor {
  return { tag, attrs, ...(text !== undefined ? { text } : {}) };
}

/**
 * The pre-auth "Canvas connection unavailable" shell — ported from the original `src/ui/router.ts`
 * scaffold verbatim (same copy, same structure) so `test/browser/shell.spec.ts` keeps passing
 * unchanged. Rendered whenever `/api/auth/status` reports authentication isn't configured, which
 * is exactly the condition the previous scaffold assumed unconditionally.
 */
function renderDisabledShell(mount: HTMLElement): void {
  const status = element("div", { class: "status", role: "status", "aria-live": "polite" });
  const shell: ElementDescriptor = {
    tag: "div",
    attrs: { class: "shell" },
    children: [
      {
        tag: "main",
        attrs: { id: "main", class: "panel", tabindex: "-1" },
        children: [
          element("p", { class: "eyebrow" }, "Local foundation"),
          element("h1", {}, "Due Good"),
          element(
            "p",
            {},
            "A private student planning workspace is being prepared. No Canvas account is connected in this local scaffold.",
          ),
          { ...status, children: [element("strong", {}, "Canvas connection unavailable"), element("span", {}, " Institution-enabled OAuth has not been configured.")] },
        ],
      },
    ],
  };
  mount.replaceChildren(render(shell));

  const statusNode = mount.querySelector(".status");
  if (window.isSecureContext && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      statusNode?.replaceChildren(
        render(element("strong", {}, "Local app shell unavailable")),
        render(element("span", {}, " Reload after the secure test origin is ready.")),
      );
    });
  }
}

interface ConnectionSummary {
  readonly id: string;
  readonly status: "active" | "revoked";
  readonly createdAt: number;
}

interface CourseSummary {
  readonly id: string;
  readonly courseCode: string | null;
  readonly title: string | null;
  readonly lastSuccessfulCheckAt: number | null;
  readonly syncing: boolean;
}

function computeSyncStatus(course: CourseSummary): SyncStatusState {
  if (course.syncing) return { kind: "syncing" };
  if (course.lastSuccessfulCheckAt === null) return { kind: "never_synced" };
  const age = Date.now() - course.lastSuccessfulCheckAt;
  if (age > STALE_AFTER_MS) return { kind: "stale", lastSyncedAt: course.lastSuccessfulCheckAt };
  return { kind: "connected_synced", lastSyncedAt: course.lastSuccessfulCheckAt };
}

interface LoadedThisWeekData {
  readonly recovery: RecoveryState | undefined;
  readonly sync: SyncStatusState | undefined;
  readonly assignments: readonly AssignmentListItem[];
}

/** The one network round trip this page's data depends on, split across three session-guarded
 * `GET`s (`/api/connections`, `/api/courses`, `/api/assignments`) since that's the actual route
 * surface — see `src/auth/routes.ts`. A 401 on any of them reads as "no session", which collapses
 * to the same disconnected recovery state as "no active connection" from the caller's point of
 * view; there is no separate "signed out" UI in phase 1. */
async function loadThisWeekData(): Promise<LoadedThisWeekData> {
  const connectionsResponse = await fetch("/api/connections", { credentials: "same-origin" });
  if (connectionsResponse.status === 401) return { recovery: { kind: "disconnected" }, sync: undefined, assignments: [] };
  const connectionsBody = (await connectionsResponse.json()) as { connections: ConnectionSummary[] };
  const hasActiveConnection = connectionsBody.connections.some((connection) => connection.status === "active");
  if (!hasActiveConnection) return { recovery: { kind: "disconnected" }, sync: undefined, assignments: [] };

  const [coursesResponse, assignmentsResponse] = await Promise.all([
    fetch("/api/courses", { credentials: "same-origin" }),
    fetch("/api/assignments", { credentials: "same-origin" }),
  ]);
  if (coursesResponse.status === 401 || assignmentsResponse.status === 401) {
    return { recovery: { kind: "disconnected" }, sync: undefined, assignments: [] };
  }
  const coursesBody = (await coursesResponse.json()) as { courses: CourseSummary[] };
  const assignmentsBody = (await assignmentsResponse.json()) as { assignments: AssignmentListItem[] };

  const [course] = coursesBody.courses;
  if (course === undefined) return { recovery: { kind: "no_course_selected" }, sync: undefined, assignments: [] };

  return { recovery: undefined, sync: computeSyncStatus(course), assignments: assignmentsBody.assignments };
}

function mountThisWeek(mount: HTMLElement): void {
  let state: ThisWeekPageState = {
    currentPath: window.location.pathname,
    loading: true,
    recovery: undefined,
    sync: undefined,
    assignments: [],
    assignmentUi: new Map(),
  };

  function draw(): void {
    mount.replaceChildren(render(renderThisWeekPage(state, handlers)));
  }

  function patchUi(sourceItemId: string, patch: Partial<AssignmentUiState>): void {
    const current = state.assignmentUi.get(sourceItemId) ?? DEFAULT_ASSIGNMENT_UI;
    const next = new Map(state.assignmentUi);
    next.set(sourceItemId, { ...current, ...patch });
    state = { ...state, assignmentUi: next };
  }

  function patchAssignment(sourceItemId: string, patch: Partial<AssignmentListItem>): void {
    state = {
      ...state,
      assignments: state.assignments.map((item) => (item.sourceItemId === sourceItemId ? { ...item, ...patch } : item)),
    };
  }

  async function toggleCompletion(sourceItemId: string): Promise<void> {
    const item = state.assignments.find((candidate) => candidate.sourceItemId === sourceItemId);
    if (item === undefined) return;
    const previousCompleted = item.completed;
    const target = !previousCompleted;

    patchAssignment(sourceItemId, { completed: target });
    patchUi(sourceItemId, { pending: true, failed: false });
    draw();

    const csrfToken = readCsrfToken();
    if (csrfToken === undefined) {
      patchAssignment(sourceItemId, { completed: previousCompleted });
      patchUi(sourceItemId, { pending: false, failed: true });
      draw();
      return;
    }

    try {
      const response = await fetch(`/api/source-items/${encodeURIComponent(sourceItemId)}/completion`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", [CSRF_HEADER_NAME]: csrfToken },
        body: JSON.stringify({ completed: target }),
      });
      if (!response.ok) throw new Error(`completion request failed with status ${String(response.status)}`);
      const body = (await response.json()) as { completed: boolean; completedAt: number | null };
      patchAssignment(sourceItemId, { completed: body.completed, completedAt: body.completedAt });
      patchUi(sourceItemId, { pending: false, failed: false });
    } catch {
      patchAssignment(sourceItemId, { completed: previousCompleted });
      patchUi(sourceItemId, { pending: false, failed: true });
    }
    draw();
  }

  const handlers: ThisWeekPageHandlers = {
    onToggleDetail(sourceItemId) {
      const current = state.assignmentUi.get(sourceItemId) ?? DEFAULT_ASSIGNMENT_UI;
      patchUi(sourceItemId, { expanded: !current.expanded });
      draw();
    },
    onToggleCompletion(sourceItemId) {
      void toggleCompletion(sourceItemId);
    },
  };

  draw();

  void loadThisWeekData().then((data) => {
    state = { ...state, loading: false, recovery: data.recovery, sync: data.sync, assignments: data.assignments };
    draw();
  });

  if (window.isSecureContext && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
}

/** The single browser entry point — the only module in `src/ui/` that touches `document`/`fetch`.
 * Every component and page module stays a pure function of props/state, per `src/ui/dom.ts`'s doc
 * comment. `/api/auth/status` decides which of the two top-level shells to render; there is no
 * client-side guess at server configuration beyond that one read. */
export function mount(): void {
  const mountEl = document.querySelector<HTMLElement>("#app");
  if (!mountEl) throw new Error("Missing application mount point.");

  fetch("/api/auth/status", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : { available: false }))
    .then((body) => {
      const available = typeof body === "object" && body !== null && (body as { available?: unknown }).available === true;
      if (available) mountThisWeek(mountEl);
      else renderDisabledShell(mountEl);
    })
    .catch(() => renderDisabledShell(mountEl));
}
