import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssignmentListItem } from "../db/types";

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
  /** Local discussion workflow state, independent from Canvas submission and completion. */
  readonly discussionPostDone: boolean;
  readonly discussionRepliesDone: boolean;
}

export interface LocalSnapshot {
  readonly version: string;
  readonly courses: readonly LocalCourse[];
  readonly assignments: readonly LocalGradeRecord[];
  readonly events: readonly LocalTimelineEvent[];
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
  return { courses: [...coursesByKey.values()], assignments, events };
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
