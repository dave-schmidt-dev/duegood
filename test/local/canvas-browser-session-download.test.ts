import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCanvasCapture } from "../../scripts/canvas-browser-session.mjs";
import { withCanvasRunLease } from "../../scripts/canvas-browser-run-lease.mjs";
import { collectCanvasBrowserCapture } from "../../scripts/canvas-browser-capture.mjs";

const directories: string[] = [];
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "duegood-session-download-test-"));
  directories.push(root);
  await chmod(root, 0o700);
  return root;
}
const syntheticLease: typeof withCanvasRunLease = async (options = {} as NonNullable<Parameters<typeof withCanvasRunLease>[0]>) => {
  const { run } = options;
  const outcome = await run(17);
  if (outcome.terminal?.status !== "captured") throw new Error("synthetic lease did not complete");
  return outcome.value;
}
async function writeStateHelper(appDirectory: string) {
  const directoryPath = path.join(appDirectory, "bin");
  await mkdir(directoryPath, { mode: 0o700 });
  const helperPath = path.join(directoryPath, "duegood-capture-state");
  await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return helperPath;
}
afterEach(async () => Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function context() {
  const page = { url: vi.fn(() => "https://marymount.instructure.com/"), isClosed: vi.fn(() => false),
    // Synthetic authenticated profile response for capture tests that exercise downstream work.
    evaluate: vi.fn(async () => true),
    goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  return { page, browser: { pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) } };
}

describe("browser capture file staging lifecycle", () => {
  it("keeps raw URLs in callback memory, saves only an opaque receipt, and removes its temporary root", async () => {
    const appDirectory = await directory();
    const helperPath = path.join(appDirectory, "synthetic-helper");
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const stateHelperPath = await writeStateHelper(appDirectory);
    const { page, browser } = context();
    const sourceUrl = "https://marymount.instructure.com/files/41/download?download_frd=1";
    const basename = `${"a".repeat(32)}.blob`;
    let stagingDirectory = "";
    const browserFileDownload = vi.fn(async ({ stagingDirectory: stage }) => {
      stagingDirectory = stage;
      await writeFile(path.join(stage, basename), "synthetic", { mode: 0o600 });
      return { kind: "staged", fileId: 41, stagedFile: basename, byteCount: 9,
        sha256: "b".repeat(64), contentType: "application/pdf", sourceAuthenticity: "unverified" };
    });
    const collector = vi.fn(async ({ downloadFile, page: capturePage, runId, generationId }) => {
      expect(capturePage).toBe(page);
      expect(runId).toBe(17);
      const receipt = await downloadFile({ fileId: 41, sourceUrl, expectedSize: 9 });
      return { schemaVersion: 2 as const, source: "canvas-browser" as const, runId, generationId, capturedAt: "2026-09-27T12:00:00Z",
        activeCourses: { complete: true as const, courseIds: [] },
        coverageRequirements: { activeCoursesComplete: true as const,
          perActiveCourse: ["course", "assignments", "assignmentGroups", "submissions"] },
        identity: { origin: "https://marymount.instructure.com", userId: 7 }, complete: false as const,
        resources: [{ endpoint: "fileBodies", courseId: null, pages: 1, items: [receipt] }],
        coverage: [{ endpoint: "fileBodies", courseId: null, status: "gap" as const, reason: "not-attempted" }] };
    });
    const saveGeneration = vi.fn(async ({ snapshot, stagingDirectory: stage, generationId }) => {
      expect(JSON.stringify(snapshot)).not.toContain(sourceUrl);
      expect(await readFile(path.join(stage, basename), "utf8")).toBe("synthetic");
      return { generationId, snapshotSha256: "c".repeat(64), capturedAt: "2026-09-27T12:00:00Z", complete: false as const,
        resourceCount: 1, itemCount: 1, blobCount: 1, blobBytes: 9, archivedSnapshot: snapshot };
    });
    const progress = vi.fn();
    await runCanvasCapture({ context: browser, expectedUserId: 7, progress,
      appDirectory, helperPath, stateHelperPath, withRunLease: syntheticLease,
      collector: collector as unknown as typeof collectCanvasBrowserCapture, browserFileDownload, saveGeneration });
    expect(browserFileDownload).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl, fileId: 41, page }));
    expect(saveGeneration).toHaveBeenCalledTimes(1);
    expect(browser.newPage).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
    await expect(lstat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-"))).toEqual([]);
    expect(progress).toHaveBeenCalledWith("CAPTURE_DOWNLOADING");
  });

  it("fails the allocated run when the private download helper is absent", async () => {
    const appDirectory = await directory();
    const { browser } = context();
    const stateHelperPath = await writeStateHelper(appDirectory);
    const terminalRequests: unknown[] = [];
    const withRunLease = vi.fn(async (options = {} as Parameters<typeof withCanvasRunLease>[0]) => {
      const { run } = options;
      try {
        const outcome = await run(17);
        terminalRequests.push(outcome.terminal);
        return outcome.value;
      } catch (error) {
        terminalRequests.push({ status: "failed", runId: 17 });
        throw error;
      }
    });
    await expect(runCanvasCapture({ context: browser, expectedUserId: 7, progress: () => {},
      appDirectory, helperPath: path.join(appDirectory, "missing"), stateHelperPath, withRunLease }))
      .rejects.toThrow("HELPER_UNAVAILABLE");
    expect(withRunLease).toHaveBeenCalledTimes(1);
    expect(terminalRequests).toEqual([{ status: "failed", runId: 17 }]);
    expect(browser.newPage).not.toHaveBeenCalled();
  });

  it("fails closed when no existing authenticated Canvas page is available", async () => {
    const appDirectory = await directory();
    const helperPath = path.join(appDirectory, "synthetic-helper");
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const stateHelperPath = await writeStateHelper(appDirectory);
    const { browser } = context();
    browser.pages.mockReturnValue([]);
    const collector = vi.fn();
    await expect(runCanvasCapture({ context: browser, expectedUserId: 7, progress: () => {}, collector,
      appDirectory, helperPath, stateHelperPath, withRunLease: syntheticLease,
      sessionWaitTimeoutMs: 5, sessionPollIntervalMs: 1 })).rejects.toThrow("CANVAS_SESSION_UNAVAILABLE");
    expect(collector).not.toHaveBeenCalled();
    expect(browser.newPage).not.toHaveBeenCalled();
    expect((await readdir(appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-"))).toEqual([]);
  });

  it("keeps a failed live request diagnostic content-free while removing staged bytes", async () => {
    const appDirectory = await directory();
    const helperPath = path.join(appDirectory, "synthetic-helper");
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const stateHelperPath = await writeStateHelper(appDirectory);
    const { browser } = context();
    const collector = vi.fn(async ({ progress }) => {
      progress({ phase: "request-failed", endpoint: "courseTabs", privateBody: "must not persist" });
      throw new Error("REQUEST_FAILED");
    });
    await expect(runCanvasCapture({ context: browser, expectedUserId: 7, progress: () => {}, collector,
      appDirectory, helperPath, stateHelperPath, withRunLease: syntheticLease })).rejects.toThrow("REQUEST_FAILED");
    const diagnosticPath = path.join(appDirectory, "canvas-capture-last-error.json");
    expect(JSON.parse(await readFile(diagnosticPath, "utf8"))).toEqual({
      phase: "collecting", endpoint: "courseTabs", errorCode: "REQUEST_FAILED",
    });
    expect((await lstat(diagnosticPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-"))).toEqual([]);
  });
});
