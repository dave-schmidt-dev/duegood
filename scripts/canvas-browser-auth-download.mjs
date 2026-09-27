import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://marymount.instructure.com";
const MAX_SOURCE_URL_BYTES = 16 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const APPROVED_QUERY_KEYS = new Set(["download_frd", "verifier"]);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function validateRequest({ context, page, fileId, sourceUrl, stagingDirectory, maxBytes, timeoutMs, progress, signal }, origin) {
  if (!context || typeof context.newCDPSession !== "function" || !page || typeof page.evaluate !== "function"
      || typeof page.url !== "function" || !Number.isSafeInteger(fileId) || fileId <= 0
      || typeof sourceUrl !== "string" || Buffer.byteLength(sourceUrl) > MAX_SOURCE_URL_BYTES
      || typeof stagingDirectory !== "string" || !path.isAbsolute(stagingDirectory)
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
      || typeof progress !== "function" || (signal !== undefined && typeof signal.addEventListener !== "function")) {
    throw failure("INVALID_REQUEST");
  }

  let url;
  try { url = new URL(sourceUrl); } catch { throw failure("INVALID_FILE_URL"); }
  const verifiers = url.searchParams.getAll("verifier");
  const downloadFlags = url.searchParams.getAll("download_frd");
  const hasVerifier = verifiers.length === 1 && verifiers[0] !== "";
  const hasDownloadFlag = downloadFlags.length === 1 && downloadFlags[0] === "1";
  if (url.origin !== origin || url.username || url.password || url.hash
      || url.pathname !== `/files/${fileId}/download`
      || [...url.searchParams.keys()].some((key) => !APPROVED_QUERY_KEYS.has(key))
      || verifiers.length > 1 || downloadFlags.length > 1 || (!hasVerifier && !hasDownloadFlag)) {
    throw failure("INVALID_FILE_URL");
  }
  if (signal?.aborted) throw failure("CANCELED");
  let pageOrigin;
  try { pageOrigin = new URL(page.url()).origin; } catch { throw failure("CANVAS_SESSION_UNAVAILABLE"); }
  if (pageOrigin !== origin || page.isClosed?.() || page.context?.() !== context) {
    throw failure("CANVAS_SESSION_UNAVAILABLE");
  }
  return { context, page, url, fileId, stagingDirectory: path.resolve(stagingDirectory), maxBytes, timeoutMs, progress, signal };
}

async function checkedPrivateDirectory(directory) {
  if (typeof process.getuid !== "function") throw failure("UNSUPPORTED_PLATFORM");
  let stat;
  try { stat = await lstat(directory); } catch { throw failure("UNSAFE_STAGING_DIRECTORY"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) {
    throw failure("UNSAFE_STAGING_DIRECTORY");
  }
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

async function verifyDirectory(directory, identity) {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev
      || stat.ino !== identity.ino || stat.uid !== identity.uid || (stat.mode & 0o7777) !== 0o700) {
    throw failure("UNSAFE_STAGING_DIRECTORY");
  }
}

async function createPrivateStage(directory, directoryIdentity) {
  await verifyDirectory(directory, directoryIdentity);
  const filePath = path.join(directory, `.duegood-browser-${randomUUID()}.part`);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags, 0o600).catch(() => { throw failure("STAGING_CREATE_FAILED"); });
  try {
    await handle.chmod(0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
      throw failure("STAGING_PERMISSIONS_REJECTED");
    }
    await verifyDirectory(directory, directoryIdentity);
    return { filePath, handle, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
}

async function removeStage(stage) {
  if (!stage) return;
  await stage.handle?.close().catch(() => undefined);
  const stat = await lstat(stage.filePath).catch(() => undefined);
  if (stat?.isFile() && !stat.isSymbolicLink() && stat.dev === stage.dev && stat.ino === stage.ino
      && stat.uid === process.getuid()) {
    await unlink(stage.filePath).catch(() => undefined);
  }
}

function responseHeader(headers, name) {
  return headers?.find((header) => header.name.toLowerCase() === name)?.value;
}

function requestHeader(headers, name) {
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten <= 0) throw failure("STAGING_WRITE_FAILED");
    offset += bytesWritten;
  }
}

/**
 * Fetches one fixed-origin Canvas file through the existing signed-in Canvas page.
 * Redirects are returned only as transient in-memory handoffs. A direct 200 body is streamed to
 * an existing owner-only staging directory and is explicitly marked unverified.
 *
 * @param {object} options
 * @param {object} options.context Persistent signed-in Playwright browser context.
 * @param {object} options.page Existing authenticated Canvas page; it is never navigated or closed.
 * @param {number} options.fileId Numeric Canvas file ID bound to `sourceUrl`.
 * @param {string} options.sourceUrl Canvas `/files/{id}/download` URL from trusted metadata.
 * @param {string} options.stagingDirectory Existing owner-only 0700 private staging directory.
 * @param {number} [options.maxBytes] Positive per-call cap no greater than 256 MiB.
 * @param {number} [options.timeoutMs] Request deadline in milliseconds, at most 120 seconds.
 * @param {Function} [options.progress] Receives content-free state and byte-count updates.
 * @param {AbortSignal} [options.signal] Cancels the request and removes partial staging bytes.
 * @returns {Promise<{kind: 'redirect', fileId: number, location: string, sourceAuthenticity: 'unverified'} | {kind: 'staged', fileId: number, stagedPath: string, byteCount: number, sourceAuthenticity: 'unverified'}>}
 * @throws {Error} A content-free error whose `code` identifies the bounded failure.
 */
