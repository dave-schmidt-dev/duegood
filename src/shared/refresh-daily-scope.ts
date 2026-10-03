/** A bounded daily-page outcome carried alongside archive-preservation history. */
export interface DailyScopeReadiness {
  readonly omissionCount: number;
}

const MAX_DAILY_SCOPE_COUNT = 100_000;

/** Accepts only the native importer’s explicit, bounded proof of daily-scope completion. */
export function dailyScopeReadiness(event: unknown): DailyScopeReadiness | null {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const record = event as Record<string, unknown>;
  if (
    record.source !== "canvas" ||
    record.sourceLabel !== "canvas" ||
    record.status !== "incomplete" ||
    record.sourceComplete !== false ||
    record.dailyScopeStatus !== "complete" ||
    record.dailyGapCount !== 0
  ) {
    return null;
  }
  const omissionCount = record.dailyOmissionCount;
  if (
    typeof omissionCount !== "number" ||
    !Number.isSafeInteger(omissionCount) ||
    omissionCount < 0 ||
    omissionCount > MAX_DAILY_SCOPE_COUNT
  ) {
    return null;
  }
  return { omissionCount };
}
