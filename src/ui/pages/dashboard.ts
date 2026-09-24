import type { ElementDescriptor } from "../dom";
import { dashboardNav, type DashboardPage } from "../routes";

export interface DashboardGradeGroup { readonly id: string | null; readonly name: string | null; readonly weight: number | null }
export interface DashboardCourse { readonly id: string; readonly courseCode: string; readonly title: string; readonly term?: string; readonly lastSuccessfulCheckAt?: number | null; readonly gradeGroups?: readonly DashboardGradeGroup[] }
export interface DashboardEvent { readonly id: string; readonly sourceItemId?: string; readonly courseId: string; readonly courseCode: string; readonly kind: "deadline" | "class" | "discussion"; readonly title: string; readonly startsAt: string; readonly endsAt?: string | null; readonly location?: string | null; readonly detail?: string | null; readonly completed: boolean; readonly completedAt?: number | null; readonly submissionState?: string; readonly source?: string | null; readonly points?: number | null; readonly score?: number | null; readonly grade?: string | null; readonly gradedAt?: string | null; readonly assignmentGroupId?: string | null; readonly assignmentGroupName?: string | null; readonly assignmentGroupWeight?: number | null; readonly discussionPostDone?: boolean; readonly discussionRepliesDone?: boolean }
export interface DashboardResource { readonly id: string; readonly courseId: string; readonly courseCode: string; readonly type: string; readonly title: string; readonly context?: string | null; readonly updatedAt?: string | number | null; readonly localUrl?: string | null; readonly savedLocally?: boolean }
export interface DashboardMessage { readonly id?: string | null; readonly author: string; readonly createdAt?: string | number | null; readonly body: string; readonly bodyTruncated?: boolean; readonly attachments: readonly DashboardAttachment[] }
export interface DashboardAttachment { readonly name: string; readonly contentType?: string | null; readonly sizeBytes?: number | null }
export interface DashboardConversation { readonly id: string; readonly courseCode?: string | null; readonly contextLabel?: string | null; readonly sender: string; readonly subject: string; readonly preview?: string | null; readonly body?: string | null; readonly receivedAt?: string | number | null; readonly unread: boolean; readonly messageCount?: number; readonly attachmentCount?: number; readonly messages?: readonly DashboardMessage[]; readonly historyComplete?: boolean; readonly safetyTruncated?: boolean }
export interface DashboardRefreshChange { readonly kind: "added" | "changed" | "removed" | "notice"; readonly title: string; readonly detail: string }
export interface DashboardRefresh { readonly id: string; readonly startedAt: string | number; readonly status: "complete" | "partial" | "failed"; readonly summary: string; readonly added: number; readonly changed: number; readonly removed: number; readonly changes: readonly DashboardRefreshChange[] }
export interface DashboardSourceStatus { readonly state?: string; readonly label?: string; readonly detail?: string; readonly lastRefreshAt?: string | number | null }
export interface DashboardProfile { readonly displayName: string | null; readonly avatarPath: string | null }
/** Desktop mode: which app store the data came from. Absent in browser mode. */
export interface DesktopStoreInfo { readonly storeState: "preview" | "authoritative"; readonly dataFolder: string; readonly importedAt: string | null; readonly lastRefreshAt?: string | null; readonly canvasRefreshEnabled?: boolean; readonly refreshAvailable?: boolean; readonly snapshotInProgress?: boolean; readonly snapshotProgress?: { readonly filesDone: number; readonly bytesDone: number } | null; readonly warning?: string | null }
/** `version` is the opaque exact-byte digest of the coursework document (empty when unknown). */
export interface DashboardData { readonly version: string; readonly courses: readonly DashboardCourse[]; readonly events: readonly DashboardEvent[]; readonly resources: readonly DashboardResource[]; readonly conversations: readonly DashboardConversation[]; readonly refreshes: readonly DashboardRefresh[]; readonly profile: DashboardProfile | null; readonly refreshAvailable: boolean; readonly sourceStatus: DashboardSourceStatus }

export interface DashboardState {
  readonly page: DashboardPage;
  readonly loading: boolean;
  readonly error?: string;
  readonly data: DashboardData;
  readonly now: number;
  readonly eventMode: "all" | "deadlines";
  readonly courseFilter: string;
  readonly gradeCourseFilter: string;
  readonly gradeMode: "all" | "graded";
  readonly resourceFilter: string;
  readonly expandedEventIds: ReadonlySet<string>;
  readonly pendingCompletionIds: ReadonlySet<string>;
  readonly failedCompletionIds: ReadonlySet<string>;
  readonly pendingDiscussionIds: ReadonlySet<string>;
  readonly failedDiscussionIds: ReadonlySet<string>;
  readonly mutationError?: { readonly id: string; readonly message: string };
  readonly selectedConversationId?: string;
  readonly selectedRefreshId?: string;
  readonly refreshState: "idle" | "running" | "complete" | "partial" | "failed";
  readonly refreshProgress?: { readonly phase: string; readonly completed: number; readonly total: number | null; readonly bytesDone: number | null };
  readonly refreshSettingPending?: boolean;
  readonly refreshSettingError?: string;
  readonly refreshDetail?: string;
  readonly copyFeedback?: Readonly<Record<string, "pending" | "copied" | "failed">>;
  /** Desktop mode only. */
  readonly desktop?: DesktopStoreInfo;
  /** Completion and discussion controls render disabled only when explicitly requested. */
  readonly readOnly?: boolean;
  readonly resourceNotice?: string;
  /** Native cutover/rollback operation state. The proof is opaque and memory-only. */
  readonly storeTransition?: {
    readonly phase: "idle" | "preparing" | "ready" | "promoting" | "demoting" | "exporting";
    readonly proof?: { readonly proofId: string; readonly files: number; readonly bytes: number };
    readonly rollbackExportVerified?: boolean;
    readonly progress?: { readonly filesDone: number; readonly bytesDone: number };
    readonly message?: string;
    readonly error?: boolean;
  };
}

export interface DashboardHandlers {
  readonly onNavigate: (page: DashboardPage) => void;
  readonly onEventMode: (mode: "all" | "deadlines") => void;
  readonly onCourseFilter: (courseCode: string) => void;
  readonly onGradeCourseFilter: (courseCode: string) => void;
  readonly onGradeMode: (mode: "all" | "graded") => void;
  readonly onResourceFilter: (type: string) => void;
  readonly onToggleEvent: (id: string) => void;
  readonly onToggleCompletion: (id: string) => void;
  readonly onToggleDiscussion: (id: string, field: "post" | "replies") => void;
  readonly onSelectConversation: (id: string) => void;
  readonly onSelectRefresh: (id: string) => void;
  readonly onRefresh: () => void;
  readonly onToggleCanvasRefresh?: (enabled: boolean) => void;
  readonly onCopyAssignment: (id: string) => void;
  /** Native-only action: Rust resolves an internal Library ID and opens or saves it. */
  readonly onOpenResource?: (id: string) => void;
  readonly onRecovery?: () => void;
  readonly onExport?: () => void;
  /** Desktop preview only: archive the preview copy and import the legacy folder again. */
  readonly onReplacePreview?: () => void;
  readonly onPreparePromotion?: () => void;
  readonly onConfirmPromotion?: (proofId: string) => void;
  readonly onCancelPromotion?: () => void;
  readonly onDemoteStore?: () => void;
  readonly onExportFrozenRollback?: () => void;
}

const COLORS = ["#365e8d", "#8b7840", "#4e785f", "#8a5d72", "#67717f"] as const;
const KNOWN_ORDER: Readonly<Record<string, number>> = { IT530: 0, IT540: 1, IT570: 2 };

