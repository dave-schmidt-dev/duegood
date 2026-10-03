#!/usr/bin/env node
/** Install and resolve a verified Developer ID build of Due Good. */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consumeOwnedStageHandoff, validateOwnedStageHandoff } from "./owned-stage-root.mjs";
import { runColdLaunchProof, stopColdVerifiedCandidate, stopRunningInstalledCandidate } from "./install-desktop-launch.mjs";

const BUNDLE_ID = "com.zerodelta.duegood";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const APP_NAME = "Due Good.app";
const STAGE_DIRECTORY_NAME = ".stage";
const HELPER_EXECUTABLES = Object.freeze(["duegood-refresh", "duegood-capture-download"]);
const IDENTITY_RE = /^Developer ID Application: .+$/u;
const RETAINED_BACKUP_NAME_RE = /^\.Due Good\.backup-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.app$/u;

const fsOps = Object.freeze({ cp, lstat, readFile, readdir, realpath, rename, rm, writeFile });

class RestoredAppRegistrationError extends Error {
  constructor(appPath, cause) {
    super(`The previous app was restored at ${appPath}, but LaunchServices registration failed.`, { cause });
    this.name = "RestoredAppRegistrationError";
  }
}

function restorationFailureDetail(error, installApp, backupPath) {
  if (error instanceof RestoredAppRegistrationError) {
    return `the previous app was restored at ${installApp}, but its LaunchServices registration could not be confirmed`;
  }
  return `the previous app remains in its backup at ${backupPath}`;
}

/** Run one fixed executable without a shell, while retaining output only for parsing. */
function runCommand(command, args, { cwd, timeoutMs = 60_000, allowExitCodes = [], maxOutputBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let overflow = false;
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => { collect(stdoutChunks, chunk); });
    child.stderr.on("data", (chunk) => { collect(stderrChunks, chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("A required local verification command could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error("A local verification command returned too much output."));
      if (code !== 0 && !allowExitCodes.includes(code)) return reject(new Error("A required local verification command failed."));
      resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), code });
    });
  });
}

function commandOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function requireIdentity(identity, securityOutput) {
  if (typeof identity !== "string" || identity.trim() === "" || /[\r\n]/u.test(identity)) {
    throw new Error("APPLE_SIGNING_IDENTITY must name the Developer ID identity used to sign this build.");
  }
  const identities = [...securityOutput.matchAll(/\b([A-F0-9]{40})\s+"([^"]+)"/giu)].map((match) => ({
    hash: match[1].toUpperCase(),
    name: match[2],
  }));
  const resolved = identities.find((item) => item.hash === identity.toUpperCase() || item.name === identity);
  if (!resolved || !IDENTITY_RE.test(resolved.name)) {
    throw new Error("APPLE_SIGNING_IDENTITY does not resolve to a valid Developer ID Application identity.");
  }
  return resolved.name;
}

function assertDeveloperId(signatureOutput, expectedName) {
  const authority = [...signatureOutput.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1].trim());
  if (!authority.some((entry) => entry === expectedName) || !authority.some((entry) => entry.startsWith("Developer ID Certification Authority"))) {
    throw new Error("The app bundle is not signed by the configured Developer ID authority.");
  }
}

function parseLaunchServicesDump(dump, bundleId) {
  const matches = [];
  let active = false;
  let registeredPath;
  const flush = () => {
    if (active && registeredPath) matches.push(registeredPath);
    registeredPath = undefined;
  };
  for (const line of dump.split(/\r?\n/u)) {
    const id = /^\s*bundle id:\s*(\S+)\s*$/iu.exec(line);
    if (id) {
      flush();
      active = id[1] === bundleId;
      continue;
    }
    if (active) {
      const location = /^\s*path:\s*(.+?)\s*$/iu.exec(line);
      if (location) registeredPath = location[1].replace(/^"|"$/gu, "");
    }
  }
  flush();
  return [...new Set(matches)];
}

async function exists(fs, target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("Could not safely inspect a local application path.", { cause: error });
  }
}

