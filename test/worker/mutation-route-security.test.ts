import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { CANVAS_REQUIRED_SCOPE, resolveAuthConfig, type KeyRing } from "../../src/config";
import { decryptCredential, encryptCredential } from "../../src/crypto";
import { createConnection, findOrCreateAccount, getActiveConnection } from "../../src/db/repository";
import { CSRF_HEADER_NAME } from "../../src/auth/mutation-routes";
import { mutationRoutes } from "../../src/auth/routes";
import { PRE_AUTH_ATTEMPT_LIMIT } from "../../src/auth/rate-limit";
import { buildSessionCookie, createSession } from "../../src/auth/session";

const APP_ORIGIN = "https://duegood.example";
const INSTITUTION = "https://marymount.instructure.com";
const ACTIVE_KEY_B64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const DUMMY_CONNECTION_ID = "00000000-0000-0000-0000-000000000000";

function enabledEnv(): typeof env {
  return {
    ...env,
    AUTH_MODE: "enabled",
    APP_ORIGIN,
    CANVAS_ORIGIN: INSTITUTION,
    CANVAS_CLIENT_ID: "client-123",
    CANVAS_CLIENT_SECRET: "secret-456",
    TOKEN_KEY_VERSION: "1",
    TOKEN_ENCRYPTION_ACTIVE_KEY_B64: ACTIVE_KEY_B64,
  };
}

async function fetchWorker(request: Request): Promise<Response> {
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], enabledEnv());
}

async function fetchWorkerWithEnv(request: Request, envOverride: typeof env): Promise<Response> {
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], envOverride);
}

function keyRing(): KeyRing {
  const resolved = resolveAuthConfig({
    authMode: "enabled",
    appOrigin: APP_ORIGIN,
    institutionOrigin: INSTITUTION,
    clientId: "client-123",
    clientSecret: "secret-456",
    scope: CANVAS_REQUIRED_SCOPE,
    keyVersion: "1",
    activeKeyB64: ACTIVE_KEY_B64,
    legacyKeysJson: undefined,
  });
  if (resolved.mode !== "enabled") throw new Error("test fixture config did not enable");
  return resolved.keyRing;
}

function sessionCookieHeader(token: string): string {
  const cookie = buildSessionCookie(token).split(";")[0];
  if (cookie === undefined) throw new Error("unreachable: buildSessionCookie always yields a name=value pair");
  return cookie;
}

interface RequestOptions {
  readonly method?: string;
  readonly token?: string;
  readonly csrfToken?: string;
  readonly origin?: string;
  readonly extraCookies?: readonly string[];
  readonly cfConnectingIp?: string;
}

function buildRequest(path: string, options: RequestOptions): Request {
  const headers = new Headers();
  const cookies = [...(options.extraCookies ?? [])];
  if (options.token !== undefined) cookies.push(sessionCookieHeader(options.token));
  if (cookies.length > 0) headers.set("Cookie", cookies.join("; "));
  if (options.csrfToken !== undefined) headers.set(CSRF_HEADER_NAME, options.csrfToken);
  if (options.origin !== undefined) headers.set("Origin", options.origin);
  if (options.cfConnectingIp !== undefined) headers.set("CF-Connecting-IP", options.cfConnectingIp);
  return new Request(`${APP_ORIGIN}${path}`, { method: options.method ?? "GET", headers });
}

/** Every `/auth/canvas/start` call in this file must use a distinct `CF-Connecting-IP` (the
 * pre-auth throttle's key), or tests would exhaust each other's shared in-memory bucket — the
 * same "distinct keys per test, not a reset export" approach `rate-limit.ts`'s own tests use. */
let ipCounter = 0;
function freshClientIp(): string {
  ipCounter += 1;
  return `203.0.113.${String(ipCounter)}`;
}

let accountCounter = 0;

// The route handlers under test stamp their own writes with the real wall-clock `Date.now()`
// (they have no injected clock), so fixtures must use it too — a fixed small epoch here would
// read as already-expired the moment a route validates it against the real current time.
async function makeSession(now = Date.now()) {
  accountCounter += 1;
  const account = await findOrCreateAccount(env.DB, INSTITUTION, `mrs-account-${String(accountCounter)}`, now);
  const created = await createSession(env.DB, account.id, now);
  return { account, ...created };
}

