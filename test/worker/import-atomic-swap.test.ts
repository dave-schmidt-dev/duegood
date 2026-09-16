import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findOrCreateAccount, findOrCreateCourse, getCourseById } from "../../src/db/repository";
import { acquireImportLease } from "../../src/import/lease";
import { commitSnapshot, LeaseFencedError } from "../../src/import/snapshot-commit";

async function makeCourse(canvasUserId: string, canvasCourseId: string) {
  const account = await findOrCreateAccount(env.DB, "https://marymount.instructure.com", canvasUserId, 1000);
  const course = await findOrCreateCourse(env.DB, {
    id: crypto.randomUUID(),
    accountId: account.id,
    canvasCourseId,
    courseCode: "TECH 101",
    title: "Introduction to Computing",
    term: "Fall 2026",
    now: 1000,
  });
  return { account, course };
}

async function sourceItem(courseId: string, canvasItemId: string) {
  return env.DB.prepare(`SELECT * FROM source_items WHERE course_id = ?1 AND canvas_item_id = ?2`)
    .bind(courseId, canvasItemId)
    .first<{ fingerprint: string; available: number; last_seen_generation: number }>();
}

describe("commitSnapshot", () => {
  it("upserts new rows and bumps the course generation, exposing nothing before the batch returns", async () => {
    const { account, course } = await makeCourse("swap-1", "9001");
    const lease = await acquireImportLease(env.DB, course.id, 2000);

    const newGeneration = await commitSnapshot(
      env.DB,
      {
        accountId: account.id,
        lease: lease!,
        upserts: [
          { canvasItemId: "50001", fingerprint: "fp-a" },
          { canvasItemId: "50002", fingerprint: "fp-b" },
        ],
        newlyUnavailableCanvasItemIds: [],
      },
      3000,
    );

    expect(newGeneration).toBe(1);
    const stored = await getCourseById(env.DB, course.id);
    expect(stored?.snapshotGeneration).toBe(1);
    expect(stored?.importLeaseToken).toBeNull();
    expect(stored?.lastSuccessfulCheckAt).toBe(3000);

    const item = await sourceItem(course.id, "50001");
    expect(item?.fingerprint).toBe("fp-a");
    expect(item?.available).toBe(1);
    expect(item?.last_seen_generation).toBe(1);
  });

  it("marks a previously-seen item unavailable without deleting its row", async () => {
    const { account, course } = await makeCourse("swap-2", "9001");
    const firstLease = await acquireImportLease(env.DB, course.id, 2000);
    await commitSnapshot(
      env.DB,
      { accountId: account.id, lease: firstLease!, upserts: [{ canvasItemId: "50001", fingerprint: "fp-a" }], newlyUnavailableCanvasItemIds: [] },
      3000,
    );

    const secondLease = await acquireImportLease(env.DB, course.id, 4000);
    await commitSnapshot(
      env.DB,
      { accountId: account.id, lease: secondLease!, upserts: [], newlyUnavailableCanvasItemIds: ["50001"] },
      5000,
    );

    const item = await sourceItem(course.id, "50001");
    expect(item?.available).toBe(0);
    expect(item?.fingerprint).toBe("fp-a");
  });

  it("rejects a commit against a lease token that no longer matches, writing nothing", async () => {
    const { account, course } = await makeCourse("swap-3", "9001");
    const staleLease = await acquireImportLease(env.DB, course.id, 2000);
    // Someone else reclaims after expiry and commits first, advancing the generation.
    const laterLease = await acquireImportLease(env.DB, course.id, staleLease!.expiresAt + 1);
    await commitSnapshot(
      env.DB,
      { accountId: account.id, lease: laterLease!, upserts: [{ canvasItemId: "50001", fingerprint: "fp-real" }], newlyUnavailableCanvasItemIds: [] },
      staleLease!.expiresAt + 100,
    );

    await expect(
      commitSnapshot(
        env.DB,
        { accountId: account.id, lease: staleLease!, upserts: [{ canvasItemId: "50002", fingerprint: "fp-stale" }], newlyUnavailableCanvasItemIds: [] },
        staleLease!.expiresAt + 200,
      ),
    ).rejects.toThrow(LeaseFencedError);

    expect(await sourceItem(course.id, "50002")).toBeNull();
    const stored = await getCourseById(env.DB, course.id);
    expect(stored?.snapshotGeneration).toBe(1);
  });

  it("chains correctly across two real sequential commits, each fenced on the generation before it", async () => {
    const { account, course } = await makeCourse("swap-4", "9001");

    const firstLease = await acquireImportLease(env.DB, course.id, 2000);
    expect(firstLease?.expectedGeneration).toBe(0);
    await commitSnapshot(
      env.DB,
      { accountId: account.id, lease: firstLease!, upserts: [{ canvasItemId: "50001", fingerprint: "fp-a" }], newlyUnavailableCanvasItemIds: [] },
      3000,
    );

    const secondLease = await acquireImportLease(env.DB, course.id, 4000);
    expect(secondLease?.expectedGeneration).toBe(1);
    const finalGeneration = await commitSnapshot(
      env.DB,
      { accountId: account.id, lease: secondLease!, upserts: [{ canvasItemId: "50001", fingerprint: "fp-a-updated" }], newlyUnavailableCanvasItemIds: [] },
      5000,
    );

    expect(finalGeneration).toBe(2);
    const item = await sourceItem(course.id, "50001");
    expect(item?.fingerprint).toBe("fp-a-updated");
    expect(item?.last_seen_generation).toBe(2);
  });
});
