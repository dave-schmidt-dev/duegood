import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { CSRF_HEADER_NAME, readCsrfToken, readLocalCsrfToken } from "./csrf";
import { render, type ElementDescriptor } from "./dom";
import {
  renderDashboard,
  copyTextToClipboard,
  formatAssignmentCopyText,
  type DashboardConversation,
  type DashboardMessage,
  type DashboardAttachment,
  type DashboardCourse,
  type DashboardGradeGroup,
  type DashboardData,
  type DashboardEvent,
  type DashboardHandlers,
  type DashboardRefresh,
  type DashboardRefreshChange,
  type DashboardResource,
  type DashboardSourceStatus,
  type DashboardProfile,
  type DashboardState,
  type DesktopStoreInfo,
  safeLocalHref,
} from "./pages/dashboard";
import { DASHBOARD_ROUTES, type DashboardPage } from "./routes";
import {
  createBrowserTransport,
  createNativeTransport,
  DesktopCommandError,
  type DashboardTransport,
  type DesktopStoreStatus,
  type DryRunReport,
  type CanvasRefreshProgress,
  type ImportProgress,
  type StoreTransitionProgress,
  type NativeTransport,
  type DesktopSnapshot,
} from "./transport";
import { desktopRecoveryPanel } from "./components/recovery-panel";

function element(tag: string, attrs: Record<string, string> = {}, text?: string): ElementDescriptor {
  return { tag, attrs, ...(text !== undefined ? { text } : {}) };
}

/** Preserves the existing truthful pre-auth shell when the local application is unavailable. */
function renderDisabledShell(mount: HTMLElement): void {
  const status = element("div", { class: "status", role: "status", "aria-live": "polite" });
  const shell: ElementDescriptor = {
    tag: "div", attrs: { class: "shell" }, children: [{ tag: "main", attrs: { id: "main", class: "panel", tabindex: "-1" }, children: [
      element("p", { class: "eyebrow" }, "Local foundation"),
      element("h1", {}, "Due Good"),
      element("p", {}, "A private student planning workspace is being prepared. No Canvas account is connected in this local scaffold."),
      { ...status, children: [element("strong", {}, "Canvas connection unavailable"), element("span", {}, " Institution-enabled OAuth has not been configured.")] },
    ] }],
  };
  mount.replaceChildren(render(shell));
  const statusNode = mount.querySelector(".status");
  if (window.isSecureContext && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => statusNode?.replaceChildren(render(element("strong", {}, "Local app shell unavailable")), render(element("span", {}, " Reload after the secure test origin is ready."))));
  }
}

