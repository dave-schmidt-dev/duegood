import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = path.resolve(".");
const brokerUrl = pathToFileURL(path.join(root, "scripts", "canvas-browser-session.mjs")).href;
const clientUrl = pathToFileURL(path.join(root, "scripts", "canvas-browser-session-client.mjs")).href;
const { runCanvasCapture } = await import(brokerUrl);
const { CAPTURE_TIMEOUT_MS } = await import(clientUrl);
const temporaryDirectories: string[] = [];
const json = (value: unknown) => JSON.stringify(value);

async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duegood-session-test-"));
  await chmod(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function childEnvironment(directory: string, failStart = false) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    SESSION_TEST_DIRECTORY: directory,
    SESSION_TEST_FAIL_START: failStart ? "1" : "0",
  };
}

function brokerProgram() {
  return `
    import path from "node:path";
    import { startSessionBroker } from ${JSON.stringify(brokerUrl)};
    const directory = process.env.SESSION_TEST_DIRECTORY;
    let contextClosed = false;
    let runs = 0;
    const page = { goto: async () => {} };
    const context = {
      pages: () => [page],
      newPage: async () => page,
      newCDPSession: async () => ({ send: async () => {}, detach: async () => {} }),
      on: () => {},
      close: async () => { contextClosed = true; },
    };
    const broker = await startSessionBroker({
      appDirectory: directory,
      profileDirectory: path.join(directory, "profile"),
      socketPath: path.join(directory, "session.sock"),
      launchContext: async () => {
        if (process.env.SESSION_TEST_FAIL_START === "1") throw new Error("synthetic failure");
        return context;
      },
      probe: async ({ context: activeContext, progress }) => {
        if (activeContext !== context || contextClosed) throw new Error("context was not reused");
        runs += 1;
        if (runs === 3) throw new Error("synthetic probe failure");
        progress("PROBE_RUNNING");
        return { status: "PARTIAL", checks: {
          signedInContinuity: "OK", accountIdentity: "AVAILABLE_UNBOUND",
          apiShapePagination: runs === 1 ? "NO_COURSES" : "OK",
          inboxUnreadState: "NO_UNREAD_ITEMS", fileMetadata: "NO_COURSE",
          fileVerifier: "NO_COURSE", cookielessDownload: "NO_COURSE", nativeDownloader: "NOT_TESTED",
        } };
      },
    });
    process.stdout.write("READY\\n");
    await broker.closed;
    process.stdout.write("CLOSED:" + String(contextClosed) + "\\n");
  `;
}

async function waitForLine(child: ReturnType<typeof spawn>, expected: string, timeoutMs = 5_000) {
  return new Promise<void>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("child output timeout")), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.split("\n").includes(expected)) finish();
    };
    const onExit = (code: number | null) => finish(new Error(`child exited ${code ?? "unknown"}`));
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

function sendCommand(
  socketPath: string,
  command: string | Record<string, unknown>,
  onProgress: (frame: Record<string, unknown>) => void = () => {},
) {
  return new Promise<{ frames: Array<Record<string, unknown>>; final: Record<string, unknown> }>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const frames: Array<Record<string, unknown>> = [];
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("socket response timeout")), 3_000);
    const finish = (error?: Error, final?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (!final) reject(new Error("missing final frame"));
      else resolve({ frames, final });
    };
    socket.once("connect", () => socket.write(`${json(typeof command === "string" ? { command } : command)}\n`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > 2_048) return finish(new Error("socket response too large"));
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(line.toString("utf8")) as Record<string, unknown>; } catch { return finish(new Error("invalid frame")); }
        if (frame.progress) {
          frames.push(frame);
          onProgress(frame);
        }
        else return finish(undefined, frame);
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

async function waitForReady(socketPath: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await sendCommand(socketPath, "status");
    if (response.final.status === "READY") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("broker did not become ready");
}

