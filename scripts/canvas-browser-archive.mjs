import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, statfs, unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  collectCanvasBlobReceipts,
  copyCanvasBlob,
  MAX_BLOB_BYTES,
  verifyStagedCanvasBlob,
  verifyStoredCanvasBlob,
} from "./canvas-browser-archive-blobs.mjs";

const ORIGIN = "https://marymount.instructure.com";
const ARCHIVE_NAME = "canvas-capture-archive";
const ARCHIVE_FORMAT = "duegood-canvas-capture-generation";
const POINTER_FORMAT = "duegood-canvas-capture-current";
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_GENERATION_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_GENERATIONS = 1000;
const MIN_FREE_BYTES = 64 * 1024 * 1024;
const STALE_TEMP_MS = 2 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{32}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SENSITIVE_KEY = /(?:access[_-]?token|verifier|signature|private[_-]?url|calendar.*(?:feed|ics)|(?:feed|ics).*(?:url|token)|credential|password)/iu;
const SIGNED_URL = /[?&](?:access[_-]?token|token|verifier|signature|sig|expires|download_frd|x-amz-[^=]*)=/iu;

function archiveError(code) {
  return Object.assign(new Error(code), { code });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw archiveError("CANCELED");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uid() {
  if (typeof process.getuid !== "function") throw archiveError("UNSUPPORTED_PLATFORM");
  return process.getuid();
}

function validateDirectoryStat(stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o7777) !== 0o700) {
    throw archiveError("UNSAFE_DIRECTORY");
  }
}

function validateFileStat(stat, maxBytes = Number.MAX_SAFE_INTEGER) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o7777) !== 0o600
      || stat.nlink !== 1 || stat.size > maxBytes) throw archiveError("UNSAFE_FILE");
}

async function inspectDirectory(directory) {
  const absolute = path.resolve(directory);
  const stat = await lstat(absolute).catch(() => undefined);
  if (!stat) throw archiveError("UNSAFE_DIRECTORY");
  validateDirectoryStat(stat);
  if (await realpath(absolute) !== absolute) throw archiveError("UNSAFE_DIRECTORY");
  return { path: absolute, dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

async function verifyDirectory(identity) {
  const stat = await lstat(identity.path).catch(() => undefined);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev
      || stat.ino !== identity.ino || stat.uid !== identity.uid || (stat.mode & 0o7777) !== 0o700) {
    throw archiveError("UNSAFE_DIRECTORY");
  }
}

async function ensurePrivateChild(parent, name) {
  const directory = path.join(parent.path, name);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw archiveError("ARCHIVE_CREATE_FAILED");
  }
  if (created) await chmod(directory, 0o700).catch(() => { throw archiveError("ARCHIVE_CREATE_FAILED"); });
  const identity = await inspectDirectory(directory);
  await verifyDirectory(parent);
  return identity;
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writePrivateFile(target, bytes) {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(target, flags, 0o600).catch(() => { throw archiveError("ARCHIVE_WRITE_FAILED"); });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
    validateFileStat(await handle.stat());
  } finally {
    await handle.close();
  }
}

function rejectPrivateValues(value, depth = 0) {
  if (depth > 40) throw archiveError("INVALID_SNAPSHOT");
  if (Array.isArray(value)) {
    for (const item of value) rejectPrivateValues(item, depth + 1);
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === "string" && SIGNED_URL.test(value)) throw archiveError("PRIVATE_VALUE_REJECTED");
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw archiveError("PRIVATE_VALUE_REJECTED");
    rejectPrivateValues(child, depth + 1);
  }
}

