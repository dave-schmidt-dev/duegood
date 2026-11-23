import { canvasFileBodiesComplete, isCanvasFileBodyOmission } from "./canvas-browser-capture-files.mjs";

const REQUIRED_COURSE_ENDPOINTS = Object.freeze([
  "course", "assignments", "assignmentGroups", "submissions",
  "pages", "modules", "announcements", "courseFiles",
]);
const REQUIRED_ACCOUNT_ENDPOINTS = Object.freeze([
  // The native Inbox projection requires each of the four Canvas lists.
  "inbox", "inboxAll", "conversationsSent", "conversationsArchived",
]);
const NON_APPLICABLE_REASONS = new Set(["locked", "unpublished", "not-applicable"]);
const DISABLED_REASON = "disabled";
const OPTIONAL_ACCESS_REASONS = new Set(["forbidden-optional", "not-found"]);
const SINGLETON_LIST_ENDPOINTS = new Set([
  "profile", "coursesActive", "coursesCompleted", "course", "courseTabs", "assignments",
  "assignmentGroups", "submissions", "pages", "modules", "discussions", "announcements",
  "quizzes", "courseFiles", "folders", "groups", "personalFiles", "personalFolders",
  "inbox", "inboxAll", "conversationsSent", "conversationsArchived", "groupFolders",
  "groupPages", "groupDiscussions", "calendarEvents",
]);
const BODY_ENDPOINT_FAMILY = new Map([
  ["assignments", "assignment"],
  ["discussions", "discussion"],
  ["announcements", "announcement"],
  ["quizzes", "quiz"],
  ["quiz", "quiz"],
  ["pages", "page"],
  ["page", "page"],
  ["groupDiscussions", "group-discussion"],
  ["groupPages", "group-page"],
  ["groupPage", "group-page"],
]);
const BODY_OMISSION_REASONS = new Set([
  "forbidden-optional", "locked", "not-applicable", "not-found", "unpublished",
]);
const COVERAGE_REASONS = new Set([
  "capture-budget", "disabled", "detail-budget", "forbidden-optional", "invalid-slug",
  "locked", "not-applicable", "not-attempted", "not-found", "pagination-budget",
  "parent-unavailable", "request-failed", "unsupported", "unpublished",
]);
const MAX_SUMMARY_COUNT = 100_000;
const MAX_ARCHIVED_FILE_BYTES = 256 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeRows(coverage, endpoint, courseId) {
  return coverage.filter((row) => row.endpoint === endpoint
    && (row.courseId ?? null) === courseId
    && row.groupId == null && row.contextCode == null);
}

