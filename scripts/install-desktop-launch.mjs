#!/usr/bin/env node
/** Cold, identity-bound launch and stop operations for the macOS installer. */
import { spawn } from "node:child_process";
import path from "node:path";

const APP_EXECUTABLE = "duegood-desktop";

const querySwift = String.raw`
import AppKit
import Foundation

let env = ProcessInfo.processInfo.environment
guard let bundleID = env["DUEGOOD_QUERY_BUNDLE_ID"] else { exit(2) }
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
let rows = apps.map { app in
    [String(app.processIdentifier), app.bundleURL?.standardizedFileURL.path ?? "", app.executableURL?.standardizedFileURL.path ?? ""]
}
guard let data = try? JSONSerialization.data(withJSONObject: rows),
      let text = String(data: data, encoding: .utf8) else { exit(3) }
print(text)
`;

const launchAtPathSwift = String.raw`
import AppKit
import Foundation

let env = ProcessInfo.processInfo.environment
guard let appPath = env["DUEGOOD_LAUNCH_APP_PATH"] else { exit(2) }
let appURL = URL(fileURLWithPath: appPath, isDirectory: true)
let config = NSWorkspace.OpenConfiguration()
config.createsNewApplicationInstance = true
config.activates = true
var launched: NSRunningApplication?
var launchError: Error?
NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, error in
    launched = app
    launchError = error
}
let deadline = Date().addingTimeInterval(30)
while launched == nil && launchError == nil && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
}
guard launchError == nil, let app = launched,
      app.bundleURL?.standardizedFileURL.path == appPath,
      let executable = app.executableURL?.standardizedFileURL.path else { exit(1) }
print("\(app.processIdentifier)\t\(app.bundleURL!.standardizedFileURL.path)\t\(executable)")
`;

const launchByBundleIdSwift = String.raw`
import AppKit
import Foundation

let env = ProcessInfo.processInfo.environment
guard let bundleID = env["DUEGOOD_QUERY_BUNDLE_ID"],
      let expectedPath = env["DUEGOOD_EXPECTED_APP_PATH"] else { exit(2) }
guard let resolvedURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID),
      resolvedURL.standardizedFileURL.path == expectedPath else { exit(4) }
let config = NSWorkspace.OpenConfiguration()
config.createsNewApplicationInstance = true
config.activates = true
var launched: NSRunningApplication?
var launchError: Error?
NSWorkspace.shared.openApplication(at: resolvedURL, configuration: config) { app, error in
    launched = app
    launchError = error
}
let deadline = Date().addingTimeInterval(30)
while launched == nil && launchError == nil && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
}
guard launchError == nil, let app = launched,
      app.bundleURL?.standardizedFileURL.path == expectedPath,
      let executable = app.executableURL?.standardizedFileURL.path else { exit(1) }
print("\(app.processIdentifier)\t\(app.bundleURL!.standardizedFileURL.path)\t\(executable)")
`;

const stopExactSwift = String.raw`
import AppKit
import Foundation

let env = ProcessInfo.processInfo.environment
guard let bundleID = env["DUEGOOD_QUERY_BUNDLE_ID"],
      let expectedPath = env["DUEGOOD_EXPECTED_APP_PATH"],
      let expectedExecutable = env["DUEGOOD_EXPECTED_EXECUTABLE_PATH"],
      let pid = Int32(env["DUEGOOD_QUERY_PID"] ?? "") else { exit(2) }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    .first(where: { $0.processIdentifier == pid }) else { exit(5) }
guard app.bundleURL?.standardizedFileURL.path == expectedPath,
      app.executableURL?.standardizedFileURL.path == expectedExecutable else { exit(6) }
_ = app.terminate()
let deadline = Date().addingTimeInterval(12)
while Date() < deadline {
    let stillRunning = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        .contains { $0.processIdentifier == pid }
    if !stillRunning { exit(0) }
    Thread.sleep(forTimeInterval: 0.1)
}
exit(7)
`;

