import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { readValidatedLocalCanvasProfile } from "../canvas/profile-sync";
import type { ConversationAttachment, ConversationMessage, NormalizedConversation } from "../canvas/conversations";
import type { LocalCourse } from "./coursework-store";

type JsonObject = Record<string, unknown>;

export interface LocalResource {
  readonly id: string;
  readonly courseId: string;
  readonly courseCode: string | null;
  readonly type: "File" | "Page" | "Link" | "Module" | "Announcement";
  readonly title: string;
  readonly context: string | null;
  readonly updatedAt: string | null;
  readonly openPath: string | null;
}

interface LocalRefreshChange {
  readonly kind: "added" | "changed" | "removed" | "notice";
  readonly title: string;
  readonly detail: string;
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
  readonly avatarPath?: "/api/local/profile/avatar";
}

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

async function jsonFile(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")) as unknown; } catch { return null; }
}

function entries(value: unknown, max = 1_000): JsonObject[] {
  return Array.isArray(value) ? value.slice(0, max).map(object).filter((item): item is JsonObject => item !== null) : [];
}

function resourceId(courseId: string, type: string, value: unknown): string {
  return `${courseId}:${type}:${String(value).slice(0, 100)}`;
}

function courseDirectory(root: string, folder: string | null): string | null {
  if (folder === null) return null;
  if (/^[a-z0-9-]+$/.test(folder)) return path.join(root, "classes", folder);
  if (/^classes\/[a-z0-9-]+$/.test(folder)) return path.join(root, folder);
  return null;
}

/** Projects already-sanitized private Canvas exports into the loopback dashboard. */
export class DashboardStore {
  readonly #root: string;

  constructor(courseworkFile: string) {
    this.#root = path.dirname(path.resolve(courseworkFile));
  }

