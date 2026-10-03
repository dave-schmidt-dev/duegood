#!/usr/bin/env node
/** Verifies refreshed private coursework in the already-running installed app. */
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSingleOwnedRunningApplication,
  queryRunningApplicationIdentities,
} from "./install-desktop-launch.mjs";
import { createOwnedScratchRoot } from "./owned-scratch-root.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_PATH = "/Applications/Due Good.app";
const BUNDLE_ID = "com.zerodelta.duegood";
const PROJECT = path.join(ROOT, "test/native/macos/DueGoodDesktopUITests.xcodeproj");
const SCHEME = "DueGoodDesktopUITests";
const TEST_CASE = `${SCHEME}/DueGoodDesktopUITests/testLiveRefreshAllPagesInPopulatedStore`;
const XCODEBUILD = "/usr/bin/xcodebuild";
const MAX_EXPECTED_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const RUN_TIMEOUT_MS = 35 * 60 * 1000;
const PAGE_IDS = ["timeline", "grades", "inbox", "completed", "courses", "library", "activity", "more"];
const PAGE_HEADINGS = {
  timeline: { nav: "Timeline", heading: "Timeline" },
  grades: { nav: "Grades", heading: "Grades" },
  inbox: { nav: "Inbox", heading: "Inbox" },
  completed: { nav: "Done", heading: "Completed" },
  courses: { nav: "Courses", heading: "Courses" },
  library: { nav: "Library", heading: "Library" },
  activity: { nav: "Activity", heading: "Activity" },
  more: { nav: "More", heading: "More" },
};
const activeChildren = new Set();
let requestedSignal;
let signalKillTimer;

class VerificationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** @typedef {{id: string, heading: string, requiredText: string[], forbiddenText: string[], emptyStateText?: string}} ExpectedPage */
/** @typedef {{schemaVersion: 1, performFullRefresh: true, pages: ExpectedPage[]}} ExpectedDocument */
/** @typedef {{id: string, ok: boolean, matched: number}} PageResult */
/** @typedef {{status: string, identityBefore: boolean, identityAfter: boolean, refreshOutcome: string, pages: PageResult[], failureCode?: string, cleanup?: string}} VerificationReceipt */

function fail(code) { throw new VerificationError(code); }

/** @param {unknown} value @returns {ExpectedDocument} */
export function validateExpectedDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== 1 || value.performFullRefresh !== true
      || !Array.isArray(value.pages) || value.pages.length !== PAGE_IDS.length) {
    fail("invalid_expected_schema");
  }
  const seen = new Set();
  let totalTokens = 0;
  const pages = value.pages.map((page) => {
    if (!page || typeof page !== "object" || Array.isArray(page)
        || typeof page.id !== "string" || !PAGE_IDS.includes(page.id)
        || seen.has(page.id) || page.heading !== PAGE_HEADINGS[page.id].heading) {
      fail("invalid_expected_schema");
    }
    seen.add(page.id);
    const requiredText = page.requiredText === undefined ? [] : page.requiredText;
    const forbiddenText = page.forbiddenText === undefined ? [] : page.forbiddenText;
    if (!Array.isArray(requiredText) || !Array.isArray(forbiddenText)
        || requiredText.length > 100 || forbiddenText.length > 100
        || !requiredText.every(validToken) || !forbiddenText.every(validToken)
        || new Set(requiredText).size !== requiredText.length
        || new Set(forbiddenText).size !== forbiddenText.length
        || typeof page.emptyStateText !== "undefined" && !validToken(page.emptyStateText)
        || (requiredText.length === 0) !== (typeof page.emptyStateText === "string")) {
      fail("invalid_expected_schema");
    }
    totalTokens += requiredText.length + forbiddenText.length + (page.emptyStateText ? 1 : 0);
    if (totalTokens > 500) fail("invalid_expected_schema");
    return {
      id: page.id,
      heading: page.heading,
      requiredText: [...requiredText],
      forbiddenText: [...forbiddenText],
      ...(page.emptyStateText ? { emptyStateText: page.emptyStateText } : {}),
    };
  });
  if (seen.size !== PAGE_IDS.length || pages.some((page, index) => page.id !== PAGE_IDS[index])) {
    fail("invalid_expected_schema");
  }
  return { schemaVersion: 1, performFullRefresh: true, pages };
}

