import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { CanvasAssignmentRaw } from "../../src/canvas/types";
import { CSRF_HEADER_NAME } from "../../src/auth/mutation-routes";
import { buildSessionCookie, createSession } from "../../src/auth/session";
import { createConnection, findOrCreateAccount, findOrCreateCourse, getTaskState } from "../../src/db/repository";
import { importCourse } from "../../src/import/course-import";

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

function getCompletion(path: string, token: string): Request {
  const headers = new Headers({ Cookie: sessionCookieHeader(token) });
  return new Request(`${APP_ORIGIN}${path}`, { method: "GET", headers });
}

function postCompletion(path: string, token: string, csrfToken: string, completed: boolean): Request {
  const headers = new Headers({ "Content-Type": "application/json", Cookie: sessionCookieHeader(token) });
  headers.set(CSRF_HEADER_NAME, csrfToken);
  headers.set("Origin", APP_ORIGIN);
  return new Request(`${APP_ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify({ completed }) });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

let accountCounter = 0;
async function makeAccountAndSession(now = Date.now()) {
  accountCounter += 1;
  const account = await findOrCreateAccount(env.DB, INSTITUTION, `completion-${String(accountCounter)}`, now);
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

async function makeConnection(accountId: number, now = Date.now()) {
  return createConnection(env.DB, {
    id: crypto.randomUUID(),
    accountId,
    keyVersion: 1,
    encryptedAccessToken: "envelope",
    encryptedRefreshToken: null,
    accessTokenExpiresAt: null,
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

describe("personal completion", () => {
  it("persists a completion mark and reads it back", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "1001");

    const setResponse = await fetchWorker(postCompletion(`/api/source-items/${itemId}/completion`, owner.token, owner.csrfToken, true));
    expect(setResponse.status).toBe(200);
    const setBody = (await setResponse.json()) as { completed: boolean; completedAt: number | null };
    expect(setBody.completed).toBe(true);
    expect(typeof setBody.completedAt).toBe("number");

    const getResponse = await fetchWorker(getCompletion(`/api/source-items/${itemId}/completion`, owner.token));
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual(setBody);
  });

  it("toggles back to incomplete and clears completedAt", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "1002");
    await fetchWorker(postCompletion(`/api/source-items/${itemId}/completion`, owner.token, owner.csrfToken, true));

    const response = await fetchWorker(postCompletion(`/api/source-items/${itemId}/completion`, owner.token, owner.csrfToken, false));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: false, completedAt: null });
  });

  it("reads unset completion state as incomplete rather than 404", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "1003");

    const response = await fetchWorker(getCompletion(`/api/source-items/${itemId}/completion`, owner.token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: false, completedAt: null });
  });

  it("rejects another account's read of a source item it doesn't own", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "1004");
    const other = await makeAccountAndSession();

    const response = await fetchWorker(getCompletion(`/api/source-items/${itemId}/completion`, other.token));

    expect(response.status).toBe(404);
  });

  it("rejects another account's write to a source item it doesn't own, without changing the owner's state", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "1005");
    const other = await makeAccountAndSession();

    const response = await fetchWorker(postCompletion(`/api/source-items/${itemId}/completion`, other.token, other.csrfToken, true));
    expect(response.status).toBe(404);

    const ownerRead = await fetchWorker(getCompletion(`/api/source-items/${itemId}/completion`, owner.token));
    expect(await ownerRead.json()).toEqual({ completed: false, completedAt: null });
  });

  it("preserves a completion value across a later import that changes the same item's fingerprint", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const connection = await makeConnection(owner.account.id);
    const itemId = await seedSourceItem(owner.account.id, course.id, "1006");
    await fetchWorker(postCompletion(`/api/source-items/${itemId}/completion`, owner.token, owner.csrfToken, true));
    const before = await getTaskState(env.DB, itemId);

    const changedPage: CanvasAssignmentRaw[] = [{ id: 1006, name: "Changed name", due_at: null, points_possible: 20 }];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(changedPage));
    const result = await importCourse({
      db: env.DB,
      canvasConfig: { institutionOrigin: INSTITUTION, accessToken: "token" },
      accountId: owner.account.id,
      courseId: course.id,
      canvasCourseId: course.canvasCourseId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      studentCanvasUserId: owner.account.canvasUserId,
      now: Date.now(),
      fetchImpl,
    });

    expect(result.status).toBe("refreshed");
    const after = await getTaskState(env.DB, itemId);
    expect(after).toEqual(before);
  });
});
