import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANVAS_HELPER_PROVENANCE_FILE, readCanvasBuildIdentity, verifyCanvasHelperProvenance } from "../../scripts/canvas-helper-provenance.mjs";
import { installCanvasHelpers } from "../../scripts/canvas-helper-install.mjs";
import { fixedCanvasBrowserImportHelperPath, fixedCanvasCaptureStateHelperPath, fixedCanvasDownloadHelperPath, prepareCanvasHelper } from "../../scripts/prepare-canvas-helper.mjs";

const directories: string[] = [];
const testMarker = "duegood-feature:test-overrides";
const releaseMarker = "duegood-feature:release";

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@duegood.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@duegood.invalid",
    },
  });
}

async function makeSource(base: string): Promise<string> {
  const source = path.join(base, "source");
  await mkdir(path.join(source, "src-tauri", "src", "bin"), { recursive: true });
  await writeFile(path.join(source, "package.json"), '{"name":"synthetic-duegood"}\n');
  await writeFile(path.join(source, "package-lock.json"), '{"name":"synthetic-duegood","lockfileVersion":3,"packages":{}}\n');
  await writeFile(path.join(source, "SHA256SUMS"), "");
  await writeFile(path.join(source, "src-tauri", "Cargo.toml"), '[package]\nname="fixture"\n');
  await writeFile(path.join(source, "src-tauri", "src", "bin", "duegood-capture-download.rs"), "fn main() {}\n");
  git(source, ["init", "--quiet", "-b", "main"]);
  git(source, ["add", "-A"]);
  git(source, ["commit", "--quiet", "-m", "fixture"]);
  return source;
}

async function setup() {
  const base = await makeDirectory("duegood-helper-test-");
  const temporaryDirectory = path.join(base, "temporary");
  const homeDirectory = path.join(base, "home");
  await mkdir(temporaryDirectory, { mode: 0o700 });
  await mkdir(homeDirectory, { mode: 0o700 });
  return { base, sourceCheckout: await makeSource(base), temporaryDirectory, homeDirectory };
}

async function expectHelperStageCleaned(sourceCheckout: string): Promise<void> {
  const stageParent = path.join(sourceCheckout, ".stage");
  await expect(readdir(path.join(stageParent, "helper")))
    .rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(path.join(stageParent, ".locks"))).toEqual([]);
}

