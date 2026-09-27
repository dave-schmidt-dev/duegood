#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOwnedScratchRoot, preserveScratchEvidence } from "./owned-scratch-root.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_BUNDLE_ID = "com.zerodelta.duegood";
const TEST_SCHEME = "DueGoodDesktopUITests";
const TEST_CASE = `${TEST_SCHEME}/DueGoodDesktopUITests/testProductionIdentifierLaunchOnly`;
const PROJECT = path.join(ROOT, "test/native/macos/DueGoodDesktopUITests.xcodeproj");
const ALLOWED_LAUNCH_FILES = new Set(["duegood.instance.lock", "duegood.write.lock", "duegood.refresh.lock"]);
const activeChildren = new Set();
let requestedSignal;
let cleanupStarted = false;
let interruptKillTimer;
const runningAppsSwift = String.raw`
import AppKit
import Foundation

let environment = ProcessInfo.processInfo.environment
guard let bundleID = environment["DUEGOOD_QUERY_BUNDLE_ID"] else { exit(2) }
let waitSeconds = Double(environment["DUEGOOD_QUERY_WAIT_SECONDS"] ?? "0") ?? 0
let deadline = Date().addingTimeInterval(waitSeconds)
repeat {
    let matches = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    if !matches.isEmpty {
        for app in matches {
            print("\(app.processIdentifier)\t\(app.bundleURL?.standardizedFileURL.path ?? "")")
        }
        exit(0)
    }
    if waitSeconds == 0 || Date() >= deadline { break }
    Thread.sleep(forTimeInterval: 0.25)
} while true
exit(0)
`;
const launchAppSwift = String.raw`
import AppKit
import Foundation

let environment = ProcessInfo.processInfo.environment
guard let appPath = environment["DUEGOOD_LAUNCH_APP_PATH"] else { exit(2) }
let appURL = URL(fileURLWithPath: appPath, isDirectory: true)
let configuration = NSWorkspace.OpenConfiguration()
configuration.createsNewApplicationInstance = true
configuration.activates = true
var launched: NSRunningApplication?
var launchError: Error?
NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { application, error in
    launched = application
    launchError = error
}
let deadline = Date().addingTimeInterval(30)
while launched == nil && launchError == nil && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
}
guard launchError == nil,
      let application = launched,
      application.bundleURL?.standardizedFileURL.path == appPath else { exit(1) }
print(application.processIdentifier)
`;
const terminateAppSwift = String.raw`
import AppKit
import Foundation

let environment = ProcessInfo.processInfo.environment
guard let bundleID = environment["DUEGOOD_QUERY_BUNDLE_ID"],
      let expectedPath = environment["DUEGOOD_QUERY_APP_PATH"],
      let pidValue = Int32(environment["DUEGOOD_QUERY_PID"] ?? "") else { exit(2) }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    .first(where: { $0.processIdentifier == pidValue && $0.bundleURL?.standardizedFileURL.path == expectedPath }) else { exit(0) }
_ = app.terminate()
let deadline = Date().addingTimeInterval(10)
while Date() < deadline {
    let stillRunning = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        .contains { $0.processIdentifier == pidValue && $0.bundleURL?.standardizedFileURL.path == expectedPath }
    if !stillRunning { exit(0) }
    Thread.sleep(forTimeInterval: 0.1)
}
exit(1)
`;

function progress(message) {
  process.stdout.write(`[production launch] ${message}\n`);
}

function signalChild(child, signal) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch {
    try { child.kill(signal); }
    catch { /* The child already exited. */ }
  }
}

function childEnded(child) {
  activeChildren.delete(child);
  if (activeChildren.size === 0 && interruptKillTimer !== undefined) {
    clearTimeout(interruptKillTimer);
    interruptKillTimer = undefined;
  }
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      requestedSignal ??= signal;
      process.exitCode = requestedSignal === "SIGINT" ? 130 : 143;
      if (cleanupStarted) return;
      for (const child of activeChildren) signalChild(child, requestedSignal);
      if (activeChildren.size > 0 && interruptKillTimer === undefined) {
        interruptKillTimer = setTimeout(() => {
          for (const child of activeChildren) signalChild(child, "SIGKILL");
          interruptKillTimer = undefined;
        }, 5_000);
        interruptKillTimer.unref();
      }
    });
  }
}

