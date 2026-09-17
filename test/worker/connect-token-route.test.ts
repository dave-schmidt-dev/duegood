import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { findOrCreateAccount, getActiveConnection, getConnectionsForAccount, listCoursesForAccount } from "../../src/db/repository";
import { mutationRoutes } from "../../src/auth/routes";
import { CSRF_HEADER_NAME } from "../../src/auth/mutation-routes";

const APP_ORIGIN = "https://duegood.example";
const INSTITUTION = "https://marymount.instructure.com";
const ACTIVE_KEY_B64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

/** No `CANVAS_CLIENT_ID`/`CANVAS_CLIENT_SECRET` at all — the exact deployment shape this route
 * exists for: `AUTH_MODE=enabled` with no OAuth developer key issued yet. */
function patOnlyEnv(): typeof env {
  return {
    ...env,
    AUTH_MODE: "enabled",
    APP_ORIGIN,
    CANVAS_ORIGIN: INSTITUTION,
    CANVAS_CLIENT_ID: undefined,
    CANVAS_CLIENT_SECRET: undefined,
    TOKEN_KEY_VERSION: "1",
    TOKEN_ENCRYPTION_ACTIVE_KEY_B64: ACTIVE_KEY_B64,
  };
}

function withOauthClientEnv(): typeof env {
  return { ...patOnlyEnv(), CANVAS_CLIENT_ID: "client-123", CANVAS_CLIENT_SECRET: "secret-456" };
}

async function fetchWorker(request: Request, envOverride: typeof env = patOnlyEnv()): Promise<Response> {
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], envOverride);
}

interface RequestOptions {
  readonly origin?: string;
  readonly cfConnectingIp?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
}

function buildConnectRequest(options: RequestOptions): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.origin !== undefined) headers.set("Origin", options.origin);
  if (options.cfConnectingIp !== undefined) headers.set("CF-Connecting-IP", options.cfConnectingIp);
  const body = options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : JSON.stringify({ token: "a-real-looking-token" }));
  return new Request(`${APP_ORIGIN}/auth/canvas/connect-token`, { method: "POST", headers, body });
}

let ipCounter = 0;
function freshClientIp(): string {
  ipCounter += 1;
  return `203.0.113.${String(200 + ipCounter)}`;
}

