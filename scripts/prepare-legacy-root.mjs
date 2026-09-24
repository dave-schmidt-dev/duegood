#!/usr/bin/env node
/**
 * Copies the supported Due Good legacy layout into a new private folder. Only importer-classified
 * root/course entries and Finder metadata files are omitted. Everything inside a recognized layout
 * subtree is preserved, even when the importer would refuse it.
 *
 * Usage: node scripts/prepare-legacy-root.mjs --source <dir> --destination <new-dir>
 * Output contains counts only; no entry names, paths, or file contents are printed.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_LOCK_DIR = "coursework.json.duegood-lock";
const ROOT_FILES = new Set([
  "coursework.json",
  "coursework-refresh-history.json",
  "canvas-profile.json",
  "courses.json",
  "canvas-conversations.json",
  "canvas-inbox.json",
]);
const COURSE_REPORTS = new Set(["coursework.md", "canvas-course-report.md"]);
const ROOT_DIR = "classes";
const EXPORT_DIR = "canvas-export";
const MATERIALS_DIR = "materials";
const OS_METADATA = ".DS_Store";
const COPY_BUFFER_BYTES = 256 * 1024;
const FILE_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const PRIVATE_PARENT_ERROR = "destination parent is not private";

class PreparationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new PreparationError(code);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isCourseFolder(name) {
  return name.length > 0 && /^[a-z0-9-]+$/.test(name);
}

function isPlainBasename(name) {
  return name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function isHistoryQuarantine(name) {
  return /^coursework-refresh-history\.json\.corrupt-[0-9]+-[0-9a-f]{8}\.json$/.test(name);
}

function isLeftoverTemp(name) {
  return name.length > 5 && name.startsWith(".") && (name.endsWith(".tmp") || name.endsWith(".bak"));
}

function isStaleLockRemnant(name) {
  return name.length > LEGACY_LOCK_DIR.length + 7 && name.startsWith(`${LEGACY_LOCK_DIR}.`) && name.endsWith(".stale");
}

function posixRelative(value) {
  return value.split(path.sep).join("/");
}

async function exists(pathname) {
  try {
    return await lstat(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("io-error");
  }
}

async function verifyPrivateDirectory(pathname) {
  let info;
  try {
    info = await lstat(pathname);
  } catch {
    fail(PRIVATE_PARENT_ERROR);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail(PRIVATE_PARENT_ERROR);
  if (process.getuid && info.uid !== process.getuid() && info.uid !== 0) fail(PRIVATE_PARENT_ERROR);
  if ((info.mode & 0o022) !== 0) fail(PRIVATE_PARENT_ERROR);
}

/** Creates missing parent components privately and refuses any symlink or shared writable parent. */
async function createPrivateDestination(destination, realSource) {
  const absolute = path.resolve(destination);
  if (!path.isAbsolute(absolute) || path.basename(absolute) === "" || absolute === path.parse(absolute).root) {
    fail("invalid-destination");
  }
  if (await exists(absolute)) fail("destination-exists");
  if (isWithin(realSource, absolute) || isWithin(absolute, realSource)) fail("overlapping-paths");

  const createdParents = [];
  let destinationCreated = false;
  try {
    const parent = path.dirname(absolute);
    const root = path.parse(parent).root;
    const parts = path.relative(root, parent).split(path.sep).filter(Boolean);
    let current = root;
    await verifyPrivateDirectory(current);
    for (const part of parts) {
      const next = path.join(current, part);
      const info = await exists(next);
      if (info) {
        await verifyPrivateDirectory(next);
      } else {
        await mkdir(next, { mode: 0o700 });
        await chmod(next, 0o700);
        await verifyPrivateDirectory(next);
        createdParents.push(next);
      }
      current = next;
    }
    await verifyPrivateDirectory(current);
    await mkdir(absolute, { mode: 0o700 });
    destinationCreated = true;
    await chmod(absolute, 0o700);
    const created = await lstat(absolute).catch(() => null);
    if (!created || created.isSymbolicLink() || !created.isDirectory() || (process.getuid && created.uid !== process.getuid())) {
      fail("destination-changed");
    }
    return { path: absolute, createdParents };
  } catch (error) {
    if (destinationCreated) await rm(absolute, { recursive: true, force: true }).catch(() => {});
    for (const parent of createdParents.reverse()) await rm(parent, { recursive: false, force: true }).catch(() => {});
    throw error;
  }
}

async function checkedNames(directory) {
  let names;
  try {
    names = await readdir(directory, { encoding: "buffer" });
  } catch {
    fail("io-error");
  }
  return names.map((name) => {
    const decoded = name.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(name)) fail("unsupported-source-name");
    return decoded;
  }).sort();
}

