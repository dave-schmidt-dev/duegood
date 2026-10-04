import { describe, expect, it, vi } from "vitest";
import { createLibraryResourceActionRunner } from "../../src/ui/library-resource-action";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

describe("Library resource action runner", () => {
  it("latches duplicate pending calls by resource while allowing another item", async () => {
    const first = deferred<"opened">();
    const second = deferred<"downloaded">();
    const open = vi.fn((id: string) => id === "first" ? first.promise : second.promise);
    const runner = createLibraryResourceActionRunner(open);

    const pendingFirst = runner.run("first");
    expect(runner.isPending("first")).toBe(true);
    expect(runner.run("first")).toBeUndefined();
    const pendingSecond = runner.run("second");
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, "first");
    expect(open).toHaveBeenNthCalledWith(2, "second");

    first.resolve("opened");
    second.resolve("downloaded");
    await expect(pendingFirst).resolves.toEqual({ status: "opened", message: "File opened." });
    await expect(pendingSecond).resolves.toEqual({ status: "downloaded", message: "File saved." });
    expect(runner.isPending("first")).toBe(false);
    expect(runner.isPending("second")).toBe(false);
  });

  it("keeps cancellation and failures truthful, then permits retry", async () => {
    const open = vi.fn<() => Promise<"opened" | "downloaded" | "cancelled">>()
      .mockResolvedValueOnce("cancelled")
      .mockRejectedValueOnce(new Error("native failure"))
      .mockResolvedValueOnce("opened");
    const runner = createLibraryResourceActionRunner(open);

    await expect(runner.run("file")).resolves.toEqual({ status: "cancelled", message: "Save cancelled." });
    await expect(runner.run("file")).resolves.toEqual({ status: "failed", message: "The saved file could not be opened." });
    await expect(runner.run("file")).resolves.toEqual({ status: "opened", message: "File opened." });
    expect(open).toHaveBeenCalledTimes(3);
  });
});
