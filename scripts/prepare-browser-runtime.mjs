#!/usr/bin/env node
/** Creates the fixed, self-contained Node runtime tree consumed by the signed macOS app. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BROWSER_RUNTIME_FORMAT = "duegood-browser-runtime";
export const BROWSER_RUNTIME_VERSION = 1;
export const BUNDLED_NODE_VERSION = "26.10.0";
export const STANDALONE_NODE_URL = "https://nodejs.org/dist/v26.10.0/node-v26.10.0-darwin-arm64.tar.gz";
export const STANDALONE_NODE_SHA256 = "751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9";
export const STANDALONE_NODE_ARCHIVE_BYTES = 58_175_384;
export const STANDALONE_NODE_PROVENANCE = Object.freeze({
  url: STANDALONE_NODE_URL,
  archiveSha256: STANDALONE_NODE_SHA256,
});
export const BROWSER_RUNTIME_ENTRYPOINT = "scripts/canvas-browser-app-refresh.mjs";
export const RUNTIME_PACKAGES = Object.freeze([
  "@esbuild/darwin-arm64", "esbuild", "pdfjs-dist", "playwright-core",
]);
export const RUNTIME_PACKAGE_PINS = Object.freeze({
  "@esbuild/darwin-arm64": "0.28.2",
  esbuild: "0.28.2",
  "pdfjs-dist": "6.3.289",
  "playwright-core": "1.63.0",
});
const PLAYWRIGHT_IMPORT_REWRITES = Object.freeze({
  "scripts/canvas-browser-probe.mjs": 'import { chromium } from "@playwright/test";',
  "scripts/canvas-browser-session.mjs": 'import { chromium } from "@playwright/test";',
});
const APPLE_PLATFORM = "darwin";
const MAX_RUNTIME_FILES = 15_000;
const MAX_RUNTIME_BYTES = 256 * 1024 * 1024;
const NODE_CACHE_RELATIVE = path.join(".cache", "duegood-browser-runtime", `node-v${BUNDLED_NODE_VERSION}-darwin-arm64`);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fail(message) {
  throw new Error(message);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertDirectory(directory, label) {
  const metadata = await lstat(directory).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) fail(`${label} must be a regular directory`);
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith(".")) return null;
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

async function collectSourceClosure(projectRoot) {
  const scriptsRoot = path.join(projectRoot, "scripts");
  const result = await build({
    entryPoints: [path.join(scriptsRoot, "canvas-browser-app-refresh.mjs")],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    external: ["@playwright/test", "playwright-core", "esbuild"],
    logLevel: "silent",
  });
  for (const item of Object.values(result.metafile.outputs).flatMap((output) => output.imports).filter((item) => item.external)) {
    const packageName = packageNameFromSpecifier(item.path);
    if (packageName !== null && !["@playwright/test", ...RUNTIME_PACKAGES].includes(packageName)) {
      fail(`browser runtime has an unpinned package import: ${packageName}`);
    }
  }
  return Object.keys(result.metafile.inputs).map((relative) => path.resolve(projectRoot, relative))
    .sort(compareText);
}

async function copyRegularTree(source, destination) {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) fail("browser runtime source contains a symlink");
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: metadata.mode & 0o777 });
    for (const entry of (await readdir(source)).sort()) {
      await copyRegularTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (!metadata.isFile()) fail("browser runtime source contains an unsupported filesystem entry");
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await cp(source, destination, { errorOnExist: true, force: false, preserveTimestamps: true });
  await chmod(destination, metadata.mode & 0o777);
}

async function walkPayload(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    if (relative === "" && entry.name === "manifest.json") continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(directory, entry.name);
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink()) fail("prepared browser runtime contains a symlink");
    if (metadata.isDirectory()) files.push(...await walkPayload(child, childRelative));
    else if (metadata.isFile()) {
      const bytes = await readFile(child);
      files.push({ path: childRelative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    } else fail("prepared browser runtime contains an unsupported filesystem entry");
  }
  return files;
}

/** Refuses missing, extra, linked, changed, or unpinned runtime payload bytes. */
export async function verifyBrowserRuntimeTree(directory, { expectedNodeVersion = BUNDLED_NODE_VERSION } = {}) {
  await assertDirectory(directory, "browser runtime");
  const manifestPath = path.join(directory, "manifest.json");
  const manifestStat = await lstat(manifestPath).catch(() => undefined);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) fail("browser runtime manifest is missing or unsafe");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.format !== BROWSER_RUNTIME_FORMAT || manifest.version !== BROWSER_RUNTIME_VERSION
      || manifest.nodeVersion !== expectedNodeVersion || manifest.entrypoint !== BROWSER_RUNTIME_ENTRYPOINT
      || JSON.stringify(manifest.nodeSource) !== JSON.stringify(STANDALONE_NODE_PROVENANCE)
      || !Array.isArray(manifest.packages) || !Array.isArray(manifest.files)) {
    fail("browser runtime manifest identity is invalid");
  }
  const expectedPackages = RUNTIME_PACKAGES.map((name) => ({ name, version: RUNTIME_PACKAGE_PINS[name] }))
    .sort((left, right) => compareText(left.name, right.name));
  if (manifest.packages.length !== expectedPackages.length
      || manifest.packages.some((item, index) => item?.name !== expectedPackages[index]?.name
        || item.version !== expectedPackages[index]?.version)) {
    fail("browser runtime package pin set is invalid");
  }
  if (manifest.files.length < 2 || manifest.files.length > MAX_RUNTIME_FILES) fail("browser runtime file inventory exceeds limits");
  const inventory = await walkPayload(directory);
  if (inventory.length !== manifest.files.length) fail("browser runtime file inventory differs from its manifest");
  let totalBytes = 0;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const listed = manifest.files[index];
    const actual = inventory[index];
    if (!listed || listed.path !== actual?.path || !/^[A-Za-z0-9_@./+-]+$/u.test(listed.path)
        || listed.path.startsWith("/") || listed.path.split("/").includes("..")
        || !Number.isSafeInteger(listed.size) || listed.size !== actual.size
        || typeof listed.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(listed.sha256)
        || listed.sha256 !== actual.sha256) fail("browser runtime file does not match its manifest");
    totalBytes += actual.size;
    if (totalBytes > MAX_RUNTIME_BYTES) fail("browser runtime size exceeds limits");
  }
  const nodeStat = await lstat(path.join(directory, "node"));
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || (nodeStat.mode & 0o111) === 0) {
    fail("browser runtime Node executable is not executable");
  }
  const nodeLicense = inventory.find((item) => item.path === "node-license.txt");
  if (!nodeLicense || nodeLicense.size === 0 || nodeLicense.size > 1024 * 1024) {
    fail("official Node license is missing or invalid");
  }
  for (const { name, version } of manifest.packages) {
    const packageManifest = JSON.parse(await readFile(path.join(directory, "node_modules", name, "package.json"), "utf8"));
    if (packageManifest.name !== name || packageManifest.version !== version) {
      fail(`bundled package manifest does not match its pin for ${name}`);
    }
  }
  return manifest;
}

