/** Content-free freshness reported by the native browser-capture importer. */
export interface BrowserFreshness {
  readonly current: boolean;
  readonly reason: BrowserFreshnessReason;
  readonly runId: number | null;
  readonly observedAt: string | null;
  readonly sections: readonly BrowserSectionFreshness[];
  readonly captureAvailability?: BrowserCaptureAvailability;
}

/** Safe capture counts/time for Recovery; Canvas identity never crosses the native bridge. */
interface BrowserCaptureAvailability {
  readonly available: boolean;
  readonly reason: BrowserCaptureAvailabilityReason;
  readonly runId: number | null;
  readonly observedAt: string | null;
  readonly activeCourseCount: number | null;
  readonly resourceCount: number | null;
  readonly itemCount: number | null;
  readonly blobCount: number | null;
  readonly blobBytes: number | null;
  readonly accountConfirmationNeeded: boolean;
}

type BrowserCaptureAvailabilityReason =
  | "no-capture" | "attempt-unavailable" | "capture-unverified" | "archive-unverified"
  | "confirmation-required" | "already-bound" | "account-mismatch" | "account-binding-unverified";

interface BrowserSectionFreshness {
  readonly courseId: number | null;
  readonly endpoint: BrowserEndpoint;
  readonly current: boolean;
}

type BrowserFreshnessReason =
  | "not-reported"
  | "not-imported"
  | "attempt-unavailable"
  | "invalid-import-receipt"
  | "invalid-run"
  | "newer-or-inconsistent-attempt"
  | "capture-unverified"
  | "identity-or-generation-mismatch"
  | "invalid-observation"
  | "invalid-coverage"
  | "duplicate-coverage"
  | "verified-import";

/** Fixed Canvas capture endpoint names; arbitrary strings from native storage are rejected. */
export type BrowserEndpoint =
  | "profile" | "coursesActive" | "coursesCompleted" | "course" | "syllabus" | "courseTabs"
  | "assignments" | "assignmentGroups" | "submissions" | "submission" | "pages" | "page"
  | "modules" | "moduleItems" | "discussions" | "discussionEntries" | "discussionReplies"
  | "announcements" | "quizzes" | "quiz" | "courseFiles" | "folders" | "groups"
  | "personalFiles" | "personalFolders" | "personalFile" | "inbox" | "inboxAll"
  | "conversationsSent" | "conversationsArchived" | "conversation" | "file" | "fileBodies"
  | "calendarEvents";

export type BrowserFactFreshness = "current" | "stale" | "unknown" | "independent";

export interface BrowserCourseCoverage {
  readonly active: boolean;
  readonly canvasCourseId: number | null;
}

export interface BrowserGradeFacts {
  readonly source: string | null;
  readonly submissionState: string;
  readonly score: number | null;
  readonly grade: string | null;
  readonly gradedAt: string | null;
  readonly assignmentGroupId: string | null;
  readonly assignmentGroupName: string | null;
  readonly assignmentGroupWeight: number | null;
}

export interface BrowserLibraryFact {
  readonly courseId: string;
  readonly type: string;
}

const ENDPOINTS = new Set<BrowserEndpoint>([
  "profile", "coursesActive", "coursesCompleted", "course", "syllabus", "courseTabs",
  "assignments", "assignmentGroups", "submissions", "submission", "pages", "page", "modules",
  "moduleItems", "discussions", "discussionEntries", "discussionReplies", "announcements",
  "quizzes", "quiz", "courseFiles", "folders", "groups", "personalFiles", "personalFolders",
  "personalFile", "inbox", "inboxAll", "conversationsSent", "conversationsArchived",
  "conversation", "file", "fileBodies", "calendarEvents",
]);

const REASONS = new Set<BrowserFreshnessReason>([
  "not-reported", "not-imported", "attempt-unavailable", "invalid-import-receipt", "invalid-run",
  "newer-or-inconsistent-attempt", "capture-unverified", "identity-or-generation-mismatch",
  "invalid-observation", "invalid-coverage", "duplicate-coverage", "verified-import",
]);

const CAPTURE_AVAILABILITY_REASONS = new Set<BrowserCaptureAvailabilityReason>([
  "no-capture", "attempt-unavailable", "capture-unverified", "archive-unverified",
  "confirmation-required", "already-bound", "account-mismatch", "account-binding-unverified",
]);

const UNREPORTED: BrowserFreshness = {
  current: false,
  reason: "not-reported",
  runId: null,
  observedAt: null,
  sections: [],
};

