import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { fixedSessionPaths } from "./canvas-browser-session.mjs";
import { bindCanvasAccount, readCanvasAccountBinding } from "./canvas-browser-binding.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "scripts", "canvas-browser-session.mjs");
const { appDirectory, socketPath, snapshotPath } = fixedSessionPaths();
const MAX_RESPONSE_BYTES = 2_048;
const START_TIMEOUT_MS = 60_000;
// Five minutes for owner sign-in, ninety seconds for the probe, and cleanup margin.
const PROBE_TIMEOUT_MS = 7 * 60_000;
// Keep five minutes of protocol margin beyond the collector's thirty-minute budget.
export const CAPTURE_TIMEOUT_MS = 35 * 60_000;
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
    const prefix = command === "capture" ? "CANVAS_CAPTURE_PROGRESS" : "PROBE_PROGRESS";
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
    const ready = await startAndWait();
    if (ready.status !== "READY") result = ready;
    else {
      const boundId = await readCanvasAccountBinding(appDirectory).catch(() => undefined);
      if (boundId === undefined) result = { status: "BINDING_REQUIRED" };
      else {
        const identity = await sendCommand("identity", 40_000).catch(() => undefined);
        if (identity?.status === "BUSY") result = { status: "BUSY" };
        else if (identity?.status !== "IDENTITY_AVAILABLE") result = { status: "SIGN_IN_REQUIRED" };
        else if (identity.userId !== boundId) result = { status: "IDENTITY_MISMATCH" };
        else {
          result = await sendCommand("capture", CAPTURE_TIMEOUT_MS, boundId).catch(() => undefined)
            ?? { status: "NOT_RUNNING" };
          if (result.status === "PARTIAL") result.snapshotPath = snapshotPath;
        }
      }
    }
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
    "SIGN_IN_REQUIRED", "BINDING_REQUIRED", "IDENTITY_MISMATCH"].includes(result.status)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    output({ status: "REQUEST_FAILED" });
    process.exitCode = 1;
  });
}
