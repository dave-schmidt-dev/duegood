#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, closeSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOwnedScratchRoot, preserveScratchEvidence } from "./owned-scratch-root.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_BUNDLE_ID = "com.zerodelta.duegood.test";
const PROJECT = path.join(ROOT, "test/native/macos/DueGoodDesktopUITests.xcodeproj");
const SCHEME = "DueGoodDesktopUITests";
const TEST_CASE = `${SCHEME}/DueGoodDesktopUITests/testFirstRunCalendarConnectionWithoutLegacyImport`;
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const activeChildren = new Set();
let requestedSignal;
let cleanupStarted = false;
let interruptKillTimer;

function childEnded(child) {
  activeChildren.delete(child);
  if (activeChildren.size === 0 && interruptKillTimer !== undefined) {
    clearTimeout(interruptKillTimer);
    interruptKillTimer = undefined;
  }
}

function signalChild(child, signal) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch {
    try { child.kill(signal); }
    catch { /* The child already exited. */ }
  }
}

export function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      requestedSignal ??= signal;
      process.exitCode = requestedSignal === "SIGINT" ? 130 : 143;
      // Finish cleanup before exiting, while still recording a signal received
      // during cleanup for the eventual process status.
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

function safeWrite(stream, message) {
  try { stream.write(message); }
  catch { /* A closed output stream must not interrupt cleanup. */ }
}

const testAppControlSwift = String.raw`
import AppKit
import Foundation

let environment = ProcessInfo.processInfo.environment
guard let mode = environment["DUEGOOD_TEST_APP_CONTROL"],
      let appPath = environment["DUEGOOD_CONTROL_APP_PATH"] else { exit(2) }
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.zerodelta.duegood.test")
if mode == "check" {
    exit(apps.isEmpty ? 0 : 1)
}
guard mode == "stop" else { exit(2) }
if apps.isEmpty { exit(0) }
guard apps.count == 1,
      let app = apps.first,
      app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == URL(fileURLWithPath: appPath).resolvingSymlinksInPath().standardizedFileURL.path else { exit(2) }
_ = app.terminate()
var deadline = Date().addingTimeInterval(10)
while !app.isTerminated && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
if !app.isTerminated {
    _ = app.forceTerminate()
    deadline = Date().addingTimeInterval(5)
    while !app.isTerminated && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
}
exit(app.isTerminated ? 0 : 1)
`;

const pasteboardSwift = String.raw`
import AppKit
import Foundation

func stop(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

do {
    let mode = ProcessInfo.processInfo.environment["DUEGOOD_PASTEBOARD_MODE"] ?? ""
    let pasteboard = NSPasteboard.general
    if mode == "save" {
        var saved = [[String: String]]()
        var total = 0
        for item in pasteboard.pasteboardItems ?? [] {
            var flavors = [String: String]()
            for type in item.types {
                guard let data = item.data(forType: type) else { stop("The current clipboard could not be saved completely.") }
                total += data.count
                guard total <= 16 * 1024 * 1024 else { stop("The current clipboard is too large for a safe smoke run.") }
                flavors[type.rawValue] = data.base64EncodedString()
            }
            saved.append(flavors)
        }
        let bytes = try JSONSerialization.data(withJSONObject: saved, options: [.fragmentsAllowed])
        guard bytes.count <= 24 * 1024 * 1024 else { stop("The current clipboard is too large for a safe smoke run.") }
        FileHandle.standardOutput.write(bytes)
    } else if mode == "restore" {
        let bytes = FileHandle.standardInput.readDataToEndOfFile()
        let saved = try JSONSerialization.jsonObject(with: bytes) as? [[String: String]]
        guard let saved else { stop("The saved clipboard snapshot is invalid.") }
        var items = [NSPasteboardItem]()
        for flavors in saved {
            let item = NSPasteboardItem()
            for (rawType, encoded) in flavors {
                guard let data = Data(base64Encoded: encoded) else { stop("The saved clipboard snapshot is invalid.") }
                item.setData(data, forType: NSPasteboard.PasteboardType(rawType))
            }
            items.append(item)
        }
        pasteboard.clearContents()
        if !items.isEmpty && !pasteboard.writeObjects(items) { stop("The clipboard could not be restored.") }
        FileHandle.standardOutput.write(Data("restored".utf8))
    } else {
        stop("Invalid clipboard helper mode.")
    }
} catch {
    stop("The clipboard snapshot operation failed.")
}
`;

function progress(message) {
  safeWrite(process.stdout, `[macOS smoke] ${message}\n`);
}

