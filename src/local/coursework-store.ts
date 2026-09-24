import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssignmentListItem } from "../db/types";
import { applySourceObservations, pendingSourceLinks, resolvePendingSourceLink, validateSourceReferences, type AcquisitionResult, type PendingLinkDecision, type PendingSourceLink, type SourceObservation } from "./acquisition";
import type { IcalNormalization } from "./ical";
import { captureCanvasSnapshot, readIcalFeedStatus, recordIcalFeedStatus, recordIcalImport, type IcalFeedStatus } from "./refresh-history";

type JsonObject = Record<string, unknown>;

export interface LocalCourse {
  readonly id: string;
  readonly courseCode: string | null;
  readonly title: string | null;
  readonly color: string | null;
  readonly folder: string | null;
  readonly lastSuccessfulCheckAt: number | null;
  readonly gradeGroups?: readonly LocalGradeGroup[];
  readonly syncing: false;
}

interface LocalGradeGroup {
  readonly id: string | null;
  readonly name: string | null;
  readonly weight: number | null;
}

interface LocalGradeRecord extends AssignmentListItem {
  /** Provenance label from the local coursework source. */
  readonly source: string | null;
  /** Canvas points possible. Null means Canvas did not return a numeric value. */
  readonly points: number | null;
  /** Canvas score earned. Null means Canvas did not return a numeric value. */
  readonly score: number | null;
  /** Canvas grade/letter value, when supplied. */
  readonly grade: string | null;
  /** Deliberate local observation, stored apart from all Canvas grade facts. */
  readonly manualGrade: string | null;
  /** Schema version of the local observation; null means no observation exists. */
  readonly manualGradeVersion: 1 | null;
  readonly manualGradeSource: "manual" | "pdf" | null;
  /** Canvas grading timestamp, when supplied. */
  readonly gradedAt: string | null;
  /** Canvas assignment-group identity and weight, when supplied. */
  readonly assignmentGroupId: string | null;
  readonly assignmentGroupName: string | null;
  readonly assignmentGroupWeight: number | null;
}

interface LocalTimelineEvent extends LocalGradeRecord {
  readonly type: "deadline" | "class";
  /** Original coursework kind; this remains distinct from the display type. */
  readonly kind: string | null;
  readonly detail: string | null;
  readonly place: string | null;
  /** Local planning note; never source-writable. */
  readonly notes: string | null;
  /** Local discussion workflow state, independent from Canvas submission and completion. */
  readonly discussionPostDone: boolean;
  readonly discussionRepliesDone: boolean;
}