function el(tag: string, text?: string, attrs?: Record<string, string>, children?: readonly ElementDescriptor[]): ElementDescriptor {
  return { tag, ...(text === undefined ? {} : { text }), ...(attrs === undefined ? {} : { attrs }), ...(children === undefined ? {} : { children }) };
}
function key(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function code(value: string): string { const match = /^(IT)(\d+)$/.exec(key(value)); return match ? `${match[1]} ${match[2]}` : value; }
function orderedCourses(courses: readonly DashboardCourse[]): readonly DashboardCourse[] {
  return [...courses].sort((a, b) => (KNOWN_ORDER[key(a.courseCode)] ?? 100) - (KNOWN_ORDER[key(b.courseCode)] ?? 100) || key(a.courseCode).localeCompare(key(b.courseCode)) || a.id.localeCompare(b.id));
}
function color(courses: readonly DashboardCourse[], courseCode: string): string {
  const index = Math.max(0, orderedCourses(courses).findIndex((course) => key(course.courseCode) === key(courseCode)));
  return COLORS[index % COLORS.length] ?? COLORS[0];
}
function asDate(value: string | number | null | undefined): Date | undefined { if (value === null || value === undefined || value === "") return undefined; const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date; }
function formatted(value: string | number | null | undefined, withTime = false): string { const date = asDate(value); return date === undefined ? "Unknown" : new Intl.DateTimeFormat("en-US", withTime ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }).format(date); }
function time(value: string | number | null | undefined): string { const date = asDate(value); return date === undefined ? "Time unknown" : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date); }
function dayKey(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function startOfDay(timestamp: number): Date { const date = new Date(timestamp); date.setHours(0, 0, 0, 0); return date; }
export function countdownText(now: number, deadline: string): string { const due = asDate(deadline); if (due === undefined) return "Time unknown"; const minutes = Math.max(0, Math.floor((due.getTime() - now) / 60_000)); const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const remainder = minutes % 60; return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`; }
export function safeLocalHref(value: string | null | undefined): string | undefined { return value !== null && value !== undefined && /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/.test(value) ? value : undefined; }
function empty(text: string): ElementDescriptor { return el("div", text, { class: "empty-state", role: "status" }); }
function heading(eyebrow: string, title: string, copy: string, count?: string): ElementDescriptor { return el("header", undefined, { class: "subpage-heading" }, [el("div", undefined, undefined, [el("p", eyebrow, { class: "eyebrow" }), el("h1", title), el("p", copy)]), ...(count === undefined ? [] : [el("div", count, { class: "page-count" })])]); }

function locked(state: DashboardState, id: string, pendingIds: ReadonlySet<string>): boolean {
  return pendingIds.has(id) || state.readOnly === true;
}

function completionButton(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const pending = state.pendingCompletionIds.has(event.id);
  const disabled = locked(state, event.id, state.pendingCompletionIds);
  return { tag: "button", attrs: { type: "button", class: "complete-button", ...(disabled ? { disabled: "" } : {}) }, text: pending ? "Saving…" : event.completed ? "Mark not done" : "Mark complete", on: { click: () => handlers.onToggleCompletion(event.id) } };
}

function completionCheckbox(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const disabled = locked(state, event.id, state.pendingCompletionIds);
  return el("label", undefined, { class: "event-check" }, [{ tag: "input", attrs: { type: "checkbox", "aria-label": "Done", ...(event.completed ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) }, on: { change: () => handlers.onToggleCompletion(event.id) } }, el("span", "Done")]);
}

function discussionCheckboxes(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): readonly ElementDescriptor[] {
  if (event.kind !== "discussion") return [];
  const disabled = locked(state, event.id, state.pendingDiscussionIds);
  const checkbox = (field: "post" | "replies", ariaLabel: string, title: string, hint: string, checked: boolean): ElementDescriptor => el("label", undefined, { class: "event-check discussion-step", "data-discussion-step": field }, [
    { tag: "input", attrs: { type: "checkbox", "aria-label": ariaLabel, ...(checked ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) }, on: { change: () => handlers.onToggleDiscussion(event.id, field) } },
    el("span", undefined, { class: "discussion-step__copy" }, [el("strong", title), el("small", hint)]),
  ]);
  return [
    checkbox("post", "Posted my response", "Main post", "Complete your original response", event.discussionPostDone === true),
    checkbox("replies", "Replied to two classmates", "Replies", "Respond to 2 classmates", event.discussionRepliesDone === true),
  ];
}

function failureMessage(state: DashboardState, id: string, fallback: string): string {
  return state.mutationError?.id === id ? state.mutationError.message : fallback;
}

function formatSubmissionState(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "unknown" || normalized === "unsupported") return undefined;
  if (normalized === "known_not_submitted" || normalized === "not_submitted" || normalized === "unsubmitted") return "Not submitted";
  if (normalized === "known_submitted" || normalized === "submitted" || normalized === "pending" || normalized === "pending_review" || normalized === "late") return "Submitted";
  if (normalized === "known_graded" || normalized === "graded") return "Graded";
  const readable = trimmed.replace(/[_-]+/g, " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

export function formatAssignmentCopyText(event: DashboardEvent): string {
  const lines: string[] = [
    `Course code: ${code(event.courseCode)}`,
    `Assignment title: ${event.title}`,
    `Due date/time: ${formatted(event.startsAt, true)}`,
  ];
  if (typeof event.points === "number" && Number.isFinite(event.points)) {
    lines.push(`Points: ${String(event.points)}`);
  }
  const submissionStatus = formatSubmissionState(event.submissionState);
  if (submissionStatus !== undefined) {
    lines.push(`Canvas submission status: ${submissionStatus}`);
  }
  lines.push(`Due Good completion status: ${event.completed ? "Completed" : "Not completed"}`);
  if (event.kind === "discussion") {
    lines.push(`Main post: ${event.discussionPostDone === true ? "Completed" : "Not completed"}`);
    lines.push(`Replies to classmates: ${event.discussionRepliesDone === true ? "Completed" : "Not completed"}`);
  }
  const detail = typeof event.detail === "string" && event.detail.trim().length > 0 ? event.detail.trim() : "No additional details were supplied.";
  lines.push(`Assignment details: ${detail}`);
  return lines.join("\n");
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // User activation may expire across the awaited rejection, so a legacy
      // fallback cannot be attempted reliably after this point.
      return false;
    }
  }

  if (typeof document === "undefined" || !document.body) return false;
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const success = document.execCommand("copy");
    return success;
  } catch {
    return false;
  } finally {
    if (textarea && textarea.parentNode) {
      textarea.parentNode.removeChild(textarea);
    }
  }
}

function copyButton(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const feedback = state.copyFeedback?.[event.id];
  const label = feedback === "pending" ? "Copying…" : feedback === "copied" ? "Copied" : feedback === "failed" ? "Could not copy" : "Copy assignment";
  const statusClass = feedback === "pending" ? "pending" : feedback === "copied" ? "copied" : feedback === "failed" ? "failed" : "";
  return {
    tag: "button",
    attrs: {
      type: "button",
      class: `copy-button copy-assignment-button ${statusClass}`.trim(),
      "data-copy-id": event.id,
      ...(feedback !== undefined ? { "aria-live": "polite" } : {}),
      ...(feedback === "pending" ? { "aria-busy": "true", disabled: "" } : {}),
    },
    text: label,
    on: {
      click: () => handlers.onCopyAssignment(event.id),
    },
  };
}

function eventCard(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const expanded = state.expandedEventIds.has(event.id);
  const detailsId = `event-detail-${event.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return el("article", undefined, { class: `event-card ${event.kind === "class" ? "class-meeting" : ""} ${event.kind === "discussion" ? "discussion-card" : ""} ${event.completed ? "completed" : ""}`.trim(), style: `--course-color:${color(state.data.courses, event.courseCode)}` }, [
    el("div", undefined, { class: "event-top" }, [el("div", undefined, undefined, [el("div", `${code(event.courseCode)} · ${event.kind === "class" ? "Class meeting" : event.kind === "discussion" ? "Discussion" : "Assignment due"}`, { class: "event-kind" }), el("h2", event.title, { class: "event-title" })]), el("time", `${time(event.startsAt)}${event.endsAt ? `–${time(event.endsAt)}` : ""}`, { class: "event-time", datetime: event.startsAt })]),
    el("div", undefined, { class: "event-meta" }, [el("span", event.location ?? (event.kind === "class" ? "Location not supplied" : "Canvas")), el("span", event.kind === "class" ? "Scheduled meeting" : event.completed ? "Completed by you" : "Not completed by you")]),
    ...(event.kind === "class" ? [] : event.kind === "discussion" ? [
      el("div", undefined, { class: "discussion-progress", "aria-label": "Discussion requirements" }, [el("span", "Discussion requirements", { class: "discussion-progress__label" }), ...discussionCheckboxes(event, state, handlers)]),
      el("div", undefined, { class: "discussion-overall" }, [el("span", "Overall assignment"), completionCheckbox(event, state, handlers)]),
    ] : [completionCheckbox(event, state, handlers)]),
    ...(state.failedCompletionIds.has(event.id) ? [el("span", failureMessage(state, event.id, "Could not save. Existing completion state was restored."), { class: "inline-error event-failure", role: "status", "aria-live": "polite" })] : []),
    ...(state.failedDiscussionIds.has(event.id) ? [el("span", failureMessage(state, event.id, "Could not save discussion progress. Existing marks were restored."), { class: "inline-error event-failure", role: "status", "aria-live": "polite" })] : []),
    el("div", undefined, { class: "event-actions" }, [
      ...(event.kind !== "class" ? [copyButton(event, state, handlers)] : []),
      { tag: "button", attrs: { type: "button", class: "event-expand", "aria-expanded": String(expanded), "aria-controls": detailsId }, text: expanded ? "Hide details" : "Details", on: { click: () => handlers.onToggleEvent(event.id) } },
    ]),
    el("div", undefined, { id: detailsId, class: "event-detail", ...(expanded ? {} : { hidden: "" }) }, [el("span", event.detail ?? "No additional details were supplied."), ...(event.kind !== "class" ? [completionButton(event, state, handlers)] : []), ...(state.failedCompletionIds.has(event.id) ? [el("span", failureMessage(state, event.id, "Could not save. Existing completion state was restored."), { class: "inline-error", role: "status", "aria-live": "polite" })] : []), ...(state.failedDiscussionIds.has(event.id) ? [el("span", failureMessage(state, event.id, "Could not save discussion progress. Existing marks were restored."), { class: "inline-error", role: "status", "aria-live": "polite" })] : [])]),
  ]);
}

function railCompletionCheckbox(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const pending = state.pendingCompletionIds.has(event.id);
  const disabled = locked(state, event.id, state.pendingCompletionIds);
  return el("label", undefined, { class: "rail-done", title: pending ? "Saving completion state" : state.readOnly === true ? "Read-only preview copy" : "Mark assignment done" }, [
    { tag: "input", attrs: { type: "checkbox", "aria-label": `Mark ${event.title} done`, ...(event.completed ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) }, on: { change: () => handlers.onToggleCompletion(event.id) } },
    el("span", pending ? "Saving…" : "Done", { class: "rail-done__label" }),
  ]);
}

function railDiscussionCheckboxes(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const disabled = locked(state, event.id, state.pendingDiscussionIds);
  const checkbox = (field: "post" | "replies", ariaLabel: string, label: string, checked: boolean): ElementDescriptor => el("label", undefined, { class: "rail-subcheck", "data-discussion-step": field }, [
    { tag: "input", attrs: { type: "checkbox", "aria-label": ariaLabel, ...(checked ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) }, on: { change: () => handlers.onToggleDiscussion(event.id, field) } },
    el("span", label),
  ]);
  return el("div", undefined, { class: "rail-discussion-checklist", "aria-label": "Discussion requirements" }, [
    el("span", "Discussion requirements", { class: "rail-discussion-label" }),
    checkbox("post", "Posted my response", "Main post", event.discussionPostDone === true),
    checkbox("replies", "Replied to two classmates", "2 classmate replies", event.discussionRepliesDone === true),
  ]);
}

function dueRailItem(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const date = new Date(event.startsAt);
  const overdue = date.getTime() < state.now;
  const meta = [el("span", overdue ? "Overdue" : `Due ${formatted(event.startsAt, true)}`), ...(event.points === null || event.points === undefined ? [] : [el("span", `${String(event.points)} pts`)]), el("span", overdue ? "Needs attention" : countdownText(state.now, event.startsAt), { class: overdue ? "rail-countdown overdue" : "rail-countdown" })];
  return el("article", undefined, { class: "rail-due-row", "data-due-item": event.id, style: `--course-color:${color(state.data.courses, event.courseCode)}` }, [
    el("time", undefined, { class: "rail-date", datetime: event.startsAt }, [el("strong", new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)), el("span", new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date))]),
    el("div", undefined, { class: "rail-due-content" }, [
      el("span", code(event.courseCode), { class: "rail-course" }),
      el("strong", event.title, { class: "rail-title" }),
      el("div", undefined, { class: "rail-meta" }, meta),
      ...(event.kind === "discussion" ? [railDiscussionCheckboxes(event, state, handlers)] : []),
      el("div", undefined, { class: "rail-actions" }, [copyButton(event, state, handlers)]),
      ...(state.failedCompletionIds.has(event.id) ? [el("span", failureMessage(state, event.id, "Could not save; existing completion state was restored."), { class: "inline-error rail-failure", role: "status", "aria-live": "polite" })] : []),
      ...(state.failedDiscussionIds.has(event.id) ? [el("span", failureMessage(state, event.id, "Could not save discussion progress; existing marks were restored."), { class: "inline-error rail-failure", role: "status", "aria-live": "polite" })] : []),
    ]),
    railCompletionCheckbox(event, state, handlers),
  ]);
}

