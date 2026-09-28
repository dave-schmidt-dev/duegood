import {
  type DashboardConversation,
  type DashboardMessage,
  type DashboardAttachment,
  type DashboardCourse,
  type DashboardGradeGroup,
  type DashboardData,
  type DashboardEvent,
  type DashboardRefresh,
  type DashboardRefreshChange,
  type DashboardResource,
  type DashboardSourceStatus,
  type DashboardProfile,
  type DashboardPendingSourceLink,
  safeLocalHref,
} from "./pages/dashboard";

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
    notes: typeof item.notes === "string" ? item.notes : null,
    completed: item.completed === true, completedAt: typeof item.completedAt === "number" ? item.completedAt : null,
    ...(optionalText(item.submissionState) === undefined ? {} : { submissionState: optionalText(item.submissionState) }),
    source: typeof item.source === "string" ? item.source : null,
    points: nullableNumeric(item.points),
    score: nullableNumeric(item.score),
    grade: typeof item.grade === "string" ? item.grade : null,
    manualGrade: typeof item.manualGrade === "string" ? item.manualGrade : null,
    manualGradeVersion: item.manualGradeVersion === 1 ? 1 : null,
    manualGradeSource: item.manualGradeSource === "pdf" ? "pdf" : typeof item.manualGrade === "string" ? "manual" : null,
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

function sourceValue(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && encoded.length <= 1_000 ? encoded : undefined;
  } catch { return undefined; }
}

function parsePendingSourceLink(value: unknown): DashboardPendingSourceLink | undefined {
  const item = record(value); const reference = record(item.reference);
  const id = text(item.id); const localId = text(item.localId); const courseId = text(item.course);
  const source = text(reference.source); const referenceId = text(reference.id); const institution = text(reference.institution); const referenceCourse = text(reference.course);
  if (id.length === 0 || id.length > 1_000 || (localId.length === 0 && item.needsRefresh !== true) || courseId.length === 0 || (source !== "canvas" && source !== "ical") || referenceId.length === 0 || institution.length === 0 || referenceCourse !== courseId) return undefined;
  const candidates = rows(item.candidateIds).filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0 && candidate.length <= 160);
  if (candidates.length > 20 || new Set(candidates).size !== candidates.length) return undefined;
  const fields: Record<string, string> = {};
  for (const [name, fieldValue] of Object.entries(record(item.fields))) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name)) return undefined;
    const rendered = sourceValue(fieldValue); if (rendered === undefined) return undefined;
    fields[name] = rendered;
  }
  const reason = item.reason === "ambiguous-match" || item.reason === "conflicting-match" ? item.reason : undefined;
  if (reason === undefined) return undefined;
  const observedAt = typeof item.observedAt === "string" && Number.isFinite(Date.parse(item.observedAt)) ? item.observedAt : undefined;
  return { id, localId, courseId, reference: { source, id: referenceId, institution, course: referenceCourse, ...(optionalText(reference.instance) === undefined ? {} : { instance: optionalText(reference.instance) }) }, fields, ...(observedAt === undefined ? {} : { observedAt }), candidateIds: candidates, reason, ...(item.needsRefresh === true ? { needsRefresh: true } : {}) };
}

export function parseDashboard(value: unknown): DashboardData {
  const body = record(value); const source = record(body.sourceStatus);
  const sourceStatus: DashboardSourceStatus = { ...(optionalText(source.state) === undefined ? {} : { state: optionalText(source.state) }), ...(optionalText(source.label) === undefined ? {} : { label: optionalText(source.label) }), ...(optionalText(source.detail) === undefined ? {} : { detail: optionalText(source.detail) }), ...(timestamp(source.lastRefreshAt) === undefined ? {} : { lastRefreshAt: timestamp(source.lastRefreshAt) }) };
  return {
    version: typeof body.version === "string" ? body.version : typeof body.version === "number" && Number.isFinite(body.version) ? String(body.version) : "",
    courses: rows(body.courses).map(parseCourse).filter((item): item is DashboardCourse => item !== undefined),
    events: rows(body.events).map(parseEvent).filter((item): item is DashboardEvent => item !== undefined),
    pendingSourceLinks: rows(body.pendingSourceLinks).map(parsePendingSourceLink).filter((item): item is DashboardPendingSourceLink => item !== undefined),
    resources: rows(body.resources).map(parseResource).filter((item): item is DashboardResource => item !== undefined),
    conversations: rows(body.conversations).map(parseConversation).filter((item): item is DashboardConversation => item !== undefined),
    refreshes: rows(body.refreshes).map(parseRefresh).filter((item): item is DashboardRefresh => item !== undefined),
    profile: parseProfile(body.profile),
    refreshAvailable: body.refreshAvailable === true,
    sourceStatus,
  };
}
