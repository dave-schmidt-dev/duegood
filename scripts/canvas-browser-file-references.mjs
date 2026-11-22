const CANVAS_ORIGIN = "https://marymount.instructure.com";
const COURSE_FILE_PATH = /^\/(?:api\/v1\/)?courses\/([1-9]\d*)\/files\/([1-9]\d*)(?:\/(?:download|preview))?\/?$/u;
const USER_FILE_PATH = /^\/(?:api\/v1\/)?files\/([1-9]\d*)(?:\/(?:download|preview))?\/?$/u;
const MAX_ATTACHMENT_REFERENCES = 10_000;

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Extracts a file reference only from a sanitized same-origin Canvas link. */
export function canvasFileReferenceFromLink(link, { courseId, groupId, allowedCourseIds } = {}) {
  if (link?.asciiHostname !== "marymount.instructure.com" || typeof link.safeTarget !== "string") return undefined;
  let target;
  try {
    target = new URL(link.safeTarget);
  } catch {
    return undefined;
  }
  if (target.origin !== CANVAS_ORIGIN || target.username || target.password || target.hash) {
    return undefined;
  }
  const seenQueryKeys = new Set();
  for (const key of target.searchParams.keys()) {
    if (!["page", "per_page", "tab"].includes(key) || seenQueryKeys.has(key)) return undefined;
    seenQueryKeys.add(key);
  }
  const courseMatch = COURSE_FILE_PATH.exec(target.pathname);
  const userMatch = USER_FILE_PATH.exec(target.pathname);
  if (courseMatch) {
    const targetCourseId = Number(courseMatch[1]);
    const fileId = Number(courseMatch[2]);
    return positiveId(targetCourseId) && positiveId(fileId)
      && allowedCourseIds instanceof Set && allowedCourseIds.has(targetCourseId)
      ? { endpoint: "file", courseId: targetCourseId, groupId: undefined, fileId }
      : undefined;
  }
  if (userMatch) {
    const fileId = Number(userMatch[1]);
    return positiveId(fileId) && (positiveId(courseId) || positiveId(groupId))
      ? { endpoint: "file", courseId: positiveId(courseId) ? courseId : null,
        groupId: positiveId(groupId) ? groupId : undefined, fileId }
      : undefined;
  }
  return undefined;
}

/** Reads attachment IDs from an item and its embedded recent replies without truncating silently. */
export function canvasAttachmentFileReferences(item, { courseId, groupId } = {}) {
  if (!positiveId(courseId) && !positiveId(groupId)) return { references: [], overflowed: false };
  const ids = new Set();
  const visited = new Set();
  let overflowed = false;
  let inspectedAttachments = 0;
  let inspectedItems = 0;
  const reference = (value) => {
    const attachments = Array.isArray(value) ? value : [value];
    for (const attachment of attachments) {
      inspectedAttachments += 1;
      if (inspectedAttachments > MAX_ATTACHMENT_REFERENCES) {
        overflowed = true;
        return;
      }
      if (!positiveId(attachment?.id)) continue;
      ids.add(attachment.id);
      if (ids.size > MAX_ATTACHMENT_REFERENCES) {
        overflowed = true;
        return;
      }
    }
  };
  const visit = (value) => {
    if (overflowed || value === null || typeof value !== "object" || visited.has(value)) return;
    inspectedItems += 1;
    if (inspectedItems > MAX_ATTACHMENT_REFERENCES) {
      overflowed = true;
      return;
    }
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === "attachments" || key === "attachment") reference(child);
      else if (key === "recent_replies" && Array.isArray(child)) {
        for (const reply of child) visit(reply);
      }
      if (overflowed) return;
    }
  };
  visit(item);
  const context = positiveId(courseId)
    ? { courseId, groupId: undefined }
    : { courseId: null, groupId };
  const references = [...ids].slice(0, MAX_ATTACHMENT_REFERENCES)
    .map((fileId) => ({ endpoint: "file", ...context, fileId }));
  return { references, overflowed };
}
