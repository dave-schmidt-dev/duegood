import { extractCanvasHtmlInPage, sanitizeCanvasLink } from "./canvas-browser-links.mjs";
import { canvasFileReferenceFromLink } from "./canvas-browser-file-references.mjs";

const ORIGIN = "https://marymount.instructure.com";
const MAX_LINKS_PER_ITEM = 500;
const MAX_BODY_BYTES = 512 * 1024;
const FILE_METADATA_ENDPOINTS = new Set(["courseFiles", "personalFiles", "file", "personalFile"]);
const CANVAS_FILE_PATH = /^\/(?:api\/v1\/)?(?:courses\/[1-9]\d*\/)?files\/[1-9]\d*(?:\/(?:download|preview))?\/?$/u;
const RICH_TEXT_KEYS = /^(?:body|content|description|discussion|html|instructions|message|syllabus(?:_body)?)$/iu;
const PRIVATE_VALUE_KEYS = /(?:access[_-]?token|verifier|signature|(?:private|signed)[_-]?url|calendar.*(?:feed|ics)|(?:feed|ics).*(?:url|token)|lti[_-]?user[_-]?id|sis[_-]?user[_-]?id)/iu;
const URL_VALUE_KEYS = /(?:^|_)(?:url|uri|href|src|links?|download|preview|thumbnail|avatar)(?:_|$)/iu;
const RUBRIC_FIELDS = new Set(["id", "description", "long_description", "points", "ratings"]);
const RUBRIC_CONTAINER_FIELDS = new Set(["criteria"]);
const RUBRIC_RATING_FIELDS = new Set(["description", "long_description", "points"]);
const RUBRIC_SETTINGS_FIELDS = new Set(["title", "points_possible", "free_form_criterion_comments"]);
const BODY_FIELD_BY_ENDPOINT = Object.freeze({
  assignments: "description",
  discussions: "message",
  groupDiscussions: "message",
  announcements: "message",
  quizzes: "description",
  quiz: "description",
  pages: "body",
  page: "body",
  groupPages: "body",
  groupPage: "body",
});
const BODY_DETAIL_ENDPOINTS = new Set(["pages", "groupPages", "quizzes"]);

function captureError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function linkIdentity(link) {
  return JSON.stringify([
    link.source,
    link.title,
    link.asciiHostname,
    link.safeTarget,
    link.clickable,
    link.reason ?? null,
  ]);
}

function stripCanvasFileUrl(link) {
  if (link.asciiHostname !== "marymount.instructure.com" || typeof link.safeTarget !== "string") return link;
  try {
    const target = new URL(link.safeTarget);
    if (target.hostname !== "marymount.instructure.com" || !CANVAS_FILE_PATH.test(target.pathname)) return link;
  } catch {
    return link;
  }
  return { ...link, safeTarget: null, clickable: false, reason: "file-url-removed" };
}

function rubricFieldsForPath(fieldPath, endpoint) {
  fieldPath = fieldPath.replace(/^\/+/, "");
  if (endpoint !== "assignments" && !fieldPath.startsWith("assignment/")) return null;
  if (/^(?:assignment\/)?rubric$/u.test(fieldPath)) return RUBRIC_CONTAINER_FIELDS;
  if (/^(?:assignment\/)?rubric_settings$/u.test(fieldPath)) return RUBRIC_SETTINGS_FIELDS;
  if (/^(?:assignment\/)?rubric\/(?:\d+|criteria\/\d+)$/u.test(fieldPath)) return RUBRIC_FIELDS;
  if (/^(?:assignment\/)?rubric\/(?:\d+|criteria\/\d+)\/ratings\/\d+$/u.test(fieldPath)) return RUBRIC_RATING_FIELDS;
  return null;
}

