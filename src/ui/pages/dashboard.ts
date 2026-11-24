import type { ElementDescriptor } from "../dom";
import { dashboardNav, type DashboardPage } from "../routes";
import type { BrowserFreshness } from "../../shared/browser-freshness";
import type { CanvasRubric } from "../../shared/canvas-rubric";
import type { FullRefreshFeedback } from "../full-refresh";
import { canvasRefreshSettingRow, refreshActionLabel, refreshNote, refreshProgressNote } from "./dashboard-refresh";
import { renderLibraryPage } from "./dashboard-library";
import { renderGradebookPage } from "./dashboard-grades";
import { renderInboxPage } from "./dashboard-inbox";
export { gradeProgress } from "./dashboard-grades";
import { formatAssignmentCopyText as formatAssignmentCopyTextWithFormatters } from "./assignment-copy-text";
import { asDate, code, color, courseworkIsVerified, el, empty, formatted, heading, isDateOnly, key, orderedCourses } from "./dashboard-utils";
import { renderCanvasBodyContent, renderStructuredBody, renderTimelineEventCard, type TimelineEventCardRenderers } from "./timeline-event-card";
import type { LibraryResourceActionFeedback } from "../library-resource-action";

export interface DashboardGradeGroup { readonly id: string | null; readonly name: string | null; readonly weight: number | null }
export interface DashboardCourse { readonly id: string; readonly courseCode: string; readonly title: string; readonly term?: string; readonly lastSuccessfulCheckAt?: number | null; readonly gradeGroups?: readonly DashboardGradeGroup[] }
export interface DashboardEvent { readonly id: string; readonly sourceItemId?: string; readonly courseId: string; readonly courseCode: string; readonly kind: "deadline" | "class" | "discussion"; readonly title: string; readonly startsAt: string | null; readonly endsAt?: string | null; readonly location?: string | null; readonly detail?: string | null; readonly assignmentDetail?: string | null; readonly notes?: string | null; readonly completed: boolean; readonly completedAt?: number | null; readonly submissionState?: string; readonly source?: string | null; readonly calendarRetained?: boolean; readonly points?: number | null; readonly score?: number | null; readonly grade?: string | null; readonly manualGrade?: string | null; readonly manualGradeVersion?: 1 | null; readonly manualGradeSource?: "manual" | "pdf" | null; readonly gradedAt?: string | null; readonly assignmentGroupId?: string | null; readonly assignmentGroupName?: string | null; readonly assignmentGroupWeight?: number | null; readonly rubric?: CanvasRubric | null; readonly discussionPostDone?: boolean; readonly discussionRepliesDone?: boolean }
export interface DashboardResource { readonly id: string; readonly courseId: string; readonly courseCode: string; readonly type: string; readonly title: string; readonly context?: string | null; readonly updatedAt?: string | number | null; readonly localUrl?: string | null; readonly savedLocally?: boolean; readonly bodyText?: string }
export interface DashboardMessage { readonly id?: string | null; readonly author: string; readonly createdAt?: string | number | null; readonly body: string; readonly bodyTruncated?: boolean; readonly attachments: readonly DashboardAttachment[] }
export interface DashboardAttachment { readonly name: string; readonly contentType?: string | null; readonly sizeBytes?: number | null }
export interface DashboardConversation { readonly id: string; readonly courseCode?: string | null; readonly contextLabel?: string | null; readonly sender: string; readonly subject: string; readonly preview?: string | null; readonly body?: string | null; readonly receivedAt?: string | number | null; readonly unread: boolean; readonly messageCount?: number; readonly attachmentCount?: number; readonly messages?: readonly DashboardMessage[]; readonly historyComplete?: boolean; readonly safetyTruncated?: boolean }
export interface DashboardRefreshChange { readonly kind: "added" | "changed" | "removed" | "notice"; readonly title: string; readonly detail: string }
export interface DashboardRefresh { readonly id: string; readonly source?: "canvas" | "calendar" | "inbox"; readonly startedAt: string | number; readonly finishedAt?: string | number | null; readonly status: "complete" | "partial" | "failed"; readonly summary: string; readonly added: number; readonly changed: number; readonly removed: number; readonly held?: number; readonly changes: readonly DashboardRefreshChange[] }
export interface DashboardSourceStatus { readonly state?: string; readonly label?: string; readonly detail?: string; readonly lastRefreshAt?: string | number | null; readonly coursework?: "synced" | "not_synced"; readonly library?: "synced" | "not_synced"; readonly inbox?: "synced" | "partial" | "not_synced"; readonly browserFreshness?: BrowserFreshness }
export interface DashboardProfile { readonly displayName: string | null; readonly avatarPath: string | null }
export interface DashboardPendingSourceLink {
  readonly id: string;
  readonly localId: string;
  readonly courseId: string;
  readonly reference: { readonly source: string; readonly id: string; readonly institution: string; readonly course: string; readonly instance?: string };
  readonly fields: Readonly<Record<string, string>>;
  readonly observedAt?: string;
  readonly candidateIds: readonly string[];
  readonly reason: "ambiguous-match" | "conflicting-match";
  readonly needsRefresh?: true;
}
/** The app store and source state owned by the Tauri desktop app. */
export interface DesktopStoreInfo { readonly storeState: "preview" | "authoritative"; readonly dataFolder: string; readonly importedAt: string | null; readonly lastRefreshAt?: string | null; readonly canvasRefreshEnabled?: boolean; readonly refreshAvailable?: boolean; readonly icalRefreshAvailable?: boolean; readonly browserRefreshAvailable?: boolean; readonly snapshotInProgress?: boolean; readonly snapshotProgress?: { readonly filesDone: number; readonly bytesDone: number } | null; readonly warning?: string | null }
/** `version` is the opaque exact-byte digest of the coursework document (empty when unknown). */
export interface DashboardData { readonly version: string; readonly courses: readonly DashboardCourse[]; readonly events: readonly DashboardEvent[]; readonly pendingSourceLinks: readonly DashboardPendingSourceLink[]; readonly resources: readonly DashboardResource[]; readonly conversations: readonly DashboardConversation[]; readonly refreshes: readonly DashboardRefresh[]; readonly profile: DashboardProfile | null; readonly refreshAvailable: boolean; readonly sourceStatus: DashboardSourceStatus }
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
  readonly pendingManualGradeIds: ReadonlySet<string>;
  readonly failedManualGradeIds: ReadonlySet<string>;
  readonly editingManualGrade?: { readonly id: string; readonly draft: string };
  readonly gradeDrafts?: Readonly<Record<string, string>>;
  readonly openCompletedItemIds?: ReadonlySet<string>;
  readonly openLibraryItemIds?: ReadonlySet<string>;
  readonly openGradeGroupCourseIds?: ReadonlySet<string>;
  readonly inboxThreadOpen?: boolean;
  readonly showSetupInstructions?: boolean;
  readonly mutationError?: { readonly id: string; readonly message: string };
  readonly selectedConversationId?: string;
  readonly selectedRefreshId?: string;
  readonly refreshState: "idle" | "running" | "complete" | "partial" | "failed";
  readonly refreshProgress?: { readonly phase: string; readonly completed: number; readonly total: number | null; readonly bytesDone: number | null; readonly reason?: string };
  readonly refreshSettingPending?: boolean;
  readonly refreshSettingError?: string;
  readonly refreshDetail?: string;
  readonly refreshFeedback?: FullRefreshFeedback;
  readonly refreshAlert?: string;
  readonly copyFeedback?: Readonly<Record<string, "pending" | "copied" | "failed">>;
  readonly selectedPendingLinkId?: string;
  readonly selectedPendingLinkCandidateId?: string;
  readonly pendingLinkDecision?: "confirm" | "reject";
  readonly pendingLinkSaving?: boolean;
  readonly pendingLinkNotice?: string;
  readonly desktop: DesktopStoreInfo;
  /** Feedback is isolated by resource so one result cannot overwrite another row. */
  readonly resourceActions?: Readonly<Record<string, LibraryResourceActionFeedback>>;
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
  readonly onEditManualGrade: (id: string) => void;
  readonly onManualGradeDraft: (value: string, id?: string) => void;
  readonly onSaveManualGrade: (id: string) => void;
  readonly onCancelManualGrade: (id?: string) => void;
  readonly onToggleCompletedDetails?: (id: string, open: boolean) => void;
  readonly onToggleLibraryBody?: (id: string, open: boolean) => void;
  readonly onToggleGradeGroups?: (courseId: string, open: boolean) => void;
  readonly onCloseInboxThread?: () => void;
  readonly onToggleSetupInstructions?: (show: boolean) => void;
  readonly onFocusRefresh?: () => void;
  readonly onSelectConversation: (id: string) => void;
  readonly onSelectRefresh: (id: string) => void;
  readonly onRefresh: () => void;
  readonly onDismissRefreshAlert?: () => void;
  readonly onToggleCanvasRefresh?: (enabled: boolean) => void;
  readonly onCopyAssignment: (id: string) => void;
  readonly onSelectPendingLink?: (id: string) => void;
  readonly onSelectPendingLinkCandidate?: (id: string) => void;
  readonly onOpenPendingLinkDecision?: (decision: "confirm" | "reject") => void;
  readonly onCancelPendingLinkDecision?: () => void;
  readonly onResolvePendingLink?: () => void;
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