  async profile(): Promise<LocalProfile | null> {
    const profile = await readValidatedLocalCanvasProfile(path.join(this.#root, "canvas-profile.json"));
    if (profile === null) return null;
    return profile.avatarFilePath === null
      ? { displayName: profile.displayName }
      : { displayName: profile.displayName, avatarPath: "/api/local/profile/avatar" };
  }

  async avatar(): Promise<{ readonly filePath: string; readonly contentType: string } | null> {
    const profile = await readValidatedLocalCanvasProfile(path.join(this.#root, "canvas-profile.json"));
    if (profile === null || profile.avatarFilePath === null || profile.avatarContentType === null) return null;
    return { filePath: profile.avatarFilePath, contentType: profile.avatarContentType };
  }

  async resources(courses: readonly LocalCourse[]): Promise<readonly LocalResource[]> {
    const resources: LocalResource[] = [];
    for (const course of courses) {
      const directory = courseDirectory(this.#root, course.folder);
      if (directory === null) continue;
      const base = path.join(directory, "canvas-export");
      const api = path.join(base, "api");
      const manifest = entries(await jsonFile(path.join(base, "download-manifest.json")));
      const localFilesByCanvasId = new Map(manifest.filter((item) => item.status === "downloaded" || item.status === "reused").map((item) => [String(item.id), item] as const));

      for (const item of entries(await jsonFile(path.join(api, "files.json")))) {
        const title = text(item.display_name) ?? text(item.filename);
        if (title === null) continue;
        const id = resourceId(course.id, "file", item.id);
        resources.push({ id, courseId: course.id, courseCode: course.courseCode, type: "File", title, context: typeof item.size === "number" ? `${String(item.size)} bytes` : null, updatedAt: text(item.updated_at, 80), openPath: localFilesByCanvasId.has(String(item.id)) ? `/api/local/resources/${encodeURIComponent(id)}` : null });
      }
      for (const item of entries(await jsonFile(path.join(api, "pages.json")))) {
        const title = text(item.title); if (title === null) continue;
        resources.push({ id: resourceId(course.id, "page", item.page_id ?? item.url), courseId: course.id, courseCode: course.courseCode, type: "Page", title, context: "Canvas page", updatedAt: text(item.updated_at, 80), openPath: null });
      }
      for (const item of entries(await jsonFile(path.join(api, "modules.json")))) {
        const title = text(item.name); if (title === null) continue;
        resources.push({ id: resourceId(course.id, "module", item.id), courseId: course.id, courseCode: course.courseCode, type: "Module", title, context: typeof item.items_count === "number" ? `${String(item.items_count)} items` : null, updatedAt: null, openPath: null });
        for (const child of entries(item.items, 250).filter((candidate) => candidate.type === "ExternalUrl")) {
          const childTitle = text(child.title); if (childTitle === null) continue;
          resources.push({ id: resourceId(course.id, "link", child.id), courseId: course.id, courseCode: course.courseCode, type: "Link", title: childTitle, context: `In ${title}`, updatedAt: null, openPath: null });
        }
      }
      for (const item of entries(await jsonFile(path.join(api, "announcements.json")))) {
        const title = text(item.title); if (title === null) continue;
        resources.push({ id: resourceId(course.id, "announcement", item.id), courseId: course.id, courseCode: course.courseCode, type: "Announcement", title, context: "Course announcement", updatedAt: text(item.posted_at, 80), openPath: null });
      }
    }
    return resources.slice(0, 2_000).sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.title.localeCompare(right.title));
  }

  async refreshes(): Promise<readonly LocalRefresh[]> {
    const document = object(await jsonFile(path.join(this.#root, "coursework-refresh-history.json")));
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
    const inbox = object(await jsonFile(path.join(this.#root, "canvas-conversations.json")));
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

  async conversations(): Promise<LocalConversationSnapshot> {
    const document = object(await jsonFile(path.join(this.#root, "canvas-conversations.json")));
    if (document === null) return { status: "not_synced", generatedAt: null, conversations: [] };
    const conversations: NormalizedConversation[] = [];
    for (const item of entries(document.conversations, 500)) {
      const canvasConversationId = text(item.canvasConversationId, 128);
      const subject = text(item.subject, 240);
      if (canvasConversationId === null || subject === null || typeof item.unread !== "boolean" || typeof item.starred !== "boolean" || typeof item.messageCount !== "number") continue;
      const participants = entries(item.participants, 100).map((participant) => ({ canvasUserId: text(participant.canvasUserId, 128), name: text(participant.name, 120) })).filter((participant): participant is { canvasUserId: string; name: string } => participant.canvasUserId !== null && participant.name !== null);
      const attachments = entries(item.attachments, 2_000).map((attachment) => ({ name: text(attachment.name, 240), contentType: text(attachment.contentType, 120), sizeBytes: typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : null })).filter((attachment): attachment is ConversationAttachment => attachment.name !== null);
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
          attachments: entries(message.attachments, 250).map((attachment) => ({ name: text(attachment.name, 240), contentType: text(attachment.contentType, 120), sizeBytes: typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : null })).filter((attachment): attachment is ConversationAttachment => attachment.name !== null),
        };
      }).filter((message): message is ConversationMessage => message !== null);
      conversations.push({ canvasConversationId, contextLabel: text(item.contextLabel, 160), subject, participants, latestMessagePreview: text(item.latestMessagePreview, 280), latestMessageAt: text(item.latestMessageAt, 80), unread: item.unread, starred: item.starred, messageCount: Math.max(0, Math.min(100_000, Math.trunc(item.messageCount))), ...(messages.length > 0 ? { messages } : {}), ...(typeof item.historyComplete === "boolean" ? { historyComplete: item.historyComplete } : {}), ...(typeof item.safetyTruncated === "boolean" ? { safetyTruncated: item.safetyTruncated } : {}), attachments });
    }
    conversations.sort((left, right) => (right.latestMessageAt ?? "").localeCompare(left.latestMessageAt ?? ""));
    return { status: document.complete === true ? "synced" : "partial", generatedAt: text(document.generatedAt, 80), conversations };
  }

  async resolveLocalResource(resourceIdValue: string, courses: readonly LocalCourse[]): Promise<string | null> {
    const [courseId, type] = resourceIdValue.split(":", 3);
    if (type !== "file") return null;
    const course = courses.find((item) => item.id === courseId);
    const directory = courseDirectory(this.#root, course?.folder ?? null);
    if (course === undefined || directory === null) return null;
    const resources = await this.resources([course]);
    const resource = resources.find((item) => item.id === resourceIdValue && item.openPath !== null);
    if (resource === undefined) return null;
    const manifest = entries(await jsonFile(path.join(directory, "canvas-export", "download-manifest.json")));
    const marker = resourceIdValue.split(":").at(-1);
    const entry = manifest.find((item) => String(item.id) === marker && (item.status === "downloaded" || item.status === "reused"));
    const filename = text(entry?.filename, 180);
    if (filename === null || filename !== path.basename(filename)) return null;
    const materials = await realpath(path.join(directory, "materials")).catch(() => null);
    if (materials === null) return null;
    const candidate = await realpath(path.join(materials, filename)).catch(() => null);
    return candidate !== null && candidate.startsWith(`${materials}${path.sep}`) ? candidate : null;
  }
}
