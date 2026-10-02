#!/usr/bin/env node
/** Fixed app entrypoint for a complete attended Canvas browser refresh. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCanvasBrowserRefresh } from "./canvas-browser-session-client.mjs";

const ALLOWED_ARGUMENTS = 0;
const PROGRESS_PHASES = new Set([
  "broker-starting", "waiting-for-canvas", "capturing", "importing", "complete",
]);
const CAPTURE_PROGRESS = new Set([
  "WAITING_FOR_OWNER_SIGN_IN", "CANVAS_SESSION_AVAILABLE", "CHECKING_CANVAS_SESSION",
  "PROBE_RUNNING", "PROBE_HEARTBEAT", "CAPTURE_OPENING", "CAPTURE_RUNNING",
  "CAPTURE_DOWNLOADING", "CAPTURE_SAVING",
]);
const ERROR_CODES = new Set([
  "BROWSER_REFRESH_FAILED", "CAPTURE_GAPS", "CAPTURE_STATE_UNAVAILABLE", "BINDING_REQUIRED",
  "SIGN_IN_REQUIRED", "IDENTITY_MISMATCH", "NATIVE_IMPORT_FAILED", "INVALID_REFRESH_RESULT",
]);
const MAX_CAPTURE_COUNT = 100_000;
const MAX_IMPORT_COUNT = 100_000;
const MAX_VERIFIED_BYTES = 4 * 1024 * 1024 * 1024;

function validCount(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function countOrZero(value, maximum) {
  return validCount(value, maximum) ? value : 0;
}

function frameWriter(writeLine) {
  return (frame) => writeLine(`${JSON.stringify(frame)}\n`);
}

function errorCodeFor(result) {
  if (result?.nativeImport?.status === "FAILED") return "NATIVE_IMPORT_FAILED";
  if (result?.status === "BINDING_REQUIRED") return "BINDING_REQUIRED";
  if (result?.status === "SIGN_IN_REQUIRED") return "SIGN_IN_REQUIRED";
  if (result?.status === "IDENTITY_MISMATCH") return "IDENTITY_MISMATCH";
  if (result?.errorCode === "CAPTURE_STATE_UNAVAILABLE") return "CAPTURE_STATE_UNAVAILABLE";
  if (result?.status === "PARTIAL" && Number.isSafeInteger(result?.gapCount) && result.gapCount > 0) return "CAPTURE_GAPS";
  return "BROWSER_REFRESH_FAILED";
}

function sanitizedResult(result) {
  const native = result?.nativeImport;
  const captureValid = result?.status === "PARTIAL"
    && result?.fileBodiesIncomplete === true
    && validCount(result.resourceCount, MAX_CAPTURE_COUNT)
    && validCount(result.itemCount, MAX_CAPTURE_COUNT)
    && validCount(result.gapCount, MAX_CAPTURE_COUNT);
  const importValid = native?.status === "IMPORTED"
    && validCount(native.importedCourses, MAX_IMPORT_COUNT)
    && validCount(native.archivedCourses, MAX_IMPORT_COUNT)
    && validCount(native.promotedBlobs, MAX_IMPORT_COUNT)
    && validCount(native.reusedBlobs, MAX_IMPORT_COUNT)
    && validCount(native.bytesVerified, MAX_VERIFIED_BYTES)
    && typeof native.alreadyCurrent === "boolean";
  const successfulPartialImport = captureValid && importValid && result.gapCount === 0;
  const errorCode = successfulPartialImport ? undefined
    : ERROR_CODES.has(errorCodeFor(result)) ? errorCodeFor(result) : "BROWSER_REFRESH_FAILED";
  return {
    type: "result",
    status: "incomplete",
    resourceCount: countOrZero(result?.resourceCount, MAX_CAPTURE_COUNT),
    itemCount: countOrZero(result?.itemCount, MAX_CAPTURE_COUNT),
    gapCount: countOrZero(result?.gapCount, MAX_CAPTURE_COUNT),
    importedCourses: countOrZero(native?.importedCourses, MAX_IMPORT_COUNT),
    archivedCourses: countOrZero(native?.archivedCourses, MAX_IMPORT_COUNT),
    promotedBlobs: countOrZero(native?.promotedBlobs, MAX_IMPORT_COUNT),
    reusedBlobs: countOrZero(native?.reusedBlobs, MAX_IMPORT_COUNT),
    bytesVerified: countOrZero(native?.bytesVerified, MAX_VERIFIED_BYTES),
    alreadyCurrent: native?.alreadyCurrent === true,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function phaseForCaptureStatus(status) {
  if (!CAPTURE_PROGRESS.has(status)) return undefined;
  return status === "WAITING_FOR_OWNER_SIGN_IN" ? "waiting-for-canvas"
    : ["CANVAS_SESSION_AVAILABLE", "CHECKING_CANVAS_SESSION", "PROBE_RUNNING", "PROBE_HEARTBEAT"].includes(status)
      ? "waiting-for-canvas" : "capturing";
}

function interceptCaptureProgress(emitPhase) {
  const originalWrite = process.stderr.write;
  process.stderr.write = function filteredStderrWrite(chunk, encoding, callback) {
    const done = typeof encoding === "function" ? encoding : callback;
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
    if (text.length <= 2048) {
      for (const line of text.split(/\r?\n/u)) {
        const match = /^CANVAS_CAPTURE_PROGRESS=([A-Z_]{1,48})$/u.exec(line);
        const phase = match ? phaseForCaptureStatus(match[1]) : undefined;
        if (phase !== undefined) emitPhase(phase);
      }
    }
    if (typeof done === "function") queueMicrotask(() => done());
    return true;
  };
  return () => { process.stderr.write = originalWrite; };
}

/** Runs the fixed existing broker/client flow and emits only bounded progress and count frames. */
export async function runCanvasAppRefresh({
  runClient = runCanvasBrowserRefresh,
  writeLine = (line) => process.stdout.write(line),
  heartbeatMs = 15_000,
} = {}) {
  const writeFrame = frameWriter(writeLine);
  let lastPhase = "";
  let currentPhase = "broker-starting";
  const emitPhase = (phase, force = false) => {
    if (!PROGRESS_PHASES.has(phase) || !force && phase === lastPhase) return;
    lastPhase = phase;
    currentPhase = phase;
    writeFrame({ type: "progress", phase });
  };
  emitPhase(currentPhase);
  const heartbeat = setInterval(() => emitPhase(currentPhase, true), heartbeatMs);
  heartbeat.unref?.();
  const restoreStderr = interceptCaptureProgress(emitPhase);
  let result;
  try {
    result = await runClient({
      reportImportProgress: () => emitPhase("importing"),
    });
  } catch {
    result = { status: "REQUEST_FAILED" };
  } finally {
    restoreStderr();
    clearInterval(heartbeat);
  }
  const final = sanitizedResult(result);
  writeFrame(final);
  return final;
}

export async function main(args = process.argv.slice(2)) {
  if (!Array.isArray(args) || args.length !== ALLOWED_ARGUMENTS) {
    const writeFrame = frameWriter((line) => process.stdout.write(line));
    writeFrame({
      type: "result", status: "incomplete", resourceCount: 0, itemCount: 0, gapCount: 0,
      importedCourses: 0, archivedCourses: 0, promotedBlobs: 0, reusedBlobs: 0,
      bytesVerified: 0, alreadyCurrent: false, errorCode: "BROWSER_REFRESH_FAILED",
    });
    process.exitCode = 2;
    return;
  }
  const result = await runCanvasAppRefresh();
  if (result.status !== "complete") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    const writeFrame = frameWriter((line) => process.stdout.write(line));
    writeFrame({
      type: "result", status: "incomplete", resourceCount: 0, itemCount: 0, gapCount: 0,
      importedCourses: 0, archivedCourses: 0, promotedBlobs: 0, reusedBlobs: 0,
      bytesVerified: 0, alreadyCurrent: false, errorCode: "BROWSER_REFRESH_FAILED",
    });
    process.exitCode = 1;
  });
}
