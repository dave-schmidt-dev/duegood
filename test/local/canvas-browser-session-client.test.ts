import { describe, expect, it, vi } from "vitest";
import { runCanvasBrowserRefresh } from "../../scripts/canvas-browser-session-client.mjs";

const captureFrame = {
  status: "PARTIAL",
  resourceCount: 12,
  itemCount: 8,
  gapCount: 2,
  fileBodiesIncomplete: true,
};

const importFrame = {
  type: "result",
  status: "complete",
  runId: 73,
  importedCourses: 3,
  archivedCourses: 1,
  promotedBlobs: 4,
  reusedBlobs: 2,
  bytesVerified: 1200,
  alreadyCurrent: false,
};

describe("Canvas refresh client orchestration", () => {
  it("captures under the bound account, then imports after capture while retaining PARTIAL", async () => {
    const calls: string[] = [];
    const progress = vi.fn();
    const stateCommand = async (verb: "begin" | "fail", runId?: number) => {
      calls.push(`${verb}:${runId ?? ""}`);
      return { runId: runId ?? 52 };
    };
    const result = await runCanvasBrowserRefresh({
      stateCommand,
      start: async () => { calls.push("start"); return { status: "READY" }; },
      readBinding: async () => { calls.push("binding"); return 41; },
      capture: async (userId) => {
        calls.push(`capture:${userId}`);
        return captureFrame;
      },
      nativeImport: async ({ confirmedFirstUserId, progress: report }) => {
        calls.push(`import:${confirmedFirstUserId}`);
        report("CANVAS_IMPORT_COPYING");
        return importFrame;
      },
      reportImportProgress: progress,
    });

    expect(calls).toEqual(["begin:", "start", "binding", "capture:41", "import:41"]);
    expect(result).toMatchObject({
      ...captureFrame,
      status: "PARTIAL",
      nativeImport: {
        status: "IMPORTED",
        importedCourses: 3,
        archivedCourses: 1,
        promotedBlobs: 4,
        reusedBlobs: 2,
        bytesVerified: 1200,
        alreadyCurrent: false,
      },
    });
    expect(result).not.toHaveProperty("nativeImport.runId");
    expect(progress).toHaveBeenCalledWith("CANVAS_IMPORT_COPYING");
  });

  it("marks a pre-capture failure failed and never starts capture or import", async () => {
    const stateCommand = vi.fn(async (verb: "begin" | "fail", runId?: number) => ({
      runId: verb === "begin" ? 8 : runId ?? 0,
    }));
    const capture = vi.fn(async () => captureFrame);
    const nativeImport = vi.fn(async () => importFrame);

    await expect(runCanvasBrowserRefresh({
      stateCommand,
      start: async () => ({ status: "START_FAILED" }),
      capture,
      nativeImport,
    })).resolves.toEqual({ status: "START_FAILED" });

    expect(stateCommand.mock.calls).toEqual([["begin"], ["fail", 8]]);
    expect(capture).not.toHaveBeenCalled();
    expect(nativeImport).not.toHaveBeenCalled();
  });

  it("keeps capture failure visible and does not run native import", async () => {
    const nativeImport = vi.fn(async () => importFrame);
    const result = await runCanvasBrowserRefresh({
      stateCommand: async (verb, runId) => ({ runId: runId ?? 9 }),
      start: async () => ({ status: "READY" }),
      readBinding: async () => 41,
      capture: async () => ({ status: "REQUEST_FAILED", errorCode: "CANVAS_SESSION_UNAVAILABLE" }),
      nativeImport,
    });

    expect(result).toEqual({ status: "REQUEST_FAILED", errorCode: "CANVAS_SESSION_UNAVAILABLE" });
    expect(nativeImport).not.toHaveBeenCalled();
  });

  it("retains the successful partial capture when native import fails with a fixed code", async () => {
    const result = await runCanvasBrowserRefresh({
      stateCommand: async (verb, runId) => ({ runId: runId ?? 9 }),
      start: async () => ({ status: "READY" }),
      readBinding: async () => 41,
      capture: async () => captureFrame,
      nativeImport: async () => {
        throw Object.assign(new Error("private diagnostic"), { code: "NATIVE_IMPORT_BUSY" });
      },
    });

    expect(result).toMatchObject({
      status: "PARTIAL",
      nativeImport: { status: "FAILED", errorCode: "NATIVE_IMPORT_BUSY" },
    });
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  });
});
