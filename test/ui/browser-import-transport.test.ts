import { describe, expect, it } from "vitest";
import { createNativeTransport } from "../../src/ui/transport";

describe("native browser capture import transport", () => {
  it("sends only account confirmation and a progress channel, filtering invalid events", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    let receive: ((message: unknown) => void) | undefined;
    const channel = { id: "synthetic-channel" };
    const progress: unknown[] = [];
    const result = {
      runId: 4,
      importedCourses: 3,
      archivedCourses: 1,
      promotedBlobs: 2,
      reusedBlobs: 0,
      bytesVerified: 8192,
      alreadyCurrent: false,
    };
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      receive?.({ phase: "copying", filesDone: 2, bytesDone: 4096 });
      receive?.({ phase: "private-course-name", filesDone: 9, bytesDone: 1 });
      return result;
    }, (onMessage) => { receive = onMessage; return channel; });

    await expect(transport.importBrowserCapture((event) => progress.push(event), true)).resolves.toEqual(result);

    expect(progress).toEqual([{ phase: "copying", filesDone: 2, bytesDone: 4096 }]);
    expect(calls).toEqual([["import_browser_capture", { confirmFirstAccount: true, onProgress: channel }]]);
  });

  it("accepts null first-account confirmation and rejects unsafe IDs before IPC", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      return {
        runId: 5,
        importedCourses: 0,
        archivedCourses: 0,
        promotedBlobs: 0,
        reusedBlobs: 0,
        bytesVerified: 0,
        alreadyCurrent: true,
      };
    }, (onMessage) => ({ onMessage }));

    await expect(transport.importBrowserCapture(() => {}, false)).resolves.toMatchObject({ alreadyCurrent: true });
    await expect(transport.importBrowserCapture(() => {}, "41" as unknown as boolean)).rejects.toMatchObject({ code: "invalid-confirmation" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({ confirmFirstAccount: false });
  });
});