async function inspectBundleId(fs, run, appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!(await exists(fs, plist))) return undefined;
  try {
    const result = await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist]);
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * An installer-owned retained backup is exactly a real directory named `.Due Good.backup-<uuid>.app`
 * whose canonical parent is the canonical Applications directory, whose bundle identifier is Due
 * Good, and whose signature carries the configured Developer ID authority. A symlink, a competing
 * bundle, or anything that cannot be proven to be installer-owned is never treated as removable.
 */
async function isOwnedRetainedBackup({ files, run, applicationsDirectory, appPath, signingName }) {
  const canonicalApplications = await files.realpath(applicationsDirectory).catch(() => undefined);
  const resolved = path.resolve(appPath);
  if (!canonicalApplications) return false;
  try {
    const stat = await files.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const canonical = await files.realpath(resolved).catch(() => undefined);
  if (!canonical) return false;
  if (path.dirname(canonical) !== canonicalApplications) return false;
  if (!RETAINED_BACKUP_NAME_RE.test(path.basename(canonical))) return false;
  try {
    if (await inspectBundleId(files, run, canonical) !== BUNDLE_ID) return false;
    await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", canonical]);
    assertDeveloperId(commandOutput(await run("/usr/bin/codesign", ["--display", "--verbose=4", canonical])), signingName);
    return true;
  } catch {
    return false;
  }
}

function safeTreeDigest(value) {
  if (!/^[a-f0-9]{40}$/iu.test(value)) throw new Error("The staged candidate does not have a valid Git tree digest.");
  return value.toLowerCase();
}

async function assertRegularFile(fs, filename) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
  } catch {
    throw new Error("The signed app bundle is missing a required regular file.");
  }
}

async function ensureProductionAppStopped(run, phase) {
  const result = await run("/usr/bin/pgrep", ["-x", "duegood-desktop"], { allowExitCodes: [0, 1] });
  if (result.code === 0) throw new Error(`The production Due Good app is running; close it before ${phase}.`);
  if (result.code !== 1) throw new Error("The production Due Good app running state could not be verified.");
}

async function uniqueSiblingPath(files, applicationsDirectory, suffix, appBundle = false) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bundleExtension = appBundle ? ".app" : "";
    const candidate = path.join(applicationsDirectory, `.Due Good.${suffix}-${randomUUID()}${bundleExtension}`);
    if (!(await exists(files, candidate))) return candidate;
  }
  throw new Error("A unique sibling path could not be reserved safely.");
}

async function verifyCopiedBundle({ files, run, appPath, signingName, helperDigests }) {
  await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", appPath]);
  assertDeveloperId(commandOutput(await run("/usr/bin/codesign", ["--display", "--verbose=4", appPath])), signingName);
  const copiedDigests = {};
  for (const name of HELPER_EXECUTABLES) {
    const helper = path.join(appPath, "Contents", "MacOS", name);
    await assertRegularFile(files, helper);
    await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", helper]);
    assertDeveloperId(commandOutput(await run("/usr/bin/codesign", ["--display", "--verbose=4", helper])), signingName);
    const copiedDigest = createHash("sha256").update(await files.readFile(helper)).digest("hex");
    if (copiedDigest !== helperDigests[name]) throw new Error(`The copied ${name} digest does not match the verified build.`);
    copiedDigests[name] = copiedDigest;
  }

  const executable = path.join(appPath, "Contents", "MacOS", "duegood-desktop");
  await assertRegularFile(files, executable);
  await run(executable, ["--verify-embedded-assets"], { cwd: appPath, timeoutMs: 30_000 });
  return copiedDigests;
}

