import { diffConversationSnapshots, normalizeCanvasConversation, type ConversationSnapshotDiff, type NormalizedConversation } from "./conversations.ts";

export interface ConversationSyncResult {
  readonly complete: boolean;
  readonly conversations: readonly NormalizedConversation[];
  readonly rejected: number;
}

export interface StoredConversationSnapshot extends ConversationSyncResult {
  readonly generatedAt: string;
  readonly changes: ConversationSnapshotDiff;
}

interface SyncOptions {
  readonly origin: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
  readonly onStatus?: (message: string) => void;
  readonly maxPages?: number;
  readonly maxConversations?: number;
}

const CANVAS_PAGE_SIZE = 100;

/** Revalidates a prior private snapshot and drops every unrecognized field. */
export function sanitizeStoredConversations(value: unknown): readonly NormalizedConversation[] {
  if (!Array.isArray(value)) return [];
  const output: NormalizedConversation[] = [];
  for (const item of value.slice(0, 500)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const participants = Array.isArray(source.participants) ? source.participants.slice(0, 100).map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      return { id: record.canvasUserId, name: record.name };
    }).filter((entry) => entry !== null) : [];
    const messages = Array.isArray(source.messages) ? source.messages.slice(0, 2_000).map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      return {
        id: record.canvasMessageId,
        author_id: record.authorId,
        author_name: record.author,
        created_at: record.createdAt,
        body: record.body,
        attachments: Array.isArray(record.attachments) ? record.attachments.map((attachment) => {
          if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) return null;
          const attachmentRecord = attachment as Record<string, unknown>;
          return { display_name: attachmentRecord.name, content_type: attachmentRecord.contentType, size: attachmentRecord.sizeBytes };
        }).filter((attachment) => attachment !== null) : [],
      };
    }).filter((entry) => entry !== null) : undefined;
    const normalized = normalizeCanvasConversation({
      id: source.canvasConversationId,
      context_name: source.contextLabel,
      subject: source.subject,
      participants,
      last_message: source.latestMessagePreview,
      last_message_at: source.latestMessageAt,
      workflow_state: source.unread === true ? "unread" : "read",
      starred: source.starred,
      message_count: source.messageCount,
      ...(messages === undefined ? {} : { messages }),
      ...(messages === undefined && source.latestMessagePreview === undefined ? { last_message: null } : {}),
    });
    if (normalized.ok) output.push(normalized.conversation);
  }
  return output;
}

function nextLink(header: string | null, origin: URL): URL | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/u.exec(part);
    if (match === null) continue;
    const target = match[1];
    if (target === undefined) continue;
    const candidate = new URL(target, origin);
    if (candidate.origin !== origin.origin || !candidate.pathname.startsWith("/api/v1/conversations")) throw new Error("unsafe Canvas pagination link");
    return candidate;
  }
  return null;
}

async function canvasJson(fetcher: typeof fetch, url: URL, token: string): Promise<{ body: unknown; next: URL | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`Canvas request failed with status ${String(response.status)}`);
    return { body: await response.json() as unknown, next: nextLink(response.headers.get("link"), url) };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches the read-only Canvas inbox without changing read/archive state. */
export async function fetchCanvasConversations(options: SyncOptions): Promise<ConversationSyncResult> {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:") throw new Error("Canvas origin must use HTTPS");
  const fetcher = options.fetcher ?? fetch;
  const maxPages = options.maxPages ?? 10;
  const maxConversations = options.maxConversations ?? 500;
  const summaries: Record<string, unknown>[] = [];
  let url: URL | null = new URL(`/api/v1/conversations?scope=inbox&per_page=${String(CANVAS_PAGE_SIZE)}`, origin);
  let complete = true;

  for (let page = 1; url !== null && page <= maxPages; page += 1) {
    options.onStatus?.(`Loading inbox page ${String(page)}`);
    const response = await canvasJson(fetcher, url, options.token);
    if (!Array.isArray(response.body)) throw new Error("Canvas conversations response was not an array");
    const pageWasFull = response.body.length >= CANVAS_PAGE_SIZE;
    for (const value of response.body) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      if (summaries.length >= maxConversations) { complete = false; break; }
      summaries.push(value as Record<string, unknown>);
    }
    if (summaries.length >= maxConversations) {
      complete = false;
      break;
    }
    url = response.next;
    if (page === maxPages && (url !== null || pageWasFull)) complete = false;
  }

  const conversations: NormalizedConversation[] = [];
  let rejected = 0;
  for (const [index, summary] of summaries.entries()) {
    const id = typeof summary.id === "string" || typeof summary.id === "number" ? String(summary.id) : null;
    if (id === null || id.length > 128) { rejected += 1; complete = false; continue; }
    options.onStatus?.(`Loading inbox thread ${String(index + 1)} of ${String(summaries.length)}`);
    try {
      const detailUrl = new URL(`/api/v1/conversations/${encodeURIComponent(id)}?auto_mark_as_read=false`, origin);
      const detail = await canvasJson(fetcher, detailUrl, options.token);
      const normalized = normalizeCanvasConversation(detail.body);
      if (!normalized.ok) { rejected += 1; complete = false; continue; }
      conversations.push(normalized.conversation);
    } catch {
      rejected += 1;
      complete = false;
    }
  }
  conversations.sort((left, right) => (right.latestMessageAt ?? "").localeCompare(left.latestMessageAt ?? ""));
  return { complete, conversations, rejected };
}

/** Preserves unseen prior threads whenever the incoming fetch is incomplete. */
export function buildStoredConversationSnapshot(previous: readonly NormalizedConversation[], result: ConversationSyncResult, now = new Date()): StoredConversationSnapshot {
  const currentIds = new Set(result.conversations.map((item) => item.canvasConversationId));
  const conversations = result.complete ? [...result.conversations] : [...result.conversations, ...previous.filter((item) => !currentIds.has(item.canvasConversationId))];
  conversations.sort((left, right) => (right.latestMessageAt ?? "").localeCompare(left.latestMessageAt ?? ""));
  return { generatedAt: now.toISOString(), complete: result.complete, rejected: result.rejected, conversations, changes: diffConversationSnapshots(previous, result.conversations, result.complete) };
}
