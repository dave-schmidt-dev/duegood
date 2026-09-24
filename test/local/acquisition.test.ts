import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseworkStore } from "../../src/local/coursework-store";
import { captureCanvasSnapshot, diffCanvasSnapshots } from "../../src/local/refresh-history";
import type { SourceObservation } from "../../src/local/acquisition";

const directories: string[] = [];
const contract = JSON.parse(await readFile(path.resolve("test/fixtures/ical-acquisition-contract.json"), "utf8")) as {
  institution: string;
  icalObservation: SourceObservation;
  ambiguousObservation: SourceObservation;
  transitionRehearsal: {
    course: { key: string; title: string };
    parentBeforeOverride: SourceObservation;
    parentAfterOverride: SourceObservation;
    discussionCheckpoints: SourceObservation[];
    newCourseObservation: SourceObservation;
    apiAdoption: SourceObservation;
  };
};

async function fixture(): Promise<{ file: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "duegood-acquisition-"));
  directories.push(directory);
  const file = path.join(directory, "coursework.json");
  await writeFile(file, await readFile(path.resolve("fixtures/local-coursework-contract.json")));
  return { file };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("source-neutral acquisition", () => {
  it("backfills legacy Canvas references deterministically without changing IDs or personal fields", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const before = JSON.parse(await readFile(file, "utf8"));
    const first = await store.applySourceObservations(contract.institution, []);
    const firstBytes = await readFile(file, "utf8");
    const after = JSON.parse(firstBytes);
    expect(first).toMatchObject({ backfilled: 3, added: 0, updated: 0, held: [] });
    expect(after.items.map((item: { id: string }) => item.id)).toEqual(before.items.map((item: { id: string }) => item.id));
    expect(after.items[0]).toMatchObject({ done: true, doneAt: before.items[0].doneAt, syntheticItemExtension: before.items[0].syntheticItemExtension });
    expect(after.items[0].sourceReferences).toEqual([{ institution: contract.institution, course: "course-a", source: "canvas", id: "910001" }]);
    expect((await store.applySourceObservations(contract.institution, [])).changed).toBe(false);
    expect(await readFile(file, "utf8")).toBe(firstBytes);
  });

  it("creates an iCal observation without assigning canvasId and preserves local mutations and unknown fields", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const result = await store.applySourceObservations(contract.institution, [contract.icalObservation]);
    expect(result).toMatchObject({ added: 1, held: [] });
    const imported = JSON.parse(await readFile(file, "utf8"));
    const item = imported.items.find((candidate: { id: string }) => candidate.id === contract.icalObservation.localId);
    expect(item).toMatchObject({ id: contract.icalObservation.localId, course: "course-a", source: "ical" });
    expect(item).not.toHaveProperty("canvasId");
    expect(item.fieldObservations.title.owner).toEqual(contract.icalObservation.reference);
    item.notesExtension = { preserve: "synthetic-only" };
    await writeFile(file, `${JSON.stringify(imported, null, 2)}\n`);
    const version = (await store.read()).version;
    await store.setCompletion(contract.icalObservation.localId, true, version);
    const mutated = JSON.parse(await readFile(file, "utf8")).items.find((candidate: { id: string }) => candidate.id === contract.icalObservation.localId);
    expect(mutated).toMatchObject({ done: true, notesExtension: { preserve: "synthetic-only" }, sourceReferences: [contract.icalObservation.reference] });
    await store.applySourceObservations(contract.institution, [{ ...contract.icalObservation, fields: { ...contract.icalObservation.fields, title: "Revised synthetic title" } }]);
    const reimported = JSON.parse(await readFile(file, "utf8")).items.find((candidate: { id: string }) => candidate.id === contract.icalObservation.localId);
    expect(reimported).toMatchObject({ done: true, notesExtension: { preserve: "synthetic-only" }, title: "Revised synthetic title" });
  });

  it("rejects duplicate scoped references and holds possible cross-source collisions", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    await expect(store.applySourceObservations(contract.institution, [contract.icalObservation, { ...contract.icalObservation, localId: "other-local-id" }]))
      .rejects.toThrow("duplicate scoped source reference");
    const held = await store.applySourceObservations(contract.institution, [contract.ambiguousObservation]);
    expect(held).toMatchObject({ added: 0, held: [{ reason: "ambiguous-match", candidateIds: ["course-a-canvas-910001", "course-a-canvas-910002"] }] });
    const document = JSON.parse(await readFile(file, "utf8"));
    expect(document.items.some((item: { id: string }) => item.id === contract.ambiguousObservation.localId)).toBe(false);
    expect(document.pendingSourceLinks).toHaveLength(1);
  });

  it("keeps a pre-review pending hold visible and upgrades it on the next source observation", async () => {
    const { file } = await fixture();
    const document = JSON.parse(await readFile(file, "utf8"));
    document.pendingSourceLinks = [{ reference: contract.ambiguousObservation.reference,
      candidateIds: contract.ambiguousObservation.possibleLocalIds, reason: "ambiguous-match" }];
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    const store = new CourseworkStore(file);
    const before = await store.read();
    expect(before.pendingSourceLinks).toMatchObject([{ needsRefresh: true, candidateIds: contract.ambiguousObservation.possibleLocalIds }]);
    await expect(store.resolvePendingSourceLink(contract.institution, before.pendingSourceLinks[0]!.id, "", "reject", before.version))
      .rejects.toThrow("needs a fresh source observation");
    expect(JSON.parse(await readFile(file, "utf8")).pendingSourceLinks).toHaveLength(1);
    await store.applySourceObservations(contract.institution, [contract.ambiguousObservation]);
    const after = await store.read();
    expect(after.pendingSourceLinks).toHaveLength(1);
    expect(after.pendingSourceLinks[0]).toMatchObject({ localId: contract.ambiguousObservation.localId,
      fields: contract.ambiguousObservation.fields, candidateIds: contract.ambiguousObservation.possibleLocalIds });
    expect(after.pendingSourceLinks[0]?.needsRefresh).toBeUndefined();
  });

  it("keeps a conflicting API record distinct without moving an existing calendar reference", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const firstId = "course-a-canvas-910001";
    const secondId = "course-a-canvas-910002";
    await store.applySourceObservations(contract.institution, [{ ...contract.icalObservation, localId: firstId, fields: { title: "Synthetic feed title" } }]);
    const api: SourceObservation = {
      localId: "course-a-api-conflict", course: "course-a",
      reference: { institution: contract.institution, course: "course-a", source: "canvas", id: "api-conflict" },
      verifiedReferences: [contract.icalObservation.reference],
      possibleLocalIds: [secondId],
      fields: { title: "Synthetic API title" },
    };
    const held = await store.applySourceObservations(contract.institution, [api]);
    expect(held.held).toMatchObject([{ reason: "conflicting-match", candidateIds: [firstId, secondId] }]);
    const before = await readFile(file, "utf8");
    const version = (await store.read()).version;
    await expect(store.resolvePendingSourceLink(contract.institution, held.held[0]!.id, secondId, "confirm", version))
      .rejects.toThrow("conflicts with existing provenance");
    expect(await readFile(file, "utf8")).toBe(before);

    await store.resolvePendingSourceLink(contract.institution, held.held[0]!.id, "", "reject", version);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.pendingSourceLinks).toEqual([]);
    expect(after.items.find((item: { id: string }) => item.id === firstId).sourceReferences).toContainEqual(contract.icalObservation.reference);
    const separate = after.items.find((item: { id: string }) => item.id === api.localId);
    expect(separate.sourceReferences).toEqual([api.reference]);
    expect(after.items.map((item: { id: string }) => item.id).filter((id: string) => id === api.localId)).toHaveLength(1);
  });

  it("matches an archived item by immutable local ID instead of creating a duplicate", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const observation: SourceObservation = {
      ...contract.icalObservation,
      localId: "course-a-canvas-919999",
      reference: { institution: contract.institution, course: "course-a", source: "canvas", id: "919999" },
      fields: { title: "Synthetic revised archived fact" },
    };
    const result = await store.applySourceObservations(contract.institution, [observation]);
    expect(result).toMatchObject({ added: 0, updated: 1, held: [] });
    const document = JSON.parse(await readFile(file, "utf8"));
    expect(document.items).toHaveLength(3);
    expect(document.archivedForecastItems[0]).toMatchObject({ id: observation.localId, title: "Synthetic revised archived fact" });
  });

  it("retains field facts from both sources and gives verified Canvas facts display priority", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    await store.applySourceObservations(contract.institution, [contract.icalObservation]);
    const canvasReference = { institution: contract.institution, course: "course-a", source: "canvas" as const, id: "synthetic-api-1" };
    const canvasObservation: SourceObservation = {
      localId: contract.icalObservation.localId,
      course: "course-a",
      reference: canvasReference,
      verifiedReferences: [contract.icalObservation.reference],
      fields: { title: "Verified API title" },
    };
    await store.applySourceObservations(contract.institution, [canvasObservation]);
    await store.applySourceObservations(contract.institution, [{ ...contract.icalObservation, fields: { title: "Newer feed title" } }]);
    const item = JSON.parse(await readFile(file, "utf8")).items.find((candidate: { id: string }) => candidate.id === contract.icalObservation.localId);
    expect(item.title).toBe("Verified API title");
    expect(item.fieldObservations.title).toEqual({
      owner: canvasReference,
      value: "Verified API title",
      alternatives: [{ owner: contract.icalObservation.reference, value: "Newer feed title" }],
    });
    expect(item).not.toHaveProperty("canvasId");
  });

  it("preserves legacy Canvas display facts when linked iCal evidence arrives", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const observation: SourceObservation = {
      ...contract.icalObservation,
      localId: "course-a-canvas-910001",
      fields: { title: "Different feed title" },
    };
    await store.applySourceObservations(contract.institution, [observation]);
    const item = JSON.parse(await readFile(file, "utf8")).items[0];
    expect(item.title).toBe("Synthetic Submitted Work");
    expect(item.fieldObservations.title).toEqual({
      owner: { institution: contract.institution, course: "course-a", source: "canvas", id: "910001" },
      value: "Synthetic Submitted Work",
      alternatives: [{ owner: contract.icalObservation.reference, value: "Different feed title" }],
    });
  });

  it("shows the linked calendar due date while keeping the prior Canvas date and grade facts", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const observation: SourceObservation = {
      ...contract.icalObservation,
      localId: "course-a-canvas-910001",
      observedAt: "2030-01-15T10:00:00Z",
      fields: { at: "2030-01-25T15:00:00.000Z" },
    };
    await store.applySourceObservations(contract.institution, [observation]);
    const item = JSON.parse(await readFile(file, "utf8")).items[0];
    expect(item).toMatchObject({ id: "course-a-canvas-910001", at: "2030-01-25T15:00:00.000Z", done: true, grade: "18", score: 18 });
    expect(item.fieldObservations.at.selected ?? item.fieldObservations.at).toMatchObject({ owner: observation.reference, value: "2030-01-25T15:00:00.000Z" });
    expect(item.fieldObservations.at.alternatives).toContainEqual({
      owner: { institution: contract.institution, course: "course-a", source: "canvas", id: "910001" }, value: "2030-01-10T23:59",
    });
    const freshApi: SourceObservation = {
      localId: "course-a-canvas-910001", course: "course-a",
      reference: { institution: contract.institution, course: "course-a", source: "canvas", id: "910001" },
      observedAt: "2030-01-16T10:00:00Z", fields: { at: "2030-01-27T15:00:00.000Z" },
    };
    await store.applySourceObservations(contract.institution, [freshApi]);
    await store.applySourceObservations(contract.institution, [{ ...observation, observedAt: "2030-01-17T10:00:00Z" }]);
    const afterApi = JSON.parse(await readFile(file, "utf8")).items[0];
    expect(afterApi.at).toBe("2030-01-27T15:00:00.000Z");
    expect(afterApi.fieldObservations.at.owner).toEqual(freshApi.reference);
    expect(afterApi.fieldObservations.at.alternatives).toContainEqual({
      owner: observation.reference, value: "2030-01-25T15:00:00.000Z", observedAt: "2030-01-15T10:00:00Z",
    });
  });

  it("records a fresh same-value API due-date capture before a later calendar observation", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const legacyId = "course-a-canvas-910001";
    await store.applySourceObservations(contract.institution, [{ ...contract.icalObservation, localId: legacyId,
      fields: { at: "2030-01-25T15:00:00.000Z" } }]);
    const freshApi: SourceObservation = { localId: legacyId, course: "course-a",
      reference: { institution: contract.institution, course: "course-a", source: "canvas", id: "910001" },
      observedAt: "2030-01-16T10:00:00Z", fields: { at: "2030-01-10T23:59" } };
    await store.applySourceObservations(contract.institution, [freshApi]);
    await store.applySourceObservations(contract.institution, [{ ...contract.icalObservation, localId: legacyId,
      observedAt: "2030-01-15T10:00:00Z", fields: { at: "2030-01-26T15:00:00.000Z" } }]);
    const item = JSON.parse(await readFile(file, "utf8")).items[0];
    expect(item.at).toBe("2030-01-10T23:59");
    expect(item.fieldObservations.at).toMatchObject({ owner: freshApi.reference, observedAt: freshApi.observedAt });
  });

  it("changes a supplied fact timestamp only when its value changes", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const first = { ...contract.icalObservation, observedAt: "2030-01-15T10:00:00Z" };
    await store.applySourceObservations(contract.institution, [first]);
    const bytes = await readFile(file, "utf8");
    const sameFact = { ...first, observedAt: "2030-01-16T10:00:00Z" };
    expect((await store.applySourceObservations(contract.institution, [sameFact])).changed).toBe(false);
    expect(await readFile(file, "utf8")).toBe(bytes);
    await store.applySourceObservations(contract.institution, [{ ...sameFact, fields: { title: "Changed title" } }]);
    const item = JSON.parse(await readFile(file, "utf8")).items.find((candidate: { id: string }) => candidate.id === contract.icalObservation.localId);
    expect(item.fieldObservations.title.observedAt).toBe("2030-01-16T10:00:00Z");
    expect(item.fieldObservations.at.observedAt).toBe("2030-01-15T10:00:00Z");
  });

  it("reserves manual and PDF references for the later explicit grade policy", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    for (const source of ["manual", "pdf"] as const) {
      await expect(store.applySourceObservations(contract.institution, [{
        ...contract.icalObservation,
        reference: { ...contract.icalObservation.reference, source },
        fields: { grade: "A" },
      }])).rejects.toThrow("later grade policy");
    }
  });

  it("rejects repeated references even within one item and refuses unknown source-owned fields", async () => {
    const { file } = await fixture();
    const document = JSON.parse(await readFile(file, "utf8"));
    const reference = { institution: contract.institution, course: "course-a", source: "canvas", id: "910001" };
    document.items[0].sourceReferences = [reference, reference];
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    const store = new CourseworkStore(file);
    await expect(store.read()).rejects.toThrow("duplicate scoped source reference");
    delete document.items[0].sourceReferences;
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    const original = await readFile(file, "utf8");
    await expect(store.applySourceObservations(contract.institution, [{
      ...contract.icalObservation,
      localId: "course-a-canvas-910001",
      fields: { syntheticItemExtension: { overwrite: true } },
    }])).rejects.toThrow("not declared source-owned");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("keeps Activity silent for source-reference bookkeeping and repeat imports byte-identical", async () => {
    const { file } = await fixture();
    const before = await captureCanvasSnapshot(file);
    const store = new CourseworkStore(file);
    await store.applySourceObservations(contract.institution, []);
    const afterBackfill = await captureCanvasSnapshot(file);
    expect(diffCanvasSnapshots(before, afterBackfill)).toMatchObject({ added: 0, updated: 0, removed: 0, changes: [] });
    await store.applySourceObservations(contract.institution, [contract.icalObservation]);
    const once = await readFile(file, "utf8");
    const repeated = await store.applySourceObservations(contract.institution, [contract.icalObservation]);
    expect(repeated.changed).toBe(false);
    expect(await readFile(file, "utf8")).toBe(once);
  });

  it("rehearses a synthetic iCal-to-API transition without losing local state or partial-feed records", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const rehearsal = contract.transitionRehearsal;
    const before = await captureCanvasSnapshot(file);
    await store.applySourceObservations(contract.institution, [
      rehearsal.parentBeforeOverride,
      ...rehearsal.discussionCheckpoints,
    ]);
    const seeded = JSON.parse(await readFile(file, "utf8"));
    seeded.courses.push({ key: rehearsal.course.key, title: rehearsal.course.title });
    const parent = seeded.items.find((item: { id: string }) => item.id === rehearsal.parentBeforeOverride.localId);
    parent.done = true;
    parent.doneAt = "2030-01-31T12:00:00Z";
    parent.discussionPostDone = true;
    parent.notesExtension = { synthetic: "preserved" };
    parent.unknownTransitionField = { synthetic: true };
    parent.manualGradeObservation = { version: 1, value: "manual-synthetic", source: "manual" };
    const pdfItem = seeded.items.find((item: { id: string }) => item.id === rehearsal.discussionCheckpoints[0]!.localId);
    pdfItem.manualGradeObservation = { version: 1, value: "pdf-synthetic", source: "pdf" };
    await writeFile(file, `${JSON.stringify(seeded, null, 2)}\n`);

    const override = await store.applySourceObservations(contract.institution, [
      rehearsal.parentAfterOverride,
      rehearsal.newCourseObservation,
      contract.ambiguousObservation,
    ]);
    expect(override).toMatchObject({ added: 1, held: [{ reason: "ambiguous-match" }] });
    const afterPartialFeed = JSON.parse(await readFile(file, "utf8"));
    const transitioned = afterPartialFeed.items.find((item: { id: string }) => item.id === rehearsal.parentBeforeOverride.localId);
    expect(transitioned).toMatchObject({
      id: rehearsal.parentBeforeOverride.localId,
      done: true,
      doneAt: "2030-01-31T12:00:00Z",
      discussionPostDone: true,
      notesExtension: { synthetic: "preserved" },
      unknownTransitionField: { synthetic: true },
      manualGradeObservation: { value: "manual-synthetic", source: "manual" },
    });
    expect(transitioned.sourceReferences).toEqual(expect.arrayContaining([
      rehearsal.parentBeforeOverride.reference,
      rehearsal.parentAfterOverride.reference,
    ]));
    expect(afterPartialFeed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rehearsal.discussionCheckpoints[0]!.localId, manualGradeObservation: { version: 1, value: "pdf-synthetic", source: "pdf" } }),
      expect.objectContaining({ id: rehearsal.discussionCheckpoints[1]!.localId }),
      expect.objectContaining({ id: rehearsal.newCourseObservation.localId }),
    ]));
    expect(afterPartialFeed.pendingSourceLinks).toHaveLength(1);
    expect(afterPartialFeed.items.filter((item: { id: string }) => item.id === rehearsal.parentBeforeOverride.localId)).toHaveLength(1);

    await store.applySourceObservations(contract.institution, [rehearsal.apiAdoption]);
    const adoptedBytes = await readFile(file, "utf8");
    const adopted = JSON.parse(adoptedBytes).items.find((item: { id: string }) => item.id === rehearsal.parentBeforeOverride.localId);
    expect(adopted).toMatchObject({
      id: rehearsal.parentBeforeOverride.localId,
      done: true,
      notesExtension: { synthetic: "preserved" },
      manualGradeObservation: { value: "manual-synthetic" },
    });
    expect(JSON.parse(adoptedBytes).items.find((item: { id: string }) => item.id === rehearsal.discussionCheckpoints[0]!.localId))
      .toMatchObject({ manualGradeObservation: { value: "pdf-synthetic", source: "pdf" } });
    expect(adopted.sourceReferences).toEqual(expect.arrayContaining([
      rehearsal.parentAfterOverride.reference,
      rehearsal.apiAdoption.reference,
    ]));
    expect((await store.applySourceObservations(contract.institution, [rehearsal.apiAdoption])).changed).toBe(false);
    expect(await readFile(file, "utf8")).toEqual(adoptedBytes);
    const activity = diffCanvasSnapshots(before, await captureCanvasSnapshot(file));
    expect(activity).toMatchObject({ removed: 0 });
    expect(activity.added).toBeGreaterThanOrEqual(4);
  });
});
