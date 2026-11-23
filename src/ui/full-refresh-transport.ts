const FULL_REFRESH_PHASES = ["browser-capture", "browser-import", "calendar", "complete", "sign-in-window"] as const;
const SIGN_IN_REASONS = [
  "CREDENTIALS_UNAVAILABLE", "SIGN_IN_BLOCKED", "VERIFICATION_REQUIRED", "SURVEY_POPUP_BLOCKING",
  "UNKNOWN_PAGE", "SIGN_IN_TIMEOUT", "SIGN_IN_REQUIRED",
] as const;
type FullRefreshPhase = (typeof FULL_REFRESH_PHASES)[number];

type SignInReason = (typeof SIGN_IN_REASONS)[number];
export interface FullRefreshProgress { readonly phase: FullRefreshPhase; readonly reason?: SignInReason }
export interface FullRefreshResult {
  readonly status: "complete" | "incomplete";
  readonly browserStatus: "complete" | "incomplete" | "failed";
  readonly calendarStatus: "complete" | "incomplete" | "failed" | "unavailable";
  readonly gapCount: number;
  readonly omissionCount: number;
  readonly bodyCount: number;
  readonly emptyBodyCount: number;
  readonly bodyFailureReason: "BODY_MISSING" | "BODY_SANITIZE_FAILED" | null;
  readonly rubricCount: number;
  readonly linkedFileCount: number;
  readonly exportStatus: "complete" | "disabled" | "failed";
  readonly exportWritten: number;
  readonly exportUnchanged: number;
  readonly exportSkippedOwnerFiles: number;
  readonly calendarAdded: number;
  readonly calendarUpdated: number;
  readonly calendarHeld: number;
  readonly updatedAt: string | null;
  readonly errorCode?: string | null;
}

export function parseFullRefreshProgress(value: unknown): FullRefreshProgress | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as { phase?: unknown; reason?: unknown };
  if (row.phase === "sign-in-window") {
    return typeof row.reason === "string" && (SIGN_IN_REASONS as readonly string[]).includes(row.reason)
      ? { phase: "sign-in-window", reason: row.reason as SignInReason }
      : null;
  }
  return row.reason === undefined && typeof row.phase === "string"
    && (FULL_REFRESH_PHASES as readonly string[]).includes(row.phase)
    ? { phase: row.phase as FullRefreshPhase } : null;
}

export function parseFullRefreshResult(value: unknown): FullRefreshResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = row.status;
  const browserStatus = row.browserStatus;
  const calendarStatus = row.calendarStatus;
  const allowedKeys = new Set([
    "status", "browserStatus", "calendarStatus", "gapCount", "omissionCount", "bodyCount", "emptyBodyCount", "rubricCount", "linkedFileCount",
    "bodyFailureReason", "exportStatus", "exportWritten", "exportUnchanged", "exportSkippedOwnerFiles",
    "calendarAdded", "calendarUpdated", "calendarHeld", "updatedAt", "errorCode",
  ]);
  const counts = [row.gapCount, row.omissionCount, row.bodyCount, row.emptyBodyCount, row.rubricCount, row.linkedFileCount,
    row.exportWritten, row.exportUnchanged, row.exportSkippedOwnerFiles,
    row.calendarAdded, row.calendarUpdated, row.calendarHeld];
  if ((status !== "complete" && status !== "incomplete") ||
      (browserStatus !== "complete" && browserStatus !== "incomplete" && browserStatus !== "failed") ||
      (calendarStatus !== "complete" && calendarStatus !== "incomplete" && calendarStatus !== "failed" && calendarStatus !== "unavailable") ||
      (row.exportStatus !== "complete" && row.exportStatus !== "disabled" && row.exportStatus !== "failed") ||
      (row.bodyFailureReason !== "none" && row.bodyFailureReason !== null
        && row.bodyFailureReason !== "BODY_MISSING" && row.bodyFailureReason !== "BODY_SANITIZE_FAILED") ||
      (status === "complete" && row.bodyFailureReason !== null && row.bodyFailureReason !== "none") ||
      Object.keys(row).some((key) => !allowedKeys.has(key)) ||
      !counts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) ||
      [row.omissionCount, row.bodyCount, row.emptyBodyCount, row.rubricCount, row.linkedFileCount,
        row.exportWritten, row.exportUnchanged, row.exportSkippedOwnerFiles].some((count) => (count as number) > 100_000) ||
      (row.emptyBodyCount as number) > (row.bodyCount as number) ||
      (row.updatedAt !== null && typeof row.updatedAt !== "string") ||
      (row.errorCode !== undefined && row.errorCode !== null && (typeof row.errorCode !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(row.errorCode)))) return null;
  return {
    status,
    browserStatus,
    calendarStatus,
    gapCount: row.gapCount as number,
    omissionCount: row.omissionCount as number,
    bodyCount: row.bodyCount as number,
    emptyBodyCount: row.emptyBodyCount as number,
    bodyFailureReason: row.bodyFailureReason === "none" ? null : row.bodyFailureReason as FullRefreshResult["bodyFailureReason"],
    rubricCount: row.rubricCount as number,
    linkedFileCount: row.linkedFileCount as number,
    exportStatus: row.exportStatus,
    exportWritten: row.exportWritten as number,
    exportUnchanged: row.exportUnchanged as number,
    exportSkippedOwnerFiles: row.exportSkippedOwnerFiles as number,
    calendarAdded: row.calendarAdded as number,
    calendarUpdated: row.calendarUpdated as number,
    calendarHeld: row.calendarHeld as number,
    updatedAt: row.updatedAt as string | null,
    ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode as string | null }),
  };
}