const snapshotLockSwift = String.raw`
import Darwin
import Foundation

let env = ProcessInfo.processInfo.environment
guard let configuredRoot = env["DUEGOOD_SNAPSHOT_DATA_ROOT"] else { exit(2) }
let expectedRoot = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/com.zerodelta.duegood")
guard configuredRoot == expectedRoot else { exit(3) }
var rootInfo = stat()
guard lstat(configuredRoot, &rootInfo) == 0,
      (rootInfo.st_mode & S_IFMT) == S_IFDIR,
      rootInfo.st_uid == getuid(),
      (rootInfo.st_mode & 0o777) == 0o700 else { exit(4) }
guard let resolvedRoot = realpath(configuredRoot, nil), String(cString: resolvedRoot) == configuredRoot else { exit(5) }
free(resolvedRoot)
let rootFD = open(configuredRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
guard rootFD >= 0 else { exit(6) }
var openedRootInfo = stat()
guard fstat(rootFD, &openedRootInfo) == 0,
      openedRootInfo.st_dev == rootInfo.st_dev,
      openedRootInfo.st_ino == rootInfo.st_ino,
      (openedRootInfo.st_mode & S_IFMT) == S_IFDIR,
      openedRootInfo.st_uid == getuid(),
      (openedRootInfo.st_mode & 0o777) == 0o700 else { close(rootFD); exit(7) }
let lockName = "duegood.snapshot.lock"
var pathInfo = stat()
let preexisting = fstatat(rootFD, lockName, &pathInfo, AT_SYMLINK_NOFOLLOW) == 0
if !preexisting && errno != ENOENT { close(rootFD); exit(8) }
let fd = openat(rootFD, lockName, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, mode_t(0o600))
guard fd >= 0 else { close(rootFD); exit(9) }
var openedInfo = stat()
guard fstat(fd, &openedInfo) == 0,
      (openedInfo.st_mode & S_IFMT) == S_IFREG,
      openedInfo.st_uid == getuid(),
      (openedInfo.st_mode & 0o777) == 0o600 else { close(fd); close(rootFD); exit(10) }
var anchoredInfo = stat()
guard fstatat(rootFD, lockName, &anchoredInfo, AT_SYMLINK_NOFOLLOW) == 0,
      anchoredInfo.st_dev == openedInfo.st_dev,
      anchoredInfo.st_ino == openedInfo.st_ino,
      (!preexisting || (pathInfo.st_dev == openedInfo.st_dev && pathInfo.st_ino == openedInfo.st_ino)) else {
    close(fd); close(rootFD); exit(11)
}
var currentRootInfo = stat()
guard lstat(configuredRoot, &currentRootInfo) == 0,
      currentRootInfo.st_dev == openedRootInfo.st_dev,
      currentRootInfo.st_ino == openedRootInfo.st_ino,
      currentRootInfo.st_uid == getuid(),
      (currentRootInfo.st_mode & 0o777) == 0o700 else { close(fd); close(rootFD); exit(12) }
let deadline = Date().addingTimeInterval(20)
while flock(fd, LOCK_EX | LOCK_NB) != 0 {
    if errno != EWOULDBLOCK && errno != EAGAIN { close(fd); close(rootFD); exit(13) }
    if Date() >= deadline { close(fd); close(rootFD); exit(14) }
    Thread.sleep(forTimeInterval: 0.01)
}
var lockedLeafInfo = stat()
var lockedRootInfo = stat()
guard fstatat(rootFD, lockName, &lockedLeafInfo, AT_SYMLINK_NOFOLLOW) == 0,
      lockedLeafInfo.st_dev == openedInfo.st_dev,
      lockedLeafInfo.st_ino == openedInfo.st_ino,
      lstat(configuredRoot, &lockedRootInfo) == 0,
      lockedRootInfo.st_dev == openedRootInfo.st_dev,
      lockedRootInfo.st_ino == openedRootInfo.st_ino else { close(fd); close(rootFD); exit(15) }
let evidence: [String: Any] = [
    "rootPath": configuredRoot,
    "openedRoot": ["device": Int64(openedRootInfo.st_dev), "inode": Int64(openedRootInfo.st_ino), "uid": Int64(openedRootInfo.st_uid), "mode": Int(openedRootInfo.st_mode & 0o777), "kind": "directory"],
    "currentRoot": ["device": Int64(lockedRootInfo.st_dev), "inode": Int64(lockedRootInfo.st_ino), "uid": Int64(lockedRootInfo.st_uid), "mode": Int(lockedRootInfo.st_mode & 0o777), "kind": "directory"],
    "openedLock": ["device": Int64(openedInfo.st_dev), "inode": Int64(openedInfo.st_ino), "uid": Int64(openedInfo.st_uid), "mode": Int(openedInfo.st_mode & 0o777), "kind": "regular"],
    "currentLock": ["device": Int64(lockedLeafInfo.st_dev), "inode": Int64(lockedLeafInfo.st_ino), "uid": Int64(lockedLeafInfo.st_uid), "mode": Int(lockedLeafInfo.st_mode & 0o777), "kind": "regular"]
]
guard let evidenceData = try? JSONSerialization.data(withJSONObject: evidence),
      let evidenceText = String(data: evidenceData, encoding: .utf8) else { close(fd); close(rootFD); exit(16) }
print("LOCKED\t\(evidenceText)")
fflush(stdout)
while getchar() != EOF { }
close(fd)
close(rootFD)
`;

