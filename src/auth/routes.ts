import type { CanvasAuthConfig } from "../config";
import { base64Encode, decryptCredential, encryptCredential } from "../crypto";
import {
  createConnection,
  deleteConnection,
  findOrCreateAccount,
  getAccountById,
  getActiveConnection,
  getConnectionsForAccount,
  getCourseById,
  revokeConnection,
  updateConnectionCredentials,
} from "../db/repository";
import { importCourse } from "../import/course-import";
import { readCookie } from "./cookies";
import { checkMutationRequest, createMutationRouteRegistry } from "./mutation-routes";
import { buildAuthorizeUrl, exchangeAuthorizationCode, refreshAccessToken, revokeProviderToken } from "./oauth-profile";
import { consumeOauthAttempt, createOauthAttempt } from "./oauth-state";
import { checkPostAuthThrottle, checkPreAuthThrottle } from "./rate-limit";
import {
  buildSessionClearCookie,
  buildSessionCookie,
  readSessionToken,
  rotateSession,
  revokeSessionByToken,
  touchSessionActivity,
  validateSession,
  type Session,
} from "./session";

/** Every route this phase introduces that changes state — see `mutation-routes.ts` for why
 * `/auth/canvas/start` and `/auth/canvas/callback` are deliberately NOT in this list: both are
 * plain top-level cross-site GET navigations (a link, and the institution's own redirect), so
 * they can carry neither a same-origin `Origin`/`Referer` nor a custom header. Each is guarded by
 * a different mechanism instead — the pre-auth throttle, and the one-time atomic state+binding
 * consumption, respectively. */
export const mutationRoutes = createMutationRouteRegistry();
mutationRoutes.register("POST", "/auth/logout");
mutationRoutes.register("POST", "/api/connections/:id/disconnect");
mutationRoutes.register("POST", "/api/connections/:id/refresh");
mutationRoutes.register("POST", "/api/connections/:id/courses/:courseId/import");

const OAUTH_BINDING_COOKIE_NAME = "__Host-duegood_oauth_binding";
const BINDING_BYTES = 32;

function generateBrowserBinding(): string {
  return base64Encode(crypto.getRandomValues(new Uint8Array(BINDING_BYTES)));
}

/** `SameSite=Lax`, not `Strict`: the callback that reads this cookie back arrives as a cross-site
 * top-level GET redirect from the institution, and `Strict` would drop the cookie on exactly that
 * request. Lifetime matches the OAuth attempt it's bound to. */
function buildOauthBindingCookie(value: string, maxAgeSeconds: number): string {
  return `${OAUTH_BINDING_COOKIE_NAME}=${value}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=${String(maxAgeSeconds)}`;
}