function validToken(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 2_000;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

/** Reads one owner-only, non-symlink expected file from a stable file handle. */
export function readPrivateExpectedFile(filePath, { beforeOpen = () => {} } = {}) {
  let fd;
  try {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\n")) fail("invalid_expected_file");
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") fail("invalid_expected_file");
    const beforePath = lstatSync(filePath);
    if (beforePath.isSymbolicLink() || !beforePath.isFile()) fail("invalid_expected_file");
    beforeOpen();
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_CLOEXEC ?? 0) | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || (before.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && before.uid !== process.getuid())
        || before.size <= 0 || before.size > MAX_EXPECTED_BYTES
        || !sameFileIdentity(beforePath, before)) fail("invalid_expected_file");

    const chunks = [];
    let length = 0;
    const buffer = Buffer.alloc(16 * 1024);
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      length += bytes;
      if (length > MAX_EXPECTED_BYTES) fail("invalid_expected_file");
      chunks.push(Buffer.from(buffer.subarray(0, bytes)));
    }
    const after = fstatSync(fd);
    const afterPath = lstatSync(filePath);
    if (!after.isFile() || (after.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && after.uid !== process.getuid())
        || !sameFileIdentity(before, after) || !sameFileIdentity(after, afterPath)
        || after.mtimeMs !== before.mtimeMs || length !== before.size) fail("invalid_expected_file");

    let decoded;
    try { decoded = JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
    catch { fail("invalid_expected_schema"); }
    return validateExpectedDocument(decoded);
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail("invalid_expected_file");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch { fail("invalid_expected_file"); }
    }
  }
}

export function parseXcodeMarkers(text) {
  const pages = new Map();
  let refreshOutcome;
  for (const line of text.split(/\r?\n/u)) {
    const refreshMatch = /DUEGOOD_LIVE_REFRESH outcome=(complete|partial|failed|reload-failed|timeout|unconfirmed)/u.exec(line);
    if (refreshMatch) refreshOutcome = refreshMatch[1];
    const pageMatch = /DUEGOOD_LIVE_PAGE id=(timeline|grades|inbox|completed|courses|library|activity|more) ok=(true|false) matched=(\d+)/u.exec(line);
    if (pageMatch) {
      const matched = Number(pageMatch[3]);
      if (Number.isSafeInteger(matched) && matched <= 100) {
        pages.set(pageMatch[1], { id: pageMatch[1], ok: pageMatch[2] === "true", matched });
      }
    }
  }
  return { refreshOutcome, pages: PAGE_IDS.map((id) => pages.get(id)).filter(Boolean) };
}

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function stopLingeringGroup(child) {
  try {
    if (!child.pid || !processGroupExists(child.pid)) return true;
    signalGroup(child, "SIGTERM");
    if (await waitForGroupExit(child.pid, 2_000)) return true;
    signalGroup(child, "SIGKILL");
    return await waitForGroupExit(child.pid, 3_000);
  } catch { return false; }
}

/** Runs xcodebuild in a private log file and bounded process group.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, logPath: string, timeoutMs?: number, progress?: (message: string) => void, spawnImpl?: typeof spawn}} options
 * @returns {Promise<{code: number | null, signal: NodeJS.Signals | null, timedOut: boolean, overflow: boolean}>}
 */