function fakeTool({ bytes = Buffer.from("synthetic production helper"), failCargo = false, omitImport = false } = {}) {
  const calls: Array<{ command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
  const run = async (command: string, args: string[], options: {
    cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; capture?: boolean;
  } = {}) => {
    calls.push({ command: path.basename(command), args, options });
    if (command === "cargo") {
      if (failCargo) throw new Error("synthetic compiler failure");
      const extension = process.platform === "win32" ? ".exe" : "";
      const releaseDirectory = path.join(options.env?.CARGO_TARGET_DIR ?? "", "release");
      await mkdir(releaseDirectory, { recursive: true });
      for (const executable of ["duegood-capture-download", "duegood-capture-state", "duegood-browser-import"]) {
        if (omitImport && executable === "duegood-browser-import") continue;
        const output = path.join(releaseDirectory, `${executable}${extension}`);
        await writeFile(output, bytes, { mode: 0o700 });
        await chmod(output, 0o700);
      }
      return { stdout: "", stderr: "" };
    }
    if (command === "rustc") return { stdout: "aarch64-apple-darwin\n", stderr: "" };
    if (command === "git" && args[0] === "rev-parse") {
      return { stdout: `${execFileSync("git", args, { cwd: options.cwd, encoding: "utf8" }).trim()}\n`, stderr: "" };
    }
    if (args[0] === "--display") return { stdout: "", stderr: "Signature=adhoc\n" };
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("prepareCanvasHelper", () => {
  it("builds, signs, and atomically installs all three owner-only capture helpers", async () => {
    const setupValue = await setup();
    const productionBytes = Buffer.from(`synthetic helper ${releaseMarker}`);
    const fake = fakeTool({ bytes: productionBytes });
    const progress: string[] = [];

    const installed = await prepareCanvasHelper({
      ...setupValue,
      platform: "darwin",
      run: fake.run,
      progress: (message: string) => { progress.push(message); },
    });

    expect(installed.path).toBe(fixedCanvasDownloadHelperPath(setupValue.homeDirectory));
    expect(installed.stateHelperPath).toBe(fixedCanvasCaptureStateHelperPath(setupValue.homeDirectory));
    expect(installed.importPath).toBe(fixedCanvasBrowserImportHelperPath(setupValue.homeDirectory));
    expect(await readFile(installed.path)).toEqual(productionBytes);
    expect(await readFile(installed.stateHelperPath)).toEqual(productionBytes);
    expect(await readFile(installed.importPath)).toEqual(productionBytes);
    const binDirectory = path.dirname(installed.path);
    const provenance = JSON.parse(await readFile(path.join(binDirectory, CANVAS_HELPER_PROVENANCE_FILE), "utf8"));
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: setupValue.sourceCheckout,
      encoding: "utf8",
    }).trim();
    expect(provenance.sourceCommit).toBe(sourceCommit);
    expect(provenance.candidateTree).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.helpers).toEqual({
      "duegood-capture-download": expect.any(String),
      "duegood-capture-state": expect.any(String),
      "duegood-browser-import": expect.any(String),
    });
    expect(await verifyCanvasHelperProvenance({
      binDirectory,
      sourceCommit,
      candidateTree: provenance.candidateTree,
    })).toEqual(provenance);
    const buildIdentityPath = path.join(setupValue.base, "duegood-build.json");
    await writeFile(buildIdentityPath, JSON.stringify({
      schemaVersion: 1,
      sourceCommit,
      candidateTree: provenance.candidateTree,
    }));
    await expect(readCanvasBuildIdentity({ metadataPath: buildIdentityPath })).resolves.toEqual({
      sourceCommit,
      candidateTree: provenance.candidateTree,
    });
    await expect(readCanvasBuildIdentity({
      metadataPath: path.join(setupValue.base, "missing-build.json"),
    })).resolves.toBeUndefined();
    expect((await stat(installed.path)).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(installed.path))).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(path.dirname(installed.path)))).mode & 0o777).toBe(0o700);
    await expectHelperStageCleaned(setupValue.sourceCheckout);
    expect(await readdir(setupValue.temporaryDirectory)).toEqual([]);
    expect(fake.calls.slice(0, 3).map((call) => call.command)).toEqual(["git", "npm", "node"]);
    const projectRoot = await realpath(setupValue.sourceCheckout);
    const stagedCwd = fake.calls[2]?.options.cwd;
    expect(stagedCwd).toBeDefined();
    expect(stagedCwd).toBe(path.join(projectRoot, ".stage", "helper"));
    expect(fake.calls[2]?.args[0]).toBe(path.join(stagedCwd!, "scripts", "build-tauri.mjs"));
    const cargo = fake.calls.find((call) => call.command === "cargo");
    const sharedCargoTarget = path.join(projectRoot, ".cache", "cargo-target");
    expect(cargo?.options.env?.CARGO_TARGET_DIR).toBe(sharedCargoTarget);
    expect((await stat(sharedCargoTarget)).isDirectory()).toBe(true);
    expect(cargo?.args).toContain("--release");
    expect(cargo?.args).toContain("--no-default-features");
    expect(cargo?.args.filter((arg) => arg === "--bin")).toHaveLength(3);
    expect(cargo?.args).toContain("duegood-browser-import");
    expect(cargo?.args).not.toContain("--features");
    expect(fake.calls.filter((call) => call.command === "codesign").map((call) => call.args[0]))
      .toEqual(["--force", "--verify", "--display", "--force", "--verify", "--display", "--force", "--verify", "--display"]);
    expect(progress).toContain("helpers installed and ready");

    const replacementBytes = Buffer.from(`replacement helper ${releaseMarker}`);
    const replacement = fakeTool({ bytes: replacementBytes });
    await prepareCanvasHelper({ ...setupValue, platform: "darwin", run: replacement.run });
    expect(await readFile(installed.path)).toEqual(replacementBytes);
    expect(await readFile(installed.stateHelperPath)).toEqual(replacementBytes);
    expect(await readFile(installed.importPath)).toEqual(replacementBytes);
    expect(await readdir(path.dirname(installed.path))).toEqual([
      "duegood-browser-import",
      CANVAS_HELPER_PROVENANCE_FILE,
      "duegood-capture-download",
      "duegood-capture-state",
    ]);
    expect(replacement.calls.find((call) => call.command === "cargo")?.options.env?.CARGO_TARGET_DIR)
      .toBe(sharedCargoTarget);
    expect((await stat(sharedCargoTarget)).isDirectory()).toBe(true);
    await expectHelperStageCleaned(setupValue.sourceCheckout);
    expect(await readdir(setupValue.temporaryDirectory)).toEqual([]);
  });

  it("rejects a test-overrides marker and removes its staged checkout", async () => {
    const setupValue = await setup();
    const fake = fakeTool({ bytes: Buffer.from(`bad helper ${testMarker}`) });

    await expect(prepareCanvasHelper({ ...setupValue, platform: "linux", run: fake.run }))
      .rejects.toMatchObject({ phase: "verifying" });

    expect(await readdir(setupValue.temporaryDirectory)).toEqual([]);
    await expectHelperStageCleaned(setupValue.sourceCheckout);
    await expect(readFile(fixedCanvasDownloadHelperPath(setupValue.homeDirectory))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fake.calls.some((call) => call.command === "codesign")).toBe(false);
  });

  it("fails closed when an installed helper differs from its provenance marker", async () => {
    const setupValue = await setup();
    const fake = fakeTool({ bytes: Buffer.from(`synthetic helper ${releaseMarker}`) });
    const installed = await prepareCanvasHelper({ ...setupValue, platform: "linux", run: fake.run });

    await writeFile(installed.path, "changed helper");
    await expect(verifyCanvasHelperProvenance({ binDirectory: path.dirname(installed.path) }))
      .rejects.toMatchObject({ code: "HELPER_STALE" });
  });

  it("preflights every destination before replacing any installed helper", async () => {
    const setupValue = await setup();
    const initial = fakeTool({ bytes: Buffer.from("previous helper set") });
    const installed = await prepareCanvasHelper({ ...setupValue, platform: "linux", run: initial.run });
    const previousDownload = await readFile(installed.path);
    const previousState = await readFile(installed.stateHelperPath);
    const provenancePath = path.join(path.dirname(installed.path), CANVAS_HELPER_PROVENANCE_FILE);
    const previousProvenance = await readFile(provenancePath);
    const heldImport = `${installed.importPath}.held`;
    await rename(installed.importPath, heldImport);
    await mkdir(installed.importPath);

    const replacement = fakeTool({ bytes: Buffer.from("replacement helper set") });
    await expect(prepareCanvasHelper({ ...setupValue, platform: "linux", run: replacement.run }))
      .rejects.toMatchObject({ phase: "installing" });

    expect(await readFile(installed.path)).toEqual(previousDownload);
    expect(await readFile(installed.stateHelperPath)).toEqual(previousState);
    expect(await readFile(provenancePath)).toEqual(previousProvenance);
    expect(await readFile(heldImport)).toEqual(Buffer.from("previous helper set"));
    expect(await readdir(path.dirname(installed.path))).not.toContain(".canvas-helper-install.lock");
  });

  it("restores the previous set when publication fails after the first replacement", async () => {
    const setupValue = await setup();
    const initial = fakeTool({ bytes: Buffer.from("previous helper set") });
    const installed = await prepareCanvasHelper({ ...setupValue, platform: "linux", run: initial.run });
    const binDirectory = path.dirname(installed.path);
    const previous = await Promise.all([
      readFile(installed.path),
      readFile(installed.stateHelperPath),
      readFile(installed.importPath),
      readFile(path.join(binDirectory, CANVAS_HELPER_PROVENANCE_FILE)),
    ]);
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: setupValue.sourceCheckout,
      encoding: "utf8",
    }).trim();
    const candidateTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: setupValue.sourceCheckout,
      encoding: "utf8",
    }).trim();
    const buildDirectory = path.join(setupValue.base, "new-build");
    await mkdir(buildDirectory);
    const names = [
      "duegood-capture-download",
      "duegood-capture-state",
      "duegood-browser-import",
    ];
    const entries = [];
    const expectedDigests: Record<string, string> = {};
    for (const [index, name] of names.entries()) {
      const binaryPath = path.join(buildDirectory, name);
      const bytes = Buffer.from(`replacement helper ${String(index)}`);
      await writeFile(binaryPath, bytes, { mode: 0o700 });
      expectedDigests[name] = createHash("sha256").update(bytes).digest("hex");
      entries.push({
        name,
        binaryPath,
        targetPath: path.join(binDirectory, name),
      });
    }
    let inspectCalls = 0;

    await expect(installCanvasHelpers({
      binDirectory,
      entries,
      sourceCommit,
      candidateTree,
      expectedDigests,
      platform: "linux",
      inspectBinary: async (binaryPath) => {
        inspectCalls += 1;
        if (inspectCalls === 4) throw new Error("synthetic installed-copy verification failure");
        const bytes = await readFile(binaryPath);
        return { sha256: createHash("sha256").update(bytes).digest("hex"), byteCount: bytes.length };
      },
    })).rejects.toThrow("synthetic installed-copy verification failure");

    const restored = await Promise.all([
      readFile(installed.path),
      readFile(installed.stateHelperPath),
      readFile(installed.importPath),
      readFile(path.join(binDirectory, CANVAS_HELPER_PROVENANCE_FILE)),
    ]);
    expect(restored).toEqual(previous);
    expect(await readdir(binDirectory)).not.toContain(".canvas-helper-install.lock");
  });

  it("excludes installer receipt markers when staging a signed candidate tree", async () => {
    const setupValue = await setup();
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: setupValue.sourceCheckout,
      encoding: "utf8",
    }).trim();
    const candidateTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: setupValue.sourceCheckout,
      encoding: "utf8",
    }).trim();
    await writeFile(path.join(setupValue.sourceCheckout, "installer-root-marker.json"), '{"synthetic":true}\n');
    const fake = fakeTool({ bytes: Buffer.from("synthetic production helper") });
    let untrackedPathsCalls = 0;

    const installed = await prepareCanvasHelper({
      ...setupValue,
      platform: "linux",
      sourceCommit,
      candidateTree,
      run: fake.run,
      untrackedPaths: () => {
        untrackedPathsCalls += 1;
        return ["installer-root-marker.json"];
      },
    });

    expect(untrackedPathsCalls).toBe(1);
    await expect(verifyCanvasHelperProvenance({
      binDirectory: path.dirname(installed.path),
      sourceCommit,
      candidateTree,
    })).resolves.toMatchObject({ sourceCommit, candidateTree });
    await expectHelperStageCleaned(setupValue.sourceCheckout);
  });

  it("rejects a missing browser import binary before installing any helper and cleans its stage", async () => {
    const setupValue = await setup();
    const fake = fakeTool({ bytes: Buffer.from(`synthetic helper ${releaseMarker}`), omitImport: true });

    await expect(prepareCanvasHelper({ ...setupValue, platform: "linux", run: fake.run }))
      .rejects.toMatchObject({ phase: "verifying" });

    expect(await readdir(setupValue.temporaryDirectory)).toEqual([]);
    await expectHelperStageCleaned(setupValue.sourceCheckout);
    await expect(readFile(fixedCanvasDownloadHelperPath(setupValue.homeDirectory)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixedCanvasCaptureStateHelperPath(setupValue.homeDirectory)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixedCanvasBrowserImportHelperPath(setupValue.homeDirectory)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an installed helper intact when a later release compilation fails", async () => {
    const setupValue = await setup();
    const originalBytes = Buffer.from("first good helper");
    const first = fakeTool({ bytes: originalBytes });
    const installed = await prepareCanvasHelper({ ...setupValue, platform: "linux", run: first.run });

    const failing = fakeTool({ failCargo: true });
    await expect(prepareCanvasHelper({ ...setupValue, platform: "linux", run: failing.run }))
      .rejects.toMatchObject({ phase: "compiling" });

    expect(await readFile(fixedCanvasDownloadHelperPath(setupValue.homeDirectory))).toEqual(originalBytes);
    expect(await readFile(installed.importPath)).toEqual(originalBytes);
    expect(await readdir(setupValue.temporaryDirectory)).toEqual([]);
    await expectHelperStageCleaned(setupValue.sourceCheckout);
  });

  it("cleans the isolated checkout after an interrupt during compilation", async () => {
    const setupValue = await setup();
    const controller = new AbortController();
    let markCompiling: () => void = () => undefined;
    const compiling = new Promise<void>((resolve) => { markCompiling = resolve; });
    const build = prepareCanvasHelper({
      ...setupValue,
      platform: "linux",
      signal: controller.signal,
      compile: async ({ signal }) => new Promise<{ downloadBinaryPath: string; stateBinaryPath: string; importBinaryPath: string }>((_resolve, reject) => {
        markCompiling();
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    });

    await compiling;
    controller.abort();
    await expect(build).rejects.toMatchObject({ phase: "compiling" });
    expect(await readdir(setupValue.temporaryDirectory)).toEqual([]);
    await expectHelperStageCleaned(setupValue.sourceCheckout);
  });
});
