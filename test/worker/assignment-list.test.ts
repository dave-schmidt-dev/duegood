import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { CANVAS_REQUIRED_SCOPE, resolveAuthConfig } from "../../src/config";
import { findOrCreateAccount, findOrCreateCourse, upsertTaskCompletion } from "../../src/db/repository";
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

// Confirms the test's own config actually resolves (mirrors import-ownership.test.ts's keyRing
// check) rather than silently exercising a misconfigured worker.
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

function getAssignments(token: string): Promise<Response> {
  const headers = new Headers({ Cookie: sessionCookieHeader(token) });
  return fetchWorker(new Request(`${APP_ORIGIN}/api/assignments`, { headers }));
}

let seq = 0;
async function makeAccountAndSession(now = Date.now()) {
  seq += 1;
  const account = await findOrCreateAccount(env.DB, INSTITUTION, `assignment-list-${String(seq)}`, now);
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

interface SeedSourceItem {
  readonly courseId: string;
  readonly accountId: number;
  readonly canvasItemId: string;
  readonly title: string | null;
  readonly dueAt: string | null;
  readonly dueAtState: string;
  readonly submissionState: string;
  readonly available?: boolean;
  readonly now?: number;
}

async function seedSourceItem(item: SeedSourceItem): Promise<string> {
  const id = crypto.randomUUID();
  const now = item.now ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO source_items
       (id, account_id, course_id, canvas_item_id, fingerprint, available, last_seen_generation, created_at, updated_at, title, due_at, due_at_state, submission_state)
     VALUES (?1, ?2, ?3, ?4, 'fp', ?5, 1, ?6, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(id, item.accountId, item.courseId, item.canvasItemId, item.available === false ? 0 : 1, now, item.title, item.dueAt, item.dueAtState, item.submissionState)
    .run();
  return id;
}

describe("GET /api/assignments", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await getAssignments("not-a-real-token");
    expect(response.status).toBe(401);
  });

  it("returns the account's available assignments with course, display, and completion data joined", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    const sourceItemId = await seedSourceItem({
      courseId: course.id,
      accountId: owner.account.id,
      canvasItemId: "1",
      title: "Reading response",
      dueAt: "2026-09-20T22:00:00Z",
      dueAtState: "known",
      submissionState: "known_submitted",
    });
    await upsertTaskCompletion(env.DB, owner.account.id, sourceItemId, true, Date.now());

    const response = await getAssignments(owner.token);
    expect(response.status).toBe(200);
    const body = await response.json<{ assignments: unknown[] }>();
    expect(body.assignments).toEqual([
      {
        sourceItemId,
        courseId: course.id,
        courseCode: "TECH 101",
        courseTitle: "Introduction to Computing",
        title: "Reading response",
        dueAt: "2026-09-20T22:00:00Z",
        dueAtState: "known",
        submissionState: "known_submitted",
        completed: true,
        completedAt: expect.any(Number),
      },
    ]);
  });

  it("defaults completion to incomplete when the student has never toggled it", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    await seedSourceItem({
      courseId: course.id,
      accountId: owner.account.id,
      canvasItemId: "1",
      title: "No deadline yet",
      dueAt: null,
      dueAtState: "known_null",
      submissionState: "unknown",
    });

    const response = await getAssignments(owner.token);
    const body = await response.json<{ assignments: { completed: boolean; completedAt: number | null }[] }>();
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({ completed: false, completedAt: null });
  });

  it("excludes an unavailable item", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    await seedSourceItem({
      courseId: course.id,
      accountId: owner.account.id,
      canvasItemId: "1",
      title: "Removed from Canvas",
      dueAt: null,
      dueAtState: "not_returned",
      submissionState: "unknown",
      available: false,
    });

    const response = await getAssignments(owner.token);
    const body = await response.json<{ assignments: unknown[] }>();
    expect(body.assignments).toEqual([]);
  });

  it("never returns another account's assignments", async () => {
    const owner = await makeAccountAndSession();
    const other = await makeAccountAndSession();
    const otherCourse = await makeCourse(other.account.id);
    await seedSourceItem({
      courseId: otherCourse.id,
      accountId: other.account.id,
      canvasItemId: "1",
      title: "Someone else's assignment",
      dueAt: null,
      dueAtState: "not_returned",
      submissionState: "unknown",
    });

    const response = await getAssignments(owner.token);
    const body = await response.json<{ assignments: unknown[] }>();
    expect(body.assignments).toEqual([]);
  });

  it("orders dated items chronologically before items with no known due date", async () => {
    const owner = await makeAccountAndSession();
    const course = await makeCourse(owner.account.id);
    await seedSourceItem({
      courseId: course.id,
      accountId: owner.account.id,
      canvasItemId: "later",
      title: "Later",
      dueAt: "2026-10-01T00:00:00Z",
      dueAtState: "known",
      submissionState: "unknown",
    });
    await seedSourceItem({
      courseId: course.id,
      accountId: owner.account.id,
      canvasItemId: "unknown-due",
      title: "Unknown due date",
      dueAt: null,
      dueAtState: "not_returned",
      submissionState: "unknown",
    });
    await seedSourceItem({
      courseId: course.id,
      accountId: owner.account.id,
      canvasItemId: "sooner",
      title: "Sooner",
      dueAt: "2026-09-20T00:00:00Z",
      dueAtState: "known",
      submissionState: "unknown",
    });

    const response = await getAssignments(owner.token);
    const body = await response.json<{ assignments: { title: string | null }[] }>();
    expect(body.assignments.map((item) => item.title)).toEqual(["Sooner", "Later", "Unknown due date"]);
  });
});
