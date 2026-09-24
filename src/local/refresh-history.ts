import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;

const MAX_EVENTS = 100;
const MAX_CHANGES = 500;
const MAX_RECOVERY_ITEMS = 100;
const MAX_FIELDS = 20;
const MAX_TEXT = 280;
const TRACKED_FIELDS = [
  "title",
  "at",
  "points",
  "submissionState",
  "gradedAt",
  "grade",
  "score",
  "assignmentGroupId",
  "assignmentGroupName",
  "assignmentGroupWeight",
] as const;
const GRADE_FIELDS = ["submissionState", "gradedAt", "grade", "score"] as const;

type TrackedField = typeof TRACKED_FIELDS[number];

interface CanvasItemSnapshot {
  readonly id: string;
  readonly course: string | null;
  readonly fields: Readonly<Record<TrackedField, string | number | null>>;
}

export interface CanvasSnapshot {
  readonly version: string;
  readonly sourceComplete: boolean;
  readonly items: readonly CanvasItemSnapshot[];
}

interface RefreshHistoryField {
  readonly field: string;
  readonly before: string | number | null;
  readonly after: string | number | null;
}

export interface RefreshHistoryChange {
  readonly kind: "added" | "changed" | "removed" | "notice";
  readonly itemId?: string;
  readonly title?: string;
  readonly course?: string | null;
  readonly fields?: readonly RefreshHistoryField[];
  readonly detail?: string;
}

