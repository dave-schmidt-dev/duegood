import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixedCanvasNativeImportHelperPath,
  nativeImportProtocolLimits,
  runCanvasBrowserNativeImport,
  validateCanvasNativeImportHelper,
} from "../../scripts/canvas-browser-native-import.mjs";

type ImportResult = {
  type: "result";
  status: "complete";
  runId: number;
  importedCourses: number;
  archivedCourses: number;
  promotedBlobs: number;
  reusedBlobs: number;
  bytesVerified: number;
  alreadyCurrent: boolean;
};

type FakeChild = EventEmitter & {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  closed: boolean;
  input: string;
  kill: (signal: NodeJS.Signals) => boolean;
};

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "duegood-browser-native-import-"));
  tempRoots.push(root);
  await chmod(root, 0o700);
  return root;
}

afterEach(async () => Promise.all(
  tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
));

const progressFrame = (phase: string) => ({
  type: "progress",
  phase,
  filesDone: 2,
  bytesDone: 64,
});

const resultFrame: ImportResult = {
  type: "result",
  status: "complete",
  runId: 37,
  importedCourses: 3,
  archivedCourses: 1,
  promotedBlobs: 4,
  reusedBlobs: 2,
  bytesVerified: 1234,
  alreadyCurrent: false,
};

function fakeChild({
  frames = [progressFrame("validating"), progressFrame("copying"), resultFrame],
  exitCode = 0,
  stderr = "",
  holdOpen = false,
}: {
  frames?: unknown[];
  exitCode?: number;
  stderr?: string;
  holdOpen?: boolean;
} = {}) {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      child.input += chunk.toString();
      callback();
    },
    final(callback) {
      callback();
      if (holdOpen) return;
      queueMicrotask(() => {
        if (stderr) child.stderr.write(stderr);
        for (const frame of frames) child.stdout.write(`${JSON.stringify(frame)}\n`);
        child.stdout.end();
        child.stderr.end();
        child.exitCode = exitCode;
        child.closed = true;
        child.emit("close", exitCode, null);
      });
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.closed = false;
  child.input = "";
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    if (child.closed) return true;
    child.signalCode = signal;
    setTimeout(() => {
      child.stdout.end();
      child.stderr.end();
      child.closed = true;
      child.emit("close", null, signal);
    }, 0);
    return true;
  }) as FakeChild["kill"];
  return child;
}

function validHelperInjection() {
  return vi.fn(async ({ helperPath = "/synthetic/helper" }: {
    homeDirectory?: string;
    helperPath?: string;
  }) => helperPath);
}

