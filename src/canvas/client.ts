import type { BudgetTracker } from "../import/limits";

export interface CanvasFetchConfig {
  readonly institutionOrigin: string;
  readonly accessToken: string;
}

const ALLOWED_PATH_PREFIXES = ["/api/v1/courses"];

/** Every outbound request and every followed pagination link must land on the institution's own
 * origin and an allowed API path — never anywhere a redirect or a forged Link header could point
 * a bearer-token-bearing request. */
function isAllowedDestination(url: URL, institutionOrigin: string): boolean {
  if (url.origin !== institutionOrigin) return false;
  return ALLOWED_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

/** Parses the `rel="next"` target out of an RFC 5988 `Link` header. Returns `undefined` on a
 * missing header, a header with no `next` relation, or a malformed URL — pagination simply stops
 * rather than guessing at a next page. */
function parseNextLink(linkHeader: string | null): string | undefined {
  if (linkHeader === null) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

export interface CanvasPageResult<T> {
  readonly items: readonly T[];
  /** Present only when the next-page link was itself validated as an allowlisted destination; an
   * unsafe or off-origin `next` link stops pagination rather than being followed. */
  readonly nextUrl?: string;
}

/**
 * Fetches one page from Canvas. Refuses to run at all against a non-allowlisted destination, and
 * refuses to follow any redirect automatically (`redirect: "manual"`) — a redirect target is never
 * validated before this call would otherwise resend the bearer token to it, so the safe behavior
 * is to stop and let the caller decide, never to silently continue. Spends exactly one unit of
 * `budget`'s Canvas-fetch allowance before making the request, so a caller that has run out never
 * reaches the network.
 */
export async function fetchCanvasPage<T>(
  url: string,
  config: CanvasFetchConfig,
  budget: BudgetTracker,
  fetchImpl: typeof fetch,
): Promise<CanvasPageResult<T>> {
  const target = new URL(url);
  if (!isAllowedDestination(target, config.institutionOrigin)) {
    throw new Error("canvas destination not allowlisted");
  }

  budget.spendCanvasFetch();
  const response = await fetchImpl(target.toString(), {
    headers: { Authorization: `Bearer ${config.accessToken}`, Accept: "application/json" },
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("canvas response redirected; refusing to follow with credentials attached");
  }
  if (!response.ok) throw new Error(`canvas request failed: ${String(response.status)}`);

  const items = (await response.json()) as T[];
  const nextUrl = parseNextLink(response.headers.get("Link"));
  const nextIsAllowed = nextUrl !== undefined && isAllowedDestination(new URL(nextUrl), config.institutionOrigin);
  return { items, nextUrl: nextIsAllowed ? nextUrl : undefined };
}
