import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { fixedSessionPaths } from "./canvas-browser-session.mjs";
import { bindCanvasAccount, readCanvasAccountBinding } from "./canvas-browser-binding.mjs";
import { runCanvasBrowserNativeImport } from "./canvas-browser-native-import.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "scripts", "canvas-browser-session.mjs");
const { appDirectory, socketPath, snapshotPath } = fixedSessionPaths();
const STATE_HELPER_PATH = path.join(appDirectory, "bin", "duegood-capture-state");
const MAX_RESPONSE_BYTES = 2_048;
const MAX_STATE_RESPONSE_BYTES = 128;
const START_TIMEOUT_MS = 60_000;
// Five minutes for owner sign-in, ninety seconds for the probe, and cleanup margin.
const PROBE_TIMEOUT_MS = 7 * 60_000;
// Keep five minutes of protocol margin beyond the collector's thirty-minute budget.
export const CAPTURE_TIMEOUT_MS = 35 * 60_000;
const STATE_HELPER_TIMEOUT_MS = 5_000;
const STATE_HELPER_KILL_GRACE_MS = 250;
const PROGRESS_STATES = new Set([
  "WAITING_FOR_OWNER_SIGN_IN", "CANVAS_SESSION_AVAILABLE", "CHECKING_CANVAS_SESSION",
  "PROBE_RUNNING", "PROBE_HEARTBEAT", "CAPTURE_OPENING", "CAPTURE_RUNNING", "CAPTURE_DOWNLOADING", "CAPTURE_SAVING",
]);
const CHECK_NAMES = new Set([
  "signedInContinuity", "accountIdentity", "apiShapePagination", "inboxUnreadState",
  "fileMetadata", "fileVerifier", "cookielessDownload", "nativeDownloader",
]);
let lastProgressState = "";
let lastProgressAt = 0;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function verifySocketPath() {
  const directory = await lstat(appDirectory).catch(() => undefined);
  if (!directory) return false;
  if (!directory.isDirectory() || directory.isSymbolicLink()
      || (typeof process.getuid === "function" && directory.uid !== process.getuid())
      || (directory.mode & 0o077) !== 0) throw new Error("SOCKET_DIRECTORY_REJECTED");
  const socket = await lstat(socketPath).catch(() => undefined);
  if (!socket) return false;
  if (!socket.isSocket() || socket.isSymbolicLink()
      || (typeof process.getuid === "function" && socket.uid !== process.getuid())
      || (socket.mode & 0o077) !== 0) throw new Error("SOCKET_PATH_REJECTED");
  return true;
}

