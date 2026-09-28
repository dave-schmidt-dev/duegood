import { chmod, lstat, mkdtemp, open, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { collectCanvasBrowserCapture } from "./canvas-browser-capture.mjs";
import { downloadCanvasFile } from "./canvas-browser-file-pipeline.mjs";
import { saveCanvasCaptureGeneration } from "./canvas-browser-archive.mjs";
import { withCanvasRunLease } from "./canvas-browser-run-lease.mjs";

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
  protocolVersion = undefined,
  progress,
  collector = collectCanvasBrowserCapture,
  appDirectory = APP_DIR,
  helperPath = path.join(appDirectory, "bin", "duegood-capture-download"),
  stateHelperPath = path.join(appDirectory, "bin", "duegood-capture-state"),
  browserFileDownload = downloadCanvasFile,
  saveGeneration = saveCanvasCaptureGeneration,
  withRunLease = withCanvasRunLease,
}) {
  const stateHelper = await lstat(stateHelperPath).catch(() => undefined);
  if (!stateHelper?.isFile() || stateHelper.isSymbolicLink() || (stateHelper.mode & 0o111) === 0
      || (stateHelper.mode & 0o022) !== 0
      || (typeof process.getuid === "function" && stateHelper.uid !== process.getuid())) {
    throw new Error("STATE_HELPER_UNAVAILABLE");
  }
  let phase = "opening";
  let endpoint = "unknown";
  try {
    return await withRunLease({ helperPath: stateHelperPath, run: async (runId) => {
      phase = "preflight";
      await privateDirectory(appDirectory);
      const helper = await lstat(helperPath).catch(() => undefined);
      if (!helper?.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111) === 0
          || (helper.mode & 0o022) !== 0
          || (typeof process.getuid === "function" && helper.uid !== process.getuid())) {
        throw new Error("HELPER_UNAVAILABLE");
      }
      const page = context?.pages?.().find((candidate) => {
        if (candidate.isClosed?.()) return false;
        try { return new URL(candidate.url()).origin === ORIGIN; } catch { return false; }
      });
      if (!page) throw new Error("CANVAS_SESSION_UNAVAILABLE");
      const generationId = randomUUID().replaceAll("-", "");
      const stagingDirectory = await mkdtemp(path.join(appDirectory, "canvas-capture-stage-"));
      try {
        await chmod(stagingDirectory, 0o700);
        progress("CAPTURE_RUNNING");
        let stagedBytes = 0;
        phase = "collecting";
        const snapshot = await collector({
          expectedUserId,
          runId,
          generationId,
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
        const archived = await saveGeneration({ appDirectory, snapshot, stagingDirectory, runId, generationId });
        if (!archived?.archivedSnapshot || archived.archivedSnapshot.identity?.userId !== expectedUserId
            || archived.archivedSnapshot.runId !== runId || archived.archivedSnapshot.generationId !== generationId
            || archived.generationId !== generationId || !/^[a-f0-9]{64}$/u.test(archived.snapshotSha256 ?? "")) {
          throw new Error("ARCHIVE_RECEIPT_REJECTED");
        }
        return {
          terminal: { status: "captured", runId, generationId,
            snapshotSha256: archived.snapshotSha256, userId: expectedUserId },
          // An already-running v1 broker has an inline v1 validator. Its transient view is
          // deliberately unlinked; the durable archive and terminal receipt stay schema v2.
          value: protocolVersion === 2
            ? archived.archivedSnapshot
            : legacyBrokerSnapshot(archived.archivedSnapshot),
        };
      } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
      }
    }});
  } catch (error) {
    await writeSafeDiagnostic(appDirectory, { phase, endpoint, error }).catch(() => undefined);
    throw error;
  }
}

function legacyBrokerSnapshot(snapshot) {
  const legacy = { ...snapshot };
  delete legacy.runId;
  delete legacy.generationId;
  delete legacy.activeCourses;
  delete legacy.coverageRequirements;
  return { ...legacy, schemaVersion: 1, complete: false };
}
