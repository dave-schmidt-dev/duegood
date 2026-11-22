import { mkdir, lstat, readFile, rename, rm, writeFile, chmod, copyFile, link, constants } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CANVAS_HELPER_NAMES,
  CANVAS_HELPER_PROVENANCE_FILE,
  publishCanvasHelperProvenance,
  stageCanvasHelperProvenance,
} from "./canvas-helper-provenance.mjs";

const LOCK_MESSAGE = "Canvas helper installation is already running, or a previous run left its lock. Confirm no installation is active, remove the stale .canvas-helper-install.lock directory from ~/Library/Application Support/DueGood/bin, then rerun npm run canvas:prepare-helper.";

function checkInterrupted(signal) {
  if (signal?.aborted) throw new Error("operation interrupted");
}

async function acquireInstallLock(binDirectory, progress) {
  const lockPath = path.join(binDirectory, ".canvas-helper-install.lock");
  const token = randomUUID();
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      progress(LOCK_MESSAGE);
      const locked = new Error(LOCK_MESSAGE, { cause: error });
      locked.code = "HELPER_INSTALL_LOCKED";
      throw locked;
    }
    throw error;
  }
  try {
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token,
    })}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return async () => {
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (owner?.schemaVersion !== 1 || owner.pid !== process.pid || owner.token !== token) {
      throw new Error("Canvas helper install lock ownership changed");
    }
    await rm(lockPath, { recursive: true, force: false });
  };
}

async function inspectInstallTargets(targets) {
  const existing = new Map();
  for (const targetPath of targets) {
    const metadata = await lstat(targetPath).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
      throw new Error("an existing Canvas helper destination is not a regular file");
    }
    existing.set(targetPath, Boolean(metadata));
  }
  return existing;
}

/**
 * Publish all helper files and their marker as one recoverable installation transaction.
 *
 * @param {{ binDirectory: string, entries: Array<{ name: string, binaryPath: string, targetPath: string }>,
 *   sourceCommit: string, candidateTree: string, platform: NodeJS.Platform,
 *   expectedDigests: Record<string, string>, progress?: (message: string) => void,
 *   beforePublish?: () => Promise<void>, signal?: AbortSignal, inspectBinary: (path: string, platform: NodeJS.Platform) => Promise<{ sha256: string, byteCount: number }> }} options
 */
export async function installCanvasHelpers({
  binDirectory,
  entries,
  sourceCommit,
  candidateTree,
  expectedDigests,
  platform,
  signal,
  inspectBinary,
  progress = () => {},
  beforePublish = async () => {},
}) {
  if (entries.length !== CANVAS_HELPER_NAMES.length
      || CANVAS_HELPER_NAMES.some((name) => !entries.some((entry) => entry.name === name))) {
    throw new Error("the production Canvas helper set is incomplete");
  }
  const releaseLock = await acquireInstallLock(binDirectory, progress);
  const markerPath = path.join(binDirectory, CANVAS_HELPER_PROVENANCE_FILE);
  const stagedHelpers = [];
  let stagedMarker;
  let markerPublished = false;
  let retainLock = false;
  try {
    const existing = await inspectInstallTargets([
      ...entries.map((entry) => entry.targetPath),
      markerPath,
    ]);
    const markerDigests = {};
    for (const entry of entries) {
      checkInterrupted(signal);
      const temporaryPath = path.join(binDirectory, `.${entry.name}.${randomUUID()}.tmp`);
      await copyFile(entry.binaryPath, temporaryPath, constants.COPYFILE_EXCL);
      try {
        await chmod(temporaryPath, 0o700);
        checkInterrupted(signal);
        const report = await inspectBinary(temporaryPath, platform);
        if (report.sha256 !== expectedDigests?.[entry.name]) {
          throw new Error("a staged Canvas helper changed after release verification");
        }
        stagedHelpers.push({
          ...entry,
          temporaryPath,
          backupPath: path.join(binDirectory, `.${entry.name}.${randomUUID()}.bak`),
          existed: existing.get(entry.targetPath),
          backupCreated: false,
          published: false,
          report,
        });
        markerDigests[entry.name] = report.sha256;
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    stagedMarker = await stageCanvasHelperProvenance({
      binDirectory,
      sourceCommit,
      candidateTree,
      helperDigests: markerDigests,
    });
    await beforePublish();
    checkInterrupted(signal);

    try {
      for (const staged of stagedHelpers) {
        checkInterrupted(signal);
        if (staged.existed) {
          await link(staged.targetPath, staged.backupPath);
          staged.backupCreated = true;
        }
        await rename(staged.temporaryPath, staged.targetPath);
        staged.published = true;
        const installed = await inspectBinary(staged.targetPath, platform);
        if (installed.sha256 !== staged.report.sha256) {
          throw new Error("an installed Canvas helper failed post-copy verification");
        }
      }
      checkInterrupted(signal);
      await publishCanvasHelperProvenance(stagedMarker);
      markerPublished = true;
    } catch (error) {
      const rollbackFailures = [];
      for (const staged of [...stagedHelpers].reverse()) {
        try {
          if (staged.backupCreated && staged.published) {
            await rename(staged.backupPath, staged.targetPath);
          } else if (staged.backupCreated) {
            await rm(staged.backupPath, { force: false });
          } else if (staged.published) {
            await rm(staged.targetPath, { force: true });
          }
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (rollbackFailures.length > 0) {
        retainLock = true;
        throw new AggregateError([error, ...rollbackFailures], "Canvas helper publication and rollback failed", { cause: error });
      }
      throw error;
    }

    return Object.fromEntries(stagedHelpers.map((staged) => [staged.name, {
      path: staged.targetPath,
      ...staged.report,
    }]));
  } finally {
    if (!markerPublished && stagedMarker) {
      await rm(stagedMarker.temporaryPath, { force: true }).catch(() => {
        progress("Canvas helper marker cleanup is incomplete");
      });
    }
    for (const staged of stagedHelpers) {
      await rm(staged.temporaryPath, { force: true }).catch(() => {
        progress("Canvas helper temporary-file cleanup is incomplete");
      });
      if (markerPublished) {
        await rm(staged.backupPath, { force: true }).catch(() => {
          progress("Canvas helper backup cleanup is incomplete");
        });
      }
    }
    if (retainLock) {
      progress(LOCK_MESSAGE);
    } else {
      try {
        await releaseLock();
      } catch {
        progress("The helper set is installed, but its lock could not be removed. Confirm no install is active, remove the stale .canvas-helper-install.lock directory from ~/Library/Application Support/DueGood/bin, then retry.");
      }
    }
  }
}
