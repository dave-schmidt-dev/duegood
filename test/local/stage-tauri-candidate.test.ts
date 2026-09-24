import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserDirectoryName,
  detectHostPlatform,
  preflightPlaywrightBrowsers,
  PROJECT_PLAYWRIGHT_BROWSERS,
  stageCandidate,
} from "../../scripts/stage-tauri-candidate.mjs";

const directories: string[] = [];

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@duegood.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@duegood.invalid",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv(), stdio: "pipe" });
}

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function makeSourceRepo(): Promise<string> {
  const source = await makeTempDir("duegood-stage-source-");
  git(source, ["init", "--quiet", "-b", "main"]);
  await writeFile(path.join(source, "package.json"), '{"name":"fixture"}\n');
  await writeFile(path.join(source, "package-lock.json"), '{"packages":{}}\n');
  await writeFile(path.join(source, "SHA256SUMS"), "");
  await writeFile(path.join(source, "app.txt"), "original\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "--quiet", "-m", "initial"]);
  return source;
}

/** Every entry under `root` except `.git`, with its type, mode, and (for files) bytes. */
async function sourceSnapshot(root: string): Promise<string[]> {
  const names = (await readdir(root, { recursive: true })).filter((name) => name !== ".git" && !name.startsWith(`.git${path.sep}`)).sort();
  const snapshot: string[] = [];
  for (const name of names) {
    const entry = await lstat(path.join(root, name));
    const kind = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file";
    const bytes = kind === "file" ? Buffer.from(await readFile(path.join(root, name))).toString("hex") : "";
    snapshot.push(`${name}:${kind}:${(entry.mode & 0o777).toString(8)}:${bytes}`);
  }
  return snapshot;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A fresh, not-yet-existing stage path inside a new private temporary parent. */
async function freshDestination(prefix = "duegood-stage-dest-"): Promise<string> {
  return path.join(await makeTempDir(prefix), "stage");
}

describe("stageCandidate", () => {
  it("rejects a synthetic private sentinel filename", async () => {
    const source = await makeSourceRepo();
    await writeFile(path.join(source, "coursework.json"), "{}\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "--quiet", "-m", "add sentinel"]);
    const destination = await freshDestination();
    await expect(stageCandidate({ source, destination })).rejects.toThrow(/coursework\.json/);
  });

  it("rejects a symlink whose target escapes the source root", async () => {
    const source = await makeSourceRepo();
    const outside = await makeTempDir("duegood-stage-outside-");
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    await symlink(path.join(outside, "secret.txt"), path.join(source, "escape-link"));
    const destination = await freshDestination();
    await expect(stageCandidate({ source, destination, include: ["escape-link"] })).rejects.toThrow(/escapes the source root/);
  });

  it("fails the stage on an unlisted untracked file", async () => {
    const source = await makeSourceRepo();
    await writeFile(path.join(source, "surprise.txt"), "unlisted\n");
    const destination = await freshDestination();
    await expect(stageCandidate({ source, destination })).rejects.toThrow(/surprise\.txt/);
  });

  it("stages an edited tracked file and an included untracked file with their working bytes", async () => {
    const source = await makeSourceRepo();
    await writeFile(path.join(source, "app.txt"), "edited\n");
    await writeFile(path.join(source, "new-app-file.txt"), "brand new\n");
    const destination = await freshDestination();
    const result = await stageCandidate({ source, destination, include: ["new-app-file.txt"] });

    const expectedCandidates = ["SHA256SUMS", "app.txt", "new-app-file.txt", "package-lock.json", "package.json"].sort();
    expect(result.candidatePaths).toEqual(expectedCandidates);
    expect(await readFile(path.join(destination, "app.txt"), "utf8")).toBe("edited\n");
    expect(await readFile(path.join(destination, "new-app-file.txt"), "utf8")).toBe("brand new\n");

    const stagedGitFiles = execFileSync("git", ["ls-files"], { cwd: destination, encoding: "utf8" }).trim().split("\n").sort();
    expect(stagedGitFiles).toEqual(expectedCandidates);
    expect(result.receipt.stagedMatchesCandidate).toBe(true);
    expect(Object.keys(result.receipt.files).sort()).toEqual(expectedCandidates);
  });

  it("yields the same tree digest across two stagings of the same source", async () => {
    const source = await makeSourceRepo();
    const resultA = await stageCandidate({ source, destination: await freshDestination("duegood-stage-dest-a-") });
    const resultB = await stageCandidate({ source, destination: await freshDestination("duegood-stage-dest-b-") });
    expect(resultA.treeDigest).toBe(resultB.treeDigest);
  });

  it("rejects an existing destination directory, file, or symlink, leaving the source unchanged", async () => {
    const source = await makeSourceRepo();
    const inner = path.join(source, "inner");
    await mkdir(inner, { mode: 0o755 });
    const before = await sourceSnapshot(source);
    const innerModeBefore = (await stat(inner)).mode;
    const outside = await makeTempDir("duegood-stage-outside-");

    const existingDirectory = await makeTempDir("duegood-stage-existing-");
    await expect(stageCandidate({ source, destination: existingDirectory })).rejects.toThrow(/must not exist yet/);
    expect(await readdir(existingDirectory)).toEqual([]);

    const existingFile = path.join(outside, "file");
    await writeFile(existingFile, "kept\n");
    await expect(stageCandidate({ source, destination: existingFile })).rejects.toThrow(/must not exist yet/);
    expect(await readFile(existingFile, "utf8")).toBe("kept\n");

    const linkIntoSource = path.join(outside, "link-into-source");
    await symlink(inner, linkIntoSource);
    await expect(stageCandidate({ source, destination: linkIntoSource })).rejects.toThrow(/must not exist yet/);
    const linkOutside = path.join(outside, "link-outside");
    await symlink(existingDirectory, linkOutside);
    await expect(stageCandidate({ source, destination: linkOutside })).rejects.toThrow(/must not exist yet/);
    const danglingLink = path.join(outside, "dangling");
    await symlink(path.join(outside, "missing-target"), danglingLink);
    await expect(stageCandidate({ source, destination: danglingLink })).rejects.toThrow(/must not exist yet/);
    expect((await readdir(outside)).sort()).toEqual(["dangling", "file", "link-into-source", "link-outside"]);

    expect(await readdir(inner)).toEqual([]);
    expect((await stat(inner)).mode).toBe(innerModeBefore);
    expect(await sourceSnapshot(source)).toEqual(before);
  });

  it("rejects a destination whose parent is a symlink into the source", async () => {
    const source = await makeSourceRepo();
    const before = await sourceSnapshot(source);
    const outside = await makeTempDir("duegood-stage-outside-");
    const parentLink = path.join(outside, "parent-link");
    await symlink(source, parentLink);

    await expect(stageCandidate({ source, destination: path.join(parentLink, "stage") })).rejects.toThrow(/outside the source tree/);
    await expect(stageCandidate({ source, destination: path.join(parentLink, "nested", "stage") })).rejects.toThrow(/outside the source tree/);
    await expect(stageCandidate({ source, destination: path.join(source, "stage") })).rejects.toThrow(/outside the source tree/);
    expect(await sourceSnapshot(source)).toEqual(before);
  });

  it("rejects a parent other users can write unless it is sticky", async () => {
    const source = await makeSourceRepo();
    const open = await makeTempDir("duegood-stage-open-");
    await chmod(open, 0o777);
    await expect(stageCandidate({ source, destination: path.join(open, "stage") })).rejects.toThrow(/writable by other users/);
    await expect(stageCandidate({ source, destination: path.join(open, "missing", "stage") })).rejects.toThrow(/writable by other users/);
    expect(await readdir(open)).toEqual([]);

    const sticky = await makeTempDir("duegood-stage-sticky-");
    await chmod(sticky, 0o1777);
    expect((await stat(sticky)).mode & 0o7777).toBe(0o1777);
    const result = await stageCandidate({ source, destination: path.join(sticky, "stage") });
    expect(result.destination).toBe(path.join(await realpath(sticky), "stage"));
  });

  it("creates a private, owned, real stage directory, including missing parents and through an outside symlink", async () => {
    const source = await makeSourceRepo();
    const outside = await makeTempDir("duegood-stage-outside-");
    const destination = path.join(outside, "a", "b", "stage");
    const result = await stageCandidate({ source, destination });
    expect(result.destination).toBe(await realpath(destination));
    const created = await lstat(destination);
    expect(created.isSymbolicLink()).toBe(false);
    expect(created.isDirectory()).toBe(true);
    expect(created.mode & 0o777).toBe(0o700);
    expect(created.uid).toBe(process.getuid?.());
    for (const parent of [path.join(outside, "a"), path.join(outside, "a", "b")]) expect((await lstat(parent)).mode & 0o777).toBe(0o700);
    expect(await readFile(path.join(destination, "app.txt"), "utf8")).toBe("original\n");
    const stagedGitFiles = execFileSync("git", ["ls-files"], { cwd: destination, encoding: "utf8" }).trim().split("\n").sort();
    expect(stagedGitFiles).toEqual(result.candidatePaths);

    const alias = await makeTempDir("duegood-stage-alias-");
    await symlink(outside, path.join(alias, "outside-link"));
    const aliased = await stageCandidate({ source, destination: path.join(alias, "outside-link", "second") });
    expect(aliased.destination).toBe(path.join(await realpath(outside), "second"));
    expect(aliased.treeDigest).toBe(result.treeDigest);
  });

  it("fails when a required file is absent from the candidate set", async () => {
    const source = await makeTempDir("duegood-stage-source-nopkg-");
    git(source, ["init", "--quiet", "-b", "main"]);
    await writeFile(path.join(source, "README.md"), "hello\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "--quiet", "-m", "initial"]);
    const destination = await freshDestination();
    await expect(stageCandidate({ source, destination })).rejects.toThrow(/missing required file/);
  });
});

describe("Playwright browser-cache preflight", () => {
  const packageLock = { packages: { "node_modules/@playwright/test": { version: "1.63.0" } } };
  const browsersJson = {
    browsers: [
      { name: "chromium", revision: "1243", installByDefault: true },
      { name: "chromium-headless-shell", revision: "1243", installByDefault: true },
      { name: "firefox", revision: "1543", installByDefault: true },
      { name: "winldd", revision: "1007", installByDefault: false },
    ],
  };
  const hostPlatform = "mac26-arm64";

  it("fails and names the missing build without downloading anything", async () => {
    const cacheDir = await makeTempDir("duegood-stage-cache-missing-");
    await mkdir(path.join(cacheDir, browserDirectoryName({ name: "chromium", revision: "1243" }, hostPlatform)), { recursive: true });
    expect(() => preflightPlaywrightBrowsers({ packageLock, browsersJson, cacheDir, hostPlatform })).toThrow(/chromium_headless_shell-1243/);
    expect(await readdir(cacheDir)).toEqual(["chromium-1243"]);
  });

  it("passes with only the Chromium builds the project launches, not every installByDefault browser", async () => {
    const cacheDir = await makeTempDir("duegood-stage-cache-complete-");
    for (const name of PROJECT_PLAYWRIGHT_BROWSERS) {
      await mkdir(path.join(cacheDir, browserDirectoryName({ name, revision: "1243" }, hostPlatform)), { recursive: true });
    }
    const preflight = preflightPlaywrightBrowsers({ packageLock, browsersJson, cacheDir, hostPlatform });
    expect(preflight.required).toEqual(["chromium-1243", "chromium_headless_shell-1243"]);
    expect(preflight.version).toBe("1.63.0");
  });

  it("fails when browsers.json lacks a required browser entry", async () => {
    const cacheDir = await makeTempDir("duegood-stage-cache-noentry-");
    const firefoxOnly = { browsers: [{ name: "firefox", revision: "1543", installByDefault: true }] };
    expect(() => preflightPlaywrightBrowsers({ packageLock, browsersJson: firefoxOnly, cacheDir, hostPlatform })).toThrow(/no entry for required browser chromium/);
  });

  it("stays in step with playwright.config.ts: every project uses the Desktop Chrome device", async () => {
    const config = await readFile(path.resolve("playwright.config.ts"), "utf8");
    const devicesUsed = [...config.matchAll(/devices\[\s*"([^"]+)"\s*\]/g)].map((match) => match[1]);
    expect(devicesUsed.length).toBeGreaterThan(0);
    expect(new Set(devicesUsed)).toEqual(new Set(["Desktop Chrome"]));
    expect(config).not.toMatch(/browserName|channel\s*:/);
  });

  it("computes a stable hostPlatform for a darwin arm64 host", () => {
    expect(detectHostPlatform({ platform: "darwin", release: "25.0.0", cpus: [{ model: "Apple M5" }] } as never)).toBe("mac26-arm64");
  });

  it("honors PLAYWRIGHT_HOST_PLATFORM_OVERRIDE", () => {
    expect(detectHostPlatform({ platform: "darwin", release: "25.0.0", cpus: [], env: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "linux-x64" } } as never)).toBe(
      "linux-x64",
    );
  });
});
