import type { FullRefreshResult } from "./full-refresh-transport";

export interface FullRefreshFeedback {
  readonly state: "complete" | "partial" | "failed";
  readonly detail: string;
}

function sourceStatus(value: FullRefreshResult["browserStatus"] | FullRefreshResult["calendarStatus"]): string {
  return value === "complete" ? "complete" : value === "incomplete" ? "incomplete" : value === "unavailable" ? "unavailable" : "failed";
}

export function fullRefreshFeedback(result: FullRefreshResult, fileNotices: readonly string[] = []): FullRefreshFeedback {
  const calendarStatus = result.calendarHeld > 0 && result.calendarStatus === "complete" ? "incomplete" : sourceStatus(result.calendarStatus);
  const complete = result.status === "complete" && result.browserStatus === "complete" && calendarStatus === "complete" && result.gapCount === 0;
  const failed = result.browserStatus === "failed" && (result.calendarStatus === "failed" || result.calendarStatus === "unavailable");
  const state = complete ? "complete" : failed ? "failed" : "partial";
  const canvas = result.browserStatus === "failed"
    ? "Canvas could not refresh. Sign in if prompted, then try again."
    : result.gapCount > 0
      ? `${String(result.gapCount)} Canvas section${result.gapCount === 1 ? " or file could" : "s or files could"} not refresh.`
      : result.browserStatus === "incomplete" ? "Canvas could not finish refreshing." : "Canvas updated.";
  const calendar = calendarStatus === "failed" ? "Calendar could not refresh; previous deadlines were kept."
    : calendarStatus === "unavailable" ? "Calendar refresh is unavailable; previous deadlines were kept."
    : `Calendar: ${String(result.calendarAdded)} added, ${String(result.calendarUpdated)} updated.${result.calendarHeld > 0
      ? ` ${String(result.calendarHeld)} calendar item${result.calendarHeld === 1 ? " was" : "s were"} left unchanged because ${result.calendarHeld === 1 ? "it could" : "they could"} not be safely matched or dated.` : ""}`;
  const omissions = result.omissionCount > 0 ? ` ${String(result.omissionCount)} optional items were unavailable or skipped.` : "";
  const reasons = result.gapCount > 0 && fileNotices.length > 0 ? ` ${fileNotices.slice(0, 3).join(" ")}` : "";
  const headline = complete ? "Canvas and calendar updated." : failed ? "Refresh could not finish." : "Refresh finished with items needing attention.";
  const detail = `${headline} ${complete ? "" : `${canvas} `}${calendar}${reasons}${omissions}${state === "complete" ? "" : " See Activity for details."}`;
  return { state, detail };
}
