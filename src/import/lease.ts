export interface AcquiredLease {
  readonly courseId: string;
  readonly token: string;
  readonly expiresAt: number;
  /** The course's snapshot generation captured at acquisition time — the fence a commit must
   * present unchanged (see snapshot-commit.ts), so a commit computed against stale data can never
   * apply even if the lease token still matches. */
  readonly expectedGeneration: number;
}

const LEASE_DURATION_MS = 60_000;

interface CourseFenceRow {
  readonly import_lease_token: string;
  readonly snapshot_generation: number;
}

/**
 * Acquires the single import lease for one course, atomically: succeeds only if no lease is
 * currently held, or the previously-held lease has expired. A live lease already held by someone
 * else returns `undefined` — the caller must not fetch from Canvas or write to D1. Lease
 * expiration alone never lets an old worker overwrite a newer commit: `commitSnapshot` fences on
 * the exact token this call returns, not merely on "a lease is present."
 */
export async function acquireImportLease(db: D1Database, courseId: string, now: number): Promise<AcquiredLease | undefined> {
  const token = crypto.randomUUID();
  const expiresAt = now + LEASE_DURATION_MS;
  const row = await db
    .prepare(
      `UPDATE courses
       SET import_lease_token = ?2, import_lease_expires_at = ?3
       WHERE id = ?1 AND (import_lease_token IS NULL OR import_lease_expires_at < ?4)
       RETURNING import_lease_token, snapshot_generation`,
    )
    .bind(courseId, token, expiresAt, now)
    .first<CourseFenceRow>();
  if (!row) return undefined;
  return { courseId, token, expiresAt, expectedGeneration: row.snapshot_generation };
}

/**
 * Releases a lease early after a failed or aborted import, only if the caller still holds it — a
 * lease already reclaimed by a later requester after expiry must never be clobbered by an earlier
 * one finally giving up. A successful import releases its lease as part of the commit batch
 * instead (see snapshot-commit.ts), not here.
 */
export async function releaseImportLease(db: D1Database, courseId: string, token: string): Promise<void> {
  await db
    .prepare(`UPDATE courses SET import_lease_token = NULL, import_lease_expires_at = NULL WHERE id = ?1 AND import_lease_token = ?2`)
    .bind(courseId, token)
    .run();
}