export function formatAssignmentCopyText(event: DashboardEvent): string {
  return formatAssignmentCopyTextWithFormatters(event, { code, isDateOnly, formatted });
}
function time(value: string | number | null | undefined): string { if (isDateOnly(value)) return "Time not specified"; const date = asDate(value); return date === undefined ? "Time unknown" : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date); }
function dayKey(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function startOfDay(timestamp: number): Date { const date = new Date(timestamp); date.setHours(0, 0, 0, 0); return date; }
function dayNumber(date: Date): number { return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000; }
function eventDate(event: DashboardEvent): Date {
  const date = asDate(event.startsAt)!;
  if (event.kind !== "class" && isDateOnly(event.startsAt)) date.setHours(23, 59, 0, 0);
  return date;
}
function upcoming(value: string | null, now: number): boolean { const date = asDate(value); return date !== undefined && (isDateOnly(value) ? dayKey(date) >= dayKey(new Date(now)) : date.getTime() >= now); }
function overdue(value: string | null, now: number): boolean { const date = asDate(value); return date !== undefined && (isDateOnly(value) ? dayKey(date) < dayKey(new Date(now)) : date.getTime() < now); }
function eventTime(event: DashboardEvent): string { return event.startsAt === null ? "No due date" : isDateOnly(event.startsAt) ? (event.kind === "class" ? "Time not specified" : "11:59 PM") : `${time(event.startsAt)}${event.endsAt ? `–${time(event.endsAt)}` : ""}`; }
export function countdownText(now: number, deadline: string | null): string { const due = asDate(deadline); if (due === undefined) return "Time unknown"; if (isDateOnly(deadline)) { const days = dayNumber(due) - dayNumber(new Date(now)); return days < 0 ? "Due date passed" : days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${String(days)} days`; } const minutes = Math.max(0, Math.floor((due.getTime() - now) / 60_000)); const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const remainder = minutes % 60; return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`; }
export function safeLocalHref(value: string | null | undefined): string | undefined { return value !== null && value !== undefined && /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/.test(value) ? value : undefined; }
function locked(id: string, pendingIds: ReadonlySet<string>): boolean {
  return pendingIds.has(id);
}

function completionButton(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const pending = state.pendingCompletionIds.has(event.id);
  const disabled = locked(event.id, state.pendingCompletionIds);
  return { tag: "button", attrs: { type: "button", class: "complete-button", ...(disabled ? { disabled: "" } : {}) }, text: pending ? "Saving…" : event.completed ? "Mark not done" : "Mark complete", on: { click: () => handlers.onToggleCompletion(event.id) } };
}

function completionCheckbox(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const disabled = locked(event.id, state.pendingCompletionIds);
  return el("label", undefined, { class: "event-check" }, [{ tag: "input", attrs: { type: "checkbox", "aria-label": "Done", ...(event.completed ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) }, on: { change: () => handlers.onToggleCompletion(event.id) } }, el("span", "Done")]);
}

function discussionCheckboxes(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): readonly ElementDescriptor[] {
  if (event.kind !== "discussion") return [];
  const disabled = locked(event.id, state.pendingDiscussionIds);
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

function timelineEventCardRenderers(state: DashboardState, handlers: DashboardHandlers): TimelineEventCardRenderers {
  return {
    el,
    code,
    color: (courseCode) => color(state.data.courses, courseCode),
    eventTime,
    isDateOnly,
    discussionCheckboxes: (event) => discussionCheckboxes(event, state, handlers),
    completionCheckbox: (event) => completionCheckbox(event, state, handlers),
    completionButton: (event) => completionButton(event, state, handlers),
    failureMessage: (id, fallback) => failureMessage(state, id, fallback),
    copyButton: (event) => copyButton(event, state, handlers),
  };
}

function railCompletionCheckbox(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const pending = state.pendingCompletionIds.has(event.id);
  const disabled = locked(event.id, state.pendingCompletionIds);
  return el("label", undefined, { class: "rail-done", title: pending ? "Saving completion state" : "Mark assignment done" }, [
    { tag: "input", attrs: { type: "checkbox", "aria-label": `Mark ${event.title} done`, ...(event.completed ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) }, on: { change: () => handlers.onToggleCompletion(event.id) } },
    el("span", pending ? "Saving…" : "Done", { class: "rail-done__label" }),
  ]);
}

function railDiscussionCheckboxes(event: DashboardEvent, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const disabled = locked(event.id, state.pendingDiscussionIds);
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

function dueRailItem(event: DashboardEvent & { readonly startsAt: string }, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const date = eventDate(event);
  const isOverdue = overdue(event.startsAt, state.now);
  const meta = [el("span", isOverdue ? "Overdue" : `Due ${formatted(event.startsAt, true)}`), ...(event.points === null || event.points === undefined ? [] : [el("span", `${String(event.points)} pts`)]), el("span", isOverdue ? "Needs attention" : countdownText(state.now, event.startsAt), { class: isOverdue ? "rail-countdown overdue" : "rail-countdown" })];
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

function timelineRail(state: DashboardState, handlers: DashboardHandlers, dueItems: readonly (DashboardEvent & { readonly startsAt: string })[], unreadMessages: readonly DashboardConversation[]): ElementDescriptor {
  const courseworkVerified = courseworkIsVerified(state.data.sourceStatus, state.data.courses);
  const inboxVerified = state.data.sourceStatus.inbox === "synced" && state.data.sourceStatus.browserFreshness?.current !== false;
  const firstDue = dueItems.slice(0, 4);
  const remainingDue = dueItems.slice(4);
  const retainedCalendarOnly = !courseworkVerified && dueItems.length > 0;
  return el("aside", undefined, { class: "timeline-rail", "aria-label": "Due soon and unread Canvas messages" }, [
    el("div", undefined, { class: "timeline-rail__head" }, [el("p", "Right now", { class: "eyebrow" }), el("h2", "At a glance"), el("p", "Upcoming work and messages needing attention")]),
    el("div", undefined, { class: "timeline-rail__scroll" }, [
      el("div", undefined, { class: "rail-section-head" }, [el("strong", courseworkVerified ? `Due soon · ${String(dueItems.length)}` : retainedCalendarOnly ? `Calendar deadlines · ${String(dueItems.length)}` : "Due soon · Unverified"), ...(remainingDue.length > 0 ? [el("span", "4 shown", { class: "rail-section-note" })] : [])]),
      ...(!courseworkVerified ? [empty(retainedCalendarOnly ? "Canvas coursework is unverified. These are retained calendar deadlines." : "Coursework could not be verified. Refresh to check what is due.")] : []),
      firstDue.length === 0 ? (courseworkVerified ? empty("No unfinished assignments are due.") : el("div")) : el("div", undefined, { class: "rail-due-list" }, firstDue.map((event) => dueRailItem(event, state, handlers))),
      ...(remainingDue.length > 0 ? [el("details", undefined, { class: "rail-more" }, [el("summary", undefined, undefined, [el("span", "All assignments", { class: "rail-toggle-all" }), el("span", "Show less", { class: "rail-toggle-less" })]), el("div", undefined, { class: "rail-due-list rail-due-list--more" }, remainingDue.map((event) => dueRailItem(event, state, handlers)))])] : []),
      el("div", undefined, { class: "rail-section-head" }, [el("strong", "Hot inbox"), el("span", inboxVerified ? String(unreadMessages.length) : "?", { class: "hot-count", "aria-label": inboxVerified ? `${String(unreadMessages.length)} unread` : "Unread count unverified" })]),
      unreadMessages.length === 0 ? empty(inboxVerified ? "No unread Canvas messages." : "Inbox could not be verified. Refresh to check unread messages.") : el("div", undefined, { class: "rail-message-list" }, unreadMessages.map((message) => railMessage(message, state, handlers)))
    ]),
  ]);
}

function laneHeading(course: DashboardCourse): string { const courseCode = course.courseCode.trim(); const title = course.title.trim(); const numericCode = /^\d+$/.test(courseCode); if (title !== "" && !(numericCode && title === courseCode)) return title; const fallback = code(courseCode).trim(); return fallback !== "" && !numericCode ? fallback : "Course name unknown"; }
function canShowEventWithoutVerifiedCanvas(event: DashboardEvent, source: DashboardSourceStatus): boolean {
  if (event.calendarRetained === true || event.source !== undefined && event.source !== null && event.source !== "canvas") return true;
  return source.coursework === undefined && source.browserFreshness === undefined;
}
function timelinePage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const courseworkVerified = courseworkIsVerified(state.data.sourceStatus, state.data.courses);
  const canShowCoursework = courseworkVerified || (state.data.sourceStatus.coursework === undefined && state.data.sourceStatus.browserFreshness === undefined);
  const courses = orderedCourses(state.data.courses);
  const events = state.data.events.filter((event): event is DashboardEvent & { readonly startsAt: string } => !event.completed
      && (canShowCoursework || canShowEventWithoutVerifiedCanvas(event, state.data.sourceStatus))
      && (state.eventMode === "all" || event.kind !== "class")
      && (state.courseFilter === "all" || key(event.courseCode) === key(state.courseFilter))
      && event.startsAt !== null && asDate(event.startsAt) !== undefined)
    .sort((a, b) => eventDate(a).getTime() - eventDate(b).getTime());
  const undatedEvents = state.data.events.filter((event) => !event.completed && event.kind !== "class" && event.startsAt === null
      && (canShowCoursework || canShowEventWithoutVerifiedCanvas(event, state.data.sourceStatus))
      && (state.courseFilter === "all" || key(event.courseCode) === key(state.courseFilter)))
    .sort((left, right) => left.courseCode.localeCompare(right.courseCode) || left.title.localeCompare(right.title));
  const dueItems = state.data.events.filter((event): event is DashboardEvent & { readonly startsAt: string } => event.kind !== "class"
      && !event.completed && event.startsAt !== null && asDate(event.startsAt) !== undefined
      && (canShowCoursework || canShowEventWithoutVerifiedCanvas(event, state.data.sourceStatus)))
    .sort((a, b) => eventDate(a).getTime() - eventDate(b).getTime());
  const unreadMessages = state.data.conversations.filter((message) => message.unread).sort((a, b) => new Date(b.receivedAt ?? 0).getTime() - new Date(a.receivedAt ?? 0).getTime());
  const start = startOfDay(state.now);
  const minimumEnd = new Date(start); minimumEnd.setDate(minimumEnd.getDate() + 6);
  const latest = events.reduce((maximum, event) => Math.max(maximum, eventDate(event).getTime()), start.getTime());
  const end = new Date(Math.max(latest, minimumEnd.getTime()));
  const hardEnd = new Date(start); hardEnd.setDate(hardEnd.getDate() + 119); if (end > hardEnd) end.setTime(hardEnd.getTime());
  const days: Date[] = []; for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) days.push(new Date(cursor));
  const lanes = Math.max(1, courses.length);
  const cardRenderers = timelineEventCardRenderers(state, handlers);
  return el("section", undefined, { class: "page", "data-page-panel": "timeline" }, [
    el("section", undefined, { class: "hero" }, [el("div", undefined, undefined, [el("p", `${formatted(start.getTime())} – ${formatted(end.getTime())}`, { class: "eyebrow" }), el("h1", "Timeline"), el("p", courseworkVerified ? "Each row is one full day. Empty rows are time you can use." : "Each row is one full day. Empty rows may have unverified coursework.", { class: "hero-copy" })])]),
    el("section", undefined, { class: "controls", "aria-label": "Timeline controls" }, [el("div", undefined, { class: "segmented", "aria-label": "Event types" }, (["all", "deadlines"] as const).map((mode) => ({ tag: "button", attrs: { type: "button", class: state.eventMode === mode ? "active" : "" }, text: mode === "all" ? "All events" : "Deadlines only", on: { click: () => handlers.onEventMode(mode) } }))), el("div", undefined, { class: "filters", "aria-label": "Course filters" }, [{ tag: "button", attrs: { type: "button", class: `filter ${state.courseFilter === "all" ? "active" : ""}` }, text: "All courses", on: { click: () => handlers.onCourseFilter("all") } }, ...courses.map((course) => ({ tag: "button", attrs: { type: "button", class: `filter ${state.courseFilter === course.courseCode ? "active" : ""}`, style: `--course-color:${color(courses, course.courseCode)}` }, text: code(course.courseCode), on: { click: () => handlers.onCourseFilter(course.courseCode) } }))])]),
    ...(courses.length === 0 ? (() => {
      const calendarItems = events.filter((event) => event.source === "ical" || event.calendarRetained === true);
      return calendarItems.length > 0
        ? [el("section", undefined, { class: "calendar-only-timeline", "aria-label": "Calendar deadlines" }, [
            el("h2", "Calendar deadlines"),
            el("p", courseworkVerified ? "These deadlines come from your calendar feed." : "Retained calendar deadlines remain available; Canvas coursework is unverified."),
            el("div", undefined, { class: "undated-events__items" }, calendarItems.map((event) => renderTimelineEventCard(event, state, handlers, cardRenderers))),
          ])]
        : [empty(courseworkVerified ? "No active Canvas courses were found." : "Canvas coursework could not be verified. Refresh to check courses.")];
    })() : [el("div", undefined, { class: "timeline-layout" }, [el("section", undefined, { class: "timeline-shell" }, [
      el("header", undefined, { class: "lane-header", style: `--lane-count:${String(lanes)}` }, [el("div", undefined, { class: "lane-summary" }, [el("span", `${days.length} days`, { class: "range" }), el("span", `${events.length} dated events`, { class: "range-note" })]), el("div", undefined, { class: "lane-marker", "aria-hidden": "true" }), ...courses.map((course) => el("div", undefined, { class: "lane-label", style: `--lane-color:${color(courses, course.courseCode)}` }, [el("b", laneHeading(course))]))]),
      ...(undatedEvents.length === 0 ? [] : [el("section", undefined, { class: "undated-events", "aria-label": "No due date" }, [
        el("header", undefined, { class: "undated-events__head" }, [el("h2", "No due date"), el("span", `${String(undatedEvents.length)} items`)]),
        el("div", undefined, { class: "undated-events__items" }, undatedEvents.map((event) => renderTimelineEventCard(event, state, handlers, cardRenderers))),
      ])]),
      el("div", undefined, { class: "timeline" }, days.map((day) => { const currentKey = dayKey(day); const dayEvents = events.filter((event) => dayKey(eventDate(event)) === currentKey); const today = currentKey === dayKey(new Date(state.now)); return el("section", undefined, { class: `day-slot ${day.getDay() === 0 || day.getDay() === 6 ? "weekend" : ""} ${today ? "today" : ""}`.trim(), "data-day": currentKey }, [el("div", undefined, { class: "day-date" }, [el("strong", formatted(day.getTime())), el("span", new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(day)), ...(today ? [el("b", "Today", { class: "today-label" })] : []), ...(dayEvents.length > 1 ? [el("b", `${dayEvents.length} events`, { class: "event-count" })] : [])]), el("div", undefined, { class: "day-rail", "aria-hidden": "true" }), el("div", undefined, { class: "course-lanes", style: `--lane-count:${String(lanes)}` }, [...courses.map((course) => el("div", undefined, { class: "course-lane", "data-course-lane": key(course.courseCode), style: `--lane-tint:${color(courses, course.courseCode)}` }, dayEvents.filter((event) => event.courseId === course.id || key(event.courseCode) === key(course.courseCode)).map((event) => renderTimelineEventCard(event, state, handlers, cardRenderers)))), ...(dayEvents.length === 0 ? [el("div", courseworkVerified ? "Open day" : "Coursework unverified", { class: "open-day" })] : [])])]); })),
    ]), timelineRail(state, handlers, dueItems, unreadMessages)] )]),
  ]);
}

function completedPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const courseworkVerified = courseworkIsVerified(state.data.sourceStatus, state.data.courses);
  const events = state.data.events.filter((event) => event.kind !== "class" && event.completed).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  const countLabel = courseworkVerified ? `${events.length} complete` : "Completion unverified";
  const emptyMessage = courseworkVerified
    ? "Nothing completed yet."
    : "Coursework could not be verified. Refresh to check completed items.";
  return el("section", undefined, { class: "page" }, [
    heading("Finished coursework", "Completed", "Completion is your state, independent from Canvas submission status.", countLabel),
    events.length === 0 ? empty(emptyMessage) : el("div", undefined, { class: "completed-list" }, events.map((event) => {
      const bodyContent = renderCanvasBodyContent(event, el);
      const isDetailsOpen = state.openCompletedItemIds?.has(event.id) === true;
      return el("article", undefined, { class: "completed-row", style: `--course-color:${color(state.data.courses, event.courseCode)}` }, [
        el("span", undefined, { class: "completed-stripe", "aria-hidden": "true" }),
        el("div", undefined, undefined, [
          el("h2", event.title),
          el("p", `${code(event.courseCode)} · Completed ${formatted(event.completedAt, true)} · Canvas submission state is separate`),
          {
            tag: "details",
            attrs: { class: "completed-body-details", ...(isDetailsOpen ? { open: "" } : {}) },
            on: { toggle: (e: Event) => handlers.onToggleCompletedDetails?.(event.id, (e.currentTarget as HTMLDetailsElement).open) },
            children: [
              el("summary", "Details"),
              ...(bodyContent.length === 0 ? [el("span", "No additional details were supplied.")] : bodyContent),
            ],
          },
        ]),
        el("div", undefined, { class: "completed-actions" }, [completionButton(event, state, handlers), ...(state.failedCompletionIds.has(event.id) ? [el("span", failureMessage(state, event.id, "Could not save. Existing completion state was restored."), { class: "inline-error", role: "status", "aria-live": "polite" })] : [])]),
      ]);
    })),
  ]);
}

function coursesPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const courseworkVerified = courseworkIsVerified(state.data.sourceStatus, state.data.courses);
  const courses = orderedCourses(state.data.courses);
  return el("section", undefined, { class: "page" }, [
    heading("Course overview", "Courses", "Each course keeps the same lane and color everywhere."),
    courses.length === 0
      ? empty(courseworkVerified ? "No active Canvas courses were found." : "Coursework could not be verified. Refresh to check courses.")
      : el("div", undefined, { class: "course-grid" }, courses.map((course, index) => {
          const events = state.data.events.filter((event) => event.courseId === course.id || key(event.courseCode) === key(course.courseCode));
          const deadlines = events.filter((event) => event.kind !== "class" && !event.completed && upcoming(event.startsAt, state.now)).sort((a, b) => eventDate(a).getTime() - eventDate(b).getTime());
          const classes = events.filter((event) => event.kind === "class" && upcoming(event.startsAt, state.now)).sort((a, b) => eventDate(a).getTime() - eventDate(b).getTime());
          const nextDeadline = deadlines[0]?.title ?? (courseworkVerified ? "Nothing upcoming" : "Coursework unverified");
          const nextClass = classes[0] === undefined ? (courseworkVerified ? "Not scheduled" : "Coursework unverified") : formatted(classes[0].startsAt, true);
          const completedCount = courseworkVerified ? `${events.filter((event) => event.completed).length} items` : "Coursework unverified";
          return el("article", undefined, { class: "course-card", style: `--course-color:${color(courses, course.courseCode)}` }, [
            el("div", undefined, { class: "course-card__head" }, [el("div", code(course.courseCode), { class: "course-card__code" }), el("h2", course.title), el("span", index === 0 ? "Left lane" : index === 1 ? "Center lane" : index === 2 ? "Right lane" : `Lane ${index + 1}`, { class: "lane-position" })]),
            el("dl", undefined, { class: "course-facts" }, [
              el("div", undefined, { class: "course-fact" }, [el("dt", "Next deadline"), el("dd", nextDeadline)]),
              el("div", undefined, { class: "course-fact" }, [el("dt", "Next class"), el("dd", nextClass)]),
              el("div", undefined, { class: "course-fact" }, [el("dt", "Completed"), el("dd", completedCount)]),
            ]),
            el("div", undefined, { class: "course-card__footer" }, [{ tag: "button", attrs: { type: "button", class: "course-action" }, text: "View timeline", on: { click: () => { handlers.onCourseFilter(course.courseCode); handlers.onNavigate("timeline"); } } }]),
          ]);
        })),
  ]);
}

function activityPage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const refreshes = state.data.refreshes; const selected = refreshes.find((refresh) => refresh.id === state.selectedRefreshId) ?? refreshes[0];
  const content = selected === undefined ? empty("No refresh history is available yet.") : el("div", undefined, { class: "refresh-layout" }, [
    el("section", undefined, { class: "change-panel" }, [
      el("div", undefined, { class: "panel-head" }, [el("h2", `${selected.source === "calendar" ? "Calendar refresh" : selected.source === "inbox" ? "Inbox update" : "Canvas refresh"} · ${formatted(selected.startedAt, true)}`), el("p", `${selected.status.toUpperCase()} · ${selected.summary}`, { class: selected.status === "partial" ? "refresh-status partial" : selected.status === "failed" ? "refresh-status failed" : "refresh-status" }), ...(selected.source === "calendar" ? [el("p", "Calendar refresh updates deadlines only. Grades, Inbox, and library items keep the prior Canvas capture.", { class: "source-scope-note", role: "note" })] : [])]),
      el("div", undefined, { class: "change-counts" }, [[selected.added, "Added"], [selected.changed, "Changed"], [selected.removed, "Removed"], ...(selected.held === undefined ? [] : [[selected.held, "Held"] as const])].map(([count, label]) => el("div", undefined, { class: "change-count" }, [el("strong", String(count)), el("span", String(label))]))),
      selected.changes.length === 0 ? empty("This refresh recorded no item-level changes.") : el("ul", undefined, { class: "change-list" }, selected.changes.map((change) => el("li", undefined, { class: "change-item" }, [el("span", change.kind, { class: `change-kind ${change.kind}` }), el("div", undefined, undefined, [el("strong", change.title), el("p", change.detail)])]))),
    ]),
    el("aside", undefined, { class: "history-panel" }, [
      el("div", undefined, { class: "panel-head" }, [el("h2", "Refresh history"), el("p", "Select a run to inspect its exact changes.")]),
      el("div", undefined, { class: "history-list" }, refreshes.map((refresh) => ({ tag: "button", attrs: { type: "button", class: `history-row ${refresh.id === selected.id ? "active" : ""}` }, on: { click: () => handlers.onSelectRefresh(refresh.id) }, children: [el("strong", undefined, undefined, [el("span", formatted(refresh.startedAt, true)), el("span", refresh.status, { class: refresh.status === "partial" ? "refresh-status partial" : refresh.status === "failed" ? "refresh-status failed" : "refresh-status" })]), el("small", `+${refresh.added} added · ${refresh.changed} changed · ${refresh.removed} removed`)] }))),
    ]),
  ]);
  return el("section", undefined, { class: "page" }, [
    el("header", undefined, { class: "subpage-heading" }, [el("div", undefined, undefined, [el("p", "Refresh evidence", { class: "eyebrow" }), el("h1", "Activity"), el("p", "What changed in each refresh, including partial imports that preserved existing data.")])]),
    content,
  ]);
}