function validateSnapshot(snapshot) {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== 2 || snapshot.source !== "canvas-browser"
      || !Number.isSafeInteger(snapshot.runId) || snapshot.runId <= 0
      || typeof snapshot.generationId !== "string" || !/^[a-f0-9]{32}$/u.test(snapshot.generationId)
      || snapshot.complete !== false || !isRecord(snapshot.identity) || snapshot.identity.origin !== ORIGIN
      || !Number.isSafeInteger(snapshot.identity.userId) || snapshot.identity.userId <= 0
      || !isRecord(snapshot.activeCourses) || snapshot.activeCourses.complete !== true
      || !Array.isArray(snapshot.activeCourses.courseIds)
      || snapshot.activeCourses.courseIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(snapshot.activeCourses.courseIds).size !== snapshot.activeCourses.courseIds.length
      || !isRecord(snapshot.coverageRequirements) || snapshot.coverageRequirements.activeCoursesComplete !== true
      || JSON.stringify(snapshot.coverageRequirements.perActiveCourse)
        !== JSON.stringify(["course", "assignments", "assignmentGroups", "submissions"])
      || typeof snapshot.capturedAt !== "string" || Number.isNaN(Date.parse(snapshot.capturedAt))
      || !Array.isArray(snapshot.resources) || !Array.isArray(snapshot.coverage)) throw archiveError("INVALID_SNAPSHOT");
  const activeResource = snapshot.resources.find((resource) => resource?.endpoint === "coursesActive" && resource.courseId === null);
  if (!activeResource || !Array.isArray(activeResource.items)
      || JSON.stringify(activeResource.items.map((item) => item?.id).sort((a, b) => a - b))
        !== JSON.stringify([...snapshot.activeCourses.courseIds].sort((a, b) => a - b))) {
    throw archiveError("ACTIVE_COURSE_INVENTORY_MISMATCH");
  }
  const completeCoverage = new Set(snapshot.coverage
    .filter((entry) => entry?.status === "complete")
    .map((entry) => `${entry.endpoint}:${entry.courseId ?? "account"}`));
  if (!completeCoverage.has("coursesActive:account")
      || snapshot.activeCourses.courseIds.some((courseId) =>
        snapshot.coverageRequirements.perActiveCourse.some((endpoint) => !completeCoverage.has(`${endpoint}:${courseId}`)))) {
    throw archiveError("REQUIRED_COURSE_COVERAGE_INCOMPLETE");
  }
  rejectPrivateValues(snapshot);
  let bytes;
  try { bytes = Buffer.from(JSON.stringify(snapshot) + "\n", "utf8"); } catch { throw archiveError("INVALID_SNAPSHOT"); }
  if (bytes.length > MAX_SNAPSHOT_BYTES) throw archiveError("SNAPSHOT_TOO_LARGE");
  return bytes;
}

function createArchivedSnapshot(snapshot, receipts) {
  const archived = JSON.parse(JSON.stringify(snapshot));
  const receiptByFileId = new Map(receipts.map((receipt) => [receipt.fileId, receipt]));
  for (const resource of archived.resources) {
    if (resource?.endpoint !== "fileBodies" || !Array.isArray(resource.items)) continue;
    for (const item of resource.items) {
      if (item?.status !== "staged") continue;
      const receipt = receiptByFileId.get(item.fileId);
      if (!receipt || receipt.stagedFile !== item.stagedFile) throw archiveError("INVALID_BLOB_RECEIPT");
      item.status = "archived";
      item.sha256 = receipt.sha256;
      delete item.stagedFile;
    }
  }
  return archived;
}

async function safeReadJson(target, maxBytes) {
  const before = await lstat(target).catch(() => undefined);
  if (!before) return undefined;
  validateFileStat(before, maxBytes);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw archiveError("UNSAFE_FILE");
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw archiveError("ARCHIVE_STATE_INVALID");
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw archiveError("ARCHIVE_STATE_INVALID"); }
  } finally {
    await handle.close();
  }
}

