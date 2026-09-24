import { execFile, spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import mockFixtureJson from "../fixtures/refresh-canvas-mock.json";
import expectedFixtureJson from "../fixtures/refresh-expected-store.json";
import { CourseworkStore } from "../../src/local/coursework-store";
import { DashboardStore } from "../../src/local/dashboard-store";
import { RefreshMockServer, type RefreshContractFixture, type RefreshMockOptions, type RefreshMockRequest } from "./refresh-mock-server";

type JsonObject = Record<string, unknown>;
type RefreshTestFixture = RefreshContractFixture & { priorLocalState: Record<string, unknown> };

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = mockFixtureJson as unknown as RefreshTestFixture;
const EXPECTED = expectedFixtureJson as unknown as JsonObject;
const runFile = promisify(execFile);
const SYNTHETIC_TOKEN = "synthetic-test-token";
const TEST_BUNDLE_ID = "com.zerodelta.duegood.test";
const TEST_MANIFEST = {
  format: "duegood-store",
  version: 1,
  state: "authoritative",
  createdAt: "2026-09-23T00:00:00Z",
  importedAt: "2026-09-23T00:00:00Z",
  source: { kind: "synthetic-test", files: 1, bytes: 1, treeDigest: "0".repeat(64) },
};

const roots: string[] = [];
const servers: RefreshMockServer[] = [];

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  throw new Error("invalid synthetic fixture object");
}

function objectArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error("invalid synthetic fixture array");
  return value.map(asObject);
}

type TestRoot = { parent: string; dataRoot: string; storeDir: string };

async function createTestRoot(state: "authoritative" | "preview" = "authoritative"): Promise<TestRoot> {
  const parent = await mkdtemp(path.join(tmpdir(), "duegood-refresh-test-"));
  roots.push(parent);
  const dataRoot = path.join(parent, TEST_BUNDLE_ID);
  const storeDir = path.join(dataRoot, "store");
  await mkdir(storeDir, { recursive: true, mode: 0o700 });

  const coursework = structuredClone(FIXTURE.priorLocalState["coursework.json"]) as JsonObject;
  const courseScopes = {
    courses: FIXTURE.courses.map((course) => ({ key: course.key, canvasId: Number(course.canvasCourseId) })),
  };
  const manifest = { ...TEST_MANIFEST, state };
  await writeFile(path.join(storeDir, "duegood-store.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(storeDir, "coursework.json"), `${JSON.stringify(coursework, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(storeDir, "courses.json"), `${JSON.stringify(courseScopes, null, 2)}\n`, { mode: 0o600 });
  for (const course of FIXTURE.courses) {
    const courseRoot = path.join(storeDir, course.folder, "canvas-export", "api");
    await mkdir(courseRoot, { recursive: true, mode: 0o700 });
    const sourceCourse = FIXTURE.apiResponses[course.key]?.course.body;
    await writeFile(path.join(courseRoot, "course.json"), `${JSON.stringify(sourceCourse, null, 2)}\n`, { mode: 0o600 });
  }
  return { parent, dataRoot, storeDir };
}

async function startMock(options: RefreshMockOptions = {}): Promise<RefreshMockServer> {
  const server = await new RefreshMockServer(FIXTURE, options).listen();
  servers.push(server);
  return server;
}

function helperPath(): string {
  const override = process.env.DUEGOOD_REFRESH_HELPER_BIN;
  if (override) return path.resolve(override);
  const suffix = process.platform === "win32" ? ".exe" : "";
  return path.join(ROOT, "src-tauri", "target", "debug", `duegood-refresh${suffix}`);
}

async function runHelper(dataRoot: string, origin: string, timeoutMs = 90_000): Promise<{ code: number | null; stdout: string; stderr: string; argv: string[] }> {
  const executable = helperPath();
  await access(executable);
  const argv: string[] = [];
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? tmpdir(),
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        TEMP: process.env.TEMP ?? tmpdir(),
        SystemRoot: process.env.SystemRoot ?? "",
        DUEGOOD_TEST_DATA_ROOT: dataRoot,
        DUEGOOD_TEST_CANVAS_ORIGIN: origin,
        CANVAS_API_TOKEN: SYNTHETIC_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, argv });
    });
  });
}

async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        result[`${relative}/`] = "directory";
        await walk(absolute);
      } else if (entry.isFile()) {
        result[relative] = await readFile(absolute, { encoding: "base64" });
      } else {
        result[relative] = `special:${entry.isSymbolicLink() ? "symlink" : "other"}`;
      }
    }
  }
  await walk(root);
  return result;
}