async function readAvatarName(root) {
  const profile = path.join(root, "canvas-profile.json");
  let handle;
  try {
    handle = await open(profile, FILE_OPEN_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024) return null;
    const value = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    const name = value?.avatar?.path;
    return typeof name === "string" && isPlainBasename(name) && name !== "coursework.json" ? name : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function sourceNode(root, relative) {
  const pathname = path.join(root, relative);
  const info = await exists(pathname);
  if (!info) fail("source-changed");
  const normalized = posixRelative(relative);
  if (info.isDirectory()) return { relative: normalized, pathname, type: "directory" };
  if (info.isSymbolicLink()) {
    let target;
    try {
      target = await readlink(pathname, { encoding: "buffer" });
    } catch {
      fail("source-changed");
    }
    return { relative: normalized, pathname, type: "symlink", target };
  }
  if (info.isFile()) return { relative: normalized, pathname, type: "file" };
  return { relative: normalized, pathname, type: "special" };
}

async function appendWholeTree(root, relative, nodes, omitted) {
  const node = await sourceNode(root, relative);
  if (node.type === "file" && path.basename(relative) === OS_METADATA) {
    omitted.osMetadataFiles += 1;
    return;
  }
  if (node.type === "special") fail("unsupported-preserved-entry-type");
  nodes.push(node);
  if (node.type !== "directory") return;
  for (const name of await checkedNames(node.pathname)) {
    await appendWholeTree(root, path.join(relative, name), nodes, omitted);
  }
}

async function appendEntry(root, name, nodes, omitted) {
  await appendWholeTree(root, name, nodes, omitted);
}

async function scanCourse(root, relative, nodes, omitted) {
  const coursePath = path.join(root, relative);
  nodes.push(await sourceNode(root, relative));
  for (const name of await checkedNames(coursePath)) {
    const entryPath = path.join(relative, name);
    const entry = await sourceNode(root, entryPath);
    if (name === OS_METADATA && entry.type === "file") {
      omitted.osMetadataFiles += 1;
    } else if ((name === EXPORT_DIR || name === MATERIALS_DIR) && entry.type === "directory") {
      await appendWholeTree(root, entryPath, nodes, omitted);
    } else if (COURSE_REPORTS.has(name) && entry.type === "file") {
      nodes.push(entry);
    } else if (entry.type === "symlink" || isLeftoverTemp(name)) {
      if (entry.type === "special") fail("unsupported-preserved-entry-type");
      nodes.push(entry);
    } else {
      omitted.unsupportedCourseEntries += 1;
    }
  }
}

async function scanClasses(root, nodes, omitted) {
  const classesPath = path.join(root, ROOT_DIR);
  nodes.push(await sourceNode(root, ROOT_DIR));
  for (const name of await checkedNames(classesPath)) {
    const relative = path.join(ROOT_DIR, name);
    const entry = await sourceNode(root, relative);
    if (entry.type === "directory") {
      if (isCourseFolder(name)) await scanCourse(root, relative, nodes, omitted);
      else omitted.invalidCourseFolderNames += 1;
    } else if (name === OS_METADATA && entry.type === "file") {
      omitted.osMetadataFiles += 1;
    } else if (entry.type === "symlink" || isLeftoverTemp(name)) {
      if (entry.type === "special") fail("unsupported-preserved-entry-type");
      nodes.push(entry);
    } else {
      omitted.unsupportedCourseEntries += 1;
    }
  }
}

async function scanSource(root) {
  const nodes = [];
  const omitted = {
    unsupportedRootEntries: 0,
    unsupportedCourseEntries: 0,
    invalidCourseFolderNames: 0,
    osMetadataFiles: 0,
  };
  const avatar = await readAvatarName(root);
  for (const name of await checkedNames(root)) {
    const entry = await sourceNode(root, name);
    if (name === OS_METADATA && entry.type === "file") {
      omitted.osMetadataFiles += 1;
    } else if (name === ROOT_DIR && entry.type === "directory") {
      await scanClasses(root, nodes, omitted);
    } else if (ROOT_FILES.has(name) || isHistoryQuarantine(name) || name === avatar) {
      await appendEntry(root, name, nodes, omitted);
    } else if (entry.type === "symlink" || isLeftoverTemp(name) || isStaleLockRemnant(name)) {
      if (entry.type === "special") fail("unsupported-preserved-entry-type");
      nodes.push(entry);
    } else {
      omitted.unsupportedRootEntries += 1;
    }
  }
  return { nodes, omitted };
}

async function hashFile(pathname) {
  let handle;
  try {
    handle = await open(pathname, FILE_OPEN_FLAGS);
    const info = await handle.stat();
    if (!info.isFile()) fail("source-changed");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { size, digest: hash.digest("hex"), device: info.dev, inode: info.ino };
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail("source-changed");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function digestNodes(nodes) {
  const digest = createHash("sha256");
  const files = new Map();
  for (const node of [...nodes].sort((a, b) => a.relative.localeCompare(b.relative))) {
    digest.update(node.type);
    digest.update("\0");
    digest.update(node.relative);
    digest.update("\0");
    if (node.type === "file") {
      const file = await hashFile(node.pathname);
      files.set(node.relative, file);
      digest.update(`${file.size}\0${file.digest}\0`);
    } else if (node.type === "symlink") {
      digest.update(node.target);
      digest.update("\0");
    }
  }
  return { digest: digest.digest("hex"), files };
}

async function copyFileVerified(source, destination, expected) {
  let input;
  let output;
  try {
    input = await open(source, FILE_OPEN_FLAGS);
    const sourceInfo = await input.stat();
    if (!sourceInfo.isFile() || sourceInfo.dev !== expected.device || sourceInfo.ino !== expected.inode) fail("source-changed");
    output = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
    let size = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, null);
        written += result.bytesWritten;
      }
    }
    await output.sync();
    await output.chmod(0o600);
    if (size !== expected.size || hash.digest("hex") !== expected.digest) fail("source-changed");
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail("io-error");
  } finally {
    await input?.close().catch(() => {});
    await output?.close().catch(() => {});
  }
}

async function copyNodes(source, destination, nodes, expectedFiles) {
  const ordered = [...nodes].sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.relative.localeCompare(b.relative);
  });
  for (const node of ordered) {
    const target = path.join(destination, node.relative);
    if (node.type === "directory") {
      await mkdir(target, { mode: 0o700 });
      await chmod(target, 0o700);
    } else if (node.type === "symlink") {
      try {
        await symlink(node.target, target);
      } catch {
        fail("io-error");
      }
    } else {
      const expected = expectedFiles.get(node.relative);
      if (!expected) fail("source-changed");
      await copyFileVerified(node.pathname, target, expected);
    }
  }
}

