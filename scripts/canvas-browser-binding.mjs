import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const BINDING_FILE = "canvas-account-binding.json";

function failure(code) { return Object.assign(new Error(code), { code }); }
function ownerUid() { return typeof process.getuid === "function" ? process.getuid() : -1; }

async function privateDirectory(directory) {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (ownerUid() >= 0 && stat.uid !== ownerUid())
      || (stat.mode & 0o7777) !== 0o700) throw failure("BINDING_DIRECTORY_REJECTED");
}

/** Returns the owner-confirmed account ID, or undefined before first binding. */
export async function readCanvasAccountBinding(appDirectory) {
  await privateDirectory(appDirectory);
  const target = path.join(appDirectory, BINDING_FILE);
  const stat = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw failure("BINDING_READ_FAILED");
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || (ownerUid() >= 0 && stat.uid !== ownerUid())
      || (stat.mode & 0o7777) !== 0o600 || stat.size > 256) throw failure("BINDING_REJECTED");
  let value;
  try { value = JSON.parse(await readFile(target, "utf8")); } catch { throw failure("BINDING_REJECTED"); }
  if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.userId) || value.userId <= 0
      || Object.keys(value).sort().join(",") !== "schemaVersion,userId") throw failure("BINDING_REJECTED");
  return value.userId;
}

/** Records a numeric ID only after the live browser independently returned that same ID. */
export async function bindCanvasAccount(appDirectory, confirmedUserId, liveUserId) {
  if (!Number.isSafeInteger(confirmedUserId) || confirmedUserId <= 0 || confirmedUserId !== liveUserId) {
    throw failure("IDENTITY_MISMATCH");
  }
  await mkdir(appDirectory, { recursive: true, mode: 0o700 });
  await privateDirectory(appDirectory);
  const existing = await readCanvasAccountBinding(appDirectory);
  if (existing !== undefined && existing !== confirmedUserId) throw failure("BINDING_ALREADY_SET");
  if (existing === confirmedUserId) return confirmedUserId;
  const temporary = path.join(appDirectory, `.${BINDING_FILE}.${randomUUID()}.tmp`);
  const target = path.join(appDirectory, BINDING_FILE);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, userId: confirmedUserId })}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await privateDirectory(appDirectory);
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return confirmedUserId;
}