function sanitizeFrame(frame, command) {
  if (frame?.progress !== undefined) {
    if (Object.keys(frame).length !== 1 || !PROGRESS_STATES.has(frame.progress)) throw new Error("INVALID_PROGRESS");
    const prefix = ["capture", "refresh"].includes(command) ? "CANVAS_CAPTURE_PROGRESS" : "PROBE_PROGRESS";
    const shortlyAfterDownload = frame.progress === "CAPTURE_RUNNING"
      && lastProgressState === "CAPTURE_DOWNLOADING" && Date.now() - lastProgressAt < 30_000;
    if (!shortlyAfterDownload
        && (frame.progress !== lastProgressState || Date.now() - lastProgressAt >= 30_000)) {
      process.stderr.write(`${prefix}=${frame.progress}\n`);
      lastProgressState = frame.progress;
      lastProgressAt = Date.now();
    }
    return undefined;
  }
  if (typeof frame?.status !== "string" || !/^[A-Z0-9_]+$/.test(frame.status)) throw new Error("INVALID_RESPONSE");
  const keys = Object.keys(frame);
  if ((command === "capture" || command === "refresh") && keys.includes("resourceCount")) {
    if (frame.status !== "PARTIAL" || keys.length !== 5
        || !["resourceCount", "itemCount", "gapCount"].every((key) => Number.isSafeInteger(frame[key]) && frame[key] >= 0)
        || frame.fileBodiesIncomplete !== true) throw new Error("INVALID_RESPONSE");
    return {
      status: frame.status,
      resourceCount: frame.resourceCount,
      itemCount: frame.itemCount,
      gapCount: frame.gapCount,
      fileBodiesIncomplete: true,
    };
  }
  if ((command === "capture" || command === "refresh") && frame.status === "REQUEST_FAILED"
      && keys.length === 2 && typeof frame.errorCode === "string"
      && /^[A-Z_]{1,48}$/u.test(frame.errorCode)) {
    return { status: "REQUEST_FAILED", errorCode: frame.errorCode };
  }
  if (command === "probe" && frame.checks !== undefined) {
    if (frame.checks === null || typeof frame.checks !== "object" || Array.isArray(frame.checks)
        || keys.length !== 2 || keys.some((key) => key !== "status" && key !== "checks")
        || Object.keys(frame.checks).some((key) => !CHECK_NAMES.has(key)
          || typeof frame.checks[key] !== "string" || !/^[A-Z0-9_]+$/.test(frame.checks[key]))) {
      throw new Error("INVALID_RESPONSE");
    }
    return { status: frame.status, checks: frame.checks };
  }
  if (command === "identity" && frame.userId !== undefined) {
    if (frame.status !== "IDENTITY_AVAILABLE" || keys.length !== 2
        || !Number.isSafeInteger(frame.userId) || frame.userId <= 0) throw new Error("INVALID_RESPONSE");
    return { status: frame.status, userId: frame.userId };
  }
  if (keys.length !== 1) throw new Error("INVALID_RESPONSE");
  return { status: frame.status };
}

async function sendCommand(command, timeoutMs, expectedUserId = undefined) {
  if (!await verifySocketPath()) return undefined;
  const request = command === "capture" ? { command, expectedUserId } : { command };
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("BROKER_TIMEOUT"));
    }, timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_BYTES) return finish(new Error("RESPONSE_TOO_LARGE"));
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        let frame;
        try { frame = JSON.parse(line.toString("utf8")); } catch { return finish(new Error("INVALID_RESPONSE")); }
        try {
          const final = sanitizeFrame(frame, command);
          if (final !== undefined) return finish(undefined, final);
        } catch (error) { return finish(error); }
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error(buffer.length > 0 ? "INCOMPLETE_RESPONSE" : "BROKER_CLOSED")));
  });
}

function launchDetachedBroker() {
  const childEnv = {
    PATH: process.env.PATH ?? "",
    HOME: homedir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
  const child = spawn(process.execPath, [BROKER_SCRIPT], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: childEnv,
    windowsHide: true,
  });
  if (!child.pid) throw new Error("BROKER_LAUNCH_FAILED");
  child.unref();
}

async function startAndWait() {
  await mkdir(appDirectory, { recursive: true, mode: 0o700 });
  const before = await lstat(appDirectory);
  if (!before.isDirectory() || before.isSymbolicLink()
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) throw new Error("SOCKET_DIRECTORY_REJECTED");
  await chmod(appDirectory, 0o700);
  const after = await lstat(appDirectory);
  if ((after.mode & 0o077) !== 0) throw new Error("SOCKET_DIRECTORY_REJECTED");
  const existing = await sendCommand("status", 1_000).catch(() => undefined);
  if (existing?.status === "READY" || existing?.status === "BUSY") return existing;
  try { launchDetachedBroker(); } catch { return { status: "START_FAILED" }; }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await sendCommand("status", 1_000).catch(() => undefined);
    if (status?.status === "READY" || status?.status === "BUSY") return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { status: "START_FAILED" };
}

async function stopAndWait() {
  const response = await sendCommand("stop", 5_000).catch(() => undefined);
  if (response?.status !== "STOPPING") return response ?? { status: "NOT_RUNNING" };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!await verifySocketPath().catch(() => false)) return { status: "STOPPED" };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { status: "STOP_FAILED" };
}

