/** A bounded daily-page outcome carried alongside archive-preservation history. */
interface DailyScopeReadiness {
  readonly omissionCount: number;
  readonly gapCount: number;
  readonly complete: boolean;
}

type CanvasRefreshStatus = "complete" | "partial" | "failed";

export interface CanvasHistoryOutcome {
  readonly status: CanvasRefreshStatus;
  readonly dailyScope: DailyScopeReadiness | null;
  readonly summaryText: string | null;
  readonly notice: { readonly title: string; readonly detail: string } | null;
}

const MAX_DAILY_SCOPE_COUNT = 100_000;

/** Reads bounded Canvas scope counts without treating daily scope as full-capture proof. */
function dailyScopeReadiness(event: Record<string, unknown>): DailyScopeReadiness | null {
  if (
    event.source !== "canvas" ||
    event.sourceLabel !== "canvas" ||
    (event.dailyScopeStatus !== "complete" && event.dailyScopeStatus !== "incomplete")
  ) {
    return null;
  }
  const gapCount = event.dailyGapCount;
  if (
    typeof gapCount !== "number" ||
    !Number.isSafeInteger(gapCount) ||
    gapCount < 0 ||
    gapCount > MAX_DAILY_SCOPE_COUNT
  ) return null;
  const omissionCount = event.dailyOmissionCount;
  if (
    typeof omissionCount !== "number" ||
    !Number.isSafeInteger(omissionCount) ||
    omissionCount < 0 ||
    omissionCount > MAX_DAILY_SCOPE_COUNT
  ) {
    return null;
  }
  return {
    omissionCount,
    gapCount,
    complete: event.dailyScopeStatus === "complete" && gapCount === 0,
  };
}

/** Projects the full-capture result and bounded omission text for one history event. */
export function canvasHistoryOutcome(
  event: Record<string, unknown>,
  isCalendar: boolean,
): CanvasHistoryOutcome {
  const dailyScope = isCalendar ? null : dailyScopeReadiness(event);
  const explicitFailure = event.status === "failed";
  const complete = !explicitFailure && (isCalendar
    ? event.status === "succeeded" && event.dailyScopeStatus !== "incomplete"
    : event.status === "succeeded" && event.sourceComplete === true
      && event.dailyScopeStatus !== "incomplete"
      && (event.dailyScopeStatus !== "complete" || dailyScope?.complete === true));
  const missingScopeProof = event.source === "canvas" && event.sourceLabel === "canvas"
    && event.dailyScopeStatus !== undefined && dailyScope === null;
  const status: CanvasRefreshStatus = explicitFailure
    ? "failed"
    : complete
      ? "complete"
      : event.status === "incomplete" || event.sourceComplete === false
          || dailyScope?.complete === false || missingScopeProof
        ? "partial"
        : "failed";
  if (dailyScope === null) return { status, dailyScope, summaryText: null, notice: null };

  const omissionText = dailyScope.omissionCount > 0
    ? `${String(dailyScope.omissionCount)} optional capture omission${dailyScope.omissionCount === 1 ? "" : "s"} recorded`
    : null;
  const omissionSuffix = omissionText === null ? "" : `; ${omissionText}`;
  const summaryText = status === "complete"
    ? `Canvas refresh completed${omissionSuffix}. Existing data was preserved.`
    : status === "failed"
      ? `Canvas refresh failed${omissionSuffix}; existing data was kept.`
      : `Canvas refresh was incomplete${omissionSuffix}; existing data was kept.`;
  const title = status === "complete" ? "Canvas refresh completed"
    : status === "failed" ? "Canvas refresh failed" : "Canvas refresh was incomplete";
  const omissionDetail = omissionText === null ? "" : `${omissionText}. `;
  const detail = `${omissionDetail}${status === "complete" ? "Existing data was preserved." : "Existing data was kept."}`;

  return { status, dailyScope, summaryText, notice: { title, detail } };
}
