import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CourseworkStore } from "../src/local/coursework-store.ts";
import { DashboardStore } from "../src/local/dashboard-store.ts";
import { superviseIcalFetch, superviseRefresh } from "../src/local/refresh-supervisor.ts";
import { captureCanvasSnapshot, readIcalFeedStatus, recordRefreshFailure, recordRefreshSuccess, recoverMissedGradeHistory } from "../src/local/refresh-history.ts";
import { IcalNormalizationError, MAX_ICAL_BYTES, normalizeCanvasIcal } from "../src/local/ical.ts";
import { GradePreviewError, MAX_GRADE_PDF_BYTES, parseGradeReportPdf, proposePdfGrades } from "../src/local/grades.ts";
import { LOCAL_CSRF_COOKIE_NAME } from "../src/auth/cookies.ts";

function fail(message) {
  process.stderr.write(`duegood-local: ${message}\n`);
  process.exit(64);
}

function options(argv) {
  const result = {};
  let readOnly = false;
  let enableRefresh = false;
  let enableIcalImport = false;
  let enableIcalFetch = false;
  for (let index = 0; index < argv.length;) {
    const key = argv[index];
    if (key === "--read-only") {
      readOnly = true;
      index += 1;
      continue;
    }
    if (key === "--enable-refresh") {
      enableRefresh = true;
      index += 1;
      continue;
    }
    if (key === "--enable-ical-import") {
      enableIcalImport = true;
      index += 1;
      continue;
    }
    if (key === "--enable-ical-fetch") {
      enableIcalFetch = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("expected --coursework PATH --port PORT");
    result[key.slice(2)] = value;
    index += 2;
  }
  if (!result.coursework || !result.port) fail("--coursework and --port are required");
  const port = Number(result.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be 1..65535");
  if (enableIcalFetch && !enableIcalImport) fail("calendar fetch requires --enable-ical-import");
  return { coursework: path.resolve(result.coursework), port, readOnly, enableRefresh, enableIcalImport, enableIcalFetch };
}

const config = options(process.argv.slice(2));
let icalOptions = null;
if (config.enableIcalImport) {
  try {
    const candidate = JSON.parse(process.env.DUEGOOD_ICAL_IMPORT_CONFIG_JSON ?? "null");
    const keys = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? Object.keys(candidate) : [];
    const allowed = new Set(["institution", "canvasOrigin", "courses", "verifiedEvents", "explicitUidMappings"]);
    if (!keys.includes("institution") || !keys.includes("canvasOrigin") || !keys.includes("courses")
        || keys.some((key) => !allowed.has(key))) throw new Error();
    icalOptions = candidate;
  } catch { fail("calendar importer configuration is unavailable"); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const publicRoot = path.join(root, "dist", "public");
const expectedHost = `127.0.0.1:${config.port}`;
const origin = `http://${expectedHost}`;
const csrf = randomBytes(32).toString("base64url");
const store = new CourseworkStore(config.coursework);
const dashboardStore = new DashboardStore(config.coursework);
let version = (await store.read()).version;
let refreshing = false;
let icalFetching = false;

async function runRefresh() {
  if (refreshing) throw new Error("refresh already running");
  refreshing = true;
  const startedAt = new Date().toISOString();
  try {
    const outcome = await superviseRefresh(path.dirname(config.coursework), undefined, undefined, undefined, async (runChild) => store.withExclusive(async () => {
      let before;
      try {
        before = await captureCanvasSnapshot(config.coursework);
      } catch (error) {
        try {
          await recordRefreshFailure(path.dirname(config.coursework), startedAt, new Date().toISOString(), error);
        } catch (auditError) {
          throw new Error(`refresh could not start and refresh history could not be written: ${auditError instanceof Error ? auditError.message : "audit write failed"}`, { cause: auditError });
        }
        throw error;
      }
      try {
        await recoverMissedGradeHistory(path.dirname(config.coursework), before, startedAt);
        const result = await runChild();
        const after = await captureCanvasSnapshot(config.coursework);
        const snapshot = await store.read();
        const audit = await recordRefreshSuccess(path.dirname(config.coursework), before, after, startedAt, new Date().toISOString());
        process.stderr.write(`duegood-local: refresh finished with ${result.capturedBytes} bounded output bytes\n`);
        return { snapshot, status: audit.status === "incomplete" ? "partial" : "complete" };
      } catch (error) {
        try {
          await recordRefreshFailure(path.dirname(config.coursework), startedAt, new Date().toISOString(), error);
        } catch (auditError) {
          throw new Error(`refresh failed and refresh history could not be written: ${auditError instanceof Error ? auditError.message : "audit write failed"}`, { cause: auditError });
        }
        throw error;
      }
    }));
    version = outcome.snapshot.version;
    return outcome;
  } finally {
    refreshing = false;
  }
}

async function runIcalFetch() {
  if (icalFetching) throw new Error("calendar fetch already running");
  icalFetching = true;
  try {
    process.stderr.write("duegood-local: calendar fetch started\n");
    const result = await superviseIcalFetch(path.dirname(config.coursework), origin, csrf, 30_000, (capturedBytes) => {
      process.stderr.write(`duegood-local: calendar fetch progress ${capturedBytes} bytes\n`);
    });
    process.stderr.write("duegood-local: calendar fetch finished\n");
    return result;
  } finally {
    icalFetching = false;
  }
}

function json(response, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length, "Cache-Control": "no-store", ...headers });
  response.end(bytes);
}

function safeRequest(request) {
  if (request.headers.host !== expectedHost) return false;
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== origin) return false;
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

class IcalRequestTooLarge extends Error {}

async function calendarBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_ICAL_BYTES) throw new IcalRequestTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class GradePreviewRequestTooLarge extends Error {}

async function gradePreviewBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_GRADE_PDF_BYTES) throw new GradePreviewRequestTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function staticFile(requestPath, response) {
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  if (!/^(?:index\.html|app\.js|app\.css|sw\.js)$/.test(relative)) return false;
  const file = path.join(publicRoot, relative);
  const bytes = await readFile(file);
  const contentType = relative.endsWith(".html") ? "text/html; charset=utf-8" : relative.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
  // Plain HTTP local launches cannot store a Secure cookie. Keep this cookie local-only and use
  // the cloud `__Host-duegood_csrf` cookie unchanged in the authenticated Worker path.
  const cookie = relative === "index.html" ? { "Set-Cookie": `${LOCAL_CSRF_COOKIE_NAME}=${csrf}; Path=/; SameSite=Lax` } : {};
  response.writeHead(200, { "Content-Type": contentType, "Content-Length": bytes.length, "Cache-Control": "no-store", ...cookie });
  response.end(bytes);
  return true;
}

