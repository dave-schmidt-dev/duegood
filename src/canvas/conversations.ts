/**
 * Privacy-bounded projection of Canvas conversations for the local inbox.
 * Message bodies are inert plain text: executable markup is removed and only
 * credential-looking values are redacted. Ordinary visible text and URLs stay.
 */

const LIMITS = {
  attachmentName: 240,
  attachmentsPerMessage: 25,
  contextLabel: 160,
  conversationId: 128,
  messageBody: 1_000_000,
  messageCount: 100_000,
  messages: 2_000,
  participants: 100,
  participantName: 120,
  preview: 280,
  subject: 240,
} as const;

interface ConversationParticipant { readonly canvasUserId: string; readonly name: string }
export interface ConversationAttachment { readonly name: string; readonly contentType: string | null; readonly sizeBytes: number | null }
export interface ConversationMessage {
  readonly canvasMessageId: string | null;
  readonly authorId: string | null;
  readonly author: string;
  readonly createdAt: string | null;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly attachments: readonly ConversationAttachment[];
}
export interface NormalizedConversation {
  readonly canvasConversationId: string;
  readonly contextLabel: string | null;
  readonly subject: string;
  readonly participants: readonly ConversationParticipant[];
  readonly latestMessagePreview: string | null;
  readonly latestMessageAt: string | null;
  readonly unread: boolean;
  readonly starred: boolean;
  readonly messageCount: number;
  readonly messages?: readonly ConversationMessage[];
  /** False for legacy summary-only snapshots or when Canvas did not return all history. */
  readonly historyComplete?: boolean;
  /** True only when an explicit safety ceiling clipped content. */
  readonly safetyTruncated?: boolean;
  readonly attachments: readonly ConversationAttachment[];
}
type ConversationNormalizationFailure = "invalid_conversation" | "invalid_field" | "limit_exceeded";
export type ConversationNormalizationResult =
  | { readonly ok: true; readonly conversation: NormalizedConversation }
  | { readonly ok: false; readonly reason: ConversationNormalizationFailure };
