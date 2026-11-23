import { readCanvasBrowserApi } from "./canvas-browser-reader.mjs";
import { extractCanvasHtmlInPage } from "./canvas-browser-links.mjs";
import { sanitizeCanvasCaptureItem } from "./canvas-browser-capture-sanitize.mjs";
import { canvasAttachmentFileReferences } from "./canvas-browser-file-references.mjs";
import { ACCOUNT_DETAIL_REQUEST_CAPS, MAX_ACCOUNT_FILE_IDS, collectCanvasAccountCapture } from "./canvas-browser-capture-account.mjs";
import { canvasFileBodiesComplete, createCanvasFileCapture } from "./canvas-browser-capture-files.mjs";
import { summarizeCanvasCaptureOutcome } from "./canvas-browser-refresh-scope.mjs";
import { hydrateDiscussionAssignmentRubrics } from "./canvas-browser-capture-rubrics.mjs";

const ORIGIN = "https://marymount.instructure.com";
const REQUEST_LIMITS = Object.freeze({
  maxPages: 25,
  maxItems: 5000,
  maxBytes: 20 * 1024 * 1024,
  timeoutMs: 30_000,
});
const MAX_COURSES = 250;
const MAX_REQUESTS = 10_000;
const MAX_CAPTURE_ITEMS = 100_000;
const MAX_CAPTURE_MILLISECONDS = 30 * 60 * 1000;
const MAX_DETAIL_REQUESTS = 5000;
const MAX_LINKED_FILE_DETAIL_REQUESTS = 1000;
const FILE_METADATA_ENDPOINTS = new Set(["courseFiles", "personalFiles", "file", "personalFile"]);
const DETAIL_REQUEST_CAPS = Object.freeze({
  page: 1000,
  moduleItems: 1000,
  submission: 1000,
  discussionEntries: 500,
  discussionReplies: 1500,
  quiz: 500,
  ...ACCOUNT_DETAIL_REQUEST_CAPS,
});
const PUBLIC_ERROR_CODES = new Set([
  "EXPECTED_USER_ID_REQUIRED", "INVALID_CONFIGURATION", "PAGE_EVALUATOR_REQUIRED", "CAPTURE_BUDGET_EXCEEDED",
  "PROGRESS_CALLBACK_FAILED", "READER_PROGRESS_BINDING_UNAVAILABLE", "IDENTITY_MISMATCH", "INVALID_READ_RESULT", "PAGINATION_INCOMPLETE",
  "REQUIRED_SECTION_INCOMPLETE", "CAPTURE_ITEM_BUDGET_EXCEEDED", "SANITIZE_BUDGET_EXCEEDED",
  "HTML_SANITIZATION_FAILED", "INVALID_RESOURCE_ITEM", "INVALID_COURSE_ID", "COURSE_BUDGET_EXCEEDED",
  "INVALID_ASSIGNMENT_IDENTITY", "INVALID_SUBMISSION_IDENTITY", "SUBMISSION_ASSIGNMENT_MISMATCH",
  "INVALID_PAGE_IDENTITY", "INVALID_PAGE_SLUG", "PAGE_IDENTITY_MISMATCH", "INVALID_MODULE_IDENTITY",
  "INVALID_DISCUSSION_IDENTITY", "INVALID_DISCUSSION_ENTRY_IDENTITY", "DISCUSSION_ENTRY_IDENTITY_MISMATCH",
  "INVALID_QUIZ_IDENTITY", "QUIZ_IDENTITY_MISMATCH", "FILE_IDENTITY_MISMATCH", "DETAIL_BUDGET_EXCEEDED",
  "INVALID_GROUP_ID", "GROUP_IDENTITY_MISMATCH", "INVALID_GROUP_FOLDER_ID", "DUPLICATE_GROUP_FOLDER_ID",
  "INVALID_GROUP_FILE_ID", "GROUP_PAGE_IDENTITY_MISMATCH", "INVALID_GROUP_DISCUSSION_ID", "INVALID_GROUP_DISCUSSION_ENTRY_ID",
  "INVALID_CONVERSATION_ID", "CONVERSATION_BUDGET_EXCEEDED", "FILE_LOCKED",
  "COURSE_IDENTITY_MISMATCH", "CONVERSATION_IDENTITY_MISMATCH", "INVALID_CAPTURE_TIME",
  "SESSION_FAILURE", "HTML_OR_SSO_REJECTED", "INVALID_JSON", "NOT_FOUND", "INCOMPLETE_REQUIRED_AREA",
  "IDENTITY_UNAVAILABLE", "UNSAFE_URL", "REDIRECT_REJECTED", "BUDGET_EXCEEDED", "REQUEST_FAILED",
  "INVALID_REQUEST",
]);
const OPTIONAL_ENDPOINTS = new Set([
  "courseTabs", "assignmentGroups", "submission", "pages", "page", "modules", "moduleItems",
  "discussions", "discussionEntries", "discussionReplies", "announcements", "quizzes", "quiz",
  "courseFiles", "folders", "groups", "personalFiles", "personalFolders", "personalFile", "file",
  "inbox", "inboxAll", "conversationsSent", "conversationsArchived", "conversation", "calendarEvents",
  "groupFolders", "groupFolderFiles", "groupPages", "groupPage", "groupDiscussions",
  "groupDiscussionEntries", "groupDiscussionReplies",
]);
const COURSE_ENDPOINTS = Object.freeze([
  "course", "courseTabs", "assignments", "assignmentGroups", "submissions", "pages", "modules",
  "discussions", "announcements", "quizzes", "courseFiles", "folders",
]);
const DEDUPED_GAP_REASONS = new Set([
  "capture-budget", "detail-budget", "not-attempted", "pagination-budget",
]);
const BODY_OMISSION_REASONS = new Set(["locked", "unpublished", "forbidden-optional", "not-found"]);
const FILE_REFERENCE_ENDPOINTS = new Set([
  "assignments", "pages", "page", "discussions", "discussionEntries", "discussionReplies", "announcements",
  "groupPages", "groupPage", "groupDiscussions", "groupDiscussionEntries", "groupDiscussionReplies",
]);

