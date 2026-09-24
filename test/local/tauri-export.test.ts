/** Rust export parity over a synthetic legacy tree; the TypeScript side never reimplements export. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CourseworkStore } from "../../src/local/coursework-store";
import { DashboardStore } from "../../src/local/dashboard-store";

const run = promisify(execFile);
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Entry { path: string; json?: Json; text?: string; hex?: string; symlink?: string; jsonRepeat?: { count: number; template: Json } }
const fixture = path.resolve("test/fixtures/tauri-legacy-source.json");

function instantiate(value: Json, n: number): Json {
  if (value === "{n#}") return n;
  if (typeof value === "string") return value.replaceAll("{n}", String(n));
  if (Array.isArray(value)) return value.map((entry) => instantiate(entry, n));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, instantiate(entry, n)]));
  return value;
}

let temp = "";
afterAll(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

describe("Rust legacy export", () => {
  it("round-trips every accepted synthetic document and material, then reproduces the Node projection", async () => {
    temp = await mkdtemp(path.join(tmpdir(), "duegood-export-parity-"));
    const source = path.join(temp, "source");
    const destination = path.join(temp, "destination");
    await mkdir(source); await mkdir(destination);
    const entries = (JSON.parse(await readFile(fixture, "utf8")) as { entries: Entry[] }).entries;
    for (const entry of entries) {
      const target = path.join(source, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      if (entry.json !== undefined) await writeFile(target, `${JSON.stringify(entry.json, null, 2)}\n`);
      else if (entry.text !== undefined) await writeFile(target, entry.text);
      else if (entry.hex !== undefined) await writeFile(target, Buffer.from(entry.hex, "hex"));
      else if (entry.jsonRepeat !== undefined) await writeFile(target, `${JSON.stringify(Array.from({ length: entry.jsonRepeat.count }, (_, index) => instantiate(entry.jsonRepeat!.template, index + 1)), null, 2)}\n`);
      else if (entry.symlink !== undefined) await symlink(entry.symlink, target);
    }
    await run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--features", "test-overrides", "--", "--ignored", "export_fixture_helper"], {
      cwd: path.resolve("."),
      env: { ...process.env, DUEGOOD_EXPORT_TEST_SOURCE: source, DUEGOOD_EXPORT_TEST_DESTINATION: destination },
      timeout: 120_000,
    });
    const folders = await readdir(path.join(destination, "exports"));
    expect(folders).toHaveLength(1);
    const exported = path.join(destination, "exports", folders[0]!);
    // Import treats macOS finder metadata as outside the coursework layout.
    expect(await readdir(exported)).not.toContain(".DS_Store");
    for (const entry of entries.filter((entry) => entry.path !== ".DS_Store")) {
      const left = path.join(source, entry.path);
      const right = path.join(exported, entry.path);
      expect((await lstat(right)).isFile()).toBe(true);
      if (entry.json !== undefined || entry.jsonRepeat !== undefined) expect(JSON.parse(await readFile(right, "utf8"))).toStrictEqual(JSON.parse(await readFile(left, "utf8")));
      else expect(await readFile(right)).toStrictEqual(await readFile(left));
    }
    expect(await readdir(exported)).not.toContain("duegood-store.json");
    expect(await readdir(exported)).not.toContain("snapshots");
    expect(await readdir(exported)).not.toContain("backups");
    const original = new CourseworkStore(path.join(source, "coursework.json"));
    const restored = new CourseworkStore(path.join(exported, "coursework.json"));
    const [left, right] = await Promise.all([original.read(), restored.read()]);
    expect(right).toStrictEqual(left);
    const [leftResources, rightResources] = await Promise.all([new DashboardStore(path.join(source, "coursework.json")).resources(left.courses), new DashboardStore(path.join(exported, "coursework.json")).resources(right.courses)]);
    expect(rightResources).toStrictEqual(leftResources);
  }, 120_000);
});
