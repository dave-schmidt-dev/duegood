import { describe, expect, it } from "vitest";
import { createNativeTransport } from "../../src/ui/transport";

describe("native store export transport", () => {
  it("uses the native picker command and validates content-free progress", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    let receive: ((message: unknown) => void) | undefined;
    const channel = { id: "synthetic-export-channel" };
    const progress: { filesDone: number; bytesDone: number }[] = [];
    const transport = createNativeTransport(async (command, args) => {
      calls.push([command, args]);
      receive?.({ filesDone: 7, bytesDone: 16384 });
      receive?.({ filesDone: "private-name", bytesDone: 12 });
      return { filesDone: 7, bytesDone: 16384 };
    }, (onMessage) => { receive = onMessage; return channel; });

    await expect(transport.exportNativeStore((event) => progress.push(event))).resolves.toEqual({ filesDone: 7, bytesDone: 16384 });
    expect(progress).toEqual([{ filesDone: 7, bytesDone: 16384 }]);
    expect(calls).toEqual([["export_native_store", { onProgress: channel }]]);
  });
});
