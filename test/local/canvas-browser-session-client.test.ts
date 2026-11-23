import { describe, expect, it, vi } from "vitest";
import { runCanvasBrowserRefresh, sanitizeFrame } from "../../scripts/canvas-browser-session-client.mjs";

const captureFrame = {
  status: "PARTIAL",
  resourceCount: 12,
  itemCount: 8,
  gapCount: 2,
  dailyGapCount: 1,
  omissionCount: 2,
  bodyCount: 5, emptyBodyCount: 1, bodyFailureReason: null, rubricCount: 4,
  linkedFileCount: 3,
  fileBodiesIncomplete: true,
};
const completeCaptureFrame = {
  ...captureFrame,
  status: "COMPLETE",
  gapCount: 0,
  dailyGapCount: 0,
  fileBodiesIncomplete: false,
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
  alreadyCurrent: false, exportStatus: "complete", exportWritten: 2, exportUnchanged: 1, exportSkippedOwnerFiles: 0,
} as const;

describe("Canvas refresh client orchestration", () => {
  it("returns stale helper provenance before invoking the capture state helper", async () => {
    const stateCommand = vi.fn(async () => ({ runId: 9 }));
    const verifyHelpers = vi.fn(async () => {
      throw Object.assign(new Error("private helper details"), { code: "HELPER_STALE" });
    });

    await expect(runCanvasBrowserRefresh({ stateCommand, verifyHelpers }))
      .resolves.toEqual({ status: "REQUEST_FAILED", errorCode: "HELPER_STALE" });
    expect(verifyHelpers).toHaveBeenCalledTimes(1);
    expect(stateCommand).not.toHaveBeenCalled();
    expect(sanitizeFrame({ status: "REQUEST_FAILED", errorCode: "HELPER_STALE" }, "capture"))
      .toEqual({ status: "REQUEST_FAILED", errorCode: "HELPER_STALE" });
  });

  it.each([
    [completeCaptureFrame, "COMPLETE"],
    [captureFrame, "PARTIAL"],
  ])("sanitizes exact %s capture frames", (frame, status) => {
    expect(sanitizeFrame(frame, "capture")).toMatchObject({ status });
    expect(() => sanitizeFrame({ status }, "capture")).toThrow("INVALID_RESPONSE");
    expect(() => sanitizeFrame({ ...frame, privateData: "discard" }, "capture")).toThrow("INVALID_RESPONSE");
    expect(() => sanitizeFrame({ ...frame, bodyCount: 5, emptyBodyCount: 1, bodyFailureReason: null, rubricCount: 100_001 }, "capture")).toThrow("INVALID_RESPONSE");
    expect(() => sanitizeFrame({ ...frame, linkedFileCount: -1 }, "capture")).toThrow("INVALID_RESPONSE");
    expect(() => sanitizeFrame({ ...frame, bodyCount: 100_001 }, "capture")).toThrow("INVALID_RESPONSE");
    expect(() => sanitizeFrame({ ...frame, emptyBodyCount: frame.bodyCount + 1 }, "capture")).toThrow("INVALID_RESPONSE");
    expect(() => sanitizeFrame({ ...frame, bodyFailureReason: "PRIVATE_CONTENT" }, "capture")).toThrow("INVALID_RESPONSE");
    if (status === "COMPLETE") {
      expect(() => sanitizeFrame({ ...frame, gapCount: 1 }, "capture")).toThrow("INVALID_RESPONSE");
      expect(() => sanitizeFrame({ ...frame, fileBodiesIncomplete: true }, "capture")).toThrow("INVALID_RESPONSE");
    }
  });

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
        alreadyCurrent: false, exportStatus: "complete", exportWritten: 2, exportUnchanged: 1, exportSkippedOwnerFiles: 0,
      },
    });
    expect(result).not.toHaveProperty("nativeImport.runId");
    expect(progress).toHaveBeenCalledWith("CANVAS_IMPORT_COPYING");
  });

  it("accepts a complete capture while preserving its omission count", async () => {
    const result = await runCanvasBrowserRefresh({
      stateCommand: async (verb, runId) => ({ runId: runId ?? 52 }),
      start: async () => ({ status: "READY" }),
      readBinding: async () => 41,
      capture: async () => completeCaptureFrame,
      nativeImport: async () => importFrame,
    });

    expect(result).toMatchObject({
      ...completeCaptureFrame,
      nativeImport: { status: "IMPORTED" },
    });
  });

  it("rejects a complete capture frame with failures or extra fields", async () => {
    const result = await runCanvasBrowserRefresh({
      stateCommand: async (verb, runId) => ({ runId: runId ?? 52 }),
      start: async () => ({ status: "READY" }),
      readBinding: async () => 41,
      capture: async () => ({ ...completeCaptureFrame, dailyGapCount: 1, privateData: "discard" }),
      nativeImport: async () => importFrame,
    });

    expect(result).toEqual({ status: "REQUEST_FAILED", errorCode: "INVALID_RESPONSE" });
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

const signInReasons = [
  "CREDENTIALS_UNAVAILABLE", "SIGN_IN_BLOCKED", "VERIFICATION_REQUIRED", "SURVEY_POPUP_BLOCKING",
  "UNKNOWN_PAGE", "SIGN_IN_TIMEOUT", "SIGN_IN_REQUIRED",
];

function recoveryFixture(errorCode: string, headless = true) {
  const failure = { status: "REQUEST_FAILED", errorCode };
  const start = vi.fn(async (options: { headless: boolean }) => ({
    status: "READY", headless: options.headless && headless, pid: options.headless ? 101 : 102,
  }));
  const stop = vi.fn(async () => ({ status: "STOPPED" }));
  const capture = vi.fn(async (): Promise<typeof failure | typeof captureFrame> => failure);
  const reportSignInWindow = vi.fn();
  const nativeImport = vi.fn(async () => importFrame);
  const stateCommand = vi.fn(async () => ({ runId: 9 }));
  return { start, stop, capture, reportSignInWindow, nativeImport, stateCommand, readBinding: async () => 41 };
}

describe("attended capture recovery", () => {
  it.each(signInReasons)("retries %s exactly once, then closes the temporary window", async (reason) => {
    const fx = recoveryFixture(reason);
    await expect(runCanvasBrowserRefresh(fx)).resolves.toEqual({ status: "REQUEST_FAILED", errorCode: reason });
    expect(fx.start.mock.calls).toEqual([[{ headless: true }], [{ headless: false }]]);
    expect(fx.reportSignInWindow.mock.calls).toEqual([[reason]]);
    expect(fx.capture.mock.calls).toEqual([[41], [41]]);
    expect(fx.stop.mock.calls).toEqual([[101], [102]]);
    expect(fx.nativeImport).not.toHaveBeenCalled();
  });

  it.each(["IDENTITY_MISMATCH", "BINDING_REQUIRED", "CAPTURE_STATE_UNAVAILABLE", "REQUEST_FAILED",
    "CAPTURE_COVERAGE_INCOMPLETE", "CAPTURE_BUDGET_EXCEEDED", "HELPER_UNAVAILABLE", "OKTA_HOST_REJECTED", "UNRECOGNIZED"])(
    "preserves %s without opening a window", async (reason) => {
      const fx = recoveryFixture(reason);
      await expect(runCanvasBrowserRefresh(fx)).resolves.toEqual({ status: "REQUEST_FAILED", errorCode: reason });
      expect(fx.stop).not.toHaveBeenCalled();
      expect(fx.reportSignInWindow).not.toHaveBeenCalled();
    },
  );

  it("leaves an owner-started visible session open", async () => {
    const fx = recoveryFixture("SIGN_IN_TIMEOUT", false);
    await runCanvasBrowserRefresh(fx);
    expect(fx.capture).toHaveBeenCalledTimes(1);
    expect(fx.stop).not.toHaveBeenCalled();
    expect(fx.reportSignInWindow).not.toHaveBeenCalled();
  });

  it("preserves a headed session the owner started during the switch", async () => {
    const fx = recoveryFixture("SIGN_IN_REQUIRED");
    fx.capture.mockResolvedValueOnce({ status: "REQUEST_FAILED", errorCode: "SIGN_IN_REQUIRED" })
      .mockResolvedValueOnce(captureFrame);
    const start = vi.fn(async ({ headless }: { headless: boolean }) => ({
      status: "READY", headless, pid: headless ? 101 : 201, reused: true,
    }));
    await expect(runCanvasBrowserRefresh({ ...fx, start })).resolves.toMatchObject({ nativeImport: { status: "IMPORTED" } });
    expect(fx.stop.mock.calls).toEqual([[101]]);
  });

  it("imports after recovery and starts the next refresh headless", async () => {
    const fx = recoveryFixture("SIGN_IN_REQUIRED");
    fx.capture.mockResolvedValueOnce({ status: "REQUEST_FAILED", errorCode: "SIGN_IN_REQUIRED" })
      .mockResolvedValue(captureFrame);
    await expect(runCanvasBrowserRefresh(fx)).resolves.toMatchObject({ nativeImport: { status: "IMPORTED" } });
    await runCanvasBrowserRefresh(fx);
    expect(fx.start.mock.calls).toEqual([[{ headless: true }], [{ headless: false }], [{ headless: true }]]);
    expect(fx.stop.mock.calls).toEqual([[101], [102]]);
    expect(fx.reportSignInWindow).toHaveBeenCalledTimes(1);
  });

  it("does not launch Chrome when the headless session cannot stop", async () => {
    const fx = recoveryFixture("SIGN_IN_REQUIRED");
    fx.stop.mockResolvedValue({ status: "STOP_FAILED" });
    await expect(runCanvasBrowserRefresh(fx)).resolves.toEqual({ status: "STOP_FAILED" });
    expect(fx.start).toHaveBeenCalledTimes(1);
    expect(fx.capture).toHaveBeenCalledTimes(1);
    expect(fx.reportSignInWindow).not.toHaveBeenCalled();
  });
});
