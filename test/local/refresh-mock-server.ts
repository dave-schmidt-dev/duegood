import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type ApiFixtureResponse = {
  status?: number;
  url?: string;
  body: unknown;
  headers?: { link?: string | null };
};
type CourseFixture = { key: string; folder: string; canvasCourseId: string | number };
type CourseApiFixtures = {
  course: ApiFixtureResponse;
  tabs: ApiFixtureResponse;
  pages: ApiFixtureResponse;
  modules: ApiFixtureResponse | { pages: ApiFixtureResponse[] };
  assignment_groups: ApiFixtureResponse;
  assignments: ApiFixtureResponse;
  discussions: ApiFixtureResponse;
  announcements: ApiFixtureResponse;
  files: ApiFixtureResponse;
  folders: ApiFixtureResponse;
};
export type RefreshContractFixture = {
  conventions: { canvasOrigin: string };
  courses: CourseFixture[];
  apiResponses: Record<string, CourseApiFixtures>;
  inbox: { list: ApiFixtureResponse; thread: ApiFixtureResponse };
  profile: { response: ApiFixtureResponse };
};

export type RefreshMockRequest = {
  method: string;
  path: string;
  authorization: string | null;
};

export type RefreshMockOptions = {
  failPath?: string;
  failStatus?: number;
  detailFailureIds?: string[];
  inboxAdditionalId?: string;
  pagination?: { courseId: string; target: "off-prefix" | string };
  download?: "fixture" | "foreign-redirect" | "oversized";
  foreignOrigin?: string;
  pauseFirstApiRequest?: boolean;
};

/** Loopback-only Canvas-shaped responder backed by the checked-in synthetic contract fixture. */
export class RefreshMockServer {
  readonly requests: RefreshMockRequest[] = [];
  readonly errors: string[] = [];
  private readonly server: Server;
  private readonly fixture: RefreshContractFixture;
  private readonly options: RefreshMockOptions;
  private readonly waiters: Array<{ predicate: (request: RefreshMockRequest) => boolean; resolve: (request: RefreshMockRequest) => void }> = [];
  private firstApiResolve: (() => void) | undefined;
  private firstApiRequest = Promise.resolve();
  private releaseFirstApiResolve: (() => void) | undefined;
  private firstApiRelease = Promise.resolve();
  private apiPaused = false;
  origin = "";

