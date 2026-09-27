import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile, mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runStreaming, withSmokeTempRoot } from "../../scripts/smoke-tauri-macos.mjs";
import { createOwnedScratchRoot } from "../../scripts/owned-scratch-root.mjs";

const temporaryDirectories: string[] = [];
const smokeModuleUrl = pathToFileURL(path.resolve("scripts/smoke-tauri-macos.mjs")).href;

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duegood-smoke-lifecycle-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("macOS smoke temp-root lifecycle", () => {
  it("creates a private temp root and refuses to remove it while active", async () => {
    const scratch = createOwnedScratchRoot("lifecycle-test");
    expect(path.dirname(scratch.root)).toBe(await realpath(os.tmpdir()));
    expect((await stat(scratch.root)).mode & 0o777).toBe(0o700);
    scratch.setActive(true);
    expect(() => scratch.cleanup()).toThrow("Refusing to remove an active scratch root.");
    await expect(access(scratch.root)).resolves.toBeUndefined();
    scratch.setActive(false);
    scratch.cleanup();
    await expect(access(scratch.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("owns a scratch root under a verified private project parent", async () => {
    const parent = await realpath(await makeTemporaryDirectory());
    const scratch = createOwnedScratchRoot("project-fixture", { baseDirectory: parent });
    expect(path.dirname(scratch.root)).toBe(parent);
    expect((await stat(scratch.root)).mode & 0o777).toBe(0o700);
    scratch.cleanup();
    await expect(readdir(parent)).resolves.toEqual([]);
  });

  it("copies failed xcresult and log evidence into private project logs before removing scratch", async () => {
    const projectRoot = await makeTemporaryDirectory();
    let tempRoot = "";
    await expect(withSmokeTempRoot(async (root: string) => {
      tempRoot = root;
      const resultBundle = path.join(root, "DueGoodDesktopUITests.xcresult");
      await mkdir(resultBundle);
      await writeFile(path.join(resultBundle, "result.txt"), "synthetic result evidence");
      await writeFile(path.join(root, "xcodebuild.log"), "synthetic private build log");
      throw new Error("synthetic smoke failure");
    }, { projectRoot })).rejects.toThrow("synthetic smoke failure");
    const logsRoot = path.join(projectRoot, ".logs");
    const evidenceRoots = await readdir(logsRoot);
    expect(evidenceRoots).toHaveLength(1);
    const evidenceRoot = path.join(logsRoot, evidenceRoots[0] ?? "");
    expect((await stat(logsRoot)).mode & 0o777).toBe(0o700);
    expect((await readdir(evidenceRoot)).sort()).toEqual(["DueGoodDesktopUITests.xcresult", "xcodebuild.log"]);
    expect(await readFile(path.join(evidenceRoot, "DueGoodDesktopUITests.xcresult", "result.txt"), "utf8")).toBe("synthetic result evidence");
    expect(await readFile(path.join(evidenceRoot, "xcodebuild.log"), "utf8")).toBe("synthetic private build log");
    await expect(access(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(tempRoot).toContain("duegood-tauri-ui-smoke-");
  });

  it("preserves its scratch root when cleanup cannot establish inactivity", async () => {
    let scratchRoot = "";
    let scratchHandle: ReturnType<typeof createOwnedScratchRoot> | undefined;
    const projectRoot = await makeTemporaryDirectory();
    await expect(withSmokeTempRoot(async (root: string, scratch: ReturnType<typeof createOwnedScratchRoot>) => {
      scratchRoot = root;
      scratchHandle = scratch;
      scratch.setActive(true);
      throw new Error("synthetic active app failure");
    }, { projectRoot })).rejects.toThrow("synthetic active app failure");
    await expect(access(scratchRoot)).resolves.toBeUndefined();
    expect(scratchHandle?.isActive()).toBe(true);
    scratchHandle?.setActive(false);
    scratchHandle?.cleanup();
  });

  it("stops descendants in the xcodebuild process group before releasing scratch", async () => {
    const scratch = createOwnedScratchRoot("group-lifecycle-test");
    const markerPath = path.join(scratch.root, "descendant-survived");
    const source = `
      import { spawn } from "node:child_process";
      const marker = ${JSON.stringify(markerPath)};
      spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'alive'), 500)", marker], { stdio: "ignore" });
      process.stdout.write("leader complete");
      setTimeout(() => process.exit(0), 50);
    `;
    let groupStopped = false;
    scratch.setActive(true);
    await runStreaming(process.execPath, ["--input-type=module", "-e", source], {
      timeoutMs: 5_000,
      logPath: path.join(scratch.root, "xcodebuild.log"),
      onProcessGroupStopped: () => {
        groupStopped = true;
        scratch.setActive(false);
      },
    });
    expect(groupStopped).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    scratch.cleanup();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("removes its temp root after %s interrupts a running command", async (signal) => {
    const tempDirectory = await makeTemporaryDirectory();
    const source = `
      import { installSignalHandlers, runCapture, withSmokeTempRoot } from ${JSON.stringify(smokeModuleUrl)};
      installSignalHandlers();
      await withSmokeTempRoot(async () => {});
      try {
        await withSmokeTempRoot(async () => {
          const child = runCapture(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 60000 });
          setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 150);
          await child;
        });
      } catch {}
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: tempDirectory },
      timeout: 8_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(signal === "SIGINT" ? 130 : 143);
    expect(await readdir(tempDirectory)).toEqual([]);
  });

  it("finishes removal and reports SIGTERM received during cleanup", async () => {
    const tempDirectory = await makeTemporaryDirectory();
    const source = `
      import { installSignalHandlers, withSmokeTempRoot } from ${JSON.stringify(smokeModuleUrl)};
      installSignalHandlers();
      await withSmokeTempRoot(async () => {}, {
        cleanup: async () => {
          process.kill(process.pid, "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
      });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: tempDirectory },
      timeout: 8_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(143);
    expect(await readdir(tempDirectory)).toEqual([]);
  });
});
