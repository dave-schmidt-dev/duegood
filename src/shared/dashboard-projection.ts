/**
 * Pure dashboard projection shared by the loopback server (browser mode) and the desktop webview
 * (native mode). Every function takes already-parsed JSON values and performs no I/O, so the Node
 * server can feed it files it reads and the webview can feed it the raw, bounded documents the
 * Rust store returns. Both modes therefore project identical data; the documented differences are
 * the injected options (resource open prefix, avatar path, refresh availability, source label,
 * and data origin, which changes only the visible Inbox wording in the source detail).
 */
import type { ConversationAttachment, ConversationMessage, NormalizedConversation } from "../canvas/conversations";
import type { AssignmentListItem } from "../db/types";
import type { LocalCourse, LocalSnapshot } from "../local/coursework-store";

type JsonObject = Record<string, unknown>;
type LocalGradeGroup = NonNullable<LocalCourse["gradeGroups"]>[number];
type LocalGradeRecord = LocalSnapshot["assignments"][number];
type LocalTimelineEvent = LocalSnapshot["events"][number];

/** Loopback route prefix for downloaded Canvas files in browser mode. */
export const LOCAL_RESOURCE_PREFIX = "/api/local/resources/";
/** Largest avatar the dashboard shows (matches `src/canvas/profile-sync.ts`). */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

export interface LocalResource {
  readonly id: string;
  readonly courseId: string;
  readonly courseCode: string | null;
  readonly type: "File" | "Page" | "Link" | "Module" | "Announcement";
  readonly title: string;
  readonly context: string | null;
  readonly updatedAt: string | null;
  readonly openPath: string | null;
  /** Native mode only: the manifest records a local copy, which opens through a later handler. */
  readonly savedLocally?: true;
}

interface LocalRefreshChange {
  readonly kind: "added" | "changed" | "removed" | "notice";
  readonly title: string;
  readonly detail: string;
}

export interface LocalRefresh {
  readonly id: string;
  readonly status: "complete" | "partial" | "failed";
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly summary: { readonly added: number; readonly changed: number; readonly removed: number };
  readonly changes: readonly LocalRefreshChange[];
}

export interface LocalConversationSnapshot {
  readonly status: "synced" | "partial" | "not_synced";
  readonly generatedAt: string | null;
  readonly conversations: readonly NormalizedConversation[];
}

export interface LocalProfile {
  readonly displayName: string;
  readonly avatarPath?: string;
}

/** Parsed Canvas export documents of one course folder; `null` when absent or malformed. */
export interface CourseExportDocuments {
  readonly files: unknown;
  readonly pages: unknown;
  readonly modules: unknown;
  readonly announcements: unknown;
  readonly downloadManifest: unknown;
}

/** Raw text of one course folder's export documents, as the Rust store returns them. */
export interface CourseExportTexts {
  readonly files: string | null;
  readonly pages: string | null;
  readonly modules: string | null;
  readonly announcements: string | null;
  readonly downloadManifest: string | null;
}

/** Size and leading bytes of the avatar sidecar; enough to check the image signature. */
export interface AvatarHeader {
  readonly sizeBytes: number;
  readonly head: readonly number[];
}

/** The fixed-name documents returned by the desktop `read_dashboard_documents` command. */
export interface DashboardDocumentBundle {
  readonly storeState: "preview" | "authoritative";
  readonly coursework: { readonly text: string; readonly version: string };
  readonly refreshHistory: string | null;
  readonly conversations: string | null;
  readonly profile: string | null;
  readonly avatar: AvatarHeader | null;
  /** Keyed by course folder name (`classes/<name>`). */
  readonly courseExports: Readonly<Record<string, CourseExportTexts>>;
}

/** Mode-specific values injected into the otherwise identical projection. */
export interface DashboardProjectionOptions {
  /** Prefix for downloaded-file open paths; `null` marks them `savedLocally` instead (native). */
  readonly resourceOpenPrefix: string | null;
  /** Avatar route for a validated avatar; `null` omits it (native mode cannot serve it yet). */
  readonly avatarPath: string | null;
  readonly refreshAvailable: boolean;
  readonly sourceLabel: string;
  /**
   * Where the documents came from, which decides what the visible source detail may claim.
   * `"live"`: the browser app's own legacy folder, which its refresh keeps current, so a complete
   * Inbox reads "Inbox synced". `"imported"`: a desktop copy that never refreshes, so the detail
   * never says "synced" (a complete Inbox reads "Inbox imported", a partial one "Inbox partial",
   * and an absent one "Inbox not captured"). Machine fields such as `sourceStatus.inbox` keep
   * their raw status in both modes.
   */
  readonly dataOrigin: "live" | "imported";
}

