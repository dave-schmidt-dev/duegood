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
  safeLocalHref,
} from "./pages/dashboard";
import { DASHBOARD_ROUTES, type DashboardPage } from "./routes";

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

const EMPTY_DATA: DashboardData = { version: 1, courses: [], events: [], resources: [], conversations: [], refreshes: [], profile: null, refreshAvailable: false, sourceStatus: {} };

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
  return { id, courseId: text(item.courseId, courseCode), courseCode, type: text(item.type, "Item"), title, ...(optionalText(item.context) === undefined ? {} : { context: optionalText(item.context) }), ...(timestamp(item.updatedAt ?? item.updated) === undefined ? {} : { updatedAt: timestamp(item.updatedAt ?? item.updated) }), ...(optionalText(item.openPath ?? item.localUrl ?? item.openUrl) === undefined ? {} : { localUrl: optionalText(item.openPath ?? item.localUrl ?? item.openUrl) }) };
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
    version: numeric(body.version, 1),
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
  return { version: 1, courses, events, resources: [], conversations: [], refreshes: [], profile: null, refreshAvailable, sourceStatus: { state: courses.length > 0 ? "ready" : "no_course", label: "Canvas coursework", detail: courses.length > 0 ? "Assignments are available; local Library and Inbox are not active in this environment." : "No course has been selected.", lastRefreshAt } };
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

