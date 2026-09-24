#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_BUNDLE_ID = "com.zerodelta.duegood";
const TEST_SCHEME = "DueGoodDesktopUITests";
const TEST_CASE = `${TEST_SCHEME}/DueGoodDesktopUITests/testProductionIdentifierLaunchOnly`;
const PROJECT = path.join(ROOT, "test/native/macos/DueGoodDesktopUITests.xcodeproj");
const ALLOWED_LAUNCH_FILES = new Set(["duegood.instance.lock", "duegood.write.lock", "duegood.refresh.lock"]);
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

function runCapture(command, args, options = {}) {
  const { input, maxBytes = 4 * 1024 * 1024, timeoutMs = 60_000, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOptions, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let timedOut = false;
    let oversized = false;
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
    child.on("error", (error) => { clearTimers(); reject(error); });
    child.on("close", (code, signal) => {
      clearTimers();
      if (timedOut) reject(new Error(`${path.basename(command)} timed out after ${timeoutMs / 1000} seconds.`));
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
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let timedOut = false;
    let oversized = false;
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
    child.on("error", (error) => { clearTimers(); reject(error); });
    child.on("close", (code, signal) => {
      clearTimers();
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
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "duegood-phase4-swift-cache-"));
  try {
    return await runCapture("/usr/bin/swift", ["-module-cache-path", path.join(cacheRoot, "Modules"), "-e", code], options);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function runStreaming(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 15 * 60 * 1000, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    let forceKillTimer;
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
    const drain = (chunk, label, prior) => {
      const lines = (prior + chunk.toString()).split(/\r?\n/);
      const rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) process.stdout.write(`${label}${line}\n`);
      return rest;
    };
    child.stdout.on("data", (chunk) => { out = drain(chunk, "[xcodebuild] ", out); });
    child.stderr.on("data", (chunk) => { err = drain(chunk, "[xcodebuild] ", err); });
    child.on("error", (error) => {
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      for (const line of [out, err]) if (line.trim()) process.stdout.write(`[xcodebuild] ${line}\n`);
      if (timedOut) reject(new Error("xcodebuild timed out after 15 minutes."));
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
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "duegood-production-launch-"));
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
    });
  } catch (error) {
    checkFailure = error;
  } finally {
    let safeToCleanRoot = !launchRequested;
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
      safeToCleanRoot = afterStop.length === 0;
    } else if (launchRequested) {
      checkFailure ??= new Error("The app launch process could not be identified; its production data folder was preserved.");
    }
    if (checkFailure) progress("Preserving the private failed XCTest result for diagnosis.");
    else rmSync(tempRoot, { recursive: true, force: true });
    if (safeToCleanRoot) {
      try {
        progress("Removing only allowlisted launch files and the empty root recorded absent before Phase 4.");
        await cleanupRoot(dataRoot);
      } catch (error) { checkFailure ??= error; }
    } else {
      checkFailure ??= new Error("The production app is still running; its data folder was preserved.");
    }
  }
  if (checkFailure) throw checkFailure;
  progress("The production launch-only check passed; no coursework import or Canvas request was made.");
}

main().catch((error) => {
  process.stderr.write(`[production launch] ${error.message}\n`);
  process.exitCode = 1;
});