function rejectIfInterrupted() {
  if (requestedSignal && !cleanupStarted) throw new Error(`Interrupted by ${requestedSignal}.`);
}

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function stopLingeringProcessGroup(child) {
  if (child.pid === undefined || !processGroupExists(child.pid)) return true;
  progress("Stopping a remaining child process from the isolated command.");
  signalChild(child, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, 2_000)) return true;
  signalChild(child, "SIGKILL");
  return waitForProcessGroupExit(child.pid, 3_000);
}

function runCapture(command, args, options = {}) {
  const { input, maxBytes = 4 * 1024 * 1024, timeoutMs = 60_000, onProcessGroupStopped = () => {}, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    try { rejectIfInterrupted(); }
    catch (error) { onProcessGroupStopped(); reject(error); return; }
    const child = spawn(command, args, { ...spawnOptions, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    activeChildren.add(child);
    const stdout = [];
    const stderr = [];
    let size = 0;
    let timedOut = false;
    let oversized = false;
    let spawnError = false;
    let forceKillTimer;
    const deadline = setTimeout(() => {
      timedOut = true;
      progress(`${path.basename(command)} exceeded its 60 second deadline; stopping it.`);
      try { process.kill(-child.pid, "SIGTERM"); }
      catch { child.kill("SIGTERM"); }
      forceKillTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }, 5_000);
    }, timeoutMs);
    const clearTimers = () => {
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    };
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { spawnError = true; clearTimers(); childEnded(child); onProcessGroupStopped(); reject(error); });
    child.on("close", async (code, signal) => {
      if (spawnError) return;
      clearTimers();
      const groupStopped = await stopLingeringProcessGroup(child).catch(() => false);
      if (groupStopped) onProcessGroupStopped();
      childEnded(child);
      if (!groupStopped) reject(new Error(`${path.basename(command)} left a child process running; its scratch root was preserved.`));
      else if (timedOut) reject(new Error(`${path.basename(command)} timed out after ${timeoutMs / 1000} seconds.`));
      else if (oversized) reject(new Error(`${path.basename(command)} output exceeded its safety limit.`));
      else if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").slice(-1500);
        reject(new Error(`${path.basename(command)} exited ${code ?? signal}${diagnostic ? `: ${diagnostic}` : ""}`));
      } else resolve(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

function runCaptureBoth(command, args, { timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    try { rejectIfInterrupted(); }
    catch (error) { reject(error); return; }
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    const stdout = [];
    const stderr = [];
    let size = 0;
    let timedOut = false;
    let oversized = false;
    let spawnError = false;
    let forceKillTimer;
    const deadline = setTimeout(() => {
      timedOut = true;
      progress(`${path.basename(command)} exceeded its 60 second deadline; stopping it.`);
      try { process.kill(-child.pid, "SIGTERM"); }
      catch { child.kill("SIGTERM"); }
      forceKillTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }, 5_000);
    }, timeoutMs);
    const clearTimers = () => {
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    };
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      } else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => { spawnError = true; clearTimers(); childEnded(child); reject(error); });
    child.on("close", async (code, signal) => {
      if (spawnError) return;
      clearTimers();
      const groupStopped = await stopLingeringProcessGroup(child).catch(() => false);
      childEnded(child);
      if (!groupStopped) {
        reject(new Error(`${path.basename(command)} left a child process running.`));
        return;
      }
      if (timedOut) {
        reject(new Error(`${path.basename(command)} timed out after ${timeoutMs / 1000} seconds.`));
        return;
      }
      if (oversized) {
        reject(new Error(`${path.basename(command)} output exceeded its safety limit.`));
        return;
      }
      const output = Buffer.concat([...stdout, ...stderr]).toString("utf8");
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} exited ${code ?? signal}`));
    });
  });
}

async function runSwift(code, options = {}) {
  const cache = createOwnedScratchRoot("production-launch-swift-cache");
  cache.setActive(true);
  try {
    return await runCapture("/usr/bin/swift", ["-module-cache-path", path.join(cache.root, "Modules"), "-e", code], {
      ...options,
      onProcessGroupStopped: () => cache.setActive(false),
    });
  } finally {
    if (!cache.isActive()) cache.cleanup();
  }
}

function runStreaming(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 15 * 60 * 1000, logPath, onProcessGroupStopped = () => {}, ...spawnOptions } = options;
    try { rejectIfInterrupted(); }
    catch (error) { onProcessGroupStopped(); reject(error); return; }
    const maxLogBytes = 8 * 1024 * 1024;
    let logFd;
    try { if (logPath) logFd = openSync(logPath, "wx", 0o600); }
    catch (error) { onProcessGroupStopped(); reject(error); return; }
    const child = spawn(command, args, { ...spawnOptions, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    let loggedBytes = 0;
    let logTruncated = false;
    let logFailure;
    let timedOut = false;
    let spawnError = false;
    let forceKillTimer;
    const closeLog = () => {
      if (logFd === undefined) return;
      try {
        if (logTruncated) writeSync(logFd, Buffer.from("\n[output truncated at 8 MiB]\n"));
        closeSync(logFd);
      } catch (error) { logFailure ??= error; }
      logFd = undefined;
    };
    const capture = (label, chunk) => {
      if (logFd === undefined || logFailure) return;
      try {
        const prefix = Buffer.from(`[${label}] `);
        const remaining = maxLogBytes - loggedBytes;
        if (remaining <= 0) { logTruncated = true; return; }
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const prefixBytes = prefix.subarray(0, remaining);
        writeSync(logFd, prefixBytes);
        loggedBytes += prefixBytes.length;
        const content = bytes.subarray(0, Math.max(0, remaining - prefixBytes.length));
        if (content.length > 0) { writeSync(logFd, content); loggedBytes += content.length; }
        if (content.length < bytes.length || prefixBytes.length < prefix.length) logTruncated = true;
      } catch (error) {
        logFailure = error;
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      process.stdout.write("[production launch] Xcode UI test exceeded its 15 minute deadline; stopping it.\n");
      try { process.kill(-child.pid, "SIGINT"); }
      catch { child.kill("SIGINT"); }
      forceKillTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }, 10_000);
    }, timeoutMs);
    const progressTimer = setInterval(() => progress("Xcode UI test is still running; command output is retained privately."), 30_000);
    const clearTimers = () => {
      clearTimeout(deadline);
      clearInterval(progressTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", (error) => {
      spawnError = true;
      clearTimers();
      closeLog();
      childEnded(child);
      onProcessGroupStopped();
      reject(logFailure ?? error);
    });
    child.on("close", async (code, signal) => {
      if (spawnError) return;
      clearTimers();
      closeLog();
      const groupStopped = await stopLingeringProcessGroup(child).catch(() => false);
      if (groupStopped) onProcessGroupStopped();
      childEnded(child);
      if (!groupStopped) reject(new Error("xcodebuild left an active child process; its scratch root was preserved."));
      else if (logFailure) reject(logFailure);
      else if (timedOut) reject(new Error("xcodebuild timed out after 15 minutes."));
      else if (code === 0) resolve();
      else reject(new Error(`xcodebuild exited ${code ?? signal}`));
    });
  });
}

function bundleIdentifier(appPath) {
  return runCapture("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(appPath, "Contents/Info.plist")]);
}

function assertPrivateMarker(markerPath, expectedRoot) {
  const markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && markerStat.uid !== process.getuid())) {
    throw new Error("The phase-owned root marker is not a private regular file.");
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (marker.root !== expectedRoot || marker.existedBeforePhase !== false) {
    throw new Error("The phase marker does not prove this production data root was absent before Phase 4.");
  }
}

function checkRootShape(root) {
  let metadata;
  try { metadata = lstatSync(root); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The production data root is not a plain directory.");
  if ((metadata.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("The production data root is not owned by this user with private 0700 permissions.");
  }
  const entries = readdirSync(root);
  for (const name of entries) {
    if (!ALLOWED_LAUNCH_FILES.has(name)) throw new Error("The production data root contains data beyond the launch-only lock files; it was preserved.");
    const entryPath = path.join(root, name);
    const entry = lstatSync(entryPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== 0 || (entry.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && entry.uid !== process.getuid())) {
      throw new Error("A launch-only lock artifact is not an empty regular 0600 file; the root was preserved.");
    }
  }
  return true;
}

async function getRunningApps() {
  const output = await runSwift(runningAppsSwift, {
    env: { ...process.env, DUEGOOD_QUERY_BUNDLE_ID: PRODUCTION_BUNDLE_ID },
    maxBytes: 8192,
  });
  return output.toString("utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => ({
    pid: Number(line.split("\t", 1)[0]),
    path: line.slice(line.indexOf("\t") + 1),
  }));
}

async function awaitRunning(appPath) {
  progress("Waiting up to 30 seconds for the installed app process.");
  const output = await runSwift(runningAppsSwift, {
    env: { ...process.env, DUEGOOD_QUERY_BUNDLE_ID: PRODUCTION_BUNDLE_ID, DUEGOOD_QUERY_APP_PATH: appPath, DUEGOOD_QUERY_WAIT_SECONDS: "30" },
    maxBytes: 8192,
  });
  const apps = output.toString("utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => ({
    pid: Number(line.split("\t", 1)[0]),
    path: line.slice(line.indexOf("\t") + 1),
  }));
  const matches = apps.filter((app) => app.path === appPath);
  if (matches.length !== 1 || apps.length !== 1 || !Number.isInteger(matches[0]?.pid)) {
    throw new Error("The staged production app did not start as a single process.");
  }
  return matches[0].pid;
}

async function cleanupRoot(root) {
  if (!checkRootShape(root)) return;
  for (const name of readdirSync(root)) unlinkSync(path.join(root, name));
  rmdirSync(root);
}

async function main() {
  if (process.platform !== "darwin") throw new Error("The production launch check requires macOS and Xcode.");
  const configuredApp = process.env.DUEGOOD_PRODUCTION_APP_PATH;
  if (!configuredApp) throw new Error("Set DUEGOOD_PRODUCTION_APP_PATH to /Applications/Due Good.app.");
  const appPath = realpathSync(configuredApp);
  if (appPath !== realpathSync("/Applications/Due Good.app")) throw new Error("The production launch check only opens the installed /Applications/Due Good.app.");
  if (!appPath.endsWith(".app")) throw new Error("DUEGOOD_PRODUCTION_APP_PATH must name a .app bundle.");
  progress("Checking the installed production bundle identity and signature.");
  const identifier = (await bundleIdentifier(appPath)).toString("utf8").trim();
  if (identifier !== PRODUCTION_BUNDLE_ID) throw new Error("The staged release app does not use the production bundle identifier.");
  await runCapture("/usr/bin/codesign", ["--verify", "--strict", appPath]);
  const signatureDetails = await runCaptureBoth("/usr/bin/codesign", ["-dv", "--verbose=2", appPath]);
  const authority = signatureDetails.split(/\r?\n/).find((line) => line.startsWith("Authority="))?.slice("Authority=".length);
  if (!authority?.startsWith("Developer ID Application:")) throw new Error("The installed production app lacks a verified Developer ID Application signature.");
  const helper = path.join(appPath, "Contents/MacOS/duegood-refresh");
  const helperStat = lstatSync(helper);
  if (!helperStat.isFile() || helperStat.isSymbolicLink()) throw new Error("The staged production helper is unavailable.");

  const home = realpathSync(os.homedir());
  const rootParent = path.join(home, "Library/Application Support");
  const canonicalParent = realpathSync(rootParent);
  const dataRoot = path.join(canonicalParent, PRODUCTION_BUNDLE_ID);
  const markerPath = process.env.DUEGOOD_PHASE4_ROOT_MARKER;
  if (!markerPath) throw new Error("Set DUEGOOD_PHASE4_ROOT_MARKER to the installer’s private Phase 4 baseline record.");
  assertPrivateMarker(markerPath, dataRoot);
  checkRootShape(dataRoot);

  progress("Verifying the content-free helper path report.");
  const rootReportBytes = await runCapture(helper, ["--report-store-root"], { maxBytes: 16 * 1024 });
  const rootReport = rootReportBytes.toString("utf8");
  if (!rootReport.endsWith("\n") || rootReport.slice(0, -1).includes("\n") || rootReport.slice(0, -1) !== dataRoot) {
    throw new Error("The helper store-root report did not match the canonical production app-data folder.");
  }

  progress("Checking which production app processes are running.");
  const alreadyRunning = await getRunningApps();
  if (alreadyRunning.length > 0) {
    if (alreadyRunning.length !== 1 || alreadyRunning[0]?.path !== appPath || !Number.isInteger(alreadyRunning[0]?.pid)) {
      throw new Error("A different Due Good process is running; the production launch check left it untouched.");
    }
    progress("Stopping the installer-started signed /Applications app before the isolated launch check.");
    await runSwift(terminateAppSwift, {
      env: {
        ...process.env,
        DUEGOOD_QUERY_BUNDLE_ID: PRODUCTION_BUNDLE_ID,
        DUEGOOD_QUERY_APP_PATH: appPath,
        DUEGOOD_QUERY_PID: String(alreadyRunning[0].pid),
      },
      maxBytes: 1024,
    });
    if ((await getRunningApps()).length !== 0) throw new Error("The installer-started app did not exit; the production root was preserved.");
  }
  const scratch = createOwnedScratchRoot("production-launch");
  const tempRoot = scratch.root;
  let launchedPid;
  let launchRequested = false;
  let checkFailure;
  try {
    mkdirSync(path.join(tempRoot, "DerivedData"), { recursive: true, mode: 0o700 });
    progress("Launching the installed production bundle for its first-run and unavailable-refresh check.");
    launchRequested = true;
    launchedPid = Number((await runSwift(launchAppSwift, {
      env: { ...process.env, DUEGOOD_LAUNCH_APP_PATH: appPath },
      maxBytes: 1024,
    })).toString("utf8").trim());
    if (!Number.isInteger(launchedPid) || launchedPid <= 0) throw new Error("The staged production app did not return a launch process.");
    const runningPid = await awaitRunning(appPath);
    if (runningPid !== launchedPid) throw new Error("The production process did not match the process opened from the staged bundle.");
    scratch.setActive(true);
    await runStreaming("/usr/bin/xcodebuild", [
      "test",
      "-project", PROJECT,
      "-scheme", TEST_SCHEME,
      "-destination", "platform=macOS,arch=arm64",
      "-derivedDataPath", path.join(tempRoot, "DerivedData"),
      "-resultBundlePath", path.join(tempRoot, "ProductionLaunch.xcresult"),
      "-parallel-testing-enabled", "NO",
      `-only-testing:${TEST_CASE}`,
      "CODE_SIGN_IDENTITY=-",
      "CODE_SIGN_STYLE=Manual",
      ], {
      cwd: ROOT,
      env: {
        ...process.env,
        DUEGOOD_PRODUCTION_APP_PATH: appPath,
        TEST_RUNNER_DUEGOOD_EXPECTED_PRODUCTION_DISPLAY_ROOT: `~/Library/Application Support/${PRODUCTION_BUNDLE_ID}`,
      },
      logPath: path.join(tempRoot, "xcodebuild.log"),
      onProcessGroupStopped: () => scratch.setActive(false),
    });
  } catch (error) {
    checkFailure = error;
  } finally {
    cleanupStarted = true;
    let safeToCleanDataRoot = !launchRequested;
    if (launchedPid !== undefined) {
      const remaining = await getRunningApps().catch(() => []);
      if (remaining.some((app) => app.pid === launchedPid && app.path === appPath)) {
        progress("Stopping the production app process started by this check.");
        try {
          await runSwift(terminateAppSwift, {
            env: {
              ...process.env,
              DUEGOOD_QUERY_BUNDLE_ID: PRODUCTION_BUNDLE_ID,
              DUEGOOD_QUERY_APP_PATH: appPath,
              DUEGOOD_QUERY_PID: String(launchedPid),
            },
            maxBytes: 1024,
          });
        } catch (error) { checkFailure ??= new Error(`Could not stop the app process started by this check: ${error.message}`); }
      }
      const afterStop = await getRunningApps().catch(() => [{ pid: launchedPid, path: appPath }]);
      safeToCleanDataRoot = afterStop.length === 0;
    } else if (launchRequested) {
      checkFailure ??= new Error("The app launch process could not be identified; its production data folder was preserved.");
    }
    if (!safeToCleanDataRoot) checkFailure ??= new Error("The production app is still running; its production data folder was preserved.");

    if (checkFailure) {
      if (scratch.isActive()) {
        progress("An isolated child process remains active; preserving its scratch root and evidence in place.");
      } else {
        progress("Preserving private failed launch evidence before scratch cleanup.");
        try {
          const saved = preserveScratchEvidence({
            scratch,
            projectRoot: ROOT,
            entries: ["ProductionLaunch.xcresult", "xcodebuild.log"],
          });
          if (saved) progress("Private failed launch evidence was saved under project .logs.");
        } catch (error) { checkFailure ??= new Error(`Could not preserve private launch evidence: ${error.message}`); }
      }
    }
    if (!scratch.isActive()) {
      try {
        scratch.cleanup();
      } catch (error) { checkFailure ??= error; }
    } else {
      progress("Keeping the scratch root until the isolated child process exits.");
    }
    if (safeToCleanDataRoot) {
      try {
        progress("Removing only allowlisted launch files and the empty root recorded absent before Phase 4.");
        await cleanupRoot(dataRoot);
      } catch (error) { checkFailure ??= error; }
    }
  }
if (checkFailure) throw checkFailure;
  progress("The production launch-only check passed; no coursework import or Canvas request was made.");
}

installSignalHandlers();
main().catch((error) => {
  process.stderr.write(`[production launch] ${error.message}\n`);
  process.exitCode = requestedSignal === "SIGINT" ? 130 : requestedSignal === "SIGTERM" ? 143 : 1;
});
