import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareLegacyRoot } from "../../scripts/prepare-legacy-root.mjs";

const temporaryRoots: string[] = [];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function makeTempRoot(): Promise<string> {
  const privateTemp = await realpath(tmpdir());
  const root = await mkdtemp(path.join(privateTemp, "duegood-legacy-prepare-"));
  temporaryRoots.push(root);
  return root;
}

async function writeFixtureRoot(root: string, { rejectedEntries = false } = {}): Promise<void> {
  await mkdir(root, { mode: 0o700 });
  await writeFile(path.join(root, "coursework.json"), '{"courses":[],"items":[]}\n');
  await mkdir(path.join(root, "classes", "syn-101"), { recursive: true, mode: 0o755 });
  await writeFile(path.join(root, "classes", "syn-101", "coursework.md"), "Synthetic report\n");
  if (rejectedEntries) {
    await writeFile(path.join(root, "private-note-synthetic-only.txt"), "omit at root\n");
    await mkdir(path.join(root, "private-extra"), { mode: 0o755 });
    await writeFile(path.join(root, "private-extra", "nested.txt"), "omit with parent\n");
    await writeFile(path.join(root, "classes", "syn-101", "course-extra-synthetic.txt"), "omit in course\n");
    await mkdir(path.join(root, "classes", "Invalid Course"), { mode: 0o755 });
    await writeFile(path.join(root, "classes", "Invalid Course", "nested.txt"), "omit invalid course folder\n");
    await mkdir(path.join(root, "classes", "syn-101", "materials"), { mode: 0o755 });
    await writeFile(path.join(root, "classes", "syn-101", "materials", "opaque.bin"), Buffer.from([0, 1, 2, 255]));
    await writeFile(path.join(root, "classes", "syn-101", "materials", ".kept.tmp"), "preserved importer refusal\n");
    await symlink("missing.bin", path.join(root, "classes", "syn-101", "materials", "broken-link"));
    await mkdir(path.join(root, "classes", "syn-101", "canvas-export"), { mode: 0o755 });
    await writeFile(path.join(root, "classes", "syn-101", "canvas-export", "future.payload"), "preserved unsupported export\n");
    await writeFile(path.join(root, ".DS_Store"), "root metadata\n");
    await writeFile(path.join(root, "classes", ".DS_Store"), "classes metadata\n");
    await writeFile(path.join(root, "classes", "syn-101", "materials", ".DS_Store"), "materials metadata\n");
    await writeFile(path.join(root, "classes", "syn-101", "canvas-export", ".DS_Store"), "export metadata\n");
  }
}

type TreeEntry = { kind: "directory" | "file" | "symlink"; value: string };

async function snapshot(root: string): Promise<Record<string, TreeEntry>> {
  const entries: Record<string, TreeEntry> = {};
  async function walk(directory: string, relative = ""): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(directory, name);
      const key = relative ? `${relative}/${name}` : name;
      const info = await lstat(child);
      if (info.isSymbolicLink()) {
        entries[key] = { kind: "symlink", value: await readlink(child) };
      } else if (info.isDirectory()) {
        entries[key] = { kind: "directory", value: "" };
        await walk(child, key);
      } else {
        entries[key] = { kind: "file", value: Buffer.from(await readFile(child)).toString("hex") };
      }
    }
  }
  await walk(root);
  return entries;
}

function isOmittedByContract(relative: string): boolean {
  return relative === "private-note-synthetic-only.txt"
    || relative === "private-extra"
    || relative.startsWith("private-extra/")
    || relative === "classes/syn-101/course-extra-synthetic.txt"
    || relative === "classes/Invalid Course"
    || relative.startsWith("classes/Invalid Course/")
    || path.posix.basename(relative) === ".DS_Store";
}