const INVALIDATED_REASONS = new Set<BrowserFreshnessReason>([
  "newer-or-inconsistent-attempt", "capture-unverified", "identity-or-generation-mismatch",
]);

export const REQUIRED_COURSEWORK_ENDPOINTS: readonly BrowserEndpoint[] = ["course", "assignments", "assignmentGroups", "submissions"];
export const LIBRARY_ENDPOINTS: readonly BrowserEndpoint[] = ["courseFiles", "pages", "modules", "announcements"];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseSection(value: unknown): BrowserSectionFreshness {
  const row = record(value);
  if (row === null || typeof row.current !== "boolean" || typeof row.endpoint !== "string" || !ENDPOINTS.has(row.endpoint as BrowserEndpoint)) {
    throw new TypeError("Malformed browser freshness section");
  }
  const courseId = row.courseId;
  if (courseId !== null && !validId(courseId)) throw new TypeError("Malformed browser freshness course");
  return { courseId, endpoint: row.endpoint as BrowserEndpoint, current: row.current };
}

function parseCaptureAvailability(value: unknown): BrowserCaptureAvailability {
  const row = record(value);
  if (row === null || typeof row.available !== "boolean" || typeof row.reason !== "string"
    || !CAPTURE_AVAILABILITY_REASONS.has(row.reason as BrowserCaptureAvailabilityReason)
    || typeof row.accountConfirmationNeeded !== "boolean") {
    throw new TypeError("Malformed browser capture availability");
  }
  const runId = row.runId;
  const observedAt = row.observedAt;
  if (runId !== null && !validId(runId)) throw new TypeError("Malformed browser capture run");
  if (observedAt !== null && (typeof observedAt !== "string" || observedAt.length > 80 || !Number.isFinite(Date.parse(observedAt)))) {
    throw new TypeError("Malformed browser capture observation");
  }
  const optionalCount = (candidate: unknown): number | null => candidate === null ? null : validCount(candidate);
  const activeCourseCount = optionalCount(row.activeCourseCount);
  const resourceCount = optionalCount(row.resourceCount);
  const itemCount = optionalCount(row.itemCount);
  const blobCount = optionalCount(row.blobCount);
  const blobBytes = optionalCount(row.blobBytes);
  const reason = row.reason as BrowserCaptureAvailabilityReason;
  const hasSummary = runId !== null && observedAt !== null && activeCourseCount !== null && resourceCount !== null
    && itemCount !== null && blobCount !== null && blobBytes !== null;
  if ((row.available && !hasSummary)
    || (row.accountConfirmationNeeded !== (reason === "confirmation-required"))
    || (row.accountConfirmationNeeded && !row.available)
    || ((reason === "confirmation-required" || reason === "already-bound") && !row.available)
    || (row.available && !["confirmation-required", "already-bound"].includes(reason))) {
    throw new TypeError("Inconsistent browser capture availability");
  }
  return {
    available: row.available,
    reason,
    runId,
    observedAt,
    activeCourseCount,
    resourceCount,
    itemCount,
    blobCount,
    blobBytes,
    accountConfirmationNeeded: row.accountConfirmationNeeded,
  };
}

function validCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("Malformed browser capture count");
  return value;
}

/**
 * Parses native freshness. Older native bundles omit the field; that case stays explicitly
 * unverified and never upgrades retained documents to current.
 */
export function parseBrowserFreshness(value: unknown): BrowserFreshness {
  if (value === undefined) return UNREPORTED;
  const row = record(value);
  if (row === null || typeof row.current !== "boolean" || typeof row.reason !== "string" || !REASONS.has(row.reason as BrowserFreshnessReason)) {
    throw new TypeError("Malformed browser freshness");
  }
  const runId = row.runId;
  if (runId !== null && !validId(runId)) throw new TypeError("Malformed browser freshness run");
  const observedAt = row.observedAt;
  if (observedAt !== null && (typeof observedAt !== "string" || observedAt.length > 80 || !Number.isFinite(Date.parse(observedAt)))) {
    throw new TypeError("Malformed browser freshness observation");
  }
  if (!Array.isArray(row.sections) || row.sections.length > 20_000) throw new TypeError("Malformed browser freshness sections");
  const sections = row.sections.map(parseSection);
  const captureAvailability = row.captureAvailability === undefined ? undefined : parseCaptureAvailability(row.captureAvailability);
  const keys = new Set<string>();
  for (const section of sections) {
    const key = `${section.courseId ?? "account"}\0${section.endpoint}`;
    if (keys.has(key)) throw new TypeError("Duplicate browser freshness section");
    keys.add(key);
  }
  if (row.current && (row.reason !== "verified-import" || runId === null || observedAt === null)) {
    throw new TypeError("Inconsistent current browser freshness");
  }
  if (!row.current && row.reason === "verified-import") throw new TypeError("Inconsistent browser freshness reason");
  return {
    current: row.current,
    reason: row.reason as BrowserFreshnessReason,
    runId,
    observedAt,
    sections,
    ...(captureAvailability === undefined ? {} : { captureAvailability }),
  };
}

