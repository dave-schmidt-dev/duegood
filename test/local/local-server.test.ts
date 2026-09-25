import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IcalFetchError, run as runIcalFetcher, validateCanvasIcalUrl } from "../../scripts/sync-canvas-ical.mjs";

const children: ChildProcess[] = [];
const directories: string[] = [];

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) return reject(new Error("missing test address"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function start(includeDiscussion = false, flags: { icalImport?: boolean; readOnly?: boolean } = {}): Promise<{ origin: string; file: string; port: number; child: ChildProcess; stderr: () => string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "duegood-server-"));
  directories.push(directory);
  const file = path.join(directory, "contract.json");
  const fixture = JSON.parse(await readFile(path.resolve("fixtures/local-coursework-contract.json"), "utf8"));
  if (includeDiscussion) fixture.items.push({
    id: "course-a-canvas-discussion-1",
    course: "course-a",
    kind: "discussion",
    title: "Synthetic Discussion",
    at: "2030-01-12T23:59",
    detail: "Post and reply.",
    submissionStatus: "unsubmitted",
    done: false,
    doneAt: null,
  });
  await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("dist/local/server.mjs"), "--coursework", file, "--port", String(port),
    ...(flags.icalImport ? ["--enable-ical-import"] : []), ...(flags.readOnly ? ["--read-only"] : [])], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...(flags.icalImport ? { DUEGOOD_ICAL_IMPORT_CONFIG_JSON: JSON.stringify({
      institution: "synthetic.institution.invalid",
      canvasOrigin: "https://canvas.example.invalid",
      courses: [{ key: "course-a", canvasCourseId: "900001" }],
    }) } : {}) },
  });
  children.push(child);
  let errors = "";
  child.stderr?.on("data", (chunk) => { errors += String(chunk); });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local server exited early: ${errors}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return { origin, file, port, child, stderr: () => errors };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`local server did not become ready: ${errors}`);
}

