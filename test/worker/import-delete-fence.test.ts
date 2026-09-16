import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createConnection, deleteConnection, findOrCreateAccount, findOrCreateCourse, getCourseById, revokeConnection } from "../../src/db/repository";
import { acquireImportLease } from "../../src/import/lease";
import { commitSnapshot, LeaseFencedError } from "../../src/import/snapshot-commit";

async function makeCourseAndConnection(canvasUserId: string, canvasCourseId: string) {
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
  const connection = await createConnection(env.DB, {
    id: crypto.randomUUID(),
    accountId: account.id,
    keyVersion: 1,
    encryptedAccessToken: "envelope",
    encryptedRefreshToken: null,
    accessTokenExpiresAt: null,
    now: 1000,
  });
  return { account, course, connection };
}

async function sourceItem(courseId: string, canvasItemId: string) {
  return env.DB.prepare(`SELECT * FROM source_items WHERE course_id = ?1 AND canvas_item_id = ?2`)
    .bind(courseId, canvasItemId)
    .first<{ fingerprint: string; available: number }>();
}

describe("commitSnapshot connection fence", () => {
  it("rejects the commit after the connection is revoked mid-import (generation bumps, status flips), writing nothing new and leaving the prior row untouched", async () => {
    const { account, course, connection } = await makeCourseAndConnection("fence-1", "9001");
    const firstLease = await acquireImportLease(env.DB, course.id, 2000);
    await commitSnapshot(
      env.DB,
      {
        accountId: account.id,
        lease: firstLease!,
        connectionId: connection.id,
        expectedConnectionGeneration: connection.generation,
        upserts: [{ canvasItemId: "50001", fingerprint: "fp-a" }],
        newlyUnavailableCanvasItemIds: [],
      },
      3000,
    );

    const lease = await acquireImportLease(env.DB, course.id, 4000);
    // Revoked mid-import: same connection row, generation bumps and status leaves 'active'.
    await revokeConnection(env.DB, connection.id, 4500);

    await expect(
      commitSnapshot(
        env.DB,
        {
          accountId: account.id,
          lease: lease!,
          connectionId: connection.id,
          expectedConnectionGeneration: connection.generation,
          upserts: [{ canvasItemId: "50002", fingerprint: "fp-b" }],
          newlyUnavailableCanvasItemIds: ["50001"],
        },
        5000,
      ),
    ).rejects.toThrow(LeaseFencedError);

    expect(await sourceItem(course.id, "50002")).toBeNull();
    const existing = await sourceItem(course.id, "50001");
    expect(existing?.fingerprint).toBe("fp-a");
    expect(existing?.available).toBe(1);
    const stored = await getCourseById(env.DB, course.id);
    expect(stored?.snapshotGeneration).toBe(1);
    expect(stored?.importLeaseToken).toBe(lease!.token);
  });

  it("rejects the commit after the connection is revoked and deleted, writing nothing new and leaving the prior row untouched", async () => {
    const { account, course, connection } = await makeCourseAndConnection("fence-2", "9002");
    const firstLease = await acquireImportLease(env.DB, course.id, 2000);
    await commitSnapshot(
      env.DB,
      {
        accountId: account.id,
        lease: firstLease!,
        connectionId: connection.id,
        expectedConnectionGeneration: connection.generation,
        upserts: [{ canvasItemId: "60001", fingerprint: "fp-a" }],
        newlyUnavailableCanvasItemIds: [],
      },
      3000,
    );

    const lease = await acquireImportLease(env.DB, course.id, 4000);
    const revoked = await revokeConnection(env.DB, connection.id, 4500);
    await deleteConnection(env.DB, revoked.id);

    await expect(
      commitSnapshot(
        env.DB,
        {
          accountId: account.id,
          lease: lease!,
          connectionId: connection.id,
          expectedConnectionGeneration: connection.generation,
          upserts: [{ canvasItemId: "60002", fingerprint: "fp-b" }],
          newlyUnavailableCanvasItemIds: ["60001"],
        },
        5000,
      ),
    ).rejects.toThrow(LeaseFencedError);

    expect(await sourceItem(course.id, "60002")).toBeNull();
    const existing = await sourceItem(course.id, "60001");
    expect(existing?.fingerprint).toBe("fp-a");
    expect(existing?.available).toBe(1);
    const stored = await getCourseById(env.DB, course.id);
    expect(stored?.snapshotGeneration).toBe(1);
    expect(stored?.importLeaseToken).toBe(lease!.token);
  });

  it("commits normally when the connection is still active at the expected generation", async () => {
    const { account, course, connection } = await makeCourseAndConnection("fence-3", "9003");
    const lease = await acquireImportLease(env.DB, course.id, 2000);
    const newGeneration = await commitSnapshot(
      env.DB,
      {
        accountId: account.id,
        lease: lease!,
        connectionId: connection.id,
        expectedConnectionGeneration: connection.generation,
        upserts: [{ canvasItemId: "70001", fingerprint: "fp-a" }],
        newlyUnavailableCanvasItemIds: [],
      },
      3000,
    );
    expect(newGeneration).toBe(1);
    const item = await sourceItem(course.id, "70001");
    expect(item?.fingerprint).toBe("fp-a");
  });
});