function railMessage(message: DashboardConversation, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  return {
    tag: "button",
    attrs: { type: "button", class: "rail-message", "data-conversation-id": message.id, style: `--course-color:${color(state.data.courses, message.courseCode ?? "")}`, "aria-label": `Open ${message.subject} from ${message.sender}` },
    children: [el("span", undefined, { class: "rail-message__dot", "aria-hidden": "true" }), el("span", undefined, undefined, [el("strong", message.subject), el("span", `${message.sender} · ${formatted(message.receivedAt, true)}`, { class: "rail-message__meta" }), el("small", message.preview ?? "No preview supplied.")])],
    on: { click: () => { handlers.onSelectConversation(message.id); handlers.onNavigate("inbox"); } },
  };
}

function timelineRail(state: DashboardState, handlers: DashboardHandlers, dueItems: readonly DashboardEvent[], unreadMessages: readonly DashboardConversation[]): ElementDescriptor {
  const firstDue = dueItems.slice(0, 4);
  const remainingDue = dueItems.slice(4);
  return el("aside", undefined, { class: "timeline-rail", "aria-label": "Due soon and unread Canvas messages" }, [
    el("div", undefined, { class: "timeline-rail__head" }, [el("p", "Right now", { class: "eyebrow" }), el("h2", "At a glance"), el("p", "Upcoming work and messages needing attention")]),
    el("div", undefined, { class: "timeline-rail__scroll" }, [
      el("div", undefined, { class: "rail-section-head" }, [el("strong", `Due soon · ${String(dueItems.length)}`), ...(remainingDue.length > 0 ? [el("span", "4 shown", { class: "rail-section-note" })] : [])]),
      firstDue.length === 0 ? empty("No unfinished assignments are due.") : el("div", undefined, { class: "rail-due-list" }, firstDue.map((event) => dueRailItem(event, state, handlers))),
      ...(remainingDue.length > 0 ? [el("details", undefined, { class: "rail-more" }, [el("summary", undefined, undefined, [el("span", "All assignments", { class: "rail-toggle-all" }), el("span", "Show less", { class: "rail-toggle-less" })]), el("div", undefined, { class: "rail-due-list rail-due-list--more" }, remainingDue.map((event) => dueRailItem(event, state, handlers)))])] : []),
      el("div", undefined, { class: "rail-section-head" }, [el("strong", "Hot inbox"), el("span", String(unreadMessages.length), { class: "hot-count", "aria-label": `${String(unreadMessages.length)} unread` })]),
      unreadMessages.length === 0 ? empty("No unread Canvas messages.") : el("div", undefined, { class: "rail-message-list" }, unreadMessages.map((message) => railMessage(message, state, handlers)))
    ]),
  ]);
}

