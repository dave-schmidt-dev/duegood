import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, LOCAL_CSRF_COOKIE_NAME, parseCookieHeader } from "../auth/cookies";

export { CSRF_HEADER_NAME };

/** Reads the CSRF token straight out of `document.cookie` — the cookie is deliberately not
 * `HttpOnly` for exactly this read (see `src/auth/cookies.ts`). Returns `undefined` when absent
 * (no session, or auth disabled), which callers treat as "cannot mutate", never as "send an
 * empty header" — `checkMutationRequest` rejects a missing header the same as a wrong one, so
 * there is no behavioral difference, only a clearer call site. */
export function readCsrfToken(): string | undefined {
  const cookie = document.cookie;
  return parseCookieHeader(cookie, CSRF_COOKIE_NAME) ?? parseCookieHeader(cookie, LOCAL_CSRF_COOKIE_NAME);
}

/** Reads only the loopback server's token after a local renewal handshake. This avoids a stale
 * cloud cookie shadowing the newly-issued local value when both names exist in one browser. */
export function readLocalCsrfToken(): string | undefined {
  return parseCookieHeader(document.cookie, LOCAL_CSRF_COOKIE_NAME);
}