async function makeConnection(accountId: number, now = Date.now()) {
  const connectionId = crypto.randomUUID();
  const identity = { accountId, connectionId };
  const ring = keyRing();
  const access = await encryptCredential(ring, identity, "stored-access-token");
  const refresh = await encryptCredential(ring, identity, "stored-refresh-token");
  return createConnection(env.DB, {
    id: connectionId,
    accountId,
    keyVersion: access.keyVersion,
    encryptedAccessToken: access.envelopeB64,
    encryptedRefreshToken: refresh.envelopeB64,
    accessTokenExpiresAt: null,
    now,
  });
}

beforeEach(() => {
  // Every test that needs Canvas network activity mocks it explicitly; anything reaching a real
  // `fetch()` without an explicit mock is exactly the "live Canvas call" the test suite must never
  // make, so the default here fails loudly instead of hanging on a real network request.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("unexpected live fetch in test");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("every registered mutation route", () => {
  it.each(mutationRoutes.list())("rejects $method $path with a missing CSRF token", async ({ method, path }) => {
    const { token } = await makeSession();
    const response = await fetchWorker(
      buildRequest(path.replace(":id", DUMMY_CONNECTION_ID), { method, token, origin: APP_ORIGIN }),
    );
    expect(response.status).toBe(403);
  });

  it.each(mutationRoutes.list())("rejects $method $path from a cross-site Origin", async ({ method, path }) => {
    const { token, csrfToken } = await makeSession();
    const response = await fetchWorker(
      buildRequest(path.replace(":id", DUMMY_CONNECTION_ID), { method, token, csrfToken, origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
  });

  it.each(mutationRoutes.list())("rejects $method $path with a wrong CSRF token", async ({ method, path }) => {
    const { token } = await makeSession();
    const response = await fetchWorker(
      buildRequest(path.replace(":id", DUMMY_CONNECTION_ID), {
        method,
        token,
        csrfToken: "not-the-real-token",
        origin: APP_ORIGIN,
      }),
    );
    expect(response.status).toBe(403);
  });

  it.each(mutationRoutes.list())("rejects $method $path with no session at all", async ({ method, path }) => {
    const response = await fetchWorker(buildRequest(path.replace(":id", DUMMY_CONNECTION_ID), { method, origin: APP_ORIGIN }));
    expect(response.status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the session and clears the cookie when the guard passes", async () => {
    const { token, csrfToken } = await makeSession();

    const response = await fetchWorker(buildRequest("/auth/logout", { method: "POST", token, csrfToken, origin: APP_ORIGIN }));

    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-duegood_session=;");

    const retry = await fetchWorker(
      buildRequest("/api/connections", { method: "GET", token, origin: APP_ORIGIN }),
    );
    expect(retry.status).toBe(401);
  });
});

describe("GET /api/connections", () => {
  it("never returns credential material for the caller's own connections", async () => {
    const { account, token } = await makeSession();
    await makeConnection(account.id);

    const response = await fetchWorker(buildRequest("/api/connections", { method: "GET", token, origin: APP_ORIGIN }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { connections: Array<Record<string, unknown>> };
    expect(body.connections).toHaveLength(1);
    for (const entry of body.connections) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "id", "status"]);
    }
    expect(JSON.stringify(body)).not.toContain("stored-access-token");
    expect(JSON.stringify(body)).not.toContain("stored-refresh-token");
  });

  it("never returns another account's connections", async () => {
    const owner = await makeSession();
    await makeConnection(owner.account.id);
    const stranger = await makeSession();

    const response = await fetchWorker(buildRequest("/api/connections", { method: "GET", token: stranger.token, origin: APP_ORIGIN }));
    const body = (await response.json()) as { connections: unknown[] };
    expect(body.connections).toHaveLength(0);
  });
});

describe("POST /api/connections/:id/disconnect", () => {
  it("revokes the provider token before deleting the connection, and rejects a foreign account", async () => {
    const owner = await makeSession();
    const connection = await makeConnection(owner.account.id);
    const stranger = await makeSession();

    const foreignAttempt = await fetchWorker(
      buildRequest(`/api/connections/${connection.id}/disconnect`, {
        method: "POST",
        token: stranger.token,
        csrfToken: stranger.csrfToken,
        origin: APP_ORIGIN,
      }),
    );
    expect(foreignAttempt.status).toBe(404);

    const revoke = vi.fn(async () => Promise.resolve(new Response(null, { status: 200 })));
    vi.mocked(globalThis.fetch).mockImplementation(revoke as unknown as typeof fetch);

    const response = await fetchWorker(
      buildRequest(`/api/connections/${connection.id}/disconnect`, {
        method: "POST",
        token: owner.token,
        csrfToken: owner.csrfToken,
        origin: APP_ORIGIN,
      }),
    );

    expect(response.status).toBe(204);
    expect(revoke).toHaveBeenCalledTimes(1);
    const [, init] = revoke.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(await getActiveConnection(env.DB, connection.id)).toBeUndefined();
  });
});

describe("POST /api/connections/:id/refresh", () => {
  it("re-encrypts a new access token when the guard and ownership checks pass", async () => {
    const owner = await makeSession();
    const connection = await makeConnection(owner.account.id);
    vi.mocked(globalThis.fetch).mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({ access_token: "refreshed-access-token", token_type: "Bearer", user: { id: 42, name: "x" }, expires_in: 3600 }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );

    const response = await fetchWorker(
      buildRequest(`/api/connections/${connection.id}/refresh`, {
        method: "POST",
        token: owner.token,
        csrfToken: owner.csrfToken,
        origin: APP_ORIGIN,
      }),
    );

    expect(response.status).toBe(204);
  });

  it("rejects local refresh-route access after the connection has been removed", async () => {
    const owner = await makeSession();
    const connection = await makeConnection(owner.account.id);
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(null, { status: 200 }));

    const disconnect = await fetchWorker(
      buildRequest(`/api/connections/${connection.id}/disconnect`, {
        method: "POST",
        token: owner.token,
        csrfToken: owner.csrfToken,
        origin: APP_ORIGIN,
      }),
    );
    expect(disconnect.status).toBe(204);

    const refreshAttempt = await fetchWorker(
      buildRequest(`/api/connections/${connection.id}/refresh`, {
        method: "POST",
        token: owner.token,
        csrfToken: owner.csrfToken,
        origin: APP_ORIGIN,
      }),
    );

    expect(refreshAttempt.status).toBe(404);
  });
});

const TOKEN_RESPONSE_BODY = {
  access_token: "canvas-access-token",
  token_type: "Bearer",
  user: { id: 4242, name: "Test Student" },
  refresh_token: "canvas-refresh-token",
  expires_in: 3600,
};

function mockTokenExchange(): void {
  vi.mocked(globalThis.fetch).mockImplementation(
    (async () => new Response(JSON.stringify(TOKEN_RESPONSE_BODY), { status: 200 })) as unknown as typeof fetch,
  );
}

describe("GET /auth/canvas/start", () => {
  it("redirects to the institution's authorize endpoint and sets the pre-auth binding cookie, with no PKCE parameter", async () => {
    const response = await fetchWorker(buildRequest("/auth/canvas/start", { cfConnectingIp: freshClientIp() }));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe(INSTITUTION);
    expect(location.pathname).toBe("/login/oauth2/auth");
    expect(location.searchParams.has("code_challenge")).toBe(false);
    expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-duegood_oauth_binding=.+; Secure; HttpOnly; Path=\/; SameSite=Lax/);
  });

  it("throttles repeated pre-auth attempts from the same client past the configured limit", async () => {
    const ip = freshClientIp();
    let last: Response | undefined;
    for (let attempt = 0; attempt < PRE_AUTH_ATTEMPT_LIMIT + 1; attempt += 1) {
      last = await fetchWorker(buildRequest("/auth/canvas/start", { cfConnectingIp: ip }));
    }
    expect(last?.status).toBe(429);
  });
});

describe("GET /auth/canvas/callback", () => {
  async function startAttempt(): Promise<{ state: string; bindingCookie: string }> {
    const start = await fetchWorker(buildRequest("/auth/canvas/start", { cfConnectingIp: freshClientIp() }));
    const location = new URL(start.headers.get("Location") ?? "");
    const state = location.searchParams.get("state");
    if (state === null) throw new Error("start response had no state param");
    const bindingCookie = start.headers.get("Set-Cookie")?.split(";")[0];
    if (bindingCookie === undefined) throw new Error("start response set no binding cookie");
    return { state, bindingCookie };
  }

  it("exchanges the code, creates the account and connection, and rotates in a fresh session", async () => {
    const { state, bindingCookie } = await startAttempt();
    mockTokenExchange();

    const response = await fetchWorker(
      buildRequest(`/auth/canvas/callback?code=auth-code&state=${encodeURIComponent(state)}`, { extraCookies: [bindingCookie] }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.some((cookie) => cookie.startsWith("__Host-duegood_session="))).toBe(true);
    expect(setCookies.some((cookie) => cookie.startsWith("__Host-duegood_oauth_binding=;"))).toBe(true);
  });

  it("rejects a replayed callback: the state is consumed before the token exchange ever runs", async () => {
    const { state, bindingCookie } = await startAttempt();
    mockTokenExchange();

    const first = await fetchWorker(buildRequest(`/auth/canvas/callback?code=auth-code&state=${encodeURIComponent(state)}`, { extraCookies: [bindingCookie] }));
    expect(first.status).toBe(302);

    const replay = await fetchWorker(buildRequest(`/auth/canvas/callback?code=auth-code&state=${encodeURIComponent(state)}`, { extraCookies: [bindingCookie] }));
    expect(replay.status).toBe(400);
  });

  it("rejects a callback with no matching pre-auth binding cookie", async () => {
    const { state } = await startAttempt();
    mockTokenExchange();

    const response = await fetchWorker(buildRequest(`/auth/canvas/callback?code=auth-code&state=${encodeURIComponent(state)}`, {}));
    expect(response.status).toBe(400);
  });

  it("rejects a callback carrying a provider error instead of a code", async () => {
    const response = await fetchWorker(buildRequest("/auth/canvas/callback?error=access_denied&state=x", {}));
    expect(response.status).toBe(400);
  });
});

describe("refresh performs lazy re-encryption under the current active key version", () => {
  const NEW_ACTIVE_KEY_B64 = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU=";

  it("re-encrypts a connection stored under a now-legacy key version under today's active version", async () => {
    const owner = await makeSession();
    // Created while key version 1 is active — this is the "legacy" envelope by the time refresh runs.
    const connection = await makeConnection(owner.account.id);
    expect(connection.keyVersion).toBe(1);

    const rotatedEnv: typeof env = {
      ...enabledEnv(),
      TOKEN_KEY_VERSION: "2",
      TOKEN_ENCRYPTION_ACTIVE_KEY_B64: NEW_ACTIVE_KEY_B64,
      TOKEN_ENCRYPTION_LEGACY_KEYS_JSON: JSON.stringify({ 1: ACTIVE_KEY_B64 }),
    };
    vi.mocked(globalThis.fetch).mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({ access_token: "refreshed-access-token", token_type: "Bearer", user: { id: 42, name: "x" }, expires_in: 3600 }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );

    const response = await fetchWorkerWithEnv(
      buildRequest(`/api/connections/${connection.id}/refresh`, {
        method: "POST",
        token: owner.token,
        csrfToken: owner.csrfToken,
        origin: APP_ORIGIN,
      }),
      rotatedEnv,
    );
    expect(response.status).toBe(204);

    const refreshed = await getActiveConnection(env.DB, connection.id);
    expect(refreshed?.keyVersion).toBe(2);

    const resolved = resolveAuthConfig({
      authMode: "enabled",
      appOrigin: APP_ORIGIN,
      institutionOrigin: INSTITUTION,
      clientId: "client-123",
      clientSecret: "secret-456",
      scope: CANVAS_REQUIRED_SCOPE,
      keyVersion: "2",
      activeKeyB64: NEW_ACTIVE_KEY_B64,
      legacyKeysJson: undefined,
    });
    if (resolved.mode !== "enabled") throw new Error("test fixture config did not enable");
    // A version-2-only ring (no legacy key present) can still decrypt: proof the envelope was
    // actually rewritten under version 2, not just the `key_version` column bumped in place.
    const decrypted = await decryptCredential(
      resolved.keyRing,
      { accountId: owner.account.id, connectionId: connection.id },
      { keyVersion: refreshed?.keyVersion ?? 0, envelopeB64: refreshed?.encryptedAccessToken ?? "" },
    );
    expect(decrypted).toBe("refreshed-access-token");
  });
});
