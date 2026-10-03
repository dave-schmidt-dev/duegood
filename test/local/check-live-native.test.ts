import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseXcodeMarkers,
  parseArguments,
  readPrivateExpectedFile,
  runBoundedProcess,
  runLiveVerification,
  validateExpectedDocument,
} from "../../scripts/check-live-native.mjs";
import { createOwnedScratchRoot } from "../../scripts/owned-scratch-root.mjs";

const registeredPages = ["timeline", "grades", "inbox", "completed", "courses", "library", "activity", "more"] as const;
const headings = ["Timeline", "Grades", "Inbox", "Completed", "Courses", "Library", "Activity", "More"] as const;
const appPath = "/Applications/Due Good.app";
const appIdentity = {
  pid: 4711,
  appPath,
  executablePath: path.join(appPath, "Contents", "MacOS", "duegood-desktop"),
};
const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duegood-live-native-test-"));
  await chmod(directory, 0o700);
  const canonical = await realpath(directory);
  temporaryRoots.push(canonical);
  return canonical;
}

function expectedDocument(): {
  schemaVersion: number;
  performFullRefresh: boolean;
  pages: Array<{ id: string; heading: string; requiredText: string[]; forbiddenText: string[]; emptyStateText?: string }>;
} {
  return {
    schemaVersion: 1,
    performFullRefresh: true,
    pages: registeredPages.map((id, index) => ({
      id,
      heading: headings[index] ?? "",
      requiredText: [`synthetic-source-token-${id}`],
      forbiddenText: [],
    })),
  };
}

