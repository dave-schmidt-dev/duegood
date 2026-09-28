import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "@playwright/test";
import { runCanvasBrowserProbe } from "./canvas-browser-probe.mjs";
import { readCanvasIdentity } from "./canvas-browser-identity.mjs";
import { loadCurrentCanvasCapture } from "./canvas-browser-runtime-loader.mjs";
export { runCanvasCapture } from "./canvas-browser-session-capture.mjs";

const ORIGIN = "https://marymount.instructure.com";
const APP_DIR = path.join(homedir(), "Library", "Application Support", "DueGood");
const PROFILE_DIR = path.join(APP_DIR, "canvas-capture-profile");
const SOCKET_PATH = path.join(APP_DIR, "canvas-session.sock");
const OWNER_PATH = path.join(APP_DIR, "canvas-session.owner");
const SNAPSHOT_FILENAME = "canvas-capture.json";
const MAX_REQUEST_BYTES = 256;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const SOCKET_TIMEOUT_MS = 5_000;
const PROGRESS_STATES = new Set([
  "WAITING_FOR_OWNER_SIGN_IN", "CANVAS_SESSION_AVAILABLE", "CHECKING_CANVAS_SESSION",
  "PROBE_RUNNING", "PROBE_HEARTBEAT", "CAPTURE_OPENING", "CAPTURE_RUNNING", "CAPTURE_DOWNLOADING", "CAPTURE_SAVING",
]);
const CAPTURE_PROGRESS_STATES = new Set(["CAPTURE_OPENING", "CAPTURE_RUNNING", "CAPTURE_DOWNLOADING", "CAPTURE_SAVING"]);
const PUBLIC_CAPTURE_FAILURES = new Set([
  "IDENTITY_MISMATCH", "HTML_OR_SSO_REJECTED", "REQUIRED_SECTION_INCOMPLETE", "PAGINATION_INCOMPLETE",
  "CAPTURE_BUDGET_EXCEEDED", "CAPTURE_ITEM_BUDGET_EXCEEDED", "COURSE_BUDGET_EXCEEDED",
  "DETAIL_BUDGET_EXCEEDED", "REQUEST_FAILED", "HELPER_UNAVAILABLE", "PRIVATE_DIRECTORY_REJECTED",
  "ARCHIVE_RECEIPT_REJECTED", "CAPTURE_DISK_BUDGET_EXCEEDED", "CAPTURE_COVERAGE_INCOMPLETE",
  "CAPTURE_IDENTITY_OR_SHAPE_REJECTED", "CAPTURE_RESOURCE_SHAPE_REJECTED",
  "FILE_BODY_COVERAGE_UNVERIFIED", "PROGRESS_CALLBACK_FAILED", "READER_PROGRESS_BINDING_UNAVAILABLE",
]);

function publicCaptureFailure(error) {
  for (const value of [error?.code, error?.message]) {
    if (PUBLIC_CAPTURE_FAILURES.has(value)) return value;
  }
  return "UNCLASSIFIED";
}

async function runCurrentCanvasCapture(options) {
  const capture = await loadCurrentCanvasCapture();
  return capture(options);
}

export function fixedSessionPaths() {
  return {
    appDirectory: APP_DIR,
    profileDirectory: PROFILE_DIR,
    socketPath: SOCKET_PATH,
    snapshotPath: path.join(APP_DIR, SNAPSHOT_FILENAME),
  };
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink() || (uid() >= 0 && before.uid !== uid())) {
    throw new Error("PRIVATE_DIRECTORY_REJECTED");
  }
  await chmod(directory, 0o700);
  const after = await lstat(directory);
  if ((after.mode & 0o077) !== 0 || (uid() >= 0 && after.uid !== uid())) throw new Error("PRIVATE_DIRECTORY_REJECTED");
}

