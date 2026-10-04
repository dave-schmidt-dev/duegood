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
import { setupPanel } from "./desktop-setup";
export { renderDesktopSetup } from "./desktop-setup";
export type { DesktopSetupHandlers, DesktopSetupState } from "./desktop-setup";
import { mountDesktop, type DesktopDashboardOptions } from "./desktop-shell";
import {
  createNativeTransport,
  DesktopCommandError,
  type CanvasRefreshProgress,
  type FullRefreshProgress,
  type IcalRefreshProgress,
  type IcalRefreshResult,
  type StoreTransitionProgress,
  type NativeTransport,
} from "./transport";
import { fullRefreshFeedback } from "./full-refresh";
import { createLibraryResourceActionRunner } from "./library-resource-action";
import { boundedScrollPosition, createDashboardViewStateStore, reconcileDashboardViewState, type DashboardViewState } from "./dashboard-view-state";

function element(tag: string, attrs: Record<string, string> = {}, text?: string): ElementDescriptor {
  return { tag, attrs, ...(text !== undefined ? { text } : {}) };
}

const EMPTY_DATA: DashboardData = { version: "", courses: [], events: [], pendingSourceLinks: [], resources: [], conversations: [], refreshes: [], profile: null, refreshAvailable: false, sourceStatus: {} };

function desktopRefreshAvailable(info: DesktopStoreInfo | undefined): boolean { return info?.browserRefreshAvailable === true || info?.refreshAvailable === true || info?.icalRefreshAvailable === true; }

function courseKey(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9]/g, ""); }

function reconciledDashboardState(state: DashboardState, data: DashboardData, refreshAvailable = desktopRefreshAvailable(state.desktop)): DashboardState {
  const hasCourse = (filter: string): boolean => filter === "all" || data.courses.some((course) => courseKey(course.courseCode) === courseKey(filter));
  const hasResourceType = state.resourceFilter === "all" || data.resources.some((resource) => resource.type.toLowerCase() === state.resourceFilter.toLowerCase());
  return {
    ...state,
    data: { ...data, refreshAvailable },
    selectedConversationId: data.conversations.some((conversation) => conversation.id === state.selectedConversationId) ? state.selectedConversationId : data.conversations[0]?.id,
    selectedRefreshId: data.refreshes.some((refresh) => refresh.id === state.selectedRefreshId) ? state.selectedRefreshId : data.refreshes[0]?.id,
    courseFilter: hasCourse(state.courseFilter) ? state.courseFilter : "all",
    gradeCourseFilter: hasCourse(state.gradeCourseFilter) ? state.gradeCourseFilter : "all",
    resourceFilter: hasResourceType ? state.resourceFilter : "all",
  };
}

