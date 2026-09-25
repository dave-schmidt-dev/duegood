#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_BUNDLE_ID = "com.zerodelta.duegood.test";
const PROJECT = path.join(ROOT, "test/native/macos/DueGoodDesktopUITests.xcodeproj");
const SCHEME = "DueGoodDesktopUITests";
const TEST_CASE = `${SCHEME}/DueGoodDesktopUITests/testFirstRunCalendarConnectionWithoutLegacyImport`;
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
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
let deadline = Date().addingTimeInterval(10)
while !app.isTerminated && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
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
  process.stdout.write(`[macOS smoke] ${message}\n`);
}

function runCapture(command, args, options = {}) {
  const { input, maxBytes = 32 * 1024 * 1024, timeoutMs = 60_000, ...spawnOptions } = options;
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
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (timedOut) reject(new Error(`${path.basename(command)} timed out after ${timeoutMs / 1000} seconds.`));
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

function runStreaming(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 15 * 60 * 1000, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let pendingOut = "";
    let pendingErr = "";
    let timedOut = false;
    let forceKillTimer;
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
    const flush = (buffer, label, final = false) => {
      const lines = buffer.split(/\r?\n/);
      const rest = final ? "" : (lines.pop() ?? "");
      for (const line of lines) if (line.trim()) process.stdout.write(`${label}${line}\n`);
      if (final && lines.at(-1) === undefined && buffer.trim()) process.stdout.write(`${label}${buffer.trim()}\n`);
      return rest;
    };
    child.stdout.on("data", (chunk) => { pendingOut = flush(pendingOut + chunk.toString(), "[xcodebuild] "); });
    child.stderr.on("data", (chunk) => { pendingErr = flush(pendingErr + chunk.toString(), "[xcodebuild] "); });
    child.on("error", (error) => {
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (pendingOut) flush(pendingOut, "[xcodebuild] ", true);
      if (pendingErr) flush(pendingErr, "[xcodebuild] ", true);
      if (timedOut) reject(new Error("xcodebuild timed out after 15 minutes."));
      else if (code === 0) resolve();
      else reject(new Error(`xcodebuild exited ${code ?? signal}`));
    });
  });
}

function assertPrivateDirectory(directory) {
  const mode = lstatSync(directory).mode & 0o777;
  if (mode !== 0o700) chmodSync(directory, 0o700);
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

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "duegood-tauri-ui-smoke-"));
  chmodSync(tempRoot, 0o700);
  const dataRoot = path.join(tempRoot, TEST_BUNDLE_ID);
  let clipboard;
  let registrationAttempted = false;
  let uiRunStarted = false;
  let testAppStopped = true;
  let failure;
  try {
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
    ], { cwd: ROOT, env });
    progress("The isolated macOS UI smoke passed.");
  } catch (error) {
    failure = error;
  } finally {
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
    if (testAppStopped) rmSync(tempRoot, { recursive: true, force: true });
    else progress("Preserving the isolated test files because app termination was not confirmed.");
  }
  if (failure) throw failure;
}

main().catch((error) => {
  process.stderr.write(`[macOS smoke] ${error.message}\n`);
  process.exitCode = 1;
});