function timelinePage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const courses = orderedCourses(state.data.courses);
  const events = state.data.events.filter((event) => !event.completed && (state.eventMode === "all" || event.kind !== "class") && (state.courseFilter === "all" || key(event.courseCode) === key(state.courseFilter)) && asDate(event.startsAt) !== undefined).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const dueItems = state.data.events.filter((event) => event.kind !== "class" && !event.completed && asDate(event.startsAt) !== undefined).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const unreadMessages = state.data.conversations.filter((message) => message.unread).sort((a, b) => new Date(b.receivedAt ?? 0).getTime() - new Date(a.receivedAt ?? 0).getTime());
  const next = state.data.events.filter((event) => event.kind !== "class" && !event.completed && new Date(event.startsAt).getTime() >= state.now).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];
  const start = startOfDay(state.now);
  const minimumEnd = new Date(start); minimumEnd.setDate(minimumEnd.getDate() + 6);
  const latest = events.reduce((maximum, event) => Math.max(maximum, new Date(event.startsAt).getTime()), start.getTime());
  const end = new Date(Math.max(latest, minimumEnd.getTime()));
  const hardEnd = new Date(start); hardEnd.setDate(hardEnd.getDate() + 119); if (end > hardEnd) end.setTime(hardEnd.getTime());
  const days: Date[] = []; for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) days.push(new Date(cursor));
  const lanes = Math.max(1, courses.length);
  return el("section", undefined, { class: "page", "data-page-panel": "timeline" }, [
    el("section", undefined, { class: "hero" }, [el("div", undefined, undefined, [el("p", `${formatted(start.getTime())} – ${formatted(end.getTime())}`, { class: "eyebrow" }), el("h1", "Timeline"), el("p", "Each row is one full day. Empty rows are time you can use.", { class: "hero-copy" })]), el("div", undefined, { class: "next-deadline", "aria-live": "polite" }, [el("span", "Next deadline"), el("strong", next === undefined ? "All clear" : countdownText(state.now, next.startsAt)), el("small", next?.title ?? "No unfinished deadline was supplied")])]),
    el("section", undefined, { class: "controls", "aria-label": "Timeline controls" }, [el("div", undefined, { class: "segmented", "aria-label": "Event types" }, (["all", "deadlines"] as const).map((mode) => ({ tag: "button", attrs: { type: "button", class: state.eventMode === mode ? "active" : "" }, text: mode === "all" ? "All events" : "Deadlines only", on: { click: () => handlers.onEventMode(mode) } }))), el("div", undefined, { class: "filters", "aria-label": "Course filters" }, [{ tag: "button", attrs: { type: "button", class: `filter ${state.courseFilter === "all" ? "active" : ""}` }, text: "All courses", on: { click: () => handlers.onCourseFilter("all") } }, ...courses.map((course) => ({ tag: "button", attrs: { type: "button", class: `filter ${state.courseFilter === course.courseCode ? "active" : ""}`, style: `--course-color:${color(courses, course.courseCode)}` }, text: code(course.courseCode), on: { click: () => handlers.onCourseFilter(course.courseCode) } }))])]),
    ...(courses.length === 0 ? [empty("No courses have been synced yet.")] : [el("div", undefined, { class: "timeline-layout" }, [el("section", undefined, { class: "timeline-shell" }, [
      el("header", undefined, { class: "lane-header", style: `--lane-count:${String(lanes)}` }, [el("div", undefined, { class: "lane-summary" }, [el("span", `${days.length} days`, { class: "range" }), el("span", `${events.length} matching events`, { class: "range-note" })]), ...courses.map((course) => el("div", undefined, { class: "lane-label", style: `--lane-color:${color(courses, course.courseCode)}` }, [el("b", code(course.courseCode)), el("span", course.title)]))]),
      el("div", undefined, { class: "timeline" }, days.map((day) => { const currentKey = dayKey(day); const dayEvents = events.filter((event) => dayKey(new Date(event.startsAt)) === currentKey); const today = currentKey === dayKey(new Date(state.now)); return el("section", undefined, { class: `day-slot ${day.getDay() === 0 || day.getDay() === 6 ? "weekend" : ""} ${today ? "today" : ""}`.trim(), "data-day": currentKey }, [el("div", undefined, { class: "day-date" }, [el("strong", formatted(day.getTime())), el("span", new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(day)), ...(today ? [el("b", "Today", { class: "today-label" })] : []), ...(dayEvents.length > 1 ? [el("b", `${dayEvents.length} events`, { class: "event-count" })] : [])]), el("div", undefined, { class: "day-rail", "aria-hidden": "true" }), el("div", undefined, { class: "course-lanes", style: `--lane-count:${String(lanes)}` }, [...courses.map((course) => el("div", undefined, { class: "course-lane", "data-course-lane": key(course.courseCode), style: `--lane-tint:${color(courses, course.courseCode)}` }, dayEvents.filter((event) => event.courseId === course.id || key(event.courseCode) === key(course.courseCode)).map((event) => eventCard(event, state, handlers)))), ...(dayEvents.length === 0 ? [el("div", "Open day", { class: "open-day" })] : [])])]); })),
    ]), timelineRail(state, handlers, dueItems, unreadMessages)] )]),
  ]);
}

function completedPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const events = state.data.events.filter((event) => event.kind !== "class" && event.completed).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return el("section", undefined, { class: "page" }, [heading("Finished coursework", "Completed", "Completion is your state, independent from Canvas submission status.", `${events.length} complete`), events.length === 0 ? empty("Nothing completed yet.") : el("div", undefined, { class: "completed-list" }, events.map((event) => el("article", undefined, { class: "completed-row", style: `--course-color:${color(state.data.courses, event.courseCode)}` }, [el("span", undefined, { class: "completed-stripe", "aria-hidden": "true" }), el("div", undefined, undefined, [el("h2", event.title), el("p", `${code(event.courseCode)} · Completed ${formatted(event.completedAt, true)} · Canvas submission state is separate`)]), el("div", undefined, { class: "completed-actions" }, [completionButton(event, state, handlers), ...(state.failedCompletionIds.has(event.id) ? [el("span", failureMessage(state, event.id, "Could not save. Existing completion state was restored."), { class: "inline-error", role: "status", "aria-live": "polite" })] : [])])])))]);
}

function hasNumericGrade(event: DashboardEvent): boolean {
  return typeof event.score === "number" && Number.isFinite(event.score) && typeof event.points === "number" && Number.isFinite(event.points);
}

function hasReportedGrade(event: DashboardEvent): boolean {
  return (typeof event.score === "number" && Number.isFinite(event.score)) || (typeof event.grade === "string" && event.grade.length > 0) || asDate(event.gradedAt) !== undefined;
}

function pointsText(event: DashboardEvent): string {
  if (hasNumericGrade(event)) return `${String(event.score)} / ${String(event.points)}`;
  if (typeof event.points === "number" && Number.isFinite(event.points)) return `${String(event.points)} possible · awaiting score`;
  if (typeof event.score === "number" && Number.isFinite(event.score)) return `${String(event.score)} earned · points unavailable`;
  return "Awaiting / unavailable";
}

