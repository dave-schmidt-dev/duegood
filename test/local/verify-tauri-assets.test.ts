import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildStamp, cargoTargetDirectory, copyVerifiedAppBundle, createFrontendAssetManifest, resetTauriBundleOutput, stageAppBundlePath, tauriAppBundlePath } from "../../scripts/build-tauri.mjs";
import { parseArguments, verifyRuntimeAssets, verifyTauriAssets } from "../../scripts/verify-tauri-assets.mjs";

const tempRoots: string[] = [];
const CANDIDATE_TREE = "a".repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "duegood-tauri-assets-"));
  tempRoots.push(root);
  const ui = path.join(root, "tested-ui");
  const app = path.join(root, "Due Good.app");
  const bundledUi = path.join(app, "Contents", "Resources", "frontend");
  const executables = path.join(app, "Contents", "MacOS");
  await mkdir(ui, { recursive: true });
  await mkdir(bundledUi, { recursive: true });
  await mkdir(executables, { recursive: true });
  await writeFile(path.join(ui, "index.html"), "<main>synthetic</main>\n");
  await writeFile(path.join(ui, "app.js"), "export const synthetic = true;\n");
  await mkdir(path.join(ui, "nested"), { recursive: true });
  await writeFile(path.join(ui, "nested", "icon.svg"), "<svg></svg>\n");
  const manifest = await createFrontendAssetManifest(ui);
  await writeFile(path.join(ui, "asset-manifest.json"), manifest);
  for (const name of ["index.html", "app.js", "nested/icon.svg", "asset-manifest.json"]) {
    const destination = path.join(bundledUi, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ui, name), destination);
  }
  await writeFile(path.join(executables, "duegood-desktop"), Buffer.concat([
    Buffer.from("synthetic app executable\n"),
    Buffer.from(manifest),
  ]));
  await writeFile(path.join(executables, "duegood-refresh"), Buffer.from("synthetic refresh helper"));
  return { root, ui, app, bundledUi, executables };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Tauri staged asset verifier", () => {
  it("accepts an exact packaged copy of the tested frontend and production binaries", async () => {
    const sample = await fixture();
    await expect(verifyTauriAssets({
      appPath: sample.app,
      testedUiDir: sample.ui,
      runtimeVerifier: () => ({ files: 3 }),
    })).resolves.toEqual({ files: 3, runtimeVerified: true });
  });

  it("rejects packaged frontend bytes that differ from the tested candidate", async () => {
    const sample = await fixture();
    await writeFile(path.join(sample.bundledUi, "app.js"), "export const changed = true;\n");
    await expect(verifyTauriAssets({ appPath: sample.app, testedUiDir: sample.ui, runtimeVerifier: () => ({ files: 3 }) }))
      .rejects.toThrow("app-bundled frontend files differ");
  });

  it("requires the tested hash manifest to be embedded in the compiled app binary", async () => {
    const sample = await fixture();
    await writeFile(path.join(sample.executables, "duegood-desktop"), Buffer.from("app binary without manifest"));
    await expect(verifyTauriAssets({ appPath: sample.app, testedUiDir: sample.ui, runtimeVerifier: () => ({ files: 3 }) }))
      .rejects.toThrow("does not embed the tested frontend asset manifest");
  });

  it("rejects a release helper compiled with test-overrides", async () => {
    const sample = await fixture();
    await writeFile(path.join(sample.executables, "duegood-refresh"), Buffer.from("feature=test-overrides"));
    await expect(verifyTauriAssets({ appPath: sample.app, testedUiDir: sample.ui, runtimeVerifier: () => ({ files: 3 }) }))
      .rejects.toThrow("refresh helper contains the test-overrides marker");
  });

  it("rejects the app executable when it carries the test-overrides marker", async () => {
    const sample = await fixture();
    const manifest = await readFile(path.join(sample.ui, "asset-manifest.json"));
    await writeFile(path.join(sample.executables, "duegood-desktop"), Buffer.concat([
      Buffer.from("feature=test-overrides\n"),
      manifest,
    ]));
    await expect(verifyTauriAssets({ appPath: sample.app, testedUiDir: sample.ui, runtimeVerifier: () => ({ files: 3 }) }))
      .rejects.toThrow("app executable contains the test-overrides marker");
  });

  it("rejects a stale staged manifest rather than trusting its recorded digests", async () => {
    const sample = await fixture();
    const manifestPath = path.join(sample.ui, "asset-manifest.json");
    const original = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, original.replace("index.html", "other.html"));
    await expect(verifyTauriAssets({ appPath: sample.app, testedUiDir: sample.ui, runtimeVerifier: () => ({ files: 3 }) }))
      .rejects.toThrow("tested frontend asset manifest does not match");
  });

  it("writes stable build stamps with the staged tree digest", () => {
    expect(buildStamp({ sourceRevision: "abc123-dirty", candidateTree: "a".repeat(40) })).toBe(
      `${JSON.stringify({ schemaVersion: 1, sourceRevision: "abc123-dirty", candidateTree: "a".repeat(40) }, null, 2)}\n`,
    );
    expect(() => buildStamp({ sourceRevision: "bad\nrevision", candidateTree: "a".repeat(40) }))
      .toThrow("single non-empty line");
  });

  it("resolves build outputs into the shared Cargo target and defaults verification to the stage app", () => {
    const projectRoot = path.join(tmpdir(), "duegood-candidate");
    const targetRoot = path.join(tmpdir(), "duegood-cache", "cargo-target");
    const env = { CARGO_TARGET_DIR: targetRoot };
    expect(cargoTargetDirectory(projectRoot, env)).toBe(targetRoot);
    expect(tauriAppBundlePath("release", { projectRoot, env })).toBe(
      path.join(targetRoot, "release", "bundle", "macos", "Due Good.app"),
    );
    expect(cargoTargetDirectory(projectRoot, {})).toBe(path.join(projectRoot, "src-tauri", "target"));
    expect(parseArguments([], projectRoot).appPath).toBe(stageAppBundlePath(projectRoot));
    expect(stageAppBundlePath(projectRoot)).toBe(path.join(projectRoot, "build", "Due Good.app"));
  });

  it("clears stale shared-target bundles and copies only the finished bundle into the stage", async () => {
    const projectRoot = path.join(await mkdtemp(path.join(tmpdir(), "duegood-stage-app-")), "candidate");
    tempRoots.push(path.dirname(projectRoot));
    const targetRoot = path.join(path.dirname(projectRoot), "shared-target");
    const options = { projectRoot, env: { CARGO_TARGET_DIR: targetRoot } };
    const source = tauriAppBundlePath("release", options);
    const staleFile = path.join(source, "stale-marker");
    await mkdir(source, { recursive: true });
    await writeFile(staleFile, "old candidate");

    expect(await resetTauriBundleOutput("release", options)).toBe(source);
    await expect(readFile(staleFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const executable = path.join(source, "Contents", "MacOS", "duegood-desktop");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "synthetic verified bundle");
    const destination = await copyVerifiedAppBundle("release", options);
    expect(destination).toBe(path.join(projectRoot, "build", "Due Good.app"));
    expect(await readFile(path.join(destination, "Contents", "MacOS", "duegood-desktop"), "utf8"))
      .toBe("synthetic verified bundle");
    await expect(readFile(path.join(destination, "stale-marker"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires build metadata to identify the current staged candidate", async () => {
    const sample = await fixture();
    const candidateTree = CANDIDATE_TREE;
    await writeFile(path.join(sample.app, "Contents", "Resources", "duegood-build.json"),
      buildStamp({ sourceRevision: "synthetic-revision", candidateTree }));
    await expect(verifyTauriAssets({
      appPath: sample.app,
      testedUiDir: sample.ui,
      candidateTree,
      runtimeVerifier: () => ({ files: 3 }),
    })).resolves.toMatchObject({ files: 3, runtimeVerified: true });
    await expect(verifyTauriAssets({
      appPath: sample.app,
      testedUiDir: sample.ui,
      candidateTree: "b".repeat(40),
      runtimeVerifier: () => ({ files: 3 }),
    })).rejects.toThrow("app build metadata does not match the current staged candidate");
  });

  it("accepts only the app's fixed, content-free runtime verification result", () => {
    const spawn = () => ({ status: 0, stdout: "Verified 3 embedded frontend asset(s).\n", stderr: "", error: undefined });
    expect(verifyRuntimeAssets("synthetic-app", { spawn: spawn as never })).toEqual({ files: 3 });
    expect(() => verifyRuntimeAssets("synthetic-app", {
      spawn: () => ({ status: 0, stdout: "Verified 3 files: /private/path\n", stderr: "", error: undefined }),
    } as never)).toThrow("invalid embedded-asset verification result");
    expect(() => verifyRuntimeAssets("synthetic-app", {
      spawn: () => ({ status: 1, stdout: "", stderr: "", error: undefined }),
    } as never)).toThrow("embedded-asset runtime verification failed");
  });

  it("rejects a runtime verifier count that does not match the tested UI", async () => {
    const sample = await fixture();
    await expect(verifyTauriAssets({
      appPath: sample.app,
      testedUiDir: sample.ui,
      runtimeVerifier: () => ({ files: 2 }),
    })).rejects.toThrow("embedded-asset count differs");
  });
});
