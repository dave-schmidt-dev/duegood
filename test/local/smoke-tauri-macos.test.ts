import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withSmokeTempRoot } from "../../scripts/smoke-tauri-macos.mjs";

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
  it("removes its temp root when work throws", async () => {
    const parent = await makeTemporaryDirectory();
    let tempRoot = "";
    await expect(withSmokeTempRoot(async (root: string) => {
      tempRoot = root;
      throw new Error("synthetic smoke failure");
    }, {
      createTempRoot: () => mkdtempSync(path.join(parent, "duegood-tauri-ui-smoke-")),
    })).rejects.toThrow("synthetic smoke failure");
    expect(await readdir(parent)).toEqual([]);
    expect(tempRoot).toContain("duegood-tauri-ui-smoke-");
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
