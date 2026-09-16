import { sha256Hex } from "../crypto";
import type { Session } from "./session";

/** Compares a caller-presented CSRF token against the session's stored hash. `undefined` (header
 * absent) is always rejected without hashing — this is not a secret comparison, just a cheap
 * short-circuit for the common "no token sent" case. */
export async function validateCsrfToken(session: Session, presentedToken: string | undefined): Promise<boolean> {
  if (presentedToken === undefined) return false;
  const presentedHash = await sha256Hex(presentedToken);
  return presentedHash === session.csrfTokenHash;
}
