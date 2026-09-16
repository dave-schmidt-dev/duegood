import { validateCsrfToken } from "./csrf";
import type { Session } from "./session";

export const CSRF_HEADER_NAME = "X-DueGood-CSRF-Token";

/** Every route this phase introduces that changes state, so a security test can enumerate this
 * list and assert each entry rejects a missing token and a cross-origin request, instead of the
 * test hand-listing routes (the exact drift Task 1.3's "Done when" bullet is guarding against).
 * Populated by `registerMutationRoute` as `src/auth/routes.ts` defines each handler — empty until
 * slice (e3) wires real routes in. */
export interface MutationRouteRegistry {
  register(method: string, path: string): void;
  requiresGuard(method: string, path: string): boolean;
  list(): ReadonlyArray<{ readonly method: string; readonly path: string }>;
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function createMutationRouteRegistry(): MutationRouteRegistry {
  const routes = new Set<string>();
  return {
    register(method, path) {
      routes.add(routeKey(method, path));
    },
    requiresGuard(method, path) {
      return routes.has(routeKey(method, path));
    },
    list() {
      return [...routes].map((entry) => {
        const separator = entry.indexOf(" ");
        return { method: entry.slice(0, separator), path: entry.slice(separator + 1) };
      });
    },
  };
}

/** Checks the request's `Origin` against `expectedOrigin`, falling back to `Referer` only when
 * `Origin` is absent (this app sends `Referrer-Policy: no-referrer`, so its own same-origin
 * requests carry no `Referer` — a check that *required* `Referer` would reject every legitimate
 * mutation). Fails closed (denies) when both headers are absent: a same-origin fetch/XHR always
 * sends `Origin` for non-GET requests, so an absent `Origin` on a state-changing request is itself
 * anomalous. */
function originAllowed(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === expectedOrigin;

  const referer = request.headers.get("Referer");
  if (referer === null) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

/** The single guard applied to every registered mutation route: same-origin (via `Origin`, or
 * `Referer` as fallback) and a valid per-session CSRF token, both required. Route wiring
 * (src/auth/routes.ts, slice e3) calls this once per request rather than each handler
 * reimplementing the check. */
export async function checkMutationRequest(request: Request, session: Session, expectedOrigin: string): Promise<boolean> {
  if (!originAllowed(request, expectedOrigin)) return false;
  const presentedToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined;
  return validateCsrfToken(session, presentedToken);
}