function percentage(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "Unknown" : `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

function groupName(group: DashboardGradeGroup): string {
  return group.name ?? "Unnamed Canvas group";
}

function groupWeight(value: number | null): string {
  return value === null ? "Weight unknown" : `${percentage(value)}`;
}

function groupsSummary(groups: readonly DashboardGradeGroup[] | undefined): string {
  if (groups === undefined || groups.length === 0) return "Grade groups · weights unavailable";
  const knownWeight = groups.reduce((total, group) => total + (typeof group.weight === "number" && Number.isFinite(group.weight) ? group.weight : 0), 0);
  return knownWeight > 0 ? `Grade groups · ${percentage(knownWeight)} of course weight` : "Grade groups · weights unavailable";
}

function recordGroup(event: DashboardEvent, group: DashboardGradeGroup): boolean {
  if (group.id !== null && event.assignmentGroupId !== null && event.assignmentGroupId !== undefined) return event.assignmentGroupId === group.id;
  return group.name !== null && event.assignmentGroupName === group.name;
}

interface GradeProgress {
  readonly graded: number | null;
  readonly gradedCoverage: number | null;
  readonly wholeCourse: number | null;
  readonly publishedCoverage: number | null;
}

export function gradeProgress(course: DashboardCourse, records: readonly DashboardEvent[]): GradeProgress {
  const groups = course.gradeGroups ?? [];
  const weightedGroups = groups.filter((group) => group.weight !== null && Number.isFinite(group.weight));
  const totalWeight = weightedGroups.reduce((sum, group) => sum + (group.weight ?? 0), 0);
  if (totalWeight <= 0) return { graded: null, gradedCoverage: null, wholeCourse: null, publishedCoverage: null };
  let gradedWeight = 0;
  let gradedContribution = 0;
  let publishedWeight = 0;
  let wholeContribution = 0;
  for (const group of weightedGroups) {
    const groupRecords = records.filter((event) => recordGroup(event, group) && typeof event.points === "number" && Number.isFinite(event.points) && event.points > 0);
    if (groupRecords.length === 0) continue;
    const possible = groupRecords.reduce((sum, event) => sum + (event.points ?? 0), 0);
    const earned = groupRecords.reduce((sum, event) => sum + (typeof event.score === "number" && Number.isFinite(event.score) ? event.score : 0), 0);
    const groupWeight = group.weight ?? 0;
    publishedWeight += groupWeight;
    wholeContribution += groupWeight * (earned / possible);
    const gradedRecords = groupRecords.filter((event) => typeof event.score === "number" && Number.isFinite(event.score));
    if (gradedRecords.length === 0) continue;
    const gradedPossible = gradedRecords.reduce((sum, event) => sum + (event.points ?? 0), 0);
    const gradedEarned = gradedRecords.reduce((sum, event) => sum + (event.score ?? 0), 0);
    gradedWeight += groupWeight;
    gradedContribution += groupWeight * (gradedEarned / gradedPossible);
  }
  return {
    graded: gradedWeight > 0 ? (gradedContribution / gradedWeight) * 100 : null,
    gradedCoverage: (gradedWeight / totalWeight) * 100,
    wholeCourse: publishedWeight > 0 ? (wholeContribution / totalWeight) * 100 : null,
    publishedCoverage: (publishedWeight / totalWeight) * 100,
  };
}

function groupCell(event: DashboardEvent): string {
  const name = event.assignmentGroupName ?? "Group unknown";
  const weight = event.assignmentGroupWeight === null || event.assignmentGroupWeight === undefined ? "Weight unknown" : percentage(event.assignmentGroupWeight);
  return `${name} · ${weight}`;
}

function gradebookPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const courses = orderedCourses(state.data.courses);
  const records = state.data.events.filter((event) => event.kind !== "class");
  const selectedRecords = records.filter((event) => state.gradeCourseFilter === "all" || key(event.courseCode) === key(state.gradeCourseFilter));
  const visibleRecords = selectedRecords.filter((event) => state.gradeMode === "all" || hasReportedGrade(event)).sort((left, right) => {
    const leftDate = asDate(left.gradedAt ?? left.startsAt)?.getTime() ?? 0;
    const rightDate = asDate(right.gradedAt ?? right.startsAt)?.getTime() ?? 0;
    return rightDate - leftDate || left.title.localeCompare(right.title);
  });
  const summary = courses.map((course) => {
    const courseRecords = records.filter((event) => event.courseId === course.id || key(event.courseCode) === key(course.courseCode));
    const numeric = courseRecords.filter(hasNumericGrade);
    const reported = courseRecords.filter(hasReportedGrade);
    const earned = numeric.reduce((total, event) => total + (event.score ?? 0), 0);
    const possible = numeric.reduce((total, event) => total + (event.points ?? 0), 0);
    const progress = gradeProgress(course, courseRecords);
    const groupRows: readonly ElementDescriptor[] = course.gradeGroups === undefined || course.gradeGroups.length === 0
      ? [el("p", "Canvas assignment groups were not supplied.", { class: "grade-groups-empty" })]
      : [el("ul", undefined, { class: "grade-groups-list" }, course.gradeGroups.map((group) => el("li", undefined, undefined, [el("span", groupName(group)), el("strong", groupWeight(group.weight))])))];
    return el("article", undefined, { class: "grade-summary-card", style: `--course-color:${color(courses, course.courseCode)}` }, [
      { tag: "button", attrs: { type: "button", class: "grade-summary-card__select", "aria-label": `Filter grades to ${code(course.courseCode)}` }, on: { click: () => handlers.onGradeCourseFilter(course.courseCode) }, children: [
        el("span", undefined, { class: "grade-summary-card__heading" }, [el("span", code(course.courseCode), { class: "course-card__code" }), el("h2", course.title)]),
        el("span", undefined, { class: "grade-summary-card__grade" }, [el("strong", percentage(numeric.length > 0 ? progress.graded : null)), el("small", numeric.length > 0 ? "Graded work" : "No numeric score")]),
      ] },
      el("div", undefined, { class: "grade-summary-metrics" }, [
        el("div", undefined, { class: "grade-summary-metric" }, [el("strong", numeric.length > 0 ? `${String(earned)} / ${String(possible)}` : "—"), el("span", numeric.length > 0 ? "Graded points" : "No graded points")]),
        el("div", undefined, { class: "grade-summary-metric" }, [el("strong", numeric.length > 0 ? percentage(progress.wholeCourse) : "Unknown"), el("span", "Whole-course progress")]),
      ]),
      el("p", `${String(reported.length)} of ${String(courseRecords.length)} listed item${courseRecords.length === 1 ? "" : "s"} graded · ${String(courseRecords.length - reported.length)} awaiting`, { class: "grade-summary-awaiting" }),
      el("p", `Coverage: ${percentage(progress.gradedCoverage)} graded · ${percentage(progress.publishedCoverage)} with current records`, { class: "grade-summary-coverage" }),
      { tag: "details", attrs: { class: "grade-summary-groups" }, children: [
        { tag: "summary", attrs: { class: "grade-summary-groups__summary" }, text: groupsSummary(course.gradeGroups) },
        ...groupRows,
      ] },
    ]);
  });
  const table = visibleRecords.length === 0 ? empty(state.gradeMode === "graded" ? "No graded items match this filter." : "No grade records match this filter.") : el("div", undefined, { class: "grade-table-wrap" }, [
    { tag: "table", attrs: { class: "grade-table" }, children: [
      { tag: "caption", text: "Coursework grade records" },
      { tag: "thead", children: [{ tag: "tr", children: [el("th", "Assignment", { scope: "col" }), el("th", "Course", { scope: "col" }), el("th", "Canvas group", { scope: "col" }), el("th", "Source", { scope: "col" }), el("th", "Score", { scope: "col" }), el("th", "Grade", { scope: "col" }), el("th", "Graded", { scope: "col" })] }] },
      { tag: "tbody", children: visibleRecords.map((event) => ({ tag: "tr", children: [
        el("th", event.title, { scope: "row" }),
        el("td", code(event.courseCode)),
        el("td", groupCell(event)),
        el("td", event.source ?? "Not supplied"),
        el("td", pointsText(event), { class: hasNumericGrade(event) ? "grade-score" : "grade-score grade-score--pending" }),
        el("td", event.grade ?? (hasReportedGrade(event) ? "Reported" : "Not graded")),
        el("td", hasReportedGrade(event) ? (asDate(event.gradedAt) === undefined ? "Date unavailable" : formatted(event.gradedAt, true)) : "Awaiting / unavailable"),
      ] })) },
    ] },
  ]);
  return el("section", undefined, { class: "page", "data-page-panel": "grades" }, [
    heading("Coursework grade records", "Grades", "Read-only Canvas records with group metadata and bounded progress indicators. No official weighted or final course grade is inferred."),
    el("div", undefined, { class: "grade-honesty", role: "note" }, [el("strong", "Graded points are not a final course grade."), el("span", "Progress indicators are not official final grades: graded work excludes ungraded assignments; whole-course progress treats ungraded current records as zero. Coverage and unknown group data stay visible.")]),
    el("section", undefined, { class: "grade-summary-grid", "aria-label": "Course grade summaries" }, summary.length === 0 ? [empty("No courses have been synced yet.")] : summary),
    el("section", undefined, { class: "controls grade-controls", "aria-label": "Gradebook controls" }, [
      el("div", undefined, { class: "segmented", "aria-label": "Grade filters" }, (["all", "graded"] as const).map((mode) => ({ tag: "button", attrs: { type: "button", class: state.gradeMode === mode ? "active" : "", "aria-pressed": String(state.gradeMode === mode) }, text: mode === "all" ? "All records" : "Graded only", on: { click: () => handlers.onGradeMode(mode) } }))),
      el("div", undefined, { class: "filters", "aria-label": "Grade course filters" }, [{ tag: "button", attrs: { type: "button", class: `filter ${state.gradeCourseFilter === "all" ? "active" : ""}`, "aria-pressed": String(state.gradeCourseFilter === "all") }, text: "All courses", on: { click: () => handlers.onGradeCourseFilter("all") } }, ...courses.map((course) => ({ tag: "button", attrs: { type: "button", class: `filter ${key(state.gradeCourseFilter) === key(course.courseCode) ? "active" : ""}`, "aria-pressed": String(key(state.gradeCourseFilter) === key(course.courseCode)), style: `--course-color:${color(courses, course.courseCode)}` }, text: code(course.courseCode), on: { click: () => handlers.onGradeCourseFilter(course.courseCode) } }))]),
    ]),
    table,
  ]);
}

function coursesPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const courses = orderedCourses(state.data.courses);
  return el("section", undefined, { class: "page" }, [heading(courses[0]?.term ?? "Current term", "Courses", "Each course keeps the same lane and color everywhere.", `${courses.length} active`), courses.length === 0 ? empty("No courses have been synced yet.") : el("div", undefined, { class: "course-grid" }, courses.map((course, index) => { const events = state.data.events.filter((event) => event.courseId === course.id || key(event.courseCode) === key(course.courseCode)); const deadlines = events.filter((event) => event.kind !== "class" && !event.completed && new Date(event.startsAt).getTime() >= state.now).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()); const classes = events.filter((event) => event.kind === "class" && new Date(event.startsAt).getTime() >= state.now).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()); return el("article", undefined, { class: "course-card", style: `--course-color:${color(courses, course.courseCode)}` }, [el("div", undefined, { class: "course-card__head" }, [el("div", code(course.courseCode), { class: "course-card__code" }), el("h2", course.title), el("span", index === 0 ? "Left lane" : index === 1 ? "Center lane" : index === 2 ? "Right lane" : `Lane ${index + 1}`, { class: "lane-position" })]), el("dl", undefined, { class: "course-facts" }, [el("div", undefined, { class: "course-fact" }, [el("dt", "Next deadline"), el("dd", deadlines[0]?.title ?? "Nothing upcoming")]), el("div", undefined, { class: "course-fact" }, [el("dt", "Next class"), el("dd", classes[0] === undefined ? "Not scheduled" : formatted(classes[0].startsAt, true))]), el("div", undefined, { class: "course-fact" }, [el("dt", "Completed"), el("dd", `${events.filter((event) => event.completed).length} items`)])]), el("div", undefined, { class: "course-card__footer" }, [{ tag: "button", attrs: { type: "button", class: "course-action" }, text: "View timeline", on: { click: () => { handlers.onCourseFilter(course.courseCode); handlers.onNavigate("timeline"); } } }])]); }))]);
}

function libraryPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const types = ["all", "File", "Page", "Link", "Module", "Announcement"];
  const resources = state.data.resources.filter((item) => state.resourceFilter === "all" || item.type.toLowerCase() === state.resourceFilter.toLowerCase());
  const toolbar = el("div", undefined, { class: "resource-toolbar" }, [
    el("div", undefined, { class: "resource-types", "aria-label": "Canvas item types" }, types.map((type) => ({
      tag: "button", attrs: { type: "button", class: state.resourceFilter === type ? "active" : "" }, text: type === "all" ? "All" : `${type}s`, on: { click: () => handlers.onResourceFilter(type) },
    }))),
  ]);
  const list = resources.length === 0
    ? empty(state.data.resources.length === 0 ? "Canvas library items have not been synced yet." : "No Canvas items match this filter.")
    : el("div", undefined, { class: "resource-list" }, resources.map((resource) => {
      const href = safeLocalHref(resource.localUrl);
      return el("article", undefined, { class: "resource-row", style: `--course-color:${color(state.data.courses, resource.courseCode)}` }, [
        el("span", resource.type, { class: "resource-type" }),
        el("div", undefined, undefined, [el("h2", resource.title, { class: "resource-title" }), el("p", `${code(resource.courseCode)}${resource.context ? ` · ${resource.context}` : ""}`, { class: "resource-meta" })]),
        el("time", formatted(resource.updatedAt, true), { class: "resource-updated" }),
        ...(state.desktop !== undefined && resource.savedLocally === true && handlers.onOpenResource !== undefined
          ? [{ tag: "button", attrs: { type: "button", class: "more-action" }, text: "Open or save", on: { click: () => handlers.onOpenResource?.(resource.id) } }]
          : href !== undefined ? [el("a", "Open", { class: "more-action", href })] : resource.savedLocally === true ? [el("span", "Saved locally", { class: "resource-saved" })] : [el("span", "No local copy", { class: "resource-unavailable" })]),
      ]);
    }));
  return el("section", undefined, { class: "page" }, [heading("Imported from Canvas", "Library", "Files, pages, links, modules, and announcements from your courses.", `${resources.length} items`), toolbar, ...(state.resourceNotice === undefined ? [] : [el("p", state.resourceNotice, { role: "status", "aria-live": "polite" })]), list]);
}

function inboxPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const messages = state.data.conversations; const selected = messages.find((message) => message.id === state.selectedConversationId) ?? messages[0];
  const thread = selected?.messages ?? [];
  const warning = selected !== undefined && (selected.historyComplete === false || selected.safetyTruncated === true || thread.some((message) => message.bodyTruncated === true));
  const threadBody = selected === undefined ? empty("Select a conversation.") : el("article", undefined, { class: "message-detail" }, [
    el("div", `${selected.contextLabel ?? (selected.courseCode ? code(selected.courseCode) : "Canvas conversation")} · ${formatted(selected.receivedAt, true)}`, { class: "message-detail__meta" }),
    el("h2", selected.subject),
    el("div", `Participants: ${selected.sender}${selected.messageCount === undefined ? "" : ` · ${selected.messageCount} message${selected.messageCount === 1 ? "" : "s"}`}${selected.attachmentCount ? ` · ${selected.attachmentCount} attachment${selected.attachmentCount === 1 ? "" : "s"}` : ""}`, { class: "message-detail__sender" }),
    ...(warning ? [el("p", "This thread is incomplete or was safety-limited. Refresh Inbox to retrieve the available history; no content was silently hidden.", { class: "inbox-warning", role: "status" })] : []),
    ...(thread.length > 0 ? [el("div", undefined, { class: "message-thread" }, thread.map((message) => el("article", undefined, { class: "thread-message" }, [el("header", undefined, { class: "thread-message__head" }, [el("strong", message.author), el("time", formatted(message.createdAt, true))]), el("div", message.body, { class: "message-detail__body" }), ...(message.attachments.length > 0 ? [el("div", undefined, { class: "thread-attachments" }, message.attachments.map((attachment) => el("span", `${attachment.name}${attachment.contentType ? ` · ${attachment.contentType}` : ""}`, { class: "thread-attachment" })))] : []), ...(message.bodyTruncated ? [el("small", "This message reached the safety display limit.", { class: "inbox-warning" })] : [])]))) ] : [el("div", selected.body ?? selected.preview ?? "No message body was supplied.", { class: "message-detail__body" })]),
  ]);
  return el("section", undefined, { class: "page" }, [heading("Canvas communication", "Inbox", "Read-only Canvas conversations. Selecting one here never changes it in Canvas.", `${messages.filter((message) => message.unread).length} unread`), messages.length === 0 ? empty("Canvas conversations have not been synced yet.") : el("div", undefined, { class: "inbox-layout" }, [el("div", undefined, { class: "message-list" }, messages.map((message) => ({ tag: "button", attrs: { type: "button", class: `message-row ${message.id === selected?.id ? "active" : ""} ${message.unread ? "unread" : ""}`, style: `--course-color:${color(state.data.courses, message.courseCode ?? "")}` }, on: { click: () => handlers.onSelectConversation(message.id) }, children: [el("span", undefined, { class: "message-course", "aria-hidden": "true" }), el("span", undefined, undefined, [el("strong", message.subject), el("span", `${message.sender}${message.contextLabel ? ` · ${message.contextLabel}` : message.courseCode ? ` · ${code(message.courseCode)}` : ""}`), el("small", message.preview ?? "No preview supplied")])] }))), threadBody])]);
}

function activityPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const refreshes = state.data.refreshes; const selected = refreshes.find((refresh) => refresh.id === state.selectedRefreshId) ?? refreshes[0];
  const refreshing = state.refreshState === "running";
  const refreshButton: ElementDescriptor = { tag: "button", attrs: { type: "button", class: `more-action refresh-button${refreshing ? " refreshing" : ""}`, "aria-busy": String(refreshing), ...(refreshing ? { disabled: "" } : {}) }, text: refreshing ? "Refreshing…" : "Refresh now", on: { click: handlers.onRefresh } };
  const content = selected === undefined ? empty("No refresh history is available yet.") : el("div", undefined, { class: "refresh-layout" }, [
    el("section", undefined, { class: "change-panel" }, [
      el("div", undefined, { class: "panel-head" }, [el("h2", formatted(selected.startedAt, true)), el("p", `${selected.status.toUpperCase()} · ${selected.summary}`, { class: selected.status === "partial" ? "refresh-status partial" : "refresh-status" })]),
      el("div", undefined, { class: "change-counts" }, [[selected.added, "Added"], [selected.changed, "Changed"], [selected.removed, "Removed"]].map(([count, label]) => el("div", undefined, { class: "change-count" }, [el("strong", String(count)), el("span", String(label))]))),
      selected.changes.length === 0 ? empty("This refresh recorded no item-level changes.") : el("ul", undefined, { class: "change-list" }, selected.changes.map((change) => el("li", undefined, { class: "change-item" }, [el("span", change.kind, { class: `change-kind ${change.kind}` }), el("div", undefined, undefined, [el("strong", change.title), el("p", change.detail)])]))),
    ]),
    el("aside", undefined, { class: "history-panel" }, [
      el("div", undefined, { class: "panel-head" }, [el("h2", "Refresh history"), el("p", "Select a run to inspect its exact changes.")]),
      el("div", undefined, { class: "history-list" }, refreshes.map((refresh) => ({ tag: "button", attrs: { type: "button", class: `history-row ${refresh.id === selected.id ? "active" : ""}` }, on: { click: () => handlers.onSelectRefresh(refresh.id) }, children: [el("strong", undefined, undefined, [el("span", formatted(refresh.startedAt, true)), el("span", refresh.status, { class: refresh.status === "partial" ? "refresh-status partial" : "refresh-status" })]), el("small", `+${refresh.added} added · ${refresh.changed} changed · ${refresh.removed} removed`)] }))),
    ]),
  ]);
  return el("section", undefined, { class: "page" }, [
    el("header", undefined, { class: "subpage-heading" }, [el("div", undefined, undefined, [el("p", "Refresh evidence", { class: "eyebrow" }), el("h1", "Activity"), el("p", "What changed in each refresh, including partial imports that preserved existing data.")]), ...(state.data.refreshAvailable ? [refreshButton] : [])]),
    ...(state.refreshState === "failed" ? [el("p", "Refresh failed. Existing data was kept.", { class: "inline-error", role: "status", "aria-live": "polite" })] : []),
    ...(state.refreshState === "partial" ? [el("p", "Refresh incomplete. Existing data was kept; this run may not include complete Canvas history.", { class: "refresh-status partial", role: "status", "aria-live": "polite" })] : []),
    ...(state.refreshState === "complete" ? [el("p", "Refresh complete.", { class: "inline-success", role: "status", "aria-live": "polite" })] : []),
    content,
  ]);
}

/** Desktop store card: truthful about preview status, the fixed folder, and what import may replace. */
function desktopStoreCard(desktop: DesktopStoreInfo, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const source = state.data.sourceStatus;
  const preview = desktop.storeState === "preview";
  const refreshEnabled = desktop.canvasRefreshEnabled === true;
  const refreshAvailable = desktop.refreshAvailable === true;
  const transition = state.storeTransition ?? { phase: "idle" as const };
  const busy = transition.phase === "preparing" || transition.phase === "promoting" || transition.phase === "demoting" || transition.phase === "exporting";
  const bytes = (value: number): string => {
    if (value < 1024) return `${String(value)} bytes`;
    const units = ["KB", "MB", "GB", "TB"] as const;
    let size = value / 1024; let index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index] ?? "TB"}`;
  };
  const transitionDetails: ElementDescriptor[] = preview
    ? [
      ...(handlers.onPreparePromotion === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "more-action", ...(busy ? { disabled: "" } : {}) }, text: transition.phase === "preparing" ? "Comparing backup…" : "Choose and compare backup…", on: { click: handlers.onPreparePromotion } }]),
      ...(transition.phase === "ready" && transition.proof !== undefined ? [
        el("p", `Exact comparison passed: ${String(transition.proof.files)} files · ${bytes(transition.proof.bytes)}. The selected backup matches this preview copy.`, { class: "status", role: "status" }),
        el("p", "Promoting makes this app store authoritative. Due Good will ask for a final confirmation in a native dialog.", { class: "status" }),
        ...(handlers.onConfirmPromotion === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "sync-button" }, text: "Promote to authoritative store", on: { click: () => handlers.onConfirmPromotion?.(transition.proof!.proofId) } }]),
        ...(handlers.onCancelPromotion === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "setup-secondary" }, text: "Discard comparison", on: { click: handlers.onCancelPromotion } }]),
      ] : []),
      ...(handlers.onExportFrozenRollback === undefined ? [] : [
        el("p", "After rollback demotion, export and verify a frozen copy of the legacy source before restoring or resuming it.", { class: "status" }),
        { tag: "button", attrs: { type: "button", class: "more-action", ...(busy ? { disabled: "" } : {}) }, text: transition.phase === "exporting" ? "Exporting frozen copy…" : "Export frozen rollback copy…", on: { click: handlers.onExportFrozenRollback } },
        ...(transition.rollbackExportVerified === true ? [el("p", "Frozen rollback export verified. Use this copy when restoring the legacy browser source.", { class: "status", role: "status" })] : []),
      ]),
    ]
    : [
      el("p", "For rollback, first confirm demotion. Due Good keeps app recovery data, turns off Canvas refresh, and returns to preview; then export the frozen legacy source.", { class: "status" }),
      ...(handlers.onDemoteStore === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "setup-secondary", ...(busy ? { disabled: "" } : {}) }, text: transition.phase === "demoting" ? "Returning to preview…" : "Return app store to preview…", on: { click: handlers.onDemoteStore } }]),
      ...(transition.rollbackExportVerified === true ? [el("p", "Frozen rollback export verified. Use this copy when restoring the legacy browser source.", { class: "status", role: "status" })] : []),
    ];
  const transitionFeedback = transition.message === undefined ? [] : [el("p", transition.message, { class: transition.error ? "inline-error" : "status", role: transition.error ? "alert" : "status", "aria-live": "polite" })];
  const transitionProgress = transition.progress === undefined ? [] : [el("p", `${String(transition.progress.filesDone)} files · ${transition.progress.bytesDone} bytes processed.`, { class: "status", role: "status", "aria-live": "polite" })];
  return el("section", undefined, { class: "settings-card", "data-desktop-store": desktop.storeState }, [
    el("h2", preview ? "Preview copy" : "App store"),
    el("p", preview ? "A copy imported from the legacy folder. It never refreshes or follows later changes in the browser app. Personal progress edits stay here; the browser app's folder remains the source of truth until cutover." : "This app store is the authoritative copy. Import never replaces it."),
    el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", source.label ?? "Desktop app store"), el("span", source.detail ?? "Status details were not supplied")]), el("span", preview ? "Preview" : "Authoritative", { class: preview ? "preview-badge" : "status-ok" })]),
    el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "App data folder"), el("code", desktop.dataFolder, { class: "setup-path" })])]),
    el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Imported"), el("span", formatted(desktop.importedAt, true))]), ...(preview && handlers.onReplacePreview !== undefined ? [{ tag: "button", attrs: { type: "button", class: "more-action" }, text: "Replace preview copy…", on: { click: handlers.onReplacePreview } }] : [])]),
    ...transitionDetails,
    ...transitionProgress,
    ...transitionFeedback,
    ...(!preview ? [
      { tag: "label", attrs: { class: "settings-row" }, children: [
        el("span", undefined, undefined, [el("strong", "Canvas refresh"), el("span", refreshEnabled ? (refreshAvailable ? "Canvas refresh can be attempted on this computer." : "Canvas refresh is unavailable on this computer.") : "Canvas refresh is off.")]),
        { tag: "input", attrs: { type: "checkbox", "aria-label": "Enable Canvas refresh", ...(refreshEnabled ? { checked: "" } : {}), ...((state.refreshSettingPending === true || state.refreshState === "running") ? { disabled: "" } : {}) }, on: { change: (event: Event) => handlers.onToggleCanvasRefresh?.((event.currentTarget as HTMLInputElement).checked) } },
      ] },
      ...(desktop.lastRefreshAt == null ? [] : [el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Last Canvas refresh"), el("span", formatted(desktop.lastRefreshAt, true))])])]),
      ...(state.refreshSettingError === undefined ? [] : [el("p", state.refreshSettingError, { class: "inline-error", role: "status", "aria-live": "polite" })]),
    ] : [el("p", "Canvas refresh is unavailable for a preview copy.", { class: "status", role: "status" })]),
  ]);
}

