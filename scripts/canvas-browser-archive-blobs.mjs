import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import path from "node:path";

export const MAX_BLOB_BYTES = 256 * 1024 * 1024;
const STAGED_BLOB_NAME = /^[0-9a-f]{32}\.blob$/u;
const HASH = /^[0-9a-f]{64}$/u;

function archiveError(code) {
  return Object.assign(new Error(code), { code });
}

function uid() {
  if (typeof process.getuid !== "function") throw archiveError("UNSUPPORTED_PLATFORM");
  return process.getuid();
}

function validateFileStat(stat, maxBytes = Number.MAX_SAFE_INTEGER) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o7777) !== 0o600
      || stat.nlink !== 1 || stat.size > maxBytes) throw archiveError("UNSAFE_FILE");
}

async function verifyDirectory(identity) {
  const stat = await lstat(identity.path).catch(() => undefined);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev
      || stat.ino !== identity.ino || stat.uid !== identity.uid || (stat.mode & 0o7777) !== 0o700) {
    throw archiveError("UNSAFE_DIRECTORY");
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw archiveError("CANCELED");
}

export function collectCanvasBlobReceipts(snapshot) {
  const resources = snapshot.resources.filter((resource) => resource?.endpoint === "fileBodies");
  const receipts = [];
  const basenames = new Set();
  const fileIds = new Set();
  for (const resource of resources) {
    if (!Array.isArray(resource.items)) throw archiveError("INVALID_BLOB_RECEIPT");
    for (const item of resource.items) {
      if (item?.status !== "staged") continue;
      const expectedSizeValid = item.expectedSize === null
        || (Number.isSafeInteger(item.expectedSize) && item.expectedSize >= 0);
      if (!Number.isSafeInteger(item.fileId) || item.fileId <= 0 || !expectedSizeValid
          || !Number.isSafeInteger(item.byteCount) || item.byteCount <= 0 || item.byteCount > MAX_BLOB_BYTES
          || !HASH.test(item.sha256) || !/^[-a-z0-9.+]{1,64}\/[-a-z0-9.+]{1,64}$/u.test(item.contentType)
          || item.sourceAuthenticity !== "unverified" || typeof item.stagedFile !== "string"
          || !STAGED_BLOB_NAME.test(item.stagedFile)
          || (item.expectedSize !== null && item.expectedSize !== item.byteCount)
          || basenames.has(item.stagedFile) || fileIds.has(item.fileId)) throw archiveError("INVALID_BLOB_RECEIPT");
      basenames.add(item.stagedFile);
      fileIds.add(item.fileId);
      receipts.push({
        fileId: item.fileId,
        stagedFile: item.stagedFile,
        byteCount: item.byteCount,
        sha256: item.sha256,
        contentType: item.contentType,
        sourceAuthenticity: "unverified",
      });
    }
  }
  return receipts;
}

async function hashHandle(handle, signal, maxBytes) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let byteCount = 0;
  while (true) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    byteCount += bytesRead;
    if (byteCount > maxBytes) throw archiveError("BLOB_TOO_LARGE");
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { byteCount, sha256: hash.digest("hex") };
}

export async function verifyStoredCanvasBlob(blobs, receipt, signal) {
  const target = path.join(blobs.path, receipt.sha256 + ".blob");
  const before = await lstat(target).catch(() => undefined);
  if (!before) return false;
  validateFileStat(before, MAX_BLOB_BYTES);
  if (before.size !== receipt.byteCount) throw archiveError("ARCHIVE_BLOB_MISMATCH");
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    validateFileStat(opened, MAX_BLOB_BYTES);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw archiveError("UNSAFE_FILE");
    const actual = await hashHandle(handle, signal, MAX_BLOB_BYTES);
    if (actual.byteCount !== receipt.byteCount || actual.sha256 !== receipt.sha256) {
      throw archiveError("ARCHIVE_BLOB_MISMATCH");
    }
  } finally {
    await handle.close();
  }
  return true;
}

export async function verifyStagedCanvasBlob(staging, receipt, signal) {
  const source = path.join(staging.path, receipt.stagedFile);
  const before = await lstat(source).catch(() => undefined);
  if (!before) throw archiveError("STAGED_BLOB_MISSING");
  validateFileStat(before, MAX_BLOB_BYTES);
  if (before.size !== receipt.byteCount) throw archiveError("STAGED_BLOB_MISMATCH");
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    .catch(() => { throw archiveError("STAGED_BLOB_UNSAFE"); });
  try {
    const opened = await handle.stat();
    validateFileStat(opened, MAX_BLOB_BYTES);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw archiveError("STAGED_BLOB_UNSAFE");
    const actual = await hashHandle(handle, signal, MAX_BLOB_BYTES);
    if (actual.byteCount !== receipt.byteCount || actual.sha256 !== receipt.sha256) {
      throw archiveError("STAGED_BLOB_MISMATCH");
    }
    const after = await lstat(source).catch(() => undefined);
    await verifyDirectory(staging);
    if (!after || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw archiveError("STAGED_BLOB_CHANGED");
    }
  } finally {
    await handle.close();
  }
}

export async function copyCanvasBlob(staging, blobs, receipt, signal, tempPaths, syncDirectory) {
  const source = path.join(staging.path, receipt.stagedFile);
  const sourceStat = await lstat(source).catch(() => undefined);
  if (!sourceStat) throw archiveError("STAGED_BLOB_MISSING");
  validateFileStat(sourceStat, MAX_BLOB_BYTES);
  if (sourceStat.size !== receipt.byteCount) throw archiveError("STAGED_BLOB_MISMATCH");
  await verifyDirectory(staging);
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    .catch(() => { throw archiveError("STAGED_BLOB_UNSAFE"); });
  const temporary = path.join(blobs.path, ".pending-" + randomUUID().replaceAll("-", "") + ".blob");
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  const output = await open(temporary, flags, 0o600).catch(async () => {
    await input.close();
    throw archiveError("ARCHIVE_WRITE_FAILED");
  });
  tempPaths.add(temporary);
  try {
    const opened = await input.stat();
    validateFileStat(opened, MAX_BLOB_BYTES);
    if (opened.dev !== sourceStat.dev || opened.ino !== sourceStat.ino || opened.size !== receipt.byteCount) {
      throw archiveError("STAGED_BLOB_UNSAFE");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > receipt.byteCount || total > MAX_BLOB_BYTES) throw archiveError("STAGED_BLOB_CHANGED");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten <= 0) throw archiveError("ARCHIVE_WRITE_FAILED");
        offset += bytesWritten;
      }
    }
    if (total !== receipt.byteCount || hash.digest("hex") !== receipt.sha256) throw archiveError("STAGED_BLOB_MISMATCH");
    const after = await lstat(source).catch(() => undefined);
    await verifyDirectory(staging);
    if (!after || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw archiveError("STAGED_BLOB_CHANGED");
    }
    await output.sync();
    await output.chmod(0o600);
    validateFileStat(await output.stat(), MAX_BLOB_BYTES);
  } finally {
    await input.close().catch(() => undefined);
    await output.close().catch(() => undefined);
  }

  const destination = path.join(blobs.path, receipt.sha256 + ".blob");
  // Same-filesystem rename makes a complete verified blob visible in one step.
  await rename(temporary, destination);
  tempPaths.delete(temporary);
  await syncDirectory(blobs.path);
}
