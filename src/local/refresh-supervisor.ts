import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export interface RefreshCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface RefreshResult {
  readonly capturedBytes: number;
}

type RefreshChild = () => Promise<RefreshResult>;
type RefreshExclusive<T> = (operation: RefreshChild) => Promise<T>;

const FIXED_REFRESH_COMMAND: RefreshCommand = {
  executable: path.join(homedir(), ".agent", "bin", "bws-secret-exec"),
  args: ["canvas-course-refresh", "--"],
};

const FIXED_ICAL_COMMAND: RefreshCommand = {
  executable: path.join(homedir(), ".agent", "bin", "bws-secret-exec"),
  args: ["duegood-canvas-ical", "--"],
};

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); } catch {}
}

/** Runs one bounded, noninteractive refresh without retaining child output. */
export async function superviseRefresh<T = RefreshResult>(
  cwd: string,
  command: RefreshCommand = FIXED_REFRESH_COMMAND,
  timeoutMs = 180_000,
  onStatus: (capturedBytes: number) => void = () => undefined,
  exclusive: RefreshExclusive<T> = async (operation) => await operation() as unknown as T,
): Promise<T> {
  const runChild: RefreshChild = () => new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let capturedBytes = 0;
    let settled = false;
    const consume = (chunk: Buffer) => {
      capturedBytes = Math.min(capturedBytes + chunk.length, 65_536);
      onStatus(capturedBytes);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const timeout = setTimeout(() => {
      signalGroup(child.pid, "SIGTERM");
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      if (code === 0) resolve({ capturedBytes });
      else reject(new Error(signal === null ? `refresh exited ${code}` : `refresh stopped by ${signal}`));
    });
  });
  return exclusive(runChild);
}

/** Runs only the owner-registered iCal consumer, passing the local origin and CSRF token over stdin. */
export async function superviseIcalFetch(
  cwd: string,
  origin: string,
  csrfToken: string,
  timeoutMs = 30_000,
  onStatus: (capturedBytes: number) => void = () => undefined,
  command: RefreshCommand = FIXED_ICAL_COMMAND,
): Promise<RefreshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let capturedBytes = 0;
    let settled = false;
    const consume = (chunk: Buffer) => {
      capturedBytes = Math.min(capturedBytes + chunk.length, 65_536);
      onStatus(capturedBytes);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.stdin.once("error", () => undefined);
    child.stdin.end(`${JSON.stringify({ origin, csrfToken })}\n`);
    const timeout = setTimeout(() => {
      signalGroup(child.pid, "SIGTERM");
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", () => {
      settled = true;
      clearTimeout(timeout);
      reject(new Error("calendar fetch unavailable"));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      if (code === 0) resolve({ capturedBytes });
      else reject(new Error(signal === null ? "calendar fetch failed" : "calendar fetch timed out"));
    });
  });
}
