const REQUIRED_COURSE_ENDPOINTS = Object.freeze([
  "course", "assignments", "assignmentGroups", "submissions",
  "pages", "modules", "announcements", "courseFiles",
]);
const REQUIRED_ACCOUNT_ENDPOINTS = Object.freeze([
  // The native Inbox projection requires each of the four Canvas lists.
  "inbox", "inboxAll", "conversationsSent", "conversationsArchived",
]);
const REQUIRED_DETAIL_ENDPOINTS = new Set(["conversation"]);
const REQUIRED_LIST_ENDPOINTS = new Set([...REQUIRED_COURSE_ENDPOINTS, ...REQUIRED_ACCOUNT_ENDPOINTS]);
const NON_APPLICABLE_REASONS = new Set([
  "locked", "unpublished", "not-applicable", "unsupported",
]);
const COVERAGE_REASONS = new Set([
  "capture-budget", "disabled", "detail-budget", "forbidden-optional", "invalid-slug",
  "locked", "not-applicable", "not-attempted", "not-found", "pagination-budget",
  "parent-unavailable", "request-failed", "unsupported", "unpublished",
]);
const MAX_SUMMARY_COUNT = 100_000;

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

function bounded(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SUMMARY_COUNT) {
    throw new Error("CAPTURE_BUDGET_EXCEEDED");
  }
  return value;
}

/**
 * Summarizes the fixed daily pages independently from the always-partial archive contract.
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
  const addGap = (count = 1) => { requiredGapCount += count; };

  for (const courseId of snapshot.activeCourses.courseIds) {
    for (const endpoint of REQUIRED_COURSE_ENDPOINTS) {
      const rows = scopeRows(coverage, endpoint, courseId);
      if (rows.length !== 1 || rows[0]?.status !== "complete"
          || !hasResource(resources, endpoint, courseId)) addGap();
      for (const row of rows) requiredListRows.add(row);
    }
  }
  for (const endpoint of REQUIRED_ACCOUNT_ENDPOINTS) {
    const rows = scopeRows(coverage, endpoint, null);
    if (rows.length !== 1 || rows[0]?.status !== "complete"
        || !hasResource(resources, endpoint, null)) addGap();
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
  addGap(Math.max(
    0,
    summaries.size - details.size,
    summaries.size - completeDetails,
    details.size - summaries.size,
    missingDetailIds,
    unexpectedDetailIds,
    invalidSummaryIds,
    invalidDetailIds,
    conversationRows.length - summaries.size,
    detailResources.length - details.size,
  ));

  for (const row of coverage) {
    if (row.status === "complete" || row.endpoint === "fileBodies") continue;
    const activeScope = row.courseId == null || activeCourseIds.has(row.courseId);
    if (!activeScope) continue;
    if (requiredListRows.has(row) || row.endpoint === "conversation") continue;
    // Calendar is a separate native iCal lane. Its archive marker and failures are
    // represented by nativeCalendarStatus, not Canvas daily-scope omissions.
    if (row.endpoint === "calendar" || row.endpoint === "calendarEvents") continue;
    const explicitOptionalAccess = row.status === "gap"
      && ["forbidden-optional", "not-found"].includes(row.reason);
    if (row.status === "incomplete") {
      if (row.endpoint !== "conversation") addGap();
      continue;
    }
    if (NON_APPLICABLE_REASONS.has(row.reason)) {
      omissionCount += 1;
      continue;
    }
    if (explicitOptionalAccess && !REQUIRED_LIST_ENDPOINTS.has(row.endpoint)
        && !REQUIRED_DETAIL_ENDPOINTS.has(row.endpoint)) {
      omissionCount += 1;
      continue;
    }
    if (REQUIRED_LIST_ENDPOINTS.has(row.endpoint) || REQUIRED_DETAIL_ENDPOINTS.has(row.endpoint)
        || !explicitOptionalAccess) addGap();
  }

  const courseFiles = resources.filter((resource) => resource.endpoint === "courseFiles"
    && snapshot.activeCourses.courseIds.includes(resource.courseId)
    && resource.groupId == null && resource.contextCode == null);
  const activeFileIds = new Set(courseFiles.flatMap((resource) => resource.items
    .map((file) => file?.id).filter(positiveId)));
  const fileReceipts = new Map();
  const fileBodyResources = resources.filter((resource) => resource.endpoint === "fileBodies");
  for (const resource of fileBodyResources) {
    for (const receipt of resource.items) {
      if (!positiveId(receipt?.fileId) || fileReceipts.has(receipt.fileId)) continue;
      fileReceipts.set(receipt.fileId, receipt);
      if (activeFileIds.has(receipt.fileId) && receipt.status === "gap"
          && NON_APPLICABLE_REASONS.has(receipt.reason)) omissionCount += 1;
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
      const receipt = fileReceipts.get(file.id);
      if (!receipt || receipt.status !== "staged" && !NON_APPLICABLE_REASONS.has(receipt.reason)) addGap();
    }
  }

  return {
    requiredGapCount: bounded(requiredGapCount),
    omissionCount: bounded(omissionCount),
  };
}

/** Strict broker-boundary validation for the content-free summary. */
export function validCanvasRefreshScopeSummary(value) {
  return isRecord(value) && Object.keys(value).length === 2
    && Object.hasOwn(value, "requiredGapCount") && Object.hasOwn(value, "omissionCount")
    && Number.isSafeInteger(value.requiredGapCount) && value.requiredGapCount >= 0
    && value.requiredGapCount <= MAX_SUMMARY_COUNT
    && Number.isSafeInteger(value.omissionCount) && value.omissionCount >= 0
    && value.omissionCount <= MAX_SUMMARY_COUNT;
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
  return COVERAGE_REASONS.has(value.reason);
}
