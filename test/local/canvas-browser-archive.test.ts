import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveCanvasCaptureGeneration } from "../../scripts/canvas-browser-archive.mjs";

const ORIGIN = "https://marymount.instructure.com";
const temporaryRoots: string[] = [];

type CaptureResource = {
  endpoint: string;
  courseId: number | null;
  pages: number;
  items: Array<Record<string, unknown>>;
};

type CaptureSnapshot = {
  schemaVersion: number;
  source: string;
  capturedAt: string;
  complete: boolean;
  identity: { origin: string; userId: number };
  resources: CaptureResource[];
  coverage: Array<Record<string, unknown>>;
};

type ArchivedSnapshot = { resources: Array<{ items: Array<Record<string, unknown>> }> };

async function fixture(body = Buffer.from("synthetic Canvas file body")) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "duegood-canvas-archive-test-")));
  temporaryRoots.push(root);
  const appDirectory = path.join(root, "app");
  const stagingDirectory = path.join(root, "staging");
  await mkdir(appDirectory, { mode: 0o700 });
  await mkdir(stagingDirectory, { mode: 0o700 });
  await chmod(appDirectory, 0o700);
  await chmod(stagingDirectory, 0o700);
  const stagedFile = randomUUID().replaceAll("-", "") + ".blob";
  const sha256 = createHash("sha256").update(body).digest("hex");
  await writeFile(path.join(stagingDirectory, stagedFile), body, { mode: 0o600, flag: "wx" });
  await chmod(path.join(stagingDirectory, stagedFile), 0o600);
  const snapshot: CaptureSnapshot = {
    schemaVersion: 1,
    source: "canvas-browser",
    capturedAt: "2026-09-27T16:00:00.000Z",
    complete: false,
    identity: { origin: ORIGIN, userId: 41 },
    resources: [
      { endpoint: "profile", courseId: null, pages: 1, items: [{ id: 41, name: "Synthetic student" }] },
      {
        endpoint: "fileBodies",
        courseId: null,
        pages: 1,
        items: [{
          fileId: 77,
          status: "staged",
          expectedSize: body.length,
          byteCount: body.length,
          sha256,
          contentType: "application/pdf",
          stagedFile,
          sourceAuthenticity: "unverified",
        }],
      },
    ],
    coverage: [{ endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" }],
  };
  return { root, appDirectory, stagingDirectory, stagedFile, body, snapshot };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function currentGeneration(appDirectory: string) {
  const archive = path.join(appDirectory, "canvas-capture-archive");
  const pointer = JSON.parse(await readFile(path.join(archive, "current.json"), "utf8")) as { generationId: string };
  return { archive, generationId: pointer.generationId };
}

describe("private Canvas capture archive", () => {
  it("atomically publishes a hashed generation and retains the prior generation on refresh", async () => {
    const data = await fixture();
    const first = await saveCanvasCaptureGeneration(data);
    expect(first).toMatchObject({ complete: false, resourceCount: 2, itemCount: 2, blobCount: 1, blobBytes: data.body.length });
    expect(first).not.toHaveProperty("path");
    const firstItems = (first.archivedSnapshot as ArchivedSnapshot).resources[1]!.items;
    expect(firstItems[0]).toMatchObject({
      fileId: 77,
      status: "archived",
      sha256: data.snapshot.resources[1]!.items[0]!.sha256,
      sourceAuthenticity: "unverified",
    });
    expect(firstItems[0]).not.toHaveProperty("stagedFile");
    const firstCurrent = await currentGeneration(data.appDirectory);
    expect(firstCurrent.generationId).toBe(first.generationId);

    const secondStaging = path.join(data.root, "staging-next");
    await mkdir(secondStaging, { mode: 0o700 });
    await chmod(secondStaging, 0o700);
    const secondBody = Buffer.from("synthetic Canvas file body, refreshed");
    const secondStagedFile = randomUUID().replaceAll("-", "") + ".blob";
    await writeFile(path.join(secondStaging, secondStagedFile), secondBody, { mode: 0o600 });
    await chmod(path.join(secondStaging, secondStagedFile), 0o600);
    const secondHash = createHash("sha256").update(secondBody).digest("hex");
    const secondSnapshot = structuredClone(data.snapshot);
    secondSnapshot.capturedAt = "2026-09-28T16:00:00.000Z";
    secondSnapshot.resources[1]!.items = [{
      fileId: 78,
      status: "staged",
      expectedSize: secondBody.length,
      byteCount: secondBody.length,
      sha256: secondHash,
      contentType: "application/pdf",
      stagedFile: secondStagedFile,
      sourceAuthenticity: "unverified",
    }];
    const second = await saveCanvasCaptureGeneration({
      appDirectory: data.appDirectory,
      snapshot: secondSnapshot,
      stagingDirectory: secondStaging,
    });
    const secondCurrent = await currentGeneration(data.appDirectory);
    expect(secondCurrent.generationId).toBe(second.generationId);
    expect(second.generationId).not.toBe(first.generationId);

    const generations = await readdir(path.join(firstCurrent.archive, "generations"));
    expect(generations.sort()).toEqual([first.generationId, second.generationId].sort());
    for (const generationId of generations) {
      const files = await readdir(path.join(firstCurrent.archive, "generations", generationId));
      expect(files.sort()).toEqual(["manifest.json", "snapshot.json"]);
    }
    const manifest = JSON.parse(await readFile(
      path.join(firstCurrent.archive, "generations", second.generationId, "manifest.json"),
      "utf8",
    )) as { blobs: Array<{ sha256: string; byteCount: number }>; complete: boolean };
    expect(manifest).toMatchObject({
      complete: false,
      blobs: [{ sha256: secondHash, byteCount: secondBody.length }],
    });
    expect(await readFile(path.join(firstCurrent.archive, "blobs", manifest.blobs[0]!.sha256 + ".blob"))).toEqual(secondBody);
    const secondItems = (second.archivedSnapshot as ArchivedSnapshot).resources[1]!.items;
    expect(secondItems[0]).toMatchObject({ fileId: 78, status: "archived", sha256: secondHash });
    expect(secondItems[0]).not.toHaveProperty("stagedFile");
    const firstManifest = JSON.parse(await readFile(
      path.join(firstCurrent.archive, "generations", first.generationId, "manifest.json"),
      "utf8",
    )) as { blobs: Array<{ sha256: string }> };
    expect(await readFile(path.join(firstCurrent.archive, "blobs", firstManifest.blobs[0]!.sha256 + ".blob"))).toEqual(data.body);
    expect(await readdir(path.join(firstCurrent.archive, "blobs"))).toHaveLength(2);
    expect(JSON.stringify(second.archivedSnapshot)).not.toContain(secondStagedFile);
  });

  it("refuses a mismatched staged digest and leaves the previously selected generation untouched", async () => {
    const data = await fixture();
    const first = await saveCanvasCaptureGeneration(data);
    const badSnapshot = structuredClone(data.snapshot);
    const receipt = badSnapshot.resources[1]!.items[0]! as { sha256: string };
    receipt.sha256 = "0".repeat(64);
    await expect(saveCanvasCaptureGeneration({ ...data, snapshot: badSnapshot }))
      .rejects.toMatchObject({ code: "STAGED_BLOB_MISMATCH" });

    const selected = await currentGeneration(data.appDirectory);
    expect(selected.generationId).toBe(first.generationId);
    expect(await readdir(path.join(selected.archive, "generations"))).toEqual([first.generationId]);
    expect(await readdir(path.join(selected.archive, "blobs"))).toHaveLength(1);
  });

  it("rejects unreferenced files in the staging directory without promoting a generation", async () => {
    const data = await fixture();
    await writeFile(path.join(data.stagingDirectory, randomUUID().replaceAll("-", "") + ".blob"), "extra", { mode: 0o600 });
    await expect(saveCanvasCaptureGeneration(data)).rejects.toMatchObject({ code: "STAGING_CONTENT_MISMATCH" });
    const archive = path.join(data.appDirectory, "canvas-capture-archive");
    await expect(readdir(path.join(archive, "generations"))).resolves.toEqual([]);
    await expect(readdir(path.join(archive, "blobs"))).resolves.toEqual([]);
    await expect(readFile(path.join(archive, "current.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects secret-bearing snapshots and oversized blob receipts before promotion", async () => {
    const data = await fixture();
    const secret = structuredClone(data.snapshot) as Record<string, unknown>;
    secret["calendar_ics"] = "https://marymount.instructure.com/feed?token=private";
    await expect(saveCanvasCaptureGeneration({ ...data, snapshot: secret }))
      .rejects.toMatchObject({ code: "PRIVATE_VALUE_REJECTED" });

    const oversized = structuredClone(data.snapshot);
    const item = oversized.resources[1]!.items[0]! as { byteCount: number; expectedSize: number };
    item.byteCount = 256 * 1024 * 1024 + 1;
    item.expectedSize = item.byteCount;
    await expect(saveCanvasCaptureGeneration({ ...data, snapshot: oversized }))
      .rejects.toMatchObject({ code: "INVALID_BLOB_RECEIPT" });
    await expect(readdir(path.join(data.appDirectory, "canvas-capture-archive"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps only owned pending entries older than two hours on the next refresh", async () => {
    const data = await fixture();
    const first = await saveCanvasCaptureGeneration(data);
    const archive = path.join(data.appDirectory, "canvas-capture-archive");
    const generations = path.join(archive, "generations");
    const blobs = path.join(archive, "blobs");
    const staleGeneration = path.join(generations, ".pending-" + randomUUID().replaceAll("-", ""));
    const recentGeneration = path.join(generations, ".pending-" + randomUUID().replaceAll("-", ""));
    const staleBlob = path.join(blobs, ".pending-" + randomUUID().replaceAll("-", "") + ".blob");
    const recentBlob = path.join(blobs, ".pending-" + randomUUID().replaceAll("-", "") + ".blob");
    await mkdir(staleGeneration, { mode: 0o700 });
    await mkdir(recentGeneration, { mode: 0o700 });
    await chmod(staleGeneration, 0o700);
    await chmod(recentGeneration, 0o700);
    await writeFile(path.join(staleGeneration, "snapshot.json"), "old", { mode: 0o600 });
    await writeFile(path.join(recentGeneration, "snapshot.json"), "new", { mode: 0o600 });
    await writeFile(staleBlob, "old", { mode: 0o600 });
    await writeFile(recentBlob, "new", { mode: 0o600 });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(staleGeneration, old, old);
    await utimes(staleBlob, old, old);

    const second = await saveCanvasCaptureGeneration({
      ...data,
      snapshot: { ...data.snapshot, capturedAt: "2026-09-28T16:00:00.000Z" },
    });
    expect(await readdir(generations)).toEqual(expect.arrayContaining([first.generationId, second.generationId, path.basename(recentGeneration)]));
    expect(await readdir(generations)).not.toContain(path.basename(staleGeneration));
    expect(await readdir(blobs)).toContain(path.basename(recentBlob));
    expect(await readdir(blobs)).not.toContain(path.basename(staleBlob));
  });

  it("enforces the four GiB capture budget at its boundary before reading blob contents", async () => {
    const buildBudgetFixture = async (count: number) => {
      const data = await fixture(Buffer.from("unused"));
      const items: Array<Record<string, unknown>> = [];
      await rm(path.join(data.stagingDirectory, data.stagedFile));
      for (let index = 0; index < count; index += 1) {
        const stagedFile = randomUUID().replaceAll("-", "") + ".blob";
        items.push({
          fileId: 1000 + index,
          status: "staged",
          expectedSize: 256 * 1024 * 1024,
          byteCount: 256 * 1024 * 1024,
          sha256: "0".repeat(64),
          contentType: "application/pdf",
          stagedFile,
          sourceAuthenticity: "unverified",
        });
        await writeFile(path.join(data.stagingDirectory, stagedFile), "", { mode: 0o600 });
        await chmod(path.join(data.stagingDirectory, stagedFile), 0o600);
      }
      return {
        ...data,
        snapshot: {
          ...data.snapshot,
          resources: [{ endpoint: "fileBodies", courseId: null, pages: 1, items }],
        },
      };
    };
    const overBudget = await buildBudgetFixture(16);
    await expect(saveCanvasCaptureGeneration(overBudget)).rejects.toMatchObject({ code: "GENERATION_BUDGET_EXCEEDED" });

    const underBudget = await buildBudgetFixture(15);
    await expect(saveCanvasCaptureGeneration(underBudget)).rejects.toMatchObject({ code: "STAGED_BLOB_MISMATCH" });
  });

  it("cleans pending writes when canceled and does not select an incomplete generation", async () => {
    const data = await fixture(Buffer.alloc(8 * 1024 * 1024, 7));
    let checks = 0;
    const signal = {
      addEventListener: () => {},
      get aborted() {
        checks += 1;
        return checks > 3;
      },
    } as unknown as AbortSignal;
    const save = saveCanvasCaptureGeneration({ ...data, signal });
    await expect(save).rejects.toMatchObject({ code: "CANCELED" });
    const archive = path.join(data.appDirectory, "canvas-capture-archive");
    await expect(readFile(path.join(archive, "current.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(archive, "blobs"))).toEqual([]);
    expect((await readdir(path.join(archive, "generations"))).filter((name) => name.startsWith(".pending-"))).toEqual([]);
    await expect(readdir(path.join(archive, ".writer-lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