const EMPTY_DATA: DashboardData = { version: "", courses: [], events: [], resources: [], conversations: [], refreshes: [], profile: null, refreshAvailable: false, sourceStatus: {} };

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function optionalText(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function numeric(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function nullableNumeric(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function nullableText(value: unknown): string | null { return typeof value === "string" ? value : null; }
function timestamp(value: unknown): string | number | undefined { return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined; }
function rows(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }

function parseProfile(value: unknown): DashboardProfile | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const item = record(value);
  const avatarPath = typeof item.avatarPath === "string" ? safeLocalHref(item.avatarPath) ?? null : null;
  return { displayName: typeof item.displayName === "string" ? item.displayName : null, avatarPath };
}

export function dashboardEventKind(rawKind: string, rawType: string): DashboardEvent["kind"] {
  if (rawType === "class" || rawType === "class_meeting" || rawKind === "class" || rawKind === "class_meeting" || rawKind === "session") return "class";
  return rawKind === "discussion" ? "discussion" : "deadline";
}

function parseCourse(value: unknown): DashboardCourse | undefined {
  const item = record(value); const id = text(item.id, text(item.courseId)); const courseCode = text(item.courseCode, text(item.code));
  if (id.length === 0 || courseCode.length === 0) return undefined;
  const gradeGroups: DashboardGradeGroup[] = rows(item.gradeGroups).map((value) => { const group = record(value); return { id: nullableText(group.id), name: nullableText(group.name), weight: nullableNumeric(group.weight) }; });
  return { id, courseCode, title: text(item.title, text(item.name, courseCode)), ...(optionalText(item.term) === undefined ? {} : { term: optionalText(item.term) }), lastSuccessfulCheckAt: typeof item.lastSuccessfulCheckAt === "number" ? item.lastSuccessfulCheckAt : null, gradeGroups };
}

function parseEvent(value: unknown): DashboardEvent | undefined {
  const item = record(value); const id = text(item.id, text(item.sourceItemId)); const courseId = text(item.courseId); const courseCode = text(item.courseCode, text(item.course)); const startsAt = text(item.startsAt, text(item.at, text(item.dueAt))); const rawKind = text(item.kind, text(item.type, "deadline")); const rawType = text(item.type);
  if (id.length === 0 || courseCode.length === 0 || startsAt.length === 0 || text(item.title).length === 0) return undefined;
  const kind = dashboardEventKind(rawKind, rawType);
  return {
    id, ...(optionalText(item.sourceItemId) === undefined ? {} : { sourceItemId: optionalText(item.sourceItemId) }), courseId: courseId || courseCode, courseCode,
    kind, title: text(item.title), startsAt,
    ...(optionalText(item.endsAt ?? item.endAt) === undefined ? {} : { endsAt: optionalText(item.endsAt ?? item.endAt) }),
    ...(optionalText(item.location ?? item.place) === undefined ? {} : { location: optionalText(item.location ?? item.place) }),
    ...(optionalText(item.detail ?? item.description) === undefined ? {} : { detail: optionalText(item.detail ?? item.description) }),
    completed: item.completed === true, completedAt: typeof item.completedAt === "number" ? item.completedAt : null,
    ...(optionalText(item.submissionState) === undefined ? {} : { submissionState: optionalText(item.submissionState) }),
    source: typeof item.source === "string" ? item.source : null,
    points: nullableNumeric(item.points),
    score: nullableNumeric(item.score),
    grade: typeof item.grade === "string" ? item.grade : null,
    gradedAt: typeof item.gradedAt === "string" ? item.gradedAt : null,
    assignmentGroupId: nullableText(item.assignmentGroupId),
    assignmentGroupName: nullableText(item.assignmentGroupName),
    assignmentGroupWeight: nullableNumeric(item.assignmentGroupWeight),
    ...(kind === "discussion" ? { discussionPostDone: item.discussionPostDone === true, discussionRepliesDone: item.discussionRepliesDone === true } : {}),
  };
}

function parseResource(value: unknown): DashboardResource | undefined {
  const item = record(value); const id = text(item.id); const courseCode = text(item.courseCode, text(item.course)); const title = text(item.title, text(item.name));
  if (id.length === 0 || courseCode.length === 0 || title.length === 0) return undefined;
  return { id, courseId: text(item.courseId, courseCode), courseCode, type: text(item.type, "Item"), title, ...(optionalText(item.context) === undefined ? {} : { context: optionalText(item.context) }), ...(timestamp(item.updatedAt ?? item.updated) === undefined ? {} : { updatedAt: timestamp(item.updatedAt ?? item.updated) }), ...(optionalText(item.openPath ?? item.localUrl ?? item.openUrl) === undefined ? {} : { localUrl: optionalText(item.openPath ?? item.localUrl ?? item.openUrl) }), ...(item.savedLocally === true ? { savedLocally: true } : {}) };
}

function participantLabel(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  const participant = record(value);
  return optionalText(participant.name ?? participant.fullName ?? participant.displayName);
}

function parseAttachment(value: unknown): DashboardAttachment | undefined {
  const item = record(value); const name = text(item.name);
  return name.length === 0 ? undefined : { name, ...(optionalText(item.contentType) === undefined ? {} : { contentType: optionalText(item.contentType) }), ...(typeof item.sizeBytes === "number" ? { sizeBytes: item.sizeBytes } : {}) };
}

function parseMessage(value: unknown): DashboardMessage | undefined {
  const item = record(value); const body = typeof item.body === "string" ? item.body : undefined; const author = text(item.author, "Canvas participant");
  if (body === undefined) return undefined;
  return { ...(optionalText(item.canvasMessageId) === undefined ? {} : { id: optionalText(item.canvasMessageId) }), author, ...(timestamp(item.createdAt) === undefined ? {} : { createdAt: timestamp(item.createdAt) }), body, ...(item.bodyTruncated === true ? { bodyTruncated: true } : {}), attachments: rows(item.attachments).map(parseAttachment).filter((attachment): attachment is DashboardAttachment => attachment !== undefined) };
}

function parseConversation(value: unknown): DashboardConversation | undefined {
  const item = record(value); const id = text(item.id, text(item.canvasConversationId)); const subject = text(item.subject); if (id.length === 0 || subject.length === 0) return undefined;
  const participants = rows(item.participants).map(participantLabel).filter((name): name is string => name !== undefined);
  const messages = rows(item.messages).map(parseMessage).filter((message): message is DashboardMessage => message !== undefined);
  return {
    id,
    ...(optionalText(item.courseCode ?? item.course) === undefined ? {} : { courseCode: optionalText(item.courseCode ?? item.course) }),
    ...(optionalText(item.contextLabel) === undefined ? {} : { contextLabel: optionalText(item.contextLabel) }),
    sender: text(item.sender, participants.join(", ") || "Canvas"),
    subject,
    ...(optionalText(item.latestMessagePreview ?? item.preview) === undefined ? {} : { preview: optionalText(item.latestMessagePreview ?? item.preview) }),
    ...(optionalText(item.body) === undefined ? {} : { body: optionalText(item.body) }),
    ...(timestamp(item.latestMessageAt ?? item.receivedAt ?? item.received ?? item.lastMessageAt) === undefined ? {} : { receivedAt: timestamp(item.latestMessageAt ?? item.receivedAt ?? item.received ?? item.lastMessageAt) }),
    unread: item.unread === true,
    ...(typeof item.messageCount === "number" ? { messageCount: item.messageCount } : {}),
    ...(Array.isArray(item.attachments) ? { attachmentCount: item.attachments.length } : {}),
    ...(messages.length > 0 ? { messages } : {}),
    ...(typeof item.historyComplete === "boolean" ? { historyComplete: item.historyComplete } : {}),
    ...(item.safetyTruncated === true ? { safetyTruncated: true } : {}),
  };
}

function parseChange(value: unknown): DashboardRefreshChange | undefined {
  const item = record(value); const rawKind = text(item.kind, "notice").toLowerCase(); const title = text(item.title); if (title.length === 0) return undefined;
  const kind = rawKind === "added" || rawKind === "changed" || rawKind === "removed" ? rawKind : "notice";
  return { kind, title, detail: text(item.detail) };
}

function parseRefresh(value: unknown): DashboardRefresh | undefined {
  const item = record(value); const id = text(item.id); const startedAt = timestamp(item.finishedAt ?? item.startedAt ?? item.at); if (id.length === 0 || startedAt === undefined) return undefined;
  const rawStatus = text(item.status, "failed").toLowerCase(); const status = rawStatus === "complete" || rawStatus === "partial" ? rawStatus : "failed";
  const counts = record(item.summary);
  const summary = typeof item.summary === "string" ? item.summary : status === "partial" ? "Refresh was incomplete; existing data was kept." : "Canvas refresh completed.";
  return { id, startedAt, status, summary, added: numeric(item.added ?? counts.added), changed: numeric(item.changed ?? counts.changed), removed: numeric(item.removed ?? counts.removed), changes: rows(item.changes).map(parseChange).filter((change): change is DashboardRefreshChange => change !== undefined) };
}

export function parseDashboard(value: unknown): DashboardData {
  const body = record(value); const source = record(body.sourceStatus);
  const sourceStatus: DashboardSourceStatus = { ...(optionalText(source.state) === undefined ? {} : { state: optionalText(source.state) }), ...(optionalText(source.label) === undefined ? {} : { label: optionalText(source.label) }), ...(optionalText(source.detail) === undefined ? {} : { detail: optionalText(source.detail) }), ...(timestamp(source.lastRefreshAt) === undefined ? {} : { lastRefreshAt: timestamp(source.lastRefreshAt) }) };
  return {
    version: typeof body.version === "string" ? body.version : typeof body.version === "number" && Number.isFinite(body.version) ? String(body.version) : "",
    courses: rows(body.courses).map(parseCourse).filter((item): item is DashboardCourse => item !== undefined),
    events: rows(body.events).map(parseEvent).filter((item): item is DashboardEvent => item !== undefined),
    resources: rows(body.resources).map(parseResource).filter((item): item is DashboardResource => item !== undefined),
    conversations: rows(body.conversations).map(parseConversation).filter((item): item is DashboardConversation => item !== undefined),
    refreshes: rows(body.refreshes).map(parseRefresh).filter((item): item is DashboardRefresh => item !== undefined),
    profile: parseProfile(body.profile),
    refreshAvailable: body.refreshAvailable === true,
    sourceStatus,
  };
}

async function loadLegacyDashboard(refreshAvailable: boolean): Promise<DashboardData> {
  const connectionsResponse = await fetch("/api/connections", { credentials: "same-origin" });
  if (!connectionsResponse.ok) throw new Error("connections unavailable");
  const connections = rows(record(await connectionsResponse.json()).connections);
  if (!connections.some((connection) => record(connection).status === "active")) {
    return { ...EMPTY_DATA, refreshAvailable, sourceStatus: { state: "disconnected", label: "Canvas connection", detail: "No active Canvas connection." } };
  }
  const [coursesResponse, assignmentsResponse] = await Promise.all([
    fetch("/api/courses", { credentials: "same-origin" }),
    fetch("/api/assignments", { credentials: "same-origin" }),
  ]);
  if (!coursesResponse.ok || !assignmentsResponse.ok) throw new Error("legacy coursework unavailable");
  const courses = rows(record(await coursesResponse.json()).courses).map(parseCourse).filter((item): item is DashboardCourse => item !== undefined);
  const events = rows(record(await assignmentsResponse.json()).assignments).map(parseEvent).filter((item): item is DashboardEvent => item !== undefined);
  const lastRefreshAt = courses.map((course) => course.lastSuccessfulCheckAt ?? 0).reduce((latest, value) => Math.max(latest, value), 0) || null;
  return { version: "", courses, events, resources: [], conversations: [], refreshes: [], profile: null, refreshAvailable, sourceStatus: { state: courses.length > 0 ? "ready" : "no_course", label: "Canvas coursework", detail: courses.length > 0 ? "Assignments are available; local Library and Inbox are not active in this environment." : "No course has been selected.", lastRefreshAt } };
}

function pageFromHash(): DashboardPage {
  const candidate = window.location.hash.replace(/^#/, "");
  return DASHBOARD_ROUTES.some((route) => route.page === candidate) ? candidate as DashboardPage : "timeline";
}

function replaced(set: ReadonlySet<string>, id: string, include: boolean): ReadonlySet<string> { const next = new Set(set); if (include) next.add(id); else next.delete(id); return next; }

async function refreshLocalCsrf(previous: string): Promise<string | undefined> {
  try {
    const response = await fetch("/", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return undefined;
    const next = readLocalCsrfToken();
    return next !== undefined && next !== previous ? next : undefined;
  } catch {
    return undefined;
  }
}

export async function postMutation(path: string, body?: unknown): Promise<Response> {
  const token = readCsrfToken();
  if (token === undefined) throw new Error("csrf unavailable");
  const init = (csrf: string): RequestInit => ({ method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", [CSRF_HEADER_NAME]: csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const response = await fetch(path, init(token));
  if (response.status !== 403) return response;
  const refreshed = await refreshLocalCsrf(token);
  return refreshed === undefined ? response : fetch(path, init(refreshed));
}

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
function mountDashboard(mount: HTMLElement, authRefreshAvailable: boolean, transport: DashboardTransport, desktop?: DesktopDashboardOptions): () => void {
  const native = transport.mode === "native" ? transport as NativeTransport : undefined;
  let avatarUrl: string | undefined;
  let state: DashboardState = { page: pageFromHash(), loading: true, data: { ...EMPTY_DATA, refreshAvailable: authRefreshAvailable }, now: Date.now(), eventMode: "all", courseFilter: "all", gradeCourseFilter: "all", gradeMode: "all", resourceFilter: "all", expandedEventIds: new Set(), pendingCompletionIds: new Set(), failedCompletionIds: new Set(), pendingDiscussionIds: new Set(), failedDiscussionIds: new Set(), refreshState: "idle", ...(desktop === undefined ? {} : { desktop: desktop.info }) };
  let disposed = false;
  let snapshotStatusTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new AbortController();

  function draw(): void { if (disposed) return; state = { ...state, now: Date.now() }; mount.replaceChildren(render(renderDashboard(state, handlers))); }
  async function withAvatar(data: DashboardData): Promise<DashboardData> {
    if (native === undefined || data.profile === null) return data;
    const avatar = await native.readAvatar().catch(() => null);
    if (avatarUrl !== undefined) URL.revokeObjectURL(avatarUrl);
    avatarUrl = avatar === null ? undefined : URL.createObjectURL(new Blob([new Uint8Array(avatar.bytes).buffer], { type: avatar.contentType }));
    return { ...data, profile: { ...data.profile, avatarPath: avatarUrl ?? null } };
  }
  async function load(): Promise<void> {
    try {
      const body = await transport.loadDashboardBody(false);
      const data = await withAvatar(body !== undefined ? parseDashboard(body) : await loadLegacyDashboard(authRefreshAvailable));
      state = { ...state, loading: false, error: undefined, data: { ...data, refreshAvailable: native === undefined ? (data.refreshAvailable || authRefreshAvailable) : state.desktop?.refreshAvailable === true }, selectedConversationId: state.selectedConversationId ?? data.conversations[0]?.id, selectedRefreshId: state.selectedRefreshId ?? data.refreshes[0]?.id };
    } catch (error) {
      const detail = error instanceof DesktopCommandError ? ` ${error.message}` : "";
      state = { ...state, loading: false, error: `Coursework could not be loaded. No substitute or sample data was shown.${detail}` };
    }
    draw();
  }

  async function pollStartupSnapshot(): Promise<void> {
    if (disposed || native === undefined || state.desktop?.snapshotInProgress !== true) return;
    try {
      const status = await native.storeStatus();
      if (disposed) return;
      if (status.availability === "ready" && (status.state === "preview" || status.state === "authoritative")) {
        state = { ...state, desktop: { ...state.desktop!, canvasRefreshEnabled: status.canvasRefreshEnabled, refreshAvailable: status.refreshAvailable, snapshotInProgress: status.snapshotInProgress, snapshotProgress: status.snapshotProgress, warning: status.problem }, data: { ...state.data, refreshAvailable: status.refreshAvailable } };
        draw();
      }
      if (status.snapshotInProgress) snapshotStatusTimer = setTimeout(() => { void pollStartupSnapshot(); }, 500);
    } catch {
      if (!disposed) snapshotStatusTimer = setTimeout(() => { void pollStartupSnapshot(); }, 2000);
    }
  }

  async function reloadAuthoritativeDashboard(): Promise<boolean> {
    try {
      const body = await transport.loadDashboardBody(true);
      if (body === undefined) return false;
      const data = await withAvatar(parseDashboard(body));
      state = { ...state, data: { ...data, refreshAvailable: native === undefined ? (data.refreshAvailable || authRefreshAvailable) : state.desktop?.refreshAvailable === true }, selectedConversationId: data.conversations.some((conversation) => conversation.id === state.selectedConversationId) ? state.selectedConversationId : data.conversations[0]?.id, selectedRefreshId: data.refreshes[0]?.id };
      return true;
    } catch {
      return false;
    }
  }

  async function toggleCompletion(id: string): Promise<void> {
    if (state.readOnly === true) return;
    const item = state.data.events.find((event) => event.id === id); if (item === undefined || item.kind === "class") return;
    const target = !item.completed; const sourceItemId = item.sourceItemId ?? item.id;
    const update = (completed: boolean, completedAt: number | null) => state.data.events.map((event) => event.id === id ? { ...event, completed, completedAt } : event);
    state = { ...state, data: { ...state.data, events: update(target, target ? Date.now() : null) }, pendingCompletionIds: replaced(state.pendingCompletionIds, id, true), failedCompletionIds: replaced(state.failedCompletionIds, id, false), mutationError: undefined }; draw();
    let authoritativeReloaded = false;
    try {
      if (native !== undefined) {
        const result = await native.setCompletion(sourceItemId, item.completed, target);
        state = { ...state, data: { ...state.data, events: update(result.completed, result.completedAt) }, pendingCompletionIds: replaced(state.pendingCompletionIds, id, false) };
        draw();
        return;
      }
      const response = await postMutation(`/api/source-items/${encodeURIComponent(sourceItemId)}/completion`, { completed: target });
      if (response.status === 409) {
        const reloaded = await reloadAuthoritativeDashboard();
        authoritativeReloaded = reloaded;
        throw new Error(reloaded ? "This item changed elsewhere. Latest state reloaded; try again." : "This item changed elsewhere. Reload the page and try again.");
      }
      if (!response.ok) throw new Error(response.status === 403 ? "Could not save. The local session changed; reload the page and try again." : "Could not save. Existing completion state was restored.");
      const body = record(await response.json());
      state = { ...state, data: { ...state.data, events: update(body.completed === true, typeof body.completedAt === "number" ? body.completedAt : null) }, pendingCompletionIds: replaced(state.pendingCompletionIds, id, false) };
    } catch (error) {
      const nativeFailure = native === undefined ? undefined : await resolveNativeMutationConflict(error, reloadAuthoritativeDashboard, "item");
      if (nativeFailure !== undefined) authoritativeReloaded = nativeFailure.reloaded;
      state = { ...state, data: authoritativeReloaded ? state.data : { ...state.data, events: update(item.completed, item.completedAt ?? null) }, pendingCompletionIds: replaced(state.pendingCompletionIds, id, false), failedCompletionIds: replaced(state.failedCompletionIds, id, true), mutationError: { id, message: nativeFailure?.message ?? (error instanceof Error ? error.message : "Could not save. Existing completion state was restored.") } };
    }
    draw();
  }

  async function toggleDiscussion(id: string, field: "post" | "replies"): Promise<void> {
    if (state.readOnly === true) return;
    const item = state.data.events.find((event) => event.id === id); if (item === undefined || item.kind !== "discussion") return;
    const before = { post: item.discussionPostDone === true, replies: item.discussionRepliesDone === true };
    const target = { post: field === "post" ? !before.post : before.post, replies: field === "replies" ? !before.replies : before.replies };
    const update = (post: boolean, replies: boolean) => state.data.events.map((event) => event.id === id ? { ...event, discussionPostDone: post, discussionRepliesDone: replies } : event);
    state = { ...state, data: { ...state.data, events: update(target.post, target.replies) }, pendingDiscussionIds: replaced(state.pendingDiscussionIds, id, true), failedDiscussionIds: replaced(state.failedDiscussionIds, id, false), mutationError: undefined }; draw();
    let authoritativeReloaded = false;
    try {
      if (native !== undefined) {
        const result = await native.setDiscussionField(item.sourceItemId ?? item.id, field, before[field], target[field]);
        state = { ...state, data: { ...state.data, events: update(result.discussionPostDone, result.discussionRepliesDone) }, pendingDiscussionIds: replaced(state.pendingDiscussionIds, id, false) };
        draw();
        return;
      }
      const response = await postMutation(`/api/source-items/${encodeURIComponent(item.sourceItemId ?? item.id)}/discussion-progress`, { field, value: target[field] });
      if (response.status === 409) {
        const reloaded = await reloadAuthoritativeDashboard();
        authoritativeReloaded = reloaded;
        throw new Error(reloaded ? "This discussion changed elsewhere. Latest state reloaded; try again." : "This discussion changed elsewhere. Reload the page and try again.");
      }
      if (!response.ok) throw new Error(response.status === 403 ? "Could not save discussion progress. The local session changed; reload the page and try again." : "Could not save discussion progress. Existing marks were restored.");
      const body = record(await response.json());
      state = { ...state, data: { ...state.data, events: update(body.discussionPostDone === true, body.discussionRepliesDone === true) }, pendingDiscussionIds: replaced(state.pendingDiscussionIds, id, false) };
    } catch (error) {
      const nativeFailure = native === undefined ? undefined : await resolveNativeMutationConflict(error, reloadAuthoritativeDashboard, "discussion");
      if (nativeFailure !== undefined) authoritativeReloaded = nativeFailure.reloaded;
      state = { ...state, data: authoritativeReloaded ? state.data : { ...state.data, events: update(before.post, before.replies) }, pendingDiscussionIds: replaced(state.pendingDiscussionIds, id, false), failedDiscussionIds: replaced(state.failedDiscussionIds, id, true), mutationError: { id, message: nativeFailure?.message ?? (error instanceof Error ? error.message : "Could not save discussion progress. Existing marks were restored.") } };
    }
    draw();
  }

  async function refresh(): Promise<void> {
    if (!state.data.refreshAvailable || state.refreshState === "running") return;
    if (native !== undefined) {
      state = { ...state, refreshState: "running", refreshProgress: undefined, refreshDetail: undefined, refreshSettingError: undefined }; draw();
      try {
        const result = await native.startCanvasRefresh((progress: CanvasRefreshProgress) => {
          if (state.refreshState !== "running") return;
          state = { ...state, refreshProgress: progress };
          draw();
        });
        let data = state.data;
        let refreshDetail: string | undefined;
        try {
          const body = await transport.loadDashboardBody(true);
          if (body === undefined) throw new Error("missing refresh result");
          data = await withAvatar(parseDashboard(body));
        } catch {
          refreshDetail = "Refresh finished, but updated coursework could not be reloaded.";
        }
        const currentStatus = await native.storeStatus().catch(() => undefined);
        const desktop = currentStatus === undefined
          ? { ...state.desktop!, lastRefreshAt: result.updatedAt }
          : currentStatus.availability === "ready" && (currentStatus.state === "preview" || currentStatus.state === "authoritative")
            ? { ...state.desktop!, canvasRefreshEnabled: currentStatus.canvasRefreshEnabled, refreshAvailable: currentStatus.refreshAvailable, warning: currentStatus.problem, lastRefreshAt: result.updatedAt }
            : { ...state.desktop!, canvasRefreshEnabled: currentStatus.canvasRefreshEnabled, refreshAvailable: false, warning: currentStatus.problem, lastRefreshAt: result.updatedAt };
        const refreshState = result.status === "incomplete" ? "partial" : "complete";
        const refreshAvailable = currentStatus === undefined ? desktop.refreshAvailable === true : currentStatus.availability === "ready" && currentStatus.refreshAvailable;
        state = {
          ...state,
          desktop,
          data: { ...data, refreshAvailable },
          refreshState,
          refreshProgress: undefined,
          refreshDetail,
          selectedRefreshId: data.refreshes[0]?.id,
        };
      } catch {
        state = { ...state, refreshState: "failed", refreshProgress: undefined, refreshDetail: undefined };
      }
      draw();
      return;
    }
    const csrfToken = readCsrfToken(); if (csrfToken === undefined) { state = { ...state, refreshState: "failed" }; draw(); return; }
    state = { ...state, refreshState: "running" }; draw();
    try {
      const response = await postMutation("/api/local/refresh");
      if (!response.ok) throw new Error("refresh failed");
      const result = record(await response.json());
      const body = await transport.loadDashboardBody(false); if (body === undefined) throw new Error("reload failed");
      const data = parseDashboard(body);
      const refreshState = result.status === "partial" ? "partial" : "complete";
      state = { ...state, data: { ...data, refreshAvailable: data.refreshAvailable || authRefreshAvailable }, refreshState, selectedRefreshId: data.refreshes[0]?.id };
    } catch { state = { ...state, refreshState: "failed" }; }
    draw();
  }

  async function toggleCanvasRefresh(enabled: boolean): Promise<void> {
    if (native === undefined || state.desktop?.storeState !== "authoritative" || state.refreshSettingPending === true || state.refreshState === "running") return;
    state = { ...state, refreshSettingPending: true, refreshSettingError: undefined }; draw();
    try {
      const setting = await native.setCanvasRefreshEnabled(enabled);
      if (state.desktop !== undefined) state = {
        ...state,
        desktop: { ...state.desktop, canvasRefreshEnabled: setting.canvasRefreshEnabled, refreshAvailable: setting.refreshAvailable },
        data: { ...state.data, refreshAvailable: setting.refreshAvailable },
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
    if (native === undefined || state.desktop === undefined) return;
    let desktop: DesktopStoreInfo = {
      ...state.desktop,
      storeState: expected,
      ...(expected === "preview" ? { canvasRefreshEnabled: false, refreshAvailable: false } : { refreshAvailable: false }),
      warning: "The store changed, but its current status could not be verified. Reopen the app before relying on refresh.",
    };
    try {
      const status = await native.storeStatus();
      if (status.availability === "ready" && status.state === expected) {
        desktop = {
          storeState: expected,
          dataFolder: status.dataFolder,
          importedAt: status.importedAt,
          canvasRefreshEnabled: status.canvasRefreshEnabled,
          refreshAvailable: status.refreshAvailable,
          snapshotInProgress: status.snapshotInProgress,
          snapshotProgress: status.snapshotProgress,
          warning: status.problem,
        };
      }
    } catch { /* retain the command's reported state and fail refresh availability closed */ }
    state = { ...state, desktop, data: { ...state.data, refreshAvailable: desktop.refreshAvailable === true } };
    await reloadAuthoritativeDashboard();
  }

  async function prepareStorePromotion(): Promise<void> {
    if (native === undefined || state.desktop?.storeState !== "preview" || state.storeTransition?.phase === "preparing" || state.storeTransition?.phase === "promoting") return;
    state = { ...state, storeTransition: { phase: "preparing" } }; draw();
    try {
      const proof = await native.prepareStorePromotion(onStoreTransitionProgress("preparing"));
      state = { ...state, storeTransition: { phase: "ready", proof } };
    } catch (error) {
      const failure = transitionFailure(error, "Backup selection cancelled. The app store remains a preview copy.");
      state = { ...state, storeTransition: { phase: "idle", ...failure } };
    }
    draw();
  }

  async function confirmStorePromotion(proofId: string): Promise<void> {
    if (native === undefined || state.desktop?.storeState !== "preview" || state.storeTransition?.phase !== "ready" || state.storeTransition.proof?.proofId !== proofId) return;
    // Clear the proof before IPC; it cannot be retried in the webview after any outcome.
    state = { ...state, storeTransition: { phase: "promoting" } }; draw();
    try {
      const result = await native.confirmStorePromotion(proofId, onStoreTransitionProgress("promoting"));
      await refreshStoreAfterTransition(result.state);
      state = { ...state, storeTransition: { phase: "idle", message: `Promotion complete. ${String(result.files)} files · ${result.bytes} bytes are now in the authoritative app store.` } };
    } catch (error) {
      const failure = transitionFailure(error, "Promotion cancelled. The app store remains a preview copy; compare the backup again before retrying.");
      state = { ...state, storeTransition: { phase: "idle", ...failure } };
    }
    draw();
  }

  async function demoteStoreForRollback(): Promise<void> {
    if (native === undefined || state.desktop?.storeState !== "authoritative" || state.refreshState === "running" || state.refreshSettingPending === true || ["preparing", "promoting", "demoting", "exporting"].includes(state.storeTransition?.phase ?? "idle")) return;
    state = { ...state, storeTransition: { phase: "demoting" } }; draw();
    try {
      const result = await native.demoteStoreForRollback(onStoreTransitionProgress("demoting"));
      await refreshStoreAfterTransition(result.state);
      state = { ...state, storeTransition: { phase: "idle", rollbackExportVerified: false, message: `App store returned to preview. ${String(result.recoveryFiles)} recovery files · ${result.recoveryBytes} bytes were retained. Canvas refresh is off. Export the frozen legacy source next.` } };
    } catch (error) {
      const failure = transitionFailure(error, "Rollback cancelled. The app store remains authoritative.");
      state = { ...state, storeTransition: { phase: "idle", ...failure } };
    }
    draw();
  }

  async function exportFrozenRollback(): Promise<void> {
    if (native === undefined || state.desktop?.storeState !== "preview" || ["preparing", "promoting", "demoting", "exporting"].includes(state.storeTransition?.phase ?? "idle")) return;
    state = { ...state, storeTransition: { phase: "exporting", rollbackExportVerified: false } }; draw();
    try {
      const result = await native.exportFrozenForRollback(onStoreTransitionProgress("exporting"));
      if (!result.equal) throw new DesktopCommandError("export-mismatch", "The exported copy did not match the frozen source. Do not use it for rollback.");
      state = { ...state, storeTransition: { phase: "idle", rollbackExportVerified: true, message: `Frozen rollback copy verified: ${String(result.files)} files · ${result.bytes} bytes. Use this copy when restoring the legacy browser source.` } };
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
    const success = native === undefined ? await copyTextToClipboard(copyText).catch(() => false) : await native.copyText(copyText).then(() => true, () => false);
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
    onSelectConversation(selectedConversationId) { state = { ...state, selectedConversationId }; draw(); },
    onSelectRefresh(selectedRefreshId) { state = { ...state, selectedRefreshId }; draw(); },
    onRefresh() { void refresh(); },
    onToggleCanvasRefresh(enabled) { void toggleCanvasRefresh(enabled); },
    onCopyAssignment(id) { void copyAssignment(id); },
    ...(native === undefined ? {} : { onOpenResource(id: string) {
      state = { ...state, resourceNotice: "Opening the saved library file…" }; draw();
      void native.openResource(id).then((action) => { state = { ...state, resourceNotice: action === "downloaded" ? "File saved." : action === "opened" ? "File opened." : "Save cancelled." }; draw(); }, () => { state = { ...state, resourceNotice: "The saved file could not be opened." }; draw(); });
    } }),
    ...(native === undefined ? {} : {
      onPreparePromotion() { void prepareStorePromotion(); },
      onConfirmPromotion(proofId: string) { void confirmStorePromotion(proofId); },
      onCancelPromotion() { if (state.storeTransition?.phase === "ready") { state = { ...state, storeTransition: { phase: "idle", message: "Comparison discarded. The app store remains a preview copy." } }; draw(); } },
      onDemoteStore() { void demoteStoreForRollback(); },
      onExportFrozenRollback() { void exportFrozenRollback(); },
    }),
    ...(desktop?.onReplacePreview === undefined ? {} : { onReplacePreview: desktop.onReplacePreview }),
    ...(desktop?.onRecovery === undefined ? {} : { onRecovery: desktop.onRecovery }),
    ...(desktop?.onExport === undefined ? {} : { onExport: desktop.onExport }),
  };

  window.addEventListener("hashchange", () => { state = { ...state, page: pageFromHash() }; draw(); }, { signal: listeners.signal });
  draw(); void load(); void pollStartupSnapshot();
  if (transport.mode === "browser" && window.isSecureContext && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
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

const REFUSAL_LABELS: Readonly<Record<string, string>> = {
  missingCourseworkDocument: "coursework.json is missing",
  unsupportedRootEntries: "Unrecognized items at the top level",
  unsupportedCourseEntries: "Unrecognized items in course folders",
  unsupportedExportEntries: "Unrecognized items in Canvas exports",
  invalidCourseFolderNames: "Course folders with unsupported names",
  symlinksOutsideMaterials: "Links outside a materials folder",
  escapingMaterialSymlinks: "Material links that leave the materials folder",
  brokenMaterialSymlinks: "Broken material links",
  materialSymlinksToNonFiles: "Material links to folders or special files",
  specialFiles: "Special files (sockets, devices, pipes)",
  leftoverTemporaryFiles: "Leftover temporary files",
  staleLockRemnants: "Leftover lock folders",
  filesOverPerFileCap: "Files over the per-file cap",
  jsonDocumentsOverCap: "JSON documents over the JSON cap",
  totalBytesOverCap: "Total size over the cap",
  entriesOverCap: "More files and folders than the cap",
  materialsNestedTooDeep: "Materials nested deeper than the cap",
  malformedJson: "Malformed JSON documents",
  duplicateJsonKeys: "JSON documents with duplicate keys",
  invalidCourseworkDocument: "Invalid coursework document",
  duplicateCourseKeys: "Duplicate course keys",
  duplicateItemIds: "Duplicate item IDs",
  nonUtf8Names: "Names that are not valid UTF-8",
  unreadableEntries: "Unreadable items",
};

const INVENTORY_LABELS: readonly (readonly [string, string])[] = [
  ["courseworkDocuments", "Coursework documents"],
  ["courseFolders", "Course folders"],
  ["exportDocuments", "Canvas export documents"],
  ["materialFiles", "Material files"],
  ["historyDocuments", "Refresh history documents"],
  ["inboxDocuments", "Inbox documents"],
  ["profileDocuments", "Profile documents"],
  ["files", "Files in total"],
  ["directories", "Folders in total"],
];

const PHASE_LABELS: Readonly<Record<ImportProgress["phase"], string>> = {
  locking: "Waiting for the browser app's lock",
  scanning: "Checking the legacy folder",
  hashing: "Fingerprinting files",
  copying: "Copying files",
  rechecking: "Confirming nothing changed during the copy",
  validating: "Validating the copy",
  adopting: "Adopting the preview copy",
  complete: "Import complete",
};

/** The first-run / recovery screen state. The legacy folder path never reaches the webview. */
export interface DesktopSetupState {
  readonly status: DesktopStoreStatus;
  readonly replacePreview: boolean;
  readonly step: "idle" | "choosing" | "checking" | "ready" | "importing";
  readonly report?: DryRunReport;
  readonly progress?: ImportProgress;
  readonly error?: { readonly message: string; readonly refusals: Readonly<Record<string, number>>; readonly unsupportedTypes: Readonly<Record<string, number>> };
  readonly recoveryMode?: boolean;
  readonly snapshots?: readonly DesktopSnapshot[];
  readonly recoveryBusy?: boolean;
  readonly recoveryMessage?: string;
  readonly recoveryFilesDone?: number;
}

export interface DesktopSetupHandlers {
  readonly onChoose: () => void;
  readonly onRecheck: () => void;
  readonly onImport: () => void;
  readonly onCancel?: () => void;
  readonly onRestoreSnapshot?: (id: string) => void;
  readonly onExport?: () => void;
}

function byteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? "TB"}`;
}

function countRows(counts: Readonly<Record<string, number>>, labels: Readonly<Record<string, string>>, className: string): ElementDescriptor {
  return { tag: "ul", attrs: { class: className }, children: Object.entries(counts).map(([name, total]) => ({ tag: "li", children: [element("span", {}, labels[name] ?? name), element("strong", {}, String(total))] })) };
}

function setupPanel(eyebrow: string, title: string, children: readonly ElementDescriptor[]): ElementDescriptor {
  return { tag: "div", attrs: { class: "shell desktop-setup" }, children: [{ tag: "main", attrs: { id: "main", class: "panel setup-card", tabindex: "-1" }, children: [element("p", { class: "eyebrow" }, eyebrow), element("h1", {}, title), ...children] }] };
}

function folderBox(label: string, note: string, folder: string): ElementDescriptor {
  return { tag: "div", attrs: { class: "setup-choice" }, children: [element("strong", {}, label), element("small", {}, note), element("code", { class: "setup-path" }, folder.length > 0 ? folder : "Unavailable")] };
}

/** Renders the desktop first-run, replace-preview, and recovery screens as a pure descriptor. */
export function renderDesktopSetup(state: DesktopSetupState, handlers: DesktopSetupHandlers): ElementDescriptor {
  const { status } = state;
  const dataFolder = folderBox("App data folder", "Fixed for this app on this computer. It cannot be changed.", status.dataFolder);
  if (status.availability === "another-instance") {
    return setupPanel("Desktop app", "Due Good is already open", [element("p", {}, "Another Due Good window owns the app store. Use that window; this one reads and changes nothing."), dataFolder]);
  }
  if (status.availability === "unavailable") {
    return setupPanel("Desktop app", "App data folder unavailable", [element("p", { role: "alert" }, status.problem ?? "The app data folder could not be opened."), dataFolder]);
  }
  if (state.recoveryMode === true) {
    return setupPanel("Recovery", "Recover or export coursework", [
      desktopRecoveryPanel({ snapshots: state.snapshots ?? [], importedAt: status.importedAt, busy: state.recoveryBusy === true, message: state.recoveryMessage, filesDone: state.recoveryFilesDone }, {
        onRestore: (id) => handlers.onRestoreSnapshot?.(id),
        onExport: () => handlers.onExport?.(),
        ...(status.state === "preview" || status.state === "authoritative" ? { onBack: () => handlers.onCancel?.() } : {}),
      }),
      ...(state.error === undefined ? [] : [element("p", { role: "alert" }, state.error.message)]),
    ]);
  }
  if (status.state === "damaged" || status.state === "unknown") {
    return setupPanel("Recovery", "The app store needs recovery", [
      element("p", {}, "Due Good found its app store but could not read it safely. Nothing was changed, and nothing will be imported over it."),
      ...(status.problem === null ? [] : [element("p", { class: "status", role: "status" }, status.problem)]),
      dataFolder,
    ]);
  }
  const busy = state.step === "choosing" || state.step === "checking" || state.step === "importing";
  const report = state.report;
  const progress = state.progress;
  const disabled = (flag: boolean): Record<string, string> => flag ? { disabled: "" } : {};
  const stepNote = state.step === "choosing" ? "Waiting for the folder picker…" : state.step === "checking" ? "Running a dry run. Nothing is copied." : status.legacyRootSelected ? "Folder selected. Its location is never shown or stored." : "No folder selected.";
  const children: ElementDescriptor[] = [
    element("p", {}, state.replacePreview
      ? "Import the legacy folder again. The current preview copy is first archived into a private, timestamped backup that is never deleted."
      : "Import your existing Due Good folder once. Due Good copies it into its own app store and never changes the original folder."),
    { tag: "p", attrs: { class: "preview-label" }, children: [element("span", { class: "preview-badge" }, "Preview copy"), element("span", {}, " It never refreshes or follows later changes in the browser app. Personal progress edits stay in this copy.")] },
    dataFolder,
    { tag: "div", attrs: { class: "setup-choice" }, children: [
      element("strong", {}, "Legacy folder"),
      element("small", {}, "The folder that holds coursework.json and the classes folder. Chosen with the system folder picker."),
      element("span", { class: "setup-step", role: "status", "aria-live": "polite" }, stepNote),
      { tag: "div", attrs: { class: "setup-actions" }, children: [
        { tag: "button", attrs: { type: "button", class: "more-action", ...disabled(busy) }, text: "Choose legacy folder…", on: { click: handlers.onChoose } },
        ...(status.legacyRootSelected && !busy ? [{ tag: "button", attrs: { type: "button", class: "setup-secondary" }, text: "Check again", on: { click: handlers.onRecheck } }] : []),
      ] },
    ] },
  ];
  if (report !== undefined) {
    const inventory = Object.fromEntries(INVENTORY_LABELS.filter(([name]) => name in report.inventory).map(([name]) => [name, report.inventory[name] ?? 0]));
    children.push({ tag: "section", attrs: { class: "setup-report", "aria-label": "Dry run" }, children: [
      element("h2", {}, "Dry run"),
      element("p", {}, `Counts only; nothing was copied. ${byteSize(report.inventory.bytes ?? 0)} in total.`),
      countRows(inventory, Object.fromEntries(INVENTORY_LABELS), "setup-counts"),
      ...(report.legacyLockPresent ? [element("p", { class: "status", role: "status" }, "The browser app is writing right now. The import waits for it to finish.")] : []),
      ...(Object.keys(report.refusals).length === 0 ? [] : [element("p", { class: "inline-error" }, "The folder cannot be imported as it is. Nothing is dropped silently:"), countRows(report.refusals, REFUSAL_LABELS, "setup-counts setup-refusals")]),
      ...(Object.keys(report.unsupportedTypes).length === 0 ? [] : [element("p", {}, "Unsupported items by type:"), countRows(report.unsupportedTypes, {}, "setup-counts")]),
    ] });
  }
  if (state.step === "importing") {
    const total = progress?.filesTotal ?? 0;
    children.push({ tag: "div", attrs: { class: "setup-progress", role: "status", "aria-live": "polite" }, children: [
      element("strong", {}, progress === undefined ? "Starting the import…" : PHASE_LABELS[progress.phase]),
      { tag: "progress", attrs: { max: String(Math.max(total, 1)), value: String(progress?.filesDone ?? 0), "aria-label": "Import progress" } },
      element("span", {}, progress === undefined ? "" : `${String(progress.filesDone)} of ${String(progress.filesTotal)} files · ${byteSize(progress.bytesDone)} of ${byteSize(progress.bytesTotal)}`),
    ] });
  }
  if (state.error !== undefined) {
    children.push({ tag: "div", attrs: { class: "load-error", role: "alert" }, children: [
      element("strong", {}, state.error.message),
      ...(Object.keys(state.error.refusals).length === 0 ? [] : [countRows(state.error.refusals, REFUSAL_LABELS, "setup-counts setup-refusals")]),
      ...(Object.keys(state.error.unsupportedTypes).length === 0 ? [] : [countRows(state.error.unsupportedTypes, {}, "setup-counts")]),
    ] });
  }
  children.push({ tag: "div", attrs: { class: "setup-actions" }, children: [
    { tag: "button", attrs: { type: "button", class: "sync-button", ...disabled(busy || report?.wouldImport !== true) }, text: state.replacePreview ? "Archive and replace preview copy" : "Import as preview copy", on: { click: handlers.onImport } },
    ...(!state.replacePreview || handlers.onCancel === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "setup-secondary", ...disabled(state.step === "importing") }, text: "Keep current preview copy", on: { click: handlers.onCancel } }]),
  ] });
  return setupPanel(state.replacePreview ? "Replace preview copy" : "One-time setup", state.replacePreview ? "Replace the preview copy" : "Set up local storage", children);
}

function setupError(error: unknown): NonNullable<DesktopSetupState["error"]> {
  if (error instanceof DesktopCommandError) return { message: error.message, refusals: error.refusals, unsupportedTypes: error.unsupportedTypes };
  return { message: "The desktop command failed. Nothing was changed.", refusals: {}, unsupportedTypes: {} };
}

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
    const info: DesktopStoreInfo = { storeState, dataFolder: status.dataFolder, importedAt: status.importedAt, canvasRefreshEnabled: status.canvasRefreshEnabled, refreshAvailable: status.refreshAvailable, snapshotInProgress: status.snapshotInProgress, snapshotProgress: status.snapshotProgress, warning: status.problem };
    setup = undefined;
    // An authoritative store is never replaced by import, so only a preview offers replacement.
    disposeDashboard = mountDashboard(mount, false, transport, { info, onRecovery: () => startRecovery(status), onExport: () => { startRecovery(status); void runExport(); }, ...(storeState === "preview" ? { onReplacePreview: () => startSetup(status, true) } : {}) });
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

  const setupHandlers: DesktopSetupHandlers = {
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
  if (isTauri()) {
    mountDesktop(mountEl, createNativeTransport((command, args) => invoke(command, args), (onMessage) => new Channel<unknown>(onMessage)));
    return;
  }
  const transport = createBrowserTransport();
  fetch("/api/auth/status", { credentials: "same-origin" }).then((response) => response.ok ? response.json() : { available: false }).then((body: unknown) => { const status = record(body); if (status.available === true) mountDashboard(mountEl, status.refreshAvailable === true, transport); else renderDisabledShell(mountEl); }).catch(() => renderDisabledShell(mountEl));
}
