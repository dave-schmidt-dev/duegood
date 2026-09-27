import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixedCanvasDownloadHelperPath, prepareCanvasHelper } from "../../scripts/prepare-canvas-helper.mjs";

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

function fakeTool({ bytes = Buffer.from("synthetic production helper"), failCargo = false } = {}) {
  const calls: Array<{ command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
  const run = async (command: string, args: string[], options: {
    cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; capture?: boolean;
  } = {}) => {
    calls.push({ command: path.basename(command), args, options });
    if (command === "cargo") {
      if (failCargo) throw new Error("synthetic compiler failure");
      const executableName = process.platform === "win32" ? "duegood-capture-download.exe" : "duegood-capture-download";
      const output = path.join(options.env?.CARGO_TARGET_DIR ?? "", "release", executableName);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, bytes, { mode: 0o700 });
      await chmod(output, 0o700);
      return { stdout: "", stderr: "" };
    }
    if (command === "rustc") return { stdout: "aarch64-apple-darwin\n", stderr: "" };
    if (args[0] === "--display") return { stdout: "", stderr: "Signature=adhoc\n" };
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("prepareCanvasHelper", () => {
  it("builds only the release binary, ad hoc signs on macOS, and atomically installs owner-only bytes", async () => {
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
    expect(await readFile(installed.path)).toEqual(productionBytes);
    expect((await stat(installed.path)).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(installed.path))).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(path.dirname(installed.path)))).mode & 0o777).toBe(0o700);
    await expectHelperStageCleaned(setupValue.sourceCheckout);
    expect(await readdir(setupValue.temporaryDirectory)).toEqual([]);
    expect(fake.calls.slice(0, 2).map((call) => call.command)).toEqual(["npm", "node"]);
    const projectRoot = await realpath(setupValue.sourceCheckout);
    const stagedCwd = fake.calls[1]?.options.cwd;
    expect(stagedCwd).toBeDefined();
    expect(stagedCwd).toBe(path.join(projectRoot, ".stage", "helper"));
    expect(fake.calls[1]?.args[0]).toBe(path.join(stagedCwd!, "scripts", "build-tauri.mjs"));
    const cargo = fake.calls.find((call) => call.command === "cargo");
    const sharedCargoTarget = path.join(projectRoot, ".cache", "cargo-target");
    expect(cargo?.options.env?.CARGO_TARGET_DIR).toBe(sharedCargoTarget);
    expect((await stat(sharedCargoTarget)).isDirectory()).toBe(true);
    expect(cargo?.args).toContain("--release");
    expect(cargo?.args).toContain("--no-default-features");
    expect(cargo?.args).not.toContain("--features");
    expect(fake.calls.filter((call) => call.command === "codesign").map((call) => call.args[0]))
      .toEqual(["--force", "--verify", "--display"]);
    expect(progress).toContain("helper installed and ready");

    const replacementBytes = Buffer.from(`replacement helper ${releaseMarker}`);
    const replacement = fakeTool({ bytes: replacementBytes });
    await prepareCanvasHelper({ ...setupValue, platform: "darwin", run: replacement.run });
    expect(await readFile(installed.path)).toEqual(replacementBytes);
    expect(await readdir(path.dirname(installed.path))).toEqual(["duegood-capture-download"]);
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

  it("keeps an installed helper intact when a later release compilation fails", async () => {
    const setupValue = await setup();
    const originalBytes = Buffer.from("first good helper");
    const first = fakeTool({ bytes: originalBytes });
    await prepareCanvasHelper({ ...setupValue, platform: "linux", run: first.run });

    const failing = fakeTool({ failCargo: true });
    await expect(prepareCanvasHelper({ ...setupValue, platform: "linux", run: failing.run }))
      .rejects.toMatchObject({ phase: "compiling" });

    expect(await readFile(fixedCanvasDownloadHelperPath(setupValue.homeDirectory))).toEqual(originalBytes);
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
      compile: async ({ signal }) => new Promise<string>((_resolve, reject) => {
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
