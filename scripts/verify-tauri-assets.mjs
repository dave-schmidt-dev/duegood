#!/usr/bin/env node
/** Verifies the exact frontend tree copied into the staged macOS app and release feature hygiene. */
import { lstat, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStagedCandidate, createFrontendAssetManifest } from "./build-tauri.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEST_OVERRIDES_MARKER = Buffer.from("test-overrides");
export const EMBEDDED_ASSET_VERIFY_OUTPUT = /^Verified (\d+) embedded frontend asset\(s\)\.\r?\n?$/;

function fail(message) {
  throw new Error(message);
}

async function assertRegularFile(file, label) {
  let stats;
  try {
    stats = await lstat(file);
  } catch {
    fail(`${label} is missing`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must be a regular file`);
}

/** Runs the app's no-window verifier against the same decompressed embedded assets Tauri serves. */
export function verifyRuntimeAssets(appExecutable, { spawn = spawnSync } = {}) {
  const result = spawn(appExecutable, ["--verify-embedded-assets"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || result.stderr) {
    fail("bundled app embedded-asset runtime verification failed");
  }
  const match = result.stdout.match(EMBEDDED_ASSET_VERIFY_OUTPUT);
  if (!match) fail("bundled app returned an invalid embedded-asset verification result");
  return { files: Number(match[1]) };
}

/** Compares staged frontend source bytes with the copies embedded in the app bundle. */
export async function verifyTauriAssets({
  appPath,
  testedUiDir,
  appExecutableName = "duegood-desktop",
  helperExecutableName = "duegood-refresh",
  allowTestOverrides = false,
  runtimeVerifier = verifyRuntimeAssets,
}) {
  if (typeof appPath !== "string" || typeof testedUiDir !== "string") {
    fail("appPath and testedUiDir are required");
  }
  const expectedManifest = await createFrontendAssetManifest(testedUiDir);
  const stagedManifestPath = path.join(testedUiDir, "asset-manifest.json");
  await assertRegularFile(stagedManifestPath, "tested frontend asset manifest");
  const stagedManifest = await readFile(stagedManifestPath, "utf8");
  if (stagedManifest !== expectedManifest) fail("tested frontend asset manifest does not match its staged files");

  const bundledFrontend = path.join(appPath, "Contents", "Resources", "frontend");
  const bundledManifestPath = path.join(bundledFrontend, "asset-manifest.json");
  await assertRegularFile(bundledManifestPath, "app-bundled frontend asset manifest");
  const bundledManifest = await readFile(bundledManifestPath, "utf8");
  if (bundledManifest !== expectedManifest) fail("app-bundled frontend manifest differs from the tested staged candidate");
  const bundledFileManifest = await createFrontendAssetManifest(bundledFrontend);
  if (bundledFileManifest !== expectedManifest) fail("app-bundled frontend files differ from the tested staged candidate");

  const executableDirectory = path.join(appPath, "Contents", "MacOS");
  const appExecutable = path.join(executableDirectory, appExecutableName);
  await assertRegularFile(appExecutable, "app executable");
  const appBytes = await readFile(appExecutable);
  if (!appBytes.includes(Buffer.from(expectedManifest))) {
    fail("app executable does not embed the tested frontend asset manifest");
  }
  for (const [name, label] of [[appExecutableName, "app executable"], [helperExecutableName, "refresh helper"]]) {
    const executable = path.join(executableDirectory, name);
    await assertRegularFile(executable, label);
    const bytes = await readFile(executable);
    if (!allowTestOverrides && bytes.includes(TEST_OVERRIDES_MARKER)) {
      fail(`${label} contains the test-overrides marker`);
    }
  }
  const expectedFiles = JSON.parse(expectedManifest).files.length;
  const runtime = await runtimeVerifier(appExecutable);
  if (runtime.files !== expectedFiles) fail("bundled app embedded-asset count differs from the tested candidate");
  return { files: expectedFiles, runtimeVerified: true };
}

function parseArguments(args) {
  const parsed = {
    appPath: path.join(root, "src-tauri", "target", "release", "bundle", "macos", "Due Good.app"),
    testedUiDir: path.join(root, "dist", "public"),
    allowTestOverrides: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--app" && args[index + 1]) parsed.appPath = path.resolve(args[++index]);
    else if (args[index] === "--tested-ui-dir" && args[index + 1]) parsed.testedUiDir = path.resolve(args[++index]);
    else if (args[index] === "--allow-test-overrides") parsed.allowTestOverrides = true;
    else fail(`unknown or incomplete argument: ${args[index]}`);
  }
  return parsed;
}

export async function main(args = process.argv.slice(2)) {
  await assertStagedCandidate(root);
  const result = await verifyTauriAssets(parseArguments(args));
  console.log(`Verified ${result.files} bundled and runtime frontend asset(s) and release binaries.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`verify:tauri-assets: ${error.message}`);
    process.exitCode = 1;
  });
}
