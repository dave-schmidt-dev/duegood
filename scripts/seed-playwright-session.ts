import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { createSession } from "../src/auth/session";
import type { CanvasAssignmentRaw } from "../src/canvas/types";
import { createConnection, findOrCreateAccount, findOrCreateCourse } from "../src/db/repository";
import { importCourse } from "../src/import/course-import";
import { INJECTED_MARKUP_TITLE } from "./seed-constants";

// `process.cwd()`, not a path derived from `import.meta.url`: this source file is bundled by
// `scripts/build-seed-script.mjs` before it runs, so its runtime location (`dist/scripts/...`) is
// one directory deeper than its source location (`scripts/...`) — a `import.meta.url`-relative
// path would silently resolve one level too shallow. Every npm script in this project (`build:ui`,
// `migrations:local`, this one) is invoked from the repo root by convention, so `cwd()` is reliable
// here in a way a bundle-relative path is not.
const root = process.cwd();
const outputPath = path.join(root, "test-results", "playwright-session-fixture.json");

// Must match `dev:test:auth`'s `CANVAS_ORIGIN` in package.json — this script never talks to the
// running Worker or its config, but keeping the seeded account's institution consistent with what
// the Worker believes its institution is avoids a latent mismatch if a later route ever compares
// the two.
const INSTITUTION = "https://canvas-synthetic.invalid";
const CANVAS_USER_ID = "playwright-student-1";
const CANVAS_COURSE_ID = "9001";

function syntheticFetch(page: readonly CanvasAssignmentRaw[]): typeof fetch {
  return (async () => new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

function dueInDays(days: number): string {
  const date = new Date();
  date.setUTCHours(22, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

/**
 * Covers the phase-1 content-model states `docs/DESIGN-SYSTEM.md` requires the This Week page to
 * render: a dated, submitted item; an explicitly-no-deadline, unsubmitted item; an item Canvas
 * returned no submission data for at all (reads as `unknown`, never a false "not submitted"); and
 * a title containing executable-looking markup, to prove it never becomes real DOM.
 */
const FIXTURE_PAGE: CanvasAssignmentRaw[] = [
  { id: 50001, name: "Reading response", due_at: dueInDays(2), points_possible: 10, submission: { workflow_state: "submitted" } },
  { id: 50002, name: "Discussion post (no deadline)", due_at: null, points_possible: 5, submission: { workflow_state: "unsubmitted" } },
  { id: 50003, name: "Group project proposal", due_at: dueInDays(6), points_possible: 20 },
  { id: 50004, name: INJECTED_MARKUP_TITLE, due_at: dueInDays(4), points_possible: 10, submission: { workflow_state: "unsubmitted" } },
];

async function main(): Promise<void> {
  const { env, dispose } = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(root, "wrangler.jsonc"),
    // `wrangler dev --persist-to .wrangler/state` (see `dev:test:auth`) actually writes under a
    // `v3` subdirectory of the given path, confirmed by inspecting `.wrangler/state` on disk —
    // `getPlatformProxy`'s `persist.path` does NOT add that `v3` segment itself, so passing the
    // bare `--persist-to` value here silently created and read a second, empty database instead of
    // reusing the CLI's.
    persist: { path: path.join(root, ".wrangler", "state", "v3") },
  });

  try {
    const now = Date.now();
    const account = await findOrCreateAccount(env.DB, INSTITUTION, CANVAS_USER_ID, now);

    // `findOrCreateAccount`/`findOrCreateCourse` are idempotent finds, and `.wrangler/state/v3`
    // persists across `wrangler dev` restarts — so without this, a completion POST from a
    // previous `session-seed`/`phase1-completion` run leaks into every later run against the
    // same fixture account, since the source item's id (and thus its `task_state` row) is
    // reused. Reset before seeding so every run starts from the same known-incomplete state the
    // fixture assumes.
    await env.DB.prepare(`DELETE FROM task_state WHERE account_id = ?1`).bind(account.id).run();

    const course = await findOrCreateCourse(env.DB, {
      id: crypto.randomUUID(),
      accountId: account.id,
      canvasCourseId: CANVAS_COURSE_ID,
      courseCode: "TECH 101",
      title: "Introduction to Computing",
      term: "Fall 2026",
      now,
    });
    const connection = await createConnection(env.DB, {
      id: crypto.randomUUID(),
      accountId: account.id,
      keyVersion: 1,
      // Never decrypted by this script — `importCourse` takes the Canvas access token directly via
      // `canvasConfig`, so this placeholder envelope is never read. Real shape from
      // `test/worker/course-import.test.ts`'s `makeFixture()`.
      encryptedAccessToken: "envelope",
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      now,
    });

    const importResult = await importCourse({
      db: env.DB,
      canvasConfig: { institutionOrigin: INSTITUTION, accessToken: "synthetic-access-token" },
      accountId: account.id,
      courseId: course.id,
      canvasCourseId: course.canvasCourseId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      studentCanvasUserId: account.canvasUserId,
      now,
      fetchImpl: syntheticFetch(FIXTURE_PAGE),
    });
    if (importResult.status !== "refreshed") {
      throw new Error(`seed import did not refresh (reason: ${importResult.status === "not_refreshed" ? importResult.reason : "unknown"})`);
    }

    const session = await createSession(env.DB, account.id, now);

    // Two more accounts, seeded only far enough to reach `recovery-panel.ts`'s other two states —
    // `disconnected` (zero connections) and `no_course_selected` (an active connection but zero
    // selected courses) — so `test/browser/accessibility-phase1.spec.ts`'s recovery-state
    // coverage exercises real rendered pages, not just the non-browser contract test.
    const disconnectedAccount = await findOrCreateAccount(env.DB, INSTITUTION, `${CANVAS_USER_ID}-disconnected`, now);
    const disconnectedSession = await createSession(env.DB, disconnectedAccount.id, now);

    const noCourseAccount = await findOrCreateAccount(env.DB, INSTITUTION, `${CANVAS_USER_ID}-no-course`, now);
    await createConnection(env.DB, {
      id: crypto.randomUUID(),
      accountId: noCourseAccount.id,
      keyVersion: 1,
      encryptedAccessToken: "envelope",
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      now,
    });
    const noCourseSession = await createSession(env.DB, noCourseAccount.id, now);

    // Raw values only, not a built `Set-Cookie` string: the Playwright spec applies these via
    // `context.addCookies(...)`, which needs its own `{name, value, domain, path, ...}` shape, not
    // a header-formatted string — building that is the spec's job, not this script's.
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      JSON.stringify(
        {
          sessionToken: session.token,
          csrfToken: session.csrfToken,
          accountId: account.id,
          courseId: course.id,
          disconnectedSessionToken: disconnectedSession.token,
          noCourseSessionToken: noCourseSession.token,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`Wrote Playwright session fixture to ${path.relative(root, outputPath)}.`);
  } finally {
    await dispose();
  }
}

await main();