function morePage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const source = state.data.sourceStatus;
  const refreshing = state.refreshState === "running";
  const refreshButton: ElementDescriptor = { tag: "button", attrs: { type: "button", class: `more-action refresh-button${refreshing ? " refreshing" : ""}`, "aria-busy": String(refreshing), ...(refreshing ? { disabled: "" } : {}) }, text: refreshing ? "Refreshing…" : "Refresh", on: { click: handlers.onRefresh } };
  return el("section", undefined, { class: "page" }, [heading("Due Good", "More", "Source status, refresh controls, and local app information."), el("div", undefined, { class: "more-grid" }, [state.desktop !== undefined ? desktopStoreCard(state.desktop, state, handlers) : el("section", undefined, { class: "settings-card" }, [el("h2", "Coursework source"), el("p", "The local Marymount coursework document remains the authoritative writable source."), el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", source.label ?? "Local source"), el("span", source.detail ?? "Status details were not supplied")]), el("span", source.state ?? "Unknown", { class: source.state === "connected" || source.state === "ready" ? "status-ok" : "" })]), el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Last refresh"), el("span", formatted(source.lastRefreshAt, true))]), ...(state.data.refreshAvailable ? [refreshButton] : [])])]), el("section", undefined, { class: "settings-card" }, [el("h2", "Import behavior"), el("p", "Incomplete refreshes never remove existing coursework."), el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Canvas items"), el("span", "Assignments, class meetings, files, pages, links, modules, announcements, and read-only inbox")])]), el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Privacy"), el("span", "Local app · no public coursework data")])])])])]);
}

