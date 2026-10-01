import path from "node:path";
import {
  inspectCanvasCaptureDirectory,
  openCanvasCaptureArchiveRoot,
  validateCanvasCurrentGeneration,
} from "./canvas-browser-archive.mjs";
import { copyArchivedCanvasBlobToStaging, MAX_BLOB_BYTES } from "./canvas-browser-archive-blobs.mjs";

const ORIGIN = "https://marymount.instructure.com";
const FILE_METADATA_ENDPOINTS = new Set(["courseFiles", "personalFiles", "file", "personalFile"]);
const HASH = /^[0-9a-f]{64}$/u;
const CONTENT_TYPE = /^[-a-z0-9.+]{1,64}\/[-a-z0-9.+]{1,64}$/u;
const MAX_TIMESTAMP_CHARACTERS = 64;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_CHARACTERS) return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, zoneHourText, zoneMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z" && (Number(zoneHourText) > 23 || Number(zoneMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function contentTypeOf(item) {
  return item["content-type"] ?? item.content_type ?? item.contentType;
}

function booleanFlag(item, snakeCaseKey, camelCaseKey = snakeCaseKey) {
  const value = item[snakeCaseKey] ?? item[camelCaseKey];
  return typeof value === "boolean" ? value : null;
}

function validContentType(value) {
  return typeof value === "string" && CONTENT_TYPE.test(value.toLowerCase());
}

function emptyIndex() {
  return { entries: new Map(), blobs: null };
}

function archivedReceipt(item) {
  if (Number.isSafeInteger(item.fileId) && item.fileId > 0 && HASH.test(item.sha256)
      && Number.isSafeInteger(item.byteCount) && item.byteCount > 0 && item.byteCount <= MAX_BLOB_BYTES
      && validContentType(item.contentType) && item.sourceAuthenticity === "unverified") {
    return { sha256: item.sha256, byteCount: item.byteCount, contentType: item.contentType.toLowerCase() };
  }
  return null;
}

function fileEvidence(item) {
  const contentType = contentTypeOf(item);
  return {
    size: item.size,
    modifiedAt: item.modified_at,
    updatedAt: item.updated_at,
    contentType: typeof contentType === "string" ? contentType.toLowerCase() : undefined,
    locked: booleanFlag(item, "locked"),
    hidden: booleanFlag(item, "hidden"),
    lockedForUser: booleanFlag(item, "locked_for_user", "lockedForUser"),
    hiddenForUser: booleanFlag(item, "hidden_for_user", "hiddenForUser"),
  };
}

function validEvidence(evidence) {
  return Number.isSafeInteger(evidence.size) && evidence.size > 0 && evidence.size <= MAX_BLOB_BYTES
    && validTimestamp(evidence.modifiedAt) && validTimestamp(evidence.updatedAt)
    && validContentType(evidence.contentType)
    && evidence.locked === false && evidence.hidden === false
    && evidence.lockedForUser === false && evidence.hiddenForUser === false;
}

/**
 * Binds each prior archived file receipt to one unique, consistent file-endpoint metadata record.
 * A file ID is reusable only when exactly one archived receipt and agreeing metadata with valid
 * revision stamps, positive size, and a content type exist for it.
 */
function buildCanvasFileReuseEntries(snapshot) {
  const receipts = new Map();
  const evidenceById = new Map();
  for (const resource of Array.isArray(snapshot.resources) ? snapshot.resources : []) {
    if (!isRecord(resource) || !Array.isArray(resource.items)) continue;
    if (resource.endpoint === "fileBodies") {
      for (const item of resource.items) {
        if (!isRecord(item) || item.status !== "archived") continue;
        if (receipts.has(item.fileId)) {
          receipts.set(item.fileId, null); // Duplicate receipts cannot bind uniquely.
          continue;
        }
        const receipt = archivedReceipt(item);
        if (receipt !== null) receipts.set(item.fileId, receipt);
      }
      continue;
    }
    if (!FILE_METADATA_ENDPOINTS.has(resource.endpoint)) continue;
    for (const item of resource.items) {
      if (!isRecord(item) || !Number.isSafeInteger(item.id) || item.id <= 0) continue;
      const evidence = fileEvidence(item);
      const existing = evidenceById.get(item.id);
      if (existing === undefined) evidenceById.set(item.id, evidence);
      else if (JSON.stringify(existing) !== JSON.stringify(evidence)) evidenceById.set(item.id, null);
    }
  }
  const entries = new Map();
  for (const [fileId, receipt] of receipts) {
    if (receipt === null) continue;
    const evidence = evidenceById.get(fileId);
    if (evidence === undefined || evidence === null || !validEvidence(evidence)) continue;
    if (evidence.size !== receipt.byteCount) continue;
    entries.set(fileId, {
      fileId,
      sha256: receipt.sha256,
      byteCount: receipt.byteCount,
      contentType: receipt.contentType,
      size: evidence.size,
      modifiedAt: evidence.modifiedAt,
      updatedAt: evidence.updatedAt,
      metadataContentType: evidence.contentType,
    });
  }
  return entries;
}

