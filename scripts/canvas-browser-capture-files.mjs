const MAX_FILE_DOWNLOADS = 5000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const OPTIONAL_FILE_BODY_GAP_REASONS = new Set([
  "empty",
  "locked",
  "not-applicable",
  "unpublished",
]);
const DOWNLOAD_FAILURE_CODES = new Set([
  "CANCELED", "REQUEST_TIMEOUT", "INVALID_FILE_URL", "UNSAFE_REQUEST", "HTTP_STATUS_REJECTED",
  "RESPONSE_TOO_LARGE", "EMPTY_RESPONSE", "REDIRECT_HANDOFF_UNSUPPORTED", "REDIRECT_WITHOUT_LOCATION",
  "INVALID_REDIRECT_LOCATION", "CANVAS_SESSION_UNAVAILABLE", "CANVAS_NAVIGATION_FAILED",
  "CDP_SESSION_FAILED", "NETWORK_SETUP_FAILED", "SERVICE_WORKER_BYPASS_FAILED",
  "FETCH_INTERCEPTOR_SETUP_FAILED", "FETCH_DRIVER_FAILED", "CDP_RESPONSE_FAILED",
  "STAGING_CREATE_FAILED", "STAGING_WRITE_FAILED", "STAGING_PERMISSIONS_REJECTED",
  "UNSAFE_STAGING_DIRECTORY", "PROGRESS_CALLBACK_FAILED", "HELPER_UNAVAILABLE",
  "HELPER_DOWNLOAD_FAILED", "CAPTURE_DISK_BUDGET_EXCEEDED", "DOWNLOAD_FAILED",
  "HELPER_DOWNLOAD_INVALID_URL", "HELPER_DOWNLOAD_REDIRECT_REFUSED",
  "HELPER_DOWNLOAD_TOO_MANY_REDIRECTS", "HELPER_DOWNLOAD_RESPONSE_TOO_LARGE",
  "HELPER_DOWNLOAD_INVALID_AVATAR", "HELPER_DOWNLOAD_REQUEST_FAILED",
  "HELPER_DOWNLOAD_HTTP_STATUS", "HELPER_DOWNLOAD_CONCURRENCY_LOCK_POISONED",
  "HELPER_DOWNLOAD_SIGN_IN_RESPONSE", "HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH",
  "HELPER_DOWNLOAD_SIZE_MISMATCH", "HELPER_DOWNLOAD_UNSAFE_STAGING_DIRECTORY",
  "HELPER_DOWNLOAD_STAGING_FAILED",
]);
const RASTER_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/avif",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalRasterImageType(value) {
  if (typeof value !== "string") return null;
  const contentType = value.split(";", 1)[0].trim().toLowerCase();
  const canonical = contentType === "image/jpg" ? "image/jpeg"
    : contentType === "image/heif" ? "image/heic" : contentType;
  return RASTER_IMAGE_TYPES.has(canonical) ? canonical : null;
}

/** Reports whether a MIME type is one of the supported raster image types. */
export function isRasterImageContentType(value) {
  return canonicalRasterImageType(value) !== null;
}

/** Returns whether a file-body gap is a recognized Canvas omission. */
export function isCanvasFileBodyOmission(receipt) {
  return receipt?.status === "gap" && OPTIONAL_FILE_BODY_GAP_REASONS.has(receipt.reason);
}

/**
 * Reports whether every captured file body was staged or explicitly omitted by Canvas.
 *
 * @param {Array<object>} receipts File body receipts from the capture collector.
 * @returns {boolean} True when no body is missing or failed verification/download.
 */