function pagePanel(pageName: DashboardPage, descriptor: ElementDescriptor): ElementDescriptor {
  return { ...descriptor, attrs: { ...descriptor.attrs, "data-page-panel": pageName } };
}

function page(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  switch (state.page) {
    case "timeline": return pagePanel("timeline", timelinePage(state, handlers));
    case "grades": return pagePanel("grades", gradebookPage(state, handlers));
    case "inbox": return pagePanel("inbox", inboxPage(state, handlers));
    case "completed": return pagePanel("completed", completedPage(state, handlers));
    case "courses": return pagePanel("courses", coursesPage(state, handlers));
    case "library": return pagePanel("library", libraryPage(state, handlers));
    case "activity": return pagePanel("activity", activityPage(state, handlers));
    case "more": return pagePanel("more", morePage(state, handlers));
  }
}

function refreshNote(state: DashboardState, latest: DashboardRefresh | undefined): string {
  if (state.refreshState === "running") {
    const progress = state.refreshProgress;
    if (progress === undefined) return "Canvas refresh is in progress";
    const phase = ({ starting: "Preparing", snapshot: "Saving safety copy", fetch: "Reading Canvas data", reconcile: "Reviewing changes", stage: "Preparing changes", publish: "Saving updates", complete: "Finishing" } as Readonly<Record<string, string>>)[progress.phase] ?? "Working";
    const count = progress.total === null ? `${String(progress.completed)} completed` : `${String(progress.completed)} of ${String(progress.total)} completed`;
    return `Canvas refresh · ${phase} · ${count}${progress.bytesDone === null ? "" : ` · ${String(progress.bytesDone)} bytes received`}`;
  }
  if (state.refreshDetail !== undefined) return state.refreshDetail;
  if (state.refreshState === "complete") return "Refresh complete.";
  if (state.refreshState === "partial") return "Refresh incomplete. Existing data was kept.";
  if (state.refreshState === "failed") return "Refresh failed. Existing data was kept.";
  // Preview copies cannot refresh; authoritative desktop stores report their last import until refreshed.
  if (state.desktop?.storeState === "preview") return state.desktop.importedAt === null ? "Imported copy" : `Imported ${formatted(state.desktop.importedAt, true)}`;
  if (state.desktop?.lastRefreshAt) return `Updated ${formatted(state.desktop.lastRefreshAt, true)}`;
  return latest === undefined ? "Not yet refreshed" : `Updated ${formatted(latest.startedAt, true)}`;
}

