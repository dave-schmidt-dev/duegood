import type { FullRefreshResult } from "./full-refresh-transport";

export interface FullRefreshFeedback {
  readonly state: "complete" | "partial" | "failed";
  readonly detail: string;
}

function sourceStatus(value: FullRefreshResult["browserStatus"] | FullRefreshResult["calendarStatus"]): string {
  return value === "complete" ? "complete" : value === "incomplete" ? "incomplete" : value === "unavailable" ? "unavailable" : "failed";
}

const CANVAS_FAILURE_DETAILS: Readonly<Record<string, string>> = {
  "helper-stale": "Canvas capture helpers are out of date. Run npm run canvas:prepare-helper, then try again.",
  "canvas-credentials-unavailable": "Saved Canvas sign-in details are unavailable. Use the visible Canvas setup session, then retry refresh.",
  "canvas-sign-in-blocked": "Canvas rejected the saved sign-in details. Use the visible Canvas setup session, then retry refresh.",
  "canvas-verification-required": "Canvas requires an extra verification step. Complete it in the visible Canvas setup session, then retry refresh.",
  "canvas-survey-blocking": "A Canvas survey is blocking refresh. Dismiss it in the visible Canvas session, then retry refresh.",
  "canvas-sign-in-page-unknown": "Due Good could not recognize the Canvas sign-in page. Complete sign-in in the visible Canvas setup session, then retry refresh.",
  "canvas-sign-in-timeout": "Canvas sign-in did not finish automatically. Complete it in the visible Canvas setup session, then retry refresh.",
  "canvas-sign-in-required": "Canvas needs you to sign in. Use the visible Canvas setup session, then retry refresh.",
  "headless-session-required": "A visible Canvas setup session is open. Finish sign-in and account binding, then close that session and retry refresh.",
};

export function fullRefreshFeedback(result: FullRefreshResult, fileNotices: readonly string[] = []): FullRefreshFeedback {
  const calendarStatus = result.calendarHeld > 0 && result.calendarStatus === "complete" ? "incomplete" : sourceStatus(result.calendarStatus);
  const complete = result.status === "complete" && result.browserStatus === "complete" && calendarStatus === "complete" && result.gapCount === 0;
  const failed = result.browserStatus === "failed" && (result.calendarStatus === "failed" || result.calendarStatus === "unavailable");
  const state = complete ? "complete" : failed ? "failed" : "partial";
  const canvas = result.browserStatus === "failed"
    ? CANVAS_FAILURE_DETAILS[result.errorCode ?? ""] ?? "Canvas could not refresh. Check the Canvas setup and try again."
    : result.gapCount > 0
      ? `${String(result.gapCount)} Canvas section${result.gapCount === 1 ? " or file could" : "s or files could"} not refresh.`
      : result.browserStatus === "incomplete" ? "Canvas could not finish refreshing." : "Canvas updated.";
  const calendar = calendarStatus === "failed" ? "Calendar could not refresh; previous deadlines were kept."
    : calendarStatus === "unavailable" ? "Calendar refresh is unavailable; previous deadlines were kept."
    : `Calendar: ${String(result.calendarAdded)} added, ${String(result.calendarUpdated)} updated.${result.calendarHeld > 0
      ? ` ${String(result.calendarHeld)} calendar item${result.calendarHeld === 1 ? " was" : "s were"} left unchanged because ${result.calendarHeld === 1 ? "it could" : "they could"} not be safely matched or dated.` : ""}`;
  const omissions = ` ${String(result.omissionCount)} omission${result.omissionCount === 1 ? "" : "s"} recorded.`;
  const captureCounts = result.browserStatus === "failed" ? "" : ` Bodies kept for ${String(result.bodyCount)} items (${String(result.emptyBodyCount)} empty). Rubrics on ${String(result.rubricCount)} assignments. Metadata retrieved for ${String(result.linkedFileCount)} additional linked files.`;
  const bodyIssue = result.bodyFailureReason === "BODY_MISSING" ? " Some Canvas item bodies were missing from the response."
    : result.bodyFailureReason === "BODY_SANITIZE_FAILED" ? " Some Canvas item bodies could not be sanitized." : "";
  const exportSummary = result.exportStatus === "complete"
    ? ` Course exports: ${String(result.exportWritten)} written, ${String(result.exportUnchanged)} unchanged, ${String(result.exportSkippedOwnerFiles)} owner files skipped.`
    : result.exportStatus === "failed" ? " Course exports failed." : " Course exports disabled.";
  const reasons = result.gapCount > 0 && fileNotices.length > 0 ? ` ${fileNotices.slice(0, 3).join(" ")}` : "";
  const headline = complete ? "Complete. Canvas and calendar updated." : failed ? "Refresh could not finish." : "Refresh finished with items needing attention.";
  const detail = `${headline} ${complete ? "" : `${canvas} `}${calendar}${reasons}${bodyIssue}${omissions}${captureCounts}${exportSummary}${state === "complete" ? "" : " See Activity for details."}`;
  return { state, detail };
}
