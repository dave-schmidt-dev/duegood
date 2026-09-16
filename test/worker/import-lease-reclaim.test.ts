import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findOrCreateAccount, findOrCreateCourse, getCourseById } from "../../src/db/repository";
import { acquireImportLease, releaseImportLease } from "../../src/import/lease";

async function makeCourse(canvasUserId: string, canvasCourseId: string) {
  const account = await findOrCreateAccount(env.DB, "https://marymount.instructure.com", canvasUserId, 1000);
  return findOrCreateCourse(env.DB, {
    id: crypto.randomUUID(),
    accountId: account.id,
    canvasCourseId,
    courseCode: "TECH 101",
    title: "Introduction to Computing",
    term: "Fall 2026",
    now: 1000,
  });
}

describe("acquireImportLease", () => {
  it("acquires a lease for a course with no lease held, capturing its current generation", async () => {
    const course = await makeCourse("lease-1", "9001");
    const lease = await acquireImportLease(env.DB, course.id, 2000);

    expect(lease).toBeDefined();
    expect(lease?.expectedGeneration).toBe(0);
    expect(lease?.expiresAt).toBeGreaterThan(2000);
  });

  it("refuses a second acquisition while a live lease is held", async () => {
    const course = await makeCourse("lease-2", "9001");
    await acquireImportLease(env.DB, course.id, 2000);

    expect(await acquireImportLease(env.DB, course.id, 2500)).toBeUndefined();
  });

  it("allows the next requester to reclaim the lease only after it has expired", async () => {
    const course = await makeCourse("lease-3", "9001");
    const first = await acquireImportLease(env.DB, course.id, 2000);
    expect(first).toBeDefined();

    // Still live: reclaim refused one millisecond before expiry.
    expect(await acquireImportLease(env.DB, course.id, first!.expiresAt - 1)).toBeUndefined();

    // Expired: the next requester may reclaim it, receiving a fresh token.
    const reclaimed = await acquireImportLease(env.DB, course.id, first!.expiresAt + 1);
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.token).not.toBe(first?.token);
  });

  it("returns undefined for an unknown course id", async () => {
    expect(await acquireImportLease(env.DB, crypto.randomUUID(), 1000)).toBeUndefined();
  });
});

describe("releaseImportLease", () => {
  it("clears the lease when released by its holder, allowing immediate re-acquisition", async () => {
    const course = await makeCourse("lease-4", "9001");
    const lease = await acquireImportLease(env.DB, course.id, 2000);
    await releaseImportLease(env.DB, course.id, lease!.token);

    const reacquired = await acquireImportLease(env.DB, course.id, 2001);
    expect(reacquired).toBeDefined();

    const stored = await getCourseById(env.DB, course.id);
    expect(stored?.importLeaseToken).toBe(reacquired?.token);
  });

  it("does not clear a lease already reclaimed by someone else after expiry", async () => {
    const course = await makeCourse("lease-5", "9001");
    const first = await acquireImportLease(env.DB, course.id, 2000);
    const reclaimed = await acquireImportLease(env.DB, course.id, first!.expiresAt + 1);

    // The original holder, unaware it expired, tries to release its now-stale token.
    await releaseImportLease(env.DB, course.id, first!.token);

    const stored = await getCourseById(env.DB, course.id);
    expect(stored?.importLeaseToken).toBe(reclaimed?.token);
  });
});
