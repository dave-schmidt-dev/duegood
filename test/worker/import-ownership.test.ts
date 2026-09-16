import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { CANVAS_REQUIRED_SCOPE, resolveAuthConfig, type KeyRing } from "../../src/config";
import { encryptCredential } from "../../src/crypto";
import { createConnection, findOrCreateAccount, findOrCreateCourse } from "../../src/db/repository";
import { CSRF_HEADER_NAME } from "../../src/auth/mutation-routes";
import { buildSessionCookie, createSession } from "../../src/auth/session";

const APP_ORIGIN = "https://duegood.example";
const INSTITUTION = "https://marymount.instructure.com";
const ACTIVE_KEY_B64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

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

function buildRequest(path: string, options: { method: string; token: string; csrfToken: string }): Request {
  const headers = new Headers();
  headers.set("Cookie", sessionCookieHeader(options.token));
  headers.set(CSRF_HEADER_NAME, options.csrfToken);
  headers.set("Origin", APP_ORIGIN);
  return new Request(`${APP_ORIGIN}${path}`, { method: options.method, headers });
}

let accountCounter = 0;
async function makeAccountAndSession(now = Date.now()) {
  accountCounter += 1;
  const account = await findOrCreateAccount(env.DB, INSTITUTION, `import-owner-${String(accountCounter)}`, now);
  const created = await createSession(env.DB, account.id, now);
  return { account, ...created };
}

async function makeConnection(accountId: number, now = Date.now()) {
  const connectionId = crypto.randomUUID();
  const identity = { accountId, connectionId };
  const ring = keyRing();
  const access = await encryptCredential(ring, identity, "stored-access-token");
  return createConnection(env.DB, {
    id: connectionId,
    accountId,
    keyVersion: access.keyVersion,
    encryptedAccessToken: access.envelopeB64,
    encryptedRefreshToken: null,
    accessTokenExpiresAt: null,
    now,
  });
}

async function makeCourse(accountId: number, now = Date.now()) {
  accountCounter += 1;
  return findOrCreateCourse(env.DB, {
    id: crypto.randomUUID(),
    accountId,
    canvasCourseId: String(9000 + accountCounter),
    courseCode: "TECH 101",
    title: "Introduction to Computing",
    term: "Fall 2026",
    now,
  });
}

beforeEach(() => {
  // Both rejections here must happen before any Canvas call is ever made; a live fetch would mean
  // the ownership check was bypassed.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("unexpected live fetch in test");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/connections/:id/courses/:courseId/import ownership", () => {
  it("rejects an import naming another account's course, even with the caller's own connection", async () => {
    const owner = await makeAccountAndSession();
    const ownerConnection = await makeConnection(owner.account.id);
    const otherAccount = await makeAccountAndSession();
    const otherCourse = await makeCourse(otherAccount.account.id);

    const response = await fetchWorker(
      buildRequest(`/api/connections/${ownerConnection.id}/courses/${otherCourse.id}/import`, {
        method: "POST",
        token: owner.token,
        csrfToken: owner.csrfToken,
      }),
    );

    expect(response.status).toBe(404);
  });

  it("rejects an import naming another account's connection, even against the caller's own course", async () => {
    const owner = await makeAccountAndSession();
    const ownerCourse = await makeCourse(owner.account.id);
    const otherAccount = await makeAccountAndSession();
    const otherConnection = await makeConnection(otherAccount.account.id);

    const response = await fetchWorker(
      buildRequest(`/api/connections/${otherConnection.id}/courses/${ownerCourse.id}/import`, {
        method: "POST",
        token: owner.token,
        csrfToken: owner.csrfToken,
      }),
    );

    expect(response.status).toBe(404);
  });
});
