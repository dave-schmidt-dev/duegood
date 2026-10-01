import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCanvasCaptureDirectory, saveCanvasCaptureGeneration } from "../../scripts/canvas-browser-archive.mjs";
import { copyArchivedCanvasBlobToStaging } from "../../scripts/canvas-browser-archive-blobs.mjs";
import { runCanvasCapture } from "../../scripts/canvas-browser-session-capture.mjs";
import { loadCanvasFileReuseIndex, stageReusedCanvasFile } from "../../scripts/canvas-browser-file-reuse.mjs";
import { withCanvasRunLease } from "../../scripts/canvas-browser-run-lease.mjs";
import type { collectCanvasBrowserCapture } from "../../scripts/canvas-browser-capture.mjs";

const ORIGIN = "https://marymount.instructure.com";
const USER_ID = 41;
const COURSE_ID = 88;
const FILE_ID = 900;
const T1 = "2026-09-01T10:00:00Z";
const T2 = "2026-09-02T10:00:00Z";
const PRIOR_BODY = Buffer.from("synthetic prior Canvas file body");
// Same byte length as the prior body on purpose: size alone must never imply unchanged.
const REFRESHED_BODY = Buffer.from("synthetic newer Canvas file body");
const RUN_ID = 17;
const directories: string[] = [];

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

async function directory() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "duegood-file-reuse-test-"));
  await chmod(root, 0o700);
  directories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type PriorOptions = {
  userId?: number;
  fileId?: number;
  body?: Buffer;
  contentType?: string;
  modifiedAt?: string | null;
  updatedAt?: string | null;
  metadataResources?: Array<{ endpoint: string; courseId: number | null; items: Array<Record<string, unknown>> }>;
  omitMetadata?: boolean;
};