function mountDashboard(mount: HTMLElement, authRefreshAvailable: boolean): void {
  let state: DashboardState = { page: pageFromHash(), loading: true, data: { ...EMPTY_DATA, refreshAvailable: authRefreshAvailable }, now: Date.now(), eventMode: "all", courseFilter: "all", gradeCourseFilter: "all", gradeMode: "all", resourceFilter: "all", expandedEventIds: new Set(), pendingCompletionIds: new Set(), failedCompletionIds: new Set(), pendingDiscussionIds: new Set(), failedDiscussionIds: new Set(), refreshState: "idle" };

  function draw(): void { state = { ...state, now: Date.now() }; mount.replaceChildren(render(renderDashboard(state, handlers))); }
  async function load(): Promise<void> {
    try {
      const response = await fetch("/api/dashboard", { credentials: "same-origin" });
      const data = response.ok ? parseDashboard(await response.json()) : await loadLegacyDashboard(authRefreshAvailable);
      state = { ...state, loading: false, error: undefined, data: { ...data, refreshAvailable: data.refreshAvailable || authRefreshAvailable }, selectedConversationId: state.selectedConversationId ?? data.conversations[0]?.id, selectedRefreshId: state.selectedRefreshId ?? data.refreshes[0]?.id };
    } catch {
      state = { ...state, loading: false, error: "Coursework could not be loaded. No substitute or sample data was shown." };
    }
    draw();
  }

  async function reloadAuthoritativeDashboard(): Promise<boolean> {
    try {
      const response = await fetch("/api/dashboard", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return false;
      const data = parseDashboard(await response.json());
      state = { ...state, data: { ...data, refreshAvailable: data.refreshAvailable || authRefreshAvailable }, selectedConversationId: data.conversations.some((conversation) => conversation.id === state.selectedConversationId) ? state.selectedConversationId : data.conversations[0]?.id, selectedRefreshId: data.refreshes[0]?.id };
      return true;
    } catch {
      return false;
    }
  }

  async function toggleCompletion(id: string): Promise<void> {
    const item = state.data.events.find((event) => event.id === id); if (item === undefined || item.kind === "class") return;
    const target = !item.completed; const sourceItemId = item.sourceItemId ?? item.id;
    const update = (completed: boolean, completedAt: number | null) => state.data.events.map((event) => event.id === id ? { ...event, completed, completedAt } : event);
    state = { ...state, data: { ...state.data, events: update(target, target ? Date.now() : null) }, pendingCompletionIds: replaced(state.pendingCompletionIds, id, true), failedCompletionIds: replaced(state.failedCompletionIds, id, false), mutationError: undefined }; draw();
    let authoritativeReloaded = false;
    try {
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
      state = { ...state, data: authoritativeReloaded ? state.data : { ...state.data, events: update(item.completed, item.completedAt ?? null) }, pendingCompletionIds: replaced(state.pendingCompletionIds, id, false), failedCompletionIds: replaced(state.failedCompletionIds, id, true), mutationError: { id, message: error instanceof Error ? error.message : "Could not save. Existing completion state was restored." } };
    }
    draw();
  }

  async function toggleDiscussion(id: string, field: "post" | "replies"): Promise<void> {
    const item = state.data.events.find((event) => event.id === id); if (item === undefined || item.kind !== "discussion") return;
    const before = { post: item.discussionPostDone === true, replies: item.discussionRepliesDone === true };
    const target = { post: field === "post" ? !before.post : before.post, replies: field === "replies" ? !before.replies : before.replies };
    const update = (post: boolean, replies: boolean) => state.data.events.map((event) => event.id === id ? { ...event, discussionPostDone: post, discussionRepliesDone: replies } : event);
    state = { ...state, data: { ...state.data, events: update(target.post, target.replies) }, pendingDiscussionIds: replaced(state.pendingDiscussionIds, id, true), failedDiscussionIds: replaced(state.failedDiscussionIds, id, false), mutationError: undefined }; draw();
    let authoritativeReloaded = false;
    try {
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
      state = { ...state, data: authoritativeReloaded ? state.data : { ...state.data, events: update(before.post, before.replies) }, pendingDiscussionIds: replaced(state.pendingDiscussionIds, id, false), failedDiscussionIds: replaced(state.failedDiscussionIds, id, true), mutationError: { id, message: error instanceof Error ? error.message : "Could not save discussion progress. Existing marks were restored." } };
    }
    draw();
  }

  async function refresh(): Promise<void> {
    if (!state.data.refreshAvailable || state.refreshState === "running") return;
    const csrfToken = readCsrfToken(); if (csrfToken === undefined) { state = { ...state, refreshState: "failed" }; draw(); return; }
    state = { ...state, refreshState: "running" }; draw();
    try {
      const response = await postMutation("/api/local/refresh");
      if (!response.ok) throw new Error("refresh failed");
      const result = record(await response.json());
      const dashboard = await fetch("/api/dashboard", { credentials: "same-origin" }); if (!dashboard.ok) throw new Error("reload failed");
      const data = parseDashboard(await dashboard.json());
      const refreshState = result.status === "partial" ? "partial" : "complete";
      state = { ...state, data: { ...data, refreshAvailable: data.refreshAvailable || authRefreshAvailable }, refreshState, selectedRefreshId: data.refreshes[0]?.id };
    } catch { state = { ...state, refreshState: "failed" }; }
    draw();
  }

  const copyTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  async function copyAssignment(id: string): Promise<void> {
    const item = state.data.events.find((event) => event.id === id);
    if (item === undefined || item.kind === "class") return;
    const copyText = formatAssignmentCopyText(item);
    const success = await copyTextToClipboard(copyText);
    const status: "copied" | "failed" = success ? "copied" : "failed";

    const prev = copyTimeouts.get(id);
    if (prev !== undefined) clearTimeout(prev);

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
    onCopyAssignment(id) { void copyAssignment(id); },
  };

  window.addEventListener("hashchange", () => { state = { ...state, page: pageFromHash() }; draw(); });
  draw(); void load();
  if (window.isSecureContext && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

export function mount(): void {
  const mountEl = document.querySelector<HTMLElement>("#app"); if (!mountEl) throw new Error("Missing application mount point.");
  fetch("/api/auth/status", { credentials: "same-origin" }).then((response) => response.ok ? response.json() : { available: false }).then((body: unknown) => { const status = record(body); if (status.available === true) mountDashboard(mountEl, status.refreshAvailable === true); else renderDisabledShell(mountEl); }).catch(() => renderDisabledShell(mountEl));
}
