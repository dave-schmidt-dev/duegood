import { base64Encode, sha256Hex } from "../crypto";

/** Short-lived: an in-flight OAuth attempt should not outlive the time a user takes to approve
 * or deny the consent screen at the institution. */
export const OAUTH_STATE_LIFETIME_SECONDS = 10 * 60;
const STATE_BYTES = 32;

export interface OauthAttempt {
  readonly id: string;
  readonly institutionOrigin: string;
  readonly redirectUri: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
}

export interface CreatedOauthAttempt {
  readonly attempt: OauthAttempt;
  /** The random `state` value to place in the authorize-URL redirect. Never stored — only its
   * hash is persisted — so this value exists only in this return and the outgoing redirect. */
  readonly state: string;
}

interface OauthStateRow {
  readonly id: string;
  readonly institution_origin: string;
  readonly redirect_uri: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly consumed_at: number | null;
}

function toAttempt(row: OauthStateRow): OauthAttempt {
  return {
    id: row.id,
    institutionOrigin: row.institution_origin,
    redirectUri: row.redirect_uri,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

const OAUTH_STATE_COLUMNS = "id, institution_origin, redirect_uri, created_at, expires_at, consumed_at";

function generateState(): string {
  return base64Encode(crypto.getRandomValues(new Uint8Array(STATE_BYTES)));
}

export interface OauthAttemptParams {
  readonly institutionOrigin: string;
  readonly redirectUri: string;
  /** A secret tying this attempt to the browser that started it (e.g. a random pre-auth cookie
   * value minted by the route handler). Never stored in the clear — only its hash — and this
   * module has no opinion on how the caller produces or carries it. */
  readonly browserBinding: string;
}

/** Starts a new OAuth attempt. Called once per `/auth/canvas/start` request, before redirecting
 * to the institution's authorize endpoint. */
export async function createOauthAttempt(
  db: D1Database,
  params: OauthAttemptParams,
  now: number,
): Promise<CreatedOauthAttempt> {
  const state = generateState();
  const stateHash = await sha256Hex(state);
  const bindingHash = await sha256Hex(params.browserBinding);

  const row = await db
    .prepare(
      `INSERT INTO oauth_states (id, state_hash, binding_hash, institution_origin, redirect_uri, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       RETURNING ${OAUTH_STATE_COLUMNS}`,
    )
    .bind(
      crypto.randomUUID(),
      stateHash,
      bindingHash,
      params.institutionOrigin,
      params.redirectUri,
      now,
      now + OAUTH_STATE_LIFETIME_SECONDS * 1000,
    )
    .first<OauthStateRow>();
  if (!row) throw new Error("oauth_states insert returned no row");

  return { attempt: toAttempt(row), state };
}

export interface ConsumeOauthAttemptParams {
  readonly state: string;
  readonly institutionOrigin: string;
  readonly redirectUri: string;
  readonly browserBinding: string;
}

/** Consumes an OAuth attempt at the callback, in one atomic statement: the `UPDATE ... WHERE`
 * clause requires an unconsumed, unexpired row whose institution, redirect URI, and browser
 * binding all match what the callback presents, and `RETURNING` reports whether this call won
 * the race. A missing, expired, replayed, or mismatched attempt all return `undefined` —
 * indistinguishably, so a caller can't learn which condition failed. Two concurrent callbacks
 * for the same state can therefore never both succeed. */
export async function consumeOauthAttempt(
  db: D1Database,
  params: ConsumeOauthAttemptParams,
  now: number,
): Promise<OauthAttempt | undefined> {
  const stateHash = await sha256Hex(params.state);
  const bindingHash = await sha256Hex(params.browserBinding);

  const row = await db
    .prepare(
      `UPDATE oauth_states SET consumed_at = ?2
       WHERE state_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2
         AND institution_origin = ?3 AND redirect_uri = ?4 AND binding_hash = ?5
       RETURNING ${OAUTH_STATE_COLUMNS}`,
    )
    .bind(stateHash, now, params.institutionOrigin, params.redirectUri, bindingHash)
    .first<OauthStateRow>();
  return row ? toAttempt(row) : undefined;
}