export function runBoundedProcess(command, args, {
  cwd,
  env,
  logPath,
  timeoutMs = RUN_TIMEOUT_MS,
  progress = () => {},
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    if (requestedSignal) { reject(new VerificationError("interrupted")); return; }
    let logFd;
    try { logFd = openSync(logPath, "wx", 0o600); }
    catch { reject(new VerificationError("private_log_unavailable")); return; }
    let child;
    try { child = spawnImpl(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch {
      closeSync(logFd);
      reject(new VerificationError("xcodebuild_unavailable"));
      return;
    }
    activeChildren.add(child);
    let captured = 0;
    let overflow = false;
    let timedOut = false;
    let spawnFailure = false;
    let forceKillTimer;
    const append = (channel, chunk) => {
      if (captured >= MAX_LOG_BYTES) { overflow = true; signalGroup(child, "SIGKILL"); return; }
      const prefix = Buffer.from(`${channel} `);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_LOG_BYTES - captured;
      try {
        const head = prefix.subarray(0, remaining);
        writeSync(logFd, head);
        captured += head.length;
        const body = bytes.subarray(0, Math.max(0, remaining - head.length));
        if (body.length) { writeSync(logFd, body); captured += body.length; }
        if (body.length < bytes.length || head.length < prefix.length) { overflow = true; signalGroup(child, "SIGKILL"); }
      } catch { signalGroup(child, "SIGTERM"); }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      progress("Native UI verification exceeded its bounded runtime; stopping the test process group.");
      signalGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => signalGroup(child, "SIGKILL"), 5_000);
      forceKillTimer.unref();
    }, timeoutMs);
    const heartbeat = setInterval(() => progress("Native refresh verification is still running."), 30_000);
    const finish = () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      try { closeSync(logFd); } catch { /* closed */ }
      activeChildren.delete(child);
      if (activeChildren.size === 0 && signalKillTimer !== undefined) {
        clearTimeout(signalKillTimer);
        signalKillTimer = undefined;
      }
    };
    child.stdout.on("data", (chunk) => append("stdout ", chunk));
    child.stderr.on("data", (chunk) => append("stderr ", chunk));
    child.once("error", () => {
      spawnFailure = true;
      finish();
      reject(new VerificationError("xcodebuild_unavailable"));
    });
    child.once("close", async (code, signal) => {
      if (spawnFailure) return;
      const stopped = await stopLingeringGroup(child);
      finish();
      if (!stopped) reject(new VerificationError("xcodebuild_process_group_active"));
      else if (requestedSignal) reject(new VerificationError("interrupted"));
      else resolve({ code, signal, timedOut, overflow });
    });
  });
}