function pageFromHash(): DashboardPage {
  const candidate = window.location.hash.replace(/^#/, "");
  return DASHBOARD_ROUTES.some((route) => route.page === candidate) ? candidate as DashboardPage : "timeline";
}

function replaced(set: ReadonlySet<string>, id: string, include: boolean): ReadonlySet<string> { const next = new Set(set); if (include) next.add(id); else next.delete(id); return next; }

/** Native per-item conflicts always trigger a fresh document read before the notice is shown. */
export async function resolveNativeMutationConflict(error: unknown, reload: () => Promise<boolean>, subject: "item" | "discussion"): Promise<{ readonly reloaded: boolean; readonly message: string }> {
  if (!(error instanceof DesktopCommandError) || error.code !== "item-conflict") return { reloaded: false, message: error instanceof Error ? error.message : "Could not save. Existing state was restored." };
  const reloaded = await reload();
  return { reloaded, message: reloaded ? `This ${subject} changed elsewhere. Latest state reloaded; try again.` : `This ${subject} changed elsewhere. Reload the page and try again.` };
}

/** Mounts the dashboard; returns a disposer so the desktop shell can swap screens cleanly. */
function mountDashboard(mount: HTMLElement, transport: NativeTransport, desktop: DesktopDashboardOptions): () => void {
  let avatarUrl: string | undefined;
  const viewStateStore = createDashboardViewStateStore(desktop.info.dataFolder);
  const storedViewState = viewStateStore.load();
  let scrollPositions: Partial<Record<DashboardPage, number>> = { ...storedViewState.scrollPositions };
  let restoredViewState = false;
  let viewStateTimer: ReturnType<typeof setTimeout> | undefined;
  let skipNextHashScrollCapture = false;
  let state: DashboardState = { page: pageFromHash(), loading: true, data: { ...EMPTY_DATA, refreshAvailable: desktopRefreshAvailable(desktop.info) }, now: Date.now(), eventMode: "all", courseFilter: "all", gradeCourseFilter: "all", gradeMode: "all", resourceFilter: "all", expandedEventIds: new Set(), pendingCompletionIds: new Set(), failedCompletionIds: new Set(), pendingDiscussionIds: new Set(), failedDiscussionIds: new Set(), pendingManualGradeIds: new Set(), failedManualGradeIds: new Set(), refreshState: "idle", desktop: desktop.info };
  const resourceActionRunner = createLibraryResourceActionRunner((id) => transport.openResource(id));
  let disposed = false;
  let snapshotStatusTimer: ReturnType<typeof setTimeout> | undefined;
  let topbarHeightObserver: ResizeObserver | undefined;
  const listeners = new AbortController();

  function measureTopbarHeight(): void {
    topbarHeightObserver?.disconnect();
    topbarHeightObserver = undefined;
    const topbar = mount.querySelector<HTMLElement>(".topbar");
    if (topbar === null) {
      document.documentElement.style.removeProperty("--topbar-height");
      return;
    }
    const updateHeight = (): void => document.documentElement.style.setProperty("--topbar-height", `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
    updateHeight();
    if (typeof ResizeObserver !== "function") return;
    topbarHeightObserver = new ResizeObserver(updateHeight);
    topbarHeightObserver.observe(topbar);
  }
  function draw(): void { if (disposed) return; state = { ...state, now: Date.now() }; mount.replaceChildren(render(renderDashboard(state, handlers))); measureTopbarHeight(); }
  function drawPreservingScroll(): void {
    const page = state.page;
    const preservedPosition = scrollPositions[page] ?? boundedScrollPosition(window.scrollY);
    draw();
    if (!disposed && state.page === page && preservedPosition > 0) window.scrollTo({ top: preservedPosition, behavior: "instant" });
  }
  function viewState(): DashboardViewState {
    return {
      eventMode: state.eventMode, courseFilter: state.courseFilter, gradeCourseFilter: state.gradeCourseFilter,
      gradeMode: state.gradeMode, resourceFilter: state.resourceFilter, expandedEventIds: [...state.expandedEventIds],
      ...(state.selectedConversationId === undefined ? {} : { selectedConversationId: state.selectedConversationId }),
      ...(state.selectedRefreshId === undefined ? {} : { selectedRefreshId: state.selectedRefreshId }),
      ...(state.editingManualGrade === undefined ? {} : { editingManualGrade: state.editingManualGrade }),
      scrollPositions,
    };
  }
  function saveViewState(): void { if (viewStateTimer !== undefined) { clearTimeout(viewStateTimer); viewStateTimer = undefined; } viewStateStore.save(viewState()); }
  function scheduleViewStateSave(): void { if (viewStateTimer === undefined) viewStateTimer = setTimeout(saveViewState, 150); }
  function captureScroll(): void {
    if (state.loading) return;
    const position = boundedScrollPosition(window.scrollY);
    scrollPositions = { ...scrollPositions, [state.page]: position };
    scheduleViewStateSave();
  }
  function restoreScroll(): void {
    if (!disposed && !state.loading) window.scrollTo({ top: scrollPositions[state.page] ?? 0, behavior: "instant" });
  }
  function restoreStoredViewState(data: DashboardData): void {
    if (restoredViewState) return;
    const restored = reconcileDashboardViewState(storedViewState, data);
    scrollPositions = { ...restored.scrollPositions };
    state = {
      ...state, eventMode: restored.eventMode, courseFilter: restored.courseFilter, gradeCourseFilter: restored.gradeCourseFilter,
      gradeMode: restored.gradeMode, resourceFilter: restored.resourceFilter, expandedEventIds: new Set(restored.expandedEventIds),
      ...(restored.selectedConversationId === undefined ? {} : { selectedConversationId: restored.selectedConversationId }),
      ...(restored.selectedRefreshId === undefined ? {} : { selectedRefreshId: restored.selectedRefreshId }),
      ...(restored.editingManualGrade === undefined ? {} : { editingManualGrade: restored.editingManualGrade }),
    };
    restoredViewState = true;
  }
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
      restoreStoredViewState(data);
      state = { ...reconciledDashboardState(state, data), loading: false, error: undefined };
    } catch (error) {
      const detail = error instanceof DesktopCommandError ? ` ${error.message}` : "";
      state = { ...state, loading: false, error: `Coursework could not be loaded. No substitute or sample data was shown.${detail}` };
    }
    draw();
    restoreScroll();
  }

  async function pollStartupSnapshot(): Promise<void> {
    if (disposed || state.desktop?.snapshotInProgress !== true) return;
    try {
      const status = await transport.storeStatus();
      if (disposed) return;
      if (status.availability === "ready" && (status.state === "preview" || status.state === "authoritative")) {
        state = { ...state, desktop: { ...state.desktop!, canvasRefreshEnabled: status.canvasRefreshEnabled, refreshAvailable: status.refreshAvailable, icalRefreshAvailable: status.icalRefreshAvailable, browserRefreshAvailable: status.browserRefreshAvailable, snapshotInProgress: status.snapshotInProgress, snapshotProgress: status.snapshotProgress, warning: status.problem }, data: { ...state.data, refreshAvailable: status.refreshAvailable || status.icalRefreshAvailable || status.browserRefreshAvailable === true } };
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
      state = reconciledDashboardState(state, data);
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
      draw(); scheduleViewStateSave();
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
    draw(); scheduleViewStateSave();
  }

  async function refresh(): Promise<void> {
    if (!state.data.refreshAvailable || state.refreshState === "running") return;
    const fullRefresh = state.desktop?.browserRefreshAvailable === true;
    captureScroll();
    state = { ...state, refreshState: "running", refreshProgress: undefined, refreshDetail: undefined, refreshSettingError: undefined }; drawPreservingScroll();
    try {
      let data = state.data;
      let updatedAt: string | null = null;
      let refreshDetail: string | undefined;
      let refreshState: DashboardState["refreshState"];
      if (fullRefresh) {
        const result = await transport.startFullRefresh((progress: FullRefreshProgress) => {
          if (state.refreshState !== "running") return;
          state = { ...state, refreshProgress: { phase: progress.phase, completed: 0, total: null, bytesDone: null } };
          drawPreservingScroll();
        });
        const feedback = fullRefreshFeedback(result);
        refreshState = feedback.state;
        refreshDetail = feedback.detail;
        updatedAt = result.updatedAt;
        if (await reloadAuthoritativeDashboard()) data = state.data;
        else refreshDetail += " Updated data could not be reloaded; the prior view is still shown.";
      } else {
        const useCalendar = state.desktop?.refreshAvailable !== true && state.desktop?.icalRefreshAvailable === true;
        const result = useCalendar
          ? await transport.startIcalRefresh((progress: IcalRefreshProgress) => {
              if (state.refreshState !== "running") return;
              state = { ...state, refreshProgress: { phase: progress.phase, completed: 0, total: null, bytesDone: null } };
              drawPreservingScroll();
            })
          : await transport.startCanvasRefresh((progress: CanvasRefreshProgress) => {
              if (state.refreshState !== "running") return;
              state = { ...state, refreshProgress: progress };
              drawPreservingScroll();
            });
        updatedAt = result.updatedAt;
        refreshDetail = useCalendar ? `Calendar refresh complete · ${String((result as IcalRefreshResult).added)} added · ${String((result as IcalRefreshResult).updated)} updated · ${String((result as IcalRefreshResult).held)} held` : undefined;
        try {
          data = await withAvatar(parseDashboard(await transport.loadDashboardBody(true)));
          refreshState = result.status === "incomplete" ? "partial" : "complete";
        } catch {
          refreshDetail = "Refresh finished, but updated data could not be reloaded. The prior view is still shown.";
          refreshState = result.status === "incomplete" ? "partial" : "complete";
        }
      }
      const currentStatus = await transport.storeStatus().catch(() => undefined);
      const desktopInfo = currentStatus === undefined
        ? { ...state.desktop!, lastRefreshAt: updatedAt ?? state.desktop?.lastRefreshAt }
        : currentStatus.availability === "ready" && (currentStatus.state === "preview" || currentStatus.state === "authoritative")
          ? { ...state.desktop!, canvasRefreshEnabled: currentStatus.canvasRefreshEnabled, refreshAvailable: currentStatus.refreshAvailable, icalRefreshAvailable: currentStatus.icalRefreshAvailable, browserRefreshAvailable: currentStatus.browserRefreshAvailable, warning: currentStatus.problem, lastRefreshAt: updatedAt ?? state.desktop?.lastRefreshAt }
          : { ...state.desktop!, canvasRefreshEnabled: currentStatus.canvasRefreshEnabled, refreshAvailable: false, icalRefreshAvailable: false, browserRefreshAvailable: false, warning: currentStatus.problem, lastRefreshAt: updatedAt ?? state.desktop?.lastRefreshAt };
      const refreshAvailable = currentStatus === undefined ? desktopRefreshAvailable(desktopInfo) : currentStatus.availability === "ready" && (currentStatus.refreshAvailable || currentStatus.icalRefreshAvailable || currentStatus.browserRefreshAvailable === true);
      state = reconciledDashboardState({ ...state, desktop: desktopInfo }, data, refreshAvailable);
      state = { ...state, desktop: desktopInfo, refreshState, refreshProgress: undefined, refreshDetail };
    } catch {
      if (fullRefresh) {
        const reloaded = await reloadAuthoritativeDashboard();
        state = { ...state, refreshState: "failed", refreshProgress: undefined, refreshDetail: reloaded ? "Full refresh failed. Latest saved data was reloaded." : "Full refresh failed and updated data could not be reloaded; the prior view is still shown." };
      } else state = { ...state, refreshState: "failed", refreshProgress: undefined, refreshDetail: undefined };
    }
    drawPreservingScroll();
    scheduleViewStateSave();
  }

  async function toggleCanvasRefresh(enabled: boolean): Promise<void> {
    if (state.desktop?.storeState !== "authoritative" || state.refreshSettingPending === true || state.refreshState === "running") return;
    state = { ...state, refreshSettingPending: true, refreshSettingError: undefined }; draw();
    try {
      const setting = await transport.setCanvasRefreshEnabled(enabled);
      if (state.desktop !== undefined) state = {
        ...state,
        desktop: { ...state.desktop, canvasRefreshEnabled: setting.canvasRefreshEnabled, refreshAvailable: setting.refreshAvailable },
        data: { ...state.data, refreshAvailable: setting.refreshAvailable || state.desktop.icalRefreshAvailable === true || state.desktop.browserRefreshAvailable === true },
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
      ...(expected === "preview" ? { canvasRefreshEnabled: false, refreshAvailable: false, icalRefreshAvailable: false, browserRefreshAvailable: false } : { refreshAvailable: false, icalRefreshAvailable: false, browserRefreshAvailable: false }),
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
          browserRefreshAvailable: status.browserRefreshAvailable,
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
    onNavigate(page) {
      if (page === state.page) { restoreScroll(); return; }
      captureScroll();
      state = { ...state, page };
      draw();
      restoreScroll();
      skipNextHashScrollCapture = true;
      window.location.hash = page;
    },
    onEventMode(eventMode) { state = { ...state, eventMode }; draw(); scheduleViewStateSave(); },
    onCourseFilter(courseFilter) { state = { ...state, courseFilter }; draw(); scheduleViewStateSave(); },
    onGradeCourseFilter(gradeCourseFilter) { state = { ...state, gradeCourseFilter }; draw(); scheduleViewStateSave(); },
    onGradeMode(gradeMode) { state = { ...state, gradeMode }; draw(); scheduleViewStateSave(); },
    onResourceFilter(resourceFilter) { state = { ...state, resourceFilter }; draw(); scheduleViewStateSave(); },
    onToggleEvent(id) { state = { ...state, expandedEventIds: replaced(state.expandedEventIds, id, !state.expandedEventIds.has(id)) }; draw(); scheduleViewStateSave(); },
    onToggleCompletion(id) { void toggleCompletion(id); },
    onToggleDiscussion(id, field) { void toggleDiscussion(id, field); },
    onEditManualGrade(id) {
      if (state.pendingManualGradeIds.has(id)) return;
      const item = state.data.events.find((event) => event.id === id);
      if (item === undefined || item.kind === "class") return;
      state = { ...state, editingManualGrade: { id, draft: item.manualGrade ?? "" }, failedManualGradeIds: replaced(state.failedManualGradeIds, id, false), mutationError: undefined };
      draw(); scheduleViewStateSave();
    },
    onManualGradeDraft(draft) {
      if (state.editingManualGrade !== undefined) { state = { ...state, editingManualGrade: { ...state.editingManualGrade, draft } }; scheduleViewStateSave(); }
    },
    onSaveManualGrade(id) { void saveManualGrade(id); },
    onCancelManualGrade() { if (state.editingManualGrade !== undefined) { state = { ...state, editingManualGrade: undefined }; draw(); scheduleViewStateSave(); } },
    onSelectConversation(selectedConversationId) { state = { ...state, selectedConversationId }; draw(); scheduleViewStateSave(); },
    onSelectRefresh(selectedRefreshId) { state = { ...state, selectedRefreshId }; draw(); scheduleViewStateSave(); },
    onRefresh() { void refresh(); },
    onToggleCanvasRefresh(enabled) { void toggleCanvasRefresh(enabled); },
    onCopyAssignment(id) { void copyAssignment(id); },
    onSelectPendingLink(id) { selectPendingLink(id); },
    onSelectPendingLinkCandidate(id) { selectPendingLinkCandidate(id); },
    onOpenPendingLinkDecision(decision) { openPendingLinkDecision(decision); },
    onCancelPendingLinkDecision() { cancelPendingLinkDecision(); },
    onResolvePendingLink() { void resolvePendingLink(); },
    onOpenResource(id: string) {
      const action = resourceActionRunner.run(id);
      if (action === undefined) return;
      state = { ...state, resourceActions: { ...state.resourceActions, [id]: { status: "pending", message: "Opening the saved library file…" } } };
      draw();
      void action.then((feedback) => { state = { ...state, resourceActions: { ...state.resourceActions, [id]: feedback } }; draw(); });
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

  window.addEventListener("scroll", captureScroll, { passive: true, signal: listeners.signal });
  window.addEventListener("pagehide", () => { captureScroll(); saveViewState(); }, { signal: listeners.signal });
  window.addEventListener("hashchange", () => {
    const page = pageFromHash();
    const acknowledgedNavigation = skipNextHashScrollCapture && page === state.page;
    skipNextHashScrollCapture = false;
    if (acknowledgedNavigation) return;
    captureScroll();
    state = { ...state, page }; draw(); restoreScroll();
  }, { signal: listeners.signal });
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
    captureScroll();
    saveViewState();
    listeners.abort();
    topbarHeightObserver?.disconnect();
    document.documentElement.style.removeProperty("--topbar-height");
    if (snapshotStatusTimer !== undefined) clearTimeout(snapshotStatusTimer);
    for (const timer of copyTimeouts.values()) clearTimeout(timer);
    copyTimeouts.clear();
    if (avatarUrl !== undefined) URL.revokeObjectURL(avatarUrl);
  };
}

export function mount(): void {
  const mountEl = document.querySelector<HTMLElement>("#app"); if (!mountEl) throw new Error("Missing application mount point.");
  if (!isTauri()) {
    mountEl.replaceChildren(render(setupPanel("Desktop app", "Due Good requires the desktop app", [element("p", {}, "Open Due Good in its Tauri desktop app to view or import coursework.")])));
    return;
  }
  mountDesktop(mountEl, createNativeTransport((command, args) => invoke(command, args), (onMessage) => new Channel<unknown>(onMessage)), mountDashboard);
}
