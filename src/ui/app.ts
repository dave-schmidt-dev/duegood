import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { render, type ElementDescriptor } from "./dom";
import {
  renderDashboard,
  formatAssignmentCopyText,
  type DashboardData,
  type DashboardHandlers,
  type DashboardState,
  type DesktopStoreInfo,
} from "./pages/dashboard";
import { parseDashboard } from "./dashboard-response";
export { dashboardEventKind, parseDashboard } from "./dashboard-response";
import { DASHBOARD_ROUTES, type DashboardPage } from "./routes";
import { renderDesktopSetup, setupError, setupPanel, type DesktopSetupHandlers, type DesktopSetupState } from "./desktop-setup";
export { renderDesktopSetup } from "./desktop-setup";
export type { DesktopSetupHandlers, DesktopSetupState } from "./desktop-setup";
import {
  createNativeTransport,
  DesktopCommandError,
  type DesktopStoreStatus,
  type CanvasRefreshProgress,
  type IcalRefreshProgress,
  type IcalRefreshResult,
  type StoreTransitionProgress,
  type NativeTransport,
} from "./transport";

function element(tag: string, attrs: Record<string, string> = {}, text?: string): ElementDescriptor {
  return { tag, attrs, ...(text !== undefined ? { text } : {}) };
}

const EMPTY_DATA: DashboardData = { version: "", courses: [], events: [], pendingSourceLinks: [], resources: [], conversations: [], refreshes: [], profile: null, refreshAvailable: false, sourceStatus: {} };

function desktopRefreshAvailable(info: DesktopStoreInfo | undefined): boolean { return info?.refreshAvailable === true || info?.icalRefreshAvailable === true; }