function sendFrame(socket, value) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function readCommand(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error, value) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.setTimeout(0);
      error ? reject(error) : resolve(value);
    };
    const onError = () => finish(new Error("SOCKET_READ_FAILED"));
    const onEnd = () => finish(new Error("INCOMPLETE_REQUEST"));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) return finish(new Error("REQUEST_TOO_LARGE"));
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) return finish(new Error("MULTIPLE_REQUESTS_REJECTED"));
      let request;
      const rawRequest = buffer.subarray(0, newline).toString("utf8");
      try { request = JSON.parse(rawRequest); } catch { return finish(new Error("INVALID_REQUEST")); }
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        return finish(new Error("INVALID_REQUEST"));
      }
      const keys = Object.keys(request);
      if (["status", "probe", "identity", "stop"].includes(request.command) && keys.length === 1) {
        if (rawRequest !== JSON.stringify({ command: request.command })) return finish(new Error("INVALID_REQUEST"));
        return finish(undefined, request);
      }
      if (request.command === "capture" && keys.length === 2
          && keys.includes("expectedUserId") && Number.isSafeInteger(request.expectedUserId)
          && request.expectedUserId > 0) {
        if (rawRequest !== JSON.stringify({ command: "capture", expectedUserId: request.expectedUserId })) {
          return finish(new Error("INVALID_REQUEST"));
        }
        return finish(undefined, request);
      }
      finish(new Error("INVALID_REQUEST"));
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => finish(new Error("REQUEST_TIMEOUT")));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateCapture(snapshot, expectedUserId) {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== 2 || snapshot.source !== "canvas-browser"
      || !Number.isSafeInteger(snapshot.runId) || snapshot.runId <= 0
      || typeof snapshot.generationId !== "string" || !/^[a-f0-9]{32}$/u.test(snapshot.generationId)
      || !isRecord(snapshot.identity) || snapshot.identity.origin !== ORIGIN
      || snapshot.identity.userId !== expectedUserId
      || !isRecord(snapshot.activeCourses) || snapshot.activeCourses.complete !== true
      || !Array.isArray(snapshot.activeCourses.courseIds)
      || snapshot.activeCourses.courseIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(snapshot.activeCourses.courseIds).size !== snapshot.activeCourses.courseIds.length
      || !isRecord(snapshot.coverageRequirements)
      || snapshot.coverageRequirements.activeCoursesComplete !== true
      || JSON.stringify(snapshot.coverageRequirements.perActiveCourse)
        !== JSON.stringify(["course", "assignments", "assignmentGroups", "submissions"])
      || !Array.isArray(snapshot.resources) || !Array.isArray(snapshot.coverage)) {
    throw new Error("CAPTURE_IDENTITY_OR_SHAPE_REJECTED");
  }
  if (snapshot.coverage.some((entry) => !isRecord(entry) || typeof entry.endpoint !== "string"
      || !["complete", "gap"].includes(entry.status)
      || (entry.status === "gap" && !["forbidden-optional", "disabled", "not-attempted", "not-found", "request-failed"].includes(entry.reason)))) {
    throw new Error("CAPTURE_COVERAGE_INCOMPLETE");
  }
  const activeInventory = snapshot.resources.find((resource) => resource?.endpoint === "coursesActive" && resource.courseId === null);
  if (!activeInventory || !Array.isArray(activeInventory.items)
      || JSON.stringify(activeInventory.items.map((item) => item?.id).sort((a, b) => a - b))
        !== JSON.stringify([...snapshot.activeCourses.courseIds].sort((a, b) => a - b))) {
    throw new Error("ACTIVE_COURSE_INVENTORY_MISMATCH");
  }
  const completeCoverage = new Set(snapshot.coverage
    .filter((entry) => entry.status === "complete")
    .map((entry) => `${entry.endpoint}:${entry.courseId ?? "account"}`));
  if (!completeCoverage.has("coursesActive:account")
      || snapshot.activeCourses.courseIds.some((courseId) =>
        snapshot.coverageRequirements.perActiveCourse.some((endpoint) => !completeCoverage.has(`${endpoint}:${courseId}`)))) {
    throw new Error("REQUIRED_COURSE_COVERAGE_INCOMPLETE");
  }
  const coverage = snapshot.coverage.map((entry) => ({ ...entry }));
  const fileBodyEntries = coverage.filter((entry) => entry.endpoint === "fileBodies");
  if (fileBodyEntries.some((entry) => entry.status !== "gap")) throw new Error("FILE_BODY_COVERAGE_UNVERIFIED");
  if (fileBodyEntries.length === 0) {
    coverage.push({ endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" });
  }
  let itemCount = 0;
  for (const resource of snapshot.resources) {
    if (!isRecord(resource) || !Array.isArray(resource.items)) throw new Error("CAPTURE_RESOURCE_SHAPE_REJECTED");
    itemCount += resource.items.length;
    if (!Number.isSafeInteger(itemCount)) throw new Error("CAPTURE_BUDGET_EXCEEDED");
  }
  const partial = { ...snapshot, complete: false, coverage };
  const serialized = `${JSON.stringify(partial)}\n`;
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) throw new Error("CAPTURE_BUDGET_EXCEEDED");
  return {
    partial,
    serialized,
    resourceCount: snapshot.resources.length,
    itemCount,
    gapCount: coverage.filter((entry) => entry.status === "gap").length,
  };
}