export function renderDashboard(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const courses = orderedCourses(state.data.courses); const latest = state.data.refreshes[0]; const profile = state.data.profile;
  const displayName = profile?.displayName?.trim() || "";
  const initials = displayName === "" ? "D" : displayName.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();
  const brandMark: ElementDescriptor = el("div", undefined, { class: "brand-mark" }, [
    el("span", initials, { class: "brand-initials", "aria-hidden": "true" }),
    ...(profile?.avatarPath === undefined || profile.avatarPath === null ? [] : [{
      tag: "img",
      attrs: { class: "brand-avatar", src: profile.avatarPath, alt: displayName || "Canvas profile picture" },
      on: { error: (event: Event) => (event.currentTarget as HTMLImageElement | null)?.setAttribute("hidden", "") },
    }]),
  ]);
  const refreshing = state.refreshState === "running";
  const snapshotProgress = state.desktop?.snapshotProgress;
  const snapshotFiles = snapshotProgress?.filesDone ?? 0;
  const snapshotBytes = snapshotProgress?.bytesDone ?? 0;
  const snapshotStatus = `Saving today’s private recovery snapshot… ${String(snapshotFiles)} file${snapshotFiles === 1 ? "" : "s"} · ${String(snapshotBytes)} bytes copied.`;
  const refreshButton: ElementDescriptor = { tag: "button", attrs: { type: "button", class: `sync-button refresh-button${refreshing ? " refreshing" : ""}`, "aria-busy": String(refreshing), ...(refreshing ? { disabled: "" } : {}) }, text: refreshing ? "Refreshing…" : "Refresh", on: { click: handlers.onRefresh } };
  return el("div", undefined, { class: "app" }, [el("aside", undefined, { class: "sidebar" }, [el("div", undefined, { class: "brand" }, [brandMark, el("div", undefined, undefined, [el("div", "Due Good", { class: "brand-name" }), el("span", courses[0]?.term ?? "Marymount", { class: "brand-note" })])]), dashboardNav(state.page, handlers.onNavigate), el("section", undefined, { class: "course-legend", "aria-label": "Course legend" }, [el("h2", "Course colors"), ...courses.map((course) => el("div", undefined, { class: "legend-row" }, [el("span", undefined, { class: "legend-dot", style: `--dot:${color(courses, course.courseCode)}` }), el("span", `${code(course.courseCode)} · ${course.title}`)]))])]), el("div", undefined, { class: "workspace" }, [el("header", undefined, { class: "topbar" }, [el("div", undefined, { class: "term-label" }, [el("strong", courses[0]?.term ?? "Current term"), el("span", ` · ${courses.length} course${courses.length === 1 ? "" : "s"}`)]), el("div", undefined, { class: "top-actions" }, [...(state.desktop?.storeState === "preview" ? [el("span", "Preview copy", { class: "preview-badge", title: "Imported from the legacy folder. It never refreshes." })] : []), el("span", refreshNote(state, latest), { class: "sync-note", role: "status", "aria-live": "polite" }), ...(handlers.onRecovery === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "more-action" }, text: "Recovery", on: { click: handlers.onRecovery } }]), ...(handlers.onExport === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "more-action" }, text: "Export", on: { click: handlers.onExport } }]), ...(state.data.refreshAvailable ? [refreshButton] : [])])]), el("main", undefined, { id: "main", tabindex: "-1" }, [...(state.loading ? [empty("Loading coursework…")] : []), ...(state.desktop?.snapshotInProgress ? [el("div", snapshotStatus, { class: "status", role: "status", "aria-live": "polite" })] : []), ...(state.error === undefined ? [] : [el("div", state.error, { class: "load-error", role: "alert" })]), ...(state.desktop?.warning ? [el("div", state.desktop.warning, { class: "load-error", role: "alert" })] : []), ...(!state.loading && state.error === undefined ? [page(state, handlers)] : [])])])]);
}