/** Rehashes the two nested Mach-O files after Tauri signs them in their final bundle location. */
export async function refreshBrowserRuntimeManifest(directory) {
  await assertDirectory(directory, "browser runtime");
  const metadata = await lstat(path.join(directory, "manifest.json")).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) fail("browser runtime manifest is missing or unsafe");
  const before = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  const expectedPackages = RUNTIME_PACKAGES.map((name) => ({ name, version: RUNTIME_PACKAGE_PINS[name] }))
    .sort((left, right) => compareText(left.name, right.name));
  if (before.format !== BROWSER_RUNTIME_FORMAT || before.version !== BROWSER_RUNTIME_VERSION
      || before.nodeVersion !== BUNDLED_NODE_VERSION || before.entrypoint !== BROWSER_RUNTIME_ENTRYPOINT
      || JSON.stringify(before.nodeSource) !== JSON.stringify(STANDALONE_NODE_PROVENANCE)
      || JSON.stringify(before.packages) !== JSON.stringify(expectedPackages)) fail("browser runtime manifest identity is invalid");
  const files = await walkPayload(directory);
  const manifest = { ...before, files };
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return await verifyBrowserRuntimeTree(directory);
}

function readLockVersion(lock, name) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    fail(`package lock is missing a valid pin for ${name}`);
  }
  return version;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runFixed(command, args, { timeout = 30_000 } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { PATH: "" },
    stdio: "pipe",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail("pinned Node runtime verification failed");
  return result;
}