function buildOauthBindingClearCookie(): string {
  return `${OAUTH_BINDING_COOKIE_NAME}=; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function clientAddressOf(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function requireSession(request: Request, db: D1Database, now: number): Promise<Session | undefined> {
  const token = readSessionToken(request);
  if (token === undefined) return undefined;
  const session = await validateSession(db, token, now);
  if (session === undefined) return undefined;
  await touchSessionActivity(db, session.id, now);
  return session;
}

async function handleStart(request: Request, config: CanvasAuthConfig, db: D1Database): Promise<Response> {
  const now = Date.now();
  const clientAddress = clientAddressOf(request);
  const allowed = await checkPreAuthThrottle(config.institutionOrigin, clientAddress, now);
  if (!allowed) return jsonError(429, "rate_limited");

  const binding = generateBrowserBinding();
  const created = await createOauthAttempt(
    db,
    { institutionOrigin: config.institutionOrigin, redirectUri: config.redirectUri, browserBinding: binding },
    now,
  );

  const headers = new Headers({ Location: buildAuthorizeUrl(config, created.state) });
  const lifetimeSeconds = Math.max(1, Math.floor((created.attempt.expiresAt - now) / 1000));
  headers.append("Set-Cookie", buildOauthBindingCookie(binding, lifetimeSeconds));
  return new Response(null, { status: 302, headers });
}

async function handleCallback(request: Request, config: CanvasAuthConfig, db: D1Database): Promise<Response> {
  const now = Date.now();
  const url = new URL(request.url);
  if (url.searchParams.get("error") !== null) return jsonError(400, "provider_denied");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const binding = readCookie(request, OAUTH_BINDING_COOKIE_NAME);
  if (code === null || state === null || binding === undefined) return jsonError(400, "invalid_callback");

  // Consumed before the token exchange: a replayed callback can never trigger a second exchange,
  // even if the first exchange is still in flight.
  const attempt = await consumeOauthAttempt(
    db,
    { state, institutionOrigin: config.institutionOrigin, redirectUri: config.redirectUri, browserBinding: binding },
    now,
  );
  if (attempt === undefined) return jsonError(400, "invalid_callback");

  let tokenResult;
  try {
    tokenResult = await exchangeAuthorizationCode(config, code, fetch);
  } catch {
    return jsonError(502, "provider_exchange_failed");
  }

  const account = await findOrCreateAccount(db, config.institutionOrigin, tokenResult.canvasUserId, now);
  const connectionId = crypto.randomUUID();
  const identity = { accountId: account.id, connectionId };
  const accessEnc = await encryptCredential(config.keyRing, identity, tokenResult.accessToken);
  const refreshEnc =
    tokenResult.refreshToken !== undefined ? await encryptCredential(config.keyRing, identity, tokenResult.refreshToken) : undefined;

  await createConnection(db, {
    id: connectionId,
    accountId: account.id,
    keyVersion: accessEnc.keyVersion,
    encryptedAccessToken: accessEnc.envelopeB64,
    encryptedRefreshToken: refreshEnc?.envelopeB64 ?? null,
    accessTokenExpiresAt: now + tokenResult.expiresInSeconds * 1000,
    now,
  });

  // Rotates rather than creates: kills any pre-auth session cookie the caller happened to present,
  // closing the session-fixation gap a bare `createSession` would leave open.
  const previousToken = readSessionToken(request);
  const created = await rotateSession(db, previousToken, account.id, now);

  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", buildSessionCookie(created.token));
  headers.append("Set-Cookie", buildOauthBindingClearCookie());
  return new Response(null, { status: 302, headers });
}

async function handleLogout(request: Request, config: CanvasAuthConfig, db: D1Database): Promise<Response> {
  const now = Date.now();
  const session = await requireSession(request, db, now);
  if (session === undefined) return jsonError(401, "unauthenticated");
  if (!(await checkMutationRequest(request, session, config.appOrigin))) return jsonError(403, "forbidden");

  const token = readSessionToken(request);
  if (token !== undefined) await revokeSessionByToken(db, token, now);

  const headers = new Headers();
  headers.append("Set-Cookie", buildSessionClearCookie());
  return new Response(null, { status: 204, headers });
}

async function handleListConnections(request: Request, db: D1Database): Promise<Response> {
  const now = Date.now();
  const session = await requireSession(request, db, now);
  if (session === undefined) return jsonError(401, "unauthenticated");

  const connections = await getConnectionsForAccount(db, session.accountId);
  // Explicit allowlist, never a spread: credential material must never reach this response even
  // if `Connection` grows a new field later.
  const summaries = connections.map((connection) => ({
    id: connection.id,
    status: connection.status,
    createdAt: connection.createdAt,
  }));
  return Response.json({ connections: summaries });
}

async function ownedActiveConnection(db: D1Database, connectionId: string, accountId: number) {
  const connection = await getActiveConnection(db, connectionId);
  if (connection === undefined || connection.accountId !== accountId) return undefined;
  return connection;
}

async function handleDisconnect(
  request: Request,
  config: CanvasAuthConfig,
  db: D1Database,
  connectionId: string,
): Promise<Response> {
  const now = Date.now();
  const session = await requireSession(request, db, now);
  if (session === undefined) return jsonError(401, "unauthenticated");
  if (!(await checkMutationRequest(request, session, config.appOrigin))) return jsonError(403, "forbidden");

  const connection = await ownedActiveConnection(db, connectionId, session.accountId);
  if (connection === undefined) return jsonError(404, "not_found");

  const identity = { accountId: connection.accountId, connectionId: connection.id };
  const accessToken = await decryptCredential(config.keyRing, identity, {
    keyVersion: connection.keyVersion,
    envelopeB64: connection.encryptedAccessToken,
  });
  await revokeProviderToken(config, accessToken, fetch);

  await revokeConnection(db, connectionId, now);
  await deleteConnection(db, connectionId);
  return new Response(null, { status: 204 });
}

async function handleRefresh(
  request: Request,
  config: CanvasAuthConfig,
  db: D1Database,
  connectionId: string,
): Promise<Response> {
  const now = Date.now();
  const session = await requireSession(request, db, now);
  if (session === undefined) return jsonError(401, "unauthenticated");
  if (!(await checkMutationRequest(request, session, config.appOrigin))) return jsonError(403, "forbidden");

  const connection = await ownedActiveConnection(db, connectionId, session.accountId);
  if (connection === undefined) return jsonError(404, "not_found");
  if (!checkPostAuthThrottle(session.accountId, connectionId, now)) return jsonError(429, "rate_limited");
  if (connection.encryptedRefreshToken === null) return jsonError(409, "no_refresh_token");

  const identity = { accountId: connection.accountId, connectionId: connection.id };
  const refreshToken = await decryptCredential(config.keyRing, identity, {
    keyVersion: connection.keyVersion,
    envelopeB64: connection.encryptedRefreshToken,
  });

  let tokenResult;
  try {
    tokenResult = await refreshAccessToken(config, refreshToken, fetch);
  } catch {
    return jsonError(502, "provider_exchange_failed");
  }

  const accessEnc = await encryptCredential(config.keyRing, identity, tokenResult.accessToken);
  // Canvas never reissues a refresh token on this grant; re-encrypt the existing one under the
  // current active key version too, so both fields stay under the same version on every refresh
  // (a free lazy re-encryption if the key ring has rotated since the last write).
  const refreshEnc = await encryptCredential(config.keyRing, identity, refreshToken);

  try {
    await updateConnectionCredentials(db, connectionId, connection.generation, {
      keyVersion: accessEnc.keyVersion,
      encryptedAccessToken: accessEnc.envelopeB64,
      encryptedRefreshToken: refreshEnc.envelopeB64,
      accessTokenExpiresAt: now + tokenResult.expiresInSeconds * 1000,
    });
  } catch {
    return jsonError(404, "not_found");
  }
  return new Response(null, { status: 204 });
}

/**
 * Keyed by the internal `courses.id` (UUID) with an explicit ownership check below, not by
 * `canvasCourseId` fused with an implicit find-or-create — the latter can never surface a
 * cross-account access attempt, since a lookup scoped to the caller's own account always finds
 * either the caller's own course or nothing. "Select which Canvas course to track" is a separate,
 * not-yet-built mechanism; this route only refreshes a course row that already exists.
 */
async function handleCourseImport(
  request: Request,
  config: CanvasAuthConfig,
  db: D1Database,
  connectionId: string,
  courseId: string,
): Promise<Response> {
  const now = Date.now();
  const session = await requireSession(request, db, now);
  if (session === undefined) return jsonError(401, "unauthenticated");
  if (!(await checkMutationRequest(request, session, config.appOrigin))) return jsonError(403, "forbidden");

  const connection = await ownedActiveConnection(db, connectionId, session.accountId);
  if (connection === undefined) return jsonError(404, "not_found");
  if (!checkPostAuthThrottle(session.accountId, connectionId, now)) return jsonError(429, "rate_limited");

  const course = await getCourseById(db, courseId);
  if (course === undefined || course.accountId !== session.accountId) return jsonError(404, "not_found");

  const account = await getAccountById(db, session.accountId);
  if (account === undefined) return jsonError(404, "not_found");

  const identity = { accountId: connection.accountId, connectionId: connection.id };
  const accessToken = await decryptCredential(config.keyRing, identity, {
    keyVersion: connection.keyVersion,
    envelopeB64: connection.encryptedAccessToken,
  });

  const result = await importCourse({
    db,
    canvasConfig: { institutionOrigin: config.institutionOrigin, accessToken },
    accountId: session.accountId,
    courseId: course.id,
    canvasCourseId: course.canvasCourseId,
    connectionId: connection.id,
    connectionGeneration: connection.generation,
    studentCanvasUserId: account.canvasUserId,
    now,
    fetchImpl: fetch,
  });
  return Response.json(result);
}

const DISCONNECT_PATH = /^\/api\/connections\/([^/]+)\/disconnect$/;
const REFRESH_PATH = /^\/api\/connections\/([^/]+)\/refresh$/;
const IMPORT_PATH = /^\/api\/connections\/([^/]+)\/courses\/([^/]+)\/import$/;

/** Routes every `/auth/*` and `/api/*` request once authentication is configured (`index.ts`
 * keeps its own unconditional 404 for this namespace while auth is disabled). */
export async function handleAuthRoutes(request: Request, config: CanvasAuthConfig, db: D1Database): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/auth/canvas/start") return handleStart(request, config, db);
  if (request.method === "GET" && url.pathname === "/auth/canvas/callback") return handleCallback(request, config, db);
  if (request.method === "POST" && url.pathname === "/auth/logout") return handleLogout(request, config, db);
  if (request.method === "GET" && url.pathname === "/api/connections") return handleListConnections(request, db);

  const disconnectMatch = DISCONNECT_PATH.exec(url.pathname);
  if (request.method === "POST" && disconnectMatch?.[1] !== undefined) {
    return handleDisconnect(request, config, db, disconnectMatch[1]);
  }

  const refreshMatch = REFRESH_PATH.exec(url.pathname);
  if (request.method === "POST" && refreshMatch?.[1] !== undefined) {
    return handleRefresh(request, config, db, refreshMatch[1]);
  }

  const importMatch = IMPORT_PATH.exec(url.pathname);
  if (request.method === "POST" && importMatch?.[1] !== undefined && importMatch[2] !== undefined) {
    return handleCourseImport(request, config, db, importMatch[1], importMatch[2]);
  }

  return jsonError(404, "not_found");
}