const IMPORTED_INBOX_LABELS: Readonly<Record<LocalConversationSnapshot["status"], string>> = {
  synced: "Inbox imported",
  partial: "Inbox partial",
  not_synced: "Inbox not captured",
};

function inboxDetail(status: LocalConversationSnapshot["status"], dataOrigin: DashboardProjectionOptions["dataOrigin"]): string {
  return dataOrigin === "imported" ? IMPORTED_INBOX_LABELS[status] : `Inbox ${status.replace("_", " ")}`;
}

/** The `/api/dashboard` response body. */
export interface DashboardBody {
  readonly version: string;
  readonly courses: readonly LocalCourse[];
  readonly events: LocalSnapshot["events"];
  readonly resources: readonly LocalResource[];
  readonly conversations: readonly NormalizedConversation[];
  readonly refreshes: readonly LocalRefresh[];
  readonly profile: LocalProfile | null;
  readonly refreshAvailable: boolean;
  readonly sourceStatus: {
    readonly state: "partial" | "not_synced" | "ready";
    readonly label: string;
    readonly detail: string;
    readonly lastRefreshAt: string | null;
    readonly coursework: "synced";
    readonly library: "synced" | "not_synced";
    readonly inbox: LocalConversationSnapshot["status"];
  };
}

const CHANGE_FIELD_LABELS: Readonly<Record<string, string>> = {
  title: "Title",
  at: "Due date",
  points: "Points",
  submissionState: "Submission",
  gradedAt: "Graded at",
  grade: "Grade",
  score: "Score",
  assignmentGroupId: "Assignment group ID",
  assignmentGroupName: "Assignment group",
  assignmentGroupWeight: "Assignment group weight",
};

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length === 0 ? null : clean.slice(0, max);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function entries(value: unknown, max = 1_000): JsonObject[] {
  return Array.isArray(value) ? value.slice(0, max).map(object).filter((item): item is JsonObject => item !== null) : [];
}

function resourceId(courseId: string, type: string, value: unknown): string {
  return `${courseId}:${type}:${String(value).slice(0, 100)}`;
}

/** Parses JSON text like the Node reader: absent or malformed documents become `null`. */
function parseJsonText(value: string | null | undefined): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

/** The `classes/<name>` folder a course names, or `null` for anything else. */
export function courseFolderSlug(folder: string | null): string | null {
  if (folder === null) return null;
  if (/^[a-z0-9-]+$/.test(folder)) return folder;
  if (/^classes\/[a-z0-9-]+$/.test(folder)) return folder.slice("classes/".length);
  return null;
}

function submissionStateLabel(value: unknown): string {
  if (typeof value !== "string") return "Unknown";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "known_not_submitted" || normalized === "not_submitted" || normalized === "unsubmitted") return "Not submitted";
  if (normalized === "known_submitted" || normalized === "submitted" || normalized === "pending" || normalized === "pending_review" || normalized === "late") return "Submitted";
  if (normalized === "known_graded" || normalized === "graded") return "Graded";
  return "Unknown";
}

function dateLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function changeFieldValue(field: string, value: unknown): string {
  if (field === "submissionState") return submissionStateLabel(value);
  if (field === "at" || field === "gradedAt") return dateLabel(value) ?? "Unavailable";
  if (value === null || value === undefined || (typeof value === "string" && value.trim().length === 0)) return "Unavailable";
  if (field === "assignmentGroupWeight" && typeof value === "number") return `${String(value)}%`;
  return typeof value === "string" || typeof value === "number" ? String(value) : "Unavailable";
}

function changedFieldsDetail(change: JsonObject): string | null {
  const fieldDetails = entries(change.fields, 20).map((field) => {
    const name = text(field.field, 80);
    if (name === null) return null;
    const label = CHANGE_FIELD_LABELS[name] ?? name;
    return `${label}: ${changeFieldValue(name, field.before)} → ${changeFieldValue(name, field.after)}`;
  }).filter((value): value is string => value !== null);
  if (fieldDetails.length === 0) return null;
  const course = text(change.course, 80);
  return [course, fieldDetails.join(" · ")].filter((value): value is string => value !== null).join(" · ");
}

// --- Coursework document (port of `validateAndProject` in src/local/coursework-store.ts) -------

function requireObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function gradeGroups(value: unknown): readonly LocalGradeGroup[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => {
    const group = requireObject(candidate, "course.gradeGroups entry");
    return { id: stringOrNull(group.id), name: stringOrNull(group.name), weight: numberOrNull(group.weight) };
  });
}

function submissionState(item: JsonObject): AssignmentListItem["submissionState"] {
  if (item.submissionStatus === "pending" || item.submissionStatus === "graded") return "known_submitted";
  if (item.submissionStatus === "unsubmitted") return "known_not_submitted";
  return "unknown";
}

function dueAt(item: JsonObject): Pick<AssignmentListItem, "dueAt" | "dueAtState"> {
  if (!("at" in item)) return { dueAt: null, dueAtState: "not_returned" };
  if (item.at === null) return { dueAt: null, dueAtState: "known_null" };
  if (typeof item.at !== "string") throw new Error("item.at must be a string or null");
  return { dueAt: item.at, dueAtState: "known" };
}

/**
 * Validates a parsed coursework document and projects it exactly like the Node store. Throws on
 * the same structural errors (non-object document, duplicate course keys or item IDs, unknown
 * course references, non-string due dates).
 */
function projectCoursework(value: unknown, version: string): LocalSnapshot {
  const document = requireObject(value, "coursework document");
  const rawCourses = requireArray(document.courses, "courses");
  const rawItems = requireArray(document.items, "items");
  const coursesByKey = new Map<string, LocalCourse>();
  for (const [index, candidate] of rawCourses.entries()) {
    const course = requireObject(candidate, `courses[${index}]`);
    if (typeof course.key !== "string" || course.key.length === 0) throw new Error(`courses[${index}].key must be a nonempty string`);
    if (coursesByKey.has(course.key)) throw new Error(`duplicate course key: ${course.key}`);
    coursesByKey.set(course.key, {
      id: course.key,
      courseCode: stringOrNull(course.code),
      title: stringOrNull(course.title),
      color: stringOrNull(course.color),
      folder: stringOrNull(course.folder),
      lastSuccessfulCheckAt: typeof document.generated === "string" ? Date.parse(document.generated) || null : null,
      gradeGroups: gradeGroups(course.gradeGroups),
      syncing: false,
    });
  }

  const ids = new Set<string>();
  const assignments: LocalGradeRecord[] = [];
  const events: LocalTimelineEvent[] = [];
  for (const [index, candidate] of rawItems.entries()) {
    const item = requireObject(candidate, `items[${index}]`);
    if (typeof item.id !== "string" || item.id.length === 0) throw new Error(`items[${index}].id must be a nonempty string`);
    if (ids.has(item.id)) throw new Error(`duplicate item id: ${item.id}`);
    ids.add(item.id);
    if (typeof item.course !== "string" || !coursesByKey.has(item.course)) throw new Error(`item ${item.id} references an unknown course`);
    const course = coursesByKey.get(item.course) as LocalCourse;
    if (item.kind === "milestone") continue;
    const projected: LocalGradeRecord = {
      sourceItemId: item.id,
      courseId: course.id,
      courseCode: course.courseCode,
      courseTitle: course.title,
      title: stringOrNull(item.title),
      ...dueAt(item),
      submissionState: submissionState(item),
      completed: item.done === true,
      completedAt: typeof item.doneAt === "string" ? Date.parse(item.doneAt) || null : null,
      source: stringOrNull(item.source),
      points: numberOrNull(item.points),
      score: numberOrNull(item.score),
      grade: stringOrNull(item.grade),
      gradedAt: stringOrNull(item.gradedAt),
      assignmentGroupId: stringOrNull(item.assignmentGroupId),
      assignmentGroupName: stringOrNull(item.assignmentGroupName),
      assignmentGroupWeight: numberOrNull(item.assignmentGroupWeight),
    };
    const event: LocalTimelineEvent = {
      ...projected,
      type: item.kind === "session" ? "class" : "deadline",
      kind: typeof item.kind === "string" ? item.kind : null,
      detail: stringOrNull(item.detail),
      place: null,
      discussionPostDone: item.discussionPostDone === true,
      discussionRepliesDone: item.discussionRepliesDone === true,
    };
    events.push(event);
    if (event.type === "deadline") assignments.push(projected);
  }
  assignments.sort((left, right) => (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999"));
  events.sort((left, right) => (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999"));
  return { version, courses: [...coursesByKey.values()], assignments, events };
}

// --- Library resources ------------------------------------------------------------------------

/** Projects one course's Canvas export lists into Library resources (unsorted, uncapped). */
export function projectCourseResources(course: Pick<LocalCourse, "id" | "courseCode">, documents: CourseExportDocuments, resourceOpenPrefix: string | null): LocalResource[] {
  const resources: LocalResource[] = [];
  const manifest = entries(documents.downloadManifest);
  const localFilesByCanvasId = new Map(manifest.filter((item) => item.status === "downloaded" || item.status === "reused").map((item) => [String(item.id), item] as const));

  for (const item of entries(documents.files)) {
    const title = text(item.display_name) ?? text(item.filename);
    if (title === null) continue;
    const id = resourceId(course.id, "file", item.id);
    const saved = localFilesByCanvasId.has(String(item.id));
    resources.push({
      id, courseId: course.id, courseCode: course.courseCode, type: "File", title,
      context: typeof item.size === "number" ? `${String(item.size)} bytes` : null,
      updatedAt: text(item.updated_at, 80),
      openPath: saved && resourceOpenPrefix !== null ? `${resourceOpenPrefix}${encodeURIComponent(id)}` : null,
      ...(saved && resourceOpenPrefix === null ? { savedLocally: true as const } : {}),
    });
  }
  for (const item of entries(documents.pages)) {
    const title = text(item.title); if (title === null) continue;
    resources.push({ id: resourceId(course.id, "page", item.page_id ?? item.url), courseId: course.id, courseCode: course.courseCode, type: "Page", title, context: "Canvas page", updatedAt: text(item.updated_at, 80), openPath: null });
  }
  for (const item of entries(documents.modules)) {
    const title = text(item.name); if (title === null) continue;
    resources.push({ id: resourceId(course.id, "module", item.id), courseId: course.id, courseCode: course.courseCode, type: "Module", title, context: typeof item.items_count === "number" ? `${String(item.items_count)} items` : null, updatedAt: null, openPath: null });
    for (const child of entries(item.items, 250).filter((candidate) => candidate.type === "ExternalUrl")) {
      const childTitle = text(child.title); if (childTitle === null) continue;
      resources.push({ id: resourceId(course.id, "link", child.id), courseId: course.id, courseCode: course.courseCode, type: "Link", title: childTitle, context: `In ${title}`, updatedAt: null, openPath: null });
    }
  }
  for (const item of entries(documents.announcements)) {
    const title = text(item.title); if (title === null) continue;
    resources.push({ id: resourceId(course.id, "announcement", item.id), courseId: course.id, courseCode: course.courseCode, type: "Announcement", title, context: "Course announcement", updatedAt: text(item.posted_at, 80), openPath: null });
  }
  return resources;
}

/** Caps the Library at 2,000 items in course order, then sorts newest first and by title. */
export function finalizeResources(resources: readonly LocalResource[]): readonly LocalResource[] {
  return resources.slice(0, 2_000).sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.title.localeCompare(right.title));
}

// --- Activity (refresh history plus Inbox changes) --------------------------------------------

/** Projects the refresh history and the Inbox change set into Activity entries, newest first. */
export function projectRefreshes(historyDocument: unknown, inboxDocument: unknown): readonly LocalRefresh[] {
  const document = object(historyDocument);
  const raw = entries(document?.events, 100);
  const refreshes = raw.map((event, index): LocalRefresh => {
    const complete = event.status === "succeeded" && event.sourceComplete === true;
    const changes = entries(event.changes, 500).map((change): LocalRefreshChange => {
      const kind = change.kind === "added" ? "added" : change.kind === "removed" ? "removed" : change.kind === "notice" ? "notice" : "changed";
      const detail = changedFieldsDetail(change);
      return { kind, title: text(change.title) ?? "Canvas item", detail: detail ?? text(change.detail, 1_000) ?? text(change.course, 80) ?? "" };
    });
    const summary = object(event.summary);
    const status: LocalRefresh["status"] = complete ? "complete" : event.sourceComplete === false ? "partial" : "failed";
    if (status !== "complete" && changes.length === 0) changes.push({ kind: "notice", title: "Refresh incomplete", detail: "Existing coursework was kept." });
    return { id: text(event.id, 120) ?? `refresh-${String(index)}`, status, startedAt: text(event.startedAt, 80), finishedAt: text(event.finishedAt, 80), summary: { added: number(summary?.added), changed: number(summary?.updated), removed: complete ? number(summary?.removed) : 0 }, changes };
  });
  const inbox = object(inboxDocument);
  const inboxChanges = object(inbox?.changes);
  if (inbox !== null && inboxChanges !== null) {
    const added = entries(inboxChanges.added, 500);
    const changed = entries(inboxChanges.changed, 500);
    const removed = inbox.complete === true ? entries(inboxChanges.removed, 500) : [];
    const changes: LocalRefreshChange[] = [
      ...added.map((item) => ({ kind: "added" as const, title: text(item.subject) ?? "Inbox thread", detail: "New Canvas inbox thread." })),
      ...changed.map((item) => ({ kind: "changed" as const, title: text(object(item.after)?.subject) ?? "Inbox thread", detail: "Canvas inbox thread updated." })),
      ...removed.map((item) => ({ kind: "removed" as const, title: text(item.subject) ?? "Inbox thread", detail: "Canvas inbox thread no longer appears in the inbox." })),
    ];
    if (inbox.complete !== true && changes.length === 0) changes.push({ kind: "notice", title: "Inbox refresh incomplete", detail: "Existing messages were kept." });
    refreshes.push({ id: `inbox-${text(inbox.generatedAt, 80) ?? "latest"}`, status: inbox.complete === true ? "complete" : "partial", startedAt: null, finishedAt: text(inbox.generatedAt, 80), summary: { added: added.length, changed: changed.length, removed: removed.length }, changes });
  }
  return refreshes.sort((left, right) => (right.finishedAt ?? right.startedAt ?? "").localeCompare(left.finishedAt ?? left.startedAt ?? ""));
}

// --- Inbox --------------------------------------------------------------------------------------

function attachmentsOf(value: unknown, max: number): ConversationAttachment[] {
  return entries(value, max).map((attachment) => ({ name: text(attachment.name, 240), contentType: text(attachment.contentType, 120), sizeBytes: typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : null })).filter((attachment): attachment is ConversationAttachment => attachment.name !== null);
}

/** Normalizes the stored Inbox document into bounded, read-only conversations, newest first. */
export function projectConversations(value: unknown): LocalConversationSnapshot {
  const document = object(value);
  if (document === null) return { status: "not_synced", generatedAt: null, conversations: [] };
  const conversations: NormalizedConversation[] = [];
  for (const item of entries(document.conversations, 500)) {
    const canvasConversationId = text(item.canvasConversationId, 128);
    const subject = text(item.subject, 240);
    if (canvasConversationId === null || subject === null || typeof item.unread !== "boolean" || typeof item.starred !== "boolean" || typeof item.messageCount !== "number") continue;
    const participants = entries(item.participants, 100).map((participant) => ({ canvasUserId: text(participant.canvasUserId, 128), name: text(participant.name, 120) })).filter((participant): participant is { canvasUserId: string; name: string } => participant.canvasUserId !== null && participant.name !== null);
    const attachments = attachmentsOf(item.attachments, 2_000);
    const messages = entries(item.messages, 2_000).map((message): ConversationMessage | null => {
      const author = text(message.author, 120);
      const body = typeof message.body === "string" ? message.body : null;
      if (body === null || author === null) return null;
      return {
        canvasMessageId: typeof message.canvasMessageId === "string" ? message.canvasMessageId : null,
        authorId: typeof message.authorId === "string" ? message.authorId : null,
        author,
        createdAt: typeof message.createdAt === "string" ? message.createdAt : null,
        body,
        bodyTruncated: message.bodyTruncated === true,
        attachments: attachmentsOf(message.attachments, 250),
      };
    }).filter((message): message is ConversationMessage => message !== null);
    conversations.push({ canvasConversationId, contextLabel: text(item.contextLabel, 160), subject, participants, latestMessagePreview: text(item.latestMessagePreview, 280), latestMessageAt: text(item.latestMessageAt, 80), unread: item.unread, starred: item.starred, messageCount: Math.max(0, Math.min(100_000, Math.trunc(item.messageCount))), ...(messages.length > 0 ? { messages } : {}), ...(typeof item.historyComplete === "boolean" ? { historyComplete: item.historyComplete } : {}), ...(typeof item.safetyTruncated === "boolean" ? { safetyTruncated: item.safetyTruncated } : {}), attachments });
  }
  conversations.sort((left, right) => (right.latestMessageAt ?? "").localeCompare(left.latestMessageAt ?? ""));
  return { status: document.complete === true ? "synced" : "partial", generatedAt: text(document.generatedAt, 80), conversations };
}

// --- Profile (port of `readValidatedLocalCanvasProfile` in src/canvas/profile-sync.ts) ----------

function cleanText(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const result = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return result.length === 0 ? null : result.slice(0, max);
}

function avatarContentType(value: unknown): AvatarContentType | null {
  const normalized = typeof value === "string" ? value.split(";", 1)[0]?.trim().toLowerCase() : undefined;
  return AVATAR_CONTENT_TYPES.includes(normalized as AvatarContentType) ? normalized as AvatarContentType : null;
}

function hasImageSignature(bytes: Uint8Array, type: AvatarContentType): boolean {
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  const ascii = (start: number, end: number): string => new TextDecoder().decode(bytes.subarray(start, end));
  if (type === "image/gif") return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
  return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

/**
 * Validates the stored profile and its avatar header like the Node reader: a cleaned display
 * name, an allowed image type, a plain sibling file name, a size within the cap, and a matching
 * image signature. Returns `null` when no display name survives.
 */
function projectProfile(value: unknown, avatar: AvatarHeader | null, avatarPath: string | null): LocalProfile | null {
  const record = object(value);
  if (record === null) return null;
  const displayName = cleanText(record.name) ?? cleanText(record.short_name);
  if (displayName === null) return null;
  const metadata = object(record.avatar);
  const type = avatarContentType(metadata?.contentType);
  const name = metadata?.path;
  const plainName = typeof name === "string" && name.length > 0 && !name.includes("/");
  const valid = type !== null && plainName && avatar !== null && avatar.sizeBytes > 0 && avatar.sizeBytes <= MAX_AVATAR_BYTES && hasImageSignature(Uint8Array.from(avatar.head), type);
  return valid && avatarPath !== null ? { displayName, avatarPath } : { displayName };
}

// --- Whole dashboard ------------------------------------------------------------------------------

function exportDocuments(texts: CourseExportTexts): CourseExportDocuments {
  return {
    files: parseJsonText(texts.files),
    pages: parseJsonText(texts.pages),
    modules: parseJsonText(texts.modules),
    announcements: parseJsonText(texts.announcements),
    downloadManifest: parseJsonText(texts.downloadManifest),
  };
}

/**
 * Projects the desktop store's raw documents into the `/api/dashboard` body. With the browser
 * options this equals the loopback server's response for the same files (the parity test in
 * `test/local/tauri-documents.test.ts` asserts it). Throws when the coursework document is invalid.
 */
export function projectDashboardDocuments(bundle: DashboardDocumentBundle, options: DashboardProjectionOptions): DashboardBody {
  const snapshot = projectCoursework(JSON.parse(bundle.coursework.text) as unknown, bundle.coursework.version);
  const collected: LocalResource[] = [];
  for (const course of snapshot.courses) {
    const slug = courseFolderSlug(course.folder);
    if (slug === null || !Object.hasOwn(bundle.courseExports, slug)) continue;
    const texts = bundle.courseExports[slug];
    if (texts === undefined) continue;
    for (const resource of projectCourseResources(course, exportDocuments(texts), options.resourceOpenPrefix)) collected.push(resource);
  }
  const resources = finalizeResources(collected);
  const conversationsDocument = parseJsonText(bundle.conversations);
  const refreshes = projectRefreshes(parseJsonText(bundle.refreshHistory), conversationsDocument);
  const inbox = projectConversations(conversationsDocument);
  const profile = projectProfile(parseJsonText(bundle.profile), bundle.avatar, options.avatarPath);
  const latestRefreshAt = refreshes[0]?.finishedAt ?? refreshes[0]?.startedAt ?? null;
  const dashboardCourses = snapshot.courses.filter((course) => snapshot.events.some((event) => event.courseId === course.id));
  return {
    version: snapshot.version,
    courses: dashboardCourses,
    events: snapshot.events,
    resources,
    conversations: inbox.conversations,
    refreshes,
    profile,
    refreshAvailable: options.refreshAvailable,
    sourceStatus: {
      state: inbox.status === "partial" ? "partial" : inbox.status === "not_synced" ? "not_synced" : "ready",
      label: options.sourceLabel,
      detail: `${String(snapshot.events.length)} timeline events · ${String(resources.length)} library items · ${inboxDetail(inbox.status, options.dataOrigin)}`,
      lastRefreshAt: latestRefreshAt,
      coursework: "synced",
      library: resources.length > 0 ? "synced" : "not_synced",
      inbox: inbox.status,
    },
  };
}