async function validateCurrent(root) {
  const pointer = await safeReadJson(path.join(root.path, "current.json"), 4096);
  if (pointer === undefined) return null;
  if (!isRecord(pointer) || pointer.format !== POINTER_FORMAT || ![1, 2].includes(pointer.version)
      || !UUID.test(pointer.generationId)
      || (pointer.version === 2 && (!Number.isSafeInteger(pointer.runId) || pointer.runId <= 0
        || !HASH.test(pointer.snapshotSha256)))) throw archiveError("ARCHIVE_STATE_INVALID");
  const generations = await inspectDirectory(path.join(root.path, "generations"));
  const generation = await inspectDirectory(path.join(generations.path, pointer.generationId));
  const manifest = await safeReadJson(path.join(generation.path, "manifest.json"), MAX_SNAPSHOT_BYTES);
  if (!isRecord(manifest) || manifest.format !== ARCHIVE_FORMAT || manifest.version !== pointer.version
      || manifest.generationId !== pointer.generationId || !HASH.test(manifest.snapshotSha256)
      || !Number.isSafeInteger(manifest.snapshotBytes) || manifest.snapshotBytes <= 0
      || (pointer.version === 2 && (manifest.runId !== pointer.runId
        || manifest.snapshotSha256 !== pointer.snapshotSha256))) {
    throw archiveError("ARCHIVE_STATE_INVALID");
  }
  const snapshotPath = path.join(generation.path, "snapshot.json");
  const snapshotStat = await lstat(snapshotPath).catch(() => undefined);
  if (!snapshotStat) throw archiveError("ARCHIVE_STATE_INVALID");
  validateFileStat(snapshotStat, MAX_SNAPSHOT_BYTES);
  const snapshot = await readFile(snapshotPath).catch(() => { throw archiveError("ARCHIVE_STATE_INVALID"); });
  if (snapshot.length !== manifest.snapshotBytes
      || createHash("sha256").update(snapshot).digest("hex") !== manifest.snapshotSha256) {
    throw archiveError("ARCHIVE_STATE_INVALID");
  }
  if (pointer.version === 2) {
    let parsed;
    try { parsed = JSON.parse(snapshot.toString("utf8")); } catch { throw archiveError("ARCHIVE_STATE_INVALID"); }
    if (!isRecord(parsed) || parsed.schemaVersion !== 2 || parsed.runId !== pointer.runId
      || parsed.generationId !== pointer.generationId
      || parsed.identity?.origin !== ORIGIN
        || !Number.isSafeInteger(parsed.identity?.userId) || parsed.identity.userId <= 0
        || !isRecord(manifest.identity) || manifest.identity.origin !== ORIGIN
        || parsed.identity.userId !== manifest.identity.userId) {
      throw archiveError("ARCHIVE_STATE_INVALID");
    }
  }
  return pointer.generationId;
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw archiveError("ARCHIVE_LOCK_INVALID");
  }
}

async function acquireLock(root) {
  const lockPath = path.join(root.path, ".writer-lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw archiveError("ARCHIVE_CREATE_FAILED");
    }
    if (created) {
      try {
        await chmod(lockPath, 0o700);
        const identity = await inspectDirectory(lockPath);
        const owner = { pid: process.pid, token, startedAt: new Date().toISOString() };
        await writePrivateFile(path.join(lockPath, "owner.json"), Buffer.from(JSON.stringify(owner) + "\n"));
        await syncDirectory(lockPath);
        return { path: lockPath, identity, token };
      } catch {
        await unlink(path.join(lockPath, "owner.json")).catch(() => undefined);
        await rmdir(lockPath).catch(() => undefined);
        throw archiveError("ARCHIVE_CREATE_FAILED");
      }
    }
    const identity = await inspectDirectory(lockPath);
    const entries = await readdir(identity.path);
    if (entries.length !== 1 || entries[0] !== "owner.json") throw archiveError("ARCHIVE_BUSY");
    const owner = await safeReadJson(path.join(identity.path, "owner.json"), 4096);
    if (!isRecord(owner) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.token !== "string" || !/^[0-9a-f-]{36}$/u.test(owner.token)
        || await processExists(owner.pid)) throw archiveError("ARCHIVE_BUSY");
    const ownerPath = path.join(identity.path, "owner.json");
    const ownerStat = await lstat(ownerPath);
    validateFileStat(ownerStat, 4096);
    await unlink(ownerPath).catch(() => { throw archiveError("ARCHIVE_BUSY"); });
    await rmdir(identity.path).catch(() => { throw archiveError("ARCHIVE_BUSY"); });
  }
  throw archiveError("ARCHIVE_BUSY");
}