async function fetchFromOrigin({
  context,
  page,
  fileId,
  sourceUrl,
  stagingDirectory,
  maxBytes = MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  progress = () => {},
  signal = undefined,
} = {}, origin) {
  const request = validateRequest({ context, page, fileId, sourceUrl, stagingDirectory, maxBytes, timeoutMs, progress, signal }, origin);
  const directoryIdentity = await checkedPrivateDirectory(request.stagingDirectory);
  let cdp;
  let stage;
  let keepStage = false;
  let activeRequestId;
  const transferMarker = randomUUID();
  let settled = false;
  let fallbackErrorCode = "DOWNLOAD_FAILED";
  let timer;
  const outcome = defer();
  const settle = (error, value) => {
    if (settled) return;
    settled = true;
    error ? outcome.reject(error) : outcome.resolve(value);
  };
  // Attach a handler immediately; cleanup will still await the same promise below.
  void outcome.promise.catch(() => undefined);

  const emit = async (state, byteCount = 0) => {
    try { await request.progress(Object.freeze({ state, byteCount })); } catch { throw failure("PROGRESS_CALLBACK_FAILED"); }
  };

  const cancelActive = (code) => {
    if (activeRequestId && cdp) {
      void cdp.send("Fetch.failRequest", { requestId: activeRequestId, errorReason: "Aborted" }).catch(() => undefined);
    }
    settle(failure(code));
  };

  const handlePaused = async (event) => {
    let url;
    try { url = new URL(event.request.url); } catch { throw failure("UNSAFE_REQUEST"); }
    const isFileRequest = event.request.method === "GET" && url.href === request.url.href
      && (event.responseStatusCode === undefined
        ? requestHeader(event.request.headers, "X-DueGood-Capture-Request") === transferMarker
        : event.requestId === activeRequestId);

    if (!isFileRequest && event.responseStatusCode === undefined) {
      await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
      return;
    }
    if (!isFileRequest && event.responseStatusCode !== undefined) {
      await cdp.send("Fetch.continueResponse", { requestId: event.requestId });
      return;
    }
    if (event.responseStatusCode === undefined) {
      activeRequestId = event.requestId;
      await cdp.send("Fetch.continueRequest", { requestId: event.requestId, interceptResponse: true });
      return;
    }
    activeRequestId = event.requestId;

    const status = event.responseStatusCode;
    if (REDIRECT_CODES.has(status)) {
      if (request.url.search !== "?download_frd=1") throw failure("REDIRECT_HANDOFF_UNSUPPORTED");
      const locationHeader = responseHeader(event.responseHeaders, "location");
      if (!locationHeader) throw failure("REDIRECT_WITHOUT_LOCATION");
      let location;
      try { location = new URL(locationHeader, request.url).href; } catch { throw failure("INVALID_REDIRECT_LOCATION"); }
      if (Buffer.byteLength(location) > MAX_SOURCE_URL_BYTES) throw failure("INVALID_REDIRECT_LOCATION");
      await cdp.send("Fetch.continueResponse", { requestId: event.requestId });
      activeRequestId = undefined;
      await emit("REDIRECT_CAPTURED");
      settle(undefined, { kind: "redirect", fileId, location, sourceAuthenticity: "unverified" });
      return;
    }
    if (status !== 200) throw failure("HTTP_STATUS_REJECTED");

    const contentLength = responseHeader(event.responseHeaders, "content-length");
    if (contentLength !== undefined) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) throw failure("INVALID_RESPONSE_LENGTH");
      if (Number(contentLength) > maxBytes) throw failure("RESPONSE_TOO_LARGE");
    }

    stage = await createPrivateStage(request.stagingDirectory, directoryIdentity);
    const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", { requestId: event.requestId });
    let totalBytes = 0;
    let eof = false;
    try {
      while (totalBytes < maxBytes) {
        if (request.signal?.aborted) throw failure("CANCELED");
        const read = await cdp.send("IO.read", {
          handle: stream,
          size: Math.min(READ_CHUNK_BYTES, maxBytes - totalBytes),
        });
        const bytes = read.base64Encoded ? Buffer.from(read.data, "base64") : Buffer.from(read.data, "utf8");
        if (bytes.length > maxBytes - totalBytes) throw failure("RESPONSE_TOO_LARGE");
        if (bytes.length > 0) {
          await writeAll(stage.handle, bytes);
          totalBytes += bytes.length;
          await emit("STREAMING", totalBytes);
        }
        if (read.eof) {
          eof = true;
          break;
        }
      }
      if (!eof && totalBytes === maxBytes) {
        const sentinel = await cdp.send("IO.read", { handle: stream, size: 1 });
        const extra = sentinel.base64Encoded ? Buffer.from(sentinel.data, "base64") : Buffer.from(sentinel.data, "utf8");
        if (extra.length > 0 || !sentinel.eof) throw failure("RESPONSE_TOO_LARGE");
        eof = true;
      }
      if (!eof) throw failure("RESPONSE_TOO_LARGE");
      if (totalBytes === 0) throw failure("EMPTY_RESPONSE");
      await verifyDirectory(request.stagingDirectory, directoryIdentity);
      await stage.handle.sync();
      const stat = await lstat(stage.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
          || stat.dev !== stage.dev || stat.ino !== stage.ino || (stat.mode & 0o777) !== 0o600
          || stat.size !== totalBytes) throw failure("STAGING_PERMISSIONS_REJECTED");
      await stage.handle.close();
      stage.handle = undefined;
      await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      activeRequestId = undefined;
      await emit("STAGED", totalBytes);
      if (settled) throw failure("TRANSFER_INTERRUPTED");
      keepStage = true;
      settle(undefined, {
        kind: "staged",
        fileId,
        stagedPath: stage.filePath,
        byteCount: totalBytes,
        sourceAuthenticity: "unverified",
      });
    } finally {
      await cdp.send("IO.close", { handle: stream }).catch(() => undefined);
    }
  };

  const onPaused = (event) => {
    void handlePaused(event).catch((error) => {
      const code = typeof error?.code === "string" ? error.code : "CDP_FAILED";
      if (cdp) {
        void cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      }
      settle(failure(code));
    });
  };

  const onAbort = () => cancelActive("CANCELED");
  try {
    await emit("STARTING");
    fallbackErrorCode = "CDP_SESSION_FAILED";
    cdp = await request.context.newCDPSession(page).catch(() => { throw failure("CDP_SESSION_FAILED"); });
    cdp.on("Fetch.requestPaused", onPaused);
    fallbackErrorCode = "NETWORK_SETUP_FAILED";
    await cdp.send("Network.enable").catch(() => { throw failure("NETWORK_SETUP_FAILED"); });
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }).catch(() => { throw failure("NETWORK_SETUP_FAILED"); });
    fallbackErrorCode = "SERVICE_WORKER_BYPASS_FAILED";
    await cdp.send("Network.setBypassServiceWorker", { bypass: true }).catch(() => { throw failure("SERVICE_WORKER_BYPASS_FAILED"); });
    fallbackErrorCode = "FETCH_INTERCEPTOR_SETUP_FAILED";
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: `${origin}/files/${fileId}/download?*`, requestStage: "Request" }],
    }).catch(() => { throw failure("FETCH_INTERCEPTOR_SETUP_FAILED"); });
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) cancelActive("CANCELED");
    if (settled) return await outcome.promise;
    timer = setTimeout(() => cancelActive("REQUEST_TIMEOUT"), timeoutMs);
    fallbackErrorCode = "FETCH_DRIVER_FAILED";
    await page.evaluate(async ({ url, timeout, marker }) => {
      const controller = new AbortController();
      const abortTimer = globalThis.setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "same-origin",
          redirect: "manual",
          cache: "no-store",
          headers: {
            Accept: "application/octet-stream, application/pdf, */*",
            "X-DueGood-Capture-Request": marker,
          },
          signal: controller.signal,
        });
        return { type: response.type, status: response.status };
      } finally {
        globalThis.clearTimeout(abortTimer);
      }
    }, { url: request.url.href, timeout: timeoutMs, marker: transferMarker }).catch(() => undefined);
    fallbackErrorCode = "CDP_RESPONSE_FAILED";
    return await outcome.promise;
  } catch (error) {
    if (settled) return await outcome.promise;
    throw failure(typeof error?.code === "string" ? error.code : fallbackErrorCode);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    if (!settled) settle(failure("DOWNLOAD_FAILED"));
    if (cdp) {
      await cdp.send("Fetch.disable").catch(() => undefined);
      await cdp.send("Network.disable").catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
    if (stage && !keepStage) await removeStage(stage);
  }
}

/** Fetches through the fixed Marymount origin used by the production broker. */
export async function fetchCanvasFileToStaging(options = {}) {
  return fetchFromOrigin(options, ORIGIN);
}

/** Synthetic-only seam. It is unavailable outside test mode and accepts IPv4 loopback only. */
export async function fetchCanvasFileToStagingForTest(options = {}, syntheticOrigin) {
  if (process.env.DUEGOOD_SYNTHETIC_TEST !== "1") throw failure("TEST_ORIGIN_UNAVAILABLE");
  let url;
  try { url = new URL(syntheticOrigin); } catch { throw failure("INVALID_TEST_ORIGIN"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw failure("INVALID_TEST_ORIGIN");
  }
  return fetchFromOrigin(options, url.origin);
}