async function readStoreJson<T = JsonObject>(storeDir: string, name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(storeDir, name), "utf8")) as T;
}

async function assertNodeExportParity(root: TestRoot): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), "duegood-refresh-export-"));
  roots.push(temporary);
  const legacySource = path.join(temporary, "legacy-source");
  const destination = path.join(temporary, "destination");
  await mkdir(legacySource);
  await mkdir(destination);
  await cp(root.storeDir, legacySource, {
    recursive: true,
    filter: (source) => path.basename(source) !== "duegood-store.json",
  });
  await runFile("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--features", "test-overrides", "--", "--ignored", "export_fixture_helper"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      TEMP: process.env.TEMP ?? tmpdir(),
      SystemRoot: process.env.SystemRoot ?? "",
      DUEGOOD_EXPORT_TEST_SOURCE: legacySource,
      DUEGOOD_EXPORT_TEST_DESTINATION: destination,
    },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const exportedFolders = await readdir(path.join(destination, "exports"));
  expect(exportedFolders).toHaveLength(1);
  const exported = path.join(destination, "exports", exportedFolders[0]!);
  const sourceCoursework = path.join(root.storeDir, "coursework.json");
  const exportedCoursework = path.join(exported, "coursework.json");
  const [sourceSnapshot, exportedSnapshot] = await Promise.all([
    new CourseworkStore(sourceCoursework).read(),
    new CourseworkStore(exportedCoursework).read(),
  ]);
  expect(exportedSnapshot).toStrictEqual(sourceSnapshot);
  const [sourceResources, exportedResources] = await Promise.all([
    new DashboardStore(sourceCoursework).resources(sourceSnapshot.courses),
    new DashboardStore(exportedCoursework).resources(exportedSnapshot.courses),
  ]);
  expect(exportedResources).toStrictEqual(sourceResources);
}

function apiRequests(server: RefreshMockServer): RefreshMockRequest[] {
  return server.requests.filter((request) => request.path.startsWith("/api/"));
}

function downloadRequests(server: RefreshMockServer): RefreshMockRequest[] {
  return server.requests.filter((request) => request.path.startsWith("/files/") || request.path.startsWith("/objects/") || request.path.startsWith("/images/"));
}

function assertNoMutationsOrDownloadCredentials(server: RefreshMockServer): void {
  expect(server.errors).toEqual([]);
  expect(server.requests.filter((request) => request.method !== "GET")).toEqual([]);
  expect(downloadRequests(server).filter((request) => request.authorization !== null)).toEqual([]);
  expect(apiRequests(server).every((request) => request.authorization === `Bearer ${SYNTHETIC_TOKEN}`)).toBe(true);
}

function courseProjection(coursework: JsonObject): unknown {
  const itemProjection = (items: unknown) => objectArray(items).map((item) => ({
    id: item.id,
    course: item.course,
    kind: item.kind,
    title: item.title,
    at: item.at,
    points: item.points,
    source: item.source,
    canvasId: item.canvasId,
    done: item.done,
    doneAt: item.doneAt,
    submissionStatus: item.submissionStatus,
    submittedAt: item.submittedAt,
    gradedAt: item.gradedAt,
    grade: item.grade,
    score: item.score,
  }));
  return {
    courses: objectArray(coursework.courses).map((course) => ({
      key: course.key,
      code: course.code,
      folder: course.folder,
      gradeGroups: course.gradeGroups,
      ignoredCanvasAssignmentIds: course.ignoredCanvasAssignmentIds,
    })),
    items: itemProjection(coursework.items),
    archivedForecastItems: itemProjection(coursework.archivedForecastItems ?? []),
  };
}

function expectedCourseProjection(): unknown {
  const expected = asObject(EXPECTED["coursework.json"]);
  return courseProjection(expected);
}

function parseJsonLines(output: string): JsonObject[] {
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value) ? [value as JsonObject] : [];
    } catch {
      return [];
    }
  });
}

