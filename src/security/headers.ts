const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The restrictive header set applied to auth/API responses: a locked-down CSP, no caching of
 * anything that might carry session-scoped data, no referrer leakage, and the two legacy
 * anti-framing/anti-sniffing headers browsers still check alongside CSP. */
export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
  };
}

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders())) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