async function expectedFile(directory: string, document = expectedDocument()): Promise<string> {
  const filePath = path.join(directory, "expected.json");
  await writeFile(filePath, JSON.stringify(document), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

function xcodeMarkers(outcome = "complete") {
  return [
    `DUEGOOD_LIVE_REFRESH outcome=${outcome}`,
    ...registeredPages.map((id) => `DUEGOOD_LIVE_PAGE id=${id} ok=true matched=1`),
  ].join("\n");
}

function ownedScratchRoots(parent: string, roots: string[]) {
  return () => {
    const scratch = createOwnedScratchRoot("live-run-test", { baseDirectory: parent });
    roots.push(scratch.root);
    return scratch;
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("live native verifier private input", () => {
  it("takes only the expected-file path from its environment", () => {
    const expectedPath = "/private/expected-live-check.json";
    expect(parseArguments([], { DUEGOOD_LIVE_EXPECTED_FILE: expectedPath })).toEqual({ expectedFilePath: expectedPath });
    expect(() => parseArguments(["--expected-file", expectedPath], { DUEGOOD_LIVE_EXPECTED_FILE: expectedPath })).toThrow("invalid_arguments");
    expect(() => parseArguments([], {})).toThrow("invalid_arguments");
  });

  it("requires all eight public routes and either source tokens or an explicit empty state", () => {
    const valid = validateExpectedDocument(expectedDocument());
    expect(valid.pages.map((page) => page.id)).toEqual(registeredPages);
    const emptyState = expectedDocument();
    emptyState.pages[3] = { id: "completed", heading: "Completed", requiredText: [], forbiddenText: [], emptyStateText: "Nothing completed yet." };
    expect(validateExpectedDocument(emptyState).pages[3]?.emptyStateText).toBe("Nothing completed yet.");
    expect(() => validateExpectedDocument({ ...valid, pages: valid.pages.slice(1) })).toThrow("invalid_expected_schema");
    expect(() => validateExpectedDocument({ ...valid, pages: valid.pages.map((page) => page.id === "inbox" ? { ...page, heading: "Wrong" } : page) })).toThrow("invalid_expected_schema");
    const noExpectation = expectedDocument();
    noExpectation.pages[2] = { id: "inbox", heading: "Inbox", requiredText: [], forbiddenText: [] };
    expect(() => validateExpectedDocument(noExpectation)).toThrow("invalid_expected_schema");
  });

  it("rejects symlinks, permissive files, and malformed private bytes without echoing contents", async () => {
    const directory = await temporaryDirectory();
    const target = await expectedFile(directory);
    const link = path.join(directory, "linked.json");
    await symlink(target, link);
    expect(() => readPrivateExpectedFile(link)).toThrow("invalid_expected_file");

    await chmod(target, 0o644);
    expect(() => readPrivateExpectedFile(target)).toThrow("invalid_expected_file");
    await chmod(target, 0o600);

    const malformed = path.join(directory, "malformed.json");
    const privateCanary = "synthetic-private-json-canary";
    await writeFile(malformed, `not-json-${privateCanary}`, { mode: 0o600 });
    await chmod(malformed, 0o600);
    let message = "";
    try { readPrivateExpectedFile(malformed); }
    catch (error) { message = error instanceof Error ? error.message : ""; }
    expect(message).toBe("invalid_expected_schema");
    expect(message).not.toContain(privateCanary);
  });

  it("rejects oversized or non-private expected files", async () => {
    const directory = await temporaryDirectory();
    const oversized = path.join(directory, "oversized.json");
    await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x20), { mode: 0o600 });
    await chmod(oversized, 0o600);
    expect(() => readPrivateExpectedFile(oversized)).toThrow("invalid_expected_file");
  });

  it.skipIf(process.platform === "win32")("rejects a regular-file-to-FIFO swap without blocking", async () => {
    const directory = await temporaryDirectory();
    const expectedPath = await expectedFile(directory);
    const fifoPath = path.join(directory, "replacement.fifo");
    const created = spawnSync("/usr/bin/mkfifo", [fifoPath], { encoding: "utf8", timeout: 2_000 });
    expect(created.error).toBeUndefined();
    expect(created.status).toBe(0);
    const moduleUrl = new URL("../../scripts/check-live-native.mjs", import.meta.url).href;
    const source = `
      import { renameSync } from "node:fs";
      import { readPrivateExpectedFile } from ${JSON.stringify(moduleUrl)};
      try {
        readPrivateExpectedFile(${JSON.stringify(expectedPath)}, {
          beforeOpen: () => renameSync(${JSON.stringify(fifoPath)}, ${JSON.stringify(expectedPath)}),
        });
        process.stdout.write("unexpected-success");
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : "unknown-error");
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 2_500 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("invalid_expected_file");
  });
});

describe("populated-store live verification orchestration", () => {
  it("attaches to the same owned process, passes only a private expected-file path, and removes scratch", async () => {
    const parent = await temporaryDirectory();
    const expectedPath = await expectedFile(parent);
    const roots: string[] = [];
    const query = vi.fn(async (options: unknown) => {
      void options;
      return [appIdentity];
    });
    let childOptions: { args: string[]; env: Record<string, string | undefined>; logPath: string } | undefined;
    const sourceCanary = "synthetic-source-token-timeline";
    const previousCanary = process.env.DUEGOOD_TEST_PRIVATE_CANARY;
    process.env.DUEGOOD_TEST_PRIVATE_CANARY = sourceCanary;
    try {
      const receipt = await runLiveVerification({
        expectedFilePath: expectedPath,
        platform: "darwin",
        fileExists: () => true,
        queryApplications: query,
        scratchFactory: ownedScratchRoots(parent, roots),
        runXcode: async (_command, args, options) => {
          childOptions = { args, env: options.env, logPath: options.logPath };
          await writeFile(options.logPath, xcodeMarkers(), { mode: 0o600 });
          await chmod(options.logPath, 0o600);
          return { code: 0, signal: null, timedOut: false, overflow: false };
        },
      });
      expect(receipt.status).toBe("passed");
      expect(receipt.identityBefore).toBe(true);
      expect(receipt.identityAfter).toBe(true);
      expect(receipt.pages).toHaveLength(8);
      expect(query).toHaveBeenCalledTimes(2);
      const identityOptions = query.mock.calls[0]?.[0] as { environment?: Record<string, string>; inheritEnvironment?: boolean } | undefined;
      const identityEnvironment = identityOptions?.environment ?? {};
      expect(identityOptions?.inheritEnvironment).toBe(false);
      expect(Object.keys(identityEnvironment).every((key) => ["HOME", "DEVELOPER_DIR", "TMPDIR"].includes(key))).toBe(true);
      expect(identityEnvironment).not.toHaveProperty("DUEGOOD_LIVE_EXPECTED_FILE");
      expect(childOptions?.args).toContain("-only-testing:DueGoodDesktopUITests/DueGoodDesktopUITests/testLiveRefreshAllPagesInPopulatedStore");
      expect(childOptions?.env).toHaveProperty("TEST_RUNNER_DUEGOOD_LIVE_EXPECTED_FILE");
      expect(childOptions?.env.TEST_RUNNER_DUEGOOD_LIVE_EXPECTED_FILE).toContain("expected-live-check.json");
      expect(childOptions?.env).not.toHaveProperty("DUEGOOD_TEST_PRIVATE_CANARY");
      expect(JSON.stringify(childOptions)).not.toContain(sourceCanary);
      expect(JSON.stringify(childOptions)).not.toContain("synthetic-source-token-timeline");
      expect(JSON.stringify(childOptions?.args)).not.toContain(expectedPath);
      expect(JSON.stringify(receipt)).not.toContain(sourceCanary);
      for (const root of roots) await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousCanary === undefined) delete process.env.DUEGOOD_TEST_PRIVATE_CANARY;
      else process.env.DUEGOOD_TEST_PRIVATE_CANARY = previousCanary;
    }
  });

  it("rejects a non-owned or ambiguous running identity before xcodebuild", async () => {
    const parent = await temporaryDirectory();
    const expectedPath = await expectedFile(parent);
    const roots: string[] = [];
    const runXcode = vi.fn();
    const receipt = await runLiveVerification({
      expectedFilePath: expectedPath,
      platform: "darwin",
      fileExists: () => true,
      queryApplications: async () => [appIdentity, { ...appIdentity, pid: 4712 }],
      scratchFactory: ownedScratchRoots(parent, roots),
      runXcode,
    });
    expect(receipt.failureCode).toBe("installed_app_identity_invalid");
    expect(runXcode).not.toHaveBeenCalled();
    for (const root of roots) await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports missing host tools as a fixed code and never creates scratch", async () => {
    const parent = await temporaryDirectory();
    const expectedPath = await expectedFile(parent);
    const roots: string[] = [];
    const receipt = await runLiveVerification({
      expectedFilePath: expectedPath,
      platform: "darwin",
      fileExists: (filePath) => filePath !== "/usr/bin/xcodebuild",
      scratchFactory: ownedScratchRoots(parent, roots),
    });
    expect(receipt.failureCode).toBe("native_tool_unavailable");
    expect(roots).toEqual([]);
  });

  it("records partial refresh distinctly even when page tokens are present", async () => {
    const parent = await temporaryDirectory();
    const expectedPath = await expectedFile(parent);
    const roots: string[] = [];
    const receipt = await runLiveVerification({
      expectedFilePath: expectedPath,
      platform: "darwin",
      fileExists: () => true,
      queryApplications: async () => [appIdentity],
      scratchFactory: ownedScratchRoots(parent, roots),
      runXcode: async (_command, _args, options) => {
        await writeFile(options.logPath, xcodeMarkers("partial"), { mode: 0o600 });
        await chmod(options.logPath, 0o600);
        return { code: 0, signal: null, timedOut: false, overflow: false };
      },
    });
    expect(receipt.status).toBe("partial");
    expect(receipt.failureCode).toBe("full_refresh_partial");
    expect(receipt.refreshOutcome).toBe("partial");
    for (const root of roots) await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["failed", "missing"] as const)("fails a partial refresh when a page receipt is %s", async (pageIssue) => {
    const parent = await temporaryDirectory();
    const expectedPath = await expectedFile(parent);
    const roots: string[] = [];
    const markers = xcodeMarkers("partial");
    const invalidPageMarkers = pageIssue === "failed"
      ? markers.replace("DUEGOOD_LIVE_PAGE id=activity ok=true matched=1", "DUEGOOD_LIVE_PAGE id=activity ok=false matched=0")
      : markers.split("\n").filter((line) => !line.includes("DUEGOOD_LIVE_PAGE id=activity ")).join("\n");
    const receipt = await runLiveVerification({
      expectedFilePath: expectedPath,
      platform: "darwin",
      fileExists: () => true,
      queryApplications: async () => [appIdentity],
      scratchFactory: ownedScratchRoots(parent, roots),
      runXcode: async (_command, _args, options) => {
        await writeFile(options.logPath, invalidPageMarkers, { mode: 0o600 });
        await chmod(options.logPath, 0o600);
        return { code: 0, signal: null, timedOut: false, overflow: false };
      },
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.failureCode).toBe("page_content_check_failed");
    expect(receipt.refreshOutcome).toBe("partial");
    for (const root of roots) await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans temporary copies and raw logs after timeout and hostile child output", async () => {
    const parent = await temporaryDirectory();
    const expectedPath = await expectedFile(parent);
    const roots: string[] = [];
    const privateCanary = "synthetic-raw-xcode-output";
    const receipt = await runLiveVerification({
      expectedFilePath: expectedPath,
      platform: "darwin",
      fileExists: () => true,
      queryApplications: async () => [appIdentity],
      scratchFactory: ownedScratchRoots(parent, roots),
      runXcode: async (_command, _args, options) => {
        await writeFile(options.logPath, privateCanary, { mode: 0o600 });
        await chmod(options.logPath, 0o600);
        return { code: null, signal: "SIGTERM", timedOut: true, overflow: false };
      },
    });
    expect(receipt.failureCode).toBe("xcodebuild_timed_out");
    expect(JSON.stringify(receipt)).not.toContain(privateCanary);
    for (const root of roots) await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("stops a timed-out child group after logging privately", async () => {
    const parent = await temporaryDirectory();
    const scratch = createOwnedScratchRoot("live-process-test", { baseDirectory: parent });
    const logPath = path.join(scratch.root, "private.log");
    const privateCanary = "synthetic-child-output-canary";
    const progress: string[] = [];
    scratch.setActive(true);
    const result = await runBoundedProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(privateCanary)}); setInterval(() => {}, 1000);`], {
      cwd: parent,
      env: { PATH: process.env.PATH ?? "" },
      logPath,
      timeoutMs: 2_000,
      progress: (message) => progress.push(message),
    });
    scratch.setActive(false);
    expect(result.timedOut).toBe(true);
    expect(await readFile(logPath, "utf8")).toContain(privateCanary);
    expect(progress).toEqual(["Native UI verification exceeded its bounded runtime; stopping the test process group."]);
    expect(await readdir(scratch.root)).toEqual(["private.log"]);
    scratch.cleanup();
  }, 15_000);
});

describe("content-free Xcode marker parsing", () => {
  it("extracts fixed statuses and counts without retaining raw lines", () => {
    const privateCanary = "synthetic-private-title-never-return-this";
    const parsed = parseXcodeMarkers(`${xcodeMarkers()}\n${privateCanary}`);
    expect(parsed.refreshOutcome).toBe("complete");
    expect(parsed.pages.map((page) => page.id)).toEqual(registeredPages);
    expect(JSON.stringify(parsed)).not.toContain(privateCanary);
  });
});