export interface RefreshHistoryEvent {
  readonly schema: 1;
  readonly id: string;
  readonly status: "succeeded" | "incomplete" | "failed";
  readonly sourceComplete?: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly summary: { readonly added: number; readonly updated: number; readonly removed: number };
  readonly changes: readonly RefreshHistoryChange[];
  readonly error?: string;
  readonly recovery?: "recovery-v1" | "history-corrupt-v1";
  /** Internal one-refresh marker for a recovered history file. */
  readonly pending?: boolean;
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length === 0 ? null : clean.slice(0, max);
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function value(value: unknown): string | number | null {
  return typeof value === "string" ? text(value) : number(value);
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceComplete(document: JsonObject): boolean {
  const sync = typeof document.sync === "object" && document.sync !== null && !Array.isArray(document.sync) ? document.sync as JsonObject : null;
  return sync?.status === undefined || sync?.status === "complete" || sync?.status === "succeeded";
}

function submissionState(item: JsonObject): string | null {
  return text(item.submissionState) ?? text(item.submissionStatus) ?? text(item.status);
}

function trackedFields(item: JsonObject): Readonly<Record<TrackedField, string | number | null>> {
  return {
    title: text(item.title),
    at: text(item.at) ?? text(item.dueAt),
    points: number(item.points),
    submissionState: submissionState(item),
    gradedAt: text(item.gradedAt),
    grade: value(item.grade),
    score: number(item.score),
    assignmentGroupId: text(item.assignmentGroupId),
    assignmentGroupName: text(item.assignmentGroupName),
    assignmentGroupWeight: number(item.assignmentGroupWeight),
  };
}

function hasSourceCoverage(item: JsonObject): boolean {
  if (Array.isArray(item.sourceReferences)) {
    return item.sourceReferences.some((candidate) => {
      const reference = optionalObject(candidate);
      return reference?.source === "canvas" || reference?.source === "ical";
    });
  }
  // Legacy documents do not yet have scoped references; retain their existing Activity coverage.
  return item.source === "canvas" || item.canvasId != null;
}

/** Captures source-covered fields; local completion, notes, and provenance bookkeeping never enter the snapshot. */
export async function captureCanvasSnapshot(file: string): Promise<CanvasSnapshot> {
  const bytes = await readFile(file);
  const rawBytes = Buffer.from(bytes);
  const document = object(JSON.parse(rawBytes.toString("utf8")), "coursework document");
  if (!Array.isArray(document.items)) throw new Error("coursework items must be an array");
  const items: CanvasItemSnapshot[] = [];
  for (const [index, candidate] of document.items.entries()) {
    const item = object(candidate, `coursework items[${index}]`);
    const id = text(item.id, 160);
    if (id === null) continue;
    if (!hasSourceCoverage(item)) continue;
    items.push({ id, course: text(item.course, 160), fields: trackedFields(item) });
  }
  items.sort((left, right) => left.id.localeCompare(right.id));
  return { version: hash(rawBytes), sourceComplete: sourceComplete(document), items };
}

function changedFields(before: CanvasItemSnapshot | undefined, after: CanvasItemSnapshot | undefined): RefreshHistoryField[] {
  return TRACKED_FIELDS.flatMap((field) => {
    const beforeValue = before?.fields[field] ?? null;
    const afterValue = after?.fields[field] ?? null;
    return Object.is(beforeValue, afterValue) ? [] : [{ field, before: beforeValue, after: afterValue }];
  });
}

function label(item: CanvasItemSnapshot | undefined): string {
  const title = item?.fields.title;
  return typeof title === "string" && title.length > 0 ? title : item?.id ?? "Canvas item";
}

/** Produces bounded item-level changes, including grade-only changes. */
export function diffCanvasSnapshots(before: CanvasSnapshot, after: CanvasSnapshot): { readonly added: number; readonly updated: number; readonly removed: number; readonly changes: readonly RefreshHistoryChange[] } {
  const beforeById = new Map(before.items.map((item) => [item.id, item]));
  const afterById = new Map(after.items.map((item) => [item.id, item]));
  const changes: RefreshHistoryChange[] = [];
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const item of after.items) {
    const prior = beforeById.get(item.id);
    if (prior === undefined) {
      added += 1;
      changes.push({ kind: "added", itemId: item.id, title: label(item), course: item.course });
      continue;
    }
    const fields = changedFields(prior, item);
    if (fields.length > 0) {
      updated += 1;
      changes.push({ kind: "changed", itemId: item.id, title: label(item), course: item.course, fields: fields.slice(0, MAX_FIELDS) });
    }
  }
  if (after.sourceComplete) {
    for (const item of before.items) {
      if (afterById.has(item.id)) continue;
      removed += 1;
      changes.push({ kind: "removed", itemId: item.id, title: label(item), course: item.course });
    }
  }
  return { added, updated, removed, changes: changes.slice(0, MAX_CHANGES) };
}

async function readHistory(file: string): Promise<JsonObject> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, events: [] };
    throw error;
  }
  try {
    const document = object(JSON.parse(raw), "refresh history");
    if (document.schema !== undefined && document.schema !== 1) throw new Error("refresh history schema is unsupported");
    if (document.events !== undefined && !Array.isArray(document.events)) throw new Error("refresh history events must be an array");
    return document;
  } catch (error) {
    const quarantine = `${file}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    await rename(file, quarantine);
    const recoveredAt = new Date().toISOString();
    const recoveredDocument: JsonObject = {
      schema: 1,
      events: [{
        schema: 1,
        id: `refresh-history-recovery-v1-${recoveredAt}-${randomUUID().slice(0, 8)}`,
        recovery: "history-corrupt-v1",
        pending: true,
        status: "incomplete",
        sourceComplete: false,
        startedAt: recoveredAt,
        finishedAt: recoveredAt,
        summary: { added: 0, updated: 0, removed: 0 },
        changes: [{
          kind: "notice",
          title: "Refresh history recovered",
          detail: "The previous refresh history was unreadable and was preserved locally. History is incomplete until a later full refresh establishes a new baseline.",
        }],
        error: error instanceof Error ? text(error.message) ?? "Refresh history was unreadable" : "Refresh history was unreadable",
      }],
    };
    await writeAtomic(file, recoveredDocument);
    return recoveredDocument;
  }
}

async function writeAtomic(file: string, document: JsonObject): Promise<void> {
  const output = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(output);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
}

async function appendEvent(root: string, event: RefreshHistoryEvent): Promise<RefreshHistoryEvent> {
  const file = path.join(root, "coursework-refresh-history.json");
  const document = await readHistory(file);
  const events = Array.isArray(document.events) ? document.events : [];
  const historyWasRecovered = events.some((candidate) => {
    const entry = optionalObject(candidate);
    return entry?.recovery === "history-corrupt-v1" && entry.pending === true;
  });
  const safeEvent = historyWasRecovered && event.status === "succeeded"
    ? { ...event, status: "incomplete" as const, sourceComplete: false }
    : event;
  const clearedEvents = historyWasRecovered
    ? events.map((candidate) => {
      const entry = optionalObject(candidate);
      return entry?.recovery === "history-corrupt-v1" && entry.pending === true ? { ...entry, pending: false } : candidate;
    })
    : events;
  await writeAtomic(file, { ...document, schema: 1, events: [...clearedEvents, safeEvent].slice(-MAX_EVENTS) });
  return safeEvent;
}

function validTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Repairs one known legacy gap without inventing a complete before/after diff.
 * The marker makes this idempotent across later refreshes.
 */
export async function recoverMissedGradeHistory(root: string, current: CanvasSnapshot, finishedAt = new Date().toISOString()): Promise<RefreshHistoryEvent | null> {
  const file = path.join(root, "coursework-refresh-history.json");
  const document = await readHistory(file);
  const events = Array.isArray(document.events) ? document.events : [];
  if (events.some((candidate) => optionalObject(candidate)?.recovery === "recovery-v1")) return null;
  const boundary = events.reduce<number | null>((latest, candidate) => {
    const entry = optionalObject(candidate);
    const timestamp = entry?.status === "succeeded" && entry.sourceComplete === true ? validTimestamp(entry.finishedAt) : null;
    return timestamp === null || (latest !== null && timestamp <= latest) ? latest : timestamp;
  }, null);
  if (boundary === null) return null;
  const candidates = current.items.filter((item) => {
    const gradedAt = validTimestamp(item.fields.gradedAt);
    if (gradedAt === null || gradedAt <= boundary) return false;
    return item.fields.submissionState === "graded" || item.fields.grade !== null || item.fields.score !== null;
  }).slice(0, MAX_RECOVERY_ITEMS);
  if (candidates.length === 0) return null;
  const changes: RefreshHistoryChange[] = [
    { kind: "notice", title: "Earlier grade history recovered", detail: "An earlier Due Good refresh omitted item-level history; these current Canvas grade fields are shown without claiming a complete before/after diff." },
    ...candidates.map((item): RefreshHistoryChange => ({
      kind: "changed",
      itemId: item.id,
      title: label(item),
      course: item.course,
      fields: GRADE_FIELDS.map((field) => ({ field, before: null, after: item.fields[field] })),
    })),
  ];
  const event: RefreshHistoryEvent = {
    schema: 1,
    id: `refresh-recovery-v1-${finishedAt}-${randomUUID().slice(0, 8)}`,
    recovery: "recovery-v1",
    status: "incomplete",
    sourceComplete: false,
    startedAt: finishedAt,
    finishedAt,
    summary: { added: 0, updated: candidates.length, removed: 0 },
    changes,
  };
  return appendEvent(root, event);
}

export async function recordRefreshSuccess(root: string, before: CanvasSnapshot, after: CanvasSnapshot, startedAt: string, finishedAt: string): Promise<RefreshHistoryEvent> {
  const diff = diffCanvasSnapshots(before, after);
  const event: RefreshHistoryEvent = {
    schema: 1,
    id: `refresh-${finishedAt}-${randomUUID().slice(0, 8)}`,
    status: after.sourceComplete ? "succeeded" : "incomplete",
    ...(after.sourceComplete ? { sourceComplete: true } : { sourceComplete: false }),
    startedAt,
    finishedAt,
    summary: { added: diff.added, updated: diff.updated, removed: after.sourceComplete ? diff.removed : 0 },
    changes: diff.changes,
  };
  return appendEvent(root, event);
}

export async function recordRefreshFailure(root: string, startedAt: string, finishedAt: string, error: unknown): Promise<RefreshHistoryEvent> {
  const detail = text(error instanceof Error ? error.message : error) ?? "Refresh failed";
  const event: RefreshHistoryEvent = {
    schema: 1,
    id: `refresh-${finishedAt}-${randomUUID().slice(0, 8)}`,
    status: "failed",
    startedAt,
    finishedAt,
    summary: { added: 0, updated: 0, removed: 0 },
    changes: [{ kind: "notice", title: "Canvas refresh failed", detail }],
    error: detail,
  };
  return appendEvent(root, event);
}

/** Content-free receipt for a rolling-window calendar acquisition, distinct from Canvas inventory. */
export interface IcalFeedStatus {
  readonly schema: 1;
  readonly acquisition: "succeeded" | "failed";
  readonly coverage: "rolling_window";
  readonly attemptedAt: string;
  readonly lastSuccessAt: string | null;
  readonly accepted: number;
  readonly held: number;
}

/** Reads only the bounded calendar acquisition receipt; a damaged receipt grants no coverage. */
export async function readIcalFeedStatus(root: string): Promise<IcalFeedStatus | null> {
  let raw: string;
  try { raw = await readFile(path.join(root, "coursework-ical-feed-status.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (Buffer.byteLength(raw) > 4_096) return null;
  try {
    const value = object(JSON.parse(raw), "calendar feed status");
    if (value.schema !== 1 || (value.acquisition !== "succeeded" && value.acquisition !== "failed")
        || value.coverage !== "rolling_window" || typeof value.attemptedAt !== "string"
        || (value.lastSuccessAt !== null && typeof value.lastSuccessAt !== "string")
        || !Number.isInteger(value.accepted) || !Number.isInteger(value.held)) return null;
    return value as unknown as IcalFeedStatus;
  } catch { return null; }
}

/** Atomically replaces the content-free calendar receipt under the coursework writer lock. */
export async function recordIcalFeedStatus(root: string, status: IcalFeedStatus): Promise<void> {
  if (status.schema !== 1 || status.coverage !== "rolling_window"
      || !Number.isInteger(status.accepted) || status.accepted < 0
      || !Number.isInteger(status.held) || status.held < 0) throw new Error("invalid calendar feed status");
  await writeAtomic(path.join(root, "coursework-ical-feed-status.json"), status as unknown as JsonObject);
}

/** Records visible calendar changes in Activity without claiming full Canvas inventory coverage. */
export async function recordIcalImport(root: string, before: CanvasSnapshot, after: CanvasSnapshot, startedAt: string, finishedAt: string): Promise<RefreshHistoryEvent | null> {
  const diff = diffCanvasSnapshots(before, { ...after, sourceComplete: false });
  if (diff.added === 0 && diff.updated === 0) return null;
  const event: RefreshHistoryEvent = {
    schema: 1,
    id: `ical-import-${finishedAt}-${randomUUID().slice(0, 8)}`,
    status: "incomplete",
    sourceComplete: false,
    startedAt,
    finishedAt,
    summary: { added: diff.added, updated: diff.updated, removed: 0 },
    changes: [
      { kind: "notice" as const, title: "Calendar feed import", detail: "A rolling-window feed updated local coursework; absence never removes an item." },
      ...diff.changes.filter((change) => change.kind !== "removed"),
    ].slice(0, MAX_CHANGES),
  };
  return appendEvent(root, event);
}