/** Desktop store card: truthful about preview status, the fixed folder, and what import may replace. */
function desktopStoreCard(desktop: DesktopStoreInfo, state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const source = state.data.sourceStatus;
  const preview = desktop.storeState === "preview";
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
        ...(transition.rollbackExportVerified === true ? [el("p", "Frozen rollback export verified. Use this copy when restoring the legacy local source.", { class: "status", role: "status" })] : []),
      ]),
    ]
    : [
      el("p", "For rollback, first confirm demotion. Due Good keeps app recovery data, turns off Canvas refresh, and returns to preview; then export the frozen legacy source.", { class: "status" }),
      ...(handlers.onDemoteStore === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "setup-secondary", ...(busy ? { disabled: "" } : {}) }, text: transition.phase === "demoting" ? "Returning to preview…" : "Return app store to preview…", on: { click: handlers.onDemoteStore } }]),
      ...(transition.rollbackExportVerified === true ? [el("p", "Frozen rollback export verified. Use this copy when restoring the legacy local source.", { class: "status", role: "status" })] : []),
    ];
  const transitionFeedback = transition.message === undefined ? [] : [el("p", transition.message, { class: transition.error ? "inline-error" : "status", role: transition.error ? "alert" : "status", "aria-live": "polite" })];
  const transitionProgress = transition.progress === undefined ? [] : [el("p", `${String(transition.progress.filesDone)} files · ${transition.progress.bytesDone} bytes processed.`, { class: "status", role: "status", "aria-live": "polite" })];
  return el("section", undefined, { class: "settings-card", "data-desktop-store": desktop.storeState }, [
    el("h2", preview ? "Preview copy" : "App store"),
    el("p", preview ? "A copy imported from the legacy local source. It does not follow later source changes. Personal progress edits stay here until cutover." : "This app store is the authoritative copy. Import never replaces it."),
    el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", source.label ?? "Desktop app store"), el("span", source.detail ?? "Status details were not supplied")]), el("span", preview ? "Preview" : "Authoritative", { class: preview ? "preview-badge" : "status-ok" })]),
    el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "App data folder"), el("code", desktop.dataFolder, { class: "setup-path" })])]),
    el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Imported"), el("span", formatted(desktop.importedAt, true))]), ...(preview && handlers.onReplacePreview !== undefined ? [{ tag: "button", attrs: { type: "button", class: "more-action" }, text: "Replace preview copy…", on: { click: handlers.onReplacePreview } }] : [])]),
    el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "App data"), el("span", "Snapshot recovery and rollback folder export")]), ...(handlers.onRecovery === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "more-action" }, text: "Recovery", on: { click: handlers.onRecovery } }]), ...(handlers.onExport === undefined ? [] : [{ tag: "button", attrs: { type: "button", class: "more-action" }, text: "Export", on: { click: handlers.onExport } }])]),
    ...transitionDetails,
    ...transitionProgress,
    ...transitionFeedback,
    ...(!preview ? [
      canvasRefreshSettingRow(desktop, state, handlers),
      el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Calendar feed"), el("span", desktop.icalRefreshAvailable ? "Available for native refresh." : "Unavailable until the app store is authoritative, the feed port is free, and course identity is known.")])]),
      ...(desktop.lastRefreshAt == null ? [] : [el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Last refresh"), el("span", formatted(desktop.lastRefreshAt, true))])])]),
      ...(state.refreshSettingError === undefined ? [] : [el("p", state.refreshSettingError, { class: "inline-error", role: "status", "aria-live": "polite" })]),
    ] : [el("p", "Canvas refresh is unavailable for a preview copy.", { class: "status", role: "status" })]),
  ]);
}