function safeAppInputs(bundleId, appPath) {
  if (typeof bundleId !== "string" || !/^[A-Za-z0-9.-]+$/u.test(bundleId)) throw new Error("The production bundle identifier is invalid.");
  if (typeof appPath !== "string" || !path.isAbsolute(appPath) || appPath.includes("\n")) throw new Error("The production app path is invalid.");
}

function parseIdentityRows(text) {
  let rows;
  try { rows = JSON.parse(text); }
  catch { throw new Error("Running application identities could not be read safely."); }
  if (!Array.isArray(rows)) throw new Error("Running application identities were malformed.");
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length !== 3) throw new Error("A running application identity was malformed.");
    const [pidText, appPath, executablePath] = row;
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || typeof appPath !== "string" || typeof executablePath !== "string") {
      throw new Error("A running application identity was malformed.");
    }
    return { pid, appPath, executablePath };
  });
}

function parseLaunchedIdentity(text) {
  const line = text.trim().split(/\r?\n/u)[0] ?? "";
  const [pidText, appPath, executablePath] = line.split("\t");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || !appPath || !executablePath) throw new Error("The app launch did not return a complete process identity.");
  return { pid, appPath, executablePath };
}

function assertOwnedIdentity(identity, { appPath, expectedPid } = {}) {
  const expectedExecutable = path.join(appPath, "Contents", "MacOS", APP_EXECUTABLE);
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0
      || (expectedPid !== undefined && identity.pid !== expectedPid)
      || identity.appPath !== appPath || identity.executablePath !== expectedExecutable) {
    throw new Error("A Due Good process did not match the installed app path, executable, and expected PID.");
  }
  return identity;
}

/** Validate descriptor-versus-name metadata returned after the native anchored lock was acquired. */
export function assertSnapshotCatalogIdentity(evidence, { dataRoot, uid = typeof process.getuid === "function" ? process.getuid() : undefined } = {}) {
  if (!evidence || evidence.rootPath !== dataRoot || !path.isAbsolute(dataRoot)) throw new Error("The snapshot catalog root identity is not the canonical production root.");
  const validatePair = (opened, current, kind, mode) => {
    for (const item of [opened, current]) {
      if (!item || item.kind !== kind || item.mode !== mode || !Number.isInteger(item.uid) || item.uid !== uid
          || !Number.isInteger(item.device) || !Number.isInteger(item.inode)) {
        throw new Error("The snapshot catalog path is not an owned regular lock target.");
      }
    }
    if (opened.device !== current.device || opened.inode !== current.inode) throw new Error("The snapshot catalog path changed during lock acquisition.");
  };
  validatePair(evidence.openedRoot, evidence.currentRoot, "directory", 0o700);
  validatePair(evidence.openedLock, evidence.currentLock, "regular", 0o600);
  return true;
}

