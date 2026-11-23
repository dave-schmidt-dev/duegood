import type { LocalCourse } from "./coursework-types";

type JsonObject = Record<string, unknown>;

/** Loopback route prefix for downloaded Canvas files in browser mode. */
export const LOCAL_RESOURCE_PREFIX = "/api/local/resources/";

export interface LocalResource {
  readonly id: string;
  readonly courseId: string;
  readonly courseCode: string | null;
  readonly type: "File" | "Page" | "Link" | "Module" | "Announcement" | "Quiz";
  readonly title: string;
  readonly context: string | null;
  readonly updatedAt: string | null;
  readonly openPath: string | null;
  /** Structured, sanitized Canvas text. Raw Canvas HTML is never sent to the UI. */
  readonly bodyText?: string;
  /** Native mode only: the manifest records a local copy, which opens through a later handler. */
  readonly savedLocally?: true;
  /** Internal freshness evidence for a file captured through a course content link. */
  readonly linkedCaptureRunId?: number;
}

/** Parsed Canvas export documents of one course folder; `null` when absent or malformed. */
export interface CourseExportDocuments {
  readonly files: unknown;
  readonly pages: unknown;
  readonly modules: unknown;
  readonly announcements: unknown;
  readonly quizzes: unknown;
  readonly downloadManifest: unknown;
}

/** Raw text of one course folder's export documents, as the Rust store returns them. */
export interface CourseExportTexts {
  readonly files: string | null;
  readonly pages: string | null;
  readonly modules: string | null;
  readonly announcements: string | null;
  readonly quizzes?: string | null;
  readonly downloadManifest: string | null;
}

function text(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length === 0 ? null : clean.slice(0, max);
}

function entries(value: unknown, max = 1_000): JsonObject[] {
  return Array.isArray(value) ? value.slice(0, max).filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

function resourceId(courseId: string, type: string, value: unknown): string {
  return `${courseId}:${type}:${String(value).slice(0, 100)}`;
}

function knownBodyText(item: JsonObject): string | undefined {
  const detail = item.detail;
  if (typeof detail !== "string" || detail.trim().length === 0 || item.bodyEmpty !== false) return undefined;
  return detail;
}

/** Projects one course's Canvas export lists into Library resources (unsorted, uncapped). */
export function projectCourseResources(
  course: Pick<LocalCourse, "id" | "courseCode">,
  documents: CourseExportDocuments,
  resourceOpenPrefix: string | null,
): LocalResource[] {
  const resources: LocalResource[] = [];
  const manifest = entries(documents.downloadManifest);
  const localFilesByCanvasId = new Set(manifest.flatMap((item) => {
    if ((item.status === "downloaded" || item.status === "reused") && (typeof item.id === "string" || typeof item.id === "number")) return [String(item.id)];
    const fileId = item.fileId;
    const contentType = typeof item.contentType === "string" ? item.contentType : "";
    const validNativeReceipt = item.status === "saved"
      && (typeof fileId === "number" && Number.isSafeInteger(fileId) && fileId > 0 || typeof fileId === "string" && /^[1-9][0-9]{0,15}$/.test(fileId))
      && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256)
      && typeof item.byteCount === "number" && Number.isSafeInteger(item.byteCount) && item.byteCount > 0
      && item.sourceAuthenticity === "unverified"
      && contentType.length <= 120 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9._=+-]+)*$/i.test(contentType);
    return validNativeReceipt ? [String(fileId)] : [];
  }));

  for (const item of entries(documents.files)) {
    const title = text(item.display_name) ?? text(item.filename);
    if (title === null) continue;
    const id = resourceId(course.id, "file", item.id);
    const saved = localFilesByCanvasId.has(String(item.id));
    const linkedCaptureRunId = typeof item.linkedCaptureRunId === "number"
      && Number.isSafeInteger(item.linkedCaptureRunId) && item.linkedCaptureRunId > 0
      ? item.linkedCaptureRunId : undefined;
    resources.push({
      id, courseId: course.id, courseCode: course.courseCode, type: "File", title,
      context: typeof item.size === "number" ? `${String(item.size)} bytes` : null,
      updatedAt: text(item.updated_at, 80),
      openPath: saved && resourceOpenPrefix !== null ? `${resourceOpenPrefix}${encodeURIComponent(id)}` : null,
      ...(saved && resourceOpenPrefix === null ? { savedLocally: true as const } : {}),
      ...(linkedCaptureRunId === undefined ? {} : { linkedCaptureRunId }),
    });
  }
  for (const item of entries(documents.pages)) {
    const title = text(item.title); if (title === null) continue;
    const bodyText = knownBodyText(item);
    resources.push({ id: resourceId(course.id, "page", item.page_id ?? item.url), courseId: course.id, courseCode: course.courseCode, type: "Page", title, context: "Canvas page", updatedAt: text(item.updated_at, 80), openPath: null, ...(bodyText === undefined ? {} : { bodyText }) });
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
    const bodyText = knownBodyText(item);
    resources.push({ id: resourceId(course.id, "announcement", item.id), courseId: course.id, courseCode: course.courseCode, type: "Announcement", title, context: "Course announcement", updatedAt: text(item.posted_at, 80), openPath: null, ...(bodyText === undefined ? {} : { bodyText }) });
  }
  for (const item of entries(documents.quizzes)) {
    const title = text(item.title); if (title === null) continue;
    const bodyText = knownBodyText(item);
    resources.push({ id: resourceId(course.id, "quiz", item.id), courseId: course.id, courseCode: course.courseCode, type: "Quiz", title, context: "Canvas quiz", updatedAt: text(item.updated_at, 80), openPath: null, ...(bodyText === undefined ? {} : { bodyText }) });
  }
  return resources;
}

/** Caps the Library at 2,000 items in course order, then sorts newest first and by title. */
export function finalizeResources(resources: readonly LocalResource[]): readonly LocalResource[] {
  return resources
    .slice(0, 2_000)
    .map((item) => {
      const resource = { ...item };
      delete resource.linkedCaptureRunId;
      return resource;
    })
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.title.localeCompare(right.title));
}

/** Parses the fixed Canvas export text fields; absent or malformed documents become `null`. */
export function parseCourseExportDocuments(texts: CourseExportTexts): CourseExportDocuments {
  const parse = (value: string | null | undefined): unknown => {
    if (typeof value !== "string") return null;
    try { return JSON.parse(value) as unknown; } catch { return null; }
  };
  return {
    files: parse(texts.files), pages: parse(texts.pages), modules: parse(texts.modules),
    announcements: parse(texts.announcements), quizzes: parse(texts.quizzes), downloadManifest: parse(texts.downloadManifest),
  };
}