/** Publishes one synthetic prior archive generation that a later capture may reuse. */
async function priorArchive(root: string, options: PriorOptions = {}) {
  const {
    userId = USER_ID, fileId = FILE_ID, body = PRIOR_BODY, contentType = "application/pdf",
    modifiedAt = T1, updatedAt = T1, metadataResources = [], omitMetadata = false,
  } = options;
  const appDirectory = path.join(root, "app");
  await mkdir(appDirectory, { recursive: true, mode: 0o700 });
  await chmod(appDirectory, 0o700);
  const stagingDirectory = path.join(root, "prior-staging");
  await mkdir(stagingDirectory, { mode: 0o700 });
  await chmod(stagingDirectory, 0o700);
  const stagedFile = randomUUID().replaceAll("-", "") + ".blob";
  await writeFile(path.join(stagingDirectory, stagedFile), body, { mode: 0o600, flag: "wx" });
  await chmod(path.join(stagingDirectory, stagedFile), 0o600);
  const fileItem: Record<string, unknown> = { id: fileId, display_name: "Synthetic handout",
    size: body.length, "content-type": contentType, locked: false, hidden: false,
    locked_for_user: false, hidden_for_user: false };
  if (modifiedAt !== null) fileItem.modified_at = modifiedAt;
  if (updatedAt !== null) fileItem.updated_at = updatedAt;
  const snapshot = {
    schemaVersion: 2,
    source: "canvas-browser",
    runId: 1,
    generationId: randomUUID().replaceAll("-", ""),
    capturedAt: "2026-09-27T16:00:00.000Z",
    complete: false,
    identity: { origin: ORIGIN, userId },
    activeCourses: { complete: true, courseIds: [] },
    coverageRequirements: { activeCoursesComplete: true,
      perActiveCourse: ["course", "assignments", "assignmentGroups", "submissions"] },
    resources: [
      { endpoint: "profile", courseId: null, pages: 1, items: [{ id: userId, name: "Synthetic student" }] },
      { endpoint: "coursesActive", courseId: null, pages: 1, items: [] },
      ...(omitMetadata ? [] : [{ endpoint: "courseFiles", courseId: COURSE_ID, pages: 1, items: [fileItem] }]),
      ...metadataResources.map((resource) => ({ pages: 1, ...resource })),
      { endpoint: "fileBodies", courseId: null, pages: 1, items: [{
        fileId, status: "staged", expectedSize: body.length, byteCount: body.length,
        sha256: sha256(body), contentType, stagedFile, sourceAuthenticity: "unverified" }] },
    ],
    coverage: [
      { endpoint: "coursesActive", courseId: null, status: "complete" },
      { endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" },
    ],
  };
  await saveCanvasCaptureGeneration({ appDirectory, snapshot, stagingDirectory });
  return { appDirectory, body, sha: sha256(body) };
}

type CurrentFile = {
  fileId: number;
  size: number;
  modifiedAt: string | null;
  updatedAt: string | null;
  contentType: string;
  locked?: boolean;
  hidden?: boolean;
  lockedForUser?: boolean;
  hiddenForUser?: boolean;
};

const syntheticLease: typeof withCanvasRunLease = async (options = {} as NonNullable<Parameters<typeof withCanvasRunLease>[0]>) => {
  const { run } = options;
  const outcome = await run(RUN_ID);
  if (outcome.terminal?.status !== "captured") throw new Error("synthetic lease did not complete");
  return outcome.value;
};

function browserContext() {
  const page = { url: vi.fn(() => `${ORIGIN}/`), isClosed: vi.fn(() => false),
    goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  return { page, browser: { pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) } };
}

async function writeHelpers(appDirectory: string) {
  const helperPath = path.join(appDirectory, "synthetic-helper");
  await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const bin = path.join(appDirectory, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const stateHelperPath = path.join(bin, "duegood-capture-state");
  await writeFile(stateHelperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { helperPath, stateHelperPath };
}

type RunOptions = {
  appDirectory: string;
  expectedUserId?: number;
  files: CurrentFile[];
  downloadBody?: Buffer;
  extraResources?: Array<{ endpoint: string; courseId: number | null; pages?: number; items: Array<Record<string, unknown>> }>;
  activeCourses?: number[];
  stageFileReuse?: typeof stageReusedCanvasFile;
};

/** Builds one synthetic capture through the real runCanvasCapture reuse and archive paths. */
async function captureHarness(options: RunOptions) {
  const {
    appDirectory, expectedUserId = USER_ID, files, downloadBody = REFRESHED_BODY,
    extraResources = [], activeCourses = [],
  } = options;
  const { helperPath, stateHelperPath } = await writeHelpers(appDirectory);
  const { browser } = browserContext();
  const browserFileDownload = vi.fn(async ({ stagingDirectory, fileId }: { stagingDirectory: string; fileId: number }) => {
    const stagedFile = randomUUID().replaceAll("-", "") + ".blob";
    await writeFile(path.join(stagingDirectory, stagedFile), downloadBody, { mode: 0o600, flag: "wx" });
    return { kind: "staged", fileId, stagedFile, byteCount: downloadBody.length,
      sha256: sha256(downloadBody), contentType: "application/pdf", sourceAuthenticity: "unverified" };
  });
  const collector = vi.fn(async ({ downloadFile, runId, generationId }: {
    downloadFile: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    runId: number; generationId: string;
  }) => {
    const items = new Map<number, Record<string, unknown>>();
    for (const file of files) {
      const receipt = await downloadFile({
        fileId: file.fileId,
        sourceUrl: `${ORIGIN}/files/${file.fileId}/download?download_frd=1`,
        expectedSize: file.size,
        modifiedAt: file.modifiedAt,
        updatedAt: file.updatedAt,
        contentType: file.contentType,
        locked: file.locked ?? null,
        hidden: file.hidden ?? null,
        lockedForUser: file.lockedForUser ?? null,
        hiddenForUser: file.hiddenForUser ?? null,
      }) as { fileId: number; byteCount: number; sha256: string; contentType: string; stagedFile: string };
      items.set(file.fileId, { fileId: file.fileId, status: "staged", expectedSize: file.size,
        byteCount: receipt.byteCount, sha256: receipt.sha256, contentType: receipt.contentType,
        stagedFile: receipt.stagedFile, sourceAuthenticity: "unverified" });
    }
    const coverage = [
      { endpoint: "coursesActive", courseId: null, status: "complete" },
      { endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" },
      ...activeCourses.flatMap((courseId) => ["course", "assignments", "assignmentGroups", "submissions"]
        .map((endpoint) => ({ endpoint, courseId, status: "complete" }))),
    ];
    return {
      schemaVersion: 2 as const,
      source: "canvas-browser" as const,
      runId,
      generationId,
      capturedAt: "2026-09-28T12:00:00.000Z",
      complete: false as const,
      identity: { origin: ORIGIN, userId: expectedUserId },
      activeCourses: { complete: true as const, courseIds: activeCourses },
      coverageRequirements: { activeCoursesComplete: true as const,
        perActiveCourse: ["course", "assignments", "assignmentGroups", "submissions"] },
      resources: [
        { endpoint: "profile", courseId: null, pages: 1, items: [{ id: expectedUserId, name: "Synthetic student" }] },
        { endpoint: "coursesActive", courseId: null, pages: 1,
          items: activeCourses.map((id) => ({ id })) },
        ...extraResources,
        { endpoint: "fileBodies", courseId: null, pages: 1, items: [...items.values()] },
      ],
      coverage,
    };
  });
  const progress = vi.fn();
  const runPromise = runCanvasCapture({
    context: browser,
    expectedUserId,
    protocolVersion: 2,
    progress,
    appDirectory,
    helperPath,
    stateHelperPath,
    withRunLease: syntheticLease,
    collector: collector as unknown as typeof collectCanvasBrowserCapture,
    browserFileDownload,
    ...(options.stageFileReuse === undefined ? {} : { stageFileReuse: options.stageFileReuse }),
  });
  return { runPromise, browserFileDownload, collector, progress };
}

/** Awaits one synthetic capture that is expected to complete. */
async function runCapture(options: RunOptions) {
  const harness = await captureHarness(options);
  const result = await harness.runPromise;
  return { result, browserFileDownload: harness.browserFileDownload,
    collector: harness.collector, progress: harness.progress };
}

async function currentManifest(appDirectory: string) {
  const archive = path.join(appDirectory, "canvas-capture-archive");
  const pointer = JSON.parse(await readFile(path.join(archive, "current.json"), "utf8")) as {
    generationId: string; runId: number;
  };
  const manifest = JSON.parse(await readFile(
    path.join(archive, "generations", pointer.generationId, "manifest.json"), "utf8")) as {
    version: number; runId: number; generationId: string;
    blobs: Array<{ fileId: number; byteCount: number; sha256: string; contentType: string; sourceAuthenticity: string }>;
  };
  return { archive, pointer, manifest };
}

const unchangedFile = (): CurrentFile => ({ fileId: FILE_ID, size: PRIOR_BODY.length,
  modifiedAt: T1, updatedAt: T1, contentType: "application/pdf", locked: false, hidden: false,
  lockedForUser: false, hiddenForUser: false });

type ArchivedView = {
  resources?: Array<{ endpoint?: string; items?: Array<Record<string, unknown>> }>;
  syllabusSessions?: unknown;
};

function archivedView(result: unknown): ArchivedView {
  return result as ArchivedView;
}

function archivedBodies(result: unknown): Array<Record<string, unknown>> {
  return archivedView(result).resources?.find((resource) => resource.endpoint === "fileBodies")?.items ?? [];
}

describe("Canvas capture local file reuse", () => {
  it("stages an unchanged prior archived file without downloading it again", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    const reuseMetadata: unknown[] = [];
    const { result, browserFileDownload } = await runCapture({
      appDirectory: prior.appDirectory,
      files: [unchangedFile()],
      stageFileReuse: async (index, metadata, stagingDirectory) => {
        reuseMetadata.push(metadata);
        return stageReusedCanvasFile(index, metadata, stagingDirectory);
      },
    });
    expect(browserFileDownload).not.toHaveBeenCalled();
    // Only content-free metadata reaches the reuse helper; the raw Canvas URL never does.
    expect(reuseMetadata).toEqual([{ fileId: FILE_ID, size: PRIOR_BODY.length, modifiedAt: T1,
      updatedAt: T1, contentType: "application/pdf", locked: false, hidden: false,
      lockedForUser: false, hiddenForUser: false }]);

    const bodies = archivedBodies(result);
    expect(bodies).toEqual([{ fileId: FILE_ID, status: "archived", expectedSize: PRIOR_BODY.length,
      byteCount: PRIOR_BODY.length, sha256: prior.sha, contentType: "application/pdf",
      sourceAuthenticity: "unverified" }]);
    const { archive, pointer, manifest } = await currentManifest(prior.appDirectory);
    expect(manifest).toMatchObject({ version: 2, runId: RUN_ID, generationId: pointer.generationId,
      blobs: [{ fileId: FILE_ID, byteCount: PRIOR_BODY.length, sha256: prior.sha,
        contentType: "application/pdf", sourceAuthenticity: "unverified" }] });
    // The reused content-addressed blob is deduplicated against the prior generation.
    expect(await readdir(path.join(archive, "blobs"))).toEqual([`${prior.sha}.blob`]);
    expect(await readFile(path.join(archive, "blobs", `${prior.sha}.blob`))).toEqual(PRIOR_BODY);
    expect((await readdir(prior.appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-"))).toEqual([]);
  });

  it("reports progress while copying and rejects a reuse copy over the remaining budget", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    const index = await loadCanvasFileReuseIndex({ appDirectory: prior.appDirectory, expectedUserId: USER_ID });
    const stagingDirectory = path.join(root, "progress-stage");
    await mkdir(stagingDirectory, { mode: 0o700 });
    await chmod(stagingDirectory, 0o700);
    const events: Array<Record<string, unknown>> = [];
    const metadata = { fileId: FILE_ID, size: PRIOR_BODY.length, modifiedAt: T1, updatedAt: T1,
      contentType: "application/pdf", locked: false, hidden: false,
      lockedForUser: false, hiddenForUser: false };
    const reused = await stageReusedCanvasFile(index, metadata, stagingDirectory, {
      maxBytes: PRIOR_BODY.length, progress: (event: Record<string, unknown>) => events.push(event),
    });
    expect(reused).toMatchObject({ kind: "staged", reused: true });
    expect(events).toEqual([{ phase: "file-reuse-copy", byteCount: PRIOR_BODY.length, totalBytes: PRIOR_BODY.length }]);

    const overBudgetDirectory = path.join(root, "over-budget-stage");
    await mkdir(overBudgetDirectory, { mode: 0o700 });
    await chmod(overBudgetDirectory, 0o700);
    await expect(stageReusedCanvasFile(index, metadata, overBudgetDirectory, { maxBytes: 0 })).resolves.toBeNull();
    await expect(readdir(overBudgetDirectory)).resolves.toEqual([]);
  });

  it("rejects a mismatched prior byte count and cleans staging after cancellation", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    const index = await loadCanvasFileReuseIndex({ appDirectory: prior.appDirectory, expectedUserId: USER_ID });
    expect(index.blobs).not.toBeNull();
    const stagingDirectory = path.join(root, "failed-copy-stage");
    await mkdir(stagingDirectory, { mode: 0o700 });
    await chmod(stagingDirectory, 0o700);
    const blobs = index.blobs as NonNullable<typeof index.blobs>;
    const staging = await inspectCanvasCaptureDirectory(stagingDirectory);
    const receipt = { sha256: prior.sha, byteCount: PRIOR_BODY.length };

    await expect(copyArchivedCanvasBlobToStaging(blobs, staging, {
      ...receipt, byteCount: PRIOR_BODY.length + 1,
    })).rejects.toMatchObject({ code: "ARCHIVE_BLOB_MISMATCH" });
    await expect(readdir(stagingDirectory)).resolves.toEqual([]);

    await expect(copyArchivedCanvasBlobToStaging(blobs, staging, receipt, AbortSignal.abort()))
      .rejects.toMatchObject({ code: "CANCELED" });
    await expect(readdir(stagingDirectory)).resolves.toEqual([]);
  });

  it("downloads new or changed files even when the byte size is unchanged", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    const { result, browserFileDownload } = await runCapture({
      appDirectory: prior.appDirectory,
      files: [{ fileId: FILE_ID, size: PRIOR_BODY.length, modifiedAt: T2, updatedAt: T2,
        contentType: "application/pdf" }],
    });
    expect(browserFileDownload).toHaveBeenCalledTimes(1);
    expect(archivedBodies(result)[0]).toMatchObject({ fileId: FILE_ID, status: "archived",
      sha256: sha256(REFRESHED_BODY) });
    const { archive } = await currentManifest(prior.appDirectory);
    expect(await readdir(path.join(archive, "blobs"))).toHaveLength(2);

    const rootTwo = await directory();
    const priorTwo = await priorArchive(rootTwo);
    const replacedId = await runCapture({ appDirectory: priorTwo.appDirectory,
      files: [{ fileId: FILE_ID + 1, size: PRIOR_BODY.length, modifiedAt: T1, updatedAt: T1,
        contentType: "application/pdf" }] });
    expect(replacedId.browserFileDownload).toHaveBeenCalledTimes(1);

    const rootThree = await directory();
    const priorThree = await priorArchive(rootThree);
    const retyped = await runCapture({ appDirectory: priorThree.appDirectory,
      files: [{ fileId: FILE_ID, size: PRIOR_BODY.length, modifiedAt: T1, updatedAt: T1,
        contentType: "text/plain" }] });
    expect(retyped.browserFileDownload).toHaveBeenCalledTimes(1);
  });

  it("downloads when current revision stamps are missing or invalid", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    const missing = await runCapture({ appDirectory: prior.appDirectory,
      files: [{ fileId: FILE_ID, size: PRIOR_BODY.length, modifiedAt: null, updatedAt: null,
        contentType: "application/pdf" }] });
    expect(missing.browserFileDownload).toHaveBeenCalledTimes(1);

    const rootTwo = await directory();
    const priorTwo = await priorArchive(rootTwo);
    const invalid = await runCapture({ appDirectory: priorTwo.appDirectory,
      files: [{ fileId: FILE_ID, size: PRIOR_BODY.length, modifiedAt: "not-a-timestamp",
        updatedAt: T1, contentType: "application/pdf" }] });
    expect(invalid.browserFileDownload).toHaveBeenCalledTimes(1);
    const malformed = await runCapture({ appDirectory: prior.appDirectory,
      files: [{ ...unchangedFile(), modifiedAt: "0" }] });
    expect(malformed.browserFileDownload).toHaveBeenCalledTimes(1);
    const invalidCalendarDate = await runCapture({ appDirectory: prior.appDirectory,
      files: [{ ...unchangedFile(), modifiedAt: "2026-02-30T10:00:00Z", updatedAt: "2026-02-30T10:00:00Z" }] });
    expect(invalidCalendarDate.browserFileDownload).toHaveBeenCalledTimes(1);
  });

  it("downloads when prior metadata lacks usable revision evidence", async () => {
    const root = await directory();
    const prior = await priorArchive(root, { omitMetadata: true });
    const { browserFileDownload } = await runCapture({ appDirectory: prior.appDirectory,
      files: [unchangedFile()] });
    expect(browserFileDownload).toHaveBeenCalledTimes(1);
  });

  it("downloads for a different confirmed account than the prior generation", async () => {
    const root = await directory();
    const prior = await priorArchive(root, { userId: USER_ID });
    const { browserFileDownload } = await runCapture({ appDirectory: prior.appDirectory,
      expectedUserId: 42, files: [{ fileId: FILE_ID, size: PRIOR_BODY.length, modifiedAt: T1,
        updatedAt: T1, contentType: "application/pdf" }] });
    expect(browserFileDownload).toHaveBeenCalledTimes(1);
  });

  it("downloads when the archive pointer is absent", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    await rm(path.join(prior.appDirectory, "canvas-capture-archive"), { recursive: true, force: true });
    const { result, browserFileDownload } = await runCapture({ appDirectory: prior.appDirectory,
      files: [unchangedFile()] });
    expect(browserFileDownload).toHaveBeenCalledTimes(1);
    expect(archivedBodies(result)[0]).toMatchObject({ fileId: FILE_ID, status: "archived",
      sha256: sha256(REFRESHED_BODY) });
  });

  it("downloads, then fails closed, when the archive pointer is invalid", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    await writeFile(path.join(prior.appDirectory, "canvas-capture-archive", "current.json"),
      "{\"broken\": true}\n", { mode: 0o600 });
    const harness = await captureHarness({ appDirectory: prior.appDirectory, files: [unchangedFile()] });
    // Reuse treats the unusable archive as a cache miss, and the existing save safeguard still
    // refuses to commit a new generation alongside a tampered pointer.
    await expect(harness.runPromise).rejects.toMatchObject({ code: "ARCHIVE_STATE_INVALID" });
    expect(harness.browserFileDownload).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(await readFile(
      path.join(prior.appDirectory, "canvas-capture-last-error.json"), "utf8")) as {
      phase: string; endpoint: string; errorCode: string;
    };
    expect(diagnostic).toEqual({ phase: "archiving", endpoint: "unknown",
      errorCode: "ARCHIVE_STATE_INVALID" });
    expect((await readdir(prior.appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-")))
      .toEqual([]);
  });

  it("downloads and never promotes bad bytes when the prior blob is corrupt", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    const blobPath = path.join(prior.appDirectory, "canvas-capture-archive", "blobs", `${prior.sha}.blob`);
    await writeFile(blobPath, Buffer.concat([Buffer.from("X"), PRIOR_BODY.subarray(1)]), { mode: 0o600 });
    const { result, browserFileDownload } = await runCapture({ appDirectory: prior.appDirectory,
      files: [unchangedFile()] });
    expect(browserFileDownload).toHaveBeenCalledTimes(1);
    expect(archivedBodies(result)[0]).toMatchObject({ fileId: FILE_ID, status: "archived",
      sha256: sha256(REFRESHED_BODY) });
    const { archive } = await currentManifest(prior.appDirectory);
    const blobs = await readdir(path.join(archive, "blobs"));
    expect(blobs).toContain(`${prior.sha}.blob`);
    expect(blobs).toContain(`${sha256(REFRESHED_BODY)}.blob`);
    expect((await readdir(prior.appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-")))
      .toEqual([]);
  });

  it("downloads when the prior blob is missing", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    await unlink(path.join(prior.appDirectory, "canvas-capture-archive", "blobs", `${prior.sha}.blob`));
    const { result, browserFileDownload } = await runCapture({ appDirectory: prior.appDirectory,
      files: [unchangedFile()] });
    expect(browserFileDownload).toHaveBeenCalledTimes(1);
    expect(archivedBodies(result)[0]).toMatchObject({ fileId: FILE_ID, status: "archived",
      sha256: sha256(REFRESHED_BODY) });
  });

  it("fails closed when the prior blob is a symlink", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    const blobPath = path.join(prior.appDirectory, "canvas-capture-archive", "blobs", `${prior.sha}.blob`);
    const target = path.join(root, "symlink-target.blob");
    await writeFile(target, PRIOR_BODY, { mode: 0o600 });
    await unlink(blobPath);
    await symlink(target, blobPath);
    const harness = await captureHarness({ appDirectory: prior.appDirectory, files: [unchangedFile()] });
    // The reuse copy rejects the symlink and downloads instead; the existing archive safeguard
    // then refuses to commit while an unsafe blob remains in the archive.
    await expect(harness.runPromise).rejects.toMatchObject({ code: "UNSAFE_FILE" });
    expect(harness.browserFileDownload).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(await readFile(
      path.join(prior.appDirectory, "canvas-capture-last-error.json"), "utf8")) as {
      phase: string; endpoint: string; errorCode: string;
    };
    expect(diagnostic).toEqual({ phase: "archiving", endpoint: "unknown", errorCode: "UNSAFE_FILE" });
    expect((await readdir(prior.appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-")))
      .toEqual([]);
  });

  it("downloads when prior duplicate metadata records conflict", async () => {
    const root = await directory();
    const prior = await priorArchive(root, { metadataResources: [
      { endpoint: "file", courseId: null, items: [{ id: FILE_ID, size: PRIOR_BODY.length,
        "content-type": "application/pdf", modified_at: T2, updated_at: T2,
        locked: false, hidden: false, locked_for_user: false, hidden_for_user: false }] },
    ] });
    const { browserFileDownload } = await runCapture({ appDirectory: prior.appDirectory,
      files: [unchangedFile()] });
    expect(browserFileDownload).toHaveBeenCalledTimes(1);
  });

  it("downloads when the current file is restricted or access flags are absent", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    const locked = await runCapture({ appDirectory: prior.appDirectory,
      files: [{ ...unchangedFile(), locked: true }] });
    expect(locked.browserFileDownload).toHaveBeenCalledTimes(1);

    const rootTwo = await directory();
    const priorTwo = await priorArchive(rootTwo);
    const hidden = await runCapture({ appDirectory: priorTwo.appDirectory,
      files: [{ ...unchangedFile(), hidden: true }] });
    expect(hidden.browserFileDownload).toHaveBeenCalledTimes(1);

    const rootThree = await directory();
    const priorThree = await priorArchive(rootThree);
    const lockedForUser = await runCapture({ appDirectory: priorThree.appDirectory,
      files: [{ ...unchangedFile(), lockedForUser: true }] });
    expect(lockedForUser.browserFileDownload).toHaveBeenCalledTimes(1);

    const rootFour = await directory();
    const priorFour = await priorArchive(rootFour);
    const hiddenForUser = await runCapture({ appDirectory: priorFour.appDirectory,
      files: [{ ...unchangedFile(), hiddenForUser: true }] });
    expect(hiddenForUser.browserFileDownload).toHaveBeenCalledTimes(1);

    const rootFive = await directory();
    const priorFive = await priorArchive(rootFive);
    const unknown = await runCapture({ appDirectory: priorFive.appDirectory,
      files: [{ fileId: FILE_ID, size: PRIOR_BODY.length, modifiedAt: T1, updatedAt: T1,
        contentType: "application/pdf" }] });
    expect(unknown.browserFileDownload).toHaveBeenCalledTimes(1);
  });

  it("re-downloads and removes the replaced copy when current duplicate metadata conflicts", async () => {
    const root = await directory();
    const prior = await priorArchive(root);
    const { result, browserFileDownload } = await runCapture({
      appDirectory: prior.appDirectory,
      files: [
        { ...unchangedFile() },
        { ...unchangedFile(), modifiedAt: T2, updatedAt: T2 },
      ],
    });
    // The first record reused prior bytes; the conflicting newer record forced one fresh download.
    expect(browserFileDownload).toHaveBeenCalledTimes(1);
    const bodies = archivedBodies(result);
    expect(bodies).toEqual([{ fileId: FILE_ID, status: "archived", expectedSize: PRIOR_BODY.length,
      byteCount: REFRESHED_BODY.length,
      sha256: sha256(REFRESHED_BODY), contentType: "application/pdf",
      sourceAuthenticity: "unverified" }]);
    const { archive } = await currentManifest(prior.appDirectory);
    expect(await readdir(path.join(archive, "blobs"))).toHaveLength(2);
    expect((await readdir(prior.appDirectory)).filter((entry) => entry.startsWith("canvas-capture-stage-"))).toEqual([]);
  });

  it("derives syllabus sessions from staged reused bytes", async () => {
    const root = await directory();
    const syllabusText = "Class meetings\nMonday January 14, 2030 18:00-20:30";
    const syllabusBody = Buffer.from(syllabusText, "utf8");
    const prior = await priorArchive(root, { body: syllabusBody, contentType: "text/plain" });
    const { result, browserFileDownload } = await runCapture({
      appDirectory: prior.appDirectory,
      files: [{ fileId: FILE_ID, size: syllabusBody.length, modifiedAt: T1, updatedAt: T1,
        contentType: "text/plain", locked: false, hidden: false, lockedForUser: false, hiddenForUser: false }],
      activeCourses: [COURSE_ID],
      extraResources: [
        { endpoint: "course", courseId: COURSE_ID, items: [{ id: COURSE_ID,
          time_zone: "America/New_York", syllabus_body: "" }] },
        { endpoint: "courseFiles", courseId: COURSE_ID, items: [{ id: FILE_ID,
          display_name: "syllabus.txt" }] },
      ],
    });
    expect(browserFileDownload).not.toHaveBeenCalled();
    expect(archivedView(result).syllabusSessions).toEqual({ schemaVersion: 1, courses: [{
      courseId: COURSE_ID, timeZone: "America/New_York", status: "complete",
      sessions: [expect.objectContaining({ date: "2030-01-14", startTime: "18:00", endTime: "20:30" })],
    }] });
  });
});
