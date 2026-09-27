import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadCurrentCanvasCapture } from "../../scripts/canvas-browser-runtime-loader.mjs";

it("reloads changed capture dependencies without replacing the broker process", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "duegood-capture-loader-test-"));
  try {
    const entry = path.join(directory, "entry.mjs");
    const dependency = path.join(directory, "dependency.mjs");
    await writeFile(entry, 'import { value } from "./dependency.mjs"; export const runCanvasCapture = () => value;\n');
    await writeFile(dependency, "export const value = 1;\n");
    expect((await loadCurrentCanvasCapture({ entry }))()).toBe(1);

    await writeFile(dependency, "export const value = 2;\n");
    expect((await loadCurrentCanvasCapture({ entry }))()).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