export interface LocalSnapshot {
  readonly version: string;
  readonly courses: readonly LocalCourse[];
  readonly assignments: readonly LocalGradeRecord[];
  readonly events: readonly LocalTimelineEvent[];
  readonly pendingSourceLinks: readonly PendingSourceLink[];
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface ManualGradeObservation {
  readonly version: 1;
  readonly value: string;
  readonly source: "manual" | "pdf";
}

/** Validate the intentionally small local grade record without accepting source-owned facts. */
function manualGradeObservation(value: unknown, label: string): ManualGradeObservation | null {
  if (value === undefined) return null;
  const observation = object(value, label);
  if (observation.version !== 1 || typeof observation.value !== "string" || observation.value.trim().length === 0 || observation.value.trim().length > 80) {
    throw new Error(`${label} must contain version 1 and a nonempty value up to 80 characters`);
  }
  if (observation.source !== undefined && observation.source !== "manual" && observation.source !== "pdf") throw new Error(`${label} has an invalid source`);
  return { version: 1, value: observation.value.trim(), source: observation.source === "pdf" ? "pdf" : "manual" };
}

function gradeGroups(value: unknown): readonly LocalGradeGroup[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => {
    const group = object(candidate, "course.gradeGroups entry");
    return { id: stringOrNull(group.id), name: stringOrNull(group.name), weight: numberOrNull(group.weight) };
  });
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type DiscussionProgressField = "discussionPostDone" | "discussionRepliesDone";
type DiscussionProgress = Pick<LocalTimelineEvent, "discussionPostDone" | "discussionRepliesDone">;

const LOCK_STALE_AFTER_MS = 30_000;

interface LockOwner {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
}

function ownerFile(lockDirectory: string): string {
  return path.join(lockDirectory, "owner.json");
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function staleLock(lockDirectory: string): Promise<boolean> {
  let metadata: LockOwner | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(ownerFile(lockDirectory), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const candidate = parsed as Record<string, unknown>;
      if (typeof candidate.pid === "number" && typeof candidate.token === "string" && typeof candidate.createdAt === "number") {
        metadata = { pid: candidate.pid, token: candidate.token, createdAt: candidate.createdAt };
      }
    }
  } catch {}
  if (metadata !== null) return !processAlive(metadata.pid);
  try {
    const details = await stat(lockDirectory);
    return Date.now() - details.mtimeMs >= LOCK_STALE_AFTER_MS || metadata !== null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function releaseLock(lockDirectory: string, token: string): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ownerFile(lockDirectory), "utf8"));
    if (typeof parsed !== "object" || parsed === null || (parsed as Record<string, unknown>).token !== token) return;
    await rm(ownerFile(lockDirectory), { force: true });
    await rmdir(lockDirectory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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

function validateAndProject(document: JsonObject): Omit<LocalSnapshot, "version"> {
  const rawCourses = array(document.courses, "courses");
  const rawItems = array(document.items, "items");
  const coursesByKey = new Map<string, LocalCourse>();
  for (const [index, value] of rawCourses.entries()) {
    const course = object(value, `courses[${index}]`);
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
  for (const [index, value] of rawItems.entries()) {
    const item = object(value, `items[${index}]`);
    if (typeof item.id !== "string" || item.id.length === 0) throw new Error(`items[${index}].id must be a nonempty string`);
    if (ids.has(item.id)) throw new Error(`duplicate item id: ${item.id}`);
    ids.add(item.id);
    if (typeof item.course !== "string" || !coursesByKey.has(item.course)) throw new Error(`item ${item.id} references an unknown course`);
    const course = coursesByKey.get(item.course) as LocalCourse;
    if (item.kind === "milestone") continue;
    const localGrade = manualGradeObservation(item.manualGradeObservation, `item ${item.id}.manualGradeObservation`);
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
      manualGrade: localGrade?.value ?? null,
      manualGradeVersion: localGrade?.version ?? null,
      manualGradeSource: localGrade?.source ?? null,
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
      notes: stringOrNull(item.notes),
      discussionPostDone: item.discussionPostDone === true,
      discussionRepliesDone: item.discussionRepliesDone === true,
    };
    events.push(event);
    if (event.type === "deadline") assignments.push(projected);
  }
  validateSourceReferences(document);
  assignments.sort((left, right) => (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999"));
  events.sort((left, right) => (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999"));
  return { courses: [...coursesByKey.values()], assignments, events, pendingSourceLinks: pendingSourceLinks(document) };
}

async function acquireLock(lockDirectory: string, timeoutMs = 5_000): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      try {
        await writeFile(ownerFile(lockDirectory), `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return async () => releaseLock(lockDirectory, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await staleLock(lockDirectory)) {
        const abandoned = `${lockDirectory}.${randomUUID()}.stale`;
        try {
          await rename(lockDirectory, abandoned);
          await rm(abandoned, { recursive: true, force: true });
          continue;
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT" && (recoveryError as NodeJS.ErrnoException).code !== "EEXIST") throw recoveryError;
        }
      }
      if (Date.now() >= deadline) throw new Error("coursework document is busy");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Link a verified assignment deep link to one legacy Canvas item in the same course. */
function linkIcalAssignments(document: JsonObject, normalized: IcalNormalization): readonly SourceObservation[] {
  const courses = array(document.courses, "courses").map((value, index) => object(value, `courses[${index}]`));
  const items = [...array(document.items, "items"), ...(Array.isArray(document.archivedForecastItems) ? document.archivedForecastItems : [])]
    .map((value, index) => object(value, `source item ${index}`));
  const links = new Map(normalized.events.filter((event) => event.kind === "assignment-parent")
    .map((event) => [event.observation.localId, event] as const));
  return normalized.observations.map((observation) => {
    const event = links.get(observation.localId);
    const match = /^assignment:([1-9]\d*)$/u.exec(observation.reference.id);
    if (!event || !match || !event.canvasCourseId || typeof observation.fields.url !== "string") return observation;
    const deepLink = new URL(observation.fields.url);
    if (deepLink.protocol !== "https:" || deepLink.username || deepLink.password || deepLink.search || deepLink.hash
        || deepLink.pathname !== `/courses/${event.canvasCourseId}/assignments/${match[1]}`) return observation;
    const knownCourse = courses.filter((course) => course.key === observation.course && String(course.canvasCourseId) === event.canvasCourseId);
    if (knownCourse.length !== 1) return observation;
    const candidates = items.filter((item) => item.course === observation.course && item.canvasId != null
      && String(item.canvasId) === match[1]);
    if (candidates.length === 1) return { ...observation, localId: String(candidates[0]!.id) };
    if (candidates.length > 1) return { ...observation, possibleLocalIds: candidates.map((item) => String(item.id)).sort() };
    return observation;
  });
}

/** Exact-byte, lossless local coursework access with optimistic conflict detection. */
export class CourseworkStore {
  readonly #file: string;
  readonly #lockDirectory: string;

  constructor(file: string) {
    this.#file = path.resolve(file);
    this.#lockDirectory = `${this.#file}.duegood-lock`;
  }

  async read(): Promise<LocalSnapshot> {
    const bytes = await readFile(this.#file);
    const parsed = object(JSON.parse(Buffer.from(bytes).toString("utf8")), "coursework document");
    return { version: hash(bytes), ...validateAndProject(parsed) };
  }

  async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquireLock(this.#lockDirectory);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async #writeDocument(document: JsonObject): Promise<string> {
    const output = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    const temporary = path.join(path.dirname(this.#file), `.${path.basename(this.#file)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(output);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#file);
      const directory = await open(path.dirname(this.#file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      if (handle !== undefined) await handle.close();
      await rm(temporary, { force: true });
    }
    return hash(output);
  }

  /** Applies source facts under the shared lock; a no-op leaves the exact source bytes untouched. */
  async applySourceObservations(institution: string, observations: readonly SourceObservation[]): Promise<AcquisitionResult & { readonly version: string }> {
    return this.withExclusive(async () => {
      const bytes = await readFile(this.#file);
      const document = object(JSON.parse(Buffer.from(bytes).toString("utf8")), "coursework document");
      validateAndProject(document);
      const result = applySourceObservations(document, institution, observations);
      validateAndProject(document);
      const version = result.changed ? await this.#writeDocument(document) : hash(bytes);
      return { ...result, version };
    });
  }

  /** Resolves a manually reviewed source candidate behind the exact-byte version fence. */
  async resolvePendingSourceLink(institution: string, pendingId: string, localItemId: string, decision: PendingLinkDecision, expectedVersion: string): Promise<AcquisitionResult & { readonly version: string }> {
    return this.withExclusive(async () => {
      const bytes = await readFile(this.#file);
      if (hash(bytes) !== expectedVersion) throw new Error("coursework document changed; reload and retry");
      const document = object(JSON.parse(Buffer.from(bytes).toString("utf8")), "coursework document");
      validateAndProject(document);
      const result = resolvePendingSourceLink(document, institution, pendingId, localItemId, decision);
      validateAndProject(document);
      const version = await this.#writeDocument(document);
      return { ...result, version };
    });
  }

  /** Imports one parsed calendar window through the existing exclusive coursework writer. */
  async importIcalFeed(institution: string, normalized: IcalNormalization, startedAt: string, finishedAt: string): Promise<AcquisitionResult & { readonly version: string; readonly feedStatus: IcalFeedStatus }> {
    return this.withExclusive(async () => {
      const before = await captureCanvasSnapshot(this.#file);
      const bytes = await readFile(this.#file);
      const document = object(JSON.parse(Buffer.from(bytes).toString("utf8")), "coursework document");
      validateAndProject(document);
      const observations = linkIcalAssignments(document, normalized).map((observation) => ({ ...observation, observedAt: finishedAt }));
      const result = applySourceObservations(document, institution, observations);
      validateAndProject(document);
      const version = result.changed ? await this.#writeDocument(document) : hash(bytes);
      const after = await captureCanvasSnapshot(this.#file);
      await recordIcalImport(path.dirname(this.#file), before, after, startedAt, finishedAt);
      const feedStatus: IcalFeedStatus = { schema: 1, acquisition: "succeeded", coverage: "rolling_window",
        attemptedAt: finishedAt, lastSuccessAt: finishedAt, accepted: observations.length - result.held.length,
        held: normalized.held.length + result.held.length };
      await recordIcalFeedStatus(path.dirname(this.#file), feedStatus);
      return { ...result, version, feedStatus };
    });
  }

  /** Records only a content-free failed acquisition; it does not change coursework bytes. */
  async recordIcalFailure(attemptedAt: string): Promise<IcalFeedStatus> {
    return this.withExclusive(async () => {
      const root = path.dirname(this.#file);
      const prior = await readIcalFeedStatus(root);
      const status: IcalFeedStatus = { schema: 1, acquisition: "failed", coverage: "rolling_window",
        attemptedAt, lastSuccessAt: prior?.lastSuccessAt ?? null, accepted: 0, held: 0 };
      await recordIcalFeedStatus(root, status);
      return status;
    });
  }

  async setCompletion(itemId: string, completed: boolean, expectedVersion: string): Promise<{ completed: boolean; completedAt: number | null; version: string }> {
    return this.withExclusive(async () => {
      const bytes = await readFile(this.#file);
      if (hash(bytes) !== expectedVersion) throw new Error("coursework document changed; reload and retry");
      const document = object(JSON.parse(Buffer.from(bytes).toString("utf8")), "coursework document");
      validateAndProject(document);
      const item = array(document.items, "items").map((value, index) => object(value, `items[${index}]`)).find((candidate) => candidate.id === itemId);
      if (item === undefined) throw new Error("coursework item not found");
      const doneAt = completed ? new Date().toISOString() : null;
      item.done = completed;
      item.doneAt = doneAt;
      const output = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
      const temporary = path.join(path.dirname(this.#file), `.${path.basename(this.#file)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(output);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, this.#file);
        const directory = await open(path.dirname(this.#file), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally {
        if (handle !== undefined) await handle.close();
        await rm(temporary, { force: true });
      }
      return { completed, completedAt: doneAt === null ? null : Date.parse(doneAt), version: hash(output) };
    });
  }

  /** Writes or clears one schema-versioned local grade without changing Canvas grade or score. */
  async setManualGrade(itemId: string, value: string | null, expectedVersion: string, source: "manual" | "pdf" = "manual"): Promise<{ manualGrade: string | null; manualGradeVersion: 1 | null; manualGradeSource: "manual" | "pdf" | null; version: string }> {
    return this.withExclusive(async () => {
      const bytes = await readFile(this.#file);
      if (hash(bytes) !== expectedVersion) throw new Error("coursework document changed; reload and retry");
      const document = object(JSON.parse(Buffer.from(bytes).toString("utf8")), "coursework document");
      validateAndProject(document);
      const item = array(document.items, "items").map((candidate, index) => object(candidate, `items[${index}]`)).find((candidate) => candidate.id === itemId);
      if (item === undefined) throw new Error("coursework item not found");
      const normalized = value === null ? null : value.trim();
      if (normalized !== null && (normalized.length === 0 || normalized.length > 80)) throw new Error("manual grade must be a nonempty string up to 80 characters");
      if (normalized === null) delete item.manualGradeObservation;
      else item.manualGradeObservation = { version: 1, value: normalized, source };
      validateAndProject(document);
      const version = await this.#writeDocument(document);
      return { manualGrade: normalized, manualGradeVersion: normalized === null ? null : 1, manualGradeSource: normalized === null ? null : source, version };
    });
  }

  /** Persist one local discussion checklist mark without touching Canvas state or completion. */
  async setDiscussionField(itemId: string, field: DiscussionProgressField, value: boolean): Promise<DiscussionProgress & { version: string }> {
    return this.withExclusive(async () => {
      const bytes = await readFile(this.#file);
      const document = object(JSON.parse(Buffer.from(bytes).toString("utf8")), "coursework document");
      validateAndProject(document);
      const item = array(document.items, "items").map((candidate, index) => object(candidate, `items[${index}]`)).find((candidate) => candidate.id === itemId);
      if (item === undefined || item.kind !== "discussion") throw new Error("discussion coursework item not found");
      item[field] = value;
      const output = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
      const temporary = path.join(path.dirname(this.#file), `.${path.basename(this.#file)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(output);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, this.#file);
        const directory = await open(path.dirname(this.#file), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally {
        if (handle !== undefined) await handle.close();
        await rm(temporary, { force: true });
      }
      return { discussionPostDone: item.discussionPostDone === true, discussionRepliesDone: item.discussionRepliesDone === true, version: hash(output) };
    });
  }

  /** Persist both local discussion checklist marks for legacy callers. */
  async setDiscussionProgress(itemId: string, discussionPostDone: boolean, discussionRepliesDone: boolean, expectedVersion: string): Promise<{ discussionPostDone: boolean; discussionRepliesDone: boolean; version: string }> {
    return this.withExclusive(async () => {
      const bytes = await readFile(this.#file);
      if (hash(bytes) !== expectedVersion) throw new Error("coursework document changed; reload and retry");
      const document = object(JSON.parse(Buffer.from(bytes).toString("utf8")), "coursework document");
      validateAndProject(document);
      const item = array(document.items, "items").map((value, index) => object(value, `items[${index}]`)).find((candidate) => candidate.id === itemId);
      if (item === undefined || item.kind !== "discussion") throw new Error("discussion coursework item not found");
      item.discussionPostDone = discussionPostDone;
      item.discussionRepliesDone = discussionRepliesDone;
      const output = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
      const temporary = path.join(path.dirname(this.#file), `.${path.basename(this.#file)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(output);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, this.#file);
        const directory = await open(path.dirname(this.#file), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally {
        if (handle !== undefined) await handle.close();
        await rm(temporary, { force: true });
      }
      return { discussionPostDone, discussionRepliesDone, version: hash(output) };
    });
  }
}