async function restoreBackup({ files, run, installApp, backupPath, signingName, candidateIdentity, productionDataRoot, stopCandidate = stopColdVerifiedCandidate }) {
  if (!(await exists(files, backupPath))) throw new Error("The retained previous app backup is unavailable.");
  if (!(await isOwnedRetainedBackup({ files, run, applicationsDirectory: path.dirname(installApp), appPath: backupPath, signingName }))) {
    throw new Error("The retained previous app no longer passes its ownership and signature checks.");
  }
  if (candidateIdentity?.pid) {
    await stopCandidate({ appPath: installApp, pid: candidateIdentity.pid, dataRoot: productionDataRoot });
  } else {
    await ensureProductionAppStopped(run, "restoring the previous app");
  }
  await run(LSREGISTER, ["-u", installApp]);
  await files.rm(installApp, { recursive: true, force: true });
  await files.rename(backupPath, installApp);
  try {
    await run(LSREGISTER, ["-f", installApp]);
  } catch (error) {
    throw new RestoredAppRegistrationError(installApp, error);
  }
}

async function canonicalFuturePath(fs, target) {
  let current = path.resolve(target);
  const tail = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...tail);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error("The production data root could not be canonicalized.", { cause: error });
      const parent = path.dirname(current);
      if (parent === current) throw new Error("The production data root could not be canonicalized.", { cause: error });
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Recognize only an exact stage handoff claim. The owned-stage helper remains the authority for
 * validating its lock owner and removing both the stage directory and purpose lock.
 */
function isOwnedStageHandoff({ ownership, candidateRootReal, sourceRootReal }) {
  return typeof ownership === "object" && ownership !== null && !Array.isArray(ownership)
    && ownership.schemaVersion === 1
    && ownership.owner === "duegood-stage"
    && ownership.projectRoot === sourceRootReal
    && ownership.stageRoot === candidateRootReal
    && ownership.handoff === true
    && typeof ownership.keep === "boolean"
    && path.dirname(candidateRootReal) === path.join(sourceRootReal, STAGE_DIRECTORY_NAME);
}

/** Unregister only verified installer-owned backups while retaining their bytes for both proofs. */
async function unregisterInstallerOwnedBackups({ files, run, applicationsDirectory, signingName, log }) {
  let entries;
  try {
    entries = await files.readdir(applicationsDirectory, { withFileTypes: true });
  } catch {
    throw new Error("The Applications directory could not be inspected for installer-owned backups.");
  }
  const owned = [];
  for (const entry of entries) {
    if (!RETAINED_BACKUP_NAME_RE.test(entry.name)) continue;
    const backupPath = path.join(applicationsDirectory, entry.name);
    if (!(await isOwnedRetainedBackup({ files, run, applicationsDirectory, appPath: backupPath, signingName }))) {
      log(`install: leaving an unverified backup-like entry untouched: ${entry.name}`);
      continue;
    }
    log(`install: unregistering installer-owned backup while retaining its bytes: ${entry.name}`);
    await run(LSREGISTER, ["-u", backupPath]);
    owned.push(backupPath);
  }
  return owned;
}

async function removeVerifiedInstallerBackups({ files, run, applicationsDirectory, signingName, backupPaths, log }) {
  const removed = [];
  for (const backupPath of backupPaths) {
    if (!(await isOwnedRetainedBackup({ files, run, applicationsDirectory, appPath: backupPath, signingName }))) {
      throw new Error("An installer-owned backup changed before post-proof cleanup; its bytes were preserved.");
    }
    log(`install: removing previously unregistered backup after both cold proofs: ${path.basename(backupPath)}`);
    await files.rm(backupPath, { recursive: true, force: false });
    removed.push(backupPath);
  }
  return removed;
}

/**
 * Verify and install a staged app. `files`, `run`, and `log` can be injected for hermetic tests;
 * callers must keep every writable destination outside the source candidate. The default app path
 * is stage-local (`<candidateRoot>/build/Due Good.app`) and an explicit `appPath` still wins.
 * A stage receipt that grants an owned handoff is consumed: its stage is removed after this run
 * whether the install succeeds or fails, once every subprocess and copy has finished. Receipts
 * that request retention or do not prove ownership leave the stage in place.
 */