interface ConversationChange { readonly before: NormalizedConversation; readonly after: NormalizedConversation }
export interface ConversationSnapshotDiff { readonly added: readonly NormalizedConversation[]; readonly changed: readonly ConversationChange[]; readonly removed: readonly NormalizedConversation[] }
interface MessageResult { readonly messages: readonly ConversationMessage[]; readonly safetyTruncated: boolean }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedText(value: unknown, maximumLength: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1).trimEnd()}…`;
}
function boundedId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 && normalized.length <= LIMITS.conversationId ? normalized : undefined;
}
function optionalBoolean(value: unknown, fallback: boolean): boolean | undefined { if (value === undefined || value === null) return fallback; return typeof value === "boolean" ? value : undefined; }
function optionalIsoTime(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 64) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
function decodeBasicEntities(value: string): string {
  return value.replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'");
}

/** Converts Canvas HTML to inert text while preserving ordinary visible content and URLs. */
function sanitizeBody(value: unknown): { readonly body: string; readonly truncated: boolean } | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  let body = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ");
  body = body.replace(/<\s*br\s*\/?>/giu, "\n").replace(/<\s*\/p\s*>/giu, "\n\n").replace(/<[^>]*>/gu, " ");
  body = decodeBasicEntities(body)
    .replace(/\b(access[_-]?token|auth(?:orization)?|bearer|token|password|secret)\s*[=:]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/([?&](?:access[_-]?token|auth(?:orization)?|bearer|token|password|secret)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/[ \t]+/gu, " ").replace(/[ \t]*\n[ \t]*/gu, "\n").trim();
  if (body.length <= LIMITS.messageBody) return { body, truncated: false };
  return { body: `${body.slice(0, LIMITS.messageBody - 1).trimEnd()}…`, truncated: true };
}
function messagePreview(value: unknown): string | null | undefined {
  const sanitized = sanitizeBody(value);
  if (sanitized === undefined || sanitized === null) return sanitized;
  return boundedText(sanitized.body, LIMITS.preview);
}
function normalizeParticipants(value: unknown): readonly ConversationParticipant[] | ConversationNormalizationFailure {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return "invalid_field";
  if (value.length > LIMITS.participants) return "limit_exceeded";
  const participants: ConversationParticipant[] = []; const seen = new Set<string>();
  for (const rawParticipant of value) {
    if (!isRecord(rawParticipant)) return "invalid_field";
    const canvasUserId = boundedId(rawParticipant.id);
    const name = boundedText(rawParticipant.name ?? rawParticipant.display_name, LIMITS.participantName);
    if (canvasUserId === undefined || name === undefined || name === null || name.length === 0) return "invalid_field";
    if (!seen.has(canvasUserId)) { participants.push({ canvasUserId, name }); seen.add(canvasUserId); }
  }
  return participants;
}
function normalizeAttachment(value: unknown): ConversationAttachment | ConversationNormalizationFailure {
  if (!isRecord(value)) return "invalid_field";
  const name = boundedText(value.display_name ?? value.filename ?? value.name, LIMITS.attachmentName);
  const contentType = boundedText(value["content-type"] ?? value.content_type, 120);
  const rawSize = value.size;
  if (name === undefined || name === null || name.length === 0 || contentType === undefined) return "invalid_field";
  if (rawSize !== undefined && rawSize !== null && (typeof rawSize !== "number" || !Number.isSafeInteger(rawSize) || rawSize < 0)) return "invalid_field";
  return { name, contentType, sizeBytes: rawSize === undefined || rawSize === null ? null : rawSize };
}
function messageAuthor(raw: Record<string, unknown>): { readonly id: string | null; readonly name: string } {
  const author = isRecord(raw.author) ? raw.author : isRecord(raw.sender) ? raw.sender : null;
  const id = boundedId(author?.id ?? raw.author_id ?? raw.sender_id) ?? null;
  const name = boundedText(author?.display_name ?? author?.name ?? raw.author_name ?? raw.sender_name, LIMITS.participantName) ?? "Canvas participant";
  return { id, name };
}
function normalizeMessages(value: unknown): MessageResult | ConversationNormalizationFailure {
  if (value === undefined || value === null) return { messages: [], safetyTruncated: false };
  if (!Array.isArray(value)) return "invalid_field";
  const safetyTruncated = value.length > LIMITS.messages; const messages: ConversationMessage[] = [];
  for (const rawValue of value.slice(0, LIMITS.messages)) {
    if (!isRecord(rawValue)) return "invalid_field";
    const body = sanitizeBody(rawValue.body ?? rawValue.message); const createdAt = optionalIsoTime(rawValue.created_at ?? rawValue.createdAt); const author = messageAuthor(rawValue);
    if (body === undefined || createdAt === undefined) return "invalid_field";
    const rawAttachments = rawValue.attachments;
    if (rawAttachments !== undefined && rawAttachments !== null && !Array.isArray(rawAttachments)) return "invalid_field";
    if (Array.isArray(rawAttachments) && rawAttachments.length > LIMITS.attachmentsPerMessage) return "limit_exceeded";
    const attachments: ConversationAttachment[] = [];
    for (const rawAttachment of rawAttachments ?? []) { const attachment = normalizeAttachment(rawAttachment); if (typeof attachment === "string") return attachment; attachments.push(attachment); }
    messages.push({ canvasMessageId: boundedId(rawValue.id) ?? null, authorId: author.id, author: author.name, createdAt, body: body?.body ?? "", bodyTruncated: body?.truncated ?? false, attachments });
  }
  return { messages, safetyTruncated: safetyTruncated || messages.some((message) => message.bodyTruncated) };
}
function newestMessage(messages: readonly ConversationMessage[]): ConversationMessage | undefined { return [...messages].sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))[0]; }

/** Normalizes one Canvas conversation-detail payload without retaining source URLs or markup. */
export function normalizeCanvasConversation(value: unknown): ConversationNormalizationResult {
  if (!isRecord(value)) return { ok: false, reason: "invalid_conversation" };
  const canvasConversationId = boundedId(value.id); if (canvasConversationId === undefined) return { ok: false, reason: "invalid_conversation" };
  const contextLabel = boundedText(value.context_name, LIMITS.contextLabel); const subject = boundedText(value.subject, LIMITS.subject); const participants = normalizeParticipants(value.participants); const messageResult = normalizeMessages(value.messages);
  const lastMessageAt = optionalIsoTime(value.last_message_at); const lastMessagePreview = messagePreview(value.last_message); const starred = optionalBoolean(value.starred, false); const rawCount = value.message_count;
  const messageCount = rawCount === undefined || rawCount === null ? (Array.isArray(value.messages) ? value.messages.length : 0) : rawCount;
  if (contextLabel === undefined || subject === undefined || typeof participants === "string" || typeof messageResult === "string" || lastMessageAt === undefined || lastMessagePreview === undefined || starred === undefined || !Number.isSafeInteger(messageCount) || (messageCount as number) < 0 || (messageCount as number) > LIMITS.messageCount) return { ok: false, reason: typeof participants === "string" ? participants : typeof messageResult === "string" ? messageResult : "invalid_field" };
  const workflowState = value.workflow_state;
  if (workflowState !== undefined && workflowState !== "read" && workflowState !== "unread" && workflowState !== "archived") return { ok: false, reason: "invalid_field" };
  const rawMessages = messageResult.messages; const summaryOnly = !Array.isArray(value.messages);
  const fallback = sanitizeBody(value.last_message);
  const messages = rawMessages.length > 0 || !summaryOnly ? rawMessages : [{ canvasMessageId: null, authorId: null, author: "Canvas participant", createdAt: lastMessageAt, body: fallback?.body ?? "", bodyTruncated: fallback?.truncated ?? false, attachments: [] }];
  const newest = newestMessage(messages); const safetyTruncated = messageResult.safetyTruncated || messages.some((message) => message.bodyTruncated);
  return { ok: true, conversation: { canvasConversationId, contextLabel, subject: subject ?? "(No subject)", participants, latestMessagePreview: lastMessagePreview ?? newest?.body.slice(0, LIMITS.preview) ?? null, latestMessageAt: lastMessageAt ?? newest?.createdAt ?? null, unread: workflowState === "unread", starred, messageCount: messageCount as number, messages, historyComplete: !summaryOnly && !safetyTruncated && (rawCount === undefined || rawCount === null || (messageCount as number) <= messages.length), safetyTruncated, attachments: messages.flatMap((message) => message.attachments) } };
}
function sameConversation(left: NormalizedConversation, right: NormalizedConversation): boolean { return JSON.stringify(left) === JSON.stringify(right); }
export function diffConversationSnapshots(previous: readonly NormalizedConversation[], current: readonly NormalizedConversation[], complete: boolean): ConversationSnapshotDiff {
  const previousById = new Map(previous.map((conversation) => [conversation.canvasConversationId, conversation])); const currentById = new Map(current.map((conversation) => [conversation.canvasConversationId, conversation])); const added: NormalizedConversation[] = []; const changed: ConversationChange[] = [];
  for (const conversation of current) { const before = previousById.get(conversation.canvasConversationId); if (before === undefined) added.push(conversation); else if (!sameConversation(before, conversation)) changed.push({ before, after: conversation }); }
  return { added, changed, removed: complete ? previous.filter((conversation) => !currentById.has(conversation.canvasConversationId)) : [] };
}
