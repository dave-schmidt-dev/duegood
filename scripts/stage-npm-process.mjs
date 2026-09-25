import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROCESS_GROUP_TERM_TIMEOUT_MS = 1_000;
const PROCESS_GROUP_KILL_TIMEOUT_MS = 1_000;
const signalEscalationTimers = new WeakMap();

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId) && Date.now() < deadline) await wait(20);
  return !processGroupExists(processGroupId);
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/** Stop npm and every child in its private process group, then confirm the group is gone. */
export async function stopNpmProcessGroup(processGroupId) {
  if (!processGroupId || process.platform === "win32" || !processGroupExists(processGroupId)) return;
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(processGroupId, PROCESS_GROUP_TERM_TIMEOUT_MS)) return;
  signalProcessGroup(processGroupId, "SIGKILL");
  if (!(await waitForProcessGroupExit(processGroupId, PROCESS_GROUP_KILL_TIMEOUT_MS))) {
    throw new Error(`npm child process group ${String(processGroupId)} did not stop after SIGKILL`);
  }
}

/** Send a signal to npm's private process group, including any shell/script descendants. */
export function signalNpmProcessGroup(child, signal) {
  if (process.platform === "win32" || !child?.pid) {
    child?.kill(signal);
    return;
  }
  try {
    signalProcessGroup(child.pid, signal);
  } catch {
    child.kill(signal);
  }

  if (signal !== "SIGKILL" && !signalEscalationTimers.has(child)) {
    const timer = setTimeout(() => {
      signalEscalationTimers.delete(child);
      if (processGroupExists(child.pid)) signalNpmProcessGroup(child, "SIGKILL");
    }, PROCESS_GROUP_TERM_TIMEOUT_MS);
    timer.unref();
    signalEscalationTimers.set(child, timer);
  }
}

/** Run a candidate npm phase and wait until its process group has stopped before resolving. */
export function runNpmPhase(label, args, cwd, env, { onStart = () => {}, onClose = () => {}, checkInterrupted = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    checkInterrupted();
    const child = spawn("npm", args, {
      cwd,
      stdio: ["ignore", process.stderr, process.stderr],
      env,
      detached: process.platform !== "win32",
    });
    onStart(child);
    let startError;
    child.once("error", (error) => {
      startError = error;
    });
    child.once("close", () => {
      const timer = signalEscalationTimers.get(child);
      if (timer) clearTimeout(timer);
      signalEscalationTimers.delete(child);
    });
    child.once("close", async (code, signal) => {
      try {
        await stopNpmProcessGroup(child.pid);
      } catch (error) {
        reject(new Error(`${label} child processes did not stop: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      onClose(child);
      if (startError) {
        reject(new Error(`${label} could not start: ${startError.message}`));
      } else if (code !== 0) {
        reject(new Error(`${label} failed (exit ${String(code)}${signal ? `, signal ${signal}` : ""}): npm ${args.join(" ")}`));
      } else {
        resolve();
      }
    });
  });
}

/** Owns the generated temporary root and process signal lifecycle for the staging CLI. */
export function createStageCliLifecycle(options, onLog) {
  let temporaryRoot;
  let destination;
  if (options.destination) {
    destination = path.resolve(options.destination);
  } else {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "duegood-tauri-stage-"));
    destination = path.join(temporaryRoot, "stage");
  }

  let interruptedSignal;
  let activeNpmChild;
  const checkInterrupted = () => {
    if (!interruptedSignal) return;
    const error = new Error(`interrupted by ${interruptedSignal}`);
    error.signal = interruptedSignal;
    throw error;
  };
  const signalHandler = (signal) => {
    interruptedSignal ??= signal;
    if (activeNpmChild?.pid) signalNpmProcessGroup(activeNpmChild, signal);
  };
  const onSigint = () => signalHandler("SIGINT");
  const onSigterm = () => signalHandler("SIGTERM");
  const npmPhaseOptions = {
    checkInterrupted,
    onStart: (child) => {
      activeNpmChild = child;
    },
    onClose: (child) => {
      if (activeNpmChild === child) activeNpmChild = undefined;
    },
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  return {
    destination,
    checkInterrupted,
    npmPhaseOptions,
    withInterruption(error) {
      if (!interruptedSignal || !error || typeof error !== "object") return error;
      error.signal = interruptedSignal;
      if (!String(error.message).includes(`interrupted by ${interruptedSignal}`)) {
        error.message = `interrupted by ${interruptedSignal}: ${String(error.message)}`;
      }
      return error;
    },
    close() {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (activeNpmChild) {
        onLog(`cleanup: retained at ${temporaryRoot ?? destination} because the npm child process group is still active`);
      } else if (options.keep && temporaryRoot) {
        onLog(`stage: retained at ${temporaryRoot}`);
      } else if (options.keep && existsSync(destination)) {
        onLog(`stage: retained at ${temporaryRoot ?? destination}`);
      } else if (temporaryRoot && !options.keep) {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  };
}
