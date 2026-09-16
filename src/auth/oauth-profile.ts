import type { CanvasAuthConfig } from "../config";

/**
 * Owns the Canvas OAuth2 confidential-client profile: the authorize-URL shape, the
 * `/login/oauth2/token` exchange (`authorization_code` and `refresh_token` grants), and provider
 * revocation. Verified 2026-09-16 against Instructure's own OAuth2 endpoint reference
 * (`GET login/oauth2/auth`, `POST login/oauth2/token`, `DELETE login/oauth2/token`):
 *
 * - Canvas defines no `code_challenge`/`code_verifier`/`code_challenge_method` parameter on any
 *   grant type. There is no PKCE extension point to build against, so this module implements only
 *   the confidential authorization-code flow (server-held `client_secret`) and never adds a PKCE
 *   code path. "Absence of PKCE proof does not invent a Canvas limitation" (TASKS.md) — an
 *   institution cannot document Canvas PKCE support because Canvas has none, so this profile stays
 *   confidential-only unconditionally rather than exposing a configuration surface for something
 *   the provider cannot honor.
 * - `client_id`/`client_secret` are POST body parameters (form-encoded), not HTTP Basic auth.
 * - The token response carries the Canvas user identity directly (`user.id`/`user.name`) — no
 *   second `/api/v1/users/self` call is needed to learn who authenticated.
 * - `state` round-trips verbatim on the callback query string.
 * - A `refresh_token` grant response omits `refresh_token`; the original refresh token remains
 *   valid and must be reused (Canvas: "the same refresh token is to be reused").
 *
 * Every call here targets `config.institutionOrigin`, which is fixed at deploy time and is the
 * same origin `consumeOauthAttempt` (`oauth-state.ts`) re-validates the callback against — there
 * is no attacker-reachable path to redirect an exchange at a different host, so this module does
 * not itself allowlist hosts/paths.
 */

const TOKEN_PATH = "/login/oauth2/token";
const AUTHORIZE_PATH = "/login/oauth2/auth";

export interface CanvasTokenResult {
  readonly accessToken: string;
  /** `undefined` on a refresh-grant response — Canvas does not reissue a refresh token. */
  readonly refreshToken: string | undefined;
  readonly expiresInSeconds: number;
  readonly canvasUserId: string;
}

export type FetchFn = typeof fetch;

export function buildAuthorizeUrl(config: CanvasAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_PATH, config.institutionOrigin);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", config.scope);
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function requestToken(institutionOrigin: string, body: Record<string, string>, fetchFn: FetchFn): Promise<CanvasTokenResult> {
  const response = await fetchFn(new URL(TOKEN_PATH, institutionOrigin), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) throw new Error(`Canvas token endpoint returned ${String(response.status)}`);

  const json: unknown = await response.json();
  if (
    !isRecord(json) ||
    typeof json.access_token !== "string" ||
    typeof json.expires_in !== "number" ||
    !isRecord(json.user) ||
    (typeof json.user.id !== "number" && typeof json.user.id !== "string")
  ) {
    throw new Error("Canvas token response had an unexpected shape");
  }
  if (json.refresh_token !== undefined && typeof json.refresh_token !== "string") {
    throw new Error("Canvas token response had an unexpected shape");
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSeconds: json.expires_in,
    canvasUserId: String(json.user.id),
  };
}

/** Exchanges a one-time authorization code for the initial access/refresh token pair. Called at
 * most once per code — Canvas invalidates the code on first use, and `consumeOauthAttempt` has
 * already made the *callback* itself single-use before this is ever reached. */
export async function exchangeAuthorizationCode(
  config: CanvasAuthConfig,
  code: string,
  fetchFn: FetchFn,
): Promise<CanvasTokenResult> {
  return requestToken(
    config.institutionOrigin,
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    },
    fetchFn,
  );
}

/** Mints a fresh access token from a stored refresh token. The caller must keep using its
 * existing refresh token afterward — `result.refreshToken` is `undefined` on this grant. */
export async function refreshAccessToken(
  config: CanvasAuthConfig,
  refreshToken: string,
  fetchFn: FetchFn,
): Promise<CanvasTokenResult> {
  return requestToken(
    config.institutionOrigin,
    {
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      refresh_token: refreshToken,
    },
    fetchFn,
  );
}

/** Best-effort provider-side revocation (`DELETE login/oauth2/token`, authenticated with the
 * access token being revoked). Never throws: logout/disconnect must still delete the local
 * credential and end the local session even when the institution is unreachable or already
 * considers the token invalid. Returns whether Canvas acknowledged the revocation. */
export async function revokeProviderToken(config: CanvasAuthConfig, accessToken: string, fetchFn: FetchFn): Promise<boolean> {
  try {
    const response = await fetchFn(new URL(TOKEN_PATH, config.institutionOrigin), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}