/** Require a single live process to match the installed app path and executable exactly. */
export function assertSingleOwnedRunningApplication(apps, { appPath, expectedPid, bundleId = "com.zerodelta.duegood" } = {}) {
  safeAppInputs(bundleId, appPath);
  if (!Array.isArray(apps) || apps.length !== 1) throw new Error("Due Good is not running as exactly one process.");
  return assertOwnedIdentity(apps[0], { appPath, expectedPid, bundleId });
}

function assertCold(apps) {
  if (apps.length !== 0) throw new Error("Due Good is already running; a cold launch proof cannot use an existing process.");
}

function runSwift(code, { env = {}, inheritEnvironment = true, timeoutMs = 35_000, maxBytes = 16_384, spawnImpl = spawn } = {}) {
  if (process.platform !== "darwin") return Promise.reject(new Error("Native app launch proof requires macOS."));
  return new Promise((resolve, reject) => {
    const child = spawnImpl("/usr/bin/swift", ["-e", code], {
      env: { ...(inheritEnvironment ? process.env : {}), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let size = 0;
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish(new Error("A native launch identity check timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        finish(new Error("A native launch identity check returned too much output."));
      } else stdout.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => finish(new Error("A native launch identity check could not start.")));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) finish(new Error("A native launch identity check failed."));
      else finish(undefined, Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function acquireSnapshotLock({ dataRoot, spawnImpl = spawn, timeoutMs = 25_000 } = {}) {
  if (process.platform !== "darwin") return Promise.reject(new Error("Snapshot quiescence requires macOS."));
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) return Promise.reject(new Error("The production data root is not canonical and absolute."));
  return new Promise((resolve, reject) => {
    const child = spawnImpl("/usr/bin/swift", ["-e", snapshotLockSwift], {
      env: { ...process.env, DUEGOOD_SNAPSHOT_DATA_ROOT: dataRoot },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let ready = false;
    let settled = false;
    let timer;
    let killTimer;
    let markClosed;
    const closed = new Promise((resolve) => { markClosed = resolve; });
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); };
    const release = async () => {
      if (!child.stdin.destroyed) child.stdin.end();
      await closed;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
      reject(error);
    };
    timer = setTimeout(() => fail(new Error("The snapshot catalog did not become idle within its bounded wait.")), timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const line = output.split(/\r?\n/u).find((entry) => entry.startsWith("LOCKED\t"));
      if (!ready && line) {
        try {
          const evidence = JSON.parse(line.slice("LOCKED\t".length));
          assertSnapshotCatalogIdentity(evidence, { dataRoot });
          ready = true;
          settled = true;
          cleanup();
          resolve({ release, evidence });
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Snapshot lock identity evidence was invalid."));
        }
      }
    });
    child.once("error", () => fail(new Error("The snapshot catalog lock helper could not start.")));
    child.once("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      markClosed();
      if (!ready) fail(new Error(`The snapshot catalog lock helper failed safely (${code ?? "signal"}).`));
    });
  });
}

/** Read-only list of live Due Good identities; optional environment allowlisting never changes caller defaults. */
export async function queryRunningApplicationIdentities({ bundleId = "com.zerodelta.duegood", run = runSwift, environment = {}, inheritEnvironment = true } = {}) {
  if (typeof bundleId !== "string" || !/^[A-Za-z0-9.-]+$/u.test(bundleId)) throw new Error("The production bundle identifier is invalid.");
  return parseIdentityRows(await run(querySwift, { env: { ...environment, DUEGOOD_QUERY_BUNDLE_ID: bundleId }, inheritEnvironment, maxBytes: 16_384 }));
}

/** Generic, injectable state machine that proves two cold launches around a snapshot lock. */
export async function proveColdApplicationLaunch({
  bundleId = "com.zerodelta.duegood",
  appPath,
  query,
  launchByPath,
  launchByBundleId,
  withSnapshotLock,
  inspectProcess,
  stopProcess,
  onOwnedLaunch = () => {},
  progress = () => {},
}) {
  safeAppInputs(bundleId, appPath);
  for (const dependency of [query, launchByPath, launchByBundleId, withSnapshotLock, inspectProcess, stopProcess]) {
    if (typeof dependency !== "function") throw new Error("The cold launch proof is missing a required operation.");
  }

  assertCold(await query(bundleId));
  progress("Cold launching the exact installed app path.");
  const pathLaunch = parseLaunchedIdentity(await launchByPath(appPath));
  onOwnedLaunch(pathLaunch, "exact-path");
  assertOwnedIdentity(pathLaunch, { appPath, bundleId });
  const pathObserved = await query(bundleId);
  if (pathObserved.length !== 1 || pathObserved[0]?.pid !== pathLaunch.pid) {
    throw new Error("The exact-path launch did not create one new production app process.");
  }
  const pathIdentity = assertOwnedIdentity(await inspectProcess(pathLaunch.pid, bundleId), { appPath, expectedPid: pathLaunch.pid, bundleId });

  progress("Waiting for snapshot catalog activity to become idle before stopping the verified process.");
  await withSnapshotLock(async () => {
    const lockedIdentity = assertOwnedIdentity(await inspectProcess(pathIdentity.pid, bundleId), { appPath, expectedPid: pathIdentity.pid, bundleId });
    await stopProcess(lockedIdentity, bundleId);
    assertCold(await query(bundleId));
  });
  assertCold(await query(bundleId));

  progress("Cold resolving the production bundle identifier to the installed app.");
  const bundleLaunch = parseLaunchedIdentity(await launchByBundleId(bundleId, appPath));
  onOwnedLaunch(bundleLaunch, "bundle-id");
  assertOwnedIdentity(bundleLaunch, { appPath, bundleId });
  const observed = await query(bundleId);
  if (observed.length !== 1) throw new Error("The bundle identifier did not resolve to exactly one cold app process.");
  const bundleIdentity = assertOwnedIdentity(observed[0], { appPath, expectedPid: bundleLaunch.pid, bundleId });
  return { exactPath: pathIdentity, bundleId: bundleIdentity };
}

/** Stop a single verified candidate under the validated snapshot catalog lock. */
export async function stopVerifiedCandidate({
  bundleId = "com.zerodelta.duegood",
  appPath,
  pid,
  dataRoot,
  query = queryRunningApplicationIdentities,
  withSnapshotLock,
  inspectProcess,
  stopProcess,
}) {
  safeAppInputs(bundleId, appPath);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("The candidate PID is invalid; rollback stopped safely.");
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) throw new Error("The production data root is invalid; rollback stopped safely.");
  if (typeof withSnapshotLock !== "function" || typeof inspectProcess !== "function" || typeof stopProcess !== "function") {
    throw new Error("The verified candidate cannot be stopped safely for rollback.");
  }
  await withSnapshotLock(async () => {
    const apps = await query({ bundleId });
    if (apps.length === 0) return;
    if (apps.length !== 1 || apps[0]?.pid !== pid) throw new Error("Another Due Good process is running; rollback stopped safely.");
    const identity = assertOwnedIdentity(await inspectProcess(pid, bundleId), { appPath, expectedPid: pid, bundleId });
    await stopProcess(identity, bundleId);
    assertCold(await query({ bundleId }));
  });
}

/** Native rollback operation. It stops only the recorded PID after reacquiring snapshot quiescence. */
export async function stopColdVerifiedCandidate({ bundleId = "com.zerodelta.duegood", appPath, pid, dataRoot, spawnImpl = spawn } = {}) {
  safeAppInputs(bundleId, appPath);
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) throw new Error("The production data root is invalid.");
  const run = (code, envOrOptions = {}, timeoutMs = 35_000) => {
    const options = Object.hasOwn(envOrOptions, "env") ? envOrOptions : { env: envOrOptions };
    return runSwift(code, { ...options, timeoutMs: options.timeoutMs ?? timeoutMs, spawnImpl });
  };
  const query = () => queryRunningApplicationIdentities({ bundleId, run });
  const withSnapshotLock = async (callback) => {
    const lease = await acquireSnapshotLock({ dataRoot, spawnImpl });
    try { return await callback(); }
    finally { await lease.release(); }
  };
  const inspectProcess = async (expectedPid) => {
    const apps = await query();
    const matches = apps.filter((app) => app.pid === expectedPid);
    if (matches.length !== 1 || apps.length !== 1) throw new Error("The launched Due Good process could not be verified as the only running instance.");
    return matches[0];
  };
  const stopProcess = (identity) => run(stopExactSwift, {
    DUEGOOD_QUERY_BUNDLE_ID: bundleId,
    DUEGOOD_EXPECTED_APP_PATH: appPath,
    DUEGOOD_EXPECTED_EXECUTABLE_PATH: path.join(appPath, "Contents", "MacOS", APP_EXECUTABLE),
    DUEGOOD_QUERY_PID: String(identity.pid),
  }, 15_000);
  return stopVerifiedCandidate({ bundleId, appPath, pid, dataRoot, query, withSnapshotLock, inspectProcess, stopProcess });
}

/** Stop the currently running installed candidate only when its bundle URL, executable, and PID are exact. */
export async function stopRunningInstalledCandidate({
  bundleId = "com.zerodelta.duegood",
  appPath,
  dataRoot,
  query = queryRunningApplicationIdentities,
  stopCandidate = stopColdVerifiedCandidate,
} = {}) {
  safeAppInputs(bundleId, appPath);
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) throw new Error("The production data root is invalid.");
  const apps = await query({ bundleId });
  if (apps.length === 0) return false;
  const identity = assertSingleOwnedRunningApplication(apps, { bundleId, appPath });
  await stopCandidate({ bundleId, appPath, pid: identity.pid, dataRoot });
  return true;
}

