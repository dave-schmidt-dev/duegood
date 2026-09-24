/**
 * Parity between the desktop and browser dashboards. The desktop webview runs the shared projection
 * (`src/shared/dashboard-projection.ts`) over the raw documents the Rust store returns; the browser
 * build gets `/api/dashboard` from the loopback server. Over the same synthetic legacy tree, the
 * shared projection with browser options must equal the served body exactly, and the native options
 * may differ only in the documented fields (refresh availability, resource open paths, avatar,
 * source label, and the source detail's Inbox wording).
 *
 * The Rust test `documents::tests::bundle_matches_the_fixed_name_documents_of_the_imported_fixture`
 * proves the native bundle carries these exact bytes; this file builds the same bundle from the
 * materialized fixture with the same rules and checks the projection side. Synthetic data only; the
 * only network use is the loopback server this test starts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_RESOURCE_PREFIX,
  projectDashboardDocuments,
  type CourseExportTexts,
  type DashboardBody,
  type DashboardDocumentBundle,
} from "../../src/shared/dashboard-projection";
import { IMPORT_PHASES, nativeProjectionOptions, parseDocumentBundle } from "../../src/ui/transport";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface FixtureEntry {
  readonly path: string;
  readonly json?: Json;
  readonly text?: string;
  readonly hex?: string;
  readonly symlink?: string;
  readonly jsonRepeat?: { readonly count: number; readonly template: Json };
}

const FIXTURE = path.resolve("test/fixtures/tauri-legacy-source.json");
const AVATAR_HEAD_BYTES = 16;

/** `{n}` inside strings becomes `n`; the exact string `{n#}` becomes the number `n`. */
function instantiate(template: Json, n: number): Json {
  if (template === "{n#}") return n;
  if (typeof template === "string") return template.replaceAll("{n}", String(n));
  if (Array.isArray(template)) return template.map((item) => instantiate(item, n));
  if (template !== null && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, instantiate(value, n)]));
  return template;
}