function fixedStateError() {
  const error = new Error("CAPTURE_STATE_UNAVAILABLE");
  error.code = "CAPTURE_STATE_UNAVAILABLE";
  return error;
}

async function validateCaptureStateHelper() {
  const home = homedir();
  const directories = [
    home,
    path.join(home, "Library"),
    path.join(home, "Library", "Application Support"),
    appDirectory,
    path.dirname(STATE_HELPER_PATH),
  ];
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (const directory of directories) {
    const stat = await lstat(directory).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
        || uid !== undefined && stat.uid !== uid) throw fixedStateError();
  }
  const helper = await lstat(STATE_HELPER_PATH).catch(() => undefined);
  if (!helper?.isFile() || helper.isSymbolicLink() || helper.size === 0
      || (helper.mode & 0o100) === 0 || (helper.mode & 0o022) !== 0
      || uid !== undefined && helper.uid !== uid) throw fixedStateError();
}

/** Starts or fails one fixed-root capture attempt through the installed state helper. */
async function runCaptureStateCommand(verb, runId = undefined) {
  if (verb !== "begin" && verb !== "fail"
      || verb === "fail" && (!Number.isSafeInteger(runId) || runId <= 0)) throw fixedStateError();
  await validateCaptureStateHelper();
  const args = verb === "begin" ? ["begin"] : ["fail", String(runId)];
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let failure;
    let outputBytes = 0;
    let output = "";
    let timeout;
    let killTimeout;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      child?.stdout?.off("data", onStdout);
      child?.off("error", onError);
      child?.off("close", onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = () => {
      if (child?.exitCode == null && child?.signalCode == null) {
        try { child.kill("SIGTERM"); } catch { /* The helper may have closed concurrently. */ }
        killTimeout = setTimeout(() => {
          if (child?.exitCode == null && child?.signalCode == null) {
            try { child.kill("SIGKILL"); } catch { /* The child may have closed. */ }
          }
        }, STATE_HELPER_KILL_GRACE_MS);
        killTimeout.unref?.();
      }
    };
    const fail = () => {
      failure = fixedStateError();
      terminate();
    };
    const onStdout = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_STATE_RESPONSE_BYTES) return fail();
      output += chunk.toString("utf8");
    };
    const onError = () => fail();
    const onClose = (code, signal) => {
      if (failure) return finish(failure);
      if (code !== 0 || signal !== null) return finish(fixedStateError());
      const line = output.trim();
      const match = verb === "begin"
        ? /^run=([1-9][0-9]{0,15}) status=running$/u.exec(line)
        : /^run=([1-9][0-9]{0,15}) status=failed$/u.exec(line);
      const parsedRunId = match ? Number(match[1]) : undefined;
      if (!Number.isSafeInteger(parsedRunId) || parsedRunId <= 0
          || verb === "fail" && parsedRunId !== runId) return finish(fixedStateError());
      finish(undefined, { runId: parsedRunId });
    };

    try {
      child = spawn(STATE_HELPER_PATH, args, {
        shell: false,
        windowsHide: true,
        cwd: appDirectory,
        env: {},
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(fixedStateError());
      return;
    }
    child.once("error", onError);
    child.once("close", onClose);
    child.stdout?.on("data", onStdout);
    timeout = setTimeout(fail, STATE_HELPER_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function importStatusView(result) {
  if (!result || result.type !== "result" || result.status !== "complete"
      || !Number.isSafeInteger(result.runId) || result.runId <= 0
      || !["importedCourses", "archivedCourses", "promotedBlobs", "reusedBlobs", "bytesVerified"]
        .every((key) => Number.isSafeInteger(result[key]) && result[key] >= 0)
      || typeof result.alreadyCurrent !== "boolean") throw new Error("NATIVE_IMPORT_PROTOCOL_INVALID");
  return {
    status: "IMPORTED",
    importedCourses: result.importedCourses,
    archivedCourses: result.archivedCourses,
    promotedBlobs: result.promotedBlobs,
    reusedBlobs: result.reusedBlobs,
    bytesVerified: result.bytesVerified,
    alreadyCurrent: result.alreadyCurrent,
  };
}

function safeImportErrorCode(error) {
  return typeof error?.code === "string" && /^NATIVE_IMPORT_[A-Z_]{1,48}$/u.test(error.code)
    ? error.code : "NATIVE_IMPORT_FAILED";
}

function captureSummary(frame) {
  const keys = ["status", "resourceCount", "itemCount", "gapCount", "fileBodiesIncomplete"];
  if (!frame || typeof frame !== "object" || Array.isArray(frame)
      || Object.keys(frame).length !== keys.length || keys.some((key) => !Object.hasOwn(frame, key))
      || frame.status !== "PARTIAL" || frame.fileBodiesIncomplete !== true
      || !["resourceCount", "itemCount", "gapCount"].every((key) =>
        Number.isSafeInteger(frame[key]) && frame[key] >= 0)) {
    throw new Error("INVALID_CAPTURE_RESPONSE");
  }
  return {
    status: "PARTIAL",
    resourceCount: frame.resourceCount,
    itemCount: frame.itemCount,
    gapCount: frame.gapCount,
    fileBodiesIncomplete: true,
  };
}

function captureFailureSummary(frame) {
  if (frame?.status === "REQUEST_FAILED" && Object.keys(frame).length === 2
      && Object.hasOwn(frame, "errorCode") && typeof frame.errorCode === "string"
      && /^[A-Z_]{1,48}$/u.test(frame.errorCode)) {
    return { status: "REQUEST_FAILED", errorCode: frame.errorCode };
  }
  if (frame && Object.keys(frame).length === 1
      && typeof frame.status === "string" && /^[A-Z0-9_]{1,48}$/u.test(frame.status)) {
    return { status: frame.status };
  }
  return { status: "REQUEST_FAILED", errorCode: "INVALID_RESPONSE" };
}

/**
 * @typedef {object} CanvasRefreshOptions
 * @property {() => Promise<{status: string}>} [start]
 * @property {() => Promise<number | undefined>} [readBinding]
 * @property {(userId: number) => Promise<{status: string, [key: string]: unknown} | undefined>} [capture]
 * @property {(options: {confirmedFirstUserId: number, progress: (status: string) => void}) => Promise<{
 *   type: string, status: string, runId: number, importedCourses: number, archivedCourses: number,
 *   promotedBlobs: number, reusedBlobs: number, bytesVerified: number, alreadyCurrent: boolean
 * }>} [nativeImport]
 * @property {(verb: "begin" | "fail", runId?: number) => Promise<{runId: number}>} [stateCommand]
 * @property {(status: string) => void} [reportImportProgress]
 */

/** Captures and imports one owner-bound Canvas session while retaining PARTIAL capture semantics.
 * @param {CanvasRefreshOptions} options
 */
export async function runCanvasBrowserRefresh({
  start = startAndWait,
  readBinding = () => readCanvasAccountBinding(appDirectory),
  capture = (userId) => sendCommand("capture", CAPTURE_TIMEOUT_MS, userId),
  nativeImport = runCanvasBrowserNativeImport,
  stateCommand = runCaptureStateCommand,
  reportImportProgress = (status) => process.stderr.write(`CANVAS_NATIVE_IMPORT_PROGRESS=${status}\n`),
} = {}) {
  let preCaptureRunId;
  try {
    ({ runId: preCaptureRunId } = await stateCommand("begin"));
    if (!Number.isSafeInteger(preCaptureRunId) || preCaptureRunId <= 0) throw fixedStateError();
  } catch {
    return { status: "REQUEST_FAILED", errorCode: "CAPTURE_STATE_UNAVAILABLE" };
  }
  const invalidatePreCaptureAttempt = async () => {
    await stateCommand("fail", preCaptureRunId).catch(() => undefined);
  };

  let ready;
  try { ready = await start(); } catch {
    await invalidatePreCaptureAttempt();
    return { status: "START_FAILED" };
  }
  if (ready?.status !== "READY") {
    await invalidatePreCaptureAttempt();
    return { status: /^[A-Z0-9_]{1,48}$/u.test(ready?.status ?? "") ? ready.status : "START_FAILED" };
  }

  let boundId;
  try { boundId = await readBinding(); } catch { /* A rejected binding requires owner setup again. */ }
  if (!Number.isSafeInteger(boundId) || boundId <= 0) {
    await invalidatePreCaptureAttempt();
    return { status: "BINDING_REQUIRED" };
  }

  let captured;
  try { captured = await capture(boundId); } catch { captured = undefined; }
  if (captured?.status !== "PARTIAL") {
    await invalidatePreCaptureAttempt();
    return captureFailureSummary(captured ?? { status: "NOT_RUNNING" });
  }
  let safeCapture;
  try { safeCapture = captureSummary(captured); } catch {
    await invalidatePreCaptureAttempt();
    return { status: "REQUEST_FAILED", errorCode: "INVALID_RESPONSE" };
  }

  let nativeImportStatus;
  try {
    nativeImportStatus = importStatusView(await nativeImport({
      confirmedFirstUserId: boundId,
      progress: reportImportProgress,
    }));
  } catch (error) {
    nativeImportStatus = { status: "FAILED", errorCode: safeImportErrorCode(error) };
  }
  return { ...safeCapture, snapshotPath, nativeImport: nativeImportStatus };
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  const captureUserText = ["capture", "bind"].includes(command) && extra.length === 1 ? extra[0] : undefined;
  const captureUserId = typeof captureUserText === "string" && /^\d{1,15}$/u.test(captureUserText)
    ? Number(captureUserText) : undefined;
  const validCaptureId = Number.isSafeInteger(captureUserId) && captureUserId > 0;
  if (["capture", "bind"].includes(command) && !validCaptureId
      || !["capture", "bind"].includes(command) && extra.length !== 0
      || !["start", "status", "probe", "identity", "bind", "capture", "refresh", "stop"].includes(command)) {
    output({ status: "INVALID_CONFIGURATION" });
    process.exitCode = 2;
    return;
  }
  let result;
  if (command === "start") result = await startAndWait();
  else if (command === "stop") result = await stopAndWait();
  else if (command === "bind") {
    const identity = await sendCommand("identity", 40_000).catch(() => undefined);
    if (identity?.status === "BUSY") result = { status: "BUSY" };
    else if (identity?.status !== "IDENTITY_AVAILABLE") result = { status: "SIGN_IN_REQUIRED" };
    else if (identity.userId !== captureUserId) result = { status: "IDENTITY_MISMATCH" };
    else {
      await bindCanvasAccount(appDirectory, captureUserId, identity.userId);
      result = { status: "BOUND", userId: captureUserId };
    }
  }
  else if (command === "refresh") {
    result = await runCanvasBrowserRefresh();
  }
  else if (command === "capture") {
    result = await sendCommand(command, CAPTURE_TIMEOUT_MS, captureUserId).catch(() => undefined)
      ?? { status: "NOT_RUNNING" };
    if (result.status === "PARTIAL") result.snapshotPath = snapshotPath;
  } else {
    result = await sendCommand(command, command === "probe" ? PROBE_TIMEOUT_MS : 5_000).catch(() => undefined)
      ?? { status: "NOT_RUNNING" };
  }
  output(result);
  if (["NOT_RUNNING", "START_FAILED", "STOP_FAILED", "REQUEST_FAILED", "INVALID_CONFIGURATION",
    "SIGN_IN_REQUIRED", "BINDING_REQUIRED", "IDENTITY_MISMATCH", "CAPTURE_STATE_UNAVAILABLE"].includes(result.status)
      || result.nativeImport?.status === "FAILED") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    output({ status: "REQUEST_FAILED" });
    process.exitCode = 1;
  });
}