async function waitForHealth(origin: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error("restarted local server exited early");
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("restarted local server did not become ready");
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const canvasOrigin = "https://canvas.example.invalid";
function calendarEvent(uid: string, assignmentId: string, at = "20300120T150000Z"): string {
  return `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20300101T000000Z\r\nSUMMARY:Synthetic imported work\r\nDTSTART:${at}\r\nURL:${canvasOrigin}/courses/900001/assignments/${assignmentId}?feedtoken=synthetic-url-sentinel\r\nEND:VEVENT\r\n`;
}
function calendar(...events: string[]): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join("")}END:VCALENDAR\r\n`;
}
async function csrfToken(origin: string): Promise<string> {
  const page = await fetch(origin);
  const token = page.headers.get("set-cookie")?.match(/duegood_local_csrf=([^;]+)/)?.[1];
  if (!token) throw new Error("missing synthetic test token");
  return token;
}
async function postCalendar(origin: string, token: string, input: string, suffix = ""): Promise<Response> {
  return fetch(`${origin}/api/local/ical-import${suffix}`, {
    method: "POST", headers: { "Content-Type": "text/calendar; charset=utf-8", "x-duegood-csrf-token": token }, body: input,
  });
}

describe("local server", () => {
  it("keeps feed acquisition opt-in and confines synthetic failure injections before the byte importer", async () => {
    const defaultServer = await start();
    const defaultStatus = await fetch(`${defaultServer.origin}/api/auth/status`).then((response) => response.json()) as { icalFetchAvailable: boolean };
    expect(defaultStatus.icalFetchAvailable).toBe(false);
    expect(() => validateCanvasIcalUrl("https://elsewhere.invalid/feeds/calendars/private-sentinel")).toThrow(IcalFetchError);
    expect(() => validateCanvasIcalUrl("https://marymount.instructure.com:444/feeds/calendars/private-sentinel")).toThrow(IcalFetchError);
    expect(() => validateCanvasIcalUrl("https://marymount.instructure.com:443/feeds/calendars/private-sentinel")).toThrow(IcalFetchError);
    expect(() => validateCanvasIcalUrl("https://marymount.instructure.com/feeds/calendars/private-sentinel?unexpected=query")).toThrow(IcalFetchError);

    const feed = "https://marymount.instructure.com/feeds/calendars/synthetic-private-feed.ics";
    const launch = new TextEncoder().encode(JSON.stringify({ origin: "http://127.0.0.1:43127", csrfToken: "a".repeat(43) }));
    await expect(runIcalFetcher(["--loopback-origin", "http://127.0.0.1:43127"], {
      DUEGOOD_CANVAS_ICAL_URL: feed, DUEGOOD_ICAL_IMPORT_ORIGIN: "http://127.0.0.1:43127",
    }, { readLaunch: async () => launch, fetchImpl: async () => { throw new Error("must not fetch"); } })).rejects.toMatchObject({ code: "INVALID_IMPORT_TARGET" });
    await expect(runIcalFetcher([], {
      DUEGOOD_CANVAS_ICAL_URL: feed, DUEGOOD_ICAL_IMPORT_ORIGIN: "http://127.0.0.1:43127",
    }, { readLaunch: async () => new TextEncoder().encode(JSON.stringify({ origin: "http://127.0.0.1:43128", csrfToken: "a".repeat(43) })),
      fetchImpl: async () => { throw new Error("must not fetch"); } })).rejects.toMatchObject({ code: "INVALID_IMPORT_LAUNCH" });
    const cases: Array<[string, () => Promise<Response>]> = [
      ["REDIRECT_REJECTED", async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.invalid" } })],
      ["TIMEOUT", async () => { const error = new Error("synthetic-private-timeout"); error.name = "AbortError"; throw error; }],
      ["DNS_OR_TLS_FAILURE", async () => { throw new TypeError("getaddrinfo synthetic-private-dns"); }],
      ["DNS_OR_TLS_FAILURE", async () => { throw new TypeError("TLS synthetic-private-certificate"); }],
      ["OVERSIZE", async () => new Response("", { status: 200, headers: { "Content-Type": "text/calendar", "Content-Length": String(5 * 1024 * 1024 + 1) } })],
    ];
    for (const [code, response] of cases) {
      let imports = 0;
      const statuses: string[] = [];
      await expect(runIcalFetcher([], { DUEGOOD_CANVAS_ICAL_URL: feed, DUEGOOD_ICAL_IMPORT_ORIGIN: "http://127.0.0.1:43127" }, {
        readLaunch: async () => launch,
        onStatus: (status: string) => statuses.push(status),
        fetchImpl: async (input: RequestInfo | URL) => {
          if (String(input).startsWith("https://marymount.instructure.com/")) return await response();
          imports += 1;
          return new Response(null, { status: 200 });
        },
      })).rejects.toMatchObject({ code });
      expect(imports).toBe(0);
      expect(statuses.join(" ")).not.toContain("synthetic-private-feed");
      expect(statuses.join(" ")).not.toContain("synthetic-private");
    }
  });

  it("posts only bounded calendar bytes to the fixed loopback importer", async () => {
    const feed = "https://marymount.instructure.com/feeds/calendars/synthetic-private-feed.ics";
    const input = new TextEncoder().encode(calendar(calendarEvent("synthetic-uid", "990123")));
    let importRequest: RequestInit | undefined;
    let importTarget = "";
    const statuses: string[] = [];
    await runIcalFetcher([], { DUEGOOD_CANVAS_ICAL_URL: feed, DUEGOOD_ICAL_IMPORT_ORIGIN: "http://127.0.0.1:43127" }, {
      readLaunch: async () => new TextEncoder().encode(JSON.stringify({ origin: "http://127.0.0.1:43127", csrfToken: "a".repeat(43) })),
      onStatus: (status: string) => statuses.push(status),
      fetchImpl: async (request: RequestInfo | URL, init?: RequestInit) => {
        if (String(request).startsWith("https://marymount.instructure.com/")) return new Response(input, { status: 200, headers: { "Content-Type": "text/calendar" } });
        importTarget = String(request);
        importRequest = init;
        return new Response(null, { status: 200 });
      },
    });
    expect(importRequest).toMatchObject({ method: "POST", redirect: "error", headers: { "Content-Type": "text/calendar; charset=utf-8" } });
    expect(importTarget).toBe("http://127.0.0.1:43127/api/local/ical-import");
    expect(importRequest?.body).toBeInstanceOf(Uint8Array);
    expect(statuses).toEqual(["started", `downloaded ${input.byteLength} bytes`, "completed"]);
    expect(statuses.join(" ")).not.toContain("synthetic-private-feed");
  });

  it("serves the local projection and protects completion writes", async () => {
    const { origin, file } = await start();
    const page = await fetch(origin);
    expect(page.status).toBe(200);
    const setCookie = page.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^duegood_local_csrf=[^;]+;/);
    expect(setCookie).not.toMatch(/;\s*Secure(?:;|$)/i);
    const cookie = setCookie.match(/duegood_local_csrf=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();

    const assignments = await fetch(`${origin}/api/assignments`).then((response) => response.json()) as { assignments: unknown[] };
    expect(assignments.assignments).toHaveLength(2);
    const dashboard = await fetch(`${origin}/api/dashboard`).then((response) => response.json()) as { events: unknown[]; resources: unknown[]; conversations: unknown[]; refreshes: unknown[]; sourceStatus: { state: string; inbox: string } };
    expect(dashboard.events).toHaveLength(2);
    expect(dashboard.resources).toEqual([]);
    expect(dashboard.conversations).toEqual([]);
    expect(dashboard.refreshes).toEqual([]);
    expect(dashboard.sourceStatus).toMatchObject({ state: "not_synced", inbox: "not_synced" });
    const rejected = await fetch(`${origin}/api/source-items/course-a-canvas-910002/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    expect(rejected.status).toBe(403);

    const accepted = await fetch(`${origin}/api/source-items/course-a-canvas-910002/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-duegood-csrf-token": cookie as string },
      body: JSON.stringify({ completed: true }),
    });
    expect(accepted.status).toBe(200);
    const document = JSON.parse(await readFile(file, "utf8"));
    expect(document.items[1].done).toBe(true);
  });

  it("serves a validated local profile avatar inline and returns 404 when absent", async () => {
    const { origin, file } = await start();
    const missing = await fetch(`${origin}/api/local/profile/avatar`);
    expect(missing.status).toBe(404);
    const root = path.dirname(file);
    const avatar = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(path.join(root, "canvas-profile.json"), JSON.stringify({ name: "Synthetic Student", avatar: { path: "canvas-profile-avatar.png", contentType: "image/png", bytes: avatar.length } }));
    await writeFile(path.join(root, "canvas-profile-avatar.png"), avatar);
    const response = await fetch(`${origin}/api/local/profile/avatar`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(avatar);
    const dashboard = await fetch(`${origin}/api/dashboard`).then((result) => result.json()) as { profile: unknown };
    expect(dashboard.profile).toEqual({ displayName: "Synthetic Student", avatarPath: "/api/local/profile/avatar" });
  });

  it("rejects a hostile Host header", async () => {
    const { origin } = await start();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const probe = request(`${origin}/health`, { headers: { Host: "attacker.invalid" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      probe.once("error", reject);
      probe.end();
    });
    expect(status).toBe(403);
  });

  it("protects and persists discussion checklist writes", async () => {
    const { origin, file } = await start(true);
    const page = await fetch(origin);
    const setCookie = page.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^duegood_local_csrf=[^;]+;/);
    expect(setCookie).not.toMatch(/;\s*Secure(?:;|$)/i);
    const cookie = setCookie.match(/duegood_local_csrf=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();
    const dashboard = await fetch(`${origin}/api/dashboard`).then((response) => response.json()) as { events: Array<{ sourceItemId: string; kind: string | null; discussionPostDone: boolean; discussionRepliesDone: boolean; completed: boolean }> };
    const discussion = dashboard.events.find((event) => event.kind === "discussion");
    expect(discussion).toMatchObject({ discussionPostDone: false, discussionRepliesDone: false, completed: false });
    const rejected = await fetch(`${origin}/api/source-items/${discussion?.sourceItemId}/discussion-progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discussionPostDone: true, discussionRepliesDone: true }),
    });
    expect(rejected.status).toBe(403);
    const accepted = await fetch(`${origin}/api/source-items/${discussion?.sourceItemId}/discussion-progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-duegood-csrf-token": cookie as string },
      body: JSON.stringify({ discussionPostDone: true, discussionRepliesDone: true }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ discussionPostDone: true, discussionRepliesDone: true });
    const document = JSON.parse(await readFile(file, "utf8"));
    expect(document.items.at(-1)).toMatchObject({ discussionPostDone: true, discussionRepliesDone: true, done: false });
  });

  it("merges field-specific discussion writes from stale tabs", async () => {
    const { origin, file } = await start(true);
    const page = await fetch(origin);
    const cookie = page.headers.get("set-cookie")?.match(/duegood_local_csrf=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();
    const writes = (field: "post" | "replies") => fetch(`${origin}/api/source-items/course-a-canvas-discussion-1/discussion-progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-duegood-csrf-token": cookie as string },
      body: JSON.stringify({ field, value: true }),
    });
    const responses = await Promise.all([writes("post"), writes("replies")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const document = JSON.parse(await readFile(file, "utf8"));
    expect(document.items.at(-1)).toMatchObject({ discussionPostDone: true, discussionRepliesDone: true, done: false });
  });

  it("rotates the local CSRF token after a server restart", async () => {
    const first = await start();
    const firstPage = await fetch(first.origin);
    const stale = firstPage.headers.get("set-cookie")?.match(/duegood_local_csrf=([^;]+)/)?.[1];
    expect(stale).toBeTruthy();
    first.child.kill("SIGTERM");
    await new Promise<void>((resolve) => first.child.once("exit", () => resolve()));
    const replacement = spawn(process.execPath, [path.resolve("dist/local/server.mjs"), "--coursework", first.file, "--port", String(first.port)], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(replacement);
    await waitForHealth(first.origin, replacement);
    const freshPage = await fetch(first.origin);
    const fresh = freshPage.headers.get("set-cookie")?.match(/duegood_local_csrf=([^;]+)/)?.[1];
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(stale);
    const rejected = await fetch(`${first.origin}/api/source-items/course-a-canvas-910002/completion`, { method: "POST", headers: { "Content-Type": "application/json", "x-duegood-csrf-token": stale as string }, body: JSON.stringify({ completed: true }) });
    expect(rejected.status).toBe(403);
    const accepted = await fetch(`${first.origin}/api/source-items/course-a-canvas-910002/completion`, { method: "POST", headers: { "Content-Type": "application/json", "x-duegood-csrf-token": fresh as string }, body: JSON.stringify({ completed: true }) });
    expect(accepted.status).toBe(200);
  });

  it("returns a coursework version conflict when the source changes after projection", async () => {
    const { origin, file } = await start();
    const page = await fetch(origin);
    const cookie = page.headers.get("set-cookie")?.match(/duegood_local_csrf=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();
    await fetch(`${origin}/api/dashboard`);
    const document = JSON.parse(await readFile(file, "utf8")) as { generated: string };
    document.generated = "2030-01-01T00:00:00.000Z";
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    const response = await fetch(`${origin}/api/source-items/course-a-canvas-910002/completion`, { method: "POST", headers: { "Content-Type": "application/json", "x-duegood-csrf-token": cookie as string }, body: JSON.stringify({ completed: true }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "coursework document changed; reload and retry" });
  });

  it("fails closed when another server already owns the injected port", async () => {
    const { origin, file } = await start();
    const port = new URL(origin).port;
    const second = spawn(process.execPath, [path.resolve("dist/local/server.mjs"), "--coursework", file, "--port", port], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(second);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("second server did not fail promptly")), 2_000);
      second.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(exitCode).not.toBe(0);
  });

  it("imports a bounded calendar window through the exclusive writer and preserves local state", async () => {
    const { origin, file, stderr } = await start(false, { icalImport: true });
    const token = await csrfToken(origin);
    const firstInput = calendar(calendarEvent("synthetic-private-uid-sentinel", "990123"), calendarEvent("legacy-uid", "910001"));
    const firstResponse = await postCalendar(origin, token, firstInput);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { version: string; added: number; removed: number; feedStatus: { acquisition: string; coverage: string } };
    expect(first).toMatchObject({ added: 1, removed: 0, feedStatus: { acquisition: "succeeded", coverage: "rolling_window" } });
    let document = JSON.parse(await readFile(file, "utf8")) as { items: Array<Record<string, unknown>> };
    const imported = document.items.find((item) => item.source === "ical");
    expect(imported).toBeDefined();
    expect(imported).not.toHaveProperty("canvasId");
    expect(document.items.filter((item) => item.canvasId === 910001)).toHaveLength(1);
    expect(document.items.find((item) => item.canvasId === 910001)).toMatchObject({ id: "course-a-canvas-910001", done: true, grade: "18", score: 18,
      at: "2030-01-20T15:00:00.000Z" });
    expect(document.items.find((item) => item.canvasId === 910001)?.sourceReferences).toContainEqual({
      institution: "synthetic.institution.invalid", course: "course-a", source: "ical", id: "assignment:910001",
    });
    const importedId = imported?.id as string;
    const completion = await fetch(`${origin}/api/source-items/${importedId}/completion`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-duegood-csrf-token": token }, body: JSON.stringify({ completed: true }),
    });
    expect(completion.status).toBe(200);
    document = JSON.parse(await readFile(file, "utf8")) as { items: Array<Record<string, unknown>> };
    const target = document.items.find((item) => item.id === importedId)!;
    target.notesExtension = { keep: "local" };
    target.grade = "A";
    target.score = 99;
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    const beforeRepeat = await readFile(file, "utf8");
    const repeated = await postCalendar(origin, token, firstInput);
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as { version: string }).version).toBe((await fetch(`${origin}/api/dashboard`).then((response) => response.json()) as { version: string }).version);
    expect(await readFile(file, "utf8")).toBe(beforeRepeat);
    const changed = await postCalendar(origin, token, calendar(calendarEvent("override-uid", "990123", "20300122T150000Z")));
    expect(changed.status).toBe(200);
    const smaller = await postCalendar(origin, token, calendar());
    expect(smaller.status).toBe(200);
    expect(await smaller.json()).toMatchObject({ added: 0, removed: 0 });
    document = JSON.parse(await readFile(file, "utf8")) as { items: Array<Record<string, unknown>> };
    expect(document.items.find((item) => item.id === importedId)).toMatchObject({
      id: importedId, done: true, notesExtension: { keep: "local" }, grade: "A", score: 99, at: "2030-01-22T15:00:00.000Z",
    });
    const dashboard = await fetch(`${origin}/api/dashboard`).then((response) => response.json()) as {
      events: Array<{ sourceItemId: string }>; refreshes: Array<{ summary: { removed: number } }>;
      sourceStatus: { inbox: string }; icalFeedStatus: { acquisition: string; coverage: string; accepted: number };
    };
    expect(dashboard.events.some((event) => event.sourceItemId === importedId)).toBe(true);
    expect(dashboard.refreshes.some((entry) => entry.summary.removed !== 0)).toBe(false);
    expect(dashboard.icalFeedStatus).toMatchObject({ acquisition: "succeeded", coverage: "rolling_window", accepted: 0 });
    expect(dashboard.sourceStatus.inbox).toBe("not_synced");
    expect(await readFile(file, "utf8")).not.toContain("synthetic-private-uid-sentinel");
    expect(await readFile(file, "utf8")).not.toContain("synthetic-url-sentinel");
    expect(stderr()).not.toContain("synthetic-private-uid-sentinel");
    expect(stderr()).not.toContain("synthetic-url-sentinel");
  });

  it("keeps calendar import disabled by default and rejects read-only, missing CSRF, and source options", async () => {
    const defaultServer = await start();
    const defaultToken = await csrfToken(defaultServer.origin);
    expect((await postCalendar(defaultServer.origin, defaultToken, calendar())).status).toBe(405);
    const readOnly = await start(false, { icalImport: true, readOnly: true });
    const readOnlyToken = await csrfToken(readOnly.origin);
    expect((await postCalendar(readOnly.origin, readOnlyToken, calendar())).status).toBe(405);
    const enabled = await start(false, { icalImport: true });
    const missingCsrf = await fetch(`${enabled.origin}/api/local/ical-import`, {
      method: "POST", headers: { "Content-Type": "text/calendar" }, body: calendar(),
    });
    expect(missingCsrf.status).toBe(403);
    const token = await csrfToken(enabled.origin);
    expect((await postCalendar(enabled.origin, token, calendar(), "?origin=https://elsewhere.invalid")).status).toBe(400);
    const jsonOptions = await fetch(`${enabled.origin}/api/local/ical-import`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-duegood-csrf-token": token },
      body: JSON.stringify({ url: "https://elsewhere.invalid/private-feed", course: "course-a" }),
    });
    expect(jsonOptions.status).toBe(400);
    expect((await readFile(enabled.file, "utf8"))).not.toContain("elsewhere.invalid");
  });

  it("records content-free acquisition failure without changing coursework or leaking source text", async () => {
    const { origin, file, stderr } = await start(false, { icalImport: true });
    const token = await csrfToken(origin);
    expect((await postCalendar(origin, token, calendar(calendarEvent("prior-success", "990123")))).status).toBe(200);
    const successfulStatus = (await fetch(`${origin}/api/dashboard`).then((result) => result.json()) as {
      icalFeedStatus: { lastSuccessAt: string };
    }).icalFeedStatus;
    const before = await readFile(file, "utf8");
    const invalid = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic-private-error-sentinel";
    const response = await postCalendar(origin, token, invalid);
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private-error-sentinel");
    expect(await readFile(file, "utf8")).toBe(before);
    const dashboard = await fetch(`${origin}/api/dashboard`).then((result) => result.json()) as {
      icalFeedStatus: { acquisition: string; coverage: string; lastSuccessAt: string | null }; sourceStatus: { inbox: string };
    };
    expect(dashboard.icalFeedStatus).toMatchObject({ acquisition: "failed", coverage: "rolling_window", lastSuccessAt: successfulStatus.lastSuccessAt });
    expect(dashboard.sourceStatus.inbox).toBe("not_synced");
    expect(stderr()).not.toContain("synthetic-private-error-sentinel");
  });

  it("rejects oversized calendar input without storing source bytes", async () => {
    const { origin, file, stderr } = await start(false, { icalImport: true });
    const token = await csrfToken(origin);
    const before = await readFile(file, "utf8");
    const response = await postCalendar(origin, token, `BEGIN:VCALENDAR\r\nX-SECRET:synthetic-size-sentinel${"x".repeat(5 * 1024 * 1024)}\r\nEND:VCALENDAR\r\n`);
    expect(response.status).toBe(413);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-size-sentinel");
    expect(stderr()).not.toContain("synthetic-size-sentinel");
  });

  it("does not stream a local resource directory", async () => {
    const { origin, file } = await start();
    const root = path.dirname(file);
    const exportRoot = path.join(root, "classes", "synthetic-course-a", "canvas-export");
    await mkdir(path.join(exportRoot, "api"), { recursive: true });
    await mkdir(path.join(root, "classes", "synthetic-course-a", "materials", "directory-resource"), { recursive: true });
    await writeFile(path.join(exportRoot, "download-manifest.json"), JSON.stringify([{ id: 1, filename: "directory-resource", status: "downloaded" }]));
    await writeFile(path.join(exportRoot, "api", "files.json"), JSON.stringify([{ id: 1, display_name: "Directory resource", filename: "directory-resource", size: 0 }]));
    const dashboard = await fetch(`${origin}/api/dashboard`).then((response) => response.json()) as { resources: Array<{ id: string; openPath: string | null }> };
    expect(dashboard.resources).toContainEqual(expect.objectContaining({ id: "course-a:file:1", openPath: "/api/local/resources/course-a%3Afile%3A1" }));
    const response = await fetch(`${origin}/api/local/resources/course-a%3Afile%3A1`);
    expect(response.status).toBe(404);
  });
});