function sourceFactRows(fields: Readonly<Record<string, string>>): readonly ElementDescriptor[] {
  const entries = Object.entries(fields).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? [el("span", "No source facts were supplied.")] : entries.map(([name, value]) =>
    el("div", undefined, { class: "settings-row" }, [el("strong", name), el("span", value)]));
}

function pendingLinkLabel(candidate: DashboardPendingSourceLink, courses: readonly DashboardCourse[]): string {
  const action = candidate.candidateIds.length === 1 ? "Review" : "Choose candidate";
  const rawTitle = candidate.fields["title"] ?? candidate.fields["Title"];
  const title = typeof rawTitle === "string" ? rawTitle.replace(/^"|"$/g, "").trim() || "Untitled coursework" : "Untitled coursework";
  const course = courses.find((item) => item.id === candidate.courseId || key(item.courseCode) === key(candidate.reference.course));
  const courseLabel = course === undefined
    ? candidate.reference.course.trim() === "" ? "Course unknown" : code(candidate.reference.course)
    : code(course.courseCode);
  const rawDue = candidate.fields["at"] ?? candidate.fields["dueAt"] ?? candidate.fields["dueDate"];
  const cleanDue = typeof rawDue === "string" ? rawDue.replace(/^"|"$/g, "").trim() : "";
  const parsedDue = asDate(cleanDue);
  const due = parsedDue === undefined ? cleanDue === "" ? "date unavailable" : "date unknown" : formatted(cleanDue, true);
  return `${action}: ${title} · ${courseLabel} · Due ${due}`;
}

