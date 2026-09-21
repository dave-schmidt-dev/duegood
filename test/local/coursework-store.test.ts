import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseworkStore } from "../../src/local/coursework-store";

const directories: string[] = [];

async function fixture(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "duegood-local-"));
  directories.push(directory);
  const file = path.join(directory, "contract.json");
  await writeFile(file, await readFile(path.resolve("fixtures/local-coursework-contract.json")));
  return { directory, file };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("CourseworkStore", () => {
  it("projects assignments and preserves private completion separately", async () => {
    const { file } = await fixture();
    const sourceDocument = JSON.parse(await readFile(file, "utf8"));
    sourceDocument.courses[0].gradeGroups = [
      { id: "group-a", name: "Projects", weight: 60 },
      { id: "group-b", name: null, weight: null },
    ];
    sourceDocument.items[0].assignmentGroupId = "group-a";
    sourceDocument.items[0].assignmentGroupName = "Projects";
    sourceDocument.items[0].assignmentGroupWeight = 60;
    await writeFile(file, `${JSON.stringify(sourceDocument, null, 2)}\n`);
    const store = new CourseworkStore(file);
    const before = await store.read();
    expect(before.courses).toHaveLength(2);
    expect(before.assignments).toHaveLength(2);
    expect(before.events).toHaveLength(2);
    expect(before.courses[0]).toMatchObject({ color: "#3b6f8f", folder: "synthetic-course-a" });
    expect(before.courses[0]?.gradeGroups).toEqual([{ id: "group-a", name: "Projects", weight: 60 }, { id: "group-b", name: null, weight: null }]);
    expect(before.assignments[0]).toMatchObject({ points: 20, score: 18, grade: "18", gradedAt: "2030-01-09T18:00:00Z" });
    expect(before.assignments[0]).toMatchObject({ assignmentGroupId: "group-a", assignmentGroupName: "Projects", assignmentGroupWeight: 60 });
    expect(before.assignments[1]).toMatchObject({ points: 10, score: null, grade: null, gradedAt: null });
    const result = await store.setCompletion("course-a-canvas-910002", true, before.version);
    expect(result.completed).toBe(true);
    const document = JSON.parse(await readFile(file, "utf8"));
    expect(document.items[1].done).toBe(true);
    expect(document.items[1].doneAt).toMatch(/^\d{4}-/);
    expect(document.items[1].syntheticItemExtension).toEqual({ preserve: "pending-item" });
    expect(document.syntheticTopLevelExtension).toEqual({ preserve: ["first", "second"] });
  });

  it("rejects an exact-byte conflict", async () => {
    const { file } = await fixture();
    const store = new CourseworkStore(file);
    const before = await store.read();
    await writeFile(file, `${await readFile(file, "utf8")} `);
    await expect(store.setCompletion("course-a-canvas-910002", true, before.version)).rejects.toThrow("changed");
  });

  it("rejects duplicate stable IDs", async () => {
    const { file } = await fixture();
    const document = JSON.parse(await readFile(file, "utf8"));
    document.items.push({ ...document.items[0] });
    await writeFile(file, JSON.stringify(document));
    await expect(new CourseworkStore(file).read()).rejects.toThrow("duplicate item id");
  });

  it("persists discussion checklist state separately from completion", async () => {
    const { file } = await fixture();
    const document = JSON.parse(await readFile(file, "utf8"));
    document.items.push({
      id: "course-a-canvas-discussion-1",
      course: "course-a",
      kind: "discussion",
      title: "Synthetic Discussion",
      at: "2030-01-12T23:59",
      detail: "Post and reply.",
      submissionStatus: "unsubmitted",
      done: false,
      doneAt: null,
    });
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    const store = new CourseworkStore(file);
    const before = await store.read();
    const discussion = before.events.find((event) => event.kind === "discussion");
    expect(discussion).toMatchObject({ discussionPostDone: false, discussionRepliesDone: false, completed: false });
    const result = await store.setDiscussionProgress(discussion?.sourceItemId ?? "", true, true, before.version);
    expect(result).toMatchObject({ discussionPostDone: true, discussionRepliesDone: true });
    const after = await store.read();
    expect(after.events.find((event) => event.kind === "discussion")).toMatchObject({ discussionPostDone: true, discussionRepliesDone: true, completed: false });
    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted.items.at(-1)).toMatchObject({ discussionPostDone: true, discussionRepliesDone: true, done: false });
  });

  it("merges independent discussion fields from concurrent stale tabs", async () => {
    const { file } = await fixture();
    const document = JSON.parse(await readFile(file, "utf8"));
    document.items.push({
      id: "course-a-canvas-discussion-1",
      course: "course-a",
      kind: "discussion",
      title: "Synthetic Discussion",
      at: "2030-01-12T23:59",
      detail: "Post and reply.",
      submissionStatus: "unsubmitted",
      done: false,
      doneAt: null,
    });
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    const itemId = "course-a-canvas-discussion-1";
    const firstTab = new CourseworkStore(file);
    const secondTab = new CourseworkStore(file);
    await Promise.all([
      firstTab.setDiscussionField(itemId, "discussionPostDone", true),
      secondTab.setDiscussionField(itemId, "discussionRepliesDone", true),
    ]);
    const after = await firstTab.read();
    expect(after.events.find((event) => event.sourceItemId === itemId)).toMatchObject({ discussionPostDone: true, discussionRepliesDone: true });
  });

  it("recovers a lock left by a killed owner", async () => {
    const { file } = await fixture();
    const lockDirectory = `${file}.duegood-lock`;
    await mkdir(lockDirectory);
    await writeFile(`${lockDirectory}/owner.json`, JSON.stringify({ pid: 999_999_999, token: "dead-owner", createdAt: Date.now() }));
    await expect(new CourseworkStore(file).withExclusive(async () => "acquired")).resolves.toBe("acquired");
  });
});
