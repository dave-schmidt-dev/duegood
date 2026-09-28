import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
const TERMINATE_GRACE_MS = 1000;
const MAX_INPUT_BYTES = 1024;
const MAX_LINE_BYTES = 4096;
const MAX_OUTPUT_BYTES = 128 * 1024;

const PROGRESS_CODES = Object.freeze({
  validating: "CANVAS_IMPORT_VALIDATING",
  copying: "CANVAS_IMPORT_COPYING",
  reconciling: "CANVAS_IMPORT_RECONCILING",
  publishing: "CANVAS_IMPORT_PUBLISHING",
  complete: "CANVAS_IMPORT_COMPLETE",
});

function importError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function noop() {}

/** Fixed installed native importer path; checkout binaries are never executed. */
export function fixedCanvasNativeImportHelperPath(homeDirectory = homedir()) {
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "DueGood",
    "bin",
    "duegood-browser-import",
  );
}

/** Verifies the one installed production helper without exposing paths in failures. */
export async function validateCanvasNativeImportHelper({
  homeDirectory = homedir(),
  helperPath = fixedCanvasNativeImportHelperPath(homeDirectory),
} = {}) {
  const expected = fixedCanvasNativeImportHelperPath(homeDirectory);
  if (!path.isAbsolute(homeDirectory) || helperPath !== expected || !path.isAbsolute(helperPath)) {
    throw importError("NATIVE_IMPORT_HELPER_UNAVAILABLE");
  }

  const directories = [
    homeDirectory,
    path.join(homeDirectory, "Library"),
    path.join(homeDirectory, "Library", "Application Support"),
    path.join(homeDirectory, "Library", "Application Support", "DueGood"),
    path.dirname(helperPath),
  ];
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (const directory of directories) {
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch {
      throw importError("NATIVE_IMPORT_HELPER_UNAVAILABLE");
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o022) !== 0) {
      throw importError("NATIVE_IMPORT_HELPER_UNAVAILABLE");
    }
    if (uid !== undefined && metadata.uid !== uid) {
      throw importError("NATIVE_IMPORT_HELPER_UNAVAILABLE");
    }
  }

  let helper;
  try {
    helper = await lstat(helperPath);
  } catch {
    throw importError("NATIVE_IMPORT_HELPER_UNAVAILABLE");
  }
  if (!helper.isFile() || helper.isSymbolicLink() || helper.size === 0
      || (helper.mode & 0o111) === 0 || (helper.mode & 0o022) !== 0
      || uid !== undefined && helper.uid !== uid) {
    throw importError("NATIVE_IMPORT_HELPER_UNAVAILABLE");
  }
  return helperPath;
}

function validCount(value, allowZero = true) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

function exactKeys(record, keys) {
  return record !== null && typeof record === "object" && !Array.isArray(record)
    && Object.keys(record).length === keys.length
    && keys.every((key) => Object.hasOwn(record, key));
}

function validateProgress(frame) {
  const keys = ["type", "phase", "filesDone", "bytesDone"];
  if (!exactKeys(frame, keys) || frame.type !== "progress"
      || !Object.hasOwn(PROGRESS_CODES, frame.phase)
      || !validCount(frame.filesDone) || !validCount(frame.bytesDone)) {
    throw importError("NATIVE_IMPORT_PROTOCOL_INVALID");
  }
  return frame;
}

function validateResult(frame) {
  const keys = [
    "type",
    "status",
    "runId",
    "importedCourses",
    "archivedCourses",
    "promotedBlobs",
    "reusedBlobs",
    "bytesVerified",
    "alreadyCurrent",
  ];
  if (!exactKeys(frame, keys) || frame.type !== "result" || frame.status !== "complete"
      || !validCount(frame.runId, false)
      || !validCount(frame.importedCourses)
      || !validCount(frame.archivedCourses)
      || !validCount(frame.promotedBlobs)
      || !validCount(frame.reusedBlobs)
      || !validCount(frame.bytesVerified)
      || typeof frame.alreadyCurrent !== "boolean") {
    throw importError("NATIVE_IMPORT_PROTOCOL_INVALID");
  }
  return frame;
}

