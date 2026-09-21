import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureCanvasSnapshot, diffCanvasSnapshots, recordRefreshFailure, recordRefreshSuccess, recoverMissedGradeHistory } from "../../src/local/refresh-history";

const directories: string[] = [];

async function fixture(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "duegood-refresh-history-"));
  directories.push(directory);
  const file = path.join(directory, "coursework.json");
  await writeFile(file, JSON.stringify({
    schema: 1,
    sync: { status: "complete" },
    courses: [{ key: "course-a", code: "SYN-101" }],
    items: [
      { id: "canvas-1", course: "course-a", source: "canvas", canvasId: 1, title: "Submitted", at: "2030-01-10", points: 20, submissionStatus: "pending", gradedAt: null, grade: null, score: null, done: false, notes: "private" },
      { id: "manual-1", course: "course-a", source: "manual", canvasId: null, title: "Manual note", at: "2030-01-11", points: 5, submissionStatus: "pending", gradedAt: null, grade: null, score: null, done: false },
    ],
  }, null, 2));
  return { directory, file };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("refresh history", () => {
  it("excludes manual items from Canvas change detection", async () => {
    const { file } = await fixture();
    const snapshot = await captureCanvasSnapshot(file);
    expect(snapshot.items.map((item) => item.id)).toEqual(["canvas-1"]);
  });

  it("records grade-only changes while excluding local completion and notes", async () => {
    const { directory, file } = await fixture();
    const before = await captureCanvasSnapshot(file);
    const document = JSON.parse(await readFile(file, "utf8"));
    document.items[0].submissionStatus = "graded";
    document.items[0].gradedAt = "2030-01-09T12:00:00Z";
    document.items[0].grade = "A";
    document.items[0].score = 19;
    document.items[0].done = true;
    document.items[0].notes = "changed locally";
    await writeFile(file, `${JSON.stringify(document)}\n`);
    const after = await captureCanvasSnapshot(file);
    const diff = diffCanvasSnapshots(before, after);
    expect(diff).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(diff.changes[0]?.fields?.map((field) => field.field)).toEqual(["submissionState", "gradedAt", "grade", "score"]);
    const event = await recordRefreshSuccess(directory, before, after, "2030-01-09T12:00:00Z", "2030-01-09T12:01:00Z");
    expect(event.status).toBe("succeeded");
    const history = JSON.parse(await readFile(path.join(directory, "coursework-refresh-history.json"), "utf8"));
    expect(history.events).toHaveLength(1);
    expect(JSON.stringify(history.events[0])).not.toContain("notes");
    expect(JSON.stringify(history.events[0])).not.toContain("done");
  });

  it("bounds appended events and preserves the newest schema-1 window", async () => {
    const { directory, file } = await fixture();
    const before = await captureCanvasSnapshot(file);
    const after = await captureCanvasSnapshot(file);
    for (let index = 0; index < 105; index += 1) await recordRefreshSuccess(directory, before, after, `2030-01-01T00:00:${String(index).padStart(2, "0")}Z`, `2030-01-01T00:01:${String(index).padStart(2, "0")}Z`);
    const history = JSON.parse(await readFile(path.join(directory, "coursework-refresh-history.json"), "utf8"));
    expect(history.schema).toBe(1);
    expect(history.events).toHaveLength(100);
    expect(history.events[0].startedAt).toContain(":05Z");
    expect(history.events.at(-1).startedAt).toContain(":104Z");
  });

  it("records a failed event with no false success status", async () => {
    const { directory } = await fixture();
    const event = await recordRefreshFailure(directory, "2030-01-09T12:00:00Z", "2030-01-09T12:00:05Z", new Error("synthetic refresh failed"));
    expect(event).toMatchObject({ status: "failed", summary: { added: 0, updated: 0, removed: 0 } });
    const history = JSON.parse(await readFile(path.join(directory, "coursework-refresh-history.json"), "utf8"));
    expect(history.events[0]).toMatchObject({ status: "failed", error: "synthetic refresh failed" });
    expect(history.events[0].sourceComplete).toBeUndefined();
  });

  it("records an incomplete source as partial instead of claiming success", async () => {
    const { directory, file } = await fixture();
    const before = await captureCanvasSnapshot(file);
    const document = JSON.parse(await readFile(file, "utf8"));
    document.sync.status = "partial";
    await writeFile(file, `${JSON.stringify(document)}\n`);
    const after = await captureCanvasSnapshot(file);
    const event = await recordRefreshSuccess(directory, before, after, "2030-01-09T12:00:00Z", "2030-01-09T12:01:00Z");
    expect(event).toMatchObject({ status: "incomplete", sourceComplete: false });
  });

  it("recovers a missed grade boundary once with an incomplete, before-unknown event", async () => {
    const { directory, file } = await fixture();
    await writeFile(path.join(directory, "coursework-refresh-history.json"), JSON.stringify({ schema: 1, events: [
      { id: "old", status: "succeeded", sourceComplete: true, startedAt: "2030-01-09T11:00:00Z", finishedAt: "2030-01-09T11:01:00Z", summary: { added: 0, updated: 0, removed: 0 }, changes: [] },
      { id: "partial", status: "succeeded", sourceComplete: false, startedAt: "2030-01-09T13:00:00Z", finishedAt: "2030-01-09T13:01:00Z", summary: { added: 0, updated: 0, removed: 0 }, changes: [] },
      { id: "failed", status: "failed", startedAt: "2030-01-09T14:00:00Z", finishedAt: "2030-01-09T14:01:00Z", summary: { added: 0, updated: 0, removed: 0 }, changes: [] },
    ] }));
    const document = JSON.parse(await readFile(file, "utf8"));
    document.items[0].submissionStatus = "graded";
    document.items[0].gradedAt = "2030-01-09T12:00:00Z";
    document.items[0].grade = "A";
    document.items[0].score = 19;
    await writeFile(file, `${JSON.stringify(document)}\n`);
    const current = await captureCanvasSnapshot(file);
    const recovered = await recoverMissedGradeHistory(directory, current, "2030-01-09T13:00:00Z");
    expect(recovered).toMatchObject({ recovery: "recovery-v1", status: "incomplete", sourceComplete: false, summary: { added: 0, updated: 1, removed: 0 } });
    expect(recovered?.changes[0]).toMatchObject({ kind: "notice", title: "Earlier grade history recovered" });
    expect(recovered?.changes[1]?.fields).toEqual([
      { field: "submissionState", before: null, after: "graded" },
      { field: "gradedAt", before: null, after: "2030-01-09T12:00:00Z" },
      { field: "grade", before: null, after: "A" },
      { field: "score", before: null, after: 19 },
    ]);
    expect(await recoverMissedGradeHistory(directory, current, "2030-01-09T14:00:00Z")).toBeNull();
    const history = JSON.parse(await readFile(path.join(directory, "coursework-refresh-history.json"), "utf8"));
    expect(history.events).toHaveLength(4);
  });

  it("does not recover without a valid boundary or a newer graded item", async () => {
    const { directory, file } = await fixture();
    const current = await captureCanvasSnapshot(file);
    expect(await recoverMissedGradeHistory(directory, current, "2030-01-09T14:00:00Z")).toBeNull();
    await writeFile(path.join(directory, "coursework-refresh-history.json"), JSON.stringify({ schema: 1, events: [{ id: "old", status: "succeeded", finishedAt: "not-a-date", summary: {}, changes: [] }] }));
    expect(await recoverMissedGradeHistory(directory, current, "2030-01-09T14:00:00Z")).toBeNull();
  });

  it("quarantines corrupt history and records an incomplete recovery without touching coursework", async () => {
    const { directory, file } = await fixture();
    const courseworkBefore = await readFile(file, "utf8");
    const before = await captureCanvasSnapshot(file);
    await writeFile(path.join(directory, "coursework-refresh-history.json"), "{not-json");

    const after = await captureCanvasSnapshot(file);
    const event = await recordRefreshSuccess(directory, before, after, "2030-01-09T12:00:00Z", "2030-01-09T12:01:00Z");

    expect(event).toMatchObject({ status: "incomplete", sourceComplete: false });
    expect(await readFile(file, "utf8")).toBe(courseworkBefore);
    const history = JSON.parse(await readFile(path.join(directory, "coursework-refresh-history.json"), "utf8"));
    expect(history.events[0]).toMatchObject({ recovery: "history-corrupt-v1", status: "incomplete", sourceComplete: false });
    expect(history.events[0].changes[0]).toMatchObject({ kind: "notice", title: "Refresh history recovered" });
    expect((await readdir(directory)).some((entry) => entry.startsWith("coursework-refresh-history.json.corrupt-"))).toBe(true);

    const next = await recordRefreshSuccess(directory, after, after, "2030-01-10T12:00:00Z", "2030-01-10T12:01:00Z");
    expect(next).toMatchObject({ status: "succeeded", sourceComplete: true });
  });
});