function assertNoLegacyLock(info) {
  if (info) fail("legacy-lock-busy");
}

/**
 * Copy a legacy root to a new private destination. Source bytes and layout are only read.
 * @param {{source: string, destination: string}} options
 */
export async function prepareLegacyRoot({ source, destination } = {}) {
  if (typeof source !== "string" || typeof destination !== "string" || source.length === 0 || destination.length === 0) {
    fail("invalid-arguments");
  }
  let realSource;
  try {
    realSource = await realpath(path.resolve(source));
    if (!(await lstat(realSource)).isDirectory()) fail("source-unavailable");
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail("source-unavailable");
  }
  assertNoLegacyLock(await exists(path.join(realSource, LEGACY_LOCK_DIR)));
  const beforeScan = await scanSource(realSource);
  const beforeDigest = await digestNodes(beforeScan.nodes);
  let privateDestination;
  try {
    privateDestination = await createPrivateDestination(destination, realSource);
    await copyNodes(realSource, privateDestination.path, beforeScan.nodes, beforeDigest.files);
    assertNoLegacyLock(await exists(path.join(realSource, LEGACY_LOCK_DIR)));
    const afterScan = await scanSource(realSource);
    const afterDigest = await digestNodes(afterScan.nodes);
    assertNoLegacyLock(await exists(path.join(realSource, LEGACY_LOCK_DIR)));
    if (beforeDigest.digest !== afterDigest.digest) fail("source-changed");
    if (JSON.stringify(beforeScan.omitted) !== JSON.stringify(afterScan.omitted)) fail("source-changed");
    return {
      copiedFiles: beforeScan.nodes.filter((node) => node.type === "file").length,
      copiedDirectories: beforeScan.nodes.filter((node) => node.type === "directory").length,
      copiedSymlinks: beforeScan.nodes.filter((node) => node.type === "symlink").length,
      omitted: beforeScan.omitted,
    };
  } catch (error) {
    if (privateDestination) {
      await rm(privateDestination.path, { recursive: true, force: true }).catch(() => {});
      for (const parent of privateDestination.createdParents.reverse()) await rm(parent, { recursive: false, force: true }).catch(() => {});
    }
    if (error instanceof PreparationError) throw error;
    fail("io-error");
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key !== "--source" && key !== "--destination") fail("invalid-arguments");
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || options[key]) fail("invalid-arguments");
    options[key] = value;
    index += 1;
  }
  if (!options["--source"] || !options["--destination"]) fail("invalid-arguments");
  return { source: options["--source"], destination: options["--destination"] };
}

async function main() {
  try {
    const result = await prepareLegacyRoot(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof PreparationError ? error.code : "io-error";
    process.stderr.write(`Legacy root preparation failed (${code}). No source content was printed.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