async function writePrivateSnapshot(appDirectory, serialized) {
  const destination = path.join(appDirectory, SNAPSHOT_FILENAME);
  const temporaryPath = path.join(appDirectory, `.${SNAPSHOT_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    const stat = await lstat(temporaryPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || (uid() >= 0 && stat.uid !== uid())) throw new Error("SNAPSHOT_PERMISSIONS_REJECTED");
    await rename(temporaryPath, destination);
    renamed = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
  return destination;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return error?.code === "EPERM" ? true : undefined;
  }
}

async function readOwner(ownerPath = OWNER_PATH) {
  let info;
  try {
    const stat = await lstat(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (uid() >= 0 && stat.uid !== uid()) || (stat.mode & 0o077) !== 0) {
      throw new Error("OWNER_RECORD_UNVERIFIED");
    }
    const content = await readFile(ownerPath, "utf8");
    if (Buffer.byteLength(content) > 256) throw new Error("OWNER_RECORD_UNVERIFIED");
    info = JSON.parse(content);
    if (info?.uid !== uid() || !Number.isSafeInteger(info.pid) || info.pid <= 0) throw new Error("OWNER_RECORD_UNVERIFIED");
    return { pid: info.pid, uid: info.uid, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("OWNER_RECORD_UNVERIFIED", { cause: error });
  }
}

async function socketStatus(socketPath = SOCKET_PATH, timeoutMs = 500) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => socket.write('{"command":"status"}\n'));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024) return finish(undefined);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const frame = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        finish(frame?.status === "READY" ? frame : undefined);
      } catch { finish(undefined); }
    });
    socket.once("error", () => finish(undefined));
  });
}

async function removeStaleSocket(owner, socketPath, ownerPath) {
  const status = await socketStatus(socketPath);
  if (status) throw new Error("BROKER_ALREADY_RUNNING");
  let socketStat;
  try { socketStat = await lstat(socketPath); } catch (error) {
    if (error?.code === "ENOENT") {
      const currentOwner = await readOwner(ownerPath);
      if (!currentOwner || currentOwner.pid !== owner.pid || currentOwner.ino !== owner.ino
          || processIsAlive(owner.pid) !== false || await socketStatus(socketPath, 250)) {
        throw new Error("BROKER_OWNER_UNVERIFIED", { cause: error });
      }
      await unlink(ownerPath);
      return;
    }
    throw new Error("SOCKET_STATE_UNVERIFIED", { cause: error });
  }
  if (!socketStat.isSocket() || socketStat.isSymbolicLink() || (uid() >= 0 && socketStat.uid !== uid())) {
    throw new Error("SOCKET_STATE_UNVERIFIED");
  }
  const currentOwner = await readOwner(ownerPath);
  if (!currentOwner || currentOwner.pid !== owner.pid || currentOwner.ino !== owner.ino
      || processIsAlive(owner.pid) !== false || await socketStatus(socketPath, 250)) {
    throw new Error("BROKER_OWNER_UNVERIFIED");
  }
  const currentSocket = await lstat(socketPath).catch(() => undefined);
  if (!currentSocket || currentSocket.dev !== socketStat.dev || currentSocket.ino !== socketStat.ino) {
    throw new Error("SOCKET_STATE_CHANGED");
  }
  await unlink(socketPath);
  await unlink(ownerPath);
}

async function claimOwner(socketPath, ownerPath) {
  const existingStatus = await socketStatus(socketPath);
  if (existingStatus) return { alreadyRunning: true };
  const oldOwner = await readOwner(ownerPath);
  if (oldOwner) {
    const alive = processIsAlive(oldOwner.pid);
    if (alive !== false) throw new Error("BROKER_OWNER_LIVE_OR_UNVERIFIED");
    await removeStaleSocket(oldOwner, socketPath, ownerPath);
  } else {
    try {
      const stat = await lstat(socketPath);
      if (stat.isSocket()) throw new Error("STALE_SOCKET_OWNER_UNKNOWN");
      throw new Error("SOCKET_PATH_REJECTED");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const handle = await open(ownerPath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") throw new Error("BROKER_START_RACE");
    throw error;
  });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, uid: uid() }));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(ownerPath).catch(() => undefined);
    throw error;
  }
  return { handle, alreadyRunning: false };
}

async function listen(server, socketPath, onIdentity) {
  const previousUmask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
  } finally { process.umask(previousUmask); }
  const before = await lstat(socketPath);
  if (!before.isSocket() || (uid() >= 0 && before.uid !== uid())) {
    throw new Error("SOCKET_PERMISSIONS_REJECTED");
  }
  const identity = { dev: before.dev, ino: before.ino };
  onIdentity(identity);
  await chmod(socketPath, 0o600);
  const stat = await lstat(socketPath);
  if (!stat.isSocket() || stat.dev !== identity.dev || stat.ino !== identity.ino
      || (stat.mode & 0o077) !== 0 || (uid() >= 0 && stat.uid !== uid())) {
    throw new Error("SOCKET_PERMISSIONS_REJECTED");
  }
  return identity;
}

/** Start one local owner-only broker. Dependency overrides are for synthetic tests. */
export async function startSessionBroker({
  appDirectory = APP_DIR,
  profileDirectory = PROFILE_DIR,
  socketPath = SOCKET_PATH,
  launchContext = () => chromium.launchPersistentContext(profileDirectory, {
    channel: "chrome", headless: false, args: ["--disable-http-cache"], timeout: 20_000,
  }),
  probe = ({ context, progress }) => runCanvasBrowserProbe({
    context, closeContext: false, attended: true, progress,
  }),
  identity = readCanvasIdentity,
  capture = runCurrentCanvasCapture,
} = {}) {
  await ensurePrivateDirectory(appDirectory);
  await ensurePrivateDirectory(profileDirectory);
  const ownerPath = path.join(appDirectory, "canvas-session.owner");
  const ownerClaim = await claimOwner(socketPath, ownerPath);
  if (ownerClaim.alreadyRunning) return { alreadyRunning: true };

  let context;
  let server;
  let socketIdentity;
  let closing = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let requestBusy = false;
  const activeSockets = new Set();
  const cleanup = async () => {
    if (closing) return closed;
    closing = true;
    if (server?.listening) {
      await new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of activeSockets) socket.destroy();
      });
    }
    await context?.close().catch(() => undefined);
    if (socketIdentity) {
      const stat = await lstat(socketPath).catch(() => undefined);
      if (stat?.isSocket() && stat.dev === socketIdentity.dev && stat.ino === socketIdentity.ino) {
        await unlink(socketPath).catch(() => undefined);
      }
    }
    const owner = await readOwner(ownerPath).catch(() => undefined);
    if (owner?.pid === process.pid) await unlink(ownerPath).catch(() => undefined);
    await ownerClaim.handle.close().catch(() => undefined);
    resolveClosed();
    return closed;
  };

  try {
    context = await launchContext();
    const page = context.pages()[0] ?? await context.newPage();
    void page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
    server = net.createServer((socket) => {
      activeSockets.add(socket);
      socket.once("close", () => activeSockets.delete(socket));
      socket.on("error", () => {});
      if (requestBusy) {
        sendFrame(socket, { status: "BUSY" });
        socket.end();
        return;
      }
      requestBusy = true;
      const respond = (frame, { keepBusy = false, onFlushed = undefined } = {}) => {
        if (!keepBusy) requestBusy = false;
        sendFrame(socket, frame);
        if (!socket.destroyed) socket.end(() => {
          socket.destroy();
          onFlushed?.();
        });
        else onFlushed?.();
      };
      void (async () => {
        let activeCommand;
        try {
          const request = await readCommand(socket);
          activeCommand = request.command;
          if (closing) return respond({ status: "STOPPING" });
          if (request.command === "status") return respond({ status: "READY" });
          if (request.command === "identity") {
            const userId = await identity({ context });
            return respond(Number.isSafeInteger(userId) && userId > 0
              ? { status: "IDENTITY_AVAILABLE", userId }
              : { status: "SIGN_IN_REQUIRED" });
          }
          if (request.command === "probe") {
            const result = await probe({
              context,
              progress: (status) => { if (PROGRESS_STATES.has(status)) sendFrame(socket, { progress: status }); },
            });
            return respond(result);
          }
          if (request.command === "capture") {
            const reportProgress = (status) => {
              if (CAPTURE_PROGRESS_STATES.has(status)) sendFrame(socket, { progress: status });
            };
            const snapshot = await capture({
              context,
              expectedUserId: request.expectedUserId,
              protocolVersion: 2,
              progress: reportProgress,
            });
            const validated = validateCapture(snapshot, request.expectedUserId);
            reportProgress("CAPTURE_SAVING");
            await writePrivateSnapshot(appDirectory, validated.serialized);
            return respond({
              status: "PARTIAL",
              resourceCount: validated.resourceCount,
              itemCount: validated.itemCount,
              gapCount: validated.gapCount,
              fileBodiesIncomplete: true,
            });
          }
          respond({ status: "STOPPING" }, { keepBusy: true, onFlushed: () => setImmediate(() => { void cleanup(); }) });
        } catch (error) {
          respond(activeCommand === "capture"
            ? { status: "REQUEST_FAILED", errorCode: publicCaptureFailure(error) }
            : { status: "REQUEST_FAILED" });
        }
      })();
    });
    socketIdentity = await listen(server, socketPath, (identity) => { socketIdentity = identity; });
  } catch (error) {
    if (!socketIdentity && server?.listening) {
      const stat = await lstat(socketPath).catch(() => undefined);
      if (stat?.isSocket() && (uid() < 0 || stat.uid === uid())) {
        socketIdentity = { dev: stat.dev, ino: stat.ino };
      }
    }
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
    if (socketIdentity) {
      const stat = await lstat(socketPath).catch(() => undefined);
      if (stat?.isSocket() && stat.dev === socketIdentity.dev && stat.ino === socketIdentity.ino) {
        await unlink(socketPath).catch(() => undefined);
      }
    }
    await context?.close().catch(() => undefined);
    await ownerClaim.handle.close().catch(() => undefined);
    const owner = await readOwner(ownerPath).catch(() => undefined);
    if (owner?.pid === process.pid) await unlink(ownerPath).catch(() => undefined);
    throw error;
  }

  context.on("close", () => { void cleanup(); });
  return { alreadyRunning: false, close: cleanup, closed };
}

async function main() {
  const broker = await startSessionBroker();
  if (broker.alreadyRunning) {
    process.stderr.write("SESSION_BROKER=ALREADY_RUNNING\n");
    return;
  }
  process.stderr.write("SESSION_BROKER=READY\n");
  const stop = () => { void broker.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await broker.closed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("SESSION_BROKER=START_FAILED\n");
    process.exitCode = 1;
  });
}