function validateRubricNode(value, fieldPath, endpoint) {
  fieldPath = fieldPath.replace(/^\/+/, "");
  if (endpoint !== "assignments" && !fieldPath.startsWith("assignment/")) return;
  if (/^(?:assignment\/)?rubric$/u.test(fieldPath) && value !== null && !Array.isArray(value)) {
    throw captureError("INVALID_RESOURCE_ITEM");
  }
  if (/^(?:assignment\/)?rubric_settings$/u.test(fieldPath) && value !== null && !isRecord(value)) {
    throw captureError("INVALID_RESOURCE_ITEM");
  }
  if (/^(?:assignment\/)?rubric\/(?:\d+|criteria\/\d+)$/u.test(fieldPath) && !isRecord(value)) {
    throw captureError("INVALID_RESOURCE_ITEM");
  }
  if (/^(?:assignment\/)?rubric\/(?:\d+|criteria\/\d+)\/ratings$/u.test(fieldPath) && value !== null
      && !Array.isArray(value)) throw captureError("INVALID_RESOURCE_ITEM");
  if (/^(?:assignment\/)?rubric\/(?:\d+|criteria\/\d+)\/ratings\/\d+$/u.test(fieldPath) && !isRecord(value)) {
    throw captureError("INVALID_RESOURCE_ITEM");
  }
}

function validateRubricField(parentPath, key, value, endpoint) {
  parentPath = parentPath.replace(/^\/+/, "");
  const criterion = /^(?:assignment\/)?rubric\/(?:\d+|criteria\/\d+)$/u.test(parentPath);
  const rating = /^(?:assignment\/)?rubric\/(?:\d+|criteria\/\d+)\/ratings\/\d+$/u.test(parentPath);
  const settings = /^(?:assignment\/)?rubric_settings$/u.test(parentPath);
  const assignment = (endpoint === "assignments" && parentPath === "") || parentPath === "assignment";
  if (key === "use_rubric_for_grading" && assignment && value !== null && typeof value !== "boolean") {
    throw captureError("INVALID_RESOURCE_ITEM");
  }
  if (!(criterion || rating || settings)) return;
  if (key === "id" && criterion && typeof value !== "string" && typeof value !== "number") {
    throw captureError("INVALID_RESOURCE_ITEM");
  }
  if (["description", "long_description", "title"].includes(key)
      && value !== null && typeof value !== "string") throw captureError("INVALID_RESOURCE_ITEM");
  if (["points", "points_possible"].includes(key)
      && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw captureError("INVALID_RESOURCE_ITEM");
  }
  if (key === "free_form_criterion_comments" && value !== null && typeof value !== "boolean") {
    throw captureError("INVALID_RESOURCE_ITEM");
  }
}

/**
 * Remove private values and rich HTML while retaining safe metadata and link descriptions.
 * @param {object} item Reader item.
 * @param {object} options Sanitization dependencies and source identity.
 * @param {string} options.endpoint Fixed reader endpoint.
 * @param {number|null} options.courseId Course identity, when applicable.
 * @param {number} options.itemIndex Item index within the endpoint result.
 * @param {Function} options.evaluatePage Page-evaluate compatible function.
 * @param {Function} options.htmlReader Self-contained HTML sanitizer.
 * @returns {Promise<object>} Sanitized metadata record.
 */
