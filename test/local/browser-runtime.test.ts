import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BROWSER_RUNTIME_ENTRYPOINT,
  BUNDLED_NODE_VERSION,
  STANDALONE_NODE_PROVENANCE,
  verifyBrowserRuntimeTree,
} from "../../scripts/prepare-browser-runtime.mjs";
import { runCanvasAppRefresh } from "../../scripts/canvas-browser-app-refresh.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME = path.join(ROOT, "dist", "browser-runtime");

describe.sequential("packaged browser runtime", () => {
  it("loads the full capture and PDF runtime outside the checkout with an empty environment", async () => {
    const isolatedRoot = await mkdtemp(path.join(tmpdir(), "duegood-browser-runtime-isolated-"));
    try {
      expect(path.relative(ROOT, isolatedRoot).startsWith(`..${path.sep}`)).toBe(true);
      const isolatedRuntime = path.join(isolatedRoot, "browser-runtime");
      await cp(RUNTIME, isolatedRuntime, { recursive: true, verbatimSymlinks: true });
      await cp(path.join(ROOT, "test", "fixtures", "synthetic-grade-report.pdf"), path.join(isolatedRoot, "synthetic-grade-report.pdf"));

      const manifest = await verifyBrowserRuntimeTree(isolatedRuntime);
      expect(manifest.nodeSource).toStrictEqual(STANDALONE_NODE_PROVENANCE);
      expect(manifest.nodeVersion).toBe(BUNDLED_NODE_VERSION);
      expect(manifest.entrypoint).toBe(BROWSER_RUNTIME_ENTRYPOINT);
      expect(manifest.files.some((file: { path: string }) => file.path === "node-license.txt")).toBe(true);
      const packagedScripts = manifest.files.filter((file: { path: string }) => file.path.startsWith("scripts/"));
      const testRunnerImports = await Promise.all(packagedScripts.map(async (file: { path: string }) => {
        const contents = await readFile(path.join(isolatedRuntime, file.path), "utf8");
        return contents.includes("@playwright/test") ? file.path : undefined;
      }));
      expect(testRunnerImports.filter(Boolean)).toEqual([]);
      for (const script of ["canvas-browser-session.mjs", "canvas-browser-probe.mjs"]) {
        await expect(readFile(path.join(isolatedRuntime, "scripts", script), "utf8"))
          .resolves.toContain('from "playwright-core"');
      }

      const node = path.join(isolatedRuntime, "node");
      const version = spawnSync(node, ["--version"], { cwd: isolatedRoot, env: {}, encoding: "utf8" });
      expect(version.error).toBeUndefined();
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe(`v${BUNDLED_NODE_VERSION}`);

      const isolatedLoad = String.raw`
        import path from "node:path";
        import { readFile } from "node:fs/promises";
        import { pathToFileURL } from "node:url";
        const runtime = path.join(process.cwd(), "browser-runtime");
        const moduleUrl = (relative) => pathToFileURL(path.join(runtime, relative)).href;
        await import(moduleUrl("scripts/canvas-browser-app-refresh.mjs"));
        const loader = await import(moduleUrl("scripts/canvas-browser-runtime-loader.mjs"));
        if (typeof await loader.loadCurrentCanvasCapture() !== "function") throw new Error("CAPTURE_MODULE_REJECTED");
        const pdfjs = await import(moduleUrl("node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
        const extract = loader.createPdfTextExtractor({ pdfjs });
        const pages = await extract(await readFile(path.join(process.cwd(), "synthetic-grade-report.pdf")));
        if (!Array.isArray(pages) || !pages.some((page) => page.includes("SYN-101"))) throw new Error("PDF_MODULE_REJECTED");
        process.stdout.write("isolated-runtime-ok\n");
      `;
      const imported = spawnSync(node, ["--input-type=module", "-e", isolatedLoad], {
        cwd: isolatedRoot,
        env: {},
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(imported.error).toBeUndefined();
      expect(imported.status).toBe(0);
      expect(imported.stdout).toBe("isolated-runtime-ok\n");
      expect(imported.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(imported.stderr).not.toContain("playwright/test");
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects modified payload bytes", async () => {
    const manifest = await verifyBrowserRuntimeTree(RUNTIME);
    const target = path.join(RUNTIME, BROWSER_RUNTIME_ENTRYPOINT);
    const original = await readFile(target);
    try {
      await writeFile(target, Buffer.concat([original, Buffer.from("\n") ]));
      await expect(verifyBrowserRuntimeTree(RUNTIME)).rejects.toThrow(/does not match its manifest/u);
    } finally {
      await writeFile(target, original, { mode: 0o644 });
    }
    await expect(verifyBrowserRuntimeTree(RUNTIME)).resolves.toStrictEqual(manifest);
  }, 30_000);

  it("emits only allowlisted progress and sanitized import counts", async () => {
    const output: string[] = [];
    const privateSentinel = "/private/capture/snapshot.json";
    const result = await runCanvasAppRefresh({
      heartbeatMs: 60_000,
      writeLine: (line) => { output.push(line); return true; },
      runClient: async (options = {}) => {
        process.stderr.write("CANVAS_CAPTURE_PROGRESS=CAPTURE_RUNNING\n");
        process.stderr.write(`CANVAS_CAPTURE_PROGRESS=PRIVATE_${privateSentinel}\n`);
        options.reportImportProgress?.("raw account or course data");
        return {
          status: "PARTIAL",
          resourceCount: 9,
          itemCount: 4,
          gapCount: 0,
          fileBodiesIncomplete: true,
          snapshotPath: privateSentinel,
          courseName: "private course name",
          nativeImport: {
            status: "IMPORTED",
            importedCourses: 2,
            archivedCourses: 1,
            promotedBlobs: 3,
            reusedBlobs: 4,
            bytesVerified: 128,
            alreadyCurrent: false,
            snapshotPath: privateSentinel,
          },
        };
      },
    });

    const frames = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(frames).toEqual([
      { type: "progress", phase: "broker-starting" },
      { type: "progress", phase: "capturing" },
      { type: "progress", phase: "importing" },
      {
        type: "result",
        status: "incomplete",
        resourceCount: 9,
        itemCount: 4,
        gapCount: 0,
        importedCourses: 2,
        archivedCourses: 1,
        promotedBlobs: 3,
        reusedBlobs: 4,
        bytesVerified: 128,
        alreadyCurrent: false,
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain(privateSentinel);
    expect(JSON.stringify(frames)).not.toContain("private course name");
    expect(result).toStrictEqual(frames.at(-1));
  });

  it("fails closed when capture data is incomplete", async () => {
    const output: string[] = [];
    const result = await runCanvasAppRefresh({
      heartbeatMs: 60_000,
      writeLine: (line) => { output.push(line); return true; },
      runClient: async () => ({
        status: "PARTIAL",
        resourceCount: 3,
        itemCount: 1,
        gapCount: 2,
        snapshotPath: "/private/snapshot.json",
      }),
    });
    expect(result.status).toBe("incomplete");
    expect(result.errorCode).toBe("CAPTURE_GAPS");
    expect(output.join("\n")).not.toContain("snapshot.json");

    const malformed = await runCanvasAppRefresh({
      heartbeatMs: 60_000,
      writeLine: (line) => { output.push(line); return true; },
      runClient: async () => ({
        status: "PARTIAL",
        resourceCount: 3,
        itemCount: 1,
        gapCount: 0,
        nativeImport: {
          status: "IMPORTED",
          importedCourses: 1,
          archivedCourses: 0,
          promotedBlobs: 0,
          reusedBlobs: 0,
          bytesVerified: 0,
          alreadyCurrent: false,
        },
      }),
    });
    expect(malformed.status).toBe("incomplete");
    expect(malformed.errorCode).toBe("BROWSER_REFRESH_FAILED");
  });
});