/** Same rules as `testutil::materialize_fixture` in `src-tauri/src/lib.rs`. */
async function materialize(root: string): Promise<void> {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as { entries: FixtureEntry[] };
  for (const entry of fixture.entries) {
    if (entry.path.startsWith("/") || entry.path.includes("..")) throw new Error("fixture paths stay inside");
    const target = path.join(root, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    if (entry.json !== undefined) await writeFile(target, `${JSON.stringify(entry.json, null, 2)}\n`);
    else if (entry.text !== undefined) await writeFile(target, entry.text);
    else if (entry.hex !== undefined) await writeFile(target, Buffer.from(entry.hex, "hex"));
    else if (entry.jsonRepeat !== undefined) {
      const { count, template } = entry.jsonRepeat;
      await writeFile(target, `${JSON.stringify(Array.from({ length: count }, (_, index) => instantiate(template, index + 1)), null, 2)}\n`);
    } else if (entry.symlink !== undefined) await symlink(entry.symlink, target);
    else throw new Error(`unknown fixture entry kind for ${entry.path}`);
  }
}

async function optionalText(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

/** Builds the `read_dashboard_documents` bundle with the Rust reader's rules (`src-tauri/src/documents.rs`). */
async function documentBundle(root: string): Promise<DashboardDocumentBundle> {
  const coursework = await readFile(path.join(root, "coursework.json"));
  const profile = await optionalText(path.join(root, "canvas-profile.json"));
  let avatar: DashboardDocumentBundle["avatar"] = null;
  const avatarName = (() => { try { return (JSON.parse(profile ?? "null") as { avatar?: { path?: unknown } } | null)?.avatar?.path; } catch { return undefined; } })();
  if (typeof avatarName === "string" && avatarName.length > 0 && avatarName !== "." && avatarName !== ".." && !avatarName.includes("/")) {
    const file = path.join(root, avatarName);
    const metadata = await lstat(file).catch(() => null);
    if (metadata?.isFile() === true) {
      const handle = await open(file, "r");
      try {
        const head = Buffer.alloc(AVATAR_HEAD_BYTES);
        const { bytesRead } = await handle.read(head, 0, AVATAR_HEAD_BYTES, 0);
        avatar = { sizeBytes: metadata.size, head: [...head.subarray(0, bytesRead)] };
      } finally {
        await handle.close();
      }
    }
  }
  const courseExports: Record<string, CourseExportTexts> = {};
  const folders = (await readdir(path.join(root, "classes"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    const base = path.join(root, "classes", folder, "canvas-export");
    courseExports[folder] = {
      files: await optionalText(path.join(base, "api", "files.json")),
      pages: await optionalText(path.join(base, "api", "pages.json")),
      modules: await optionalText(path.join(base, "api", "modules.json")),
      announcements: await optionalText(path.join(base, "api", "announcements.json")),
      downloadManifest: await optionalText(path.join(base, "download-manifest.json")),
    };
  }
  return {
    storeState: "preview",
    coursework: { text: new TextDecoder().decode(coursework), version: createHash("sha256").update(coursework).digest("hex") },
    refreshHistory: await optionalText(path.join(root, "coursework-refresh-history.json")),
    conversations: await optionalText(path.join(root, "canvas-conversations.json")),
    profile,
    avatar,
    courseExports,
  };
}

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

async function serve(courseworkFile: string): Promise<{ origin: string; child: ChildProcess }> {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const child = spawn(process.execPath, [path.resolve("dist/local/server.mjs"), "--coursework", courseworkFile, "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr?.on("data", (chunk) => { errors += String(chunk); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local server exited early: ${errors}`);
    try {
      if ((await fetch(`${origin}/health`)).ok) return { origin, child };
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGTERM");
  throw new Error(`local server did not become ready: ${errors}`);
}

const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let directory = "";
let child: ChildProcess | undefined;
let served: DashboardBody;
let bundle: DashboardDocumentBundle;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "duegood-parity-"));
  const root = path.join(directory, "legacy");
  await materialize(root);
  bundle = await documentBundle(root);
  const server = await serve(path.join(root, "coursework.json"));
  child = server.child;
  const response = await fetch(`${server.origin}/api/dashboard`);
  expect(response.status).toBe(200);
  served = await response.json() as DashboardBody;
});

afterAll(async () => {
  if (child !== undefined && child.exitCode === null) child.kill("SIGTERM");
  if (directory.length > 0) await rm(directory, { recursive: true, force: true });
});

describe("shared dashboard projection parity", () => {
  it("equals the browser server's /api/dashboard body with browser options", () => {
    const projected = projectDashboardDocuments(bundle, {
      resourceOpenPrefix: LOCAL_RESOURCE_PREFIX,
      avatarPath: "/api/local/profile/avatar",
      refreshAvailable: served.refreshAvailable,
      sourceLabel: "Local Marymount source",
      dataOrigin: "live",
    });
    expect(normalize(projected)).toStrictEqual(served);
    // The fixture's Inbox is complete; the live browser source may say so.
    expect(served.sourceStatus.inbox).toBe("synced");
    expect(projected.sourceStatus.detail).toContain("Inbox synced");
  });

  it("differs over the native documents only in the documented desktop fields", () => {
    const native = normalize(projectDashboardDocuments(parseDocumentBundle(normalize(bundle)), nativeProjectionOptions("preview")));
    expect(native.refreshAvailable).toBe(false);
    expect(native.sourceStatus.label).toBe("Desktop preview copy");
    expect(native.profile).toEqual({ displayName: served.profile?.displayName });
    expect(native.resources.every((resource) => resource.openPath === null)).toBe(true);
    expect(native.resources.map((resource) => resource.savedLocally === true)).toEqual(served.resources.map((resource) => resource.openPath !== null));
    expect(native.resources.filter((resource) => resource.savedLocally === true).length).toBeGreaterThan(0);
    // A preview copy never refreshes, so its visible status never claims a sync, even though the
    // imported Inbox document was complete.
    expect(native.sourceStatus.detail).toBe(served.sourceStatus.detail.replace("Inbox synced", "Inbox imported"));
    expect(native.sourceStatus.detail).toContain("Inbox imported");
    expect(native.sourceStatus.label).not.toMatch(/synced/i);
    expect(native.sourceStatus.detail).not.toMatch(/synced/i);

    const aligned = {
      ...native,
      resources: native.resources.map((resource, index) => { const aligned: Record<string, unknown> = { ...resource, openPath: served.resources[index]?.openPath ?? null }; delete aligned.savedLocally; return aligned; }),
      profile: served.profile,
      refreshAvailable: served.refreshAvailable,
      sourceStatus: { ...native.sourceStatus, label: served.sourceStatus.label, detail: served.sourceStatus.detail },
    };
    expect(aligned).toStrictEqual(served);
  });

  it("covers the resource cap, locale sort, Activity detail formatting, conversation normalization, and the profile", () => {
    expect(served.version).toMatch(/^[0-9a-f]{64}$/);
    expect(served.version).toBe(bundle.coursework.version);

    // Resource cap: the Library keeps the first 2,000 items in course order, then sorts.
    expect(served.resources).toHaveLength(2_000);
    expect(served.resources.some((resource) => resource.title === "Lab moved")).toBe(false);
    expect(served.resources.filter((resource) => resource.courseCode === "SYN 101" && resource.type === "File")).toHaveLength(1_000);
    // Locale-aware title order among same-day pages.
    const pages = served.resources.filter((resource) => resource.type === "Page").map((resource) => resource.title);
    expect(pages).toEqual(["ábaco basics", "apple notes", "Élan vital", "Zebra crossings"]);
    const opened = served.resources.filter((resource) => resource.openPath !== null).map((resource) => resource.id);
    expect(opened.sort()).toEqual(["syn-101:file:1", "syn-101:file:2"]);

    // Activity: field changes are formatted, Inbox changes are merged, and newest comes first.
    expect(served.refreshes.map((refresh) => refresh.id)).toEqual(["inbox-2026-09-20T12:05:00Z", "refresh-2", "refresh-1", "refresh-3"]);
    const quiz = served.refreshes.find((refresh) => refresh.id === "refresh-1")?.changes.find((change) => change.title === "Quiz one")?.detail ?? "";
    for (const part of ["Submission: Not submitted → Graded", "Assignment group weight: Unavailable → 60.5%", "Score: Unavailable → 9.5", "futureField: x → y", "Grade: Unavailable → A", "Graded at: not a date → "]) expect(quiz).toContain(part);
    expect(served.refreshes.find((refresh) => refresh.id === "refresh-1")?.changes.map((change) => change.title)).toContain("Spaced title");
    expect(served.refreshes.find((refresh) => refresh.id === "refresh-2")?.status).toBe("partial");
    expect(served.refreshes[0]?.changes.map((change) => change.detail)).toContain("Canvas inbox thread no longer appears in the inbox.");

    // Conversations: invalid rows are skipped, whitespace collapses, counts are clamped.
    expect(served.conversations.map((conversation) => [conversation.canvasConversationId, conversation.subject, conversation.messageCount])).toEqual([["c-2", "Lab schedule", 100_000], ["c-1", "Question about essay", 2], ["c-4", "Older thread", 0]]);
    expect(served.conversations.find((conversation) => conversation.canvasConversationId === "c-1")?.participants).toEqual([{ canvasUserId: "u-1", name: "Synthetic Instructor" }]);

    // Profile: control characters removed, whitespace collapsed, avatar signature validated.
    expect(served.profile).toEqual({ displayName: "Synthetic Learner", avatarPath: "/api/local/profile/avatar" });
  });

  it("keeps the webview's import phases in step with the Rust ImportPhase enum", async () => {
    const source = await readFile(path.resolve("src-tauri/src/import.rs"), "utf8");
    const body = /pub enum ImportPhase \{([^}]*)\}/.exec(source)?.[1] ?? "";
    const variants = [...body.matchAll(/^\s*([A-Z][A-Za-z]*),?\s*$/gm)].map((match) => (match[1] ?? "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase());
    expect(variants).toEqual([...IMPORT_PHASES]);
  });
});
