import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CourseworkStore } from "../../src/local/coursework-store";
import { superviseRefresh } from "../../src/local/refresh-supervisor";

describe("refresh supervisor", () => {
  it("runs a fixed noninteractive child and reports bounded progress", async () => {
    const progress: number[] = [];
    const result = await superviseRefresh(process.cwd(), {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('synthetic progress')"],
    }, 2_000, (bytes) => progress.push(bytes));
    expect(result.capturedBytes).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(0);
  });

  it("reports a failed child without returning its output", async () => {
    await expect(superviseRefresh(process.cwd(), {
      executable: process.execPath,
      args: ["-e", "process.stderr.write('synthetic failure');process.exit(7)"],
    }, 2_000)).rejects.toThrow("refresh exited 7");
  });

  it("terminates a child process group at the deadline", async () => {
    await expect(superviseRefresh(process.cwd(), {
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
    }, 50)).rejects.toThrow(/refresh stopped by SIGTERM|refresh stopped by SIGKILL/);
  });

  it("serializes refresh child execution with local mutations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "duegood-refresh-"));
    try {
      const file = path.join(directory, "contract.json");
      await writeFile(file, await readFile(path.resolve("fixtures/local-coursework-contract.json")));
      const store = new CourseworkStore(file);
      const before = await store.read();
      let refreshFinishedAt = 0;
      const refresh = superviseRefresh(process.cwd(), {
        executable: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('done'), 120)"],
      }, 2_000, undefined, async (runChild) => store.withExclusive(async () => {
        const result = await runChild();
        refreshFinishedAt = Date.now();
        return result;
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      let mutationFinishedAt = 0;
      const mutation = store.setCompletion("course-a-canvas-910002", true, before.version).then((result) => {
        mutationFinishedAt = Date.now();
        return result;
      });
      await Promise.all([refresh, mutation]);
      expect(mutationFinishedAt).toBeGreaterThanOrEqual(refreshFinishedAt);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
