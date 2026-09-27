import { chmod, lstat, mkdtemp, open, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { collectCanvasBrowserCapture } from "./canvas-browser-capture.mjs";
import { downloadCanvasFile } from "./canvas-browser-file-pipeline.mjs";
import { saveCanvasCaptureGeneration } from "./canvas-browser-archive.mjs";

const ORIGIN = "https://marymount.instructure.com";
const APP_DIR = path.join(homedir(), "Library", "Application Support", "DueGood");
const MAX_CAPTURE_DISK_BYTES = 4 * 1024 * 1024 * 1024;
const DIAGNOSTIC_FILE = "canvas-capture-last-error.json";

async function writeSafeDiagnostic(appDirectory, { phase, endpoint, error }) {
  const errorCode = [error?.code, error?.message].find((value) =>
    typeof value === "string" && /^[A-Z_]{1,48}$/u.test(value)) ?? "UNCLASSIFIED";
  const safeEndpoint = typeof endpoint === "string" && /^[A-Za-z]{1,32}$/u.test(endpoint)
    ? endpoint : "unknown";
  const temporary = path.join(appDirectory, `.${DIAGNOSTIC_FILE}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify({ phase, endpoint: safeEndpoint, errorCode })}\n`); }
    finally { await handle.close(); }
    await rename(temporary, path.join(appDirectory, DIAGNOSTIC_FILE));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function privateDirectory(directory) {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("PRIVATE_DIRECTORY_REJECTED");
  }
}

/** Captures from one persistent browser and publishes a private, immutable archive generation. */
export async function runCanvasCapture({
  context,
  expectedUserId,
  progress,
  collector = collectCanvasBrowserCapture,
  appDirectory = APP_DIR,
  helperPath = path.join(appDirectory, "bin", "duegood-capture-download"),
  browserFileDownload = downloadCanvasFile,
  saveGeneration = saveCanvasCaptureGeneration,
}) {
  const helper = await lstat(helperPath).catch(() => undefined);
  if (!helper?.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111) === 0
      || (helper.mode & 0o022) !== 0
      || (typeof process.getuid === "function" && helper.uid !== process.getuid())) {
    throw new Error("HELPER_UNAVAILABLE");
  }
  await privateDirectory(appDirectory);
  const page = context?.pages?.().find((candidate) => {
    if (candidate.isClosed?.()) return false;
    try { return new URL(candidate.url()).origin === ORIGIN; } catch { return false; }
  });
  if (!page) throw new Error("CANVAS_SESSION_UNAVAILABLE");
  const stagingDirectory = await mkdtemp(path.join(appDirectory, "canvas-capture-stage-"));
  let phase = "opening";
  let endpoint = "unknown";
  try {
    await chmod(stagingDirectory, 0o700);
    progress("CAPTURE_RUNNING");
    let stagedBytes = 0;
    phase = "collecting";
    const snapshot = await collector({
      expectedUserId,
      page,
      progress: (event) => {
        if (typeof event?.endpoint === "string") endpoint = event.endpoint;
        progress("CAPTURE_RUNNING");
      },
      downloadFile: async ({ fileId, sourceUrl, expectedSize }) => {
        if (stagedBytes >= MAX_CAPTURE_DISK_BYTES
            || expectedSize !== undefined && expectedSize !== null
              && expectedSize > MAX_CAPTURE_DISK_BYTES - stagedBytes) {
          throw new Error("CAPTURE_DISK_BUDGET_EXCEEDED");
        }
        progress("CAPTURE_DOWNLOADING");
        const receipt = await browserFileDownload({ context, page, fileId, sourceUrl, expectedSize,
          stagingDirectory, helperPath, progress: () => progress("CAPTURE_DOWNLOADING") });
        if (receipt?.kind !== "staged" || !Number.isSafeInteger(receipt.byteCount)
            || receipt.byteCount <= 0 || receipt.byteCount > MAX_CAPTURE_DISK_BYTES - stagedBytes) {
          if (typeof receipt?.stagedFile === "string" && /^[a-f0-9]{32}\.blob$/u.test(receipt.stagedFile)) {
            await unlink(path.join(stagingDirectory, receipt.stagedFile)).catch(() => undefined);
          }
          throw new Error("CAPTURE_DISK_BUDGET_EXCEEDED");
        }
        stagedBytes += receipt.byteCount;
        return receipt;
      },
    });
    phase = "archiving";
    progress("CAPTURE_SAVING");
    const archived = await saveGeneration({ appDirectory, snapshot, stagingDirectory });
    if (!archived?.archivedSnapshot || archived.archivedSnapshot.identity?.userId !== expectedUserId) {
      throw new Error("ARCHIVE_RECEIPT_REJECTED");
    }
    return archived.archivedSnapshot;
  } catch (error) {
    await writeSafeDiagnostic(appDirectory, { phase, endpoint, error }).catch(() => undefined);
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