function queueLabels(links: readonly DashboardPendingSourceLink[], courses: readonly DashboardCourse[]): string[] {
  const labels = links.map((link) => pendingLinkLabel(link, courses));
  const totals = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1);
  return labels.map((label) => {
    const total = totals.get(label)!;
    if (total === 1) return label;
    const index = (positions.get(label) ?? 0) + 1;
    positions.set(label, index);
    return `${label} · ${index} of ${total}`;
  });
}

/** A bounded review surface: the API item is not rendered as coursework until a decision is persisted. */
function pendingLinkReview(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor | undefined {
  const links = state.data.pendingSourceLinks;
  if (links.length === 0) return undefined;
  const selected = links.find((link) => link.id === state.selectedPendingLinkId) ?? links[0]!;
  const selectedCandidateId = selected.candidateIds.length === 1 ? selected.candidateIds[0] : selected.candidateIds.includes(state.selectedPendingLinkCandidateId ?? "") ? state.selectedPendingLinkCandidateId : undefined;
  const local = selectedCandidateId === undefined ? undefined : state.data.events.find((event) => event.sourceItemId === selectedCandidateId || event.id === selectedCandidateId);
  const localDetails = local === undefined ? [el("p", "The local candidate is unavailable. Reload before making a decision.", { class: "inline-error", role: "alert" })] : [
    el("h3", local.title),
    el("div", undefined, { class: "settings-row" }, [el("strong", "Due Good ID"), el("code", local.sourceItemId ?? local.id)]),
    el("div", undefined, { class: "settings-row" }, [el("strong", "Course"), el("span", code(local.courseCode))]),
    el("div", undefined, { class: "settings-row" }, [el("strong", "Due"), el("span", formatted(local.startsAt, true))]),
    el("div", undefined, { class: "settings-row" }, [el("strong", "Done"), el("span", local.completed ? "Completed" : "Not completed")]),
    el("div", undefined, { class: "settings-row" }, [el("strong", "Notes"), el("span", local.notes?.trim() || "No local note")]),
  ];
  const labels = queueLabels(links, state.data.courses);
  const canKeepDistinct = selected.needsRefresh !== true;
  const canConfirm = local !== undefined && selectedCandidateId !== undefined && canKeepDistinct;
  const decision = state.pendingLinkDecision;
  return el("section", undefined, { class: "settings-card pending-link-review", "data-pending-link-review": "true" }, [
    el("h2", "Possible source link"),
    el("p", "Canvas and iCal records remain separate until you decide. Similar titles or dates are never proof of identity."),
    ...(selected.needsRefresh === true ? [el("p", "This earlier suggestion needs a fresh coursework import before it can be reviewed. It remains pending and no records will be linked automatically.", { class: "inline-error", role: "status" })] : []),
    el("div", undefined, { class: "pending-link-queue", role: "list", style: "display:flex;flex-wrap:wrap;gap:8px" }, links.map((link, index) => ({
      tag: "button", attrs: { type: "button", role: "listitem", class: "more-action", "aria-pressed": String(link.id === selected.id), ...(state.pendingLinkSaving ? { disabled: "" } : {}) },
      text: labels[index]!,
      on: { click: () => handlers.onSelectPendingLink?.(link.id) },
    }))),
    el("div", undefined, { class: "pending-link-comparison", style: "display:flex;flex-wrap:wrap;gap:16px" }, [
      el("article", undefined, { class: "settings-card", style: "flex:1 1 260px" }, [el("h3", "Due Good item"), ...localDetails]),
      el("article", undefined, { class: "settings-card", style: "flex:1 1 260px" }, [
        el("h3", "Source observation"),
        el("div", undefined, { class: "settings-row" }, [el("strong", "Source reference"), el("code", selected.reference.id)]),
        el("div", undefined, { class: "settings-row" }, [el("strong", "Course"), el("span", selected.reference.course)]),
        el("div", undefined, { class: "settings-row" }, [el("strong", "Observed"), el("span", selected.observedAt === undefined ? "Unknown" : formatted(selected.observedAt, true))]),
        ...sourceFactRows(selected.fields),
      ]),
    ]),
    ...(selected.candidateIds.length <= 1 ? [] : [el("fieldset", undefined, { class: "settings-card" }, [
      el("legend", "Choose the Due Good item to compare before confirming"),
      ...selected.candidateIds.map((candidateId) => {
        const candidate = state.data.events.find((event) => event.sourceItemId === candidateId || event.id === candidateId);
        return { tag: "label", attrs: { class: "settings-row" }, children: [
          { tag: "input", attrs: { type: "radio", name: "pending-link-candidate", value: candidateId, "aria-label": `Choose Due Good item ${candidateId}`, ...(candidateId === selectedCandidateId ? { checked: "" } : {}), ...(state.pendingLinkSaving ? { disabled: "" } : {}) }, on: { change: () => handlers.onSelectPendingLinkCandidate?.(candidateId) } },
          el("span", candidate === undefined ? `Due Good ID ${candidateId} is unavailable` : `${candidate.title} · Due Good ID ${candidate.sourceItemId ?? candidate.id}`),
        ] };
      }),
    ])]),
    ...(selected.candidateIds.length === 0 ? [el("p", "No current local candidate is available. Confirmation is unavailable; you may keep the source record distinct.", { class: "inline-error", role: "alert" })] : []),
    ...(decision === undefined ? [el("div", undefined, { style: "display:flex;flex-wrap:wrap;gap:8px" }, [
      { tag: "button", attrs: { type: "button", class: "setup-secondary", ...(canKeepDistinct ? {} : { disabled: "" }) }, text: "Keep distinct", on: { click: () => handlers.onOpenPendingLinkDecision?.("reject") } },
      { tag: "button", attrs: { type: "button", class: "sync-button", ...(canConfirm ? {} : { disabled: "" }) }, text: "Confirm link", on: { click: () => handlers.onOpenPendingLinkDecision?.("confirm") } },
    ])] : [el("section", undefined, { role: "dialog", "aria-modal": "true", "aria-label": decision === "confirm" ? "Confirm source link" : "Keep records distinct", class: "pending-link-decision" }, [
      el("h3", decision === "confirm" ? "Link these records?" : "Keep these records distinct?"),
      el("p", decision === "confirm" ? "The existing Due Good item keeps its immutable ID, Done state, notes, grades, and unknown fields. The verified Canvas reference and source facts are added to it; the competing API item stays suppressed." : "No source reference is attached. The Canvas observation becomes its own coursework item with its own immutable ID; no fields merge."),
      el("p", "Cancel leaves this suggestion pending and does not change coursework."),
      el("div", undefined, { style: "display:flex;flex-wrap:wrap;gap:8px" }, [
        { tag: "button", attrs: { type: "button", class: "setup-secondary", ...(state.pendingLinkSaving ? { disabled: "" } : {}) }, text: "Cancel", on: { click: () => handlers.onCancelPendingLinkDecision?.() } },
        { tag: "button", attrs: { type: "button", class: decision === "confirm" ? "sync-button" : "more-action", ...(state.pendingLinkSaving ? { disabled: "", "aria-busy": "true" } : {}) }, text: state.pendingLinkSaving ? "Saving…" : decision === "confirm" ? "Confirm link" : "Keep distinct", on: { click: () => handlers.onResolvePendingLink?.() } },
      ]),
    ])]),
    el("p", "Keyboard: J/K selects a suggestion; C confirms; R keeps records distinct; Escape cancels a decision.", { class: "status" }),
  ]);
}

function morePage(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  const pendingReview = pendingLinkReview(state, handlers);
  const courses = orderedCourses(state.data.courses);
  return el("section", undefined, { class: "page" }, [
    heading("Due Good", "More", "Source status, refresh controls, and local app information."),
    ...(state.pendingLinkNotice === undefined ? [] : [el("p", state.pendingLinkNotice, { class: "status", role: "status", "aria-live": "polite" })]),
    ...(pendingReview === undefined ? [] : [pendingReview]),
    el("div", undefined, { class: "more-grid" }, [
      desktopStoreCard(state.desktop, state, handlers),
      el("section", undefined, { class: "settings-card" }, [
        el("h2", "Import behavior"),
        el("p", "Incomplete refreshes never remove existing coursework."),
        el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Canvas items"), el("span", "Assignments, class meetings, files, pages, links, modules, announcements, and read-only inbox")])]),
        el("div", undefined, { class: "settings-row" }, [el("div", undefined, undefined, [el("strong", "Privacy"), el("span", "Local app · no public coursework data")])]),
        el("details", undefined, { "data-course-colors": "true" }, [el("summary", "Course colors"), ...courses.map((course) => el("div", undefined, { class: "settings-row" }, [el("span", undefined, { class: "legend-dot", style: `--dot:${color(courses, course.courseCode)}` }), el("span", `${code(course.courseCode)} · ${course.title}`)]))]),
      ]),
    ]),
  ]);
}

function pagePanel(pageName: DashboardPage, descriptor: ElementDescriptor): ElementDescriptor {
  return { ...descriptor, attrs: { ...descriptor.attrs, "data-page-panel": pageName, "aria-label": `Due Good ${pageName} page` } };
}

function page(state: DashboardState, handlers: DashboardHandlers): ElementDescriptor {
  switch (state.page) {
    case "timeline": return pagePanel("timeline", timelinePage(state, handlers));
    case "grades": return pagePanel("grades", renderGradebookPage(state, handlers));
    case "inbox": return pagePanel("inbox", renderInboxPage(state, handlers));
    case "completed": return pagePanel("completed", completedPage(state, handlers));
    case "courses": return pagePanel("courses", coursesPage(state, handlers));
    case "library": return pagePanel("library", renderLibraryPage(state, handlers, { el, heading, empty, safeLocalHref, formatted, code, color, structuredBody: (text) => renderStructuredBody(text, el) }));
    case "activity": return pagePanel("activity", activityPage(state, handlers));
    case "more": return pagePanel("more", morePage(state, handlers));
  }
}

function compactRefreshOutcome(state: DashboardState, latest: DashboardRefresh | undefined): string {
  if (state.refreshFeedback !== undefined) return state.refreshFeedback.outcome;
  if (state.desktop?.storeState === "preview") return state.desktop.importedAt === null ? "Imported copy" : `Imported ${formatted(state.desktop.importedAt, true)}`;
  if (state.refreshState === "running") return refreshProgressNote(state, false);
  if (state.refreshState === "failed") return "Refresh failed";
  if (state.refreshState === "partial") return latest?.source === "calendar" ? "Calendar refresh incomplete" : "Refresh incomplete";
  if (state.refreshState === "complete") return latest?.source === "calendar" ? "Calendar refreshed" : "Refresh complete";
  if (latest?.status === "partial") return "Last refresh incomplete";
  if (latest?.status === "failed") return "Last refresh failed";
  if (latest?.source === "calendar") return `Calendar updated · ${formatted(latest.finishedAt ?? latest.startedAt, true)}`;
  if (state.desktop?.lastRefreshAt) return `Updated ${formatted(state.desktop.lastRefreshAt, true)}`;
  if (latest !== undefined) return `Updated ${formatted(latest.startedAt, true)}`;
  return "Not yet refreshed";
}

function compactRefreshAction(state: DashboardState): string {
  if (state.refreshFeedback !== undefined) return state.refreshFeedback.action;
  if (state.refreshState === "failed" || state.refreshState === "partial") return "Check Activity for details, then retry.";
  return "";
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
  const refreshScope = state.desktop?.browserRefreshAvailable === true ? "Canvas coursework, grades, Inbox, library, and calendar deadlines" : state.desktop?.refreshAvailable === true ? "Canvas coursework, grades, Inbox, and library" : state.desktop?.icalRefreshAvailable === true ? "Calendar deadlines only; grades, Inbox, and library keep the prior Canvas capture" : "Refresh unavailable";
  const refreshButton: ElementDescriptor = { tag: "button", attrs: { type: "button", class: `sync-button refresh-button${refreshing ? " refreshing" : ""}`, "aria-busy": String(refreshing), title: refreshScope, ...(refreshing ? { disabled: "" } : {}) }, text: refreshActionLabel(state, refreshing, "topbar"), on: { click: handlers.onRefresh } };
  const setupInstructionsBtn = state.refreshFeedback?.setupInstructionsAvailable === true ? [{
    tag: "button",
    attrs: { type: "button", class: "setup-secondary setup-instructions-btn", "aria-label": "Canvas setup session instructions" },
    text: "Setup steps",
    on: { click: () => handlers.onToggleSetupInstructions?.(true) },
  }] : [];
  const setupDialog = state.showSetupInstructions === true ? [
    el("section", undefined, { role: "region", "aria-label": "Canvas setup session instructions", class: "setup-report canvas-setup-dialog" }, [
      el("h2", "Visible Canvas setup session"),
      el("p", "Use this setup only when Canvas sign-in or a survey blocks the headless refresh. Run these commands from Due Good’s project directory:"),
      el("ol", undefined, { class: "setup-steps-list" }, [
        el("li", "Stop any running Canvas session: npm run canvas:session -- stop"),
        el("li", "Start the visible setup session: npm run canvas:session -- start --headed"),
        el("li", "Finish sign-in, verification, or dismiss any survey popup in the opened Chrome window."),
        el("li", "Stop the visible session: npm run canvas:session -- stop"),
        el("li", "Return to Due Good and click Refresh. The app refresh remains headless."),
      ]),
      el("div", undefined, { class: "setup-actions" }, [
        {
          tag: "button",
          attrs: { type: "button", class: "sync-button", "data-return-to-refresh": "true" },
          text: "Return to Refresh",
          on: { click: () => { handlers.onToggleSetupInstructions?.(false); handlers.onFocusRefresh?.(); } },
        },
      ]),
    ]),
  ] : [];
  const sourceNotice = freshnessNotice(state.data.sourceStatus, state.data.courses, refreshing && (state.desktop?.browserRefreshAvailable === true || state.desktop?.refreshAvailable === true));
  const refreshAlert = state.refreshAlert === undefined ? [] : [el("div", undefined, { class: "refresh-change-alert", role: "alert", "aria-live": "assertive" }, [el("p", state.refreshAlert), { tag: "button", attrs: { type: "button", "aria-label": "Dismiss refresh changes alert" }, text: "Dismiss", on: { click: () => handlers.onDismissRefreshAlert?.() } }])];
  const refreshAction = compactRefreshAction(state);
  const refreshSummary = `${compactRefreshOutcome(state, latest)}${refreshAction === "" ? "" : ` · ${refreshAction}`}`;
  const refreshDiagnostics = state.refreshFeedback?.detail ?? state.refreshDetail ?? refreshNote(state, latest);
  const refreshDetails: ElementDescriptor = {
    tag: "details",
    attrs: { class: "refresh-details" },
    children: [
      { tag: "summary", text: "Details" },
      el("p", refreshDiagnostics),
    ],
  };
  const courseSummary = courseworkIsVerified(state.data.sourceStatus, state.data.courses)
    ? `${courses.length} course${courses.length === 1 ? "" : "s"}`
    : "Courses unverified";
  return el("div", undefined, { class: "app" }, [el("aside", undefined, { class: "sidebar" }, [el("div", undefined, { class: "brand" }, [brandMark, el("div", undefined, undefined, [el("div", "Due Good", { class: "brand-name" }), el("span", courses[0]?.term ?? "Marymount", { class: "brand-note" })])]), dashboardNav(state.page, handlers.onNavigate)]), el("div", undefined, { class: "workspace" }, [el("header", undefined, { class: "topbar" }, [el("div", undefined, { class: "term-label" }, [el("strong", courses[0]?.term ?? "Current term"), el("span", ` · ${courseSummary}`)]), el("div", undefined, { class: "top-actions" }, [...(state.desktop?.storeState === "preview" ? [el("span", "Preview copy", { class: "preview-badge", title: "Imported from the legacy folder. It never refreshes." })] : []), el("span", refreshSummary, { class: "sync-note", role: "status", "aria-live": "polite" }), refreshDetails, ...setupInstructionsBtn, ...(state.data.refreshAvailable ? [refreshButton] : [])])]), el("main", undefined, { id: "main", tabindex: "-1" }, [...(state.loading ? [empty("Loading coursework…")] : []), ...setupDialog, ...refreshAlert, ...(state.desktop?.snapshotInProgress ? [el("div", snapshotStatus, { class: "status", role: "status", "aria-live": "polite" })] : []), ...(state.error === undefined ? [] : [el("div", state.error, { class: "load-error", role: "alert" })]), ...(state.desktop?.warning ? [el("div", state.desktop.warning, { class: "load-error", role: "alert" })] : []), ...(!state.loading && state.error === undefined ? [...(sourceNotice === undefined ? [] : [sourceNotice]), page(state, handlers)] : [])])])]);
}

function freshnessNotice(source: DashboardSourceStatus, courses: readonly DashboardCourse[], refreshing: boolean): ElementDescriptor | undefined {
  const affected = [
    ...(!courseworkIsVerified(source, courses) ? ["coursework and grades"] : []),
    ...(source.inbox !== "synced" || source.browserFreshness?.current === false ? ["Inbox"] : []),
    ...(source.library !== "synced" || source.browserFreshness?.current === false ? ["library items"] : []),
  ];
  if (affected.length === 0) return undefined;
  if (refreshing) return el("p", "Updating Canvas. Unverified sections are temporarily hidden; retained calendar deadlines and personal records remain available.", { class: "source-freshness-notice", role: "note", "data-source-freshness": "refreshing" });
  const sections = affected.length === 0 ? "Canvas" : `Canvas ${affected.join(", ")}`;
  return el("p", `${sections} could not be verified from the latest refresh. Unverified coursework is hidden; retained calendar deadlines and personal records remain available. Refresh again or check Activity for details.`, { class: "inline-error source-freshness-notice", role: "note", "data-source-freshness": "stale" });
}