function parseLine(bytes, state, progress) {
  if (bytes.length === 0 || bytes.length > MAX_LINE_BYTES) {
    throw importError("NATIVE_IMPORT_OUTPUT_LIMIT");
  }
  const line = bytes.toString("utf8").replace(/\r$/u, "");
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    throw importError("NATIVE_IMPORT_PROTOCOL_INVALID");
  }
  if (state.result) throw importError("NATIVE_IMPORT_PROTOCOL_INVALID");
  if (frame?.type === "progress") {
    const validated = validateProgress(frame);
    try {
      const callbackResult = progress(PROGRESS_CODES[validated.phase]);
      if (callbackResult && typeof callbackResult.then === "function") {
        callbackResult.catch(() => state.fail("NATIVE_IMPORT_PROGRESS_FAILED"));
      }
    } catch {
      throw importError("NATIVE_IMPORT_PROGRESS_FAILED");
    }
    return;
  }
  if (frame?.type === "result") {
    state.result = validateResult(frame);
    return;
  }
  throw importError("NATIVE_IMPORT_PROTOCOL_INVALID");
}

function signalChild(child, signal) {
  try {
    if (child.exitCode == null && child.signalCode == null) child.kill(signal);
  } catch {
    // The child may have closed between the state check and kill.
  }
}

function prepareInput(confirmedFirstUserId) {
  if (confirmedFirstUserId !== null
      && (!Number.isSafeInteger(confirmedFirstUserId) || confirmedFirstUserId <= 0)) {
    throw importError("NATIVE_IMPORT_CONFIRMATION_INVALID");
  }
  const bytes = Buffer.from(`${JSON.stringify({ confirmedFirstUserId })}\n`, "utf8");
  if (bytes.length > MAX_INPUT_BYTES) throw importError("NATIVE_IMPORT_CONFIRMATION_INVALID");
  return bytes;
}

/**
 * @typedef {import("node:events").EventEmitter & {
 *   stdin: import("node:stream").Writable,
 *   stdout: import("node:stream").Readable,
 *   stderr: import("node:stream").Readable,
 *   exitCode: number | null,
 *   signalCode: NodeJS.Signals | null,
 *   kill: (signal: NodeJS.Signals) => boolean,
 * }} CanvasNativeImportChild
 * @typedef {(command: string, args: string[], options: import("node:child_process").SpawnOptions) => CanvasNativeImportChild} CanvasNativeImportSpawn
 * @typedef {object} CanvasNativeImportOptions
 * @property {number | null} [confirmedFirstUserId]
 * @property {string} [homeDirectory]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {(status: string) => void} [progress]
 * @property {CanvasNativeImportSpawn} [spawnChild]
 * @property {(options: {homeDirectory?: string, helperPath?: string}) => Promise<string>} [validateHelper]
 */

/**
 * Runs the installed native importer with one bounded JSON request and bounded NDJSON output.
 * @param {CanvasNativeImportOptions} options
 */