async function verifyStandaloneNode(nodePath) {
  const metadata = await lstat(nodePath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0) {
    fail("standalone Node executable is missing or unsafe");
  }
  const version = runFixed(nodePath, ["--version"], { timeout: 10_000 });
  if (version.stdout.trim() !== `v${BUNDLED_NODE_VERSION}` || version.stderr.trim() !== "") {
    fail("standalone Node executable does not match its fixed version");
  }
  const linkedLibraries = runFixed("/usr/bin/otool", ["-L", nodePath]).stdout.split(/\r?\n/u).slice(1)
    .map((line) => /^\s+(\S+)/u.exec(line)?.[1]).filter(Boolean);
  if (linkedLibraries.length === 0 || linkedLibraries.some((library) =>
    !library.startsWith("/System/Library/Frameworks/") && !library.startsWith("/usr/lib/"))) {
    fail("standalone Node links a non-system library");
  }
  return metadata;
}

async function downloadedNodeArchive(destination, onProgress = () => {}) {
  const response = await fetch(STANDALONE_NODE_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || response.url !== STANDALONE_NODE_URL
      || response.headers.get("content-length") !== String(STANDALONE_NODE_ARCHIVE_BYTES)
      || response.body === null) fail("official standalone Node artifact is unavailable or changed");
  let received = 0;
  let nextProgress = 10 * 1024 * 1024;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > STANDALONE_NODE_ARCHIVE_BYTES) return callback(new Error("NODE_ARCHIVE_SIZE_REJECTED"));
      if (received >= nextProgress) {
        onProgress(Math.min(100, Math.floor(received * 100 / STANDALONE_NODE_ARCHIVE_BYTES)));
        nextProgress += 10 * 1024 * 1024;
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  if (received !== STANDALONE_NODE_ARCHIVE_BYTES) fail("official standalone Node archive has the wrong length");
  const bytes = await readFile(destination);
  if (sha256(bytes) !== STANDALONE_NODE_SHA256) fail("official standalone Node archive checksum failed");
}

async function readValidNodeCache(cacheDirectory) {
  const directory = await lstat(cacheDirectory).catch(() => undefined);
  if (!directory) return undefined;
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail("standalone Node cache path is unsafe");
  const provenancePath = path.join(cacheDirectory, "provenance.json");
  const nodePath = path.join(cacheDirectory, "node");
  const licensePath = path.join(cacheDirectory, "node-license.txt");
  const [provenanceStat, nodeStat, licenseStat] = await Promise.all([provenancePath, nodePath, licensePath]
    .map((file) => lstat(file).catch(() => undefined)));
  if (![provenanceStat, nodeStat, licenseStat].every((stat) => stat?.isFile() && !stat.isSymbolicLink())
      || (nodeStat.mode & 0o111) === 0) fail("standalone Node cache files are incomplete or unsafe");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  const nodeBytes = await readFile(nodePath);
  const licenseBytes = await readFile(licensePath);
  if (provenance.schemaVersion !== 1 || provenance.nodeVersion !== BUNDLED_NODE_VERSION
      || provenance.url !== STANDALONE_NODE_URL || provenance.archiveSha256 !== STANDALONE_NODE_SHA256
      || provenance.nodeSha256 !== sha256(nodeBytes) || provenance.licenseSha256 !== sha256(licenseBytes)
      || licenseBytes.length === 0 || licenseBytes.length > 1024 * 1024) {
    fail("standalone Node cache provenance did not verify");
  }
  await verifyStandaloneNode(nodePath);
  return { nodePath, licensePath, nodeSha256: provenance.nodeSha256 };
}

