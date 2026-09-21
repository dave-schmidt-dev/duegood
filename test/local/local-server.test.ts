import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

async function start(includeDiscussion = false): Promise<{ origin: string; file: string; port: number; child: ChildProcess }> {
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
  const child = spawn(process.execPath, [path.resolve("dist/local/server.mjs"), "--coursework", file, "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let errors = "";
  child.stderr?.on("data", (chunk) => { errors += String(chunk); });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local server exited early: ${errors}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return { origin, file, port, child };
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

describe("local server", () => {
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
