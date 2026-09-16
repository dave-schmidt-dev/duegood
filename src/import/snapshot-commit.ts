import type { AcquiredLease } from "./lease";

interface SourceItemUpsert {
  readonly canvasItemId: string;
  readonly fingerprint: string;
}

export interface CommitCandidate {
  readonly accountId: number;
  readonly lease: AcquiredLease;
  readonly upserts: readonly SourceItemUpsert[];
  readonly newlyUnavailableCanvasItemIds: readonly string[];
}

export class LeaseFencedError extends Error {
  constructor() {
    super("import lease is stale or the course's snapshot generation has moved");
    this.name = "LeaseFencedError";
  }
}

/**
 * Commits one course's diff in a single D1 `batch()` call. D1 `batch()` runs every statement
 * sequentially within one transaction — later statements see earlier statements' effects already
 * applied — so every fence-checked write here is independently fenced against the exact course
 * row (`id`, `import_lease_token`, `snapshot_generation`) the caller's lease captured, via
 * `INSERT ... SELECT ... WHERE` / `UPDATE ... WHERE EXISTS`, and all of them run BEFORE the course
 * row itself is updated: the course update must run last, or it would clear the very
 * `import_lease_token` the earlier statements still need to check against. If the lease has been
 * reclaimed or the generation has moved since acquisition, every statement in the batch becomes a
 * no-op together, and this throws `LeaseFencedError` — no partial write, no stale commit, and no
 * staged row is ever visible before this single call returns.
 */
export async function commitSnapshot(db: D1Database, candidate: CommitCandidate, now: number): Promise<number> {
  const { lease } = candidate;
  const newGeneration = lease.expectedGeneration + 1;

  const upsertStatements = candidate.upserts.map((item) =>
    db
      .prepare(
        `INSERT INTO source_items (id, account_id, course_id, canvas_item_id, fingerprint, available, last_seen_generation, created_at, updated_at)
         SELECT ?1, ?2, id, ?3, ?4, 1, ?5, ?6, ?6
         FROM courses WHERE id = ?7 AND import_lease_token = ?8 AND snapshot_generation = ?9
         ON CONFLICT (course_id, canvas_item_id) DO UPDATE SET
           fingerprint = excluded.fingerprint, available = 1, last_seen_generation = excluded.last_seen_generation, updated_at = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(),
        candidate.accountId,
        item.canvasItemId,
        item.fingerprint,
        newGeneration,
        now,
        lease.courseId,
        lease.token,
        lease.expectedGeneration,
      ),
  );

  const unavailableStatements = candidate.newlyUnavailableCanvasItemIds.map((canvasItemId) =>
    db
      .prepare(
        `UPDATE source_items SET available = 0, updated_at = ?3
         WHERE course_id = ?1 AND canvas_item_id = ?2
           AND EXISTS (SELECT 1 FROM courses WHERE id = ?1 AND import_lease_token = ?4 AND snapshot_generation = ?5)`,
      )
      .bind(lease.courseId, canvasItemId, now, lease.token, lease.expectedGeneration),
  );

  const courseUpdate = db
    .prepare(
      `UPDATE courses
       SET snapshot_generation = ?2, import_lease_token = NULL, import_lease_expires_at = NULL, last_successful_check_at = ?3
       WHERE id = ?1 AND import_lease_token = ?4 AND snapshot_generation = ?5`,
    )
    .bind(lease.courseId, newGeneration, now, lease.token, lease.expectedGeneration);

  const results = await db.batch([...upsertStatements, ...unavailableStatements, courseUpdate]);
  const courseResult = results[results.length - 1];
  if ((courseResult?.meta.changes ?? 0) === 0) throw new LeaseFencedError();
  return newGeneration;
}