describe("Canvas native import runner", () => {
  it("uses the fixed helper with no argv, sends confirmation over bounded stdin, and returns safe progress", async () => {
    const child = fakeChild();
    const spawnChild = vi.fn(() => child);
    const validateHelper = validHelperInjection();
    const progress: string[] = [];
    const homeDirectory = "/synthetic/home";

    await expect(runCanvasBrowserNativeImport({
      confirmedFirstUserId: 41,
      homeDirectory,
      spawnChild,
      validateHelper,
      progress: (status: string) => progress.push(status),
    })).resolves.toEqual(resultFrame);

    const helperPath = fixedCanvasNativeImportHelperPath(homeDirectory);
    expect(validateHelper).toHaveBeenCalledWith({ homeDirectory, helperPath });
    expect(spawnChild).toHaveBeenCalledWith(helperPath, [], expect.objectContaining({
      shell: false,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    }));
    expect(child.input).toBe('{"confirmedFirstUserId":41}\n');
    expect(Buffer.byteLength(child.input)).toBeLessThanOrEqual(nativeImportProtocolLimits.maxInputBytes);
    expect(progress).toEqual(["CANVAS_IMPORT_VALIDATING", "CANVAS_IMPORT_COPYING"]);
    expect(JSON.stringify(progress)).not.toContain("41");
  });

  it("validates an owned installed executable and rejects a symlink or group-writable helper", async () => {
    const homeDirectory = await tempRoot();
    const helperPath = fixedCanvasNativeImportHelperPath(homeDirectory);
    await mkdir(path.dirname(helperPath), { recursive: true, mode: 0o700 });
    await writeFile(helperPath, "synthetic-helper", { mode: 0o700 });
    await expect(validateCanvasNativeImportHelper({ homeDirectory })).resolves.toBe(helperPath);

    const realHelper = `${helperPath}.real`;
    await rm(helperPath);
    await writeFile(realHelper, "synthetic-helper", { mode: 0o700 });
    await symlink(realHelper, helperPath);
    await expect(validateCanvasNativeImportHelper({ homeDirectory }))
      .rejects.toMatchObject({ code: "NATIVE_IMPORT_HELPER_UNAVAILABLE" });

    await rm(helperPath);
    await writeFile(helperPath, "synthetic-helper", { mode: 0o770 });
    await chmod(helperPath, 0o770);
    await expect(validateCanvasNativeImportHelper({ homeDirectory }))
      .rejects.toMatchObject({ code: "NATIVE_IMPORT_HELPER_UNAVAILABLE" });
  });

  it("maps private child diagnostics and unsuccessful exit to a fixed error code", async () => {
    const child = fakeChild({ frames: [], exitCode: 2, stderr: "private account diagnostic" });
    await expect(runCanvasBrowserNativeImport({
      spawnChild: () => child,
      validateHelper: validHelperInjection(),
    })).rejects.toMatchObject({ code: "NATIVE_IMPORT_FAILED", message: "NATIVE_IMPORT_FAILED" });
    expect(child.stderr.readableLength).toBe(0);
  });

  it("kills and joins the child for an oversized line or a frame with private fields", async () => {
    const oversized = fakeChild({ frames: ["x".repeat(nativeImportProtocolLimits.maxLineBytes + 1)] });
    const spawnOversized = vi.fn(() => oversized);
    await expect(runCanvasBrowserNativeImport({
      spawnChild: spawnOversized,
      validateHelper: validHelperInjection(),
    })).rejects.toMatchObject({ code: "NATIVE_IMPORT_OUTPUT_LIMIT" });
    expect(oversized.kill).toHaveBeenCalledWith("SIGTERM");
    expect(oversized.closed).toBe(true);

    const unsafe = fakeChild({
      frames: [{ ...resultFrame, userId: 41 }],
    });
    await expect(runCanvasBrowserNativeImport({
      spawnChild: () => unsafe,
      validateHelper: validHelperInjection(),
    })).rejects.toMatchObject({ code: "NATIVE_IMPORT_PROTOCOL_INVALID" });
    expect(unsafe.kill).toHaveBeenCalledWith("SIGTERM");
    expect(unsafe.closed).toBe(true);
  });

  it("stops and joins the child on timeout and AbortSignal", async () => {
    const timedOut = fakeChild({ frames: [], holdOpen: true });
    await expect(runCanvasBrowserNativeImport({
      timeoutMs: 15,
      spawnChild: () => timedOut,
      validateHelper: validHelperInjection(),
    })).rejects.toMatchObject({ code: "NATIVE_IMPORT_TIMEOUT" });
    expect(timedOut.kill).toHaveBeenCalledWith("SIGTERM");
    expect(timedOut.closed).toBe(true);

    const aborted = fakeChild({ frames: [], holdOpen: true });
    const controller = new AbortController();
    const running = runCanvasBrowserNativeImport({
      signal: controller.signal,
      spawnChild: () => {
        controller.abort();
        return aborted;
      },
      validateHelper: validHelperInjection(),
    });
    await expect(running).rejects.toMatchObject({ code: "NATIVE_IMPORT_ABORTED" });
    expect(aborted.kill).toHaveBeenCalledWith("SIGTERM");
    expect(aborted.closed).toBe(true);
  });

  it("rejects invalid confirmation IDs before validating or spawning the helper", async () => {
    const spawnChild = vi.fn();
    const validateHelper = validHelperInjection();
    await expect(runCanvasBrowserNativeImport({
      confirmedFirstUserId: 0,
      spawnChild,
      validateHelper,
    })).rejects.toMatchObject({ code: "NATIVE_IMPORT_CONFIRMATION_INVALID" });
    expect(validateHelper).not.toHaveBeenCalled();
    expect(spawnChild).not.toHaveBeenCalled();
  });
});

describe("compiled Canvas import helper input boundary", () => {
  it("rejects extra arguments and malformed confirmation before opening any store", () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const build = spawnSync("cargo", [
      "build", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
      "--features", "test-overrides", "--bin", "duegood-browser-import",
    ], { cwd: projectRoot, encoding: "utf8", timeout: 120_000 });
    if (build.status !== 0 && /resource path `binaries\/duegood-refresh-/u.test(build.stderr ?? "")) {
      throw new Error("compiled helper smoke requires `npm run build:refresh-helper:test` prerequisites");
    }
    expect(build.status).toBe(0);

    const targetDirectory = path.resolve(process.env.CARGO_TARGET_DIR
      ?? path.join(projectRoot, "src-tauri", "target"));
    const binary = path.join(targetDirectory, "debug", "duegood-browser-import");
    const temporary = mkdtempSync(path.join(tmpdir(), "duegood-browser-import-cli-"));
    const dataRoot = path.join(temporary, "com.zerodelta.duegood.test");
    const env = { ...process.env, DUEGOOD_TEST_DATA_ROOT: dataRoot };
    try {
      const extraArgument = spawnSync(binary, ["unexpected"], { cwd: projectRoot, env,
        encoding: "utf8", timeout: 10_000 });
      expect(extraArgument.status).toBe(1);
      expect(extraArgument.stderr.trim()).toBe("INVALID_ARGUMENTS");

      const malformedConfirmation = spawnSync(binary, [], { cwd: projectRoot, env,
        input: "not-json\n", encoding: "utf8", timeout: 10_000 });
      expect(malformedConfirmation.status).toBe(1);
      expect(malformedConfirmation.stderr.trim()).toBe("INVALID_INPUT");
      expect(existsSync(dataRoot)).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 140_000);
});
