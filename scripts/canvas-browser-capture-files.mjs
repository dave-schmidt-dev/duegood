const MAX_FILE_DOWNLOADS = 5000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateStagedFileResult(result, candidate) {
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
  return undefined;
}

function safeDownloadError(error) {
  return typeof error?.code === "string" && DOWNLOAD_FAILURE_CODES.has(error.code)
    ? error.code
    : "DOWNLOAD_FAILED";
}

/**
 * Collects one content-free staged receipt or explicit gap for each unique file ID.
 * Raw Canvas URLs stay in this instance and are supplied to the injected callback before the
 * collector sanitizes each metadata record.
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
  let downloadCount = 0;

  const remember = (item) => {
    if (!Number.isSafeInteger(item?.id) || item.id <= 0) return undefined;
    let candidate = candidates.get(item.id);
    if (candidate === undefined) {
      candidate = { fileId: item.id, sourceUrl: undefined, expectedSize: null, invalidSize: false };
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
    return candidate;
  };

  const gap = (fileId, reason) => receipts.push({ fileId, status: "gap", reason });

  const capture = async (item) => {
    const candidate = remember(item);
    if (candidate === undefined || attempted.has(candidate.fileId)) return;
    if (candidate.invalidSize || candidate.expectedSize !== null && candidate.expectedSize > MAX_FILE_BYTES) {
      attempted.add(candidate.fileId);
      gap(candidate.fileId, "invalid-or-oversized-file-size");
      return;
    }
    if (candidate.sourceUrl === undefined) return;

    attempted.add(candidate.fileId);
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
    await progress({ phase: "file-download-complete", fileNumber: downloadCount, status: "staged", byteCount: result.byteCount });
  };

  const finish = () => {
    for (const candidate of candidates.values()) {
      if (attempted.has(candidate.fileId)) continue;
      attempted.add(candidate.fileId);
      gap(candidate.fileId, candidate.invalidSize ? "invalid-or-oversized-file-size" : "source-url-unavailable");
    }
    return receipts.slice();
  };

  return { capture, finish };
}