export async function runCanvasBrowserNativeImport({
  confirmedFirstUserId = null,
  homeDirectory = homedir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  progress = noop,
  spawnChild = spawn,
  validateHelper = validateCanvasNativeImportHelper,
} = {}) {
  const input = prepareInput(confirmedFirstUserId);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
      || typeof progress !== "function" || typeof spawnChild !== "function"
      || typeof validateHelper !== "function") {
    throw importError("NATIVE_IMPORT_CONFIGURATION_INVALID");
  }
  if (signal?.aborted) throw importError("NATIVE_IMPORT_ABORTED");

  const helperPath = fixedCanvasNativeImportHelperPath(homeDirectory);
  try {
    await validateHelper({ homeDirectory, helperPath });
  } catch {
    throw importError("NATIVE_IMPORT_HELPER_UNAVAILABLE");
  }
  if (signal?.aborted) throw importError("NATIVE_IMPORT_ABORTED");

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let failureCode;
    let pending = Buffer.alloc(0);
    let outputBytes = 0;
    const state = {
      result: undefined,
      fail(code) {
        if (failureCode || settled) return;
        failureCode = code;
        signalChild(child, "SIGTERM");
        killTimer = setTimeout(() => signalChild(child, "SIGKILL"), TERMINATE_GRACE_MS);
        killTimer.unref?.();
      },
    };
    let timeoutTimer;
    let killTimer;
    const onAbort = () => state.fail("NATIVE_IMPORT_ABORTED");
    const onInterrupt = () => state.fail("NATIVE_IMPORT_ABORTED");

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      child?.stdout?.off("data", onStdout);
      child?.stderr?.off("data", onStderr);
      child?.stdin?.off("error", onStdinError);
      child?.off("error", onChildError);
      child?.off("close", onClose);
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    const onStdout = (chunk) => {
      if (failureCode) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        state.fail("NATIVE_IMPORT_OUTPUT_LIMIT");
        return;
      }
      const combined = pending.length > 0 ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        const line = combined.subarray(start, index);
        if (line.length > MAX_LINE_BYTES) {
          state.fail("NATIVE_IMPORT_OUTPUT_LIMIT");
          return;
        }
        try {
          parseLine(line, state, progress);
        } catch (error) {
          state.fail(error.code === "NATIVE_IMPORT_OUTPUT_LIMIT"
            ? "NATIVE_IMPORT_OUTPUT_LIMIT"
            : error.code === "NATIVE_IMPORT_PROGRESS_FAILED"
              ? "NATIVE_IMPORT_PROGRESS_FAILED"
              : "NATIVE_IMPORT_PROTOCOL_INVALID");
          return;
        }
        start = index + 1;
      }
      pending = Buffer.from(combined.subarray(start));
      if (pending.length > MAX_LINE_BYTES) state.fail("NATIVE_IMPORT_OUTPUT_LIMIT");
    };

    const onStderr = () => {};
    const onStdinError = () => state.fail("NATIVE_IMPORT_UNAVAILABLE");
    const onChildError = () => state.fail("NATIVE_IMPORT_UNAVAILABLE");
    const onClose = (code, childSignal) => {
      if (!failureCode && pending.length > 0) {
        try {
          parseLine(pending, state, progress);
          pending = Buffer.alloc(0);
        } catch (error) {
          failureCode = error.code === "NATIVE_IMPORT_OUTPUT_LIMIT"
            ? "NATIVE_IMPORT_OUTPUT_LIMIT"
            : error.code === "NATIVE_IMPORT_PROGRESS_FAILED"
              ? "NATIVE_IMPORT_PROGRESS_FAILED"
              : "NATIVE_IMPORT_PROTOCOL_INVALID";
        }
      }
      if (failureCode) {
        finish(importError(failureCode));
      } else if (code !== 0 || childSignal !== null) {
        finish(importError("NATIVE_IMPORT_FAILED"));
      } else if (!state.result) {
        finish(importError("NATIVE_IMPORT_PROTOCOL_INVALID"));
      } else {
        finish(undefined, state.result);
      }
    };

    try {
      child = spawnChild(helperPath, [], {
        shell: false,
        windowsHide: true,
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(importError("NATIVE_IMPORT_UNAVAILABLE"));
      return;
    }
    if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
      child?.kill?.("SIGTERM");
      finish(importError("NATIVE_IMPORT_UNAVAILABLE"));
      return;
    }

    child.once("error", onChildError);
    child.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    timeoutTimer = setTimeout(() => state.fail("NATIVE_IMPORT_TIMEOUT"), timeoutMs);
    timeoutTimer.unref?.();
    if (signal?.aborted) onAbort();

    if (!child.stdin || !child.stdout || !child.stderr) {
      state.fail("NATIVE_IMPORT_UNAVAILABLE");
      return;
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdin.on("error", onStdinError);
    child.stderr.resume?.();
    if (!failureCode) {
      try {
        child.stdin.end(input);
      } catch {
        state.fail("NATIVE_IMPORT_UNAVAILABLE");
      }
    }
  });
}

export const nativeImportProtocolLimits = Object.freeze({
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxInputBytes: MAX_INPUT_BYTES,
  maxLineBytes: MAX_LINE_BYTES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
});