async function assertPrivateTree(root: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory)) {
      const child = path.join(directory, name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(child);
      else expect(info.mode & 0o777).toBe(0o600);
    }
  }
  await walk(root);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("prepareLegacyRoot", () => {
  it("copies the exact layout subset, keeps in-layout refusals, and prints counts only", async () => {
    const parent = await makeTempRoot();
    const source = path.join(parent, "synthetic-source");
    const destination = path.join(parent, "synthetic-prepared");
    await writeFixtureRoot(source, { rejectedEntries: true });
    const sourceBefore = await snapshot(source);

    const stdout = execFileSync(process.execPath, [
      path.join(projectRoot, "scripts/prepare-legacy-root.mjs"),
      "--source", source,
      "--destination", destination,
    ], { cwd: projectRoot, encoding: "utf8" });
    const report = JSON.parse(stdout) as {
      copiedFiles: number;
      copiedDirectories: number;
      copiedSymlinks: number;
      omitted: { unsupportedRootEntries: number; unsupportedCourseEntries: number; invalidCourseFolderNames: number; osMetadataFiles: number };
    };
    expect(report).toEqual({
      copiedFiles: 5,
      copiedDirectories: 4,
      copiedSymlinks: 1,
      omitted: { unsupportedRootEntries: 2, unsupportedCourseEntries: 1, invalidCourseFolderNames: 1, osMetadataFiles: 4 },
    });
    for (const privateValue of [source, destination, "private-note-synthetic-only.txt", "course-extra-synthetic.txt", "Invalid Course", "opaque.bin"]) {
      expect(stdout).not.toContain(privateValue);
    }

    const expected = Object.fromEntries(Object.entries(sourceBefore).filter(([name]) => !isOmittedByContract(name)));
    expect(await snapshot(destination)).toEqual(expected);
    expect(await snapshot(source)).toEqual(sourceBefore);
    await assertPrivateTree(destination);
  });

  it("refuses existing and symlinked destinations or parents without changing source data", async () => {
    const parent = await makeTempRoot();
    const source = path.join(parent, "source");
    await writeFixtureRoot(source);
    const before = await snapshot(source);

    const existing = path.join(parent, "existing");
    await mkdir(existing, { mode: 0o700 });
    await expect(prepareLegacyRoot({ source, destination: existing })).rejects.toMatchObject({ code: "destination-exists" });

    const targetParent = path.join(parent, "target-parent");
    await mkdir(targetParent, { mode: 0o700 });
    const parentLink = path.join(parent, "parent-link");
    await symlink(targetParent, parentLink);
    await expect(prepareLegacyRoot({ source, destination: path.join(parentLink, "new-root") }))
      .rejects.toMatchObject({ code: "destination parent is not private" });

    const destinationLink = path.join(parent, "destination-link");
    await symlink(targetParent, destinationLink);
    await expect(prepareLegacyRoot({ source, destination: destinationLink })).rejects.toMatchObject({ code: "destination-exists" });
    expect(await snapshot(source)).toEqual(before);
    expect(await readdir(targetParent)).toEqual([]);
  });

  it("refuses group or other writable parents and a present legacy lock", async () => {
    const parent = await makeTempRoot();
    const source = path.join(parent, "source");
    await writeFixtureRoot(source);
    const before = await snapshot(source);

    const openParent = path.join(parent, "open-parent");
    await mkdir(openParent, { mode: 0o700 });
    await chmod(openParent, 0o777);
    await expect(prepareLegacyRoot({ source, destination: path.join(openParent, "prepared") }))
      .rejects.toMatchObject({ code: "destination parent is not private" });
    await chmod(openParent, 0o700);

    await mkdir(path.join(source, "coursework.json.duegood-lock"), { mode: 0o700 });
    const destination = path.join(parent, "locked-destination");
    await expect(prepareLegacyRoot({ source, destination })).rejects.toMatchObject({ code: "legacy-lock-busy" });
    expect(await lstat(destination).catch(() => null)).toBeNull();
    expect(await snapshot(source)).toEqual({ ...before, "coursework.json.duegood-lock": { kind: "directory", value: "" } });
  });

  it("passes prepared and unprepared synthetic roots to the ignored Rust dry-run helper", async () => {
    const parent = await makeTempRoot();
    const source = path.join(parent, "rust-source");
    const destination = path.join(parent, "rust-prepared");
    await writeFixtureRoot(source);
    await writeFile(path.join(source, "non-layout-root.synthetic"), "root refusal\n");
    await writeFile(path.join(source, "classes", "syn-101", "non-layout-course.synthetic"), "course refusal\n");
    await prepareLegacyRoot({ source, destination });

    process.stderr.write("Synthetic legacy-root Rust dry run started.\n");
    const cargo = spawnSync("cargo", [
      "test",
      "--locked",
      "--manifest-path", "src-tauri/Cargo.toml",
      "--features", "test-overrides",
      "--lib",
      "import::tests::prepare_legacy_root_dry_run_helper",
      "--",
      "--ignored",
      "--exact",
      "--nocapture",
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DUEGOOD_PREPARE_SOURCE: source,
        DUEGOOD_PREPARE_DESTINATION: destination,
      },
      stdio: "pipe",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (cargo.error || cargo.status !== 0 || !cargo.stdout.includes("legacy-root-dry-run: unprepared-refused prepared-importable")) {
      throw new Error("Rust dry-run helper failed on synthetic roots.");
    }
  }, 70_000);
});
