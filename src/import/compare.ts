export interface CommittedItem {
  readonly canvasItemId: string;
  readonly fingerprint: string;
  readonly available: boolean;
}

export interface FetchedItem {
  readonly canvasItemId: string;
  readonly fingerprint: string;
}

export interface CompareResult {
  readonly upserts: readonly FetchedItem[];
  readonly newlyUnavailableCanvasItemIds: readonly string[];
  /** True when the fetched inventory looks like a partial/suspect read rather than a real
   * shrinking course: the caller must not commit anything this cycle (not even the upserts) and
   * should report the resource as not refreshed, preserving every prior row untouched for a later
   * recheck. */
  readonly anomalous: boolean;
}

/** A previously-available inventory dropping by more than this fraction — or vanishing to zero
 * entirely — is treated as a suspected partial failure, never as real bulk deletion. Real Canvas
 * courses don't retroactively lose most of their assignments; a paginated fetch that silently
 * truncated, or an institution-side filtering glitch, looks exactly like this instead. This
 * threshold is a phase-1 judgment call, not derived from docs/02-SYNC-AND-BUDGET.md — see
 * HISTORY.md for the reasoning and its known residual limitation (a course whose available count
 * legitimately drops past this ratio in one cycle stays flagged `anomalous` on every subsequent
 * complete recheck, since the committed set never changes while blocked; acceptable for phase-1
 * pilot-scale courses, not a general solution). */
const ANOMALOUS_DROP_RATIO = 0.5;

/** Below this many previously-available items, the drop ratio is too noisy to trust — one item
 * disappearing from a 3-item course is a 33%+ "drop" that would otherwise misfire the guard
 * permanently on ordinary small-course activity. Small committed sets trust the diff outright and
 * rely on the caller's own fetch-completeness check (whether every page was genuinely consumed)
 * as the real defense against truncation. */
const ANOMALOUS_RATIO_FLOOR = 4;

/**
 * Compares the committed (previously-visible) inventory against a freshly fetched and normalized
 * one for the same course, computing the exact added/updated/unavailable changes — never a bulk
 * "replace everything" — per docs/02-SYNC-AND-BUDGET.md step 6. An item present in both with an
 * unchanged fingerprint is left alone entirely (not included in `upserts`), so an unrelated sync
 * never touches rows nothing changed about.
 */
export function compareInventory(committed: readonly CommittedItem[], fetched: readonly FetchedItem[]): CompareResult {
  const committedAvailable = committed.filter((item) => item.available);
  const committedByCanvasId = new Map(committed.map((item) => [item.canvasItemId, item]));
  const fetchedIds = new Set(fetched.map((item) => item.canvasItemId));

  if (committedAvailable.length > 0) {
    const missingCount = committedAvailable.filter((item) => !fetchedIds.has(item.canvasItemId)).length;
    const missingRatio = missingCount / committedAvailable.length;
    const ratioApplies = committedAvailable.length >= ANOMALOUS_RATIO_FLOOR;
    if (fetched.length === 0 || (ratioApplies && missingRatio > ANOMALOUS_DROP_RATIO)) {
      return { upserts: [], newlyUnavailableCanvasItemIds: [], anomalous: true };
    }
  }

  const upserts = fetched.filter((item) => {
    const existing = committedByCanvasId.get(item.canvasItemId);
    return existing === undefined || !existing.available || existing.fingerprint !== item.fingerprint;
  });
  const newlyUnavailableCanvasItemIds = committedAvailable
    .filter((item) => !fetchedIds.has(item.canvasItemId))
    .map((item) => item.canvasItemId);

  return { upserts, newlyUnavailableCanvasItemIds, anomalous: false };
}
