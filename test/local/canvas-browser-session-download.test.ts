import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCanvasCapture } from "../../scripts/canvas-browser-session.mjs";

const directories: string[] = [];
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "duegood-session-download-test-"));
  directories.push(root);
  await chmod(root, 0o700);
  return root;
}
afterEach(async () => Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function context() {
  const page = { url: vi.fn(() => "https://marymount.instructure.com/"), isClosed: vi.fn(() => false),
    goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  return { page, browser: { pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) } };
}

describe("browser capture file staging lifecycle", () => {
  it("keeps raw URLs in callback memory, saves only an opaque receipt, and removes its temporary root", async () => {
    const appDirectory = await directory();
    const helperPath = path.join(appDirectory, "synthetic-helper");
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
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
    const collector = vi.fn(async ({ downloadFile, page: capturePage }) => {
      expect(capturePage).toBe(page);
      const receipt = await downloadFile({ fileId: 41, sourceUrl, expectedSize: 9 });
      return { schemaVersion: 1, source: "canvas-browser", capturedAt: "2026-09-27T12:00:00Z",
        identity: { origin: "https://marymount.instructure.com", userId: 7 }, complete: false as const,
        resources: [{ endpoint: "fileBodies", courseId: null, pages: 1, items: [receipt] }],
        coverage: [{ endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" }] };
    });
    const saveGeneration = vi.fn(async ({ snapshot, stagingDirectory: stage }) => {
      expect(JSON.stringify(snapshot)).not.toContain(sourceUrl);
      expect(await readFile(path.join(stage, basename), "utf8")).toBe("synthetic");
      return { generationId: "synthetic", capturedAt: "2026-09-27T12:00:00Z", complete: false as const,
        resourceCount: 1, itemCount: 1, blobCount: 1, blobBytes: 9, archivedSnapshot: snapshot };
    });
    const progress = vi.fn();
    await runCanvasCapture({ context: browser, expectedUserId: 7, progress, collector,
      appDirectory, helperPath, browserFileDownload, saveGeneration });
    expect(browserFileDownload).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl, fileId: 41, page }));
    expect(saveGeneration).toHaveBeenCalledTimes(1);
    expect(browser.newPage).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
    await expect(lstat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-"))).toEqual([]);
    expect(progress).toHaveBeenCalledWith("CAPTURE_DOWNLOADING");
  });

  it("refuses capture when the private native helper is absent", async () => {
    const appDirectory = await directory();
    const { browser } = context();
    await expect(runCanvasCapture({ context: browser, expectedUserId: 7, progress: () => {},
      appDirectory, helperPath: path.join(appDirectory, "missing") })).rejects.toThrow("HELPER_UNAVAILABLE");
    expect(browser.newPage).not.toHaveBeenCalled();
  });

  it("fails closed when no existing authenticated Canvas page is available", async () => {
    const appDirectory = await directory();
    const helperPath = path.join(appDirectory, "synthetic-helper");
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const { browser } = context();
    browser.pages.mockReturnValue([]);
    const collector = vi.fn();
    await expect(runCanvasCapture({ context: browser, expectedUserId: 7, progress: () => {}, collector,
      appDirectory, helperPath })).rejects.toThrow("CANVAS_SESSION_UNAVAILABLE");
    expect(collector).not.toHaveBeenCalled();
    expect(browser.newPage).not.toHaveBeenCalled();
    expect((await readdir(appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-"))).toEqual([]);
  });

  it("keeps a failed live request diagnostic content-free while removing staged bytes", async () => {
    const appDirectory = await directory();
    const helperPath = path.join(appDirectory, "synthetic-helper");
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const { browser } = context();
    const collector = vi.fn(async ({ progress }) => {
      progress({ phase: "request-failed", endpoint: "courseTabs", privateBody: "must not persist" });
      throw new Error("REQUEST_FAILED");
    });
    await expect(runCanvasCapture({ context: browser, expectedUserId: 7, progress: () => {}, collector,
      appDirectory, helperPath })).rejects.toThrow("REQUEST_FAILED");
    const diagnosticPath = path.join(appDirectory, "canvas-capture-last-error.json");
    expect(JSON.parse(await readFile(diagnosticPath, "utf8"))).toEqual({
      phase: "collecting", endpoint: "courseTabs", errorCode: "REQUEST_FAILED",
    });
    expect((await lstat(diagnosticPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-"))).toEqual([]);
  });
});