export async function sanitizeCanvasCaptureItem(item, {
  endpoint,
  courseId,
  itemIndex,
  evaluatePage,
  htmlReader,
  onFileReference,
  groupId,
  allowedCourseIds,
}) {
  const links = [];
  const seenLinks = new Set();
  const syllabusFileIds = new Set();
  const omitFileUrls = FILE_METADATA_ENDPOINTS.has(endpoint);
  const bodyKey = BODY_FIELD_BY_ENDPOINT[endpoint];
  let bodyCapture = null;
  let bodyReason;
  let linksTruncated = false;
  let textTruncated = false;
  let visited = 0;
  const sourcePrefix = `${endpoint}${courseId === null ? "" : `/${courseId}`}/${item.id ?? itemIndex}`;
  const addLink = (link) => {
    if (omitFileUrls) return;
    const fileReference = canvasFileReferenceFromLink(link, { courseId, groupId, allowedCourseIds });
    if (fileReference !== undefined) onFileReference?.(fileReference);
    if (endpoint === "course" && link.source === sourcePrefix + "//syllabus_body"
        && typeof link.safeTarget === "string") {
      try {
        const target = new URL(link.safeTarget);
        const match = /^\/(?:api\/v1\/)?(?:courses\/([1-9]\d*)\/)?files\/([1-9]\d*)(?:\/(?:download|preview))?\/?$/u.exec(target.pathname);
        const fileId = match && Number(match[2]);
        if (target.origin === ORIGIN && !target.username && !target.password && !target.search && !target.hash
            && match && (match[1] === undefined || Number(match[1]) === courseId)
            && Number.isSafeInteger(fileId) && fileId > 0) syllabusFileIds.add(fileId);
      } catch { /* An opaque or cross-course link cannot select a syllabus file. */ }
    }
    const safeLink = stripCanvasFileUrl(link);
    if (links.length >= MAX_LINKS_PER_ITEM) {
      linksTruncated = true;
      return;
    }
    const key = linkIdentity(safeLink);
    if (!seenLinks.has(key)) {
      seenLinks.add(key);
      links.push(safeLink);
    }
  };
  if (bodyKey !== undefined && !Object.hasOwn(item, bodyKey) && !BODY_DETAIL_ENDPOINTS.has(endpoint)) {
    bodyReason = "BODY_MISSING";
  } else if (bodyKey !== undefined && Object.hasOwn(item, bodyKey)) {
    const rawBody = item[bodyKey];
    if (rawBody === null || rawBody === "") {
      bodyCapture = { html: "", text: "", empty: true };
    } else if (typeof rawBody !== "string") {
      bodyReason = "BODY_SANITIZE_FAILED";
    } else {
      try {
        const parsed = await evaluatePage(htmlReader, {
          html: rawBody,
          options: {
            source: `${sourcePrefix}/${bodyKey}`,
            maxTextCharacters: MAX_BODY_BYTES,
            baseUrl: `${ORIGIN}/`,
          },
        });
        if (!isRecord(parsed) || typeof parsed.text !== "string" || typeof parsed.html !== "string"
            || !Array.isArray(parsed.links) || typeof parsed.textTruncated !== "boolean"
            || typeof parsed.linksTruncated !== "boolean" || parsed.textTruncated
            || Buffer.byteLength(parsed.text) > MAX_BODY_BYTES || Buffer.byteLength(parsed.html) > MAX_BODY_BYTES) {
          throw captureError("HTML_SANITIZATION_FAILED");
        }
        for (const link of parsed.links) {
          if (!isRecord(link) || typeof link.source !== "string" || typeof link.title !== "string"
              || (link.asciiHostname !== null && typeof link.asciiHostname !== "string")
              || (link.safeTarget !== null && typeof link.safeTarget !== "string")
              || typeof link.clickable !== "boolean") throw captureError("HTML_SANITIZATION_FAILED");
          addLink(link);
        }
        if (parsed.linksTruncated) linksTruncated = true;
        if (parsed.textTruncated) textTruncated = true;
        bodyCapture = { html: parsed.html, text: parsed.text, empty: false };
      } catch {
        bodyReason = "BODY_SANITIZE_FAILED";
      }
    }
  }
  const sanitizeValue = async (value, key, fieldPath, depth) => {
    visited += 1;
    if (visited > 100_000 || depth > 32) throw captureError("SANITIZE_BUDGET_EXCEEDED");
    if (fieldPath === `/${bodyKey}` && bodyKey !== undefined) {
      return bodyCapture === null ? undefined : bodyCapture.text;
    }
    validateRubricNode(value, fieldPath, endpoint);
    if (Array.isArray(value)) {
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        const clean = await sanitizeValue(value[index], key, `${fieldPath}/${index}`, depth + 1);
        if (clean !== undefined) entries.push(clean);
      }
      return entries;
    }
    if (isRecord(value)) {
      const clean = {};
      const rubricFields = rubricFieldsForPath(fieldPath, endpoint);
      for (const [childKey, childValue] of Object.entries(value)) {
        if (rubricFields && !rubricFields.has(childKey)) continue;
        if (childKey === "rubric_assessment") continue;
        if (childKey.startsWith("_canvas")) continue;
        if (PRIVATE_VALUE_KEYS.test(childKey)) continue;
        validateRubricField(fieldPath, childKey, childValue, endpoint);
        const child = await sanitizeValue(childValue, childKey, `${fieldPath}/${childKey}`, depth + 1);
        if (child !== undefined) clean[childKey] = child;
      }
      return clean;
    }
    if (typeof value !== "string") return value;
    const source = `${sourcePrefix}/${fieldPath}`;
    if (URL_VALUE_KEYS.test(key)) {
      if (!omitFileUrls) {
        addLink(sanitizeCanvasLink(value, { source, title: item.name ?? item.title ?? key, baseUrl: `${ORIGIN}/` }));
      }
      return null;
    }
    const hasMarkup = /<\s*[a-z!/?][^>]*>/iu.test(value);
    if (RICH_TEXT_KEYS.test(key) || hasMarkup) {
      let parsed;
      try {
        parsed = await evaluatePage(htmlReader, {
          html: value,
          options: { source, baseUrl: `${ORIGIN}/` },
        });
      } catch {
        throw captureError("HTML_SANITIZATION_FAILED");
      }
      if (!isRecord(parsed) || typeof parsed.text !== "string" || !Array.isArray(parsed.links)
          || typeof parsed.textTruncated !== "boolean" || typeof parsed.linksTruncated !== "boolean") {
        throw captureError("HTML_SANITIZATION_FAILED");
      }
      for (const link of parsed.links) {
        if (!isRecord(link) || typeof link.source !== "string" || typeof link.title !== "string"
            || (link.asciiHostname !== null && typeof link.asciiHostname !== "string")
            || (link.safeTarget !== null && typeof link.safeTarget !== "string")
            || typeof link.clickable !== "boolean") throw captureError("HTML_SANITIZATION_FAILED");
        addLink(link);
      }
      if (parsed.linksTruncated) linksTruncated = true;
      if (parsed.textTruncated) textTruncated = true;
      return parsed.text;
    }
    return sanitizePlainText(value, source);
  };

  const clean = await sanitizeValue(item, "", "", 0);
  if (!isRecord(clean)) throw captureError("INVALID_RESOURCE_ITEM");
  if (endpoint === "assignments" && (!Object.hasOwn(clean, "rubric")
      || Array.isArray(clean.rubric) && clean.rubric.length === 0)) clean.rubric = null;
  clean._canvasLinks = links;
  if (endpoint === "course") clean._canvasSyllabusFileIds = [...syllabusFileIds].slice(0, MAX_LINKS_PER_ITEM);
  if (bodyCapture !== null) clean._canvasBody = bodyCapture;
  if (bodyReason !== undefined) clean._canvasBodyReason = bodyReason;
  if (linksTruncated) clean._canvasLinksTruncated = true;
  if (textTruncated) clean._canvasTextTruncated = true;
  return clean;
}

function sanitizePlainText(value, source) {
  if (value.length > 64 * 1024) throw captureError("SANITIZE_BUDGET_EXCEEDED");
  try {
    const parsed = extractCanvasHtmlInPage({
      html: escapeHtml(value),
      options: { source, baseUrl: `${ORIGIN}/`, maxHtmlBytes: 512 * 1024, maxTextCharacters: 64 * 1024, maxLinks: 1 },
    });
    if (parsed.links.length > 0 || parsed.text !== value) return parsed.text;
  } catch {
    // Node callers may not have DOMParser. Plain strings still receive direct URL-field filtering above.
  }
  return value
    .replace(/\b(?:https?:)?\/\/[^\s<>"'`]+/giu, "[link]")
    .replace(/\b(?:verifier|(?:access[_-]?)?token|signature|sig|auth(?:orization)?|credential|password|policy|expires|awsaccesskeyid|(?:x-amz|x-goog)-[a-z0-9_-]+)\s*[:=]\s*[^\s&;,<>"'`]+/giu, "[redacted]")
    .slice(0, 64 * 1024);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}
