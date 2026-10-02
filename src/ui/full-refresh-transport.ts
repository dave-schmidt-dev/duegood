const FULL_REFRESH_PHASES = ["browser-capture", "browser-import", "calendar", "complete"] as const;
type FullRefreshPhase = (typeof FULL_REFRESH_PHASES)[number];

export interface FullRefreshProgress { readonly phase: FullRefreshPhase }
export interface FullRefreshResult {
  readonly status: "complete" | "incomplete";
  readonly browserStatus: "complete" | "incomplete" | "failed";
  readonly calendarStatus: "complete" | "incomplete" | "failed" | "unavailable";
  readonly gapCount: number;
  readonly calendarAdded: number;
  readonly calendarUpdated: number;
  readonly calendarHeld: number;
  readonly updatedAt: string | null;
  readonly errorCode?: string | null;
}

export function parseFullRefreshProgress(value: unknown): FullRefreshProgress | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const phase = (value as { phase?: unknown }).phase;
  return typeof phase === "string" && (FULL_REFRESH_PHASES as readonly string[]).includes(phase) ? { phase: phase as FullRefreshPhase } : null;
}

export function parseFullRefreshResult(value: unknown): FullRefreshResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = row.status;
  const browserStatus = row.browserStatus;
  const calendarStatus = row.calendarStatus;
  const counts = [row.gapCount, row.calendarAdded, row.calendarUpdated, row.calendarHeld];
  if ((status !== "complete" && status !== "incomplete") ||
      (browserStatus !== "complete" && browserStatus !== "incomplete" && browserStatus !== "failed") ||
      (calendarStatus !== "complete" && calendarStatus !== "incomplete" && calendarStatus !== "failed" && calendarStatus !== "unavailable") ||
      !counts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) ||
      (row.updatedAt !== null && typeof row.updatedAt !== "string") ||
      (row.errorCode !== undefined && row.errorCode !== null && (typeof row.errorCode !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(row.errorCode)))) return null;
  return {
    status,
    browserStatus,
    calendarStatus,
    gapCount: row.gapCount as number,
    calendarAdded: row.calendarAdded as number,
    calendarUpdated: row.calendarUpdated as number,
    calendarHeld: row.calendarHeld as number,
    updatedAt: row.updatedAt as string | null,
    ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode as string | null }),
  };
}