export function canvasFileBodiesComplete(receipts) {
  return Array.isArray(receipts) && receipts.every((receipt) => {
    if (!isRecord(receipt) || !Number.isSafeInteger(receipt.fileId) || receipt.fileId <= 0) return false;
    if (receipt.status === "gap") return isCanvasFileBodyOmission(receipt);
    const validBytes = (receipt.status === "staged" || receipt.status === "archived")
      && Number.isSafeInteger(receipt.byteCount) && receipt.byteCount > 0
      && receipt.byteCount <= MAX_FILE_BYTES
      && typeof receipt.sha256 === "string" && /^[a-f0-9]{64}$/u.test(receipt.sha256)
      && typeof receipt.contentType === "string"
      && /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/u.test(receipt.contentType)
      && receipt.sourceAuthenticity === "unverified";
    if (!validBytes || receipt.status === "archived") return validBytes;
    return typeof receipt.stagedFile === "string" && /^[a-f0-9]{32}\.blob$/u.test(receipt.stagedFile)
      && (receipt.expectedSize === null || Number.isSafeInteger(receipt.expectedSize)
        && receipt.expectedSize >= 0 && receipt.expectedSize === receipt.byteCount);
  });
}

function validateStagedFileResult(result, candidate) {
  if (isRecord(result) && result.kind === "empty") {
    if (result.fileId !== candidate.fileId) return "file-id-mismatch";
    if (result.byteCount !== 0 || result.sourceAuthenticity !== "unverified") return "invalid-empty-response";
    return candidate.expectedSize === 0 ? "empty" : "EMPTY_RESPONSE";
  }
  if (!isRecord(result) || result.kind !== "staged") {
    return isRecord(result) && result.kind === "redirect" ? "redirect-handoff-pending" : "invalid-download-result";
  }
  if (result.fileId !== candidate.fileId) return "file-id-mismatch";
  if (!Number.isSafeInteger(result.byteCount) || result.byteCount < 1 || result.byteCount > MAX_FILE_BYTES) {
    return "invalid-staged-size";
  }
  if (candidate.expectedSize !== null && result.byteCount !== candidate.expectedSize) return "file-size-mismatch";
  if (typeof result.stagedFile !== "string" || !/^[a-f0-9]{32}\.blob$/u.test(result.stagedFile)) {
    return "invalid-staged-file";
  }
  if (typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.sha256)) return "invalid-file-hash";
  if (typeof result.contentType !== "string" || result.contentType.length > 127
      || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/iu.test(result.contentType)) {
    return "invalid-content-type";
  }
  if (result.sourceAuthenticity !== "unverified") return "invalid-source-authenticity";
  if (candidate.rasterContentType !== undefined && !isRasterImageContentType(result.contentType)) {
    return "HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH";
  }
  return undefined;
}

function safeDownloadError(error) {
  return typeof error?.code === "string" && DOWNLOAD_FAILURE_CODES.has(error.code)
    ? error.code
    : "DOWNLOAD_FAILED";
}

function revisionEvidence(item) {
  const contentType = item["content-type"] ?? item.content_type ?? item.contentType;
  const booleanFlag = (snakeCaseKey, camelCaseKey = snakeCaseKey) => {
    const value = item[snakeCaseKey] ?? item[camelCaseKey];
    return typeof value === "boolean" ? value : null;
  };
  return {
    modifiedAt: typeof item.modified_at === "string" ? item.modified_at : null,
    updatedAt: typeof item.updated_at === "string" ? item.updated_at : null,
    contentType: typeof contentType === "string" ? contentType : null,
    locked: booleanFlag("locked"),
    hidden: booleanFlag("hidden"),
    lockedForUser: booleanFlag("locked_for_user", "lockedForUser"),
    hiddenForUser: booleanFlag("hidden_for_user", "hiddenForUser"),
  };
}

/**
 * Collects one content-free staged receipt or explicit gap for each unique file ID.
 * Raw Canvas URLs stay in this instance and are supplied to the injected callback before the
 * collector sanitizes each metadata record. Revision evidence (stamps, content type, access
 * flags) is passed to the callback content-free so an unchanged file can be staged from the
 * prior archive instead of downloaded; a later duplicate record that disagrees about the
 * revision forces a fresh download so newer metadata is never paired with reused bytes.
 *
 * @param {object} options
 * @param {Function|undefined} options.downloadFile Browser/native file staging callback.
 * @param {Function} options.progress Content-free progress callback.
 * @returns {{capture: Function, finish: Function}} Per-capture file callbacks.
 */
