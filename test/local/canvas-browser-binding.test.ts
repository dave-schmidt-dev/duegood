import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindCanvasAccount, readCanvasAccountBinding } from "../../scripts/canvas-browser-binding.mjs";

const directories: string[] = [];
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "duegood-binding-test-"));
  directories.push(root);
  await chmod(root, 0o700);
  return root;
}
afterEach(async () => Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("owner-confirmed Canvas account binding", () => {
  it("binds only the live numeric account and reuses it tomorrow", async () => {
    const root = await directory();
    expect(await readCanvasAccountBinding(root)).toBeUndefined();
    await expect(bindCanvasAccount(root, 41, 42)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(await readCanvasAccountBinding(root)).toBeUndefined();
    expect(await bindCanvasAccount(root, 41, 41)).toBe(41);
    expect(await readCanvasAccountBinding(root)).toBe(41);
    expect((await lstat(path.join(root, "canvas-account-binding.json"))).mode & 0o777).toBe(0o600);
    expect(await bindCanvasAccount(root, 41, 41)).toBe(41);
    await expect(bindCanvasAccount(root, 42, 42)).rejects.toMatchObject({ code: "BINDING_ALREADY_SET" });
  });

  it("rejects symlinks and permissive binding files", async () => {
    const root = await directory();
    const target = path.join(root, "actual.json");
    await writeFile(target, JSON.stringify({ schemaVersion: 1, userId: 41 }), { mode: 0o600 });
    await symlink(target, path.join(root, "canvas-account-binding.json"));
    await expect(readCanvasAccountBinding(root)).rejects.toMatchObject({ code: "BINDING_REJECTED" });
    await rm(path.join(root, "canvas-account-binding.json"));
    await writeFile(path.join(root, "canvas-account-binding.json"), JSON.stringify({ schemaVersion: 1, userId: 41 }), { mode: 0o644 });
    await expect(readCanvasAccountBinding(root)).rejects.toMatchObject({ code: "BINDING_REJECTED" });
  });
});