export function runCapture(command, args, options = {}) {
  const { input, maxBytes = 32 * 1024 * 1024, timeoutMs = 60_000, onProcessGroupStopped = () => {}, ...spawnOptions } = options;
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
      progress(`${path.basename(command)} exceeded its time limit; stopping it.`);
      try { process.kill(-child.pid, "SIGTERM"); }
      catch { child.kill("SIGTERM"); }
      forceKillTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }, 5_000);
    }, timeoutMs);
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
    child.on("error", (error) => {
      spawnError = true;
      childEnded(child);
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      onProcessGroupStopped();
      reject(error);
    });
    child.on("close", async (code, signal) => {
      if (spawnError) return;
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      const groupStopped = await stopLingeringProcessGroup(child).catch(() => false);
      if (groupStopped) onProcessGroupStopped();
      childEnded(child);
      if (!groupStopped) reject(new Error(`${path.basename(command)} left an active child process.`));
      else if (timedOut) reject(new Error(`${path.basename(command)} timed out after ${timeoutMs / 1000} seconds.`));
      else if (oversized) reject(new Error(`${path.basename(command)} output exceeded its safety limit.`));
      else if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").slice(-2000);
        reject(new Error(`${path.basename(command)} exited ${code ?? signal}${diagnostic ? `: ${diagnostic}` : ""}`));
      } else resolve(Buffer.concat(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runSwift(code, tempRoot, options = {}) {
  return runCapture("/usr/bin/swift", ["-module-cache-path", path.join(tempRoot, "SwiftModuleCache"), "-e", code], options);
}

export function runStreaming(command, args, options = {}) {
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
        signalChild(child, "SIGTERM");
      }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      progress("Xcode UI test exceeded its 15 minute deadline; stopping it.");
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
      childEnded(child);
      clearTimers();
      closeLog();
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

function assertPrivateDirectory(directory) {
  const mode = lstatSync(directory).mode & 0o777;
  if (mode !== 0o700) chmodSync(directory, 0o700);
}

export async function withSmokeTempRoot(work, {
  cleanup = async () => {},
  projectRoot = ROOT,
  evidenceEntries = ["DueGoodDesktopUITests.xcresult", "xcodebuild.log"],
} = {}) {
  const scratch = createOwnedScratchRoot("tauri-ui-smoke");
  const tempRoot = scratch.root;
  let failure;
  try {
    await work(tempRoot, scratch);
  } catch (error) {
    failure = error;
  } finally {
    cleanupStarted = true;
    if (interruptKillTimer !== undefined) {
      clearTimeout(interruptKillTimer);
      interruptKillTimer = undefined;
    }
    try { await cleanup(tempRoot, scratch); }
    catch (error) { failure ??= error; }
    try {
      if (failure && !scratch.isActive()) {
        const saved = preserveScratchEvidence({ scratch, projectRoot, entries: evidenceEntries });
        if (saved) progress("Private failed UI-smoke evidence was saved under project .logs.");
      } else if (failure && scratch.isActive()) {
        progress("An isolated child or app remains active; its scratch root and evidence were preserved in place.");
      }
    } catch (error) { failure ??= new Error(`Could not preserve private UI-smoke evidence: ${error.message}`); }
    if (scratch.isActive()) progress("The isolated app is still active; its scratch root was preserved.");
    else {
      try { scratch.cleanup(); }
      catch (error) { failure ??= new Error(`Could not remove isolated test files: ${error.message}`); }
    }
    cleanupStarted = false;
  }
  if (failure) throw failure;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("The macOS UI smoke requires macOS and Xcode.");
  if (!process.env.DUEGOOD_TEST_APP_PATH) throw new Error("Set DUEGOOD_TEST_APP_PATH to the staged test-identifier Due Good.app.");
  const appPath = realpathSync(process.env.DUEGOOD_TEST_APP_PATH);
  if (!appPath.endsWith(".app")) throw new Error("DUEGOOD_TEST_APP_PATH must name a .app bundle.");
  if (appPath === "/Applications/Due Good.app") throw new Error("The UI smoke refuses to launch the production app bundle.");

  const infoPlist = path.join(appPath, "Contents/Info.plist");
  progress("Checking the staged test app identity, signature, and Launch Services utility.");
  const bundleIdentifier = (await runCapture("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist])).toString("utf8").trim();
  if (bundleIdentifier !== TEST_BUNDLE_ID) throw new Error("The staged app does not use the isolated test bundle identifier.");
  await runCapture("/usr/bin/codesign", ["--verify", "--strict", appPath]);
  if (!lstatSync(LSREGISTER).isFile()) throw new Error("Launch Services registration utility is unavailable.");

  let clipboard;
  let registrationAttempted = false;
  let uiRunStarted = false;
  let testAppStopped = true;
  let xcodeGroupStopped = true;
  await withSmokeTempRoot(async (tempRoot, scratch) => {
    const dataRoot = path.join(tempRoot, TEST_BUNDLE_ID);
    chmodSync(tempRoot, 0o700);
    progress("Checking that no test-identifier app instance is already running.");
    await runSwift(testAppControlSwift, tempRoot, {
      env: { ...process.env, DUEGOOD_TEST_APP_CONTROL: "check", DUEGOOD_CONTROL_APP_PATH: appPath },
      maxBytes: 1024,
    });
    progress("Saving the current pasteboard privately.");
    clipboard = await runSwift(pasteboardSwift, tempRoot, { env: { ...process.env, DUEGOOD_PASTEBOARD_MODE: "save" }, maxBytes: 24 * 1024 * 1024 });
    progress("Preparing the isolated test data root.");
    assertPrivateDirectory(tempRoot);
    registrationAttempted = true;
    progress("Registering the isolated test app with Launch Services.");
    await runCapture(LSREGISTER, ["-f", appPath]);

    const derivedData = path.join(tempRoot, "DerivedData");
    const resultBundle = path.join(tempRoot, "DueGoodDesktopUITests.xcresult");
    const env = {
      ...process.env,
      DUEGOOD_TEST_APP_PATH: appPath,
      TEST_RUNNER_DUEGOOD_TEST_APP_PATH: appPath,
      TEST_RUNNER_DUEGOOD_TEST_DATA_ROOT: dataRoot,
    };
    progress("Running the isolated calendar first-run and relaunch smoke.");
    uiRunStarted = true;
    testAppStopped = false;
    xcodeGroupStopped = false;
    scratch.setActive(true);
    await runStreaming("/usr/bin/xcodebuild", [
      "test",
      "-project", PROJECT,
      "-scheme", SCHEME,
      "-destination", "platform=macOS,arch=arm64",
      "-derivedDataPath", derivedData,
      "-resultBundlePath", resultBundle,
      "-parallel-testing-enabled", "NO",
      `-only-testing:${TEST_CASE}`,
      "CODE_SIGN_IDENTITY=-",
      "CODE_SIGN_STYLE=Manual",
    ], {
      cwd: ROOT,
      env,
      logPath: path.join(tempRoot, "xcodebuild.log"),
      onProcessGroupStopped: () => {
        xcodeGroupStopped = true;
        scratch.setActive(!testAppStopped);
      },
    });
    progress("The isolated macOS UI smoke passed.");
  }, { projectRoot: ROOT, cleanup: async (tempRoot, scratch) => {
    let failure;
    if (uiRunStarted) {
      progress("Stopping any test app instance before removing isolated data.");
      try {
        await runSwift(testAppControlSwift, tempRoot, {
          env: { ...process.env, DUEGOOD_TEST_APP_CONTROL: "stop", DUEGOOD_CONTROL_APP_PATH: appPath },
          maxBytes: 1024,
        });
        testAppStopped = true;
      } catch (error) {
        testAppStopped = false;
        failure ??= new Error(`Could not stop the isolated test app: ${error.message}`);
      }
    }
    if (registrationAttempted) {
      progress("Unregistering the isolated test bundle.");
      try { await runCapture(LSREGISTER, ["-u", appPath]); }
      catch (error) { failure ??= new Error(`Could not unregister the isolated test bundle: ${error.message}`); }
    }
    if (clipboard !== undefined) {
      progress("Restoring the pasteboard.");
      try {
        await runSwift(pasteboardSwift, tempRoot, {
          env: { ...process.env, DUEGOOD_PASTEBOARD_MODE: "restore" },
          input: clipboard,
          maxBytes: 1024,
        });
      } catch (error) {
        failure ??= new Error(`Could not restore the saved pasteboard: ${error.message}`);
      }
    }
    if (!testAppStopped) {
      progress("The isolated test app may still be running; its scratch root will be preserved.");
      failure ??= new Error("Could not confirm the isolated test app stopped.");
    }
    scratch.setActive(!testAppStopped || !xcodeGroupStopped);
    progress(testAppStopped ? "The isolated test app stopped; scratch cleanup is safe." : "The isolated test app remains active; its scratch root will be preserved.");
    if (failure) throw failure;
  } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installSignalHandlers();
  main().catch((error) => {
    safeWrite(process.stderr, `[macOS smoke] ${error.message}\n`);
    process.exitCode = requestedSignal === "SIGINT" ? 130 : requestedSignal === "SIGTERM" ? 143 : 1;
  });
}
