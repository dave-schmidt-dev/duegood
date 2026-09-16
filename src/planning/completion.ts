import { getSourceItemAccountId, getTaskState, upsertTaskCompletion } from "../db/repository";
import type { TaskState } from "../db/types";

export type CompletionResult = { readonly status: "ok"; readonly taskState: TaskState | undefined } | { readonly status: "not_found" };

/** True on this account's own source item, and on no other row — a missing item and someone
 * else's item are deliberately indistinguishable to the caller, the same "ownership failure reads
 * as not-found" shape `getCourseById`'s callers already use. */
async function ownsSourceItem(db: D1Database, accountId: number, sourceItemId: string): Promise<boolean> {
  const owner = await getSourceItemAccountId(db, sourceItemId);
  return owner === accountId;
}

/** Reads one student's completion mark for one source item. `taskState` is `undefined` when the
 * item is owned but has never had its completion set — distinct from `status: "not_found"`, which
 * covers both a missing item and one this account doesn't own. */
export async function readCompletion(db: D1Database, accountId: number, sourceItemId: string): Promise<CompletionResult> {
  if (!(await ownsSourceItem(db, accountId, sourceItemId))) return { status: "not_found" };
  return { status: "ok", taskState: await getTaskState(db, sourceItemId) };
}

/**
 * Sets one student's completion mark for one source item. Distinct from Canvas's own submission
 * state (`source_items` carries only import-owned fields) and never written by the import path —
 * `commitSnapshot` has no reference to `task_state` at all, so a re-import can never overwrite
 * this value, by construction rather than by a runtime check.
 */
export async function writeCompletion(
  db: D1Database,
  accountId: number,
  sourceItemId: string,
  completed: boolean,
  now: number,
): Promise<CompletionResult> {
  if (!(await ownsSourceItem(db, accountId, sourceItemId))) return { status: "not_found" };
  return { status: "ok", taskState: await upsertTaskCompletion(db, accountId, sourceItemId, completed, now) };
}