function pageFromHash(): DashboardPage {
  const candidate = window.location.hash.replace(/^#/, "");
  return DASHBOARD_ROUTES.some((route) => route.page === candidate) ? candidate as DashboardPage : "timeline";
}

function replaced(set: ReadonlySet<string>, id: string, include: boolean): ReadonlySet<string> { const next = new Set(set); if (include) next.add(id); else next.delete(id); return next; }

/** Desktop-only dashboard context: the store the data came from and the replace action. */
interface DesktopDashboardOptions {
  readonly info: DesktopStoreInfo;
  readonly onReplacePreview?: () => void;
  readonly onRecovery?: () => void;
  readonly onExport?: () => void;
}

/** Native per-item conflicts always trigger a fresh document read before the notice is shown. */
export async function resolveNativeMutationConflict(error: unknown, reload: () => Promise<boolean>, subject: "item" | "discussion"): Promise<{ readonly reloaded: boolean; readonly message: string }> {
  if (!(error instanceof DesktopCommandError) || error.code !== "item-conflict") return { reloaded: false, message: error instanceof Error ? error.message : "Could not save. Existing state was restored." };
  const reloaded = await reload();
  return { reloaded, message: reloaded ? `This ${subject} changed elsewhere. Latest state reloaded; try again.` : `This ${subject} changed elsewhere. Reload the page and try again.` };
}

/** Mounts the dashboard; returns a disposer so the desktop shell can swap screens cleanly. */
function mountDashboard(mount: HTMLElement, transport: NativeTransport, desktop: DesktopDashboardOptions): () => void {
  let avatarUrl: string | undefined;
  let state: DashboardState = { page: pageFromHash(), loading: true, data: { ...EMPTY_DATA, refreshAvailable: desktop.info.refreshAvailable === true }, now: Date.now(), eventMode: "all", courseFilter: "all", gradeCourseFilter: "all", gradeMode: "all", resourceFilter: "all", expandedEventIds: new Set(), pendingCompletionIds: new Set(), failedCompletionIds: new Set(), pendingDiscussionIds: new Set(), failedDiscussionIds: new Set(), pendingManualGradeIds: new Set(), failedManualGradeIds: new Set(), refreshState: "idle", desktop: desktop.info };
  let disposed = false;
  let snapshotStatusTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new AbortController();

  function draw(): void { if (disposed) return; state = { ...state, now: Date.now() }; mount.replaceChildren(render(renderDashboard(state, handlers))); }
  async function withAvatar(data: DashboardData): Promise<DashboardData> {
    if (data.profile === null) return data;
    const avatar = await transport.readAvatar().catch(() => null);
    if (avatarUrl !== undefined) URL.revokeObjectURL(avatarUrl);
    avatarUrl = avatar === null ? undefined : URL.createObjectURL(new Blob([new Uint8Array(avatar.bytes).buffer], { type: avatar.contentType }));
    return { ...data, profile: { ...data.profile, avatarPath: avatarUrl ?? null } };
  }
  async function load(): Promise<void> {
    try {
      const data = await withAvatar(parseDashboard(await transport.loadDashboardBody(false)));
      state = { ...state, loading: false, error: undefined, data: { ...data, refreshAvailable: desktopRefreshAvailable(state.desktop) }, selectedConversationId: state.selectedConversationId ?? data.conversations[0]?.id, selectedRefreshId: state.selectedRefreshId ?? data.refreshes[0]?.id };
    } catch (error) {
      const detail = error instanceof DesktopCommandError ? ` ${error.message}` : "";
      state = { ...state, loading: false, error: `Coursework could not be loaded. No substitute or sample data was shown.${detail}` };
    }
    draw();
  }

  async function pollStartupSnapshot(): Promise<void> {
    if (disposed || state.desktop?.snapshotInProgress !== true) return;
    try {
      const status = await transport.storeStatus();
      if (disposed) return;
      if (status.availability === "ready" && (status.state === "preview" || status.state === "authoritative")) {
        state = { ...state, desktop: { ...state.desktop!, canvasRefreshEnabled: status.canvasRefreshEnabled, refreshAvailable: status.refreshAvailable, icalRefreshAvailable: status.icalRefreshAvailable, snapshotInProgress: status.snapshotInProgress, snapshotProgress: status.snapshotProgress, warning: status.problem }, data: { ...state.data, refreshAvailable: status.refreshAvailable || status.icalRefreshAvailable } };
        draw();
      }
      if (status.snapshotInProgress) snapshotStatusTimer = setTimeout(() => { void pollStartupSnapshot(); }, 500);
    } catch {
      if (!disposed) snapshotStatusTimer = setTimeout(() => { void pollStartupSnapshot(); }, 2000);
    }
  }

  async function reloadAuthoritativeDashboard(): Promise<boolean> {
    try {
      const data = await withAvatar(parseDashboard(await transport.loadDashboardBody(true)));
      state = { ...state, data: { ...data, refreshAvailable: state.desktop?.refreshAvailable === true }, selectedConversationId: data.conversations.some((conversation) => conversation.id === state.selectedConversationId) ? state.selectedConversationId : data.conversations[0]?.id, selectedRefreshId: data.refreshes[0]?.id };
      return true;
    } catch {
      return false;
    }
  }

  function selectPendingLink(id: string): void {
    if (!state.data.pendingSourceLinks.some((link) => link.id === id)) return;
    state = { ...state, selectedPendingLinkId: id, selectedPendingLinkCandidateId: undefined, pendingLinkDecision: undefined, pendingLinkNotice: undefined };
    draw();
  }

  function selectPendingLinkCandidate(id: string): void {
    const selected = state.data.pendingSourceLinks.find((link) => link.id === state.selectedPendingLinkId) ?? state.data.pendingSourceLinks[0];
    if (selected === undefined || !selected.candidateIds.includes(id)) return;
    state = { ...state, selectedPendingLinkId: selected.id, selectedPendingLinkCandidateId: id, pendingLinkDecision: undefined, pendingLinkNotice: undefined };
    draw();
  }

  function openPendingLinkDecision(decision: "confirm" | "reject"): void {
    const selected = state.data.pendingSourceLinks.find((link) => link.id === state.selectedPendingLinkId) ?? state.data.pendingSourceLinks[0];
    if (selected === undefined || selected.needsRefresh === true) return;
    const candidateId = selected.candidateIds.length === 1 ? selected.candidateIds[0] : state.selectedPendingLinkCandidateId;
    if (decision === "confirm" && (candidateId === undefined || !selected.candidateIds.includes(candidateId))) {
      state = { ...state, pendingLinkNotice: "Choose a local candidate before confirming this link." };
      draw();
      return;
    }
    state = { ...state, selectedPendingLinkId: selected.id, ...(candidateId === undefined ? {} : { selectedPendingLinkCandidateId: candidateId }), pendingLinkDecision: decision, pendingLinkNotice: undefined };
    draw();
  }

  function cancelPendingLinkDecision(): void {
    if (state.pendingLinkSaving === true) return;
    state = { ...state, pendingLinkDecision: undefined, pendingLinkNotice: "Cancelled. This suggestion is still pending; coursework did not change." };
    draw();
  }

  async function resolvePendingLink(): Promise<void> {
    const selected = state.data.pendingSourceLinks.find((link) => link.id === state.selectedPendingLinkId) ?? state.data.pendingSourceLinks[0];
    const decision = state.pendingLinkDecision;
    const candidateId = selected?.candidateIds.length === 1 ? selected.candidateIds[0] : state.selectedPendingLinkCandidateId;
    if (selected === undefined || selected.needsRefresh === true || decision === undefined || state.data.version.length !== 64 || (decision === "confirm" && (candidateId === undefined || !selected.candidateIds.includes(candidateId)))) return;
    state = { ...state, pendingLinkSaving: true, pendingLinkNotice: undefined }; draw();
    try {
      await transport.resolvePendingSourceLink(selected.id, decision === "confirm" ? candidateId! : "", decision, state.data.version);
      const reloaded = await reloadAuthoritativeDashboard();
      state = { ...state, pendingLinkSaving: false, pendingLinkDecision: undefined, pendingLinkNotice: reloaded ? (decision === "confirm" ? "Link confirmed. The original local item was kept." : "Records kept distinct. The Canvas item is now separate.") : "Decision saved. Reload to view current coursework." };
    } catch {
      state = { ...state, pendingLinkSaving: false, pendingLinkNotice: "The decision was not saved. Coursework was unchanged." };
    }
    draw();
  }

  async function toggleCompletion(id: string): Promise<void> {
    const item = state.data.events.find((event) => event.id === id); if (item === undefined || item.kind === "class") return;
    const target = !item.completed; const sourceItemId = item.sourceItemId ?? item.id;
    const update = (completed: boolean, completedAt: number | null) => state.data.events.map((event) => event.id === id ? { ...event, completed, completedAt } : event);
    state = { ...state, data: { ...state.data, events: update(target, target ? Date.now() : null) }, pendingCompletionIds: replaced(state.pendingCompletionIds, id, true), failedCompletionIds: replaced(state.failedCompletionIds, id, false), mutationError: undefined }; draw();
    try {
      const result = await transport.setCompletion(sourceItemId, item.completed, target);
      state = { ...state, data: { ...state.data, events: update(result.completed, result.completedAt) }, pendingCompletionIds: replaced(state.pendingCompletionIds, id, false) };
      draw();
      return;
    } catch (error) {
      const failure = await resolveNativeMutationConflict(error, reloadAuthoritativeDashboard, "item");
      state = { ...state, data: failure.reloaded ? state.data : { ...state.data, events: update(item.completed, item.completedAt ?? null) }, pendingCompletionIds: replaced(state.pendingCompletionIds, id, false), failedCompletionIds: replaced(state.failedCompletionIds, id, true), mutationError: { id, message: failure.message } };
    }
    draw();
  }

  async function toggleDiscussion(id: string, field: "post" | "replies"): Promise<void> {
    const item = state.data.events.find((event) => event.id === id); if (item === undefined || item.kind !== "discussion") return;
    const before = { post: item.discussionPostDone === true, replies: item.discussionRepliesDone === true };
    const target = { post: field === "post" ? !before.post : before.post, replies: field === "replies" ? !before.replies : before.replies };
    const update = (post: boolean, replies: boolean) => state.data.events.map((event) => event.id === id ? { ...event, discussionPostDone: post, discussionRepliesDone: replies } : event);
    state = { ...state, data: { ...state.data, events: update(target.post, target.replies) }, pendingDiscussionIds: replaced(state.pendingDiscussionIds, id, true), failedDiscussionIds: replaced(state.failedDiscussionIds, id, false), mutationError: undefined }; draw();
    try {
      const result = await transport.setDiscussionField(item.sourceItemId ?? item.id, field, before[field], target[field]);
      state = { ...state, data: { ...state.data, events: update(result.discussionPostDone, result.discussionRepliesDone) }, pendingDiscussionIds: replaced(state.pendingDiscussionIds, id, false) };
      draw();
      return;
    } catch (error) {
      const failure = await resolveNativeMutationConflict(error, reloadAuthoritativeDashboard, "discussion");
      state = { ...state, data: failure.reloaded ? state.data : { ...state.data, events: update(before.post, before.replies) }, pendingDiscussionIds: replaced(state.pendingDiscussionIds, id, false), failedDiscussionIds: replaced(state.failedDiscussionIds, id, true), mutationError: { id, message: failure.message } };
    }
    draw();
  }

  async function saveManualGrade(id: string): Promise<void> {
    const item = state.data.events.find((event) => event.id === id);
    const editing = state.editingManualGrade;
    if (item === undefined || item.kind === "class" || editing?.id !== id || state.pendingManualGradeIds.has(id)) return;
    const value = editing.draft.trim() || null;
    const update = (manualGrade: string | null, manualGradeVersion: 1 | null, manualGradeSource: "manual" | "pdf" | null) => state.data.events.map((event) => event.id === id ? { ...event, manualGrade, manualGradeVersion, manualGradeSource } : event);
    state = {
      ...state,
      data: { ...state.data, events: update(value, value === null ? null : 1, value === null ? null : "manual") },
      pendingManualGradeIds: replaced(state.pendingManualGradeIds, id, true),
      failedManualGradeIds: replaced(state.failedManualGradeIds, id, false),
      mutationError: undefined,
    };
    draw();
    try {
      const result = await transport.setManualGrade(item.sourceItemId ?? item.id, value, state.data.version);
      state = {
        ...state,
        data: { ...state.data, version: result.version, events: update(result.manualGrade, result.manualGradeVersion, result.manualGrade === null ? null : "manual") },
        pendingManualGradeIds: replaced(state.pendingManualGradeIds, id, false),
        editingManualGrade: undefined,
      };
      draw();
      return;
    } catch (error) {
      state = {
        ...state,
        data: { ...state.data, events: update(item.manualGrade ?? null, item.manualGradeVersion ?? null, item.manualGradeSource ?? null) },
        pendingManualGradeIds: replaced(state.pendingManualGradeIds, id, false),
        failedManualGradeIds: replaced(state.failedManualGradeIds, id, true),
        mutationError: { id, message: error instanceof Error ? error.message : "Could not save local grade. The previous value was restored." },
      };
    }
    draw();
  }

  async function refresh(): Promise<void> {
    if (!state.data.refreshAvailable || state.refreshState === "running") return;
    state = { ...state, refreshState: "running", refreshProgress: undefined, refreshDetail: undefined, refreshSettingError: undefined }; draw();
    try {
      const useCalendar = state.desktop?.refreshAvailable !== true && state.desktop?.icalRefreshAvailable === true;
      const result = useCalendar
        ? await transport.startIcalRefresh((progress: IcalRefreshProgress) => {
            if (state.refreshState !== "running") return;
            state = { ...state, refreshProgress: { phase: progress.phase, completed: 0, total: null, bytesDone: null } };
            draw();
          })
        : await transport.startCanvasRefresh((progress: CanvasRefreshProgress) => {
            if (state.refreshState !== "running") return;
            state = { ...state, refreshProgress: progress };
            draw();
          });
      let data = state.data;
      let refreshDetail: string | undefined = useCalendar ? `Calendar refresh complete · ${String((result as IcalRefreshResult).added)} added · ${String((result as IcalRefreshResult).updated)} updated · ${String((result as IcalRefreshResult).held)} held` : undefined;
      try {
        data = await withAvatar(parseDashboard(await transport.loadDashboardBody(true)));
      } catch {
        refreshDetail = "Refresh finished, but updated coursework could not be reloaded.";
      }
      const currentStatus = await transport.storeStatus().catch(() => undefined);
      const desktopInfo = currentStatus === undefined
        ? { ...state.desktop!, lastRefreshAt: result.updatedAt }
        : currentStatus.availability === "ready" && (currentStatus.state === "preview" || currentStatus.state === "authoritative")
          ? { ...state.desktop!, canvasRefreshEnabled: currentStatus.canvasRefreshEnabled, refreshAvailable: currentStatus.refreshAvailable, icalRefreshAvailable: currentStatus.icalRefreshAvailable, warning: currentStatus.problem, lastRefreshAt: result.updatedAt }
          : { ...state.desktop!, canvasRefreshEnabled: currentStatus.canvasRefreshEnabled, refreshAvailable: false, icalRefreshAvailable: false, warning: currentStatus.problem, lastRefreshAt: result.updatedAt };
      const refreshState = result.status === "incomplete" ? "partial" : "complete";
      const refreshAvailable = currentStatus === undefined ? desktopRefreshAvailable(desktopInfo) : currentStatus.availability === "ready" && (currentStatus.refreshAvailable || currentStatus.icalRefreshAvailable);
      state = { ...state, desktop: desktopInfo, data: { ...data, refreshAvailable }, refreshState, refreshProgress: undefined, refreshDetail, selectedRefreshId: data.refreshes[0]?.id };
    } catch {
      state = { ...state, refreshState: "failed", refreshProgress: undefined, refreshDetail: undefined };
    }
    draw();
  }

  async function toggleCanvasRefresh(enabled: boolean): Promise<void> {
    if (state.desktop?.storeState !== "authoritative" || state.refreshSettingPending === true || state.refreshState === "running") return;
    state = { ...state, refreshSettingPending: true, refreshSettingError: undefined }; draw();
    try {
      const setting = await transport.setCanvasRefreshEnabled(enabled);
      if (state.desktop !== undefined) state = {
        ...state,
        desktop: { ...state.desktop, canvasRefreshEnabled: setting.canvasRefreshEnabled, refreshAvailable: setting.refreshAvailable },
        data: { ...state.data, refreshAvailable: setting.refreshAvailable || state.desktop.icalRefreshAvailable === true },
      };
    } catch {
      state = { ...state, refreshSettingError: "The Canvas refresh setting could not be saved." };
    }
    state = { ...state, refreshSettingPending: false };
    draw();
  }

  function transitionFailure(error: unknown, cancelledMessage: string): { readonly message: string; readonly error: boolean } {
    if (error instanceof DesktopCommandError && error.code === "cancelled") return { message: cancelledMessage, error: false };
    return { message: error instanceof DesktopCommandError ? error.message : "The store transition failed. The current store was kept.", error: true };
  }

  function onStoreTransitionProgress(phase: NonNullable<DashboardState["storeTransition"]>["phase"]): (progress: StoreTransitionProgress) => void {
    return (progress) => {
      if (state.storeTransition?.phase !== phase) return;
      state = { ...state, storeTransition: { ...state.storeTransition, progress } };
      draw();
    };
  }

  async function refreshStoreAfterTransition(expected: "preview" | "authoritative"): Promise<void> {
    if (state.desktop === undefined) return;
    let desktop: DesktopStoreInfo = {
      ...state.desktop,
      storeState: expected,
      ...(expected === "preview" ? { canvasRefreshEnabled: false, refreshAvailable: false, icalRefreshAvailable: false } : { refreshAvailable: false, icalRefreshAvailable: false }),
      warning: "The store changed, but its current status could not be verified. Reopen the app before relying on refresh.",
    };
    try {
      const status = await transport.storeStatus();
      if (status.availability === "ready" && status.state === expected) {
        desktop = {
          storeState: expected,
          dataFolder: status.dataFolder,
          importedAt: status.importedAt,
          canvasRefreshEnabled: status.canvasRefreshEnabled,
          refreshAvailable: status.refreshAvailable,
          icalRefreshAvailable: status.icalRefreshAvailable,
          snapshotInProgress: status.snapshotInProgress,
          snapshotProgress: status.snapshotProgress,
          warning: status.problem,
        };
      }
    } catch { /* retain the command's reported state and fail refresh availability closed */ }
    state = { ...state, desktop, data: { ...state.data, refreshAvailable: desktopRefreshAvailable(desktop) } };
    await reloadAuthoritativeDashboard();
  }

  async function prepareStorePromotion(): Promise<void> {
    if (state.desktop?.storeState !== "preview" || state.storeTransition?.phase === "preparing" || state.storeTransition?.phase === "promoting") return;
    state = { ...state, storeTransition: { phase: "preparing" } }; draw();
    try {
      const proof = await transport.prepareStorePromotion(onStoreTransitionProgress("preparing"));
      state = { ...state, storeTransition: { phase: "ready", proof } };
    } catch (error) {
      const failure = transitionFailure(error, "Backup selection cancelled. The app store remains a preview copy.");
      state = { ...state, storeTransition: { phase: "idle", ...failure } };
    }
    draw();
  }

  async function confirmStorePromotion(proofId: string): Promise<void> {
    if (state.desktop?.storeState !== "preview" || state.storeTransition?.phase !== "ready" || state.storeTransition.proof?.proofId !== proofId) return;
    // Clear the proof before IPC; it cannot be retried in the webview after any outcome.
    state = { ...state, storeTransition: { phase: "promoting" } }; draw();
    try {
      const result = await transport.confirmStorePromotion(proofId, onStoreTransitionProgress("promoting"));
      await refreshStoreAfterTransition(result.state);
      state = { ...state, storeTransition: { phase: "idle", message: `Promotion complete. ${String(result.files)} files · ${result.bytes} bytes are now in the authoritative app store.` } };
    } catch (error) {
      const failure = transitionFailure(error, "Promotion cancelled. The app store remains a preview copy; compare the backup again before retrying.");
      state = { ...state, storeTransition: { phase: "idle", ...failure } };
    }
    draw();
  }

  async function demoteStoreForRollback(): Promise<void> {
    if (state.desktop?.storeState !== "authoritative" || state.refreshState === "running" || state.refreshSettingPending === true || ["preparing", "promoting", "demoting", "exporting"].includes(state.storeTransition?.phase ?? "idle")) return;
    state = { ...state, storeTransition: { phase: "demoting" } }; draw();
    try {
      const result = await transport.demoteStoreForRollback(onStoreTransitionProgress("demoting"));
      await refreshStoreAfterTransition(result.state);
      state = { ...state, storeTransition: { phase: "idle", rollbackExportVerified: false, message: `App store returned to preview. ${String(result.recoveryFiles)} recovery files · ${result.recoveryBytes} bytes were retained. Canvas refresh is off. Export the frozen legacy source next.` } };
    } catch (error) {
      const failure = transitionFailure(error, "Rollback cancelled. The app store remains authoritative.");
      state = { ...state, storeTransition: { phase: "idle", ...failure } };
    }
    draw();
  }

  async function exportFrozenRollback(): Promise<void> {
    if (state.desktop?.storeState !== "preview" || ["preparing", "promoting", "demoting", "exporting"].includes(state.storeTransition?.phase ?? "idle")) return;
    state = { ...state, storeTransition: { phase: "exporting", rollbackExportVerified: false } }; draw();
    try {
      const result = await transport.exportFrozenForRollback(onStoreTransitionProgress("exporting"));
      if (!result.equal) throw new DesktopCommandError("export-mismatch", "The exported copy did not match the frozen source. Do not use it for rollback.");
      state = { ...state, storeTransition: { phase: "idle", rollbackExportVerified: true, message: `Frozen rollback copy verified: ${String(result.files)} files · ${result.bytes} bytes. Use this copy when restoring the legacy local source.` } };
    } catch (error) {
      const failure = transitionFailure(error, "Export cancelled. No rollback copy was completed.");
      state = { ...state, storeTransition: { phase: "idle", rollbackExportVerified: false, ...failure } };
    }
    draw();
  }

  const copyTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  async function copyAssignment(id: string): Promise<void> {
    const item = state.data.events.find((event) => event.id === id);
    if (item === undefined || item.kind === "class") return;
    if (state.copyFeedback?.[id] === "pending") return;
    const copyText = formatAssignmentCopyText(item);
    const previous = copyTimeouts.get(id);
    if (previous !== undefined) { clearTimeout(previous); copyTimeouts.delete(id); }
    state = { ...state, copyFeedback: { ...state.copyFeedback, [id]: "pending" } };
    draw();
    const success = await transport.copyText(copyText).then(() => true, () => false);
    const status: "copied" | "failed" = success ? "copied" : "failed";

    state = {
      ...state,
      copyFeedback: {
        ...state.copyFeedback,
        [id]: status,
      },
    };
    draw();

    const timer = setTimeout(() => {
      copyTimeouts.delete(id);
      if (state.copyFeedback?.[id] === status) {
        const nextFeedback = { ...state.copyFeedback };
        delete nextFeedback[id];
        state = {
          ...state,
          copyFeedback: Object.keys(nextFeedback).length > 0 ? nextFeedback : undefined,
        };
        draw();
      }
    }, 2500);
    copyTimeouts.set(id, timer);
  }

  const handlers: DashboardHandlers = {
    onNavigate(page) { state = { ...state, page }; window.history.replaceState(null, "", `#${page}`); draw(); window.scrollTo({ top: 0, behavior: "instant" }); },
    onEventMode(eventMode) { state = { ...state, eventMode }; draw(); },
    onCourseFilter(courseFilter) { state = { ...state, courseFilter }; draw(); },
    onGradeCourseFilter(gradeCourseFilter) { state = { ...state, gradeCourseFilter }; draw(); },
    onGradeMode(gradeMode) { state = { ...state, gradeMode }; draw(); },
    onResourceFilter(resourceFilter) { state = { ...state, resourceFilter }; draw(); },
    onToggleEvent(id) { state = { ...state, expandedEventIds: replaced(state.expandedEventIds, id, !state.expandedEventIds.has(id)) }; draw(); },
    onToggleCompletion(id) { void toggleCompletion(id); },
    onToggleDiscussion(id, field) { void toggleDiscussion(id, field); },
    onEditManualGrade(id) {
      if (state.pendingManualGradeIds.has(id)) return;
      const item = state.data.events.find((event) => event.id === id);
      if (item === undefined || item.kind === "class") return;
      state = { ...state, editingManualGrade: { id, draft: item.manualGrade ?? "" }, failedManualGradeIds: replaced(state.failedManualGradeIds, id, false), mutationError: undefined };
      draw();
    },
    onManualGradeDraft(draft) {
      if (state.editingManualGrade !== undefined) state = { ...state, editingManualGrade: { ...state.editingManualGrade, draft } };
    },
    onSaveManualGrade(id) { void saveManualGrade(id); },
    onCancelManualGrade() { if (state.editingManualGrade !== undefined) { state = { ...state, editingManualGrade: undefined }; draw(); } },
    onSelectConversation(selectedConversationId) { state = { ...state, selectedConversationId }; draw(); },
    onSelectRefresh(selectedRefreshId) { state = { ...state, selectedRefreshId }; draw(); },
    onRefresh() { void refresh(); },
    onToggleCanvasRefresh(enabled) { void toggleCanvasRefresh(enabled); },
    onCopyAssignment(id) { void copyAssignment(id); },
    onSelectPendingLink(id) { selectPendingLink(id); },
    onSelectPendingLinkCandidate(id) { selectPendingLinkCandidate(id); },
    onOpenPendingLinkDecision(decision) { openPendingLinkDecision(decision); },
    onCancelPendingLinkDecision() { cancelPendingLinkDecision(); },
    onResolvePendingLink() { void resolvePendingLink(); },
    onOpenResource(id: string) {
      state = { ...state, resourceNotice: "Opening the saved library file…" }; draw();
      void transport.openResource(id).then((action) => { state = { ...state, resourceNotice: action === "downloaded" ? "File saved." : action === "opened" ? "File opened." : "Save cancelled." }; draw(); }, () => { state = { ...state, resourceNotice: "The saved file could not be opened." }; draw(); });
    },
    onPreparePromotion() { void prepareStorePromotion(); },
    onConfirmPromotion(proofId: string) { void confirmStorePromotion(proofId); },
    onCancelPromotion() { if (state.storeTransition?.phase === "ready") { state = { ...state, storeTransition: { phase: "idle", message: "Comparison discarded. The app store remains a preview copy." } }; draw(); } },
    onDemoteStore() { void demoteStoreForRollback(); },
    onExportFrozenRollback() { void exportFrozenRollback(); },
    ...(desktop?.onReplacePreview === undefined ? {} : { onReplacePreview: desktop.onReplacePreview }),
    ...(desktop?.onRecovery === undefined ? {} : { onRecovery: desktop.onRecovery }),
    ...(desktop?.onExport === undefined ? {} : { onExport: desktop.onExport }),
  };

  window.addEventListener("hashchange", () => { state = { ...state, page: pageFromHash() }; draw(); }, { signal: listeners.signal });
  window.addEventListener("keydown", (event) => {
    if (state.page !== "more" || state.pendingLinkSaving === true || state.data.pendingSourceLinks.length === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape" && state.pendingLinkDecision !== undefined) { event.preventDefault(); cancelPendingLinkDecision(); return; }
    if (state.pendingLinkDecision !== undefined) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    const selectedIndex = Math.max(0, state.data.pendingSourceLinks.findIndex((link) => link.id === state.selectedPendingLinkId));
    if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
      event.preventDefault(); const direction = event.key.toLowerCase() === "j" ? 1 : -1;
      selectPendingLink(state.data.pendingSourceLinks[(selectedIndex + direction + state.data.pendingSourceLinks.length) % state.data.pendingSourceLinks.length]!.id);
    } else if (event.key.toLowerCase() === "c") { event.preventDefault(); openPendingLinkDecision("confirm"); }
    else if (event.key.toLowerCase() === "r") { event.preventDefault(); openPendingLinkDecision("reject"); }
  }, { signal: listeners.signal });
  draw(); void load(); void pollStartupSnapshot();
  return () => {
    disposed = true;
    listeners.abort();
    if (snapshotStatusTimer !== undefined) clearTimeout(snapshotStatusTimer);
    for (const timer of copyTimeouts.values()) clearTimeout(timer);
    copyTimeouts.clear();
    if (avatarUrl !== undefined) URL.revokeObjectURL(avatarUrl);
  };
}

// --- Desktop first run, recovery, and import ---------------------------------------------------


/** Desktop shell: store status first, then the dashboard or the first-run/recovery screen. */
function mountDesktop(mount: HTMLElement, transport: NativeTransport): void {
  let disposeDashboard: (() => void) | undefined;
  let setup: DesktopSetupState | undefined;
  let frame = 0;

  function drawSetup(): void { if (setup !== undefined) mount.replaceChildren(render(renderDesktopSetup(setup, setupHandlers))); }
  function scheduleDraw(): void {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(() => { frame = 0; drawSetup(); });
  }
  function update(next: Partial<DesktopSetupState>): void { if (setup !== undefined) setup = { ...setup, ...next }; }

  function showDashboard(status: DesktopStoreStatus): void {
    const storeState = status.state === "authoritative" ? "authoritative" : "preview";
    const info: DesktopStoreInfo = { storeState, dataFolder: status.dataFolder, importedAt: status.importedAt, canvasRefreshEnabled: status.canvasRefreshEnabled, refreshAvailable: status.refreshAvailable, icalRefreshAvailable: status.icalRefreshAvailable, snapshotInProgress: status.snapshotInProgress, snapshotProgress: status.snapshotProgress, warning: status.problem };
    setup = undefined;
    // An authoritative store is never replaced by import, so only a preview offers replacement.
    disposeDashboard = mountDashboard(mount, transport, { info, onRecovery: () => startRecovery(status), onExport: () => { startRecovery(status); void runExport(); }, ...(storeState === "preview" ? { onReplacePreview: () => startSetup(status, true) } : {}) });
  }

  function startRecovery(status: DesktopStoreStatus): void {
    disposeDashboard?.();
    disposeDashboard = undefined;
    setup = { status, replacePreview: false, step: "idle", recoveryMode: true, snapshots: [] };
    drawSetup();
    void transport.listSnapshots().then((snapshots) => { if (setup?.recoveryMode === true) { update({ snapshots }); drawSetup(); } }, (error: unknown) => { if (setup?.recoveryMode === true) { update({ error: setupError(error) }); drawSetup(); } });
  }

  function startSetup(status: DesktopStoreStatus, replacePreview: boolean): void {
    disposeDashboard?.();
    disposeDashboard = undefined;
    setup = { status, replacePreview, step: "idle" };
    drawSetup();
  }

  async function showCurrent(): Promise<void> {
    let status: DesktopStoreStatus;
    try {
      status = await transport.storeStatus();
    } catch (error) {
      mount.replaceChildren(render(setupPanel("Desktop app", "Due Good could not reach its app store", [element("p", { role: "alert" }, setupError(error).message)])));
      return;
    }
    if (status.availability === "ready" && (status.state === "preview" || status.state === "authoritative")) showDashboard(status);
    else if (status.availability === "ready" && (status.state === "damaged" || status.state === "unknown")) startRecovery(status);
    else startSetup(status, false);
  }

  async function runRestore(id: string): Promise<void> {
    if (setup?.recoveryMode !== true || setup.recoveryBusy === true || !setup.snapshots?.some((snapshot) => snapshot.id === id)) return;
    update({ recoveryBusy: true, recoveryMessage: "Archiving the current store and restoring the snapshot…", error: undefined }); drawSetup();
    try { await transport.restoreSnapshot(id); await showCurrent(); }
    catch (error) { update({ recoveryBusy: false, error: setupError(error), recoveryMessage: undefined }); drawSetup(); }
  }

  async function runExport(): Promise<void> {
    if (setup?.recoveryMode !== true || setup.recoveryBusy === true) return;
    update({ recoveryBusy: true, recoveryMessage: "Choose an export folder…", recoveryFilesDone: 0, error: undefined }); drawSetup();
    try {
      const result = await transport.exportLegacy((progress) => { if (setup?.recoveryMode === true) { update({ recoveryMessage: "Copying rollback files…", recoveryFilesDone: progress.filesDone }); scheduleDraw(); } });
      update({ recoveryBusy: false, recoveryMessage: "Rollback folder exported.", recoveryFilesDone: result.filesDone });
    } catch (error) { update({ recoveryBusy: false, error: setupError(error), recoveryMessage: undefined }); }
    drawSetup();
  }

  async function dryRun(): Promise<void> {
    update({ step: "checking", report: undefined, error: undefined }); drawSetup();
    try {
      const report = await transport.dryRunImport();
      update({ step: "ready", report });
    } catch (error) {
      update({ step: "idle", error: setupError(error) });
    }
    drawSetup();
  }

  async function choose(): Promise<void> {
    if (setup === undefined || setup.step === "choosing" || setup.step === "checking" || setup.step === "importing") return;
    update({ step: "choosing", error: undefined }); drawSetup();
    let selected = false;
    try {
      selected = await transport.chooseLegacyRoot();
    } catch (error) {
      update({ step: "idle", error: setupError(error) }); drawSetup();
      return;
    }
    if (setup === undefined) return;
    update({ status: { ...setup.status, legacyRootSelected: selected } });
    if (!selected) { update({ step: "idle" }); drawSetup(); return; }
    await dryRun();
  }

  async function runImport(): Promise<void> {
    if (setup === undefined || setup.step !== "ready" || setup.report?.wouldImport !== true) return;
    const replacePreview = setup.replacePreview;
    update({ step: "importing", progress: undefined, error: undefined }); drawSetup();
    try {
      await transport.importLegacyRoot(replacePreview, (progress) => {
        if (setup?.step !== "importing") return;
        update({ progress }); scheduleDraw();
      });
    } catch (error) {
      // The selection is kept after a failure, so "Check again" re-runs the dry run.
      update({ step: "idle", progress: undefined, report: undefined, error: setupError(error) });
      drawSetup();
      return;
    }
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0; }
    await showCurrent();
  }

  async function connectCalendar(): Promise<void> {
    if (setup?.status.state !== "empty" || setup.step === "connecting") return;
    update({ step: "connecting", calendarProgress: undefined, error: undefined }); drawSetup();
    try {
      await transport.startIcalRefresh((calendarProgress) => {
        if (setup?.step === "connecting") { update({ calendarProgress }); scheduleDraw(); }
      });
      if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0; }
      await showCurrent();
    } catch (error) {
      update({ step: "idle", calendarProgress: undefined, error: setupError(error) }); drawSetup();
    }
  }

  const setupHandlers: DesktopSetupHandlers = {
    onConnectCalendar() { void connectCalendar(); },
    onChoose() { void choose(); },
    onRecheck() { if (setup !== undefined && setup.step !== "importing") void dryRun(); },
    onImport() { void runImport(); },
    onCancel() { void showCurrent(); },
    onRestoreSnapshot(id) { void runRestore(id); },
    onExport() { void runExport(); },
  };

  void showCurrent();
}

export function mount(): void {
  const mountEl = document.querySelector<HTMLElement>("#app"); if (!mountEl) throw new Error("Missing application mount point.");
  if (!isTauri()) {
    mountEl.replaceChildren(render(setupPanel("Desktop app", "Due Good requires the desktop app", [element("p", {}, "Open Due Good in its Tauri desktop app to view or import coursework.")])));
    return;
  }
  mountDesktop(mountEl, createNativeTransport((command, args) => invoke(command, args), (onMessage) => new Channel<unknown>(onMessage)));
}
