#!/usr/bin/env node
/** Build and atomically install the production Canvas download helper from an isolated checkout. */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOwnedStageRoot } from "./owned-stage-root.mjs";
import { listUntrackedPaths, stageCandidate } from "./stage-tauri-candidate.mjs";
import { signalNpmProcessGroup, stopNpmProcessGroup } from "./stage-npm-process.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_OVERRIDE_MARKER = Buffer.from("duegood-feature:test-overrides");
const RELEASE_MARKER = Buffer.from("duegood-feature:release");
const PROGRESS_INTERVAL_MS = 30_000;

/** @typedef {(command: string, args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, capture?: boolean }) => Promise<{ stdout: string, stderr: string }>} ToolRunner */

function noop() {}

export function fixedCanvasDownloadHelperPath(homeDirectory = homedir()) {
  return path.join(homeDirectory, "Library", "Application Support", "DueGood", "bin", "duegood-capture-download");
}

function checkInterrupted(signal) {
  if (signal?.aborted) throw new Error("operation interrupted");
}

/** @param {(message: string) => void} progress @param {string} label */
function startHeartbeat(progress, label) {
  let elapsedSeconds = 0;
  const heartbeat = setInterval(() => {
    elapsedSeconds += PROGRESS_INTERVAL_MS / 1000;
    progress(`${label} continues (${String(elapsedSeconds)} sec)`);
  }, PROGRESS_INTERVAL_MS);
  heartbeat.unref?.();
  return heartbeat;
}

function buildEnvironment(targetDirectory) {
  const env = { ...process.env, CARGO_TARGET_DIR: targetDirectory };
  // Do not let shell-provided test cfgs or compiler flags turn a production build into a test build.
  for (const key of Object.keys(env)) {
    if (key.startsWith("CARGO_FEATURE_") || key.startsWith("DUEGOOD_TEST_")) delete env[key];
  }
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  delete env.CARGO_BUILD_TARGET;
  return env;
}

/** @param {string} command @param {string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, capture?: boolean }} [options] @returns {Promise<{ stdout: string, stderr: string }>} */
function runTool(command, args, { cwd, env = process.env, signal, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    checkInterrupted(signal);
    const collectOutput = capture || path.basename(command) === "cargo";
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: collectOutput ? ["ignore", "pipe", "pipe"] : "ignore",
      windowsHide: true,
    });
    let startError;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const retain = (current, chunk) => Buffer.concat([current, chunk]).subarray(-8192);
    if (collectOutput) {
      child.stdout.on("data", (chunk) => { stdout = retain(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = retain(stderr, chunk); });
    }
    const abort = () => signalNpmProcessGroup(child, "SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", (error) => { startError = error; });
    child.once("close", async (code, childSignal) => {
      signal?.removeEventListener("abort", abort);
      try {
        await stopNpmProcessGroup(child.pid);
      } catch {
        reject(new Error("build process did not stop"));
        return;
      }
      if (signal?.aborted) {
        reject(new Error("operation interrupted"));
      } else if (startError) {
        reject(new Error(`${path.basename(command)} could not start`));
      } else if (code !== 0 || childSignal) {
        const error = new Error(`${path.basename(command)} failed (exit ${String(code)})`);
        error.stderrTail = stderr.toString("utf8");
        reject(error);
      } else {
        resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
      }
    });
  });
}

/** @param {{ checkoutDirectory: string, targetDirectory: string, platform?: NodeJS.Platform, signal?: AbortSignal, progress?: (message: string) => void, run?: ToolRunner }} options */
async function compileReleaseHelper({ checkoutDirectory, targetDirectory, platform = process.platform, signal, progress = noop, run = runTool }) {
  const env = buildEnvironment(targetDirectory);
  const runWithHeartbeat = async (label, command, args, options = {}) => {
    progress(label);
    const heartbeat = startHeartbeat(progress, label.split(" ")[0]);
    try {
      return await run(command, args, { cwd: checkoutDirectory, env, signal, ...options });
    } finally {
      clearInterval(heartbeat);
    }
  };
  await runWithHeartbeat("installing staged JavaScript dependencies", "npm", ["ci"]);
  await runWithHeartbeat("preparing staged Tauri UI assets", process.execPath, [
    path.join(checkoutDirectory, "scripts", "build-tauri.mjs"), "--prepare-only",
  ]);
  const host = await run("rustc", ["--print", "host-tuple"], {
    cwd: checkoutDirectory,
    env,
    signal,
    capture: true,
  });
  const targetTriple = host.stdout.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(targetTriple)) throw new Error("Rust host target is invalid");
  await createTauriSidecarPlaceholders(checkoutDirectory, targetTriple, platform);

  const args = [
    "build", "--locked", "--release", "--no-default-features",
    "--manifest-path", path.join(checkoutDirectory, "src-tauri", "Cargo.toml"),
    "--bin", "duegood-capture-download",
  ];
  await runWithHeartbeat("compiling production helper", "cargo", args);
  return path.join(targetDirectory, "release", platform === "win32" ? "duegood-capture-download.exe" : "duegood-capture-download");
}