function hasResource(resources, endpoint, courseId) {
  return resources.filter((resource) => resource.endpoint === endpoint
    && (resource.courseId ?? null) === courseId
    && resource.groupId == null && resource.contextCode == null).length === 1;
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validArchivedFileReceipt(receipt, fileId) {
  const validBytes = receipt?.fileId === fileId
    && Number.isSafeInteger(receipt.byteCount) && receipt.byteCount > 0
    && receipt.byteCount <= MAX_ARCHIVED_FILE_BYTES
    && typeof receipt.sha256 === "string" && /^[a-f0-9]{64}$/u.test(receipt.sha256)
    && typeof receipt.contentType === "string"
    && /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/u.test(receipt.contentType)
    && receipt.sourceAuthenticity === "unverified";
  if (!validBytes) return false;
  if (receipt.status === "archived") return true;
  return receipt.status === "staged"
    && typeof receipt.stagedFile === "string" && /^[a-f0-9]{32}\.blob$/u.test(receipt.stagedFile)
    && (receipt.expectedSize === null || Number.isSafeInteger(receipt.expectedSize)
      && receipt.expectedSize >= 0 && receipt.expectedSize === receipt.byteCount);
}

function sameScope(left, right) {
  return (left.courseId ?? null) === (right.courseId ?? null)
    && (left.groupId ?? null) === (right.groupId ?? null)
    && (left.contextCode ?? null) === (right.contextCode ?? null);
}

function rowsAtScope(coverage, endpoint, scope = {}) {
  return coverage.filter((row) => row.endpoint === endpoint && sameScope(row, scope));
}

function resourcesAtScope(resources, endpoint, scope = {}) {
  return resources.filter((resource) => resource.endpoint === endpoint && sameScope(resource, scope));
}

function resourceEndpointForCoverage(row) {
  if (row.endpoint === "groupFolders") return "folders";
  if (row.endpoint === "groupPages") return "pages";
  if (row.endpoint === "groupDiscussions") return "discussions";
  if (row.endpoint === "groupFolderFiles") return "courseFiles";
  if (row.endpoint === "groupPage") return "page";
  if (row.endpoint === "groupDiscussionEntries") return "discussionEntries";
  if (row.endpoint === "groupDiscussionReplies") return "discussionReplies";
  return row.endpoint;
}

function parentEndpointFor(row) {
  if (row.endpoint === "file") return row.groupId != null ? "groupFolderFiles" : "courseFiles";
  if (row.endpoint === "page") return row.groupId != null ? "groupPages" : "pages";
  if (["discussionEntries", "discussionReplies"].includes(row.endpoint)) {
    return row.groupId != null ? "groupDiscussions" : "discussions";
  }
  if (row.endpoint === "moduleItems") return "modules";
  if (row.endpoint === "submission") return "assignments";
  if (row.endpoint === "quiz") return "quizzes";
  if (row.endpoint === "personalFile") return "personalFiles";
  if (row.endpoint === "groupFolderFiles") return "groupFolders";
  if (row.endpoint === "groupPage") return "groupPages";
  if (["groupDiscussionEntries", "groupDiscussionReplies"].includes(row.endpoint)) return "groupDiscussions";
  return undefined;
}

function isCanvasOmission(row, coverage, resources) {
  if (row.status !== "gap") return false;
  if (row.reason === "empty") return row.endpoint === "fileBodies" && resources.some((resource) =>
    resource.endpoint === "fileBodies" && resource.items.some((item) => item.status === "gap" && item.reason === "empty"));
  if (SINGLETON_LIST_ENDPOINTS.has(row.endpoint)
      && resourcesAtScope(resources, resourceEndpointForCoverage(row), row).length > 0) return false;
  if (NON_APPLICABLE_REASONS.has(row.reason) || row.reason === DISABLED_REASON
      || OPTIONAL_ACCESS_REASONS.has(row.reason)) return true;
  if (row.reason !== "parent-unavailable") return false;
  const parentEndpoint = parentEndpointFor(row);
  if (parentEndpoint === undefined) return false;
  const parents = rowsAtScope(coverage, parentEndpoint, row);
  return parents.length === 1 && isCanvasOmission(parents[0], coverage, resources);
}

function bounded(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SUMMARY_COUNT) {
    throw new Error("CAPTURE_BUDGET_EXCEEDED");
  }
  return value;
}

function validCanvasBody(value) {
  if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.html !== "string"
      || typeof value.text !== "string" || typeof value.empty !== "boolean") return false;
  const encoder = new TextEncoder();
  if (encoder.encode(value.html).length > 512 * 1024
      || encoder.encode(value.text).length > 512 * 1024) return false;
  return !value.empty || value.html.length === 0 && value.text.length === 0;
}

function bodyIdentity(resource, item, index) {
  const family = BODY_ENDPOINT_FAMILY.get(resource.endpoint);
  const scope = [resource.courseId ?? null, resource.groupId ?? null, resource.contextCode ?? null];
  const id = item?.id ?? item?.page_id ?? item?.url;
  return JSON.stringify([family, ...scope, id ?? `${resource.endpoint}:${index}`]);
}

function inaccessibleBodyListing(endpoint, item) {
  return ["pages", "groupPages", "quizzes"].includes(endpoint)
    && (item?.locked_for_user === true || item?.locked === true || item?.published === false);
}