/**
 * Loads the reusable prior file index from the current immutable archive generation. The pointer,
 * manifest, snapshot hash, fixed origin, and expected user ID are validated by the same archive
 * safeguards the writer uses. A missing, unsafe, or mismatched archive yields an empty index so
 * capture downloads instead of trusting unverified bytes.
 *
 * @param {object} options
 * @param {string} options.appDirectory Owner-only application data directory.
 * @param {number} options.expectedUserId Owner-confirmed Canvas user ID for this run.
 * @returns {Promise<{entries: Map<number, object>, blobs: object | null}>} Reuse index.
 */
export async function loadCanvasFileReuseIndex({ appDirectory, expectedUserId } = {}) {
  try {
    if (typeof appDirectory !== "string" || !path.isAbsolute(appDirectory)
        || !Number.isSafeInteger(expectedUserId) || expectedUserId <= 0) {
      return emptyIndex();
    }
    const root = await openCanvasCaptureArchiveRoot(appDirectory);
    const current = await validateCanvasCurrentGeneration(root);
    if (current === null || !isRecord(current.snapshot)) return emptyIndex();
    const snapshot = current.snapshot;
    if (snapshot.identity?.origin !== ORIGIN || snapshot.identity?.userId !== expectedUserId) {
      return emptyIndex();
    }
    const blobs = await inspectCanvasCaptureDirectory(path.join(root.path, "blobs"));
    return { entries: buildCanvasFileReuseEntries(snapshot), blobs };
  } catch {
    // An absent or unsafe archive is a cache miss, never a capture failure.
    return emptyIndex();
  }
}

function reusableEntry(index, metadata) {
  if (!isRecord(index) || index.blobs === null || !isRecord(metadata)) return null;
  if (!Number.isSafeInteger(metadata.fileId) || metadata.fileId <= 0) return null;
  // Restricted current files are re-downloaded rather than served from the prior archive.
  if (metadata.locked !== false || metadata.hidden !== false
      || metadata.lockedForUser !== false || metadata.hiddenForUser !== false) return null;
  const entry = index.entries.get(metadata.fileId);
  if (entry === undefined) return null;
  if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size !== entry.size) return null;
  if (typeof metadata.contentType !== "string"
      || metadata.contentType.toLowerCase() !== entry.metadataContentType) return null;
  if (!validTimestamp(metadata.modifiedAt) || !validTimestamp(metadata.updatedAt)
      || metadata.modifiedAt !== entry.modifiedAt || metadata.updatedAt !== entry.updatedAt) return null;
  return entry;
}

/**
 * Stages one eligible prior archived blob into the current capture's staging directory under a
 * fresh opaque name. Only content-free file metadata (ID, size, revision stamps, content type,
 * access flags) is inspected; URLs are never used here. Any miss, corruption, or copy failure
 * returns null so the caller downloads fresh bytes instead.
 *
 * @param {object} index Loaded reuse index.
 * @param {object} metadata Content-free current file metadata.
 * @param {string} stagingDirectory Current capture staging directory.
 * @param {{maxBytes?: number, progress?: Function}} [options] Copy budget and progress callback.
 * @returns {Promise<{kind: "staged", fileId: number, stagedFile: string, byteCount: number,
 *   sha256: string, contentType: string, sourceAuthenticity: "unverified", reused: true} | null>}
 */
export async function stageReusedCanvasFile(index, metadata, stagingDirectory, options = {}) {
  const entry = reusableEntry(index, metadata);
  if (entry === null || Number.isSafeInteger(options.maxBytes) && entry.byteCount > options.maxBytes) return null;
  let staging;
  try {
    staging = await inspectCanvasCaptureDirectory(stagingDirectory);
  } catch {
    return null;
  }
  try {
    const stagedFile = await copyArchivedCanvasBlobToStaging(index.blobs, staging, entry, undefined, options.progress);
    return {
      kind: "staged",
      fileId: entry.fileId,
      stagedFile,
      byteCount: entry.byteCount,
      sha256: entry.sha256,
      contentType: entry.contentType,
      sourceAuthenticity: "unverified",
      reused: true,
    };
  } catch {
    // A corrupt or unreadable prior blob is a cache miss; the failed copy was already removed.
    return null;
  }
}