async function cleanUp(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

afterEach(cleanUp);

describe("test-overrides duegood-refresh helper", () => {
  it("captures and commits the synthetic expected coursework and local documents", async () => {
    const root = await createTestRoot();
    const server = await startMock();
    const result = await runHelper(root.dataRoot, server.origin);

    expect(result.argv).toEqual([]);
    const messages = parseJsonLines(result.stdout);
    const progressPhases = messages
      .filter((message) => message.type === "progress")
      .map((message) => typeof message.phase === "string" ? message.phase : "unknown");
    expect(result.code, `progressPhases=${progressPhases.join(",")}; apiRequestCount=${apiRequests(server).length}`).toBe(0);
    const final = messages.findLast((message) => message.type === "result");
    expect(final).toMatchObject({ type: "result", status: expect.any(String), updatedAt: expect.any(String) });

    const actualCoursework = await readStoreJson<JsonObject>(root.storeDir, "coursework.json");
    expect(courseProjection(actualCoursework)).toEqual(expectedCourseProjection());
    const expectedCourses = asObject(EXPECTED["perCourse"]);
    const expectedAlpha = asObject(expectedCourses["demo-alpha"]);
    expect(await readStoreJson(root.storeDir, "classes/demo-alpha/canvas-export/api/course.json"))
      .toEqual(expectedAlpha["canvas-export/api/course.json"]);
    expect(await readStoreJson(root.storeDir, "classes/demo-alpha/canvas-export/api/modules.json"))
      .toEqual(expectedAlpha["canvas-export/api/modules.json"]);
    expect(await readStoreJson(root.storeDir, "classes/demo-alpha/canvas-export/download-manifest.json"))
      .toEqual(expectedAlpha["canvas-export/download-manifest.json"]);
    expect(await readFile(path.join(root.storeDir, "classes/demo-alpha/materials/501-syllabus-2026.pdf")))
      .toEqual(Buffer.from("SYNTHETIC-PDF-PLACEHOLDER", "ascii"));
    const conversations = await readStoreJson<JsonObject>(root.storeDir, "canvas-conversations.json");
    expect(conversations).toMatchObject({ schema: 1, complete: true, conversations: expect.any(Array) });
    const profile = await readStoreJson<JsonObject>(root.storeDir, "canvas-profile.json");
    expect(profile).toMatchObject({ name: "Sam Rivera (Synthetic)", short_name: "Sam R.", avatar: expect.objectContaining({ contentType: "image/png" }) });
    expect(server.requests.some((request) => request.path.includes("auto_mark_as_read=false"))).toBe(true);
    expect(server.requests.some((request) => request.path.includes("page=2"))).toBe(true);
    expect(server.requests.some((request) => request.path.startsWith("/files/501/download?verifier=syn-abc123"))).toBe(true);
    expect(server.requests.some((request) => request.path.startsWith("/objects/501/download"))).toBe(true);
    expect(messages.some((message) => message.type === "progress")).toBe(true);
    expect(result.stdout).not.toContain(SYNTHETIC_TOKEN);
    expect(result.stderr).not.toContain(SYNTHETIC_TOKEN);
    await assertNodeExportParity(root);
    assertNoMutationsOrDownloadCredentials(server);
  }, 240_000);

  it("rejects an off-prefix pagination link before requesting its target", async () => {
    const root = await createTestRoot();
    const server = await startMock({ pagination: { courseId: "9101", target: "off-prefix" } });
    const before = await treeSnapshot(root.storeDir);
    const result = await runHelper(root.dataRoot, server.origin);

    expect(result.code).not.toBe(0);
    expect(server.requests.some((request) => request.path.startsWith("/api/v1/accounts/"))).toBe(false);
    expect(await treeSnapshot(root.storeDir)).toEqual(before);
    assertNoMutationsOrDownloadCredentials(server);
  });

  it("rejects a cross-origin pagination link without contacting the other loopback listener", async () => {
    const root = await createTestRoot();
    const foreign = await startMock();
    const target = `${foreign.origin}/api/v1/courses/9101/modules?page=2`;
    const server = await startMock({ pagination: { courseId: "9101", target } });
    const before = await treeSnapshot(root.storeDir);
    const result = await runHelper(root.dataRoot, server.origin);

    expect(result.code).not.toBe(0);
    expect(foreign.requests).toEqual([]);
    expect(await treeSnapshot(root.storeDir)).toEqual(before);
    assertNoMutationsOrDownloadCredentials(server);
  });

  it("rejects a download redirect to a different host before sending any request there", async () => {
    const root = await createTestRoot();
    const foreign = await startMock();
    const server = await startMock({ download: "foreign-redirect", foreignOrigin: foreign.origin });
    const before = await treeSnapshot(root.storeDir);
    const result = await runHelper(root.dataRoot, server.origin);

    expect(result.code).not.toBe(0);
    expect(foreign.requests).toEqual([]);
    expect(await treeSnapshot(root.storeDir)).toEqual(before);
    assertNoMutationsOrDownloadCredentials(server);
  });

  it("rejects oversized download bodies without committing captured files or coursework", async () => {
    const root = await createTestRoot();
    const server = await startMock({ download: "oversized" });
    const before = await treeSnapshot(root.storeDir);
    const result = await runHelper(root.dataRoot, server.origin);

    expect(result.code).not.toBe(0);
    expect(server.requests.some((request) => request.path.startsWith("/objects/501/"))).toBe(true);
    expect(await treeSnapshot(root.storeDir)).toEqual(before);
    assertNoMutationsOrDownloadCredentials(server);
  });

  it("refuses a preview store before making any Canvas request", async () => {
    const root = await createTestRoot("preview");
    const server = await startMock();
    const before = await treeSnapshot(root.storeDir);
    const result = await runHelper(root.dataRoot, server.origin);

    expect(result.code).not.toBe(0);
    expect(server.requests).toEqual([]);
    expect(await treeSnapshot(root.storeDir)).toEqual(before);
  });

  it("leaves the store unchanged when one course request fails after capture starts", async () => {
    const root = await createTestRoot();
    const server = await startMock({ failPath: "/api/v1/courses/9202/assignments", failStatus: 503 });
    const before = await treeSnapshot(root.storeDir);
    const result = await runHelper(root.dataRoot, server.origin);

    expect(result.code).not.toBe(0);
    expect(server.requests.some((request) => request.path.startsWith("/api/v1/courses/9202/assignments"))).toBe(true);
    expect(await treeSnapshot(root.storeDir)).toEqual(before);
    assertNoMutationsOrDownloadCredentials(server);
  });

  it("continues Inbox after a detail 503 and records an incomplete refresh without removals", async () => {
    const root = await createTestRoot();
    const coursework = await readStoreJson<JsonObject>(root.storeDir, "coursework.json");
    if (!Array.isArray(coursework.items)) throw new Error("synthetic coursework items are missing");
    coursework.items.push({
      id: "demo-alpha-canvas-79999",
      course: "demo-alpha",
      kind: "assignment",
      title: "Synthetic assignment absent from this capture",
      at: "2026-12-20T23:59",
      source: "canvas",
      canvasId: 79999,
      done: false,
      doneAt: null,
    });
    await writeFile(path.join(root.storeDir, "coursework.json"), `${JSON.stringify(coursework, null, 2)}\n`, { mode: 0o600 });

    const priorMessages = [{
      canvasMessageId: "77001-prior",
      authorId: "9500",
      author: "Synthetic instructor",
      createdAt: "2026-11-25T15:00:00.000Z",
      body: "Preserved prior synthetic detail",
      bodyTruncated: false,
      attachments: [],
    }];
    const priorConversation = {
      canvasConversationId: "77001",
      contextLabel: "Demo Alpha Seminar",
      subject: "Prior synthetic subject",
      participants: [{ canvasUserId: "9500", name: "Synthetic instructor" }],
      latestMessagePreview: "Prior synthetic preview",
      latestMessageAt: "2026-11-25T15:00:00.000Z",
      unread: true,
      starred: false,
      messageCount: 1,
      messages: priorMessages,
      historyComplete: true,
      safetyTruncated: false,
      attachments: [],
    };
    await writeFile(path.join(root.storeDir, "canvas-conversations.json"), `${JSON.stringify({
      schema: 1,
      generatedAt: "2026-11-25T15:00:00.000Z",
      complete: true,
      rejected: 0,
      conversations: [priorConversation],
      changes: { added: [], changed: [], removed: [] },
    }, null, 2)}\n`, { mode: 0o600 });

    const server = await startMock({ detailFailureIds: ["77001"], inboxAdditionalId: "77002" });
    const result = await runHelper(root.dataRoot, server.origin);
    const messages = parseJsonLines(result.stdout);
    const final = messages.findLast((message) => message.type === "result");
    const progressPhases = messages
      .filter((message) => message.type === "progress")
      .map((message) => typeof message.phase === "string" ? message.phase : "unknown");
    expect(final, `helperExit=${result.code}; progressPhases=${progressPhases.join(",")}; apiRequestCount=${apiRequests(server).length}; mockErrors=${server.errors.length}`)
      .toMatchObject({ type: "result", status: "incomplete", updatedAt: expect.any(String) });
    expect(result.code).toBe(0);

    const detailIds = server.requests
      .filter((request) => request.path.startsWith("/api/v1/conversations/"))
      .map((request) => request.path.match(/^\/api\/v1\/conversations\/(\d+)/)?.[1]);
    expect(detailIds.length).toBeGreaterThan(1);
    expect(detailIds[0]).toBe("77001");
    expect(detailIds.at(-1)).toBe("77002");
    expect(detailIds.slice(0, -1).every((id) => id === "77001")).toBe(true);

    const conversations = await readStoreJson<JsonObject>(root.storeDir, "canvas-conversations.json");
    expect(conversations).toMatchObject({ complete: false, rejected: 1, changes: { removed: [] } });
    const conversationRows = objectArray(conversations.conversations);
    const failedConversation = conversationRows.find((row) => row.canvasConversationId === "77001");
    expect(failedConversation).toMatchObject({ historyComplete: false, detailCaptureIncomplete: true, messages: priorMessages });
    expect(conversationRows.some((row) => row.canvasConversationId === "77002")).toBe(true);

    const committedCoursework = await readStoreJson<JsonObject>(root.storeDir, "coursework.json");
    const committedItems = objectArray(committedCoursework.items);
    expect(committedItems.some((item) => item.id === "demo-alpha-canvas-79999")).toBe(true);
    expect(committedItems.some((item) => item.id === "demo-alpha-forecast-1")).toBe(true);
    expect(objectArray(committedCoursework.archivedForecastItems ?? []).some((item) => item.id === "demo-alpha-forecast-1")).toBe(false);
    const history = await readStoreJson<JsonObject>(root.storeDir, "coursework-refresh-history.json");
    const event = objectArray(history.events).at(-1);
    expect(event).toMatchObject({ status: "incomplete", sourceComplete: false, summary: { removed: 0 } });
    expect(objectArray(event?.changes).some((change) => change.kind === "removed")).toBe(false);
    assertNoMutationsOrDownloadCredentials(server);
  }, 30_000);

  it("preserves a personal completion write made while Canvas capture is in flight", async () => {
    const root = await createTestRoot();
    const server = await startMock({ pauseFirstApiRequest: true });
    const resultPromise = runHelper(root.dataRoot, server.origin);
    const firstSignal = await Promise.race([
      server.waitForRequest((request) => request.path.startsWith("/api/"), 30_000).then(() => "request" as const),
      resultPromise.then(() => "helper-exited" as const),
    ]);
    if (firstSignal !== "request") {
      server.releaseFirstApiRequest();
      const result = await resultPromise;
      throw new Error(`helper exited (${result.code}) before its first Canvas API request`);
    }
    const courseworkPath = path.join(root.storeDir, "coursework.json");
    const personalUpdate = await readStoreJson<JsonObject>(root.storeDir, "coursework.json");
    const item = objectArray(personalUpdate.items).find((entry) => entry.id === "demo-alpha-70001");
    if (!item) throw new Error("synthetic completion item is missing");
    item.done = true;
    item.doneAt = "2026-09-23T12:34:56Z";
    const temporaryWrite = `${courseworkPath}.synthetic-write`;
    await writeFile(temporaryWrite, `${JSON.stringify(personalUpdate, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryWrite, courseworkPath);
    server.releaseFirstApiRequest();
    const result = await resultPromise;

    const committed = await readStoreJson<JsonObject>(root.storeDir, "coursework.json");
    const preserved = objectArray(committed.items).find((entry) => entry.id === "demo-alpha-70001");
    if (!preserved) throw new Error("refreshed completion item is missing");
    expect(preserved.done).toBe(true);
    expect(preserved.doneAt).toBe("2026-09-23T12:34:56Z");
    expect(preserved.title).toBe("Draft Essay v2");
    expect(result.code).toBe(0);
    const history = await readStoreJson<JsonObject>(root.storeDir, "coursework-refresh-history.json");
    const event = objectArray(history.events).at(-1);
    expect(event).toMatchObject({ personalStateReapplied: true, notice: "personal_state_reapplied" });
    expect(objectArray(event?.changes)[0]).toMatchObject({
      kind: "notice",
      title: "Personal progress kept",
      detail: "Changes made during this refresh were preserved.",
    });
    assertNoMutationsOrDownloadCredentials(server);
  }, 30_000);
});