function activeBodyScope(resource, activeCourseIds, activeGroupIds) {
  if (positiveId(resource.courseId)) return activeCourseIds.has(resource.courseId);
  if (positiveId(resource.groupId)) return activeGroupIds.has(resource.groupId);
  const courseContext = /^course_([1-9]\d*)$/u.exec(resource.contextCode ?? "");
  if (courseContext) return activeCourseIds.has(Number(courseContext[1]));
  const groupContext = /^group_([1-9]\d*)$/u.exec(resource.contextCode ?? "");
  return groupContext !== null && activeGroupIds.has(Number(groupContext[1]));
}

function bodyListingOmission(resource, item, credits) {
  const detailEndpoint = {
    pages: resource.groupId == null ? "page" : "groupPage",
    quizzes: "quiz",
    groupPages: "groupPage",
  }[resource.endpoint];
  if (detailEndpoint === undefined) return false;
  const marker = BODY_OMISSION_REASONS.has(item?._canvasBodyOmissionReason)
    ? item._canvasBodyOmissionReason : null;
  const inferred = item?.locked_for_user === true || item?.locked === true ? "locked"
    : item?.published === false ? "unpublished" : null;
  const reason = marker ?? inferred;
  if (reason === null) return false;
  const key = JSON.stringify([detailEndpoint, resource.courseId ?? null, resource.groupId ?? null,
    resource.contextCode ?? null, reason]);
  const available = credits.get(key) ?? 0;
  if (available === 0) return false;
  credits.set(key, available - 1);
  return true;
}

function bodyOmissionCredits(coverage) {
  const credits = new Map();
  for (const row of coverage) {
    if (row.status !== "gap" || !BODY_OMISSION_REASONS.has(row.reason)
        || !["page", "quiz", "groupPage"].includes(row.endpoint)) continue;
    const endpoint = row.endpoint === "page" && row.groupId != null ? "groupPage" : row.endpoint;
    const key = JSON.stringify([endpoint, row.courseId ?? null, row.groupId ?? null,
      row.contextCode ?? null, row.reason]);
    credits.set(key, (credits.get(key) ?? 0) + 1);
  }
  return credits;
}

/** Counts successful body envelopes and failures without exposing body text. */
function summarizeBodyCoverage(resources, activeCourseIds, coverage) {
  const activeGroups = new Set();
  for (const resource of resources.filter((candidate) => candidate.endpoint === "groups")) {
    for (const group of resource.items) {
      const courseId = group?.course_id ?? group?.courseId;
      if (positiveId(group?.id) && positiveId(courseId) && activeCourseIds.has(courseId)) {
        activeGroups.add(group.id);
      }
    }
  }
  const grouped = new Map();
  const omissionCredits = bodyOmissionCredits(coverage);
  for (const resource of resources) {
    if (!BODY_ENDPOINT_FAMILY.has(resource.endpoint) || !Array.isArray(resource.items)) continue;
    resource.items.forEach((item, index) => {
      const key = bodyIdentity(resource, item, index);
      const body = item?._canvasBody;
      const valid = validCanvasBody(body);
      const bodyReason = item?._canvasBodyReason;
      const reason = bodyReason === "BODY_MISSING" ? "BODY_MISSING"
        : bodyReason === "BODY_SANITIZE_FAILED" ? "BODY_SANITIZE_FAILED"
          : bodyReason !== undefined ? "BODY_SANITIZE_FAILED"
            : body === undefined ? "BODY_MISSING" : valid ? null : "BODY_SANITIZE_FAILED";
      const entry = grouped.get(key) ?? { validBody: null, failureReason: null, omitted: false, active: false };
      const omissionConfirmed = bodyListingOmission(resource, item, omissionCredits);
      if (omissionConfirmed && (inaccessibleBodyListing(resource.endpoint, item) || reason === "BODY_MISSING")) {
        if (entry.validBody === null && entry.failureReason !== "BODY_SANITIZE_FAILED") entry.omitted = true;
        entry.active ||= activeBodyScope(resource, activeCourseIds, activeGroups);
        grouped.set(key, entry);
        return;
      }
      if (valid && reason === null) {
        entry.validBody = body;
        entry.omitted = false;
      } else if (reason === "BODY_SANITIZE_FAILED") {
        entry.failureReason = reason;
        entry.omitted = false;
      } else if (entry.failureReason === null) entry.failureReason = reason;
      entry.active ||= activeBodyScope(resource, activeCourseIds, activeGroups);
      grouped.set(key, entry);
    });
  }
  let bodyCount = 0;
  let emptyBodyCount = 0;
  let requiredFailures = 0;
  let missingCount = 0;
  let sanitizeFailedCount = 0;
  for (const entry of grouped.values()) {
    if (entry.validBody !== null) {
      bodyCount += 1;
      if (entry.validBody.empty) emptyBodyCount += 1;
    } else if (!entry.omitted && entry.failureReason === "BODY_MISSING") {
      missingCount += 1;
      if (entry.active) requiredFailures += 1;
    } else if (!entry.omitted && entry.failureReason === "BODY_SANITIZE_FAILED") {
      sanitizeFailedCount += 1;
      if (entry.active) requiredFailures += 1;
    }
  }
  return { bodyCount, emptyBodyCount, requiredFailures, missingCount, sanitizeFailedCount };
}

