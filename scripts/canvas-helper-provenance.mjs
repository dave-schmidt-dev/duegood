import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const CANVAS_HELPER_PROVENANCE_FILE = "duegood-canvas-helpers.json";

export const CANVAS_HELPER_NAMES = [
  "duegood-capture-download",
  "duegood-capture-state",
  "duegood-browser-import",
];
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_HELPER_BYTES = 512 * 1024 * 1024;

function staleHelperError() {
  const error = new Error("Canvas helper provenance is missing or stale.");
  error.code = "HELPER_STALE";
  return error;
}

function isDigest(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Read the build identity embedded in the signed app bundle.
 *
 * @param {{ metadataPath: string, files?: Pick<typeof import("node:fs/promises"), "lstat" | "readFile"> }} options
 */
export async function readCanvasBuildIdentity({
  metadataPath,
  files = { lstat, readFile },
}) {
  let metadata;
  try {
    const info = await files.lstat(metadataPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MARKER_BYTES) throw staleHelperError();
    metadata = JSON.parse(await files.readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw staleHelperError();
  }
  if (metadata?.schemaVersion !== 1
      || !isDigest(metadata.sourceCommit)
      || !isDigest(metadata.candidateTree)) {
    throw staleHelperError();
  }
  return { sourceCommit: metadata.sourceCommit, candidateTree: metadata.candidateTree };
}

/**
 * Atomically write provenance for the three installed Canvas helpers.
 *
 * @param {{ binDirectory: string, sourceCommit: string, candidateTree: string,
 *   helperDigests: Record<string, string>, files?: Pick<typeof import("node:fs/promises"), "writeFile" | "rename" | "rm"> }} options
 */
export async function stageCanvasHelperProvenance({
  binDirectory,
  sourceCommit,
  candidateTree,
  helperDigests,
  files = { writeFile, rename, rm },
}) {
  if (!isDigest(sourceCommit) || !isDigest(candidateTree)
      || !CANVAS_HELPER_NAMES.every((name) => isSha256(helperDigests?.[name]))) {
    throw new Error("Canvas helper provenance inputs are invalid.");
  }
  const markerPath = path.join(binDirectory, CANVAS_HELPER_PROVENANCE_FILE);
  const temporaryPath = path.join(binDirectory, `.${CANVAS_HELPER_PROVENANCE_FILE}.${randomUUID()}.tmp`);
  const marker = {
    schemaVersion: 1,
    sourceCommit,
    candidateTree,
    helpers: Object.fromEntries(CANVAS_HELPER_NAMES.map((name) => [name, helperDigests[name]])),
  };
  try {
    await files.writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await files.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { markerPath, temporaryPath, files };
}

/**
 * Publish a previously staged provenance marker with one same-directory rename.
 *
 * @param {{ markerPath: string, temporaryPath: string, files?: Pick<typeof import("node:fs/promises"), "rename" | "rm"> }} staged
 */
export async function publishCanvasHelperProvenance(staged) {
  try {
    await staged.files.rename(staged.temporaryPath, staged.markerPath);
  } finally {
    await staged.files.rm(staged.temporaryPath, { force: true }).catch(() => undefined);
  }
  return staged.markerPath;
}

/**
 * Write and atomically replace the helper provenance marker.
 *
 * @param {Parameters<typeof stageCanvasHelperProvenance>[0]} options
 */
export async function writeCanvasHelperProvenance(options) {
  const staged = await stageCanvasHelperProvenance(options);
  return publishCanvasHelperProvenance(staged);
}

/**
 * Verify helper marker identity and each executable's current bytes.
 *
 * @param {{ binDirectory: string, sourceCommit?: string, candidateTree?: string,
 *   files?: Pick<typeof import("node:fs/promises"), "lstat" | "readFile"> }} options
 */
export async function verifyCanvasHelperProvenance({
  binDirectory,
  sourceCommit,
  candidateTree,
  files = { lstat, readFile },
}) {
  try {
    const markerPath = path.join(binDirectory, CANVAS_HELPER_PROVENANCE_FILE);
    const metadata = await files.lstat(markerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.size > MAX_MARKER_BYTES
        || (metadata.mode & 0o022) !== 0
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      throw staleHelperError();
    }
    const marker = JSON.parse(await files.readFile(markerPath, "utf8"));
    if (marker?.schemaVersion !== 1
        || !isDigest(marker.sourceCommit)
        || !isDigest(marker.candidateTree)
        || (sourceCommit !== undefined && marker.sourceCommit !== sourceCommit)
        || (candidateTree !== undefined && marker.candidateTree !== candidateTree)
        || !CANVAS_HELPER_NAMES.every((name) => isSha256(marker.helpers?.[name]))) {
      throw staleHelperError();
    }
    for (const name of CANVAS_HELPER_NAMES) {
      const helperPath = path.join(binDirectory, name);
      const helperStat = await files.lstat(helperPath);
      if (!helperStat.isFile() || helperStat.isSymbolicLink()
          || helperStat.size === 0 || helperStat.size > MAX_HELPER_BYTES
          || (helperStat.mode & 0o111) === 0
          || (helperStat.mode & 0o022) !== 0
          || (typeof process.getuid === "function" && helperStat.uid !== process.getuid())) {
        throw staleHelperError();
      }
      const digest = createHash("sha256").update(await files.readFile(helperPath)).digest("hex");
      if (digest !== marker.helpers[name]) throw staleHelperError();
    }
    return marker;
  } catch {
    throw staleHelperError();
  }
}