function safeXcodeEnvironment(expectedCopy, scratchRoot) {
  const env = {};
  for (const key of ["HOME", "PATH", "DEVELOPER_DIR", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.TMPDIR = `${scratchRoot}${path.sep}`;
  env.TEST_RUNNER_DUEGOOD_LIVE_EXPECTED_FILE = expectedCopy;
  return env;
}

function identityProbeEnvironment(scratchRoot) {
  const env = {};
  for (const key of ["HOME", "DEVELOPER_DIR"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.TMPDIR = `${scratchRoot}${path.sep}`;
  return env;
}

function copyExpectedFile(document, scratchRoot) {
  const destination = path.join(scratchRoot, "expected-live-check.json");
  const fd = openSync(destination, "wx", 0o600);
  try { writeSync(fd, Buffer.from(JSON.stringify(document), "utf8")); }
  finally { closeSync(fd); }
  return destination;
}

function ownedAppIdentity(apps) {
  try { return assertSingleOwnedRunningApplication(apps, { appPath: APP_PATH, bundleId: BUNDLE_ID }); }
  catch { fail("installed_app_identity_invalid"); }
}

function sameRunningIdentity(before, after) {
  return before.pid === after.pid && before.appPath === after.appPath && before.executablePath === after.executablePath;
}

/** Orchestrates a path/PID-only check; it never launches, stops, or opens the app store. */
/**
 * @param {{expectedFilePath: string, platform?: NodeJS.Platform, fileExists?: (filePath: string) => boolean,
 *   queryApplications?: (options: {bundleId: string}) => Promise<Array<{pid: number, appPath: string, executablePath: string}>>,
 *   runXcode?: (command: string, args: string[], options: {cwd: string, env: NodeJS.ProcessEnv, logPath: string, timeoutMs: number, progress: (message: string) => void}) => Promise<{code: number | null, timedOut: boolean, overflow: boolean}>,
 *   scratchFactory?: () => ReturnType<typeof createOwnedScratchRoot>, progress?: (message: string) => void}} options
 * @returns {Promise<VerificationReceipt>}
 */
export async function runLiveVerification({
  expectedFilePath,
  platform = process.platform,
  fileExists = (filePath) => { try { statSync(filePath); return true; } catch { return false; } },
  queryApplications = queryRunningApplicationIdentities,
  runXcode = runBoundedProcess,
  scratchFactory = () => createOwnedScratchRoot("live-native-check"),
  progress = () => {},
} = {}) {
  let scratch;
  let document;
  /** @type {VerificationReceipt} */
  const receipt = {
    status: "failed",
    identityBefore: false,
    identityAfter: false,
    refreshOutcome: "unknown",
    pages: [],
  };
  let keepScratch = false;
  try {
    if (platform !== "darwin") fail("macos_required");
    document = readPrivateExpectedFile(expectedFilePath);
    if (!fileExists(XCODEBUILD) || !fileExists("/usr/bin/swift") || !fileExists(PROJECT)) fail("native_tool_unavailable");
    scratch = scratchFactory();
    const expectedCopy = copyExpectedFile(document, scratch.root);
    const logPath = path.join(scratch.root, "xcodebuild.log");
    const probeOptions = { bundleId: BUNDLE_ID, environment: identityProbeEnvironment(scratch.root), inheritEnvironment: false };
    const before = ownedAppIdentity(await queryApplications(probeOptions));
    receipt.identityBefore = true;
    scratch.setActive(true);
    let xcodeResult;
    let xcodeFailure;
    try {
      xcodeResult = await runXcode(XCODEBUILD, [
        "test", "-project", PROJECT, "-scheme", SCHEME,
        "-destination", "platform=macOS,arch=arm64",
        "-derivedDataPath", path.join(scratch.root, "DerivedData"),
        "-resultBundlePath", path.join(scratch.root, "LiveRefresh.xcresult"),
        "-parallel-testing-enabled", "NO",
        `-only-testing:${TEST_CASE}`,
        "CODE_SIGN_IDENTITY=-", "CODE_SIGN_STYLE=Manual",
      ], {
        cwd: ROOT,
        env: safeXcodeEnvironment(expectedCopy, scratch.root),
        logPath,
        timeoutMs: RUN_TIMEOUT_MS,
        progress,
      });
    } catch (error) {
      xcodeFailure = error instanceof VerificationError ? error.code : "xcodebuild_failed";
      if (xcodeFailure === "xcodebuild_process_group_active") keepScratch = true;
    }
    scratch.setActive(keepScratch);
    const markers = parseXcodeMarkers(readPrivateLog(logPath));
    receipt.refreshOutcome = markers.refreshOutcome ?? "unknown";
    receipt.pages = markers.pages;
    try {
      const after = ownedAppIdentity(await queryApplications(probeOptions));
      receipt.identityAfter = sameRunningIdentity(before, after);
    } catch { receipt.identityAfter = false; }
    const pageReceiptFailed = markers.pages.some((page) => !page.ok) || markers.pages.length !== PAGE_IDS.length;
    if (!receipt.identityAfter) receipt.failureCode = "installed_app_identity_changed";
    else if (markers.refreshOutcome === "partial" && pageReceiptFailed) receipt.failureCode = "page_content_check_failed";
    else if (markers.refreshOutcome === "reload-failed") receipt.failureCode = "dashboard_reload_failed";
    else if (markers.refreshOutcome === "failed") receipt.failureCode = "full_refresh_failed";
    else if (markers.refreshOutcome === "timeout") receipt.failureCode = "full_refresh_timed_out";
    else if (markers.refreshOutcome === "unconfirmed") receipt.failureCode = "full_refresh_transition_unconfirmed";
    else if (xcodeFailure) receipt.failureCode = xcodeFailure;
    else if (xcodeResult?.timedOut) receipt.failureCode = "xcodebuild_timed_out";
    else if (xcodeResult?.overflow) receipt.failureCode = "xcodebuild_output_limit";
    else if (xcodeResult?.code !== 0) receipt.failureCode = "xcodebuild_failed";
    else if (pageReceiptFailed) receipt.failureCode = "page_content_check_failed";
    else if (markers.refreshOutcome === "partial") receipt.failureCode = "full_refresh_partial";
    else if (markers.refreshOutcome !== "complete") receipt.failureCode = "full_refresh_not_confirmed";
    else receipt.status = "passed";
    if (receipt.failureCode) receipt.status = receipt.failureCode === "full_refresh_partial" ? "partial" : "failed";
    return receipt;
  } catch (error) {
    const code = error instanceof VerificationError ? error.code : "verification_failed";
    receipt.failureCode = code;
    return receipt;
  } finally {
    if (scratch) {
      if (!keepScratch) {
        try { scratch.setActive(false); scratch.cleanup(); }
        catch { receipt.cleanup = "failed"; }
      } else receipt.cleanup = "blocked_active_child";
    }
  }
}

function readPrivateLog(logPath) {
  let fd;
  try {
    const pathStat = lstatSync(logPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > MAX_LOG_BYTES) return "";
    fd = openSync(logPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_CLOEXEC ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && opened.uid !== process.getuid())
        || !sameFileIdentity(pathStat, opened)) return "";
    const content = readFileSync(fd);
    const after = fstatSync(fd);
    const namedAfter = lstatSync(logPath);
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(after, namedAfter)
        || content.length > MAX_LOG_BYTES) return "";
    return content.toString("utf8");
  } catch { return ""; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      requestedSignal ??= signal;
      for (const child of activeChildren) signalGroup(child, "SIGTERM");
      if (activeChildren.size > 0 && signalKillTimer === undefined) {
        signalKillTimer = setTimeout(() => {
          for (const child of activeChildren) signalGroup(child, "SIGKILL");
          signalKillTimer = undefined;
        }, 5_000);
        signalKillTimer.unref();
      }
    });
  }
}

