import type { FullRefreshResult } from "./full-refresh-transport";

export interface FullRefreshFeedback {
  readonly state: "complete" | "partial" | "failed";
  readonly outcome: string;
  readonly action: string;
  readonly detail: string;
  readonly setupInstructionsAvailable: boolean;
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

const CANVAS_SETUP_ERROR_CODES = new Set([
  "canvas-credentials-unavailable", "canvas-sign-in-blocked", "canvas-verification-required", "canvas-survey-blocking",
  "canvas-sign-in-page-unknown", "canvas-sign-in-timeout", "canvas-sign-in-required", "headless-session-required",
]);

const CANVAS_SETUP_OUTCOMES: Readonly<Record<string, string>> = {
  "canvas-credentials-unavailable": "Saved Canvas sign-in unavailable",
  "canvas-sign-in-blocked": "Canvas rejected the saved sign-in",
  "canvas-verification-required": "Canvas needs an extra verification step",
  "canvas-survey-blocking": "A Canvas survey is blocking refresh",
  "canvas-sign-in-page-unknown": "Canvas sign-in page is unrecognized",
  "canvas-sign-in-timeout": "Canvas sign-in timed out",
  "canvas-sign-in-required": "Canvas sign-in is required",
  "headless-session-required": "A visible Canvas setup session is open",
};

function canvasFailure(errorCode: string | null | undefined): string | undefined {
  return errorCode !== null && errorCode !== undefined && Object.hasOwn(CANVAS_FAILURE_DETAILS, errorCode)
    ? CANVAS_FAILURE_DETAILS[errorCode]
    : undefined;
}

export function fullRefreshFeedback(result: FullRefreshResult, fileNotices: readonly string[] = []): FullRefreshFeedback {
  const calendarStatus = result.calendarHeld > 0 && result.calendarStatus === "complete" ? "incomplete" : sourceStatus(result.calendarStatus);
  const complete = result.status === "complete" && result.browserStatus === "complete" && calendarStatus === "complete" && result.gapCount === 0 && result.exportStatus !== "failed";
  const failed = result.browserStatus === "failed" && (result.calendarStatus === "failed" || result.calendarStatus === "unavailable");
  const state = complete ? "complete" : failed ? "failed" : "partial";
  const canvasDetail = result.browserStatus === "failed"
    ? canvasFailure(result.errorCode) ?? "Canvas could not refresh."
    : result.gapCount > 0
      ? `${String(result.gapCount)} Canvas section${result.gapCount === 1 ? " or file could" : "s or files could"} not refresh.`
      : result.browserStatus === "incomplete" ? "Canvas could not finish refreshing." : "Canvas updated.";
  const calendarDetail = calendarStatus === "failed" ? "Calendar could not refresh; previous deadlines were kept."
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
  const setupInstructionsAvailable = result.errorCode !== null && result.errorCode !== undefined && CANVAS_SETUP_ERROR_CODES.has(result.errorCode);
  const setupAction = result.errorCode === "headless-session-required"
    ? "Close the visible setup session, then retry refresh."
    : "Open Canvas setup instructions and retry refresh after setup.";
  const setupOutcome = result.errorCode !== null && result.errorCode !== undefined && Object.hasOwn(CANVAS_SETUP_OUTCOMES, result.errorCode)
    ? CANVAS_SETUP_OUTCOMES[result.errorCode]
    : undefined;
  const calendarOutcome = calendarStatus === "complete" ? "calendar updated" : calendarStatus === "incomplete" ? "calendar needs attention" : "calendar refresh failed";
  const outcome = setupOutcome !== undefined ? `${setupOutcome}; ${calendarOutcome}.`
    : complete ? "Canvas and calendar updated."
    : failed ? "Canvas and calendar refresh failed."
    : result.browserStatus === "failed" && calendarStatus === "complete" ? "Canvas failed; calendar deadlines updated."
    : result.browserStatus === "complete" && (calendarStatus === "failed" || calendarStatus === "unavailable") ? "Canvas updated; calendar refresh needs attention."
    : result.browserStatus === "failed" ? "Canvas refresh failed; calendar status needs attention."
    : result.browserStatus === "incomplete" || result.gapCount > 0 ? "Canvas refresh was incomplete."
    : "Refresh finished with items needing attention.";
  const action = setupInstructionsAvailable ? setupAction
    : result.errorCode === "helper-stale" ? "Update the Canvas capture helpers, then retry refresh."
    : result.browserStatus === "failed" ? "Check Activity for details, then retry refresh."
    : calendarStatus === "failed" || calendarStatus === "unavailable" ? "Check the calendar feed and retry refresh."
    : complete ? "Review Activity for changes."
    : "Review Activity for details, then retry refresh.";
  const headline = complete ? "Complete. Canvas and calendar updated." : failed ? "Refresh could not finish." : "Refresh finished with items needing attention.";
  const detail = `${headline} ${complete ? "" : `${canvasDetail} `}${calendarDetail}${reasons}${bodyIssue}${omissions}${captureCounts}${exportSummary}${state === "complete" ? "" : " See Activity for details."}`;
  return { state, outcome, action, detail, setupInstructionsAvailable };
}
