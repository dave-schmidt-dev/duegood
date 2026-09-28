import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { withCanvasRunLease } from "../../scripts/canvas-browser-run-lease.mjs";

type Terminal = { status: string; runId: number; generationId: string; snapshotSha256: string; userId: number };

function fakeChild({ runId = 29, terminalStatus = "captured" } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stdin: Writable;
    exitCode: number | null;
    signalCode: string | null;
    kill: ReturnType<typeof vi.fn>;
    request?: Terminal | { status: string; runId: number };
  };
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  let input = "";
  child.stdin = new Writable({
    write(chunk, _encoding, callback) { input += chunk.toString(); callback(); },
    final(callback) {
      child.request = JSON.parse(input.trim()) as Terminal | { status: string; runId: number };
      queueMicrotask(() => {
        child.stdout.write(`run=${runId} status=${terminalStatus}\n`);
        child.stdout.end();
        child.exitCode = terminalStatus === "captured" ? 0 : 1;
        child.emit("close", child.exitCode, null);
      });
      callback();
    },
  });
  queueMicrotask(() => child.stdout.write(`lease run=${runId} status=running\n`));
  return child;
}

const receipt = (runId: number): Terminal => ({ status: "captured", runId,
  generationId: "a".repeat(32), snapshotSha256: "b".repeat(64), userId: 41 });

describe("native capture lease child protocol", () => {
  it("holds the helper process through collection and sends the exact terminal receipt", async () => {
    const child = fakeChild();
    const spawnChild = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const run = vi.fn(async (runId: number) => ({ terminal: receipt(runId), value: { saved: true } }));

    await expect(withCanvasRunLease({ helperPath: "/private/test/duegood-capture-state", spawnChild, run }))
      .resolves.toEqual({ saved: true });

    expect(spawnChild).toHaveBeenCalledWith("/private/test/duegood-capture-state", ["lease"],
      expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "inherit"] }));
    expect(run).toHaveBeenCalledWith(29);
    expect(child.request).toEqual(receipt(29));
  });

  it("sends explicit failed status when collection throws", async () => {
    const child = fakeChild({ terminalStatus: "failed" });
    const failure = new Error("synthetic collection failure");
    await expect(withCanvasRunLease({ helperPath: "/private/test/duegood-capture-state",
      spawnChild: () => child as unknown as ChildProcessWithoutNullStreams,
      run: async () => { throw failure; } })).rejects.toBe(failure);
    expect(child.request).toEqual({ status: "failed", runId: 29 });
  });

  it("rejects a receipt that names a different run", async () => {
    const child = fakeChild({ terminalStatus: "failed" });
    await expect(withCanvasRunLease({ helperPath: "/private/test/duegood-capture-state",
      spawnChild: () => child as unknown as ChildProcessWithoutNullStreams,
      run: async () => ({ terminal: receipt(30), value: undefined }) }))
      .rejects.toMatchObject({ code: "CAPTURE_LEASE_RECEIPT_INVALID" });
    expect(child.request).toEqual({ status: "failed", runId: 29 });
  });
});
