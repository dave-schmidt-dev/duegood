import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { CANVAS_REQUIRED_SCOPE, resolveAuthConfig } from "../../src/config";
import { findOrCreateAccount, findOrCreateCourse } from "../../src/db/repository";
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

resolveAuthConfig({
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

async function fetchWorker(request: Request): Promise<Response> {
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], enabledEnv());
}

function sessionCookieHeader(token: string): string {
  const cookie = buildSessionCookie(token).split(";")[0];
  if (cookie === undefined) throw new Error("unreachable: buildSessionCookie always yields a name=value pair");
  return cookie;
}

function getCourses(token: string): Promise<Response> {
  const headers = new Headers({ Cookie: sessionCookieHeader(token) });
  return fetchWorker(new Request(`${APP_ORIGIN}/api/courses`, { headers }));
}

let seq = 0;
async function makeAccountAndSession(now = Date.now()) {
  seq += 1;
  const account = await findOrCreateAccount(env.DB, INSTITUTION, `course-list-${String(seq)}`, now);
  const created = await createSession(env.DB, account.id, now);
  return { account, ...created };
}

async function makeCourse(accountId: number, now = Date.now()) {
  seq += 1;
  return findOrCreateCourse(env.DB, {
    id: crypto.randomUUID(),
    accountId,
    canvasCourseId: String(9000 + seq),
    courseCode: "TECH 101",
    title: "Introduction to Computing",
    term: "Fall 2026",
    now,
  });
}

/** `findOrCreateCourse` only ever inserts a fresh row (lease/sync fields all unset); every other
 * state this route reports is reached only after an import has run, so those fields are set here
 * directly rather than by running a real import. */
async function setSyncFields(
  courseId: string,
  fields: { snapshotGeneration?: number; importLeaseToken?: string | null; importLeaseExpiresAt?: number | null; lastSuccessfulCheckAt?: number | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE courses SET snapshot_generation = ?2, import_lease_token = ?3, import_lease_expires_at = ?4, last_successful_check_at = ?5 WHERE id = ?1`,
  )
    .bind(courseId, fields.snapshotGeneration ?? 0, fields.importLeaseToken ?? null, fields.importLeaseExpiresAt ?? null, fields.lastSuccessfulCheckAt ?? null)
    .run();
}

describe("GET /api/courses", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await getCourses("not-a-real-token");
    expect(response.status).toBe(401);
  });

  it("returns no courses for an account that has never selected one", async () => {
    const owner = await makeAccountAndSession();
    const response = await getCourses(owner.token);
    expect(response.status).toBe(200);
    const body = await response.json<{ courses: unknown[] }>();
    expect(body.courses).toEqual([]);
  });

  it("reports never-synced when a course has been selected but never successfully imported", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);

    const response = await getCourses(owner.token);
    const body = await response.json<{ courses: { id: string; lastSuccessfulCheckAt: number | null; syncing: boolean }[] }>();
    expect(body.courses).toEqual([{ id: course.id, courseCode: "TECH 101", title: "Introduction to Computing", lastSuccessfulCheckAt: null, syncing: false }]);
  });

  it("reports the last-synced timestamp after a successful import commit", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const syncedAt = Date.now();
    await setSyncFields(course.id, { snapshotGeneration: 1, lastSuccessfulCheckAt: syncedAt });

    const response = await getCourses(owner.token);
    const body = await response.json<{ courses: { lastSuccessfulCheckAt: number | null; syncing: boolean }[] }>();
    expect(body.courses).toEqual([expect.objectContaining({ lastSuccessfulCheckAt: syncedAt, syncing: false })]);
  });

  it("reports syncing while an import lease is held and not yet expired", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    await setSyncFields(course.id, { importLeaseToken: "lease-1", importLeaseExpiresAt: Date.now() + 60_000 });

    const response = await getCourses(owner.token);
    const body = await response.json<{ courses: { syncing: boolean }[] }>();
    expect(body.courses).toEqual([expect.objectContaining({ syncing: true })]);
  });

  it("does not report syncing once a held lease has expired", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    await setSyncFields(course.id, { importLeaseToken: "lease-1", importLeaseExpiresAt: Date.now() - 60_000 });

    const response = await getCourses(owner.token);
    const body = await response.json<{ courses: { syncing: boolean }[] }>();
    expect(body.courses).toEqual([expect.objectContaining({ syncing: false })]);
  });

  it("never returns another account's courses", async () => {
    const owner = await makeAccountAndSession();
    const other = await makeAccountAndSession();
    await makeCourse(other.account.id);

    const response = await getCourses(owner.token);
    const body = await response.json<{ courses: unknown[] }>();
    expect(body.courses).toEqual([]);
  });
});