export function parseArguments(args, environment = process.env) {
  const expectedFilePath = environment.DUEGOOD_LIVE_EXPECTED_FILE;
  if (args.length !== 0 || typeof expectedFilePath !== "string"
      || !path.isAbsolute(expectedFilePath) || expectedFilePath.includes("\n")) {
    fail("invalid_arguments");
  }
  return { expectedFilePath };
}

function outputReceipt(receipt) {
  const safe = {
    status: receipt.status,
    identityBefore: receipt.identityBefore,
    identityAfter: receipt.identityAfter,
    refreshOutcome: receipt.refreshOutcome,
    pages: receipt.pages.map(({ id, ok, matched }) => ({ id, ok, matched })),
    ...(receipt.failureCode ? { failureCode: receipt.failureCode } : {}),
    ...(receipt.cleanup ? { cleanup: receipt.cleanup } : {}),
  };
  process.stdout.write(`DUEGOOD_LIVE_VERIFY ${JSON.stringify(safe)}\n`);
}

async function main() {
  installSignalHandlers();
  let args;
  try { args = parseArguments(process.argv.slice(2)); }
  catch { outputReceipt({ status: "failed", identityBefore: false, identityAfter: false, refreshOutcome: "unknown", pages: [], failureCode: "invalid_arguments" }); process.exitCode = 2; return; }
  const receipt = await runLiveVerification({ ...args, progress: (message) => process.stdout.write(`[live verify] ${message}\n`) });
  outputReceipt(receipt);
  if (requestedSignal) process.exitCode = requestedSignal === "SIGINT" ? 130 : 143;
  else if (receipt.status !== "passed") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    outputReceipt({ status: "failed", identityBefore: false, identityAfter: false, refreshOutcome: "unknown", pages: [], failureCode: "verification_failed" });
    process.exitCode = 2;
  });
}