/**
 * Summarizes the fixed daily pages independently of the full archive.
 * Only bounded counts cross the local broker and app bridge; source values stay in the archive.
 */
export function summarizeCanvasRefreshScope(snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.activeCourses?.courseIds)
      || !Array.isArray(snapshot.coverage) || !Array.isArray(snapshot.resources)) {
    throw new Error("CAPTURE_SCOPE_SHAPE_REJECTED");
  }
  const { coverage, resources } = snapshot;
  const activeCourseIds = new Set(snapshot.activeCourses.courseIds);
  let requiredGapCount = 0;
  let omissionCount = 0;
  const requiredListRows = new Set();
  const bodyCoverage = summarizeBodyCoverage(resources, activeCourseIds, coverage);
  const addGap = (count = 1) => { requiredGapCount += count; };

  for (const courseId of snapshot.activeCourses.courseIds) {
    for (const endpoint of REQUIRED_COURSE_ENDPOINTS) {
      const rows = scopeRows(coverage, endpoint, courseId);
      if (rows.length !== 1 || rows[0]?.status !== "complete"
          || !hasResource(resources, endpoint, courseId)) {
        const omissions = rows.filter((row) => isCanvasOmission(row, coverage, resources));
        omissionCount += omissions.length;
        if (omissions.length !== 1 || rows.length !== 1) addGap();
      }
      for (const row of rows) requiredListRows.add(row);
    }
  }
  addGap(bodyCoverage.requiredFailures);
  for (const endpoint of REQUIRED_ACCOUNT_ENDPOINTS) {
    const rows = scopeRows(coverage, endpoint, null);
    if (rows.length !== 1 || rows[0]?.status !== "complete"
        || !hasResource(resources, endpoint, null)) {
      const omissions = rows.filter((row) => isCanvasOmission(row, coverage, resources));
      omissionCount += omissions.length;
      if (omissions.length !== 1 || rows.length !== 1) addGap();
    }
    for (const row of rows) requiredListRows.add(row);
  }

  const summaries = new Set();
  let invalidSummaryIds = 0;
  for (const endpoint of REQUIRED_ACCOUNT_ENDPOINTS) {
    for (const resource of resources.filter((candidate) => candidate.endpoint === endpoint
        && candidate.courseId == null && candidate.groupId == null && candidate.contextCode == null)) {
      for (const item of resource.items) {
        if (positiveId(item?.id)) summaries.add(item.id);
        else invalidSummaryIds += 1;
      }
    }
  }
  const detailResources = resources.filter((resource) => resource.endpoint === "conversation"
    && resource.courseId == null && resource.groupId == null && resource.contextCode == null);
  let invalidDetailIds = 0;
  const details = new Set();
  for (const resource of detailResources) {
    for (const item of resource.items) {
      if (positiveId(item?.id)) details.add(item.id);
      else invalidDetailIds += 1;
    }
  }
  const missingDetailIds = [...summaries].filter((id) => !details.has(id)).length;
  const unexpectedDetailIds = [...details].filter((id) => !summaries.has(id)).length;
  const conversationRows = scopeRows(coverage, "conversation", null);
  let completeDetails = 0;
  for (const row of conversationRows) if (row.status === "complete") completeDetails += 1;
  const missingConversationDetails = Math.max(0, summaries.size - details.size);
  const omittedConversationDetails = Math.min(missingConversationDetails,
    conversationRows.filter((row) => isCanvasOmission(row, coverage, resources)).length);
  omissionCount += omittedConversationDetails;
  addGap(Math.max(
    0,
    missingConversationDetails - omittedConversationDetails,
    summaries.size - completeDetails - omittedConversationDetails,
    details.size - summaries.size,
    missingDetailIds - omittedConversationDetails,
    unexpectedDetailIds,
    invalidSummaryIds,
    invalidDetailIds,
    Math.abs(conversationRows.length - summaries.size),
    conversationRows.filter((row) => isCanvasOmission(row, coverage, resources)).length - omittedConversationDetails,
    detailResources.length - details.size,
  ));

  for (const row of coverage) {
    if (row.status === "complete" || row.endpoint === "fileBodies" || row.groupId != null
        || row.endpoint === "personalFile" && row.courseId == null) continue;
    const activeScope = row.courseId == null || activeCourseIds.has(row.courseId);
    if (!activeScope) continue;
    if (requiredListRows.has(row) || row.endpoint === "conversation") continue;
    // Calendar is a separate native iCal lane. Its archive marker and failures are
    // represented by nativeCalendarStatus, not Canvas daily-scope omissions.
    if (row.endpoint === "calendar" || row.endpoint === "calendarEvents") continue;
    if (row.status === "incomplete") {
      if (row.endpoint !== "conversation") addGap();
      continue;
    }
    if (isCanvasOmission(row, coverage, resources)) {
      omissionCount += 1;
      continue;
    }
    addGap();
  }

  const courseFiles = resources.filter((resource) => resource.endpoint === "courseFiles"
    && snapshot.activeCourses.courseIds.includes(resource.courseId)
    && resource.groupId == null && resource.contextCode == null);
  const activeFileIds = new Set(courseFiles.flatMap((resource) => resource.items
    .map((file) => file?.id).filter(positiveId)));
  const linkedFileIds = new Set();
  for (const courseId of activeCourseIds) {
    const fileResources = resourcesAtScope(resources, "file", { courseId });
    const completeRows = rowsAtScope(coverage, "file", { courseId })
      .filter((row) => row.status === "complete");
    addGap(Math.abs(completeRows.length - fileResources.length));

    for (const resource of fileResources) {
      if (!Array.isArray(resource.items) || resource.items.length !== 1
          || !positiveId(resource.items[0]?.id)) {
        addGap();
        continue;
      }
      const fileId = resource.items[0].id;
      if (activeFileIds.has(fileId)) continue;
      if (linkedFileIds.has(fileId)) {
        addGap();
        continue;
      }
      linkedFileIds.add(fileId);
    }
  }
  for (const fileId of linkedFileIds) activeFileIds.add(fileId);
  const omissionFileIds = new Set(activeFileIds);
  for (const resource of resources.filter((candidate) => candidate.endpoint === "personalFiles"
      && candidate.courseId == null && candidate.groupId == null && candidate.contextCode == null)) {
    for (const item of resource.items) if (positiveId(item?.id)) omissionFileIds.add(item.id);
  }
  const fileReceipts = new Map();
  const fileBodyResources = resources.filter((resource) => resource.endpoint === "fileBodies");
  for (const resource of fileBodyResources) {
    for (const receipt of resource.items) {
      if (!positiveId(receipt?.fileId)) continue;
      if (fileReceipts.has(receipt.fileId)) {
        fileReceipts.set(receipt.fileId, null);
        continue;
      }
      fileReceipts.set(receipt.fileId, receipt);
    }
  }
  for (const resource of courseFiles) {
    const seen = new Set();
    for (const file of resource.items) {
      if (!positiveId(file?.id) || seen.has(file.id)) {
        addGap();
        continue;
      }
      seen.add(file.id);
    }
  }
  for (const fileId of activeFileIds) {
    const receipt = fileReceipts.get(fileId);
    if (!receipt) {
      addGap();
      continue;
    }
    if (isCanvasFileBodyOmission(receipt)) {
      omissionCount += 1;
      continue;
    }
    if (!validArchivedFileReceipt(receipt, fileId)) addGap();
  }
  for (const fileId of omissionFileIds) {
    if (activeFileIds.has(fileId)) continue;
    const receipt = fileReceipts.get(fileId);
    if (receipt && isCanvasFileBodyOmission(receipt)) omissionCount += 1;
  }

  return {
    requiredGapCount: bounded(requiredGapCount),
    omissionCount: bounded(omissionCount),
    bodyCount: bounded(bodyCoverage.bodyCount),
    emptyBodyCount: bounded(bodyCoverage.emptyBodyCount),
  };
}

