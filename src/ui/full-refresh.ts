import type { FullRefreshResult } from "./full-refresh-transport";

export interface FullRefreshFeedback {
  readonly state: "complete" | "partial" | "failed";
  readonly detail: string;
}

function sourceStatus(value: FullRefreshResult["browserStatus"] | FullRefreshResult["calendarStatus"]): string {
  return value === "complete" ? "complete" : value === "incomplete" ? "incomplete" : value === "unavailable" ? "unavailable" : "failed";
}

export function fullRefreshFeedback(result: FullRefreshResult): FullRefreshFeedback {
  const complete = result.status === "complete" && result.browserStatus === "complete" && result.calendarStatus === "complete" && result.gapCount === 0;
  const failed = result.browserStatus === "failed" && (result.calendarStatus === "failed" || result.calendarStatus === "unavailable");
  const state = complete ? "complete" : failed ? "failed" : "partial";
  const gap = result.gapCount === 0 ? "no coverage gaps" : `${String(result.gapCount)} coverage gap${result.gapCount === 1 ? "" : "s"}`;
  const detail = `Canvas ${sourceStatus(result.browserStatus)} (${gap}); calendar ${sourceStatus(result.calendarStatus)} (${String(result.calendarAdded)} added, ${String(result.calendarUpdated)} updated, ${String(result.calendarHeld)} held).`;
  return { state, detail: `${complete ? "Full refresh complete." : failed ? "Full refresh failed." : "Full refresh partial."} ${detail}` };
}