/** Requires an explicit current observation for this exact course and endpoint. */
export function isBrowserSectionCurrent(
  freshness: BrowserFreshness,
  courseId: number | null,
  endpoint: BrowserEndpoint,
): boolean {
  return freshness.current && freshness.sections.some((section) =>
    section.courseId === courseId && section.endpoint === endpoint && section.current);
}

/** Requires every requested endpoint to be explicitly current for one active course. */
export function isBrowserCourseCoverageCurrent(
  freshness: BrowserFreshness,
  course: BrowserCourseCoverage,
  endpoints: readonly BrowserEndpoint[],
): boolean {
  return course.canvasCourseId !== null && endpoints.every((endpoint) =>
    isBrowserSectionCurrent(freshness, course.canvasCourseId, endpoint));
}

/** Requires full explicit coverage for every active course in the projection. */
export function areActiveBrowserCoursesCurrent(
  freshness: BrowserFreshness,
  courses: readonly BrowserCourseCoverage[],
  endpoints: readonly BrowserEndpoint[],
): boolean {
  const active = courses.filter((course) => course.active);
  return freshness.current && active.length > 0 && active.every((course) =>
    isBrowserCourseCoverageCurrent(freshness, course, endpoints));
}

/** Keeps archival library records visible while requiring exact current coverage for active courses. */
export function isBrowserLibraryFactCurrent(
  resource: BrowserLibraryFact,
  courses: ReadonlyMap<string, BrowserCourseCoverage>,
  freshness: BrowserFreshness,
): boolean {
  const course = courses.get(resource.courseId);
  if (course?.active === false) return true;
  if (course === undefined || course.canvasCourseId === null) return false;
  const endpoint: BrowserEndpoint = resource.type === "File" ? "courseFiles"
    : resource.type === "Page" ? "pages"
      : resource.type === "Announcement" ? "announcements" : "modules";
  return isBrowserSectionCurrent(freshness, course.canvasCourseId, endpoint);
}

/** Clears retained Canvas grade/submission facts unless all contributing endpoints are current. */
export function maskStaleBrowserGrade<T extends BrowserGradeFacts>(
  fact: T,
  course: BrowserCourseCoverage,
  freshness: BrowserFreshness,
): T {
  if (fact.source !== "canvas" || isBrowserCourseCoverageCurrent(freshness, course, ["assignments", "assignmentGroups", "submissions"])) return fact;
  return {
    ...fact,
    submissionState: "unknown",
    score: null,
    grade: null,
    gradedAt: null,
    assignmentGroupId: null,
    assignmentGroupName: null,
    assignmentGroupWeight: null,
  } as T;
}

/** Marks only an explicitly selected iCal due observation as independent Canvas-event provenance. */
export function hasIndependentIcalDue(value: unknown): boolean {
  const item = record(value);
  if (item === null) return false;
  if (item.source === "ical") return true;
  const observations = record(item.fieldObservations);
  const at = record(observations?.at);
  const selected = record(at?.selected);
  const owner = record(selected?.owner);
  return owner?.source === "ical" && Object.hasOwn(item, "at") && selected?.value === item.at;
}

/** Classifies one source fact without mutating or discarding it. iCal and personal facts are independent. */
export function classifyBrowserFact(
  freshness: BrowserFreshness,
  source: string | null,
  courseId: number | null,
  endpoint: BrowserEndpoint,
): BrowserFactFreshness {
  if (source === "ical" || source === "manual" || source === "pdf") return "independent";
  if (source !== "canvas") return "unknown";
  if (!freshness.current) return INVALIDATED_REASONS.has(freshness.reason) ? "stale" : "unknown";
  const section = freshness.sections.find((item) => item.courseId === courseId && item.endpoint === endpoint);
  return section === undefined ? "unknown" : section.current ? "current" : "stale";
}