export async function installDesktopApp({
  appPath,
  candidateRoot = process.cwd(),
  sourceCheckout = process.env.DUEGOOD_SOURCE_CHECKOUT,
  applicationsDirectory = "/Applications",
  homeDirectory = homedir(),
  signingIdentity = process.env.APPLE_SIGNING_IDENTITY,
  rootMarkerPath = process.env.DUEGOOD_PHASE4_ROOT_MARKER,
  platform = process.platform,
  files = fsOps,
  run = runCommand,
  launchProof = runColdLaunchProof,
  stopCandidate = stopColdVerifiedCandidate,
  stopExistingApp = stopRunningInstalledCandidate,
  log = console.log,
} = {}) {
  if (platform !== "darwin") throw new Error("The desktop installer can run only on macOS.");
  const candidateRootPath = path.resolve(candidateRoot);
  let candidateApp = appPath === undefined ? path.join(candidateRootPath, "build", APP_NAME) : path.resolve(appPath);
  const installApp = path.join(applicationsDirectory, APP_NAME);
  if (candidateApp === installApp) throw new Error("The release candidate must come from the staged build directory.");
  if (typeof sourceCheckout !== "string" || sourceCheckout.trim() === "" || !path.isAbsolute(sourceCheckout)) {
    throw new Error("DUEGOOD_SOURCE_CHECKOUT must point to the original source checkout.");
  }
  if (typeof rootMarkerPath !== "string" || rootMarkerPath.trim() === "" || !path.isAbsolute(rootMarkerPath)) {
    throw new Error("DUEGOOD_PHASE4_ROOT_MARKER must name a private marker path under the stage.");
  }
  const sourceCheckoutPath = path.resolve(sourceCheckout);
  let markerPath = path.resolve(rootMarkerPath);
  const buildMetadataPath = path.join(candidateApp, "Contents", "Resources", "duegood-build.json");

  log("install: verifying staged app identity and signature");
  try {
    const appStat = await files.lstat(candidateApp);
    if (!appStat.isDirectory() || appStat.isSymbolicLink()) throw new Error();
  } catch {
    throw new Error("The staged Due Good app bundle is unavailable or unsafe.");
  }
  const realCandidate = await files.realpath(candidateApp).catch(() => { throw new Error("The staged app bundle path could not be resolved safely."); });
  candidateApp = realCandidate;
  if (await inspectBundleId(files, run, candidateApp) !== BUNDLE_ID) {
    throw new Error("The staged app bundle has an unexpected identifier.");
  }

  const candidateRealPath = await files.realpath(candidateRootPath).catch(() => { throw new Error("The staged candidate root could not be resolved safely."); });
  const candidateRelativePath = path.relative(candidateRealPath, candidateApp);
  if (candidateRelativePath === ".." || candidateRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(candidateRelativePath)) {
    throw new Error("The staged app bundle must be inside the staged candidate.");
  }
  const markerParentRealPath = await files.realpath(path.dirname(markerPath)).catch(() => { throw new Error("The production root marker parent must be a real staged directory."); });
  markerPath = path.join(markerParentRealPath, path.basename(markerPath));
  const sourceRealPath = await files.realpath(sourceCheckoutPath).catch(() => { throw new Error("The original source checkout could not be resolved safely."); });
  if (candidateRealPath === sourceRealPath) throw new Error("The original source checkout must be distinct from the staged candidate.");
  const markerRelativePath = path.relative(candidateRealPath, markerPath);
  if (markerRelativePath === "" || markerRelativePath === ".." || markerRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(markerRelativePath)) {
    throw new Error("The production root marker must be stored inside the staged candidate.");
  }
  const markerParentRelativePath = path.relative(candidateRealPath, markerParentRealPath);
  if (markerParentRelativePath === ".." || markerParentRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(markerParentRelativePath)) {
    throw new Error("The production root marker parent must be inside the staged candidate.");
  }
  let receipt;
  try {
    receipt = JSON.parse(await files.readFile(path.join(candidateRootPath, "receipt.json"), "utf8"));
  } catch {
    throw new Error("The staged candidate receipt is unavailable or invalid.");
  }
  if (receipt?.schemaVersion !== 1 || receipt?.stagedMatchesCandidate !== true) {
    throw new Error("The staged candidate receipt is incomplete.");
  }
  const hasOwnedStageHandoffClaim = isOwnedStageHandoff({
    ownership: receipt.stageOwnership,
    candidateRootReal: candidateRealPath,
    sourceRootReal: sourceRealPath,
  });
  let stageOwnership;
  if (hasOwnedStageHandoffClaim) {
    await validateOwnedStageHandoff({
      candidateRoot: candidateRealPath,
      projectRoot: sourceRealPath,
      ownership: receipt.stageOwnership,
    });
    stageOwnership = receipt.stageOwnership;
  }
  if (stageOwnership) {
    log("install: the stage receipt grants an owned handoff; its stage is removed after this run");
  } else if (receipt?.stageOwnership?.keep === true || receipt?.keep === true) {
    log("install: the stage receipt requests retention; its stage is left in place");
  }

  let installFailure;
  let installFailed = false;
  let installResult;
  let stageCleanupFailure;
  try {
    const tree = safeTreeDigest(receipt.treeDigest);
    const committedTree = safeTreeDigest((await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: candidateRootPath })).stdout.trim());
    if (committedTree !== tree) throw new Error("The staged candidate tree does not match its receipt.");
    const sourceRevision = (await run("git", ["describe", "--always", "--dirty"], { cwd: sourceCheckoutPath })).stdout.trim();
    if (!sourceRevision || [...sourceRevision].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new Error("The source checkout revision could not be recorded safely.");
    }
    let buildMetadata;
    try {
      buildMetadata = JSON.parse(await files.readFile(buildMetadataPath, "utf8"));
    } catch {
      throw new Error("The signed build metadata is missing or invalid.");
    }
    if (buildMetadata?.schemaVersion !== 1 || buildMetadata?.sourceRevision !== sourceRevision || buildMetadata?.candidateTree !== tree) {
      throw new Error("The signed build metadata does not match the original checkout and staged candidate.");
    }
    const signingName = requireIdentity(signingIdentity, (await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"])).stdout);
    const verifyApp = ["--verify", "--strict", "--verbose=2", candidateApp];
    await run("/usr/bin/codesign", verifyApp);
    assertDeveloperId(commandOutput(await run("/usr/bin/codesign", ["--display", "--verbose=4", candidateApp])), signingName);

    const helperDigests = {};
    for (const name of HELPER_EXECUTABLES) {
      const helper = path.join(candidateApp, "Contents", "MacOS", name);
      await assertRegularFile(files, helper);
      await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", helper]);
      assertDeveloperId(commandOutput(await run("/usr/bin/codesign", ["--display", "--verbose=4", helper])), signingName);
      helperDigests[name] = createHash("sha256").update(await files.readFile(helper)).digest("hex");
    }
    const candidateExecutable = path.join(candidateApp, "Contents", "MacOS", "duegood-desktop");
    await assertRegularFile(files, candidateExecutable);
    log("install: verifying candidate embedded assets");
    await run(candidateExecutable, ["--verify-embedded-assets"], { cwd: candidateApp, timeoutMs: 30_000 });

    log("install: checking LaunchServices registrations");
    const registrations = parseLaunchServicesDump((await run(LSREGISTER, ["-dump"], { maxOutputBytes: 64 * 1024 * 1024 })).stdout, BUNDLE_ID);
    const stale = [];
    const competitors = new Set();
    for (const registeredPath of registrations) {
      const resolved = path.resolve(registeredPath);
      if (resolved === installApp || resolved === candidateApp) continue;
      if (await isOwnedRetainedBackup({ files, run, applicationsDirectory, appPath: registeredPath, signingName })) {
        stale.push(registeredPath);
        continue;
      }
      if (await exists(files, registeredPath)) competitors.add(registeredPath);
      else stale.push(registeredPath);
    }
    for (const stalePath of stale) {
      log("install: removing one stale LaunchServices registration");
      await run(LSREGISTER, ["-u", stalePath]);
    }

    const appEntries = await files.readdir(applicationsDirectory, { withFileTypes: true }).catch(() => {
      throw new Error("The Applications directory could not be inspected.");
    });
    for (const entry of appEntries) {
      if (!entry.name.endsWith(".app")) continue;
      const app = path.join(applicationsDirectory, entry.name);
      if (path.resolve(app) === installApp || path.resolve(app) === candidateApp) continue;
      if (await isOwnedRetainedBackup({ files, run, applicationsDirectory, appPath: app, signingName })) continue;
      if (await inspectBundleId(files, run, app) === BUNDLE_ID) competitors.add(app);
    }
    if (competitors.size > 0) {
      throw new Error("A different installed app claims the Due Good bundle identifier; no app was replaced.");
    }

    let upgrade = false;
    let originalTargetStat;
    if (await exists(files, installApp)) {
      const targetStat = await files.lstat(installApp).catch(() => null);
      if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) throw new Error("The install destination is not a safe app directory.");
      if (await inspectBundleId(files, run, installApp) !== BUNDLE_ID) throw new Error("The install destination belongs to a different app.");
      await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", installApp]);
      assertDeveloperId(commandOutput(await run("/usr/bin/codesign", ["--display", "--verbose=4", installApp])), signingName);
      upgrade = true;
      originalTargetStat = targetStat;
    }
    const applicationsStat = await files.lstat(applicationsDirectory).catch(() => null);
    if (!applicationsStat?.isDirectory() || applicationsStat.isSymbolicLink()) {
      throw new Error("The Applications directory must exist as a real directory before installation.");
    }

    const productionDataRoot = await canonicalFuturePath(files, path.join(homeDirectory, "Library", "Application Support", BUNDLE_ID));
    let dataRootExistedBeforeInstall = await exists(files, productionDataRoot);
    let markerStat;
    try {
      markerStat = await files.lstat(markerPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error("The production root marker could not be safely inspected.", { cause: error });
    }
    if (markerStat) {
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o077) !== 0) {
        throw new Error("The existing production root marker is not a private regular file.");
      }
      let previousMarker;
      try {
        previousMarker = JSON.parse(await files.readFile(markerPath, "utf8"));
      } catch {
        throw new Error("The existing production root marker is invalid.");
      }
      if (previousMarker?.schemaVersion !== 1 || previousMarker?.root !== productionDataRoot || typeof previousMarker?.existedBeforePhase !== "boolean") {
        throw new Error("The existing production root marker belongs to a different phase.");
      }
      dataRootExistedBeforeInstall = previousMarker.existedBeforePhase;
    } else {
      const marker = { schemaVersion: 1, root: productionDataRoot, existedBeforePhase: dataRootExistedBeforeInstall };
      try {
        await files.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        const createdMarkerStat = await files.lstat(markerPath);
        if ((createdMarkerStat.mode & 0o077) !== 0) throw new Error();
      } catch {
        throw new Error("The private production root marker could not be written.");
      }
    }

    const stagedCopy = await uniqueSiblingPath(files, applicationsDirectory, "staging");
    let backupPath;
    log("install: copying the verified app into a same-volume staging directory");
    if (upgrade) {
      await stopExistingApp({ bundleId: BUNDLE_ID, appPath: installApp, dataRoot: productionDataRoot });
      await ensureProductionAppStopped(run, "copying an upgrade");
    }
    try {
      await files.cp(candidateApp, stagedCopy, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    } catch (error) {
      await files.rm(stagedCopy, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("The verified app could not be copied into a staging directory.", { cause: error });
    }

    try {
      if (await inspectBundleId(files, run, stagedCopy) !== BUNDLE_ID) throw new Error("The copied app bundle has an unexpected identifier.");
      log("install: verifying the staged copy signature, helper digest, and embedded assets");
      await verifyCopiedBundle({ files, run, appPath: stagedCopy, signingName, helperDigests });
    } catch (error) {
      await files.rm(stagedCopy, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("The copied app failed its verification before installation.", { cause: error });
    }

    if (upgrade) {
      const currentTargetStat = await files.lstat(installApp).catch(() => null);
      if (!currentTargetStat?.isDirectory() || currentTargetStat.isSymbolicLink()
        || currentTargetStat.dev !== originalTargetStat.dev || currentTargetStat.ino !== originalTargetStat.ino
        || await inspectBundleId(files, run, installApp) !== BUNDLE_ID) {
        await files.rm(stagedCopy, { recursive: true, force: true }).catch(() => undefined);
        throw new Error("The existing app changed during upgrade preparation; it was left untouched.");
      }
      backupPath = await uniqueSiblingPath(files, applicationsDirectory, "backup", true);
      log("install: retaining the previous app bundle and swapping the verified copy");
      await ensureProductionAppStopped(run, "swapping the upgrade");
      try {
        await files.rename(installApp, backupPath);
        await files.rename(stagedCopy, installApp);
      } catch (error) {
        let restored = await exists(files, installApp);
        if (!restored && await exists(files, backupPath)) {
          try {
            await files.rename(backupPath, installApp);
            restored = true;
          } catch (restoreError) {
            await files.rm(stagedCopy, { recursive: true, force: true }).catch(() => undefined);
            throw new Error(`The app swap failed and the prior app remains in its backup at ${backupPath}; automatic restoration failed.`, { cause: restoreError });
          }
        }
        await files.rm(stagedCopy, { recursive: true, force: true }).catch(() => undefined);
        if (!restored) throw new Error("The app swap failed and the previous app could not be located safely.", { cause: error });
        throw new Error("The app upgrade swap failed; the previous app was restored.", { cause: error });
      }
    } else {
      try {
        await files.rename(stagedCopy, installApp);
      } catch (error) {
        await files.rm(stagedCopy, { recursive: true, force: true }).catch(() => undefined);
        throw new Error("The verified app could not be atomically moved into Applications.", { cause: error });
      }
    }

    let installedHelperDigests;
    try {
      log("install: verifying the installed app signature, helper digest, and embedded assets");
      installedHelperDigests = await verifyCopiedBundle({ files, run, appPath: installApp, signingName, helperDigests });
    } catch (error) {
      if (upgrade && backupPath && await exists(files, backupPath)) {
        log("install: restoring the retained app after installed-copy verification failed");
        try {
          await restoreBackup({ files, run, installApp, backupPath, signingName });
        } catch (restoreError) {
          throw new Error(`Installed-copy verification failed; ${restorationFailureDetail(restoreError, installApp, backupPath)}.`, { cause: restoreError });
        }
      } else if (!upgrade) {
        log("install: removing the new unregistered app after verification failed");
        await files.rm(installApp, { recursive: true, force: true });
      }
      throw new Error("The installed app failed verification; the previous app was restored when applicable.", { cause: error });
    }

    log("install: registering the installed bundle");
    try {
      await run(LSREGISTER, ["-f", installApp]);
    } catch (error) {
      if (upgrade && backupPath) {
        try {
          await restoreBackup({ files, run, installApp, backupPath, signingName });
        } catch (restoreError) {
          if (restoreError instanceof RestoredAppRegistrationError) {
            throw new Error(`LaunchServices registration failed; the previous app was restored at ${installApp}, but its registration could not be confirmed.`, { cause: restoreError });
          }
          throw new Error(`LaunchServices registration failed; restoration did not complete, and the previous app remains in its backup at ${backupPath}.`, { cause: restoreError });
        }
        throw new Error("LaunchServices registration failed; the previous app was restored.", { cause: error });
      }
      throw error;
    }

    const ownedBackupPaths = await unregisterInstallerOwnedBackups({ files, run, applicationsDirectory, signingName, log });
    let candidateIdentity;
    let coldProof;
    try {
      log("install: proving two cold launches against the installed path and bundle identifier");
      coldProof = await launchProof({
        bundleId: BUNDLE_ID,
        appPath: installApp,
        dataRoot: productionDataRoot,
        progress: (message) => log(`install: ${message}`),
        onOwnedLaunch: (identity, method) => {
          candidateIdentity = identity;
          log(`install: observed the owned candidate process from ${method} launch`);
        },
      });
    } catch (error) {
      if (upgrade && backupPath) {
        try {
          await restoreBackup({
            files, run, installApp, backupPath, signingName,
            candidateIdentity, productionDataRoot, stopCandidate,
          });
        } catch (restoreError) {
          throw new Error(`The cold launch proof failed; ${restorationFailureDetail(restoreError, installApp, backupPath)}.`, { cause: restoreError });
        }
        throw new Error("The installed app cold launch proof failed; the previous app was restored.", { cause: error });
      }
      throw error;
    }

    if (backupPath && !ownedBackupPaths.includes(backupPath)) ownedBackupPaths.push(backupPath);
    const removedBackupPaths = await removeVerifiedInstallerBackups({
      files, run, applicationsDirectory, signingName, backupPaths: ownedBackupPaths, log,
    });
    const dataRootExistsAfterOpen = await exists(files, productionDataRoot);
    log(`Production data root before install: ${dataRootExistedBeforeInstall ? "present" : "absent"}`);
    log(`Production data root after open: ${dataRootExistsAfterOpen ? "present" : "absent"}`);
    log(`Installed helper SHA-256: ${installedHelperDigests["duegood-refresh"]}`);
    log(`Installed capture download helper SHA-256: ${installedHelperDigests["duegood-capture-download"]}`);
    log(`Installed candidate: ${sourceRevision} (${tree})`);
    installResult = {
      appPath: installApp,
      buildMetadataPath: path.join(installApp, "Contents", "Resources", "duegood-build.json"),
      rootMarkerPath: markerPath,
      productionDataRootExistedBeforeInstall: dataRootExistedBeforeInstall,
      productionDataRootExistsAfterOpen: dataRootExistsAfterOpen,
      sourceRevision,
      candidateTree: tree,
      helperDigest: installedHelperDigests["duegood-refresh"],
      helperDigests: installedHelperDigests,
      coldProof,
      backupPath: backupPath && await exists(files, backupPath) ? backupPath : undefined,
      removedBackupPaths,
    };
  } catch (error) {
    installFailure = error;
    installFailed = true;
  } finally {
    if (stageOwnership) {
      try {
        await consumeOwnedStageHandoff({
          candidateRoot: candidateRealPath,
          projectRoot: sourceRealPath,
          ownership: stageOwnership,
        });
        log(stageOwnership.keep
          ? "install: retained the owned stage handoff as requested"
          : "install: removed the consumed stage and purpose lock after all subprocesses and copies finished");
      } catch (cleanupError) {
        stageCleanupFailure = cleanupError;
      }
    }
  }

  if (installFailed && stageCleanupFailure) {
    const installMessage = installFailure instanceof Error ? installFailure.message : String(installFailure);
    const cleanupMessage = stageCleanupFailure instanceof Error ? stageCleanupFailure.message : String(stageCleanupFailure);
    throw new AggregateError(
      [installFailure, stageCleanupFailure],
      `Desktop app installation failed: ${installMessage}; owned stage handoff cleanup also failed: ${cleanupMessage}`,
      { cause: installFailure },
    );
  }
  if (installFailed) throw installFailure;
  if (stageCleanupFailure) {
    const cleanupMessage = stageCleanupFailure instanceof Error ? stageCleanupFailure.message : String(stageCleanupFailure);
    throw new Error(`Desktop app installation completed, but owned stage handoff cleanup failed: ${cleanupMessage}`, {
      cause: stageCleanupFailure,
    });
  }
  return installResult;
}

async function main() {
  await installDesktopApp();
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Install failed: ${error instanceof Error ? error.message : "unexpected local error"}`);
    process.exitCode = 1;
  });
}
