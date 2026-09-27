import { spawn } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchCanvasFileToStaging } from "./canvas-browser-auth-download.mjs";

const MAX_HELPER_REQUEST_BYTES = 64 * 1024;
const MAX_HELPER_RESPONSE_BYTES = 2 * 1024;
const MAX_HELPER_ERROR_BYTES = 128;
const HELPER_TIMEOUT_MS = 120_000;
const OPAQUE_BLOB = /^[a-f0-9]{32}\.blob$/u;
const BROWSER_PART = /^\.duegood-browser-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.part$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DOWNLOAD_ERROR_CODES = new Set([
  "invalid-url", "redirect-refused", "too-many-redirects", "response-too-large", "invalid-avatar",
  "request-failed", "http-status", "concurrency-lock-poisoned", "sign-in-response",
  "mime-signature-mismatch", "size-mismatch", "unsafe-staging-directory", "staging-failed",
]);
function failure(code) {
  return Object.assign(new Error(code), { code });
}

function helperDownloadFailure(stderr, overflowed) {
  if (overflowed || stderr.length > MAX_HELPER_ERROR_BYTES) return failure("HELPER_DOWNLOAD_FAILED");
  const text = stderr.toString("utf8");
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!/^[a-z]+(?:-[a-z]+)*$/u.test(line) || !DOWNLOAD_ERROR_CODES.has(line)) {
    return failure("HELPER_DOWNLOAD_FAILED");
  }
  const suffix = line.replace(/-/gu, "_").toUpperCase();
  return failure(`HELPER_DOWNLOAD_${suffix}`);
}

function validReceipt(value, fileId) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "byteCount,contentType,fileId,hashScope,sha256,sourceAuthenticity,stagedFile"
    && value.fileId === fileId && OPAQUE_BLOB.test(value.stagedFile)
    && Number.isSafeInteger(value.byteCount) && value.byteCount > 0 && value.byteCount <= 256 * 1024 * 1024
    && SHA256.test(value.sha256) && typeof value.contentType === "string"
    && value.contentType.length > 0 && value.contentType.length <= 128
    && value.hashScope === "staged-bytes-only" && value.sourceAuthenticity === "unverified";
}

/** Sends one transient private file request to the fixed native helper over stdin. */
export async function runCaptureDownloadHelper({ helperPath, request, fileId, progress = () => {} }) {
  if (typeof helperPath !== "string" || !path.isAbsolute(helperPath)
      || typeof request !== "object" || request === null || !Number.isSafeInteger(fileId) || fileId <= 0) {
    throw failure("INVALID_HELPER_REQUEST");
  }
  const stat = await lstat(helperPath).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0
      || (stat.mode & 0o022) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw failure("HELPER_UNAVAILABLE");
  }
  const body = Buffer.from(JSON.stringify(request), "utf8");
  if (body.length > MAX_HELPER_REQUEST_BYTES) throw failure("INVALID_HELPER_REQUEST");
  await progress({ state: "NATIVE_DOWNLOAD_STARTED", byteCount: 0 });
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() },
      windowsHide: true,
    });
    let output = Buffer.alloc(0);
    let errorOutput = Buffer.alloc(0);
    let errorOutputOverflowed = false;
    let done = false;
    const finish = (error, receipt) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve(receipt);
    };
    const timer = setTimeout(() => finish(failure("HELPER_TIMEOUT")), HELPER_TIMEOUT_MS);
    child.once("error", () => finish(failure("HELPER_UNAVAILABLE")));
    child.stdout.on("data", (chunk) => {
      if (done) return;
      if (output.length + chunk.length > MAX_HELPER_RESPONSE_BYTES) {
        finish(failure("HELPER_RESPONSE_REJECTED"));
      } else output = Buffer.concat([output, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      if (errorOutput.length + chunk.length > MAX_HELPER_ERROR_BYTES) {
        errorOutputOverflowed = true;
      } else if (!errorOutputOverflowed) {
        errorOutput = Buffer.concat([errorOutput, chunk]);
      }
    });
    child.once("close", (code, signal) => {
      if (done) return;
      if (code !== 0 || signal) return finish(helperDownloadFailure(errorOutput, errorOutputOverflowed));
      let receipt;
      try { receipt = JSON.parse(output.toString("utf8").trim()); } catch { return finish(failure("HELPER_RESPONSE_REJECTED")); }
      if (!validReceipt(receipt, fileId)) return finish(failure("HELPER_RESPONSE_REJECTED"));
      finish(undefined, receipt);
    });
    child.stdin.on("error", () => finish(failure("HELPER_REQUEST_FAILED")));
    child.stdin.end(body);
  });
}

/** Fetches one Canvas file through the existing page, then verifies/stages it natively. */
export async function downloadCanvasFile({ context, page, fileId, sourceUrl, expectedSize, stagingDirectory, helperPath,
  progress = () => {}, browserFetch = fetchCanvasFileToStaging, nativeHelper = runCaptureDownloadHelper }) {
  const browserResult = await browserFetch({ context, page, fileId, sourceUrl, stagingDirectory, progress });
  let request;
  if (browserResult?.kind === "redirect" && browserResult.fileId === fileId) {
    request = { fileId, browserSourceUrl: sourceUrl, browserLocationUrl: browserResult.location,
      expectedSize, stagingDirectory };
  } else if (browserResult?.kind === "staged" && browserResult.fileId === fileId) {
    request = { fileId, browserStagedPath: browserResult.stagedPath, browserByteCount: browserResult.byteCount,
      expectedSize, stagingDirectory };
  } else throw failure("BROWSER_DOWNLOAD_REJECTED");
  try {
    const receipt = await nativeHelper({ helperPath, request, fileId, progress });
    if (!validReceipt(receipt, fileId)) throw failure("HELPER_RESPONSE_REJECTED");
    await progress({ state: "FILE_STAGED", byteCount: receipt.byteCount });
    return { kind: "staged", fileId, stagedFile: receipt.stagedFile, byteCount: receipt.byteCount,
      sha256: receipt.sha256, contentType: receipt.contentType, sourceAuthenticity: "unverified" };
  } finally {
    const stagedPath = browserResult?.stagedPath;
    if (browserResult?.kind === "staged" && typeof stagedPath === "string"
        && path.dirname(stagedPath) === path.resolve(stagingDirectory)
        && BROWSER_PART.test(path.basename(stagedPath))) {
      await unlink(stagedPath).catch(() => undefined);
    }
  }
}
