import { base64Encode, sha256Hex } from "../crypto";

const SESSION_COOKIE_NAME = "__Host-duegood_session";

/** Caps a session's total lifetime regardless of activity. */
export const ABSOLUTE_SESSION_LIFETIME_SECONDS = 12 * 60 * 60;
/** Ends a session after this much inactivity, refreshed by `touchSessionActivity`. */
export const IDLE_SESSION_LIFETIME_SECONDS = 30 * 60;
const TOKEN_BYTES = 32;

export interface Session {
  readonly id: string;
  readonly accountId: number;
  readonly createdAt: number;
  readonly absoluteExpiresAt: number;
  readonly idleExpiresAt: number;
  readonly revokedAt: number | null;
}

export interface CreatedSession {
  readonly session: Session;
  /** The raw opaque bearer token to place in the session cookie. Never stored — only its hash is
   * persisted (see `sha256Hex`) — so this value exists only in this return and the response. */
  readonly token: string;
}

interface SessionRow {
  readonly id: string;
  readonly account_id: number;
  readonly created_at: number;
  readonly absolute_expires_at: number;
  readonly idle_expires_at: number;
  readonly revoked_at: number | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    accountId: row.account_id,
    createdAt: row.created_at,
    absoluteExpiresAt: row.absolute_expires_at,
    idleExpiresAt: row.idle_expires_at,
    revokedAt: row.revoked_at,
  };
}

const SESSION_COLUMNS = "id, account_id, created_at, absolute_expires_at, idle_expires_at, revoked_at";

function generateToken(): string {
  return base64Encode(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** Issues a brand-new session for an account. Callers authenticating for the first time (no
 * prior session cookie) call this directly; callers re-authenticating over an existing cookie
 * should use `rotateSession` instead, so the pre-auth session can't be reused (session fixation). */
export async function createSession(db: D1Database, accountId: number, now: number): Promise<CreatedSession> {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);

  const row = await db
    .prepare(
      `INSERT INTO sessions (id, account_id, token_hash, created_at, absolute_expires_at, idle_expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       RETURNING ${SESSION_COLUMNS}`,
    )
    .bind(
      crypto.randomUUID(),
      accountId,
      tokenHash,
      now,
      now + ABSOLUTE_SESSION_LIFETIME_SECONDS * 1000,
      now + IDLE_SESSION_LIFETIME_SECONDS * 1000,
    )
    .first<SessionRow>();
  if (!row) throw new Error("session insert returned no row");

  return { session: toSession(row), token };
}

/** Looks up a session by the hash of the raw bearer token only — never by `id` — so a caller can
 * never authenticate by guessing or supplying an id; the token is the only credential. Returns
 * `undefined` for a missing, revoked, or expired (absolute or idle) session; validation failure
 * here is an expected outcome of an unauthenticated request, not an error condition. */
export async function validateSession(db: D1Database, token: string, now: number): Promise<Session | undefined> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE token_hash = ?1 AND revoked_at IS NULL
         AND absolute_expires_at > ?2 AND idle_expires_at > ?2`,
    )
    .bind(tokenHash, now)
    .first<SessionRow>();
  return row ? toSession(row) : undefined;
}

/** Extends a validated session's idle window. Only called on requests that already validate a
 * session (API/authenticated routes) — this app's static asset routes never call
 * `validateSession` at all, so they never reach this write. If asset routes ever do become
 * session-aware, revisit whether every such request should still cause a write here.
 *
 * The `WHERE` clause re-checks both expiry bounds (not just `revoked_at`) so this is a no-op
 * past either one, independent of caller discipline: without this, a caller that kept touching
 * an already-idle-expired or already-absolute-expired-but-not-yet-revoked row could resurrect it
 * or push its idle window past the absolute cap. */
export async function touchSessionActivity(db: D1Database, sessionId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE sessions SET idle_expires_at = ?2
       WHERE id = ?1 AND revoked_at IS NULL AND absolute_expires_at > ?3 AND idle_expires_at > ?3`,
    )
    .bind(sessionId, now + IDLE_SESSION_LIFETIME_SECONDS * 1000, now)
    .run();
}

/** Revokes whichever session (if any) matches this raw token. A no-op, not an error, when the
 * token matches nothing or is already revoked — logging out a dead session should still succeed. */
export async function revokeSessionByToken(db: D1Database, token: string, now: number): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db
    .prepare(`UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL`)
    .bind(tokenHash, now)
    .run();
}

/** Rotates the session at an authentication boundary (e.g. right after an OAuth callback
 * succeeds). Revokes the previous token (if any) *before* creating the new session: if the
 * insert then fails, the net effect is a logged-out caller, not two live sessions. `previousToken`
 * is `undefined` for a first-time login with no pre-auth session to revoke. */
export async function rotateSession(
  db: D1Database,
  previousToken: string | undefined,
  accountId: number,
  now: number,
): Promise<CreatedSession> {
  if (previousToken !== undefined) {
    await revokeSessionByToken(db, previousToken, now);
  }
  return createSession(db, accountId, now);
}

/** Builds the `Set-Cookie` header value for a session token. `__Host-` requires `Secure`, no
 * `Domain`, and `Path=/` — all three are structural here, not options. */
export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Secure; HttpOnly; Path=/; SameSite=Lax`;
}

/** The `Set-Cookie` value that clears the session cookie on logout. */
export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