async function createTauriSidecarPlaceholders(checkoutDirectory, targetTriple, platform) {
  const directory = path.join(checkoutDirectory, "src-tauri", "binaries");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const extension = platform === "win32" ? ".exe" : "";
  const placeholder = platform === "win32" ? Buffer.from([0x4d, 0x5a]) : Buffer.from("#!/bin/sh\nexit 1\n");
  for (const executable of ["duegood-refresh", "duegood-capture-download"]) {
    const destination = path.join(directory, `${executable}-${targetTriple}${extension}`);
    try {
      await lstat(destination);
      throw new Error("unexpected sidecar build input already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await writeFile(destination, placeholder, { flag: "wx", mode: 0o700 });
    await chmod(destination, 0o700);
  }
}

async function inspectBinary(binaryPath, platform) {
  let metadata;
  try { metadata = await lstat(binaryPath); } catch { throw new Error("release helper is missing"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || (metadata.mode & 0o111) === 0) {
    throw new Error("release helper is not a non-empty executable file");
  }
  const bytes = await readFile(binaryPath);
  if (bytes.includes(TEST_OVERRIDE_MARKER)) throw new Error("release helper contains the test-overrides marker");
  if (platform === "darwin" && !bytes.includes(RELEASE_MARKER)) {
    throw new Error("release helper is missing the production build marker");
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.length,
  };
}

async function signAdHoc(binaryPath, { signal, run = runTool, checkoutDirectory }) {
  await run("/usr/bin/codesign", ["--force", "--sign", "-", binaryPath], { cwd: checkoutDirectory, signal });
  await run("/usr/bin/codesign", ["--verify", "--strict", binaryPath], { cwd: checkoutDirectory, signal });
  const report = await run("/usr/bin/codesign", ["--display", "--verbose=2", binaryPath], {
    cwd: checkoutDirectory,
    signal,
    capture: true,
  });
  if (!`${report.stdout}\n${report.stderr}`.split(/\r?\n/).includes("Signature=adhoc")) {
    throw new Error("release helper does not have an ad hoc signature");
  }
}

async function ensureDirectory(directory, { privateMode = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 });
    metadata = await lstat(directory);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("helper installation directory is unsafe");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("helper installation directory is not user-owned");
  }
  if (privateMode) await chmod(directory, 0o700);
  else if ((metadata.mode & 0o022) !== 0) throw new Error("helper installation parent is writable by other users");
}

async function prepareInstallDirectory(homeDirectory) {
  const library = path.join(homeDirectory, "Library");
  const applicationSupport = path.join(library, "Application Support");
  const dueGood = path.join(applicationSupport, "DueGood");
  const bin = path.join(dueGood, "bin");
  await ensureDirectory(homeDirectory);
  await ensureDirectory(library);
  await ensureDirectory(applicationSupport);
  await ensureDirectory(dueGood, { privateMode: true });
  await ensureDirectory(bin, { privateMode: true });
  return path.join(bin, "duegood-capture-download");
}

async function installAtomically(binaryPath, targetPath, signal, platform) {
  const existing = await lstat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("existing helper destination is not a regular file");
  }

  const temporaryPath = path.join(path.dirname(targetPath), `.duegood-capture-download.${randomUUID()}.tmp`);
  try {
    await copyFile(binaryPath, temporaryPath, constants.COPYFILE_EXCL);
    await chmod(temporaryPath, 0o700);
    checkInterrupted(signal);
    const [sourceBytes, stagedBytes] = await Promise.all([readFile(binaryPath), readFile(temporaryPath)]);
    if (!sourceBytes.equals(stagedBytes)) throw new Error("installed helper copy failed verification");
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  const installed = await inspectBinary(targetPath, platform);
  return installed;
}

/** Stages, builds, verifies, signs when applicable, and installs one production helper.
 * @param {{ sourceCheckout?: string, homeDirectory?: string, platform?: NodeJS.Platform,
 *   signal?: AbortSignal, progress?: (message: string) => void, stage?: typeof stageCandidate,
 *   untrackedPaths?: typeof listUntrackedPaths, compile?: typeof compileReleaseHelper, run?: ToolRunner }} [options]
 * @returns {Promise<{ path: string, sha256: string, byteCount: number }>} */
export async function prepareCanvasHelper({
  sourceCheckout = scriptRoot,
  homeDirectory = homedir(),
  platform = process.platform,
  signal,
  progress = noop,
  stage = stageCandidate,
  untrackedPaths = listUntrackedPaths,
  compile = compileReleaseHelper,
  run = runTool,
} = {}) {
  let ownedStage;
  let phase = "initializing";
  /** @type {{ path: string, sha256: string, byteCount: number } | undefined} */
  let result;
  let failure;
  try {
    phase = "staging";
    progress("creating owned helper build stage");
    ownedStage = await acquireOwnedStageRoot({
      source: sourceCheckout,
      destination: path.join(sourceCheckout, ".stage", "helper"),
    });
    checkInterrupted(signal);

    progress("staging isolated checkout");
    let checkoutDirectory = ownedStage.stageRoot;
    const stageHeartbeat = startHeartbeat(progress, "staging");
    try {
      const excludedStagePaths = [".stage", path.join(".cache", "cargo-target")];
      const include = (await untrackedPaths(sourceCheckout)).filter((candidate) =>
        !excludedStagePaths.some((excluded) => candidate === excluded || candidate.startsWith(`${excluded}${path.sep}`)));
      const staged = await stage({
        source: sourceCheckout,
        destination: checkoutDirectory,
        include,
        stageOwnership: ownedStage.ownership,
        log: noop,
        checkInterrupted: () => checkInterrupted(signal),
      });
      // macOS reports TMPDIR through /var, but imported modules resolve under /private/var.
      // Pass the canonical stage path to scripts with an argv/fileURL entrypoint guard.
      checkoutDirectory = staged.destination;
    } finally {
      clearInterval(stageHeartbeat);
    }
    checkInterrupted(signal);

    phase = "compiling";
    progress("compiling production helper");
    const binaryPath = await compile({ checkoutDirectory, targetDirectory: ownedStage.cargoTargetDir, platform, signal, progress, run });
    checkInterrupted(signal);

    phase = "verifying";
    progress("verifying release binary and build marker");
    await inspectBinary(binaryPath, platform);
    checkInterrupted(signal);

    if (platform === "darwin") {
      phase = "signing";
      progress("applying ad hoc signature");
      await signAdHoc(binaryPath, { signal, run, checkoutDirectory });
      await inspectBinary(binaryPath, platform);
    }
    checkInterrupted(signal);

    phase = "installing";
    progress("installing helper atomically");
    const destination = await prepareInstallDirectory(homeDirectory);
    checkInterrupted(signal);
    const installed = await installAtomically(binaryPath, destination, signal, platform);
    progress("helper installed and ready");
    result = { path: destination, ...installed };
  } catch (error) {
    failure = new Error(`helper preparation failed during ${phase}`);
    failure.cause = error;
    failure.phase = phase;
  } finally {
    if (ownedStage) {
      try {
        await ownedStage.close({ success: Boolean(result) });
      } catch (error) {
        failure ??= new Error("helper preparation failed during cleanup");
        failure.phase ??= "cleanup";
        failure.cause ??= error;
      }
    }
  }
  if (failure) throw failure;
  if (!result) throw new Error("helper preparation failed without an installation result");
  return result;
}

async function runCli() {
  const controller = new AbortController();
  const onInterrupt = (signal) => () => controller.abort(new Error(signal));
  const onSigint = onInterrupt("SIGINT");
  const onSigterm = onInterrupt("SIGTERM");
  const progress = (message) => process.stderr.write(`canvas:prepare-helper: ${message}\n`);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await prepareCanvasHelper({ signal: controller.signal, progress });
  } catch (error) {
    progress(`failed during ${error?.phase ?? "initializing"}`);
    process.exitCode = controller.signal.reason?.message === "SIGINT" ? 130
      : controller.signal.reason?.message === "SIGTERM" ? 143 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await runCli();