const server = createServer(async (request, response) => {
  try {
    if (!safeRequest(request)) return json(response, 403, { error: "request boundary rejected" });
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/api/auth/status") return json(response, 200, { available: true, oauthConfigured: true, mode: "local", refreshAvailable: config.enableRefresh && !config.readOnly, icalImportAvailable: icalOptions !== null && !config.readOnly, icalFetchAvailable: config.enableIcalFetch && icalOptions !== null && !config.readOnly });
    if (request.method === "GET" && url.pathname === "/api/connections") return json(response, 200, { connections: [{ id: "local", status: "active", createdAt: 0 }] });
    if (request.method === "GET" && (url.pathname === "/api/courses" || url.pathname === "/api/assignments")) {
      const snapshot = await store.read();
      version = snapshot.version;
      return json(response, 200, url.pathname.endsWith("courses") ? { courses: snapshot.courses } : { assignments: snapshot.assignments });
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      const snapshot = await store.read();
      version = snapshot.version;
      const [resources, refreshes, inbox, icalFeedStatus] = await Promise.all([
        dashboardStore.resources(snapshot.courses),
        dashboardStore.refreshes(),
        dashboardStore.conversations(),
        readIcalFeedStatus(path.dirname(config.coursework)),
      ]);
      const profile = await dashboardStore.profile();
      const latestRefreshAt = refreshes[0]?.finishedAt ?? refreshes[0]?.startedAt ?? null;
      const dashboardCourses = snapshot.courses.filter((course) => snapshot.events.some((event) => event.courseId === course.id));
      return json(response, 200, {
        version: snapshot.version,
        courses: dashboardCourses,
        events: snapshot.events,
        pendingSourceLinks: snapshot.pendingSourceLinks,
        resources,
        conversations: inbox.conversations,
        refreshes,
        profile,
        refreshAvailable: config.enableRefresh && !config.readOnly,
        icalImportAvailable: icalOptions !== null && !config.readOnly,
        icalFeedStatus,
        sourceStatus: {
          state: inbox.status === "partial" ? "partial" : inbox.status === "not_synced" ? "not_synced" : "ready",
          label: "Local Marymount source",
          detail: `${String(snapshot.events.length)} timeline events · ${String(resources.length)} library items · Inbox ${inbox.status.replace("_", " ")}`,
          lastRefreshAt: latestRefreshAt,
          coursework: "synced",
          library: resources.length > 0 ? "synced" : "not_synced",
          inbox: inbox.status,
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/local/profile/avatar") {
      const avatar = await dashboardStore.avatar();
      if (avatar === null) return json(response, 404, { error: "profile avatar unavailable" });
      const metadata = await stat(avatar.filePath).catch(() => null);
      if (metadata === null || !metadata.isFile() || metadata.size > 5 * 1024 * 1024) return json(response, 404, { error: "profile avatar unavailable" });
      response.writeHead(200, {
        "Content-Type": avatar.contentType,
        "Content-Length": metadata.size,
        "Content-Disposition": "inline",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      const stream = createReadStream(avatar.filePath);
      stream.once("error", (error) => {
        if (!response.headersSent) json(response, 404, { error: "profile avatar unavailable" });
        else response.destroy(error);
      });
      stream.pipe(response);
      return;
    }
    const resourceMatch = /^\/api\/local\/resources\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && resourceMatch) {
      const snapshot = await store.read();
      const file = await dashboardStore.resolveLocalResource(decodeURIComponent(resourceMatch[1]), snapshot.courses);
      if (file === null) return json(response, 404, { error: "resource unavailable" });
      const metadata = await stat(file);
      if (!metadata.isFile()) return json(response, 404, { error: "resource unavailable" });
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": metadata.size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      const stream = createReadStream(file);
      stream.once("error", (error) => {
        if (!response.headersSent) json(response, 404, { error: "resource unavailable" });
        else response.destroy(error);
      });
      stream.pipe(response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/local/ical-import") {
      if (icalOptions === null || config.readOnly) return json(response, 405, { error: "calendar import unavailable" });
      if (request.headers["x-duegood-csrf-token"] !== csrf) return json(response, 403, { error: "csrf rejected" });
      if (url.search || request.headers["content-encoding"] || !/^text\/calendar(?:;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) {
        return json(response, 400, { error: "calendar import request rejected" });
      }
      if (refreshing) return json(response, 409, { error: "coursework refresh is running" });
      const startedAt = new Date().toISOString();
      process.stderr.write("duegood-local: calendar import started\n");
      try {
        const input = await calendarBody(request);
        const normalized = await normalizeCanvasIcal(input, icalOptions);
        const outcome = await store.importIcalFeed(icalOptions.institution, normalized, startedAt, new Date().toISOString());
        version = outcome.version;
        process.stderr.write(`duegood-local: calendar import finished; accepted ${outcome.feedStatus.accepted}, held ${outcome.feedStatus.held}\n`);
        return json(response, 200, { status: "imported", version: outcome.version, added: outcome.added,
          updated: outcome.updated, held: outcome.feedStatus.held, removed: 0, feedStatus: outcome.feedStatus });
      } catch (error) {
        try { await store.recordIcalFailure(new Date().toISOString()); }
        catch { process.stderr.write("duegood-local: calendar status write failed\n"); }
        process.stderr.write("duegood-local: calendar import failed\n");
        if (error instanceof IcalRequestTooLarge) return json(response, 413, { error: "calendar input too large" });
        if (error instanceof IcalNormalizationError) return json(response, 422, { error: "calendar import rejected", code: error.code });
        return json(response, 500, { error: "calendar import failed" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/local/ical-refresh") {
      if (!config.enableIcalFetch || icalOptions === null || config.readOnly) return json(response, 405, { error: "calendar fetch unavailable" });
      if (request.headers["x-duegood-csrf-token"] !== csrf) return json(response, 403, { error: "csrf rejected" });
      if (url.search || request.headers["content-type"] || request.headers["content-encoding"]) return json(response, 400, { error: "calendar fetch request rejected" });
      if (refreshing || icalFetching) return json(response, 409, { error: "calendar fetch already running" });
      try {
        await runIcalFetch();
        return json(response, 200, { status: "imported" });
      } catch {
        return json(response, 502, { error: "calendar fetch failed" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/local/grade-preview") {
      if (config.readOnly) return json(response, 405, { error: "grade preview unavailable" });
      if (request.headers["x-duegood-csrf-token"] !== csrf) return json(response, 403, { error: "csrf rejected" });
      if (url.search || request.headers["content-encoding"] || !/^application\/pdf(?:;\s*charset=binary)?$/iu.test(request.headers["content-type"] ?? "")) {
        return json(response, 400, { error: "grade preview request rejected" });
      }
      try {
        const input = await gradePreviewBody(request);
        const snapshot = await store.read();
        const rows = await parseGradeReportPdf(input);
        const proposals = proposePdfGrades(rows, snapshot.events.map((event) => ({
          sourceItemId: event.sourceItemId ?? event.id,
          courseCode: event.courseCode,
          title: event.title,
          kind: event.kind,
        })));
        return json(response, 200, { proposals });
      } catch (error) {
        if (error instanceof GradePreviewRequestTooLarge || error instanceof GradePreviewError) return json(response, 422, { error: "grade report needs manual entry" });
        return json(response, 422, { error: "grade report needs manual entry" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/local/refresh") {
      if (!config.enableRefresh || config.readOnly) return json(response, 405, { error: "refresh unavailable" });
      if (request.headers["x-duegood-csrf-token"] !== csrf) return json(response, 403, { error: "csrf rejected" });
      if (refreshing) return json(response, 409, { error: "refresh already running" });
      try {
        const outcome = await runRefresh();
        return json(response, 200, { status: outcome.status, version: outcome.snapshot.version });
      } catch (error) {
        return json(response, 502, { error: error instanceof Error ? error.message : "refresh failed" });
      }
    }
    const pendingLinkMatch = /^\/api\/local\/pending-source-links\/([^/]+)$/.exec(url.pathname);
    if (request.method === "POST" && pendingLinkMatch) {
      if (icalOptions === null || config.readOnly) return json(response, 405, { error: "pending link review unavailable" });
      if (request.headers["x-duegood-csrf-token"] !== csrf) return json(response, 403, { error: "csrf rejected" });
      const parsed = await body(request);
      if (typeof parsed.expectedVersion !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.expectedVersion)
          || typeof parsed.localItemId !== "string" || parsed.localItemId.length > 160
          || (parsed.decision === "confirm" && parsed.localItemId.length === 0)
          || (parsed.decision !== "confirm" && parsed.decision !== "reject")) {
        return json(response, 400, { error: "pending link decision is invalid" });
      }
      try {
        const result = await store.resolvePendingSourceLink(icalOptions.institution, decodeURIComponent(pendingLinkMatch[1]), parsed.localItemId, parsed.decision, parsed.expectedVersion);
        version = result.version;
        return json(response, 200, { status: parsed.decision === "confirm" ? "linked" : "kept-distinct", version: result.version });
      } catch (error) {
        if (error instanceof Error && error.message.includes("changed")) return json(response, 409, { error: error.message });
        throw error;
      }
    }
    const match = /^\/api\/source-items\/([^/]+)\/completion$/.exec(url.pathname);
    if (request.method === "POST" && match) {
      if (config.readOnly) return json(response, 405, { error: "read-only launch" });
      if (request.headers["x-duegood-csrf-token"] !== csrf) return json(response, 403, { error: "csrf rejected" });
      const parsed = await body(request);
      if (typeof parsed.completed !== "boolean") return json(response, 400, { error: "completed must be boolean" });
      try {
        const result = await store.setCompletion(decodeURIComponent(match[1]), parsed.completed, version);
        version = result.version;
        return json(response, 200, result);
      } catch (error) {
        if (error instanceof Error && error.message.includes("changed")) return json(response, 409, { error: error.message });
        throw error;
      }
    }
    const manualGradeMatch = /^\/api\/source-items\/([^/]+)\/manual-grade$/.exec(url.pathname);
    if (request.method === "POST" && manualGradeMatch) {
      if (config.readOnly) return json(response, 405, { error: "read-only launch" });
      if (request.headers["x-duegood-csrf-token"] !== csrf) return json(response, 403, { error: "csrf rejected" });
      const parsed = await body(request);
      if (typeof parsed.version !== "string" || !/^[a-f0-9]{64}$/.test(parsed.version) || (typeof parsed.value !== "string" && parsed.value !== null) || (parsed.source !== undefined && parsed.source !== "manual" && parsed.source !== "pdf")) {
        return json(response, 400, { error: "version and manual grade value are required" });
      }
      try {
        const result = await store.setManualGrade(decodeURIComponent(manualGradeMatch[1]), parsed.value, parsed.version, parsed.source ?? "manual");
        version = result.version;
        return json(response, 200, result);
      } catch (error) {
        if (error instanceof Error && error.message.includes("changed")) return json(response, 409, { error: error.message });
        if (error instanceof Error && error.message.includes("not found")) return json(response, 404, { error: error.message });
        if (error instanceof Error && error.message.includes("manual grade")) return json(response, 400, { error: error.message });
        throw error;
      }
    }
    const discussionMatch = /^\/api\/source-items\/([^/]+)\/discussion-progress$/.exec(url.pathname);
    if (request.method === "POST" && discussionMatch) {
      if (config.readOnly) return json(response, 405, { error: "read-only launch" });
      if (request.headers["x-duegood-csrf-token"] !== csrf) return json(response, 403, { error: "csrf rejected" });
      const parsed = await body(request);
      const field = parsed.field === "post" ? "discussionPostDone" : parsed.field === "replies" ? "discussionRepliesDone" : null;
      if (field !== null && typeof parsed.value !== "boolean") return json(response, 400, { error: "discussion field value must be boolean" });
      try {
        const result = field !== null
          ? await store.setDiscussionField(decodeURIComponent(discussionMatch[1]), field, parsed.value === true)
          : typeof parsed.discussionPostDone === "boolean" && typeof parsed.discussionRepliesDone === "boolean"
            ? await store.setDiscussionProgress(decodeURIComponent(discussionMatch[1]), parsed.discussionPostDone, parsed.discussionRepliesDone, version)
            : null;
        if (result === null) return json(response, 400, { error: "field/value or discussionPostDone/discussionRepliesDone must be provided" });
        version = result.version;
        return json(response, 200, result);
      } catch (error) {
        if (error instanceof Error && error.message.includes("changed")) return json(response, 409, { error: error.message });
        if (error instanceof Error && error.message.includes("not found")) return json(response, 404, { error: error.message });
        throw error;
      }
    }
    if (request.method === "GET" && await staticFile(url.pathname, response)) return;
    json(response, 404, { error: "not found" });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : "local server error" });
  }
});

server.on("error", (error) => {
  process.stderr.write(`duegood-local: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(config.port, "127.0.0.1", () => process.stderr.write(`duegood-local: ready at ${origin}\n`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