/** Acquires only the public, checksum-pinned upstream Node archive and caches verified runtime inputs in project .cache. */
export async function resolveStandaloneNode(projectRoot = root, { onProgress = (percent) => console.log(`Node runtime download ${percent}%.`) } = {}) {
  if (process.platform !== APPLE_PLATFORM || process.arch !== "arm64") fail("browser runtime packaging requires Apple Silicon macOS");
  const cacheRoot = path.resolve(projectRoot, ".cache", "duegood-browser-runtime");
  const cacheDirectory = path.join(path.resolve(projectRoot), NODE_CACHE_RELATIVE);
  const projectCache = path.resolve(projectRoot, ".cache");
  const projectCacheMetadata = await lstat(projectCache).catch(() => undefined);
  if (projectCacheMetadata && (!projectCacheMetadata.isDirectory() || projectCacheMetadata.isSymbolicLink())) {
    fail("project cache root is unsafe");
  }
  await mkdir(projectCache, { recursive: true, mode: 0o700 });
  await assertDirectory(projectCache, "project cache root");
  const cacheRootMetadata = await lstat(cacheRoot).catch(() => undefined);
  if (cacheRootMetadata && (!cacheRootMetadata.isDirectory() || cacheRootMetadata.isSymbolicLink())) {
    fail("browser runtime cache path is unsafe");
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await assertDirectory(cacheRoot, "browser runtime cache");
  const cached = await readValidNodeCache(cacheDirectory);
  if (cached) return cached;

  const temporary = await mkdtemp(path.join(os.tmpdir(), "duegood-node-runtime-"));
  const stagedCache = path.join(cacheRoot, `.node-stage-${randomUUID()}`);
  try {
    const archive = path.join(temporary, "node-v26.10.0-darwin-arm64.tar.gz");
    const extracted = path.join(temporary, "extracted");
    await mkdir(extracted, { mode: 0o700 });
    console.log("Downloading the checksum-pinned Node.js 26.10.0 runtime.");
    await downloadedNodeArchive(archive, onProgress);
    const extraction = runFixed("/usr/bin/tar", [
      "-xzf", archive, "-C", extracted, "--strip-components=1",
      "node-v26.10.0-darwin-arm64/bin/node", "node-v26.10.0-darwin-arm64/LICENSE",
    ], { timeout: 90_000 });
    void extraction;
    const extractedNode = path.join(extracted, "bin", "node");
    const extractedLicense = path.join(extracted, "LICENSE");
    await verifyStandaloneNode(extractedNode);
    const nodeBytes = await readFile(extractedNode);
    const licenseBytes = await readFile(extractedLicense);
    if (licenseBytes.length === 0 || licenseBytes.length > 1024 * 1024) fail("official Node license is invalid");

    await mkdir(stagedCache, { mode: 0o700 });
    const stagedNode = path.join(stagedCache, "node");
    const stagedLicense = path.join(stagedCache, "node-license.txt");
    await copyFile(extractedNode, stagedNode);
    await copyFile(extractedLicense, stagedLicense);
    await chmod(stagedNode, 0o755);
    await writeFile(path.join(stagedCache, "provenance.json"), `${JSON.stringify({
      schemaVersion: 1,
      nodeVersion: BUNDLED_NODE_VERSION,
      url: STANDALONE_NODE_URL,
      archiveSha256: STANDALONE_NODE_SHA256,
      nodeSha256: sha256(nodeBytes),
      licenseSha256: sha256(licenseBytes),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await verifyStandaloneNode(stagedNode);
    const old = await lstat(cacheDirectory).catch(() => undefined);
    if (old && (!old.isDirectory() || old.isSymbolicLink())) fail("standalone Node cache path is unsafe");
    if (old) await rm(cacheDirectory, { recursive: true });
    await rename(stagedCache, cacheDirectory);
    return await readValidNodeCache(cacheDirectory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(stagedCache, { recursive: true, force: true });
  }
}

/** Builds a generated runtime tree with no dependency on the checkout at application runtime. */
export async function prepareBrowserRuntime({ projectRoot = root, destination = path.join(projectRoot, "dist", "browser-runtime") } = {}) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedDestination = path.resolve(destination);
  const distRoot = path.join(resolvedRoot, "dist");
  if (process.platform !== APPLE_PLATFORM || process.arch !== "arm64") fail("browser runtime packaging requires Apple Silicon macOS");
  if (!isInside(distRoot, resolvedDestination)) fail("browser runtime destination must be inside dist");
  const standalone = await resolveStandaloneNode(resolvedRoot);
  await assertDirectory(path.join(resolvedRoot, "scripts"), "project scripts");
  await assertDirectory(path.join(resolvedRoot, "node_modules"), "project dependencies");
  const lock = JSON.parse(await readFile(path.join(resolvedRoot, "package-lock.json"), "utf8"));
  const sourceFiles = await collectSourceClosure(resolvedRoot);
  const sourceRelatives = new Set(sourceFiles.map((source) => path.relative(resolvedRoot, source).split(path.sep).join("/")));
  const missingReviewedImports = Object.keys(PLAYWRIGHT_IMPORT_REWRITES).filter((relative) => !sourceRelatives.has(relative));
  if (missingReviewedImports.length > 0) fail("reviewed browser Playwright imports are missing from the source closure");
  const payloadParent = path.dirname(resolvedDestination);
  await assertDirectory(payloadParent, "browser runtime output parent");
  await rm(resolvedDestination, { recursive: true, force: true });
  await mkdir(resolvedDestination, { recursive: true, mode: 0o755 });

  try {
    await copyRegularTree(standalone.nodePath, path.join(resolvedDestination, "node"));
    await chmod(path.join(resolvedDestination, "node"), 0o755);
    await copyFile(standalone.licensePath, path.join(resolvedDestination, "node-license.txt"));
    await chmod(path.join(resolvedDestination, "node-license.txt"), 0o644);
    for (const source of sourceFiles) {
      const relative = path.relative(resolvedRoot, source).split(path.sep).join("/");
      let contents = await readFile(source);
      const text = contents.toString("utf8");
      const playwrightImportCount = text.split("@playwright/test").length - 1;
      const reviewedImport = PLAYWRIGHT_IMPORT_REWRITES[relative];
      if (reviewedImport !== undefined) {
        if (playwrightImportCount !== 1 || text.split(reviewedImport).length !== 2) {
          fail(`reviewed browser Playwright import changed unexpectedly in ${relative}`);
        }
        contents = Buffer.from(text.replace(reviewedImport, reviewedImport.replace("@playwright/test", "playwright-core")));
      } else if (playwrightImportCount > 0) {
        fail(`browser runtime has an unreviewed Playwright test import in ${relative}`);
      }
      const output = path.join(resolvedDestination, relative);
      await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
      await writeFile(output, contents, { mode: 0o644, flag: "wx" });
    }

    const packagePins = [];
    for (const name of RUNTIME_PACKAGES) {
      const version = readLockVersion(lock, name);
      if (version !== RUNTIME_PACKAGE_PINS[name]) fail(`package lock changed the fixed runtime pin for ${name}`);
      const source = path.join(resolvedRoot, "node_modules", name);
      const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
      if (manifest.name !== name || manifest.version !== version) fail(`installed package does not match the lock pin for ${name}`);
      packagePins.push({ name, version });
      await copyRegularTree(source, path.join(resolvedDestination, "node_modules", name));
    }
    const files = await walkPayload(resolvedDestination);
    if (!files.some((file) => file.path === "node")
        || !files.some((file) => file.path === BROWSER_RUNTIME_ENTRYPOINT)) {
      fail("prepared browser runtime is missing its fixed executable or entrypoint");
    }
    const manifest = {
      format: BROWSER_RUNTIME_FORMAT,
      version: BROWSER_RUNTIME_VERSION,
      nodeVersion: BUNDLED_NODE_VERSION,
      nodeSource: STANDALONE_NODE_PROVENANCE,
      entrypoint: BROWSER_RUNTIME_ENTRYPOINT,
      packages: packagePins.sort((left, right) => compareText(left.name, right.name)),
      files,
    };
    await writeFile(path.join(resolvedDestination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: "wx" });
    return await verifyBrowserRuntimeTree(resolvedDestination);
  } catch (error) {
    await rm(resolvedDestination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareBrowserRuntime().then((manifest) => {
    console.log(`Prepared ${manifest.files.length} fixed browser runtime file(s), Node ${manifest.nodeVersion}.`);
  }).catch((error) => {
    console.error(`prepare-browser-runtime: ${error.message}`);
    process.exitCode = 1;
  });
}
