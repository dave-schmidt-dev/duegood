import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { CSRF_HEADER_NAME } from "../../src/auth/mutation-routes";
import { buildSessionCookie, createSession, revokeSessionByToken } from "../../src/auth/session";
import { findOrCreateAccount, findOrCreateCourse } from "../../src/db/repository";

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

function sessionCookieHeader(token: string): string {
  const cookie = buildSessionCookie(token).split(";")[0];
  if (cookie === undefined) throw new Error("unreachable: buildSessionCookie always yields a name=value pair");
  return cookie;
}

function postCompletion(path: string, token: string, csrfToken?: string, origin?: string): Request {
  const headers = new Headers({ "Content-Type": "application/json", Cookie: sessionCookieHeader(token) });
  if (csrfToken !== undefined) headers.set(CSRF_HEADER_NAME, csrfToken);
  if (origin !== undefined) headers.set("Origin", origin);
  return new Request(`${APP_ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify({ completed: true }) });
}

let accountCounter = 0;
async function makeAccountAndSession(now = Date.now()) {
  accountCounter += 1;
  const account = await findOrCreateAccount(env.DB, INSTITUTION, `completion-security-${String(accountCounter)}`, now);
  const created = await createSession(env.DB, account.id, now);
  return { account, ...created };
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

async function seedSourceItem(accountId: number, courseId: string, canvasItemId: string, now = Date.now()): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO source_items (id, account_id, course_id, canvas_item_id, fingerprint, available, last_seen_generation, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'fp', 1, 0, ?5, ?5)`,
  )
    .bind(id, accountId, courseId, canvasItemId, now)
    .run();
  return id;
}

describe("POST /api/source-items/:id/completion security", () => {
  it("rejects a missing CSRF token", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "2001");

    const response = await fetchWorker(postCompletion(`/api/source-items/${itemId}/completion`, owner.token, undefined, APP_ORIGIN));

    expect(response.status).toBe(403);
  });

  it("rejects a cross-site Origin, even with a correct CSRF token", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "2002");

    const response = await fetchWorker(
      postCompletion(`/api/source-items/${itemId}/completion`, owner.token, owner.csrfToken, "https://evil.example"),
    );

    expect(response.status).toBe(403);
  });

  it("rejects a wrong CSRF token", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "2003");

    const response = await fetchWorker(postCompletion(`/api/source-items/${itemId}/completion`, owner.token, "not-the-real-token", APP_ORIGIN));

    expect(response.status).toBe(403);
  });

  it("rejects a replayed request after the session it belonged to was revoked (logout)", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "2004");
    await revokeSessionByToken(env.DB, owner.token, Date.now());

    const response = await fetchWorker(postCompletion(`/api/source-items/${itemId}/completion`, owner.token, owner.csrfToken, APP_ORIGIN));

    expect(response.status).toBe(401);
  });
});