/** Perform installer-native launches and hold the validated catalog lock while terminating. */
export async function runColdLaunchProof({
  bundleId = "com.zerodelta.duegood",
  appPath,
  dataRoot,
  progress = () => {},
  onOwnedLaunch = () => {},
  spawnImpl = spawn,
} = {}) {
  safeAppInputs(bundleId, appPath);
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) throw new Error("The production data root is invalid.");
  const run = (code, envOrOptions = {}, timeoutMs = 35_000) => {
    const options = Object.hasOwn(envOrOptions, "env") ? envOrOptions : { env: envOrOptions };
    return runSwift(code, { ...options, timeoutMs: options.timeoutMs ?? timeoutMs, spawnImpl });
  };
  const query = async () => queryRunningApplicationIdentities({ bundleId, run });
  const withSnapshotLock = async (callback) => {
    const lease = await acquireSnapshotLock({ dataRoot, spawnImpl });
    try { return await callback(); }
    finally { await lease.release(); }
  };
  const inspectProcess = async (pid) => {
    const apps = await query();
    const matches = apps.filter((app) => app.pid === pid);
    if (matches.length !== 1 || apps.length !== 1) throw new Error("The launched Due Good process could not be verified as the only running instance.");
    return matches[0];
  };
  const stopProcess = (identity) => run(stopExactSwift, {
    DUEGOOD_QUERY_BUNDLE_ID: bundleId,
    DUEGOOD_EXPECTED_APP_PATH: appPath,
    DUEGOOD_EXPECTED_EXECUTABLE_PATH: path.join(appPath, "Contents", "MacOS", APP_EXECUTABLE),
    DUEGOOD_QUERY_PID: String(identity.pid),
  }, 15_000);

  return proveColdApplicationLaunch({
    bundleId,
    appPath,
    query,
    launchByPath: (installedPath) => run(launchAtPathSwift, { DUEGOOD_LAUNCH_APP_PATH: installedPath }),
    launchByBundleId: (identifier, expectedPath) => run(launchByBundleIdSwift, {
      DUEGOOD_QUERY_BUNDLE_ID: identifier,
      DUEGOOD_EXPECTED_APP_PATH: expectedPath,
    }),
    withSnapshotLock,
    inspectProcess,
    stopProcess,
    onOwnedLaunch,
    progress,
  });
}
