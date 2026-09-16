import type { AssignmentListItem } from "../../db/types";
import { assignmentDetail } from "../components/assignment-detail";
import { assignmentRow } from "../components/assignment-row";
import { recoveryPanel, type RecoveryState } from "../components/recovery-panel";
import { syncStatus, type SyncStatusState } from "../components/sync-status";
import type { ElementDescriptor } from "../dom";
import { primaryNav } from "../routes";

export interface AssignmentUiState {
  readonly expanded: boolean;
  readonly pending: boolean;
  readonly failed: boolean;
}

const DEFAULT_ASSIGNMENT_UI: AssignmentUiState = { expanded: false, pending: false, failed: false };

/**
 * Everything `renderThisWeekPage` needs to describe the page for one render pass. Deliberately
 * plain data, no fetch/DOM references, so `test/ui/phase1-trust-interface.test.ts` can construct
 * one directly and assert on the returned descriptor tree — the actual fetching/state-management
 * loop lives in `src/ui/app.ts`, the only module in `src/ui/` allowed to touch `fetch`/`document`.
 */
export interface ThisWeekPageState {
  readonly currentPath: string;
  readonly loading: boolean;
  /** `undefined` while `loading`; once loaded, exactly one of `recovery`/`sync` is set — a course
   * is either actively tracked (sync) or it isn't (recovery), never both. */
  readonly recovery: RecoveryState | undefined;
  readonly sync: SyncStatusState | undefined;
  readonly assignments: readonly AssignmentListItem[];
  readonly assignmentUi: ReadonlyMap<string, AssignmentUiState>;
}

export interface ThisWeekPageHandlers {
  readonly onToggleDetail: (sourceItemId: string) => void;
  readonly onToggleCompletion: (sourceItemId: string) => void;
}

function skeleton(): ElementDescriptor {
  return {
    tag: "ul",
    attrs: { class: "assignment-list assignment-list--skeleton", "aria-hidden": "true" },
    children: [0, 1, 2].map(() => ({ tag: "li", attrs: { class: "assignment-row assignment-row--skeleton" } })),
  };
}

function assignmentList(state: ThisWeekPageState, handlers: ThisWeekPageHandlers): ElementDescriptor {
  if (state.assignments.length === 0) {
    return { tag: "p", attrs: { class: "assignment-list__empty" }, text: "No assignments imported yet." };
  }
  return {
    tag: "ul",
    attrs: { class: "assignment-list" },
    children: state.assignments.map((item) => {
      const ui = state.assignmentUi.get(item.sourceItemId) ?? DEFAULT_ASSIGNMENT_UI;
      const detailId = `assignment-detail-${item.sourceItemId}`;
      return assignmentRow({
        item,
        expanded: ui.expanded,
        detailId,
        detail: assignmentDetail({ item, id: detailId, hidden: !ui.expanded }),
        completionPending: ui.pending,
        completionFailed: ui.failed,
        onToggleDetail: () => handlers.onToggleDetail(item.sourceItemId),
        onToggleCompletion: () => handlers.onToggleCompletion(item.sourceItemId),
      });
    }),
  };
}

/** Pure composition of the This Week route: nav, heading, truthful status line, and the
 * assignment list (or its loading/empty/recovery substitute) — see `docs/DESIGN-SYSTEM.md`'s
 * "This Week — phase-1 content model" section for the exact set this omits (no stat tiles, no
 * Today/Tomorrow grouping, no quick actions, no mini-calendar, no quote card). */
export function renderThisWeekPage(state: ThisWeekPageState, handlers: ThisWeekPageHandlers): ElementDescriptor {
  const statusRegion: ElementDescriptor = state.loading
    ? { tag: "p", attrs: { class: "sync-status", role: "status", "aria-live": "polite" }, text: "Loading…" }
    : (state.recovery !== undefined ? recoveryPanel(state.recovery) : syncStatus(state.sync as SyncStatusState));

  return {
    tag: "div",
    attrs: { class: "shell" },
    children: [
      primaryNav(state.currentPath),
      {
        tag: "main",
        attrs: { id: "main", class: "panel", tabindex: "-1" },
        children: [
          { tag: "h1", text: "This Week" },
          statusRegion,
          {
            tag: "section",
            attrs: { "aria-label": "This week's assignments" },
            children: [state.loading ? skeleton() : (state.recovery === undefined ? assignmentList(state, handlers) : { tag: "div", attrs: { hidden: "" } })],
          },
        ],
      },
    ],
  };
}