/** Summarizes global capture failures and omissions before archive or native import. */
export function summarizeCanvasCaptureOutcome(snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.activeCourses?.courseIds)
      || !Array.isArray(snapshot.coverage) || !Array.isArray(snapshot.resources)) {
    throw new Error("CAPTURE_SCOPE_SHAPE_REJECTED");
  }

  const dailyScope = summarizeCanvasRefreshScope(snapshot);
  const bodyCoverage = summarizeBodyCoverage(
    snapshot.resources,
    new Set(snapshot.activeCourses.courseIds),
    snapshot.coverage,
  );
  const fileMetadataIds = new Set();
  const zeroSizes = new Set();
  const otherSizes = new Set();
  const personalFileIds = new Set();
  let invalidFileMetadataCount = 0;
  for (const resource of snapshot.resources) {
    if (!["courseFiles", "personalFiles", "file", "personalFile"].includes(resource.endpoint)) continue;
    for (const item of resource.items) {
      if (!positiveId(item?.id)) {
        invalidFileMetadataCount += 1;
        continue;
      }
      if (item.size === 0) zeroSizes.add(item.id);
      else if (item.size != null) otherSizes.add(item.id);
      fileMetadataIds.add(item.id);
      if (resource.endpoint === "personalFiles") personalFileIds.add(item.id);
    }
  }

  const fileBodyResources = snapshot.resources.filter((resource) => resource.endpoint === "fileBodies");
  const fileReceipts = fileBodyResources.flatMap((resource) => resource.items);
  const receiptById = new Map();
  const duplicateReceiptIds = new Set();
  for (const receipt of fileReceipts) {
    if (!positiveId(receipt?.fileId)) continue;
    if (receiptById.has(receipt.fileId)) duplicateReceiptIds.add(receipt.fileId);
    receiptById.set(receipt.fileId, receipt);
  }
  const missingFileBodyCount = [...fileMetadataIds].filter((fileId) => !receiptById.has(fileId)).length;
  const fileBodyFailureEvidence = missingFileBodyCount > 0 || duplicateReceiptIds.size > 0
    || !canvasFileBodiesComplete(fileReceipts);

  let failureGapCount = 0;
  let omissionCount = 0;
  failureGapCount += bodyCoverage.missingCount + bodyCoverage.sanitizeFailedCount;
  failureGapCount += invalidFileMetadataCount;
  for (const row of snapshot.coverage) {
    if (row.status === "complete") continue;
    if (isCanvasOmission(row, snapshot.coverage, snapshot.resources)) {
      // Each confirmed empty body is counted from its individual receipt below.
      if (row.reason !== "empty") omissionCount += 1;
    } else if (row.endpoint !== "fileBodies" || !fileBodyFailureEvidence) {
      failureGapCount += 1;
    }
  }

  const requireListedScope = (endpoint, scope = {}, resourceEndpoint = endpoint) => {
    const rows = rowsAtScope(snapshot.coverage, endpoint, scope);
    if (rows.length !== 1) {
      failureGapCount += 1;
      return;
    }
    if (rows[0].status === "complete" && resourceEndpoint !== null
        && resourcesAtScope(snapshot.resources, resourceEndpoint, scope).length !== 1) {
      failureGapCount += 1;
    }
  };
  for (const endpoint of ["profile", "coursesActive", "coursesCompleted"]) {
    requireListedScope(endpoint);
  }
  for (const endpoint of ["groups", "personalFiles", "personalFolders", ...REQUIRED_ACCOUNT_ENDPOINTS]) {
    requireListedScope(endpoint);
  }

  const courseIds = new Set();
  for (const endpoint of ["coursesActive", "coursesCompleted"]) {
    for (const resource of resourcesAtScope(snapshot.resources, endpoint)) {
      for (const item of resource.items) if (positiveId(item?.id)) courseIds.add(item.id);
    }
  }
  const activeCourseIds = new Set();
  for (const courseId of snapshot.activeCourses.courseIds) {
    if (!positiveId(courseId) || activeCourseIds.has(courseId)) {
      failureGapCount += 1;
      continue;
    }
    activeCourseIds.add(courseId);
    if (!courseIds.has(courseId)) failureGapCount += 1;
    courseIds.add(courseId);
  }
  const allCourseListEndpoints = [
    "course", "courseTabs", "assignments", "assignmentGroups", "submissions", "pages", "modules",
    "discussions", "announcements", "quizzes", "courseFiles", "folders",
  ];
  for (const courseId of courseIds) {
    for (const endpoint of allCourseListEndpoints) requireListedScope(endpoint, { courseId });
  }

  const groupIds = new Set();
  for (const resource of resourcesAtScope(snapshot.resources, "groups")) {
    for (const item of resource.items) {
      if (!positiveId(item?.id) || groupIds.has(item.id)) {
        failureGapCount += 1;
        continue;
      }
      groupIds.add(item.id);
    }
  }
  for (const groupId of groupIds) {
    requireListedScope("groupFolders", { groupId }, "folders");
    requireListedScope("groupPages", { groupId }, "pages");
    requireListedScope("groupDiscussions", { groupId }, "discussions");
    const folderItems = resourcesAtScope(snapshot.resources, "folders", { groupId })
      .flatMap((resource) => resource.items);
    if (folderItems.some((folder) => !positiveId(folder?.id))) failureGapCount += 1;
    const fileListRows = rowsAtScope(snapshot.coverage, "groupFolderFiles", { groupId });
    if (folderItems.length > fileListRows.length && fileListRows.every((row) => row.status === "complete")) {
      failureGapCount += 1;
    }
  }

  const calendarContexts = new Map();
  if (positiveId(snapshot.identity?.userId)) {
    calendarContexts.set(`user_${snapshot.identity.userId}`, { contextCode: `user_${snapshot.identity.userId}` });
  }
  else failureGapCount += 1;
  if (positiveId(snapshot.identity?.accountId)) {
    const contextCode = `account_${snapshot.identity.accountId}`;
    calendarContexts.set(contextCode, { contextCode });
  }
  for (const courseId of courseIds) {
    const contextCode = `course_${courseId}`;
    calendarContexts.set(contextCode, { contextCode, courseId });
  }
  for (const groupId of groupIds) {
    const contextCode = `group_${groupId}`;
    calendarContexts.set(contextCode, { contextCode, groupId });
  }
  for (const scope of calendarContexts.values()) {
    const rows = rowsAtScope(snapshot.coverage, "calendarEvents", scope);
    if (rows.length !== 1) {
      failureGapCount += 1;
      continue;
    }
    if (rows[0].status === "complete" && resourcesAtScope(snapshot.resources, "calendarEvents", scope).length !== 1) {
      failureGapCount += 1;
    }
  }

  let personalFileBodyFailureCount = 0;
  let fileBodiesIncomplete = fileBodyResources.length > 1
    || !canvasFileBodiesComplete(fileReceipts)
    || duplicateReceiptIds.size > 0;
  if (fileBodyResources.length > 1 || duplicateReceiptIds.size > 0) {
    failureGapCount += 1;
  }

  for (const fileId of fileMetadataIds) {
    const receipt = receiptById.get(fileId);
    if (receipt === undefined) {
      fileBodiesIncomplete = true;
      failureGapCount += 1;
      if (personalFileIds.has(fileId)) personalFileBodyFailureCount += 1;
      continue;
    }
    if (receipt.status === "gap" && receipt.reason === "empty" && (!zeroSizes.has(fileId) || otherSizes.has(fileId))) {
      fileBodiesIncomplete = true;
      failureGapCount += 1;
      if (personalFileIds.has(fileId)) personalFileBodyFailureCount += 1;
    } else if (isCanvasFileBodyOmission(receipt)) {
      omissionCount += 1;
    } else if (receipt.status === "gap") {
      failureGapCount += 1;
      if (personalFileIds.has(fileId)) personalFileBodyFailureCount += 1;
    } else if (!validArchivedFileReceipt(receipt, fileId)) {
      fileBodiesIncomplete = true;
      failureGapCount += 1;
      if (personalFileIds.has(fileId)) personalFileBodyFailureCount += 1;
    }
  }

  for (const receipt of fileReceipts) {
    if (!positiveId(receipt?.fileId) || !fileMetadataIds.has(receipt.fileId)) {
      fileBodiesIncomplete = true;
      failureGapCount += 1;
    }
  }

  fileBodiesIncomplete ||= snapshot.coverage.some((row) => row.endpoint === "fileBodies"
    && row.status !== "complete" && !isCanvasOmission(row, snapshot.coverage, snapshot.resources));

  return {
    requiredGapCount: dailyScope.requiredGapCount,
    failureGapCount: bounded(failureGapCount),
    omissionCount: bounded(omissionCount),
    fileBodiesIncomplete,
    personalFileBodyFailureCount: bounded(personalFileBodyFailureCount),
    bodyCount: dailyScope.bodyCount,
    emptyBodyCount: dailyScope.emptyBodyCount,
    bodyFailureReason: bodyCoverage.sanitizeFailedCount > 0 ? "BODY_SANITIZE_FAILED"
      : bodyCoverage.missingCount > 0 ? "BODY_MISSING" : null,
  };
}

