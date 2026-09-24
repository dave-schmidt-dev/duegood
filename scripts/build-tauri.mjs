#!/usr/bin/env node
/**
 * Staged-only Tauri packaging. Builds the UI and its deterministic hash manifest before Cargo,
 * builds/signs the helper before bundling, then signs the app last. Use --prepare-only before
 * `cargo test` when a test runner needs the Tauri frontend assets but no signed app.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, writeFile, copyFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run as runTauriCli } from "@tauri-apps/cli";

export const MANIFEST_NAME = "asset-manifest.json";
export const MANIFEST_FORMAT = "duegood-frontend-assets";
export const TEST_BUNDLE_IDENTIFIER = "com.zerodelta.duegood.test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(-1200);
    fail(`${path.basename(command)} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

async function walkFiles(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(directory, entry.name);
    const stats = await lstat(child);
    if (stats.isSymbolicLink()) fail(`frontend asset tree contains a symlink: ${childRelative}`);
    if (stats.isDirectory()) files.push(...await walkFiles(child, childRelative));
    else if (stats.isFile()) files.push(childRelative);
    else fail(`frontend asset tree contains an unsupported file: ${childRelative}`);
  }
  return files;
}

/** Returns canonical manifest bytes for a frontend directory, excluding the manifest itself. */
export async function createFrontendAssetManifest(directory) {
  const fileNames = (await walkFiles(directory)).filter((name) => name !== MANIFEST_NAME).sort();
  if (fileNames.length === 0) fail("frontend asset directory is empty");
  const files = [];
  for (const name of fileNames) {
    const bytes = await readFile(path.join(directory, name));
    files.push({
      path: name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const manifest = { format: MANIFEST_FORMAT, version: 1, files };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Builds static UI files and writes the manifest consumed by Cargo and the verifier. */
export async function prepareFrontendAssets({ projectRoot = root, spawn = run } = {}) {
  spawn(process.execPath, [path.join(projectRoot, "scripts", "build-ui.mjs")], { cwd: projectRoot });
  const output = path.join(projectRoot, "dist", "public");
  const manifest = await createFrontendAssetManifest(output);
  await writeFile(path.join(output, MANIFEST_NAME), manifest, { mode: 0o644 });
  return manifest;
}

export function parseArguments(args) {
  let mode = "release";
  let prepareOnly = false;
  let sourceCheckout = process.env.DUEGOOD_SOURCE_CHECKOUT;
  let sourceDescribe;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--prepare-only") prepareOnly = true;
    else if (args[index] === "--test") mode = "test";
    else if (args[index] === "--source-checkout" && args[index + 1]) sourceCheckout = args[++index];
    else if (args[index] === "--source-describe" && args[index + 1]) sourceDescribe = args[++index];
    else fail(`unknown argument: ${args[index]}`);
  }
  if (sourceCheckout && sourceDescribe) fail("choose either --source-checkout or --source-describe");
  return { mode, prepareOnly, sourceCheckout, sourceDescribe };
}

function gitOutput(args) {
  return run("git", args, { stdio: "pipe" }).trim();
}

/** Refuses to build in the daily source checkout or from a modified stage. */
export async function assertStagedCandidate(projectRoot = root) {
  const receiptPath = path.join(projectRoot, "receipt.json");
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {
    fail("Tauri packaging must run in a private staged candidate (receipt.json is missing or invalid)");
  }
  if (receipt.schemaVersion !== 1 || typeof receipt.treeDigest !== "string" || !/^[0-9a-f]{40,64}$/.test(receipt.treeDigest)) {
    fail("staged candidate receipt is invalid");
  }
  const head = gitOutput(["rev-parse", "HEAD^{tree}"]);
  if (head !== receipt.treeDigest) fail("staged candidate commit no longer matches its receipt");
  const status = gitOutput(["status", "--porcelain", "--untracked-files=all"]);
  if (status) fail("Tauri packaging requires an unchanged staged candidate");
  return receipt;
}

async function ensureStageBinaryExcluded() {
  const excludePath = path.join(root, ".git", "info", "exclude");
  let old = "";
  try { old = await readFile(excludePath, "utf8"); } catch { /* git has a default empty exclude file */ }
  const entry = "/src-tauri/binaries/duegood-refresh-*";
  if (!old.split(/\r?\n/).includes(entry)) {
    await mkdir(path.dirname(excludePath), { recursive: true });
    await writeFile(excludePath, `${old}${old.endsWith("\n") || old.length === 0 ? "" : "\n"}${entry}\n`, { mode: 0o600 });
  }
}

function targetTriple() {
  return run("rustc", ["--print", "host-tuple"], { stdio: "pipe" }).trim();
}

function executableExtension() {
  return process.platform === "win32" ? ".exe" : "";
}

async function ensureSidecarBuildInput() {
  await ensureStageBinaryExcluded();
  const target = path.join(root, "src-tauri", "binaries", `duegood-refresh-${targetTriple()}${executableExtension()}`);
  try {
    await lstat(target);
  } catch {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const placeholder = process.platform === "win32" ? Buffer.from([0x4d, 0x5a]) : Buffer.from("#!/bin/sh\nexit 1\n");
    await writeFile(target, placeholder, { mode: 0o700, flag: "wx" });
    await chmod(target, 0o700);
  }
}

async function buildTestSidecar() {
  await ensureSidecarBuildInput();
  const triple = targetTriple();
  const extension = executableExtension();
  run("cargo", ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--features", "test-overrides", "--bin", "duegood-refresh"]);
  const source = path.join(root, "src-tauri", "target", "debug", `duegood-refresh${extension}`);
  const target = path.join(root, "src-tauri", "binaries", `duegood-refresh-${triple}${extension}`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target);
  await chmod(target, 0o700);
  if (process.platform === "darwin") codesign(["--force", "--sign", "-", target]);
}

function codesign(args) {
  run("/usr/bin/codesign", args);
}

function verifyDeveloperIdAuthority(file, identity) {
  const result = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", file], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) fail(`could not inspect the signed ${path.basename(file)}`);
  const expectedValues = new Set([identity, identity.replace(/\s+\([A-Z0-9]+\)$/, "")]);
  const authority = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split(/\r?\n/)
    .find((line) => line.startsWith("Authority="))
    ?.slice("Authority=".length);
  if (!authority || !expectedValues.has(authority) || !authority.startsWith("Developer ID Application:")) {
    fail(`${path.basename(file)} is not signed by the configured Developer ID Application identity`);
  }
}

function signFile(file, identity) {
  const signingArgs = ["--force", "--options", "runtime", "--timestamp"];
  signingArgs.push("--sign", identity, file);
  codesign(signingArgs);
  codesign(["--verify", "--strict", file]);
  verifyDeveloperIdAuthority(file, identity);
}

function signAppAdhoc(appPath) {
  const executableDirectory = path.join(appPath, "Contents", "MacOS");
  for (const executable of ["duegood-desktop", "duegood-refresh"]) {
    const executablePath = path.join(executableDirectory, executable);
    if (process.platform === "darwin") codesign(["--force", "--sign", "-", executablePath]);
  }
  if (process.platform === "darwin") {
    codesign(["--force", "--sign", "-", appPath]);
    codesign(["--verify", "--strict", appPath]);
  }
}

export function buildStamp({ sourceRevision, candidateTree }) {
  if (typeof sourceRevision !== "string" || sourceRevision.length === 0 || sourceRevision.length > 256 || /[\r\n]/.test(sourceRevision)) {
    fail("source revision stamp must be a single non-empty line");
  }
  if (typeof candidateTree !== "string" || !/^[0-9a-f]{40,64}$/.test(candidateTree)) {
    fail("candidate tree stamp must be a Git tree digest");
  }
  return `${JSON.stringify({ schemaVersion: 1, sourceRevision, candidateTree }, null, 2)}\n`;
}

function getSourceRevision({ sourceCheckout, sourceDescribe }) {
  if (sourceDescribe) return sourceDescribe;
  if (!sourceCheckout) fail("set DUEGOOD_SOURCE_CHECKOUT to the original source checkout for build stamping");
  return run("git", ["describe", "--always", "--dirty"], { cwd: path.resolve(sourceCheckout), stdio: "pipe" }).trim();
}

function ensureNoTestMarker(file) {
  const result = run("strings", ["-a", file], { stdio: "pipe" });
  if (result.includes("test-overrides")) fail(`release executable contains the test-overrides marker: ${path.basename(file)}`);
}

async function packageTauri(mode, receipt, options) {
  if (process.platform !== "darwin") fail("signed Tauri app packaging currently requires macOS");
  const identity = mode === "release" ? process.env.APPLE_SIGNING_IDENTITY?.trim() : undefined;
  if (mode === "release" && !identity) fail("set APPLE_SIGNING_IDENTITY to the installed Developer ID Application identity");
  if (mode === "release" && !identity.startsWith("Developer ID Application:")) {
    fail("APPLE_SIGNING_IDENTITY must name a Developer ID Application identity");
  }
  const stamp = buildStamp({
    sourceRevision: getSourceRevision(options),
    candidateTree: receipt.treeDigest,
  });
  await ensureSidecarBuildInput();

  const featureArgs = mode === "test" ? ["--features", "test-overrides"] : [];
  const profile = mode === "test" ? "debug" : "release";
  run("cargo", ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "duegood-refresh", ...featureArgs, ...(mode === "release" ? ["--release"] : [])]);

  const triple = targetTriple();
  if (!triple.endsWith("-apple-darwin")) fail(`unsupported macOS Rust target: ${triple}`);
  const extension = executableExtension();
  const helperSource = path.join(root, "src-tauri", "target", profile, `duegood-refresh${extension}`);
  const helperTarget = path.join(root, "src-tauri", "binaries", `duegood-refresh-${triple}${extension}`);
  await mkdir(path.dirname(helperTarget), { recursive: true, mode: 0o700 });
  await copyFile(helperSource, helperTarget);
  await chmod(helperTarget, 0o700);
  if (mode === "release") signFile(helperTarget, identity);
  else codesign(["--force", "--sign", "-", helperTarget]);

  const overlayPath = path.join(root, "src-tauri", `.tauri-${mode}-build.conf.json`);
  const overlay = mode === "test" ? { identifier: TEST_BUNDLE_IDENTIFIER } : {};
  await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 });
  try {
    const args = ["build", "--bundles", "app", "--no-sign", "--config", overlayPath];
    if (mode === "test") args.push("--debug", "--features", "test-overrides");
    await runTauriCli(args, "tauri");
  } finally {
    await rm(overlayPath, { force: true });
  }

  const appPath = path.join(root, "src-tauri", "target", profile, "bundle", "macos", "Due Good.app");
  const appExecutable = path.join(appPath, "Contents", "MacOS", "duegood-desktop");
  const bundledHelper = path.join(appPath, "Contents", "MacOS", "duegood-refresh");
  for (const executable of [appExecutable, bundledHelper]) {
    try { await lstat(executable); } catch { fail(`Tauri app is missing expected executable ${path.basename(executable)}`); }
  }
  const stampPath = path.join(appPath, "Contents", "Resources", "duegood-build.json");
  await writeFile(stampPath, stamp, { mode: 0o644 });
  const assetVerifier = path.join(root, "scripts", "verify-tauri-assets.mjs");
  const verifyArgs = [assetVerifier, "--app", appPath];
  if (mode === "test") verifyArgs.push("--allow-test-overrides");
  run(process.execPath, verifyArgs);
  if (mode === "release") {
    // Tauri may re-sign the copied sidecar while bundling, so sign the final bundled bytes.
    signFile(bundledHelper, identity);
    for (const executable of [appExecutable, bundledHelper]) ensureNoTestMarker(executable);
    signFile(appPath, identity);
  } else {
    signAppAdhoc(appPath);
  }
  run(process.execPath, verifyArgs);
  console.log(`Built ${mode} Tauri app at ${path.relative(root, appPath)}.`);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const receipt = await assertStagedCandidate(root);
  await prepareFrontendAssets();
  if (options.prepareOnly && options.mode === "test") await buildTestSidecar();
  if (!options.prepareOnly) await packageTauri(options.mode, receipt, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`build:tauri: ${error.message}`);
    process.exitCode = 1;
  });
}