async function releaseLock(lock) {
  if (!lock) return;
  try {
    await verifyDirectory(lock.identity);
    const owner = await safeReadJson(path.join(lock.path, "owner.json"), 4096);
    if (owner?.token !== lock.token) return;
    await unlink(path.join(lock.path, "owner.json"));
    await rmdir(lock.path);
    await syncDirectory(path.dirname(lock.path));
  } catch {
    // An interrupted writer is recovered on a later run only if its recorded PID has exited.
  }
}

async function removeStaleEntries(directory, pattern, now) {
  for (const name of await readdir(directory.path)) {
    if (!pattern.test(name)) continue;
    const target = path.join(directory.path, name);
    const stat = await lstat(target).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || stat.uid !== uid() || now - stat.mtimeMs < STALE_TEMP_MS) continue;
    if (stat.isDirectory() && (stat.mode & 0o7777) === 0o700) {
      await rm(target, { recursive: true, force: true });
    } else if (stat.isFile() && (stat.mode & 0o7777) === 0o600) {
      await unlink(target);
    }
  }
}

async function sweepStaleTemps(root, generations, blobs, now) {
  await removeStaleEntries(generations, /^\.pending-[0-9a-f]{32}$/u, now);
  await removeStaleEntries(blobs, /^\.pending-[0-9a-f]{32}\.blob$/u, now);
  await removeStaleEntries(root, /^\.current-[0-9a-f]{32}\.tmp$/u, now);
}

async function measureArchive(generations, blobs) {
  let bytes = 0;
  for (const name of await readdir(blobs.path)) {
    if (/^\.pending-[0-9a-f]{32}\.blob$/u.test(name)) {
      const stat = await lstat(path.join(blobs.path, name));
      validateFileStat(stat, MAX_BLOB_BYTES);
      bytes += stat.size;
    } else {
      if (!name.endsWith(".blob") || !HASH.test(name.slice(0, -5))) throw archiveError("ARCHIVE_STATE_INVALID");
      const stat = await lstat(path.join(blobs.path, name));
      validateFileStat(stat, MAX_BLOB_BYTES);
      bytes += stat.size;
    }
  }
  const entries = await readdir(generations.path);
  const committed = entries.filter((name) => UUID.test(name));
  if (committed.length + 1 > MAX_GENERATIONS) throw archiveError("ARCHIVE_GENERATION_LIMIT");
  for (const name of entries) {
    if (name.startsWith(".pending-")) {
      const pending = await inspectDirectory(path.join(generations.path, name));
      for (const file of await readdir(pending.path)) {
        const stat = await lstat(path.join(pending.path, file));
        validateFileStat(stat, MAX_SNAPSHOT_BYTES);
        bytes += stat.size;
      }
      continue;
    }
    if (!UUID.test(name)) throw archiveError("ARCHIVE_STATE_INVALID");
    const generation = await inspectDirectory(path.join(generations.path, name));
    const children = await readdir(generation.path);
    if (children.length !== 2 || !children.includes("snapshot.json") || !children.includes("manifest.json")) {
      throw archiveError("ARCHIVE_STATE_INVALID");
    }
    for (const file of children) {
      const stat = await lstat(path.join(generation.path, file));
      validateFileStat(stat, MAX_SNAPSHOT_BYTES);
      bytes += stat.size;
    }
  }
  if (bytes > MAX_ARCHIVE_BYTES) throw archiveError("ARCHIVE_BUDGET_EXCEEDED");
  return bytes;
}