  constructor(fixture: RefreshContractFixture, options: RefreshMockOptions = {}) {
    this.fixture = fixture;
    this.options = options;
    this.server = createServer((request, response) => {
      void this.respond(request, response).catch(() => {
        this.errors.push("mock route handler failed");
        if (!response.destroyed) {
          if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
          response.end("{}");
        }
      });
    });
    if (options.pauseFirstApiRequest) {
      this.firstApiRequest = new Promise((resolve) => { this.firstApiResolve = resolve; });
      this.firstApiRelease = new Promise((resolve) => { this.releaseFirstApiResolve = resolve; });
    }
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async close(): Promise<void> {
    this.releaseFirstApiResolve?.();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  async waitForRequest(predicate: (request: RefreshMockRequest) => boolean, timeoutMs = 5_000): Promise<RefreshMockRequest> {
    const existing = this.requests.find(predicate);
    if (existing) return existing;
    return new Promise<RefreshMockRequest>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === onMatch);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timed out waiting for synthetic Canvas request"));
      }, timeoutMs);
      const onMatch = (request: RefreshMockRequest) => {
        clearTimeout(timer);
        resolve(request);
      };
      this.waiters.push({ predicate, resolve: onMatch });
    });
  }

  async waitUntilFirstApiRequest(): Promise<void> {
    await this.firstApiRequest;
  }

  releaseFirstApiRequest(): void {
    this.releaseFirstApiResolve?.();
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestPath = request.url ?? "/";
    const recorded: RefreshMockRequest = {
      method: request.method ?? "",
      path: requestPath,
      authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : null,
    };
    this.requests.push(recorded);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(recorded)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(recorded);
      }
    }

    if (recorded.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain" }).end("synthetic mock is read-only");
      return;
    }

    if (this.options.pauseFirstApiRequest && requestPath.startsWith("/api/") && !this.apiPaused) {
      this.apiPaused = true;
      this.firstApiResolve?.();
      await this.firstApiRelease;
    }

    if (this.options.failPath && requestPath.startsWith(this.options.failPath)) {
      response.writeHead(this.options.failStatus ?? 503, { "content-type": "application/json" }).end("{}");
      return;
    }

    const url = new URL(requestPath, this.origin);
    if (/^\/files\/\d+\/download$/.test(url.pathname)) {
      this.respondFileDownload(response);
      return;
    }
    if (/^\/objects\/\d+\/download$/.test(url.pathname)) {
      this.respondDownloadBody(response);
      return;
    }
    if (/^\/images\/thumbnails\/\d+\/avatar\.png$/.test(url.pathname)) {
      response.writeHead(200, { "content-type": "image/png", "content-length": "8" }).end(Buffer.from("89504e470d0a1a0a", "hex"));
      return;
    }

    const apiResult = this.apiResponse(url);
    if (apiResult) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiResult.link) headers.link = apiResult.link;
      response.writeHead(apiResult.status ?? 200, headers).end(JSON.stringify(apiResult.body));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" }).end("{}");
  }

  private respondFileDownload(response: ServerResponse): void {
    if (this.options.download === "foreign-redirect") {
      const foreignOrigin = this.options.foreignOrigin;
      if (!foreignOrigin) {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(302, { location: `${foreignOrigin}/objects/501/download` }).end();
      return;
    }
    response.writeHead(302, { location: `${this.origin}/objects/501/download` }).end();
  }

  private respondDownloadBody(response: ServerResponse): void {
    if (this.options.download === "oversized") {
      response.writeHead(200, { "content-type": "application/pdf" })
        .end(Buffer.alloc(25 * 1024 * 1024 + 1, 0x61));
      return;
    }
    const bytes = Buffer.from("SYNTHETIC-PDF-PLACEHOLDER", "ascii");
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="syllabus-2026.pdf"',
      "content-length": String(bytes.byteLength),
    }).end(bytes);
  }

  private apiResponse(url: URL): { status?: number; body: unknown; link?: string | null } | undefined {
    const fixtureOrigin = this.fixture.conventions.canvasOrigin;
    const courseKeyById = new Map<string, string>(this.fixture.courses.map((course) => [String(course.canvasCourseId), course.key]));
    const courseMatch = url.pathname.match(/^\/api\/v1\/courses\/(\d+)(?:\/([^/]+))?$/);
    if (courseMatch) {
      const [, courseId, resource] = courseMatch;
      const key = courseKeyById.get(courseId ?? "");
      const courseFixture = key ? this.fixture.apiResponses[key] : undefined;
      if (!courseFixture) return undefined;
      if (!resource) return this.rewriteResponse(courseFixture.course, fixtureOrigin);
      if (resource === "modules") {
        const pagination = this.options.pagination;
        if (pagination && pagination.courseId === courseId && !url.searchParams.has("page")) {
          const target = pagination.target === "off-prefix"
            ? `${this.origin}/api/v1/accounts/self/reports?page=1`
            : pagination.target;
          return { status: 200, body: [], link: `<${target}>; rel="next"` };
        }
        if (!("pages" in courseFixture.modules)) {
          return this.rewriteResponse(courseFixture.modules, fixtureOrigin);
        }
        const pages = courseFixture.modules.pages;
        const page = Number(url.searchParams.get("page") ?? "1");
        const item = pages[page - 1];
        return item ? this.rewriteResponse(item, fixtureOrigin) : { status: 200, body: [] };
      }
      const mapped: Record<string, "tabs" | "pages" | "assignment_groups" | "assignments" | "discussions" | "files" | "folders"> = {
        tabs: "tabs",
        pages: "pages",
        assignment_groups: "assignment_groups",
        assignments: "assignments",
        discussion_topics: "discussions",
        files: "files",
        folders: "folders",
      };
      const mappedResource = mapped[resource ?? ""];
      const response = mappedResource ? courseFixture[mappedResource] : undefined;
      return response ? this.rewriteResponse(response, fixtureOrigin) : undefined;
    }

    if (url.pathname === "/api/v1/announcements") {
      const contextCodes = url.searchParams.getAll("context_codes[]").join(" ");
      const match = contextCodes.match(/course_(\d+)/);
      const key = match ? courseKeyById.get(match[1] ?? "") : undefined;
      const response = key ? this.fixture.apiResponses[key]?.announcements : undefined;
      return response ? this.rewriteResponse(response, fixtureOrigin) : { status: 200, body: [] };
    }

    if (url.pathname === "/api/v1/conversations") {
      const response = this.fixture.inbox?.list;
      if (!response) return undefined;
      const rows = Array.isArray(response.body) ? [...response.body] : [];
      if (this.options.inboxAdditionalId) {
        rows.push({
          id: this.options.inboxAdditionalId,
          subject: "Synthetic later thread",
          context_name: "Demo Alpha Seminar",
          last_message: "Synthetic later-thread preview",
          last_message_at: "2026-11-24T15:00:00Z",
          workflow_state: "unread",
          starred: false,
          message_count: 1,
        });
      }
      return this.rewriteResponse({ ...response, body: rows }, fixtureOrigin);
    }
    const conversationMatch = url.pathname.match(/^\/api\/v1\/conversations\/(\d+)$/);
    if (conversationMatch) {
      const conversationId = conversationMatch[1] ?? "";
      if (this.options.detailFailureIds?.includes(conversationId)) {
        return { status: 503, body: {} };
      }
      const response = this.fixture.inbox?.thread;
      if (!response) return undefined;
      const rewritten = this.rewriteResponse(response, fixtureOrigin);
      if (!rewritten.body || typeof rewritten.body !== "object" || Array.isArray(rewritten.body)) {
        return rewritten;
      }
      return { ...rewritten, body: { ...(rewritten.body as Record<string, unknown>), id: conversationId } };
    }
    if (url.pathname === "/api/v1/users/self/profile") {
      const response = this.fixture.profile?.response;
      return response ? this.rewriteResponse(response, fixtureOrigin) : undefined;
    }
    return undefined;
  }

  private rewriteResponse(response: ApiFixtureResponse, fixtureOrigin: string): { status: number; body: unknown; link?: string | null } {
    const rewrite = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value
          .replaceAll(fixtureOrigin, this.origin)
          .replaceAll("https://canvas-files.example.invalid", this.origin);
      }
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
      }
      return value;
    };
    const link = typeof response.headers?.link === "string" ? rewrite(response.headers.link) as string : undefined;
    return { status: Number(response.status ?? 200), body: rewrite(response.body), link };
  }
}
