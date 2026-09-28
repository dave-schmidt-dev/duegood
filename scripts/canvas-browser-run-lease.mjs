import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const START_TIMEOUT_MS = 10_000;
const TERMINAL_TIMEOUT_MS = 10_000;
/** @type {(command: string, args: string[], options: object) => import("node:child_process").ChildProcess} */
const defaultSpawn = spawn;

/** @typedef {object} CanvasRunLeaseOptions
 * @property {string} helperPath
 * @property {(runId: number) => Promise<{terminal?: {status: string}, value?: unknown}>} run
 * @property {(command: string, args: string[], options: object) => import("node:child_process").ChildProcess} [spawnChild]
 * @property {number} [startTimeoutMs]
 * @property {number} [terminalTimeoutMs]
 */

function leaseError(code, cause = undefined) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function timeout(promise, milliseconds, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(leaseError(code)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function parseStatusLine(line, prefix) {
  if (typeof line !== "string" || line.length > 128) throw leaseError("CAPTURE_LEASE_PROTOCOL_INVALID");
  const match = prefix === "lease"
    ? /^lease run=([1-9][0-9]*) status=running$/u.exec(line)
    : /^run=([1-9][0-9]*) status=(captured|failed)$/u.exec(line);
  if (!match) throw leaseError("CAPTURE_LEASE_PROTOCOL_INVALID");
  const runId = Number(match[1]);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw leaseError("CAPTURE_LEASE_PROTOCOL_INVALID");
  return { runId, status: match[2] ?? "running" };
}

function validateTerminal(terminal, runId) {
  if (!terminal || terminal.status !== "captured" || terminal.runId !== runId
      || !Number.isSafeInteger(terminal.userId) || terminal.userId <= 0
      || typeof terminal.generationId !== "string" || !/^[a-f0-9]{32}$/u.test(terminal.generationId)
      || typeof terminal.snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(terminal.snapshotSha256)) {
    throw leaseError("CAPTURE_LEASE_RECEIPT_INVALID");
  }
  return terminal;
}

async function sendFailure(child, runId) {
  if (child.stdin.destroyed || child.stdin.writableEnded) return;
  child.stdin.end(`${JSON.stringify({ status: "failed", runId })}\n`);
}

/** Holds a native file-lock lease while one injected capture operation runs.
 * @param {CanvasRunLeaseOptions} options Lease paths, callback and bounded protocol settings.
 */
export async function withCanvasRunLease({
  helperPath,
  run,
  spawnChild = defaultSpawn,
  startTimeoutMs = START_TIMEOUT_MS,
  terminalTimeoutMs = TERMINAL_TIMEOUT_MS,
} = {}) {
  if (typeof helperPath !== "string" || !helperPath.startsWith("/") || typeof run !== "function"
      || typeof spawnChild !== "function") throw leaseError("INVALID_CONFIGURATION");
  let child;
  let lines;
  let exitPromise;
  let runId;
  try {
    child = spawnChild(helperPath, ["lease"], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "inherit"],
    });
    if (!child?.stdout || !child?.stdin || typeof child.once !== "function") {
      throw leaseError("CAPTURE_LEASE_UNAVAILABLE");
    }
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    exitPromise = once(child, "close");
    const first = await timeout(iterator.next(), startTimeoutMs, "CAPTURE_LEASE_START_TIMEOUT");
    if (first.done) throw leaseError("CAPTURE_LEASE_UNAVAILABLE");
    ({ runId } = parseStatusLine(first.value, "lease"));
    const outcome = await run(runId);
    const terminal = validateTerminal(outcome?.terminal, runId);
    child.stdin.end(`${JSON.stringify(terminal)}\n`);
    const finalLine = await timeout(iterator.next(), terminalTimeoutMs, "CAPTURE_LEASE_TERMINAL_TIMEOUT");
    if (finalLine.done) throw leaseError("CAPTURE_LEASE_UNAVAILABLE");
    const status = parseStatusLine(finalLine.value, "final");
    const [code, signal] = await timeout(exitPromise, terminalTimeoutMs, "CAPTURE_LEASE_TERMINAL_TIMEOUT");
    if (status.runId !== runId || status.status !== "captured" || code !== 0 || signal !== null) {
      throw leaseError("CAPTURE_LEASE_REJECTED");
    }
    return outcome.value;
  } catch (error) {
    if (child && runId !== undefined) {
      await sendFailure(child, runId).catch(() => undefined);
      if (exitPromise) await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, terminalTimeoutMs))]).catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) child.kill?.("SIGTERM");
    }
    if (error?.code && /^CAPTURE_LEASE_/u.test(error.code)) throw error;
    throw error;
  } finally {
    lines?.close();
  }
}