function syntheticSnapshot(userId: number, runId = 99, generationId = "e".repeat(32)) {
  return {
    schemaVersion: 2,
    source: "canvas-browser",
    runId,
    generationId,
    capturedAt: "2026-09-27T12:00:00.000Z",
    identity: { origin: "https://marymount.instructure.com", userId },
    activeCourses: { complete: true, courseIds: [] },
    coverageRequirements: { activeCoursesComplete: true,
      perActiveCourse: ["course", "assignments", "assignmentGroups", "submissions"] },
    resources: [
      { endpoint: "profile", courseId: null, pages: 1, items: [{ id: userId, name: "synthetic private body" }] },
      { endpoint: "coursesActive", courseId: null, pages: 1, items: [] },
    ],
    coverage: [
      { endpoint: "profile", courseId: null, status: "complete" },
      { endpoint: "coursesActive", courseId: null, status: "complete" },
      { endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" },
    ],
  };
}

async function syntheticRunLease({ run }: { run: (runId: number) => Promise<{
  terminal?: Record<string, unknown>; value?: unknown;
}> }) {
  const outcome = await run(52);
  if (outcome.terminal?.status !== "captured") throw new Error("synthetic capture lease failed");
  return outcome.value;
}

function captureBrokerProgram() {
  return `
    import path from "node:path";
    import { startSessionBroker } from ${JSON.stringify(brokerUrl)};
    const directory = process.env.SESSION_TEST_DIRECTORY;
    const page = { goto: async () => {} };
    const context = { pages: () => [page], newPage: async () => page, on: () => {}, close: async () => {} };
    let runs = 0;
    const broker = await startSessionBroker({
      appDirectory: directory,
      profileDirectory: path.join(directory, "profile"),
      socketPath: path.join(directory, "session.sock"),
      launchContext: async () => context,
      identity: async ({ context: activeContext }) => activeContext === context ? 41 : undefined,
      capture: async ({ context: activeContext, expectedUserId, protocolVersion, progress }) => {
        if (activeContext !== context) throw new Error("context was not reused");
        if (protocolVersion !== 2) throw new Error("current broker did not request schema v2");
        runs += 1;
        progress("CAPTURE_RUNNING");
        if (expectedUserId === 42) return ${JSON.stringify(syntheticSnapshot(41))};
        if (expectedUserId === 43) return { ...${JSON.stringify(syntheticSnapshot(43))}, coverage: [
          { endpoint: "profile", courseId: null, status: "incomplete" },
          { endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" },
        ] };
        if (expectedUserId === 44) return { ...${JSON.stringify(syntheticSnapshot(44))}, coverage: [
          { endpoint: "profile", courseId: null, status: "complete" },
          { endpoint: "coursesActive", courseId: null, status: "complete" },
          { endpoint: "quizzes", courseId: 88, status: "gap", reason: "not-found" },
          { endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" },
        ] };
        return ${JSON.stringify(syntheticSnapshot(41))};
      },
    });
    process.stdout.write("READY\\n");
    await broker.closed;
    process.stdout.write("CLOSED:" + runs + "\\n");
  `;
}

function delayedBrokerProgram() {
  return `
    import path from "node:path";
    import { startSessionBroker } from ${JSON.stringify(brokerUrl)};
    const directory = process.env.SESSION_TEST_DIRECTORY;
    const page = { goto: async () => {} };
    const context = { pages: () => [page], newPage: async () => page, on: () => {}, close: async () => {} };
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const broker = await startSessionBroker({
      appDirectory: directory,
      profileDirectory: path.join(directory, "profile"),
      socketPath: path.join(directory, "session.sock"),
      launchContext: async () => context,
      probe: async ({ progress }) => {
        progress("PROBE_RUNNING");
        await delay(100);
        return { status: "PARTIAL", checks: { apiShapePagination: "OK" } };
      },
      capture: async ({ expectedUserId, protocolVersion, progress }) => {
        if (protocolVersion !== 2) throw new Error("current broker did not request schema v2");
        progress("CAPTURE_RUNNING");
        await delay(50);
        return { ...${JSON.stringify(syntheticSnapshot(41))}, identity: {
          origin: "https://marymount.instructure.com", userId: expectedUserId,
        } };
      },
    });
    process.stdout.write("READY\\n");
    await broker.closed;
    process.stdout.write("CLOSED\\n");
  `;
}

async function leaveStaleSocket(socketPath: string, directory: string) {
  const code = `import net from "node:net"; const server=net.createServer(); server.listen(process.env.SESSION_TEST_SOCKET,()=>process.exit(0));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { PATH: process.env.PATH ?? "", SESSION_TEST_SOCKET: socketPath },
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (codeValue) => codeValue === 0 ? resolve() : reject(new Error("stale socket setup failed")));
  });
  const owner = path.join(directory, "canvas-session.owner");
  await writeFile(owner, json({ pid: child.pid, uid: process.getuid?.() ?? -1 }), { mode: 0o600 });
}

async function stopChild(child: ReturnType<typeof spawn> | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000)),
  ]);
}

async function waitForChildExit(child: ReturnType<typeof spawn>) {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Canvas session broker process protocol", () => {
  it("allows five minutes beyond the thirty-minute capture budget for protocol cleanup", () => {
    expect(CAPTURE_TIMEOUT_MS).toBe(35 * 60_000);
  });

  it("reclaims only a dead owner's socket, reuses one browser for two probes, reports failure, and stops explicitly", async () => {
    const directory = await tempDirectory();
    const socketPath = path.join(directory, "session.sock");
    await leaveStaleSocket(socketPath, directory);
    const child = spawn(process.execPath, ["--input-type=module", "-e", brokerProgram()], {
      cwd: root,
      env: childEnvironment(directory),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLine(child, "READY");
      const socketStat = await lstat(socketPath);
      expect(socketStat.isSocket()).toBe(true);
      expect(socketStat.mode & 0o077).toBe(0);
      expect((await lstat(directory)).mode & 0o077).toBe(0);

      expect((await sendCommand(socketPath, "status")).final).toEqual({ status: "READY" });
      const first = await sendCommand(socketPath, "probe");
      const second = await sendCommand(socketPath, "probe");
      expect(first.final).toMatchObject({ status: "PARTIAL", checks: { apiShapePagination: "NO_COURSES" } });
      expect(second.final).toMatchObject({ status: "PARTIAL", checks: { apiShapePagination: "OK" } });
      expect(first.frames).toContainEqual({ progress: "PROBE_RUNNING" });
      expect((await sendCommand(socketPath, "probe")).final).toEqual({ status: "REQUEST_FAILED" });
      expect((await sendCommand(socketPath, "status")).final).toEqual({ status: "READY" });
      expect((await sendCommand(socketPath, "stop")).final).toEqual({ status: "STOPPING" });
      await waitForLine(child, "CLOSED:true");
      await waitForChildExit(child);
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(directory, "canvas-session.owner"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await stopChild(child);
    }
  });

  it("accepts rapid sequential commands after replies while keeping in-flight probes BUSY", async () => {
    const directory = await tempDirectory();
    const socketPath = path.join(directory, "session.sock");
    const child = spawn(process.execPath, ["--input-type=module", "-e", delayedBrokerProgram()], {
      cwd: root,
      env: childEnvironment(directory),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLine(child, "READY");

      expect((await sendCommand(socketPath, "status")).final).toEqual({ status: "READY" });
      expect((await sendCommand(socketPath, "probe")).final)
        .toMatchObject({ status: "PARTIAL", checks: { apiShapePagination: "OK" } });
      expect((await sendCommand(socketPath, { command: "capture", expectedUserId: 41 })).final)
        .toMatchObject({ status: "PARTIAL", resourceCount: 2, fileBodiesIncomplete: true });
      expect((await sendCommand(socketPath, "status")).final).toEqual({ status: "READY" });

      let signalRunning!: () => void;
      const probeRunning = new Promise<void>((resolve) => { signalRunning = resolve; });
      const inFlight = sendCommand(socketPath, "probe", (frame) => {
        if (frame.progress === "PROBE_RUNNING") signalRunning();
      });
      await probeRunning;
      expect((await sendCommand(socketPath, "status")).final).toEqual({ status: "BUSY" });
      expect((await inFlight).final).toMatchObject({ status: "PARTIAL" });

      expect((await sendCommand(socketPath, "stop")).final).toEqual({ status: "STOPPING" });
      await waitForLine(child, "CLOSED");
      await waitForChildExit(child);
    } finally {
      await stopChild(child);
    }
  });

  it("cleans the owner record when browser startup fails", async () => {
    const directory = await tempDirectory();
    const code = `
      import path from "node:path";
      import { startSessionBroker } from ${JSON.stringify(brokerUrl)};
      const directory = process.env.SESSION_TEST_DIRECTORY;
      try {
        await startSessionBroker({
          appDirectory: directory,
          profileDirectory: path.join(directory, "profile"),
          socketPath: path.join(directory, "session.sock"),
          launchContext: async () => { throw new Error("synthetic launch failure"); },
        });
        process.exitCode = 2;
      } catch { process.stdout.write("FAILED_CLEANLY\\n"); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root,
      env: childEnvironment(directory, true),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLine(child, "FAILED_CLEANLY");
      await waitForChildExit(child);
      await expect(lstat(path.join(directory, "session.sock"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(directory, "canvas-session.owner"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await stopChild(child);
    }
  });

  it("captures only the confirmed identity, keeps gaps explicit, and atomically publishes mode-0600 snapshots", async () => {
    const directory = await tempDirectory();
    const socketPath = path.join(directory, "session.sock");
    const snapshotPath = path.join(directory, "canvas-capture.json");
    const child = spawn(process.execPath, ["--input-type=module", "-e", captureBrokerProgram()], {
      cwd: root,
      env: childEnvironment(directory),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLine(child, "READY");

      expect((await sendCommand(socketPath, "identity")).final)
        .toEqual({ status: "IDENTITY_AVAILABLE", userId: 41 });
      await waitForReady(socketPath);

      expect((await sendCommand(socketPath, { command: "capture", expectedUserId: 42 })).final)
        .toEqual({ status: "REQUEST_FAILED", errorCode: "CAPTURE_IDENTITY_OR_SHAPE_REJECTED" });
      await waitForReady(socketPath);
      expect((await sendCommand(socketPath, { command: "capture", expectedUserId: 43 })).final)
        .toEqual({ status: "REQUEST_FAILED", errorCode: "CAPTURE_COVERAGE_INCOMPLETE" });
      await waitForReady(socketPath);
      expect((await sendCommand(socketPath, { command: "capture", expectedUserId: "41" })).final)
        .toEqual({ status: "REQUEST_FAILED" });
      await waitForReady(socketPath);
      await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(directory)).some((entry) => entry.endsWith(".tmp"))).toBe(false);

      const first = await sendCommand(socketPath, { command: "capture", expectedUserId: 41 });
      expect(first.final).toEqual({
        status: "PARTIAL", resourceCount: 2, itemCount: 1, gapCount: 1, fileBodiesIncomplete: true,
      });
      expect(first.frames).toContainEqual({ progress: "CAPTURE_RUNNING" });
      expect(first.frames).toContainEqual({ progress: "CAPTURE_SAVING" });
      expect(JSON.stringify(first)).not.toMatch(/synthetic private body|https?:/u);

      const snapshotStat = await lstat(snapshotPath);
      expect(snapshotStat.isFile()).toBe(true);
      expect(snapshotStat.mode & 0o777).toBe(0o600);
      expect(snapshotStat.uid).toBe(process.getuid?.());
      const saved = await readFile(snapshotPath, "utf8");
      expect(JSON.parse(saved)).toMatchObject({
        complete: false,
        identity: { userId: 41 },
        coverage: [
          { endpoint: "profile", status: "complete" },
          { endpoint: "coursesActive", status: "complete" },
          { endpoint: "fileBodies", status: "gap" },
        ],
      });
      expect(saved).toContain("synthetic private body");

      await waitForReady(socketPath);
      const second = await sendCommand(socketPath, { command: "capture", expectedUserId: 41 });
      expect(second.final).toMatchObject({ status: "PARTIAL", resourceCount: 2, itemCount: 1 });
      expect(await readFile(snapshotPath, "utf8")).toBe(saved);
      expect((await readdir(directory)).some((entry) => entry.endsWith(".tmp"))).toBe(false);

      await waitForReady(socketPath);
      expect((await sendCommand(socketPath, { command: "capture", expectedUserId: 44 })).final)
        .toMatchObject({ status: "PARTIAL", gapCount: 2 });

      await waitForReady(socketPath);
      expect((await sendCommand(socketPath, "stop")).final).toEqual({ status: "STOPPING" });
      await waitForLine(child, "CLOSED:5");
      await waitForChildExit(child);
    } finally {
      await stopChild(child);
    }
  });

  it("keeps a v1 broker view transient while the durable archive and current broker stay v2", async () => {
    const page = {
      url: () => "https://marymount.instructure.com/",
      isClosed: () => false,
      goto: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const context = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(),
    };
    const collector = vi.fn(async ({
      page: capturePage,
      expectedUserId,
      runId,
      generationId,
    }: {
      page: typeof page;
      expectedUserId: number;
      runId: number;
      generationId: string;
    }) => {
      expect(capturePage).toBe(page);
      return syntheticSnapshot(expectedUserId, runId, generationId);
    });
    const progress = vi.fn();
    const appDirectory = await tempDirectory();
    const helperPath = path.join(appDirectory, "synthetic-helper");
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const stateHelperPath = path.join(appDirectory, "synthetic-state-helper");
    await writeFile(stateHelperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const saveGeneration = vi.fn(async ({ snapshot, generationId }) => ({ generationId,
      snapshotSha256: "f".repeat(64), blobCount: 0,
      archivedSnapshot: snapshot }));

    const legacyView = await runCanvasCapture({ context, expectedUserId: 41, progress, collector, appDirectory, helperPath,
      stateHelperPath, withRunLease: syntheticRunLease, saveGeneration });
    const currentView = await runCanvasCapture({ context, expectedUserId: 41, protocolVersion: 2,
      progress, collector, appDirectory, helperPath,
      stateHelperPath, withRunLease: syntheticRunLease, saveGeneration });

    expect(legacyView).toMatchObject({ schemaVersion: 1, source: "canvas-browser", complete: false });
    expect(legacyView).not.toHaveProperty("runId");
    expect(legacyView).not.toHaveProperty("generationId");
    expect(currentView).toMatchObject({ schemaVersion: 2, runId: 52,
      generationId: expect.stringMatching(/^[a-f0-9]{32}$/u) });
    expect(saveGeneration.mock.calls.every(([value]) => value.snapshot.schemaVersion === 2
      && value.snapshot.runId === 52 && value.snapshot.generationId === value.generationId)).toBe(true);

    expect(context.pages).toHaveBeenCalledTimes(2);
    expect(context.newPage).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
    expect(collector).toHaveBeenCalledTimes(2);
    expect(saveGeneration).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(progress.mock.calls)).not.toMatch(/https?:|41/u);
  });
});