/** Strict broker-boundary validation for the content-free summary. */
export function validCanvasRefreshScopeSummary(value) {
  return isRecord(value) && Object.keys(value).length === 4
    && Object.hasOwn(value, "requiredGapCount") && Object.hasOwn(value, "omissionCount")
    && Object.hasOwn(value, "bodyCount") && Object.hasOwn(value, "emptyBodyCount")
    && Number.isSafeInteger(value.requiredGapCount) && value.requiredGapCount >= 0
    && value.requiredGapCount <= MAX_SUMMARY_COUNT
    && Number.isSafeInteger(value.omissionCount) && value.omissionCount >= 0
    && value.omissionCount <= MAX_SUMMARY_COUNT
    && Number.isSafeInteger(value.bodyCount) && value.bodyCount >= 0
    && value.bodyCount <= MAX_SUMMARY_COUNT
    && Number.isSafeInteger(value.emptyBodyCount) && value.emptyBodyCount >= 0
    && value.emptyBodyCount <= value.bodyCount;
}

export function isCanvasCoverageEntry(value) {
  if (!isRecord(value) || !/^[A-Za-z][A-Za-z0-9]{0,47}$/u.test(value.endpoint)
      || !["complete", "gap", "incomplete"].includes(value.status)) return false;
  if (Object.keys(value).some((key) => !["endpoint", "courseId", "groupId", "contextCode", "status", "reason"].includes(key))) return false;
  if (value.courseId !== undefined && value.courseId !== null && !positiveId(value.courseId)) return false;
  if (value.groupId !== undefined && value.groupId !== null && !positiveId(value.groupId)) return false;
  if (value.contextCode !== undefined && value.contextCode !== null
      && (typeof value.contextCode !== "string" || value.contextCode.length > 80)) return false;
  if (value.status === "complete") return value.reason === undefined;
  if (value.reason === "empty") return value.endpoint === "fileBodies" && value.status === "gap";
  return COVERAGE_REASONS.has(value.reason);
}