function mockUsersSelf(status: number, body?: unknown): void {
  vi.mocked(globalThis.fetch).mockImplementation(
    (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch,
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Routes `users/self` and `courses` to independent responses, since `handleConnectToken` calls
 * both in one request (identity verification, then `discoverCourses`) — unlike `mockUsersSelf`,
 * which answers every URL identically and is only safe for tests that don't care what discovery
 * sees. */
function mockUsersSelfAndCourses(userBody: unknown, courses: readonly unknown[]): void {
  vi.mocked(globalThis.fetch).mockImplementation((async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.includes("/api/v1/users/self")) return new Response(JSON.stringify(userBody), { status: 200 });
    if (url.includes("/api/v1/courses")) return new Response(JSON.stringify(courses), { status: 200 });
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch);
}

beforeEach(() => {
  // Same fail-loud default as mutation-route-security.test.ts: any un-mocked live fetch is a bug.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("unexpected live fetch in test");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /auth/canvas/connect-token", () => {
  it("is deliberately not a registered mutation route — no session exists yet to bind CSRF to", () => {
    expect(mutationRoutes.list()).not.toContainEqual({ method: "POST", path: "/auth/canvas/connect-token" });
  });

  it("connects a valid token: creates the account/connection, rotates in a session, never asks for OAuth", async () => {
    mockUsersSelf(200, { id: 777, name: "Student" });
    const response = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp() }));

    expect(response.status).toBe(204);
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.some((cookie) => cookie.startsWith("__Host-duegood_session="))).toBe(true);
    const csrfCookie = setCookies.find((cookie) => cookie.startsWith("__Host-duegood_csrf="));
    expect(csrfCookie).toBeDefined();

    // Never a fabricated refresh token or expiry — see personal-token.ts's doc comment.
    const account = await findOrCreateAccount(env.DB, INSTITUTION, "777", Date.now());
    const [connection] = await getConnectionsForAccount(env.DB, account.id);
    expect(connection).toBeDefined();
    if (connection === undefined) throw new Error("unreachable");
    const full = await getActiveConnection(env.DB, connection.id);
    expect(full?.encryptedRefreshToken).toBeNull();
    expect(full?.accessTokenExpiresAt).toBeNull();
  });

  it("auto-populates the account's course list from Canvas's active enrollments on connect", async () => {
    mockUsersSelfAndCourses(
      { id: 900, name: "Student" },
      [
        { id: 5001, course_code: "TECH 101", name: "Introduction to Computing" },
        { id: 5002, course_code: "MATH 201", name: "Calculus II" },
      ],
    );
    const response = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp() }));
    expect(response.status).toBe(204);

    const account = await findOrCreateAccount(env.DB, INSTITUTION, "900", Date.now());
    const courses = await listCoursesForAccount(env.DB, account.id);
    expect(courses.map((c) => c.canvasCourseId).sort()).toEqual(["5001", "5002"]);
  });

  it("still connects successfully even when course discovery itself fails", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/api/v1/users/self")) return new Response(JSON.stringify({ id: 901, name: "Student" }), { status: 200 });
      return new Response("service unavailable", { status: 503 });
    }) as unknown as typeof fetch);

    const response = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp() }));
    expect(response.status).toBe(204);

    const account = await findOrCreateAccount(env.DB, INSTITUTION, "901", Date.now());
    expect(await listCoursesForAccount(env.DB, account.id)).toEqual([]);
  });

  it("connecting via a PAT still works when an OAuth client happens to be configured too", async () => {
    mockUsersSelf(200, { id: 778, name: "Student Two" });
    const response = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp() }), withOauthClientEnv());
    expect(response.status).toBe(204);
  });

  it("a PAT connection's refresh route reports no_refresh_token rather than attempting an OAuth-shaped refresh", async () => {
    mockUsersSelf(200, { id: 779, name: "Student Three" });
    const connectResponse = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp() }));
    const setCookies = connectResponse.headers.getSetCookie();
    const sessionCookie = setCookies.find((cookie) => cookie.startsWith("__Host-duegood_session="));
    const csrfCookie = setCookies.find((cookie) => cookie.startsWith("__Host-duegood_csrf="));
    if (sessionCookie === undefined || csrfCookie === undefined) throw new Error("connect did not set session/csrf cookies");
    const csrfNameValue = csrfCookie.split(";")[0] ?? "";
    const csrfToken = csrfNameValue.slice(csrfNameValue.indexOf("=") + 1);
    if (csrfToken.length === 0) throw new Error("unreachable");

    const account = await findOrCreateAccount(env.DB, INSTITUTION, "779", Date.now());
    const [connection] = await getConnectionsForAccount(env.DB, account.id);
    if (connection === undefined) throw new Error("unreachable");

    const refreshResponse = await fetchWorker(
      new Request(`${APP_ORIGIN}/api/connections/${connection.id}/refresh`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie.split(";")[0] ?? "",
          Origin: APP_ORIGIN,
          [CSRF_HEADER_NAME]: csrfToken,
        },
      }),
    );
    expect(refreshResponse.status).toBe(409);
    expect(await refreshResponse.json()).toEqual({ error: "no_refresh_token" });
  });

  it("rejects a cross-site request — no Origin/Referer match", async () => {
    mockUsersSelf(200, { id: 780, name: "x" });
    const response = await fetchWorker(buildConnectRequest({ origin: "https://evil.example", cfConnectingIp: freshClientIp() }));
    expect(response.status).toBe(403);
  });

  it("rejects a request with no Origin at all", async () => {
    mockUsersSelf(200, { id: 781, name: "x" });
    const response = await fetchWorker(buildConnectRequest({ cfConnectingIp: freshClientIp() }));
    expect(response.status).toBe(403);
  });

  it("rejects an empty or missing token as a bad request, never reaching the network", async () => {
    const emptyToken = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp(), body: { token: "" } }));
    expect(emptyToken.status).toBe(400);

    const noToken = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp(), body: {} }));
    expect(noToken.status).toBe(400);

    const malformed = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp(), rawBody: "not json" }));
    expect(malformed.status).toBe(400);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports invalid_token with 401 when Canvas rejects the token", async () => {
    mockUsersSelf(401);
    const response = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp() }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_token" });
  });

  it("reports provider_unreachable with 502 when Canvas can't be reached", async () => {
    mockUsersSelf(500);
    const response = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: freshClientIp() }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider_unreachable" });
  });

  it("throttles repeated attempts from the same client, sharing the pre-auth bucket with /auth/canvas/start", async () => {
    mockUsersSelf(401);
    const ip = freshClientIp();
    let last: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await fetchWorker(buildConnectRequest({ origin: APP_ORIGIN, cfConnectingIp: ip }));
    }
    expect(last?.status).toBe(429);
  });
});

describe("GET /api/auth/status — oauthConfigured", () => {
  it("is false when no OAuth client is configured", async () => {
    const response = await fetchWorker(new Request(`${APP_ORIGIN}/api/auth/status`), patOnlyEnv());
    expect(await response.json()).toMatchObject({ available: true, oauthConfigured: false });
  });

  it("is true when an OAuth client is configured", async () => {
    const response = await fetchWorker(new Request(`${APP_ORIGIN}/api/auth/status`), withOauthClientEnv());
    expect(await response.json()).toMatchObject({ available: true, oauthConfigured: true });
  });
});