export function createCanvasFileCapture({ downloadFile, progress }) {
  const candidates = new Map();
  const receipts = [];
  const attempted = new Set();
  const reusedStagedFiles = new Map();
  let downloadCount = 0;

  const remember = (item) => {
    if (!Number.isSafeInteger(item?.id) || item.id <= 0) return undefined;
    let candidate = candidates.get(item.id);
    if (candidate === undefined) {
      candidate = { fileId: item.id, sourceUrl: undefined, expectedSize: null, invalidSize: false,
        revision: undefined, revisionConflict: false, conflictRetried: false,
        rasterContentType: undefined };
      candidates.set(item.id, candidate);
    }
    if (typeof item.url === "string" && item.url.length > 0 && candidate.sourceUrl === undefined) {
      candidate.sourceUrl = item.url;
    }
    if (item.size !== undefined && item.size !== null) {
      if (Number.isSafeInteger(item.size) && item.size >= 0) {
        if (candidate.expectedSize !== null && candidate.expectedSize !== item.size) candidate.invalidSize = true;
        else candidate.expectedSize = item.size;
      } else candidate.invalidSize = true;
    }
    // Keep names local to the collector; they never enter progress or file receipts.
    const identity = Number.isSafeInteger(item.folder_id) && item.folder_id > 0
      && typeof item.filename === "string" && item.filename.length > 0 && item.filename.length <= 1024
      ? { folderId: item.folder_id, filename: item.filename } : undefined;
    if (identity !== undefined) {
      if (candidate.identity === undefined) candidate.identity = identity;
      else if (JSON.stringify(candidate.identity) !== JSON.stringify(identity)) candidate.identityConflict = true;
    }
    const revision = revisionEvidence(item);
    if (candidate.rasterContentType === undefined && isRasterImageContentType(revision.contentType)) {
      candidate.rasterContentType = revision.contentType;
    }
    if (candidate.revision === undefined) candidate.revision = revision;
    else if (JSON.stringify(candidate.revision) !== JSON.stringify(revision)) candidate.revisionConflict = true;
    return candidate;
  };

  const gap = (fileId, reason) => receipts.push({ fileId, status: "gap", reason });

  const dropStagedReceipt = (fileId) => {
    const index = receipts.findIndex((receipt) => receipt.fileId === fileId && receipt.status === "staged");
    if (index >= 0) receipts.splice(index, 1);
  };

  const attemptDownload = async (candidate, revision) => {
    if (typeof downloadFile !== "function") {
      gap(candidate.fileId, "download-not-configured");
      return;
    }
    if (downloadCount >= MAX_FILE_DOWNLOADS) {
      gap(candidate.fileId, "file-count-limit");
      return;
    }
    downloadCount += 1;
    await progress({ phase: "file-download-start", fileNumber: downloadCount });
    let result;
    try {
      result = await downloadFile(Object.freeze({
        fileId: candidate.fileId,
        sourceUrl: candidate.sourceUrl,
        expectedSize: candidate.expectedSize,
        modifiedAt: revision?.modifiedAt ?? null,
        updatedAt: revision?.updatedAt ?? null,
        contentType: candidate.rasterContentType ?? revision?.contentType ?? null,
        locked: revision?.locked ?? null,
        hidden: revision?.hidden ?? null,
        lockedForUser: revision?.lockedForUser ?? null,
        hiddenForUser: revision?.hiddenForUser ?? null,
      }));
    } catch (error) {
      const code = safeDownloadError(error);
      gap(candidate.fileId, code);
      await progress({ phase: "file-download-complete", fileNumber: downloadCount, status: "gap", errorCode: code });
      return;
    }
    const reason = validateStagedFileResult(result, candidate);
    if (reason !== undefined) {
      gap(candidate.fileId, reason);
      await progress({ phase: "file-download-complete", fileNumber: downloadCount, status: "gap", errorCode: reason });
      return;
    }
    receipts.push({
      fileId: candidate.fileId,
      status: "staged",
      expectedSize: candidate.expectedSize,
      byteCount: result.byteCount,
      sha256: result.sha256,
      contentType: result.contentType.toLowerCase(),
      stagedFile: result.stagedFile,
      sourceAuthenticity: "unverified",
    });
    if (result.reused === true) reusedStagedFiles.set(candidate.fileId, result.stagedFile);
    await progress({ phase: "file-download-complete", fileNumber: downloadCount, status: "staged", byteCount: result.byteCount });
  };

  const capture = async (item) => {
    const candidate = remember(item);
    if (candidate === undefined) return;
    if (attempted.has(candidate.fileId)) {
      const lockedGap = receipts.some((receipt) => receipt.fileId === candidate.fileId
        && receipt.status === "gap" && receipt.reason === "locked");
      if (candidate.revisionConflict && !candidate.conflictRetried
          && (reusedStagedFiles.get(candidate.fileId) !== undefined || lockedGap)) {
        // A later duplicate makes the revision ambiguous, so the normal downloader must fetch bytes.
        candidate.conflictRetried = true;
        reusedStagedFiles.delete(candidate.fileId);
        dropStagedReceipt(candidate.fileId);
        if (lockedGap) {
          const index = receipts.findIndex((receipt) => receipt.fileId === candidate.fileId
            && receipt.status === "gap" && receipt.reason === "locked");
          if (index >= 0) receipts.splice(index, 1);
        }
        await attemptDownload(candidate, undefined);
      }
      return;
    }
    if (candidate.invalidSize || candidate.expectedSize !== null && candidate.expectedSize > MAX_FILE_BYTES) {
      attempted.add(candidate.fileId);
      gap(candidate.fileId, "invalid-or-oversized-file-size");
      return;
    }
    if (candidate.revision?.locked === true || candidate.revision?.lockedForUser === true) {
      attempted.add(candidate.fileId);
      gap(candidate.fileId, "locked");
      return;
    }
    if (candidate.sourceUrl === undefined) return;

    attempted.add(candidate.fileId);
    // Conflicting metadata observed before the first URL must never qualify for reuse.
    await attemptDownload(candidate, candidate.revisionConflict ? undefined : candidate.revision);
  };

  const finish = () => {
    for (const candidate of candidates.values()) {
      if (attempted.has(candidate.fileId)) continue;
      attempted.add(candidate.fileId);
      gap(candidate.fileId, candidate.invalidSize ? "invalid-or-oversized-file-size" : "source-url-unavailable");
    }
    // A rejected macOS companion is optional only when its one real document in the same
    // folder was actually archived. Orphans, conflicting metadata, and all other failures
    // stay required gaps. Valid files (even with a ._ name) keep their validated receipts.
    const validatedReceipts = receipts.map((receipt) => {
      const candidate = candidates.get(receipt.fileId);
      if (receipt.reason === "empty" && candidate?.invalidSize) {
        return { fileId: receipt.fileId, status: "gap", reason: "invalid-or-oversized-file-size" };
      }
      if (receipt.status === "staged" && candidate?.rasterContentType !== undefined
          && !isRasterImageContentType(receipt.contentType)) {
        return { fileId: receipt.fileId, status: "gap", reason: "HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH" };
      }
      return receipt;
    });
    const stagedIds = new Set(validatedReceipts
      .filter((receipt) => receipt.status === "staged").map((receipt) => receipt.fileId));
    return validatedReceipts.map((receipt) => {
      const candidate = candidates.get(receipt.fileId);
      const identity = candidate?.identity;
      if (receipt.reason !== "HELPER_DOWNLOAD_MIME_SIGNATURE_MISMATCH"
          || candidate.identityConflict || candidate.revisionConflict || candidate.invalidSize
          || !identity?.filename.startsWith("._") || identity.filename.length <= 2) return receipt;
      const companions = [...candidates.values()].filter((other) => other.fileId !== candidate.fileId
        && !other.identityConflict && !other.revisionConflict && !other.invalidSize
        && other.identity?.folderId === identity.folderId && other.identity.filename === identity.filename.slice(2));
      return companions.length === 1 && stagedIds.has(companions[0].fileId)
        ? { fileId: receipt.fileId, status: "gap", reason: "not-applicable" } : receipt;
    });
  };

  return { capture, finish };
}
