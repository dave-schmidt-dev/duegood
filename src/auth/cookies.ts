/** Parses a `Cookie`-header-shaped string for one named value. Cookie values here are always
 * opaque base64/hex tokens with no reserved characters, so a plain split is enough — no
 * quoted-string or attribute-aware parsing is needed. Takes the raw header text rather than a
 * `Request` so `src/ui/csrf.ts` can reuse it against `document.cookie` in the browser, where
 * there is no `Request` object at all. */
export function parseCookieHeader(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** Parses the `Cookie` request header for one named value. Shared by the session cookie
 * (`session.ts`) and the pre-auth OAuth binding cookie (`routes.ts`). */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (header === null) return undefined;
  return parseCookieHeader(header, name);
}

/** Exported for `src/ui/csrf.ts`, which reads this name out of `document.cookie` via
 * `parseCookieHeader` — see that module's own doc comment for why the cookie itself is not
 * `HttpOnly`. */
export const CSRF_COOKIE_NAME = "__Host-duegood_csrf";
export const CSRF_HEADER_NAME = "X-DueGood-CSRF-Token";

/** Deliberately NOT `HttpOnly`: page JS (`src/ui/csrf.ts`) reads this cookie via `document.cookie`
 * and echoes its value in the `CSRF_HEADER_NAME` header on mutating fetches — that is the whole
 * point of this cookie, so do not "fix" this to `HttpOnly`. `SameSite=Lax`, matching the session
 * cookie, not `Strict`: both are set together on `handleCallback`'s cross-site top-level redirect
 * from the institution, and any later cross-site landing navigation into the app must still carry
 * this cookie so page JS has a token to read — `Strict` would silently drop it there while the
 * `Lax` session cookie survived, breaking every mutation with no visible cause. `checkMutationRequest`
 * already blocks cross-origin *use* of a leaked token via its `Origin`/`Referer` check, so `Lax`
 * costs nothing here. */
export function buildCsrfCookie(token: string): string {
  return `${CSRF_COOKIE_NAME}=${token}; Secure; Path=/; SameSite=Lax`;
}

/** The `Set-Cookie` value that clears the CSRF cookie on logout. */
export function buildCsrfClearCookie(): string {
  return `${CSRF_COOKIE_NAME}=; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}
