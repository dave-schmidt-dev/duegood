import type { SubmissionState } from "../canvas/submission";
import type { AcquiredLease } from "./lease";
import type { FieldState } from "./normalize";

interface SourceItemUpsert {
  readonly canvasItemId: string;
  readonly fingerprint: string;
  readonly title: string | null;
  readonly dueAt: string | null;
  readonly dueAtState: FieldState;
  readonly submissionState: SubmissionState;
}

export interface CommitCandidate {
  readonly accountId: number;
  readonly lease: AcquiredLease;
  /** The account's Canvas connection this import ran under, and its generation captured at the
   * same time the lease was acquired — required, not optional, because `commitSnapshot` has
   * exactly one caller and an optional fence is a fence someone eventually forgets to pass. */
  readonly connectionId: string;
  readonly expectedConnectionGeneration: number;
  readonly upserts: readonly SourceItemUpsert[];
  readonly newlyUnavailableCanvasItemIds: readonly string[];
}

export class LeaseFencedError extends Error {
  constructor() {
    super(
      "import commit was fenced: the import lease is stale, the course's snapshot generation has moved, " +
        "or the account's Canvas connection is no longer active at the expected generation",
    );
    this.name = "LeaseFencedError";
  }
}

/**
 * Commits one course's diff in a single D1 `batch()` call. D1 `batch()` runs every statement
 * sequentially within one transaction — later statements see earlier statements' effects already
 * applied, and a statement matching zero rows does not roll back the batch — so every write here
 * independently re-checks the FULL fence (lease token + snapshot generation + connection status/
 * generation) via `INSERT ... SELECT ... WHERE` / `UPDATE ... WHERE EXISTS`, rather than relying on
 * one statement's row count to imply the others were equally guarded. Checking the connection
 * fence only on the final course-row update would let the earlier `source_items` writes commit for
 * real even when the connection was revoked mid-import — worse than reporting `LeaseFencedError`,
 * since the failure signal would be silently wrong. All fence-checked writes run BEFORE the course
 * row itself is updated: the course update must run last, since it's the one statement allowed to
 * clear the `import_lease_token` the earlier statements still need to check against. If any part of
 * the fence has moved since acquisition, every statement in the batch becomes a no-op together, and
 * this throws `LeaseFencedError` — no partial write, no stale commit, and no staged row is ever
 * visible before this single call returns.
 */
export async function commitSnapshot(db: D1Database, candidate: CommitCandidate, now: number): Promise<number> {
  const { lease } = candidate;
  const newGeneration = lease.expectedGeneration + 1;
  // Each statement binds a different number of positional params before the fence, so the
  // connection-fence placeholder indices below are re-numbered per statement, not shared.
  const connectionFenceSql = (idIndex: number, generationIndex: number) =>
    `EXISTS (SELECT 1 FROM connections WHERE id = ?${idIndex} AND status = 'active' AND generation = ?${generationIndex})`;

  const upsertStatements = candidate.upserts.map((item) =>
    db
      .prepare(
        `INSERT INTO source_items (id, account_id, course_id, canvas_item_id, fingerprint, available, last_seen_generation, created_at, updated_at, title, due_at, due_at_state, submission_state)
         SELECT ?1, ?2, id, ?3, ?4, 1, ?5, ?6, ?6, ?10, ?11, ?12, ?13
         FROM courses WHERE id = ?7 AND import_lease_token = ?8 AND snapshot_generation = ?9 AND ${connectionFenceSql(14, 15)}
         ON CONFLICT (course_id, canvas_item_id) DO UPDATE SET
           fingerprint = excluded.fingerprint, available = 1, last_seen_generation = excluded.last_seen_generation, updated_at = excluded.updated_at,
           title = excluded.title, due_at = excluded.due_at, due_at_state = excluded.due_at_state, submission_state = excluded.submission_state`,
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
        item.title,
        item.dueAt,
        item.dueAtState,
        item.submissionState,
        candidate.connectionId,
        candidate.expectedConnectionGeneration,
      ),
  );

  const unavailableStatements = candidate.newlyUnavailableCanvasItemIds.map((canvasItemId) =>
    db
      .prepare(
        `UPDATE source_items SET available = 0, updated_at = ?3
         WHERE course_id = ?1 AND canvas_item_id = ?2
           AND EXISTS (SELECT 1 FROM courses WHERE id = ?1 AND import_lease_token = ?4 AND snapshot_generation = ?5)
           AND ${connectionFenceSql(6, 7)}`,
      )
      .bind(lease.courseId, canvasItemId, now, lease.token, lease.expectedGeneration, candidate.connectionId, candidate.expectedConnectionGeneration),
  );

  const courseUpdate = db
    .prepare(
      `UPDATE courses
       SET snapshot_generation = ?2, import_lease_token = NULL, import_lease_expires_at = NULL, last_successful_check_at = ?3
       WHERE id = ?1 AND import_lease_token = ?4 AND snapshot_generation = ?5 AND ${connectionFenceSql(6, 7)}`,
    )
    .bind(lease.courseId, newGeneration, now, lease.token, lease.expectedGeneration, candidate.connectionId, candidate.expectedConnectionGeneration);

  const results = await db.batch([...upsertStatements, ...unavailableStatements, courseUpdate]);
  const courseResult = results[results.length - 1];
  if ((courseResult?.meta.changes ?? 0) === 0) throw new LeaseFencedError();
  return newGeneration;
}
