/** Parses the `Cookie` request header for one named value. Cookie values here are always opaque
 * base64/hex tokens with no reserved characters, so a plain split is enough — no quoted-string or
 * attribute-aware parsing is needed. Shared by the session cookie (`session.ts`) and the pre-auth
 * OAuth binding cookie (`routes.ts`). */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (header === null) return undefined;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}