function captureError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function fileDetailContextKey(fileId, courseId, groupId) {
  return `${fileId}:${courseId ?? ""}:${groupId ?? ""}`;
}

function isSafePageSlug(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u.test(value);
}

function isReadableModule(module) {
  return positiveId(module.id)
    && ["unlocked", "started", "completed"].includes(module.state)
    && module.published !== false
    && module.locked_for_user !== true;
}

function isReadablePublished(resource) {
  return resource.published === true
    && resource.locked_for_user !== true
    && resource.locked !== true;
}

function publicErrorCode(error) {
  const code = error?.code;
  if (typeof code === "string" && PUBLIC_ERROR_CODES.has(code)) return code;
  // Playwright keeps an in-page Error's first message line, but drops custom properties.
  const firstLine = typeof error?.message === "string" ? error.message.split(/\r?\n/u, 1)[0] : "";
  const browserCode = /^page\.evaluate: Error: ([A-Z_]+)$/u.exec(firstLine)?.[1];
  return browserCode && PUBLIC_ERROR_CODES.has(browserCode) ? browserCode : "REQUEST_FAILED";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @typedef {{endpoint: string, courseId: number | null, groupId?: number, contextCode?: string, pages: number, items: Array<Record<string, unknown>>}} CanvasCaptureResource */
/** @typedef {{endpoint: string, courseId: number | null, groupId?: number, contextCode?: string, status: "complete" | "incomplete" | "gap", reason?: string}} CanvasCaptureCoverage */
/** @typedef {{schemaVersion: 2, source: "canvas-browser", runId: number, generationId: string, capturedAt: string, complete: boolean, identity: {origin: string, userId: number, accountId?: number}, activeCourses: {complete: true, courseIds: number[]}, coverageRequirements: {activeCoursesComplete: true, perActiveCourse: string[]}, resources: CanvasCaptureResource[], coverage: CanvasCaptureCoverage[]}} CanvasBrowserCapture */

/**
 * Collect a bounded synthetic-testable metadata snapshot through fixed Canvas reader endpoints.
 * No output is returned until identity, pagination, and required course sections all validate.
 *
 * @param {object} options
 * @param {number} options.expectedUserId Owner-confirmed Canvas user ID.
 * @param {number} options.runId Native capture run allocated before collection.
 * @param {string} options.generationId Reserved archive generation identifier.
 * @param {object} [options.page] Playwright page used when `evaluate` is omitted.
 * @param {Function} [options.evaluate] Injectable page.evaluate-compatible function.
 * @param {Function} [options.reader] Fixed self-contained browser API reader.
 * @param {Function} [options.htmlReader] Self-contained browser HTML sanitizer.
 * @param {Function} [options.downloadFile] Receives transient `{fileId, sourceUrl, expectedSize}` and returns a staged receipt.
 * @param {Function} [options.progress] Receives content-free request-boundary events.
 * @param {Function} [options.now] Injectable clock for deterministic synthetic tests.
 * @returns {Promise<CanvasBrowserCapture>} A schema-v2 capture with its coverage outcome.
 */
export async function collectCanvasBrowserCapture({
  expectedUserId,
  runId,
  generationId,
  page = undefined,
  evaluate = undefined,
  reader = readCanvasBrowserApi,
  htmlReader = extractCanvasHtmlInPage,
  downloadFile = undefined,
  progress = () => {},
  now = () => new Date(),
} = {}) {
  if (!positiveId(expectedUserId)) throw captureError("EXPECTED_USER_ID_REQUIRED");
  if (!positiveId(runId) || !Number.isSafeInteger(runId)
      || typeof generationId !== "string" || !/^[a-f0-9]{32}$/u.test(generationId)) {
    throw captureError("CAPTURE_LINKAGE_REQUIRED");
  }
  if (typeof reader !== "function" || typeof htmlReader !== "function"
      || (downloadFile !== undefined && typeof downloadFile !== "function")
      || typeof progress !== "function" || typeof now !== "function") {
    throw captureError("INVALID_CONFIGURATION");
  }
  const evaluatePage = evaluate ?? (typeof page?.evaluate === "function" ? page.evaluate.bind(page) : null);
  if (typeof evaluatePage !== "function") throw captureError("PAGE_EVALUATOR_REQUIRED");

  const startedAt = Date.now();
  let requestCount = 0;
  let captureItemCount = 0;
  let detailRequestCount = 0;
  const detailRequestCounts = new Map();
  let linkedFileDetailRequestCount = 0;
  let activeEndpoint = null;
  let progressBinding;
  let capturedAt;
  const courseFileIds = new Set();
  const listedFileIds = new Set();
  const fetchedFileDetailContexts = new Set();
  const linkedFileReferences = new Map();
  const capturedCourseIds = new Set();
  const resources = [];
  const coverage = [];
  const recordedGaps = new Map();

  const addNotAttemptedGap = (endpoint, courseId, groupId = undefined, reason = "not-attempted") => {
    if (DEDUPED_GAP_REASONS.has(reason)) {
      const key = `${endpoint}:${courseId ?? "account"}:${groupId ?? ""}:${reason}`;
      if (recordedGaps.has(key)) return;
      recordedGaps.set(key, coverage.length);
    }
    coverage.push({ endpoint, courseId: courseId ?? null,
      ...(groupId === undefined ? {} : { groupId }), status: "gap", reason });
  };

  const reserveDetailRequest = (endpoint, courseId, groupId = undefined) => {
    const cap = DETAIL_REQUEST_CAPS[endpoint];
    const count = detailRequestCounts.get(endpoint) ?? 0;
    if (cap === undefined || count >= cap || detailRequestCount >= MAX_DETAIL_REQUESTS || requestCount >= MAX_REQUESTS) {
      addNotAttemptedGap(endpoint, courseId, groupId, "detail-budget");
      return false;
    }
    detailRequestCounts.set(endpoint, count + 1);
    detailRequestCount += 1;
    return true;
  };

  const emitProgress = async (event) => {
    try {
      await progress(Object.freeze(event));
    } catch {
      throw captureError("PROGRESS_CALLBACK_FAILED");
    }
  };
  const fileCapture = createCanvasFileCapture({ downloadFile, progress: emitProgress });

  const rememberLinkedFile = (reference) => {
    if (!positiveId(reference?.fileId)) return;
    const current = linkedFileReferences.get(reference.fileId);
    const hasCourseContext = positiveId(reference.courseId);
    const hasGroupContext = positiveId(reference.groupId);
    if (current === undefined || hasCourseContext && !positiveId(current.courseId)
        || !hasCourseContext && !positiveId(current.courseId)
          && hasGroupContext && !positiveId(current.groupId)) {
      linkedFileReferences.set(reference.fileId, reference);
    }
  };

  const reportReaderProgress = async (state) => {
    if (activeEndpoint === null || (state !== "CANVAS_GET_STARTED" && state !== "CANVAS_GET_FINISHED")) return;
    try {
      await progress(Object.freeze({
        phase: state === "CANVAS_GET_STARTED" ? "canvas-request-start" : "canvas-request-complete",
        endpoint: activeEndpoint,
      }));
    } catch {
      // The reader callback is advisory; its fixed status payload contains no Canvas data.
    }
  };

  const readEndpoint = async (endpoint, values = {}, {
    optional = OPTIONAL_ENDPOINTS.has(endpoint), linkedFile = false, linkedContext = undefined,
  } = {}) => {
    const coverageCourseId = values.courseId ?? linkedContext?.courseId ?? null;
    const coverageGroupId = values.groupId ?? linkedContext?.groupId;
    if (Date.now() - startedAt > MAX_CAPTURE_MILLISECONDS || requestCount >= MAX_REQUESTS) {
      if (linkedFile) {
        coverage.push({ endpoint, courseId: coverageCourseId,
          ...(coverageGroupId === undefined ? {} : { groupId: coverageGroupId }),
          status: "incomplete", reason: "capture-budget" });
        return { result: { status: "gap", items: [], pages: 0 }, gap: true };
      }
      throw captureError("CAPTURE_BUDGET_EXCEEDED");
    }
    requestCount += 1;
    const requestId = requestCount;
    const request = {
      mode: "read",
      endpoint,
      expectedUserId,
      ...REQUEST_LIMITS,
      ...values,
    };
    await emitProgress({ phase: "request-start", requestId, endpoint });
    activeEndpoint = endpoint;
    let result;
    try {
      result = await evaluatePage(reader, request);
    } catch (error) {
      const code = publicErrorCode(error);
      await emitProgress({ phase: "request-failed", requestId, endpoint, errorCode: code });
      const linkedBudgetFailure = linkedFile && code === "BUDGET_EXCEEDED";
      const linkedLocked = linkedFile && code === "FILE_LOCKED";
      if (optional && (code === "REQUEST_FAILED" || code === "NOT_FOUND"
          || linkedBudgetFailure || linkedLocked)) {
        coverage.push({ endpoint, courseId: coverageCourseId,
          ...(coverageGroupId === undefined ? {} : { groupId: coverageGroupId }),
          ...(values.calendarContextCode === undefined ? {} : { contextCode: values.calendarContextCode }),
          status: linkedBudgetFailure ? "incomplete" : "gap",
          reason: code === "NOT_FOUND" ? "not-found"
            : linkedLocked ? "locked"
              : linkedBudgetFailure ? "capture-budget" : "request-failed" });
        return { result: { status: "gap", items: [], pages: 0 }, gap: true };
      }
      if (endpoint === "calendarEvents" && code === "BUDGET_EXCEEDED") {
        coverage.push({ endpoint, courseId: coverageCourseId,
          ...(coverageGroupId === undefined ? {} : { groupId: coverageGroupId }),
          ...(values.calendarContextCode === undefined ? {} : { contextCode: values.calendarContextCode }),
          status: "incomplete", reason: "capture-budget" });
        await emitProgress({ phase: "request-complete", requestId, endpoint, status: "incomplete", pages: 0, itemCount: 0 });
        return { result: { status: "gap", items: [], pages: 0 }, gap: true };
      }
      throw captureError(code);
    } finally {
      activeEndpoint = null;
    }
    if (!isRecord(result) || !isRecord(result.identity)
        || result.identity.userId !== expectedUserId) {
      await emitProgress({ phase: "request-failed", requestId, endpoint, errorCode: "IDENTITY_MISMATCH" });
      throw captureError("IDENTITY_MISMATCH");
    }
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.pages) || result.pages < 0) {
      await emitProgress({ phase: "request-failed", requestId, endpoint, errorCode: "INVALID_READ_RESULT" });
      throw captureError("INVALID_READ_RESULT");
    }
    if (result.status === "gap" && optional && result.reason === "FORBIDDEN_OPTIONAL" && result.items.length === 0) {
      coverage.push({ endpoint, courseId: coverageCourseId,
        ...(coverageGroupId === undefined ? {} : { groupId: coverageGroupId }),
        ...(values.calendarContextCode === undefined ? {} : { contextCode: values.calendarContextCode }),
        status: "gap", reason: "forbidden-optional" });
      await emitProgress({ phase: "request-complete", requestId, endpoint, status: "gap", pages: result.pages, itemCount: 0 });
      return { result, gap: true };
    }
    const sampledCalendar = endpoint === "calendarEvents" && result.status === "sampled";
    if ((result.status !== "ok" && !sampledCalendar) || result.pages < 1 || result.items.some((item) => !isRecord(item))) {
      const code = result.status === "sampled" ? "PAGINATION_INCOMPLETE" : "REQUIRED_SECTION_INCOMPLETE";
      await emitProgress({ phase: "request-failed", requestId, endpoint, errorCode: code });
      throw captureError(code);
    }
    if (result.items.length > REQUEST_LIMITS.maxItems || captureItemCount + result.items.length > MAX_CAPTURE_ITEMS) {
      await emitProgress({ phase: "request-failed", requestId, endpoint, errorCode: "CAPTURE_ITEM_BUDGET_EXCEEDED" });
      throw captureError("CAPTURE_ITEM_BUDGET_EXCEEDED");
    }
    captureItemCount += result.items.length;
    coverage.push({ endpoint, courseId: coverageCourseId,
      ...(coverageGroupId === undefined ? {} : { groupId: coverageGroupId }),
      ...(values.calendarContextCode === undefined ? {} : { contextCode: values.calendarContextCode }),
      status: sampledCalendar ? "incomplete" : "complete",
      ...(sampledCalendar ? { reason: "pagination-budget" } : {}) });
    await emitProgress({
      phase: "request-complete",
      requestId,
      endpoint,
      status: sampledCalendar ? "incomplete" : "complete",
      pages: result.pages,
      itemCount: result.items.length,
    });
    return { result, gap: false };
  };

  const addResource = async (endpoint, courseId, result, { groupId = undefined, contextCode = undefined } = {}) => {
    if (FILE_METADATA_ENDPOINTS.has(endpoint)) {
      for (const item of result.items) {
        await fileCapture.capture(item);
        if (positiveId(item.id) && (endpoint === "courseFiles" || endpoint === "personalFiles")) {
          listedFileIds.add(item.id);
        }
        if (positiveId(item.id) && (endpoint === "file" || endpoint === "personalFile")) {
          fetchedFileDetailContexts.add(fileDetailContextKey(item.id, courseId, groupId));
        }
      }
    }
    const safeItems = [];
    for (let index = 0; index < result.items.length; index += 1) {
      const item = result.items[index];
      const itemLinkedFiles = new Map();
      const rememberLinkedHref = (reference) => {
        rememberLinkedFile(reference);
        if (!positiveId(reference?.fileId)) return;
        const referenceCourseId = positiveId(reference.courseId) ? reference.courseId : null;
        const referenceGroupId = positiveId(reference.groupId) ? reference.groupId : null;
        const key = `${referenceCourseId ?? ""}:${referenceGroupId ?? ""}:${reference.fileId}`;
        itemLinkedFiles.set(key, {
          ...(referenceCourseId === null ? {} : { courseId: referenceCourseId }),
          ...(referenceGroupId === null ? {} : { groupId: referenceGroupId }),
          fileId: reference.fileId,
        });
      };
      if (FILE_REFERENCE_ENDPOINTS.has(endpoint)) {
        const attachments = canvasAttachmentFileReferences(item, { courseId, groupId });
        for (const reference of attachments.references) rememberLinkedFile(reference);
        if (attachments.overflowed) addNotAttemptedGap("file", courseId, groupId, "detail-budget");
      }
      const safeItem = await sanitizeCanvasCaptureItem(item, {
        endpoint,
        courseId,
        itemIndex: index,
        evaluatePage,
        htmlReader,
        groupId,
        allowedCourseIds: capturedCourseIds,
        ...(FILE_REFERENCE_ENDPOINTS.has(endpoint)
          ? { onFileReference: rememberLinkedHref } : {}),
      });
      if (itemLinkedFiles.size > 0) {
        safeItem._canvasLinkedFiles = [...itemLinkedFiles.values()].sort((left, right) =>
          (left.courseId ?? 0) - (right.courseId ?? 0)
          || (left.groupId ?? 0) - (right.groupId ?? 0)
          || left.fileId - right.fileId);
      }
      if (FILE_REFERENCE_ENDPOINTS.has(endpoint) && safeItem._canvasLinksTruncated === true) {
        addNotAttemptedGap("file", courseId, groupId, "detail-budget");
      }
      safeItems.push(safeItem);
      if ((endpoint === "pages" || endpoint === "page") && isSafePageSlug(result.items[index].url)) {
        // `url` is scrubbed as a URL by the sanitizer. Keep only the route-safe identity
        // needed to explain and audit the bounded `/pages/{slug}` detail request.
        safeItems[index]._canvasPageSlug = result.items[index].url;
      }
    }
    resources.push({ endpoint, courseId,
      ...(groupId === undefined ? {} : { groupId }),
      ...(contextCode === undefined ? {} : { contextCode }),
      items: safeItems, pages: result.pages });
  };

  const markBodyDetailOmission = (listEndpoint, detailEndpoint, courseId, itemId, idField = "id", groupId = undefined) => {
    const gap = coverage[coverage.length - 1];
    if (gap?.endpoint !== detailEndpoint || gap.courseId !== courseId || gap.groupId !== groupId
        || gap.status !== "gap" || !BODY_OMISSION_REASONS.has(gap.reason)) return;
    const resource = resources.find((row) => row.endpoint === listEndpoint && row.courseId === courseId
      && row.groupId === groupId);
    const item = resource?.items.find((row) => row[idField] === itemId);
    if (item === undefined || isRecord(item._canvasBody)
        && typeof item._canvasBody.html === "string" && typeof item._canvasBody.text === "string"
        && typeof item._canvasBody.empty === "boolean") return;
    item._canvasBodyOmissionReason = gap.reason;
  };

  let output;
  let failure;
  try {
    capturedAt = now();
    if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) throw captureError("INVALID_CAPTURE_TIME");
    if (page !== undefined) {
      if (typeof page.exposeFunction !== "function") throw captureError("READER_PROGRESS_BINDING_UNAVAILABLE");
      try {
        progressBinding = await page.exposeFunction("__duegoodCanvasReaderProgress", reportReaderProgress);
        if (!progressBinding || typeof progressBinding.dispose !== "function") {
          throw new Error("BINDING_DISPOSAL_UNAVAILABLE");
        }
      } catch {
        throw captureError("READER_PROGRESS_BINDING_UNAVAILABLE");
      }
    }
    const profileRead = await readEndpoint("profile", {}, { optional: false });
    if (profileRead.gap || profileRead.result.items.length !== 1
        || profileRead.result.items[0].id !== expectedUserId) throw captureError("IDENTITY_MISMATCH");
    const profile = profileRead.result.items[0];
    const observedAccountId = positiveId(profile.account_id) ? profile.account_id : undefined;
    await addResource("profile", null, profileRead.result);

    const activeRead = await readEndpoint("coursesActive", {}, { optional: false });
    const completedRead = await readEndpoint("coursesCompleted", {}, { optional: false });
    await addResource("coursesActive", null, activeRead.result);
    await addResource("coursesCompleted", null, completedRead.result);
    const activeCourseIds = new Set();
    for (const course of activeRead.result.items) {
      if (!positiveId(course.id)) throw captureError("INVALID_COURSE_ID");
      activeCourseIds.add(course.id);
    }
    const courseIds = new Set();
    for (const course of [...activeRead.result.items, ...completedRead.result.items]) {
      if (!positiveId(course.id)) throw captureError("INVALID_COURSE_ID");
      courseIds.add(course.id);
      capturedCourseIds.add(course.id);
    }
    if (courseIds.size > MAX_COURSES) throw captureError("COURSE_BUDGET_EXCEEDED");

    for (const courseId of courseIds) {
      const courseReads = new Map();
      for (const endpoint of COURSE_ENDPOINTS) {
        const { result, gap } = await readEndpoint(endpoint, { courseId }, {
          optional: !activeCourseIds.has(courseId) || OPTIONAL_ENDPOINTS.has(endpoint),
        });
        if (gap) {
          if (endpoint === "courseFiles") addNotAttemptedGap("file", courseId, undefined, "parent-unavailable");
          continue;
        }
        if (endpoint === "course" && (result.items.length !== 1 || result.items[0].id !== courseId)) {
          throw captureError("COURSE_IDENTITY_MISMATCH");
        }
        if (endpoint === "assignments" && result.items.some((assignment) => (
          !positiveId(assignment.id) || (assignment.course_id !== undefined && assignment.course_id !== courseId)
        ))) throw captureError("INVALID_ASSIGNMENT_IDENTITY");
        if (endpoint === "assignmentGroups" && result.items.some((group) => !positiveId(group.id))) {
          throw captureError("INVALID_ASSIGNMENT_IDENTITY");
        }
        if (endpoint === "submissions" && result.items.some((submission) => !positiveId(submission.assignment_id)
            || (submission.user_id !== undefined && submission.user_id !== expectedUserId))) {
          throw captureError("INVALID_SUBMISSION_IDENTITY");
        }
        if (endpoint === "modules" && result.items.some((module) => !positiveId(module.id))) {
          throw captureError("INVALID_MODULE_IDENTITY");
        }
        if (endpoint === "discussions" && result.items.some((topic) => !positiveId(topic.id))) {
          throw captureError("INVALID_DISCUSSION_IDENTITY");
        }
        if (endpoint === "discussions") {
          const assignmentRows = courseReads.get("assignments")?.items ?? [];
          const hydrated = hydrateDiscussionAssignmentRubrics(result.items, assignmentRows);
          result.items = hydrated.items;
          if (hydrated.unmatchedCount > 0) {
            const assignmentCoverage = coverage.find((row) => row.endpoint === "assignments" && row.courseId === courseId);
            if (assignmentCoverage) {
              assignmentCoverage.status = "incomplete";
              assignmentCoverage.reason = "request-failed";
            }
          }
          if (hydrated.assignmentsUpdated) {
            const assignmentResource = resources.find((resource) => resource.endpoint === "assignments"
              && resource.courseId === courseId);
            if (assignmentResource) {
              assignmentResource.items = [];
              for (let index = 0; index < assignmentRows.length; index += 1) {
                assignmentResource.items.push(await sanitizeCanvasCaptureItem(assignmentRows[index], {
                  endpoint: "assignments", courseId, itemIndex: index, evaluatePage, htmlReader,
                }));
              }
            }
          }
        }
        if (endpoint === "quizzes" && result.items.some((quiz) => !positiveId(quiz.id))) {
          throw captureError("INVALID_QUIZ_IDENTITY");
        }
        if (endpoint === "courseFiles") {
          for (const file of result.items) {
            if (!positiveId(file.id) || (courseFileIds.size >= MAX_ACCOUNT_FILE_IDS && !courseFileIds.has(file.id))) {
              addNotAttemptedGap("file", courseId, undefined, "detail-budget");
            } else courseFileIds.add(file.id);
          }
        }
        await addResource(endpoint, courseId, result);
        courseReads.set(endpoint, result);
      }

      const pagesRead = courseReads.get("pages");
      if (pagesRead) {
        for (const pageItem of pagesRead.items) {
          const slug = pageItem.url;
          const safeSlug = isSafePageSlug(slug);
          const pageId = pageItem.page_id;
          if (pageItem.published !== true || pageItem.locked_for_user === true || pageItem.locked === true
              || !positiveId(pageId)) {
            const reason = pageItem.locked_for_user === true || pageItem.locked === true ? "locked"
              : pageItem.published === false ? "unpublished"
                : "invalid-slug";
            addNotAttemptedGap("page", courseId, undefined, reason);
            continue;
          }
          if (!reserveDetailRequest("page", courseId)) continue;
          const { result, gap } = await readEndpoint("page", {
            courseId,
            ...(safeSlug ? { pageSlug: slug } : { pageId }),
          });
          if (gap) {
            markBodyDetailOmission("pages", "page", courseId, pageId, "page_id");
            continue;
          }
          if (result.items.length !== 1 || result.items[0].page_id !== pageId
              || safeSlug && result.items[0].url !== slug) throw captureError("PAGE_IDENTITY_MISMATCH");
          await addResource("page", courseId, result);
        }
      } else {
        addNotAttemptedGap("page", courseId, undefined, "parent-unavailable");
      }

      const modulesRead = courseReads.get("modules");
      if (modulesRead) {
        for (const module of modulesRead.items) {
          if (!isReadableModule(module)) {
            const reason = module.locked_for_user === true || module.state === "locked" ? "locked"
              : module.published === false ? "unpublished" : "request-failed";
            addNotAttemptedGap("moduleItems", courseId, undefined, reason);
            continue;
          }
          if (!reserveDetailRequest("moduleItems", courseId)) continue;
          const { result, gap } = await readEndpoint("moduleItems", { courseId, moduleId: module.id });
          if (gap) continue;
          if (result.items.some((item) => item.module_id !== undefined && item.module_id !== module.id)) {
            throw captureError("INVALID_MODULE_IDENTITY");
          }
          await addResource("moduleItems", courseId, result);
        }
      } else {
        addNotAttemptedGap("moduleItems", courseId, undefined, "parent-unavailable");
      }

      const discussionsRead = courseReads.get("discussions");
      if (discussionsRead) {
        for (const topic of discussionsRead.items) {
          if (!isReadablePublished(topic)) {
            const reason = topic.locked_for_user === true || topic.locked === true ? "locked"
              : topic.published === false ? "unpublished" : "request-failed";
            addNotAttemptedGap("discussionEntries", courseId, undefined, reason);
            addNotAttemptedGap("discussionReplies", courseId, undefined, reason);
            continue;
          }
          if (!reserveDetailRequest("discussionEntries", courseId)) continue;
          const entriesRead = await readEndpoint("discussionEntries", { courseId, topicId: topic.id });
          if (entriesRead.gap) continue;
          if (entriesRead.result.items.some((entry) => !positiveId(entry.id))) {
            throw captureError("INVALID_DISCUSSION_ENTRY_IDENTITY");
          }
          await addResource("discussionEntries", courseId, entriesRead.result);
          for (const entry of entriesRead.result.items) {
            if (!reserveDetailRequest("discussionReplies", courseId)) continue;
            const repliesRead = await readEndpoint("discussionReplies", {
              courseId,
              topicId: topic.id,
              entryId: entry.id,
            });
            if (repliesRead.gap) continue;
            // Canvas scopes this endpoint to the top-level entry. A reply may name an
            // intermediate reply as its immediate parent, so parent_id need not equal entry.id.
            if (repliesRead.result.items.some((reply) => !positiveId(reply.id)
                || (reply.parent_id !== undefined && !positiveId(reply.parent_id)))) {
              throw captureError("INVALID_DISCUSSION_ENTRY_IDENTITY");
            }
            await addResource("discussionReplies", courseId, repliesRead.result);
          }
        }
      } else {
        addNotAttemptedGap("discussionEntries", courseId, undefined, "parent-unavailable");
        addNotAttemptedGap("discussionReplies", courseId, undefined, "parent-unavailable");
      }

      const assignmentsRead = courseReads.get("assignments");
      const submissionsRead = courseReads.get("submissions");
      if (assignmentsRead && submissionsRead) {
        const assignmentsById = new Map(assignmentsRead.items.map((assignment) => [assignment.id, assignment]));
        const submissionAssignmentIds = new Set();
        for (const submission of submissionsRead.items) {
          const assignmentId = submission.assignment_id;
          if (submissionAssignmentIds.has(assignmentId)) continue;
          submissionAssignmentIds.add(assignmentId);
          const assignment = assignmentsById.get(assignmentId);
          if (!assignment) throw captureError("SUBMISSION_ASSIGNMENT_MISMATCH");
          if (assignment.published !== true || assignment.locked_for_user === true || assignment.locked === true) {
            const reason = assignment.locked_for_user === true || assignment.locked === true ? "locked"
              : assignment.published === false ? "unpublished" : "request-failed";
            addNotAttemptedGap("submission", courseId, undefined, reason);
            continue;
          }
          if (!reserveDetailRequest("submission", courseId)) continue;
          const { result, gap } = await readEndpoint("submission", { courseId, assignmentId });
          if (gap) continue;
          if (result.items.length !== 1 || result.items[0].assignment_id !== assignmentId
              || result.items[0].user_id !== expectedUserId) throw captureError("SUBMISSION_ASSIGNMENT_MISMATCH");
          await addResource("submission", courseId, result);
        }
      }

      const quizzesRead = courseReads.get("quizzes");
      if (quizzesRead) {
        for (const quiz of quizzesRead.items) {
          if (!isReadablePublished(quiz)) {
            const reason = quiz.locked_for_user === true || quiz.locked === true ? "locked"
              : quiz.published === false ? "unpublished" : "request-failed";
            addNotAttemptedGap("quiz", courseId, undefined, reason);
            continue;
          }
          if (!reserveDetailRequest("quiz", courseId)) continue;
          const { result, gap } = await readEndpoint("quiz", { courseId, quizId: quiz.id });
          if (gap) {
            markBodyDetailOmission("quizzes", "quiz", courseId, quiz.id);
            continue;
          }
          if (result.items.length !== 1 || result.items[0].id !== quiz.id) throw captureError("QUIZ_IDENTITY_MISMATCH");
          await addResource("quiz", courseId, result);
        }
      } else {
        const parentReason = coverage.find((row) => row.endpoint === "quizzes"
          && row.courseId === courseId && row.status === "gap")?.reason;
        addNotAttemptedGap("quiz", courseId, undefined,
          parentReason === "not-found" ? "not-applicable" : "parent-unavailable");
      }
    }

    await collectCanvasAccountCapture({
      readEndpoint,
      addResource,
      addNotAttemptedGap,
      markBodyDetailOmission,
      reserveDetailRequest,
      courseFileIds,
      courseIds,
      expectedUserId,
      accountId: observedAccountId,
    });

    for (const [fileId, reference] of linkedFileReferences) {
      if (listedFileIds.has(fileId)
          || fetchedFileDetailContexts.has(fileDetailContextKey(fileId, reference.courseId, reference.groupId))) continue;
      if (linkedFileDetailRequestCount >= MAX_LINKED_FILE_DETAIL_REQUESTS) {
        addNotAttemptedGap("file", reference.courseId, reference.groupId, "detail-budget");
        continue;
      }
      if (!reserveDetailRequest("file", reference.courseId, reference.groupId)) continue;
      linkedFileDetailRequestCount += 1;
      const { result, gap } = await readEndpoint("file", {
        fileId,
        ...(reference.groupId === undefined ? {} : { groupId: reference.groupId }),
      }, { linkedFile: true, linkedContext: reference });
      if (gap) continue;
      if (result.items.length !== 1 || result.items[0].id !== fileId) throw captureError("FILE_IDENTITY_MISMATCH");
      await addResource("file", reference.courseId, result, {
        ...(reference.groupId === undefined ? {} : { groupId: reference.groupId }),
      });
    }

    const fileBodyReceipts = fileCapture.finish();
    if (fileBodyReceipts.length > 0) {
      resources.push({ endpoint: "fileBodies", courseId: null, items: fileBodyReceipts, pages: 1 });
    }
    if (!canvasFileBodiesComplete(fileBodyReceipts)) {
      const notAttemptedReasons = new Set([
        "download-not-configured", "file-count-limit", "invalid-or-oversized-file-size", "source-url-unavailable",
      ]);
      const reason = fileBodyReceipts.some((receipt) => receipt.status === "gap"
          && notAttemptedReasons.has(receipt.reason))
        ? "not-attempted" : "request-failed";
      addNotAttemptedGap("fileBodies", null, undefined, reason);
    } else if (fileBodyReceipts.some((receipt) => receipt.reason === "empty")) {
      addNotAttemptedGap("fileBodies", null, undefined, "empty");
    }
    const identity = { origin: ORIGIN, userId: expectedUserId };
    if (observedAccountId !== undefined) identity.accountId = observedAccountId;
    const snapshot = {
      schemaVersion: 2,
      source: "canvas-browser",
      runId,
      generationId,
      capturedAt: capturedAt.toISOString(),
      complete: false,
      identity,
      activeCourses: { complete: true, courseIds: [...activeCourseIds].sort((left, right) => left - right) },
      coverageRequirements: {
        activeCoursesComplete: true,
        perActiveCourse: ["course", "assignments", "assignmentGroups", "submissions"],
      },
      resources,
      coverage,
    };
    const outcome = summarizeCanvasCaptureOutcome(snapshot);
    snapshot.complete = outcome.requiredGapCount === 0
      && outcome.failureGapCount === 0 && !outcome.fileBodiesIncomplete;
    output = snapshot;
  } catch (error) {
    failure = captureError(publicErrorCode(error));
  } finally {
    if (progressBinding) {
      try {
        await progressBinding.dispose();
      } catch {
        failure = captureError("READER_PROGRESS_BINDING_UNAVAILABLE");
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (output === undefined) throw captureError("REQUEST_FAILED");
  return output;
}