async function ensureSpace(root, requestedBytes) {
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0 || requestedBytes > MAX_GENERATION_BYTES) {
    throw archiveError("GENERATION_BUDGET_EXCEEDED");
  }
  const space = await statfs(root.path).catch(() => { throw archiveError("DISK_CHECK_FAILED"); });
  const available = Number(space.bavail) * Number(space.bsize);
  if (!Number.isSafeInteger(available) || available < requestedBytes + MIN_FREE_BYTES) {
    throw archiveError("INSUFFICIENT_DISK_SPACE");
  }
}

async function atomicPointer(root, generationId, runId, snapshotSha256) {
  const target = path.join(root.path, "current.json");
  const existing = await lstat(target).catch(() => undefined);
  if (existing) validateFileStat(existing, 4096);
  const temporary = path.join(root.path, ".current-" + randomUUID().replaceAll("-", "") + ".tmp");
  const bytes = Buffer.from(JSON.stringify({
    format: POINTER_FORMAT, version: 2, runId, generationId, snapshotSha256,
  }) + "\n");
  try {
    await writePrivateFile(temporary, bytes);
    await rename(temporary, target);
    await syncDirectory(root.path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error?.code ? error : archiveError("ARCHIVE_PROMOTION_FAILED");
  }
}

/**
 * Stores a private partial capture as an immutable generation. Blobs are promoted only when a
 * native fileBodies receipt binds their owner-only staging file, byte count and SHA-256.
 *
 * @param {object} options Capture values.
 * @param {string} options.appDirectory Existing owner-only 0700 Tauri application data directory.
 * @param {object} options.snapshot Sanitized schema-v2 Canvas capture linked to its allocated run and generation.
 * @param {string} options.stagingDirectory Existing owner-only 0700 native blob staging directory.
 * @param {AbortSignal} [options.signal] Cancellation; pending output is removed before return.
 * @returns {Promise<{generationId: string, capturedAt: string, complete: false, resourceCount: number, itemCount: number, blobCount: number, blobBytes: number, archivedSnapshot: object}>} Receipt and archive-referenced snapshot for private local persistence.
 */
export async function saveCanvasCaptureGeneration({ appDirectory, snapshot, stagingDirectory, signal = undefined } = {}) {
  throwIfAborted(signal);
  if (typeof appDirectory !== "string" || !path.isAbsolute(appDirectory)
      || typeof stagingDirectory !== "string" || !path.isAbsolute(stagingDirectory)
      || (signal !== undefined && typeof signal.addEventListener !== "function")) {
    throw archiveError("INVALID_CONFIGURATION");
  }
  validateSnapshot(snapshot);
  const receipts = collectCanvasBlobReceipts(snapshot);
  const archivedSnapshot = createArchivedSnapshot(snapshot, receipts);
  const snapshotBytes = validateSnapshot(archivedSnapshot);
  const app = await inspectDirectory(appDirectory);
  const staging = await inspectDirectory(stagingDirectory);
  if (app.dev !== staging.dev) throw archiveError("STAGING_VOLUME_MISMATCH");

  const root = await ensurePrivateChild(app, ARCHIVE_NAME);
  const lock = await acquireLock(root);
  let pendingGeneration;
  const tempBlobPaths = new Set();
  try {
    throwIfAborted(signal);
    const generations = await ensurePrivateChild(root, "generations");
    const blobs = await ensurePrivateChild(root, "blobs");
    await sweepStaleTemps(root, generations, blobs, Date.now());
    await validateCurrent(root);

    const stageEntries = await readdir(staging.path);
    const expectedNames = new Set(receipts.map((receipt) => receipt.stagedFile));
    if (stageEntries.length !== expectedNames.size || stageEntries.some((name) => !expectedNames.has(name))) {
      throw archiveError("STAGING_CONTENT_MISMATCH");
    }
    const stagedBytes = receipts.reduce((sum, receipt) => sum + receipt.byteCount, 0);
    const existingByHash = new Map();
    let additionalBlobBytes = 0;
    for (const receipt of receipts) {
      if (!existingByHash.has(receipt.sha256)) {
        const stored = await verifyStoredCanvasBlob(blobs, receipt, signal);
        existingByHash.set(receipt.sha256, stored);
        if (!stored) additionalBlobBytes += receipt.byteCount;
      }
    }
    const projectedBytes = snapshotBytes.length + stagedBytes + 16 * 1024;
    if (projectedBytes > MAX_GENERATION_BYTES) throw archiveError("GENERATION_BUDGET_EXCEEDED");
    const archiveBytes = await measureArchive(generations, blobs);
    if (archiveBytes + snapshotBytes.length + additionalBlobBytes + 16 * 1024 > MAX_ARCHIVE_BYTES) {
      throw archiveError("ARCHIVE_BUDGET_EXCEEDED");
    }
    await ensureSpace(root, snapshotBytes.length + additionalBlobBytes + 16 * 1024);

    const copiedHashes = new Set();
    for (const receipt of receipts) {
      throwIfAborted(signal);
      if (existingByHash.get(receipt.sha256) === false && !copiedHashes.has(receipt.sha256)) {
        await copyCanvasBlob(staging, blobs, receipt, signal, tempBlobPaths, syncDirectory);
        copiedHashes.add(receipt.sha256);
      } else {
        await verifyStagedCanvasBlob(staging, receipt, signal);
      }
    }

    const generationId = snapshot.generationId;
    const finalPath = path.join(generations.path, generationId);
    pendingGeneration = path.join(generations.path, ".pending-" + randomUUID().replaceAll("-", ""));
    await mkdir(pendingGeneration, { mode: 0o700 });
    await chmod(pendingGeneration, 0o700);
    const candidate = await inspectDirectory(pendingGeneration);
    const snapshotSha256 = createHash("sha256").update(snapshotBytes).digest("hex");
    const itemCount = snapshot.resources.reduce((sum, resource) => {
      const count = isRecord(resource) && Array.isArray(resource.items) ? resource.items.length : 0;
      return sum + count;
    }, 0);
    await writePrivateFile(path.join(candidate.path, "snapshot.json"), snapshotBytes);
    const manifest = {
      format: ARCHIVE_FORMAT,
      version: 2,
      runId: snapshot.runId,
      generationId,
      capturedAt: snapshot.capturedAt,
      complete: false,
      identity: { origin: ORIGIN, userId: snapshot.identity.userId },
      snapshotBytes: snapshotBytes.length,
      snapshotSha256,
      resourceCount: snapshot.resources.length,
      itemCount,
      blobCount: receipts.length,
      blobBytes: stagedBytes,
      blobs: receipts.map(({ fileId, byteCount, sha256, contentType, sourceAuthenticity }) => ({
        fileId, byteCount, sha256, contentType, sourceAuthenticity,
      })),
    };
    // Write the manifest last so a generation is never treated as committed while incomplete.
    await writePrivateFile(path.join(candidate.path, "manifest.json"), Buffer.from(JSON.stringify(manifest) + "\n"));
    await syncDirectory(candidate.path);
    await verifyDirectory(root);
    await rename(candidate.path, finalPath);
    pendingGeneration = undefined;
    await syncDirectory(generations.path);
    throwIfAborted(signal);
    await atomicPointer(root, generationId, snapshot.runId, snapshotSha256);
    return {
      generationId,
      runId: snapshot.runId,
      snapshotSha256,
      capturedAt: snapshot.capturedAt,
      complete: false,
      resourceCount: manifest.resourceCount,
      itemCount,
      blobCount: manifest.blobCount,
      blobBytes: manifest.blobBytes,
      archivedSnapshot,
    };
  } catch (error) {
    if (error?.code) throw error;
    throw archiveError("ARCHIVE_SAVE_FAILED");
  } finally {
    if (pendingGeneration) await rm(pendingGeneration, { recursive: true, force: true }).catch(() => undefined);
    for (const temporary of tempBlobPaths) await unlink(temporary).catch(() => undefined);
    await releaseLock(lock);
  }
}
