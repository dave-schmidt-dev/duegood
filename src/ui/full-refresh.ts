import type { FullRefreshResult } from "./full-refresh-transport";

export interface FullRefreshFeedback {
  readonly state: "complete" | "partial" | "failed";
  readonly detail: string;
}

function sourceStatus(value: FullRefreshResult["browserStatus"] | FullRefreshResult["calendarStatus"]): string {
  return value === "complete" ? "complete" : value === "incomplete" ? "incomplete" : value === "unavailable" ? "unavailable" : "failed";
}

export function fullRefreshFeedback(result: FullRefreshResult): FullRefreshFeedback {
  const calendarStatus = result.calendarHeld > 0 && result.calendarStatus === "complete" ? "incomplete" : sourceStatus(result.calendarStatus);
  const complete = result.status === "complete" && result.browserStatus === "complete" && calendarStatus === "complete" && result.gapCount === 0;
  const failed = result.browserStatus === "failed" && (result.calendarStatus === "failed" || result.calendarStatus === "unavailable");
  const state = complete ? "complete" : failed ? "failed" : "partial";
  const gap = result.gapCount === 0 ? "no required Canvas capture gaps" : `${String(result.gapCount)} required Canvas capture gap${result.gapCount === 1 ? "" : "s"}`;
  const omissions = result.omissionCount === 0 ? "no optional capture omissions"
    : `${String(result.omissionCount)} optional capture omission${result.omissionCount === 1 ? "" : "s"} recorded`;
  const held = `${String(result.calendarHeld)} calendar item${result.calendarHeld === 1 ? "" : "s"} held`;
  const detail = `Canvas ${sourceStatus(result.browserStatus)} (${gap}; ${omissions}); calendar ${calendarStatus} (${String(result.calendarAdded)} added, ${String(result.calendarUpdated)} updated, ${held}).`;
  const headline = complete ? "Current Canvas pages refreshed."
    : failed ? "Full refresh failed." : "Full refresh partial.";
  return { state, detail: `${headline} ${detail}` };
}
