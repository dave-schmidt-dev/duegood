import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { readCanvasBrowserApi } from "../../scripts/canvas-browser-reader.mjs";
import { classifyProbe } from "../../scripts/canvas-browser-probe.mjs";

const ORIGIN = "https://marymount.instructure.com";
const json = (body: unknown, headers: Record<string, string> = {}, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});
const profile = () => json({ id: 41, name: "Synthetic learner" });

describe("content-free probe classification", () => {
  it("does not call a browser-only file check a completed native download", () => {
    expect(classifyProbe({ accountIdentity: "AVAILABLE_UNBOUND", signedInContinuity: "OK", nativeDownloader: "NOT_TESTED" })).toBe("PARTIAL");
    expect(classifyProbe({ accountIdentity: "MATCH", signedInContinuity: "OK", nativeDownloader: "VERIFIED" })).toBe("COMPLETE");
    expect(classifyProbe({ accountIdentity: "MISMATCH", signedInContinuity: "OK", nativeDownloader: "NOT_TESTED" })).toBe("IDENTITY_MISMATCH");
  });
});

describe("guarded Canvas browser API reader", () => {
  it("uses only the explicit course, submission, page, module, discussion, announcement, and quiz GET shapes", async () => {
    const cases = [
      { input: { endpoint: "syllabus", courseId: 88 }, path: "/api/v1/courses/88", search: "" },
      { input: { endpoint: "courseTabs", courseId: 88 }, path: "/api/v1/courses/88/tabs", search: "?per_page=100" },
      { input: { endpoint: "assignmentGroups", courseId: 88 }, path: "/api/v1/courses/88/assignment_groups", search: "?per_page=100" },
      { input: { endpoint: "submissions", courseId: 88 }, path: "/api/v1/courses/88/students/submissions", search: "?per_page=100" },
      { input: { endpoint: "submission", courseId: 88, assignmentId: 501 }, path: "/api/v1/courses/88/assignments/501/submissions/self", search: "?include%5B%5D=submission_comments" },
      { input: { endpoint: "page", courseId: 88, pageSlug: "week-one" }, path: "/api/v1/courses/88/pages/week-one", search: "" },
      { input: { endpoint: "moduleItems", courseId: 88, moduleId: 12 }, path: "/api/v1/courses/88/modules/12/items", search: "?per_page=100" },
      { input: { endpoint: "discussionEntries", courseId: 88, topicId: 19 }, path: "/api/v1/courses/88/discussion_topics/19/entries", search: "?per_page=100" },
      { input: { endpoint: "discussionReplies", courseId: 88, topicId: 19, entryId: 72 }, path: "/api/v1/courses/88/discussion_topics/19/entries/72/replies", search: "?per_page=100" },
      { input: { endpoint: "announcements", courseId: 88 }, path: "/api/v1/announcements", search: "?context_codes%5B%5D=course_88&per_page=100" },
      { input: { endpoint: "quizzes", courseId: 88 }, path: "/api/v1/courses/88/quizzes", search: "?per_page=100" },
      { input: { endpoint: "quiz", courseId: 88, quizId: 73 }, path: "/api/v1/courses/88/quizzes/73", search: "" },
    ];

    for (const { input, path, search } of cases) {
      const calls: Array<{ url: URL; init: RequestInit }> = [];
      const fetcher = vi.fn(async (value: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(value));
        calls.push({ url, init });
        if (url.pathname === "/api/v1/users/self/profile") return profile();
        if (input.endpoint === "syllabus") return json({ id: 88, course_id: 88, syllabus_body: "<p>synthetic</p>" });
        if (input.endpoint === "submission") return json({ id: 701, course_id: 88, assignment_id: 501, user_id: 41, submission_comments: [] });
        if (input.endpoint === "page") return json({ id: 607, course_id: 88, url: "week-one", body: "<p>synthetic</p>" });
        if (input.endpoint === "quiz") return json({ id: 73, course_id: 88, title: "Synthetic quiz" });
        if (input.endpoint === "submissions") return json([{ id: 701, course_id: 88, user_id: 41 }]);
        return json([{ id: 72, course_id: 88 }]);
      });

      await expect(readCanvasBrowserApi({ mode: "read", ...input, expectedUserId: 41 }, fetcher))
        .resolves.toMatchObject({ status: "ok", identity: { userId: 41 } });
      expect(calls.map(({ url }) => url.pathname + url.search)).toEqual([
        "/api/v1/users/self/profile",
        path + search,
      ]);
      expect(calls[1]?.init.method).toBe("GET");
      expect(calls[1]?.init.redirect).toBe("manual");
      expect(calls[1]?.init.credentials).toBe("same-origin");
      expect(calls[1]?.init.cache).toBe("no-store");
    }
  });

  it("rejects page path injection and discussion view before any request", async () => {
    const fetcher = vi.fn(async () => profile());
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "page", courseId: 88, pageSlug: "../front-page", expectedUserId: 41 }, fetcher))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "discussionView", courseId: 88, topicId: 19, expectedUserId: 41 }, fetcher))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces fixed announcement query data across safe pagination and rejects host, path, and query changes", async () => {
    const safeCalls: URL[] = [];
    const safeFetcher = vi.fn(async (value: RequestInfo | URL) => {
      const url = new URL(String(value));
      safeCalls.push(url);
      if (url.pathname.endsWith("/profile")) return profile();
      if (url.pathname === "/api/v1/announcements" && url.searchParams.get("page") === "2") return json([{ id: 2, context_code: "course_88" }]);
      return json([{ id: 1, context_code: "course_88" }], {
        link: `<${ORIGIN}/api/v1/announcements?context_codes%5B%5D=course_88&per_page=1&page=2>; rel="next"`,
      });
    });
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "announcements", courseId: 88, expectedUserId: 41, perPage: 1 }, safeFetcher))
      .resolves.toMatchObject({ status: "ok", pages: 2, items: [{ id: 1 }, { id: 2 }] });
    expect(safeCalls.map((url) => url.searchParams.get("page"))).toEqual([null, null, "2"]);

    const unsafeLinks = [
      `<https://evil.example/api/v1/announcements?context_codes%5B%5D=course_88&per_page=1&page=2>; rel="next"`,
      `<${ORIGIN}/api/v1/courses/88/announcements?context_codes%5B%5D=course_88&per_page=1&page=2>; rel="next"`,
      `<${ORIGIN}/api/v1/announcements?context_codes%5B%5D=course_88&per_page=1&page=2&token=bad>; rel="next"`,
      `<${ORIGIN}/api/v1/announcements?context_codes%5B%5D=course_89&per_page=1&page=2>; rel="next"`,
    ];
    for (const link of unsafeLinks) {
      let requestsAfterFirstPage = 0;
      const fetcher = vi.fn(async (value: RequestInfo | URL) => {
        const url = new URL(String(value));
        if (url.pathname.endsWith("/profile")) return profile();
        if (url.searchParams.has("page")) requestsAfterFirstPage += 1;
        return json([{ id: 1, context_code: "course_88" }], { link });
      });
      await expect(readCanvasBrowserApi({ mode: "read", endpoint: "announcements", courseId: 88, expectedUserId: 41, perPage: 1 }, fetcher))
        .rejects.toMatchObject({ code: "UNSAFE_URL" });
      expect(requestsAfterFirstPage).toBe(0);
    }
  });

  it("keeps forbidden areas as gaps and required-area 403 responses incomplete", async () => {
    const forbiddenPage = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
      ? profile()
      : json({ message: "forbidden" }, {}, 403));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "pages", courseId: 88, expectedUserId: 41 }, forbiddenPage))
      .resolves.toMatchObject({ status: "gap", reason: "FORBIDDEN_OPTIONAL" });

    const forbiddenCourse = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
      ? profile()
      : json({ message: "forbidden" }, {}, 403));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "assignments", courseId: 88, expectedUserId: 41 }, forbiddenCourse))
      .rejects.toMatchObject({ code: "INCOMPLETE_REQUIRED_AREA" });
  });

  it("rejects submission records that do not match the locally confirmed caller", async () => {
    const fetcher = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
      ? profile()
      : json([{ id: 701, course_id: 88, user_id: 42 }]));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "submissions", courseId: 88, expectedUserId: 41 }, fetcher))
      .rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  it("emits only fixed progress states around each GET and ignores a broken optional binding", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "__duegoodCanvasReaderProgress");
    const states: unknown[] = [];
    Object.defineProperty(globalThis, "__duegoodCanvasReaderProgress", {
      configurable: true,
      value: (state: unknown) => { states.push(state); },
    });
    try {
      const fetcher = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
        ? profile()
        : json([{ id: 501, course_id: 88 }]));
      await expect(readCanvasBrowserApi({ mode: "read", endpoint: "assignments", courseId: 88, expectedUserId: 41 }, fetcher))
        .resolves.toMatchObject({ status: "ok" });
      expect(states).toEqual([
        "CANVAS_GET_STARTED", "CANVAS_GET_FINISHED",
        "CANVAS_GET_STARTED", "CANVAS_GET_FINISHED",
      ]);
      expect(states.some((state) => typeof state !== "string" || state.includes("/"))).toBe(false);

      Object.defineProperty(globalThis, "__duegoodCanvasReaderProgress", {
        configurable: true,
        value: () => { throw new Error("synthetic broken status sink"); },
      });
      await expect(readCanvasBrowserApi({ mode: "read", endpoint: "profile", expectedUserId: 41 }, fetcher))
        .resolves.toMatchObject({ status: "ok" });
    } finally {
      if (previous) Object.defineProperty(globalThis, "__duegoodCanvasReaderProgress", previous);
      else Reflect.deleteProperty(globalThis, "__duegoodCanvasReaderProgress");
    }
  });

  it("returns a full identity-bound page set and uses only fixed same-origin GET requests", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (value: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(value));
      calls.push({ url, init });
      if (url.pathname.endsWith("/profile")) return profile();
      if (url.pathname === "/api/v1/courses/88/assignments" && url.searchParams.get("page") === "2") {
        return json([{ id: 502, course_id: 88, name: "Synthetic task two" }]);
      }
      if (url.pathname === "/api/v1/courses/88/assignments") {
        return json([{ id: 501, course_id: 88, name: "Synthetic task one" }], {
          link: `</api/v1/courses/88/assignments?per_page=1&page=2>; rel="next"`,
        });
      }
      throw new Error("Unexpected synthetic URL");
    });

    const result = await readCanvasBrowserApi(
      { mode: "read", endpoint: "assignments", courseId: 88, expectedUserId: 41, perPage: 1 }, fetcher,
    ) as unknown as { status: string; identity: { userId: number }; pages: number; items: Array<{ id: number }> };

    expect(result).toMatchObject({ status: "ok", identity: { userId: 41 }, pages: 2 });
    expect(result.items.map((item) => item.id)).toEqual([501, 502]);
    expect(calls.map(({ url }) => url.href)).toEqual([
      `${ORIGIN}/api/v1/users/self/profile`,
      `${ORIGIN}/api/v1/courses/88/assignments?per_page=1`,
      `${ORIGIN}/api/v1/courses/88/assignments?per_page=1&page=2`,
    ]);
    for (const { init } of calls) {
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
    }
  });

  it("rejects a mismatched locally confirmed user before reading the requested course", async () => {
    const fetcher = vi.fn(async () => json({ id: 42, name: "Synthetic learner" }));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "course", courseId: 88, expectedUserId: 41 }, fetcher))
      .rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows a 90-second whole-probe budget while keeping read mode capped at 30 seconds", async () => {
    const fetcher = vi.fn(async (value: RequestInfo | URL) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/profile")) return profile();
      if (url.pathname === "/api/v1/courses" || url.pathname === "/api/v1/conversations") return json([]);
      throw new Error("Unexpected synthetic URL");
    });

    await expect(readCanvasBrowserApi({
      mode: "read", endpoint: "profile", expectedUserId: 41, timeoutMs: 30_001,
    }, fetcher)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(readCanvasBrowserApi({
      mode: "read", endpoint: "profile", expectedUserId: 41, timeoutMs: 30_000,
    }, fetcher)).resolves.toMatchObject({ status: "ok", identity: { userId: 41 } });

    await expect(readCanvasBrowserApi({ mode: "probe", timeoutMs: 90_000 }, fetcher))
      .resolves.toMatchObject({ signedInContinuity: "OK", apiShapePagination: "NO_COURSES" });
    await expect(readCanvasBrowserApi({ mode: "probe", timeoutMs: 90_001 }, fetcher))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("samples one course and file page before the whole-probe page budget is exhausted", async () => {
    const filePages: number[] = [];
    const courseListPages: number[] = [];
    const requestedPaths: string[] = [];
    const downloadCalls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (value: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(value));
      requestedPaths.push(url.pathname);
      if (url.pathname.endsWith("/profile")) return profile();
      if (url.pathname === "/api/v1/courses" && url.searchParams.get("enrollment_state") === "active") {
        const page = Number(url.searchParams.get("page") ?? "1");
        courseListPages.push(page);
        if (page === 1) return json([{ id: 88 }], {
          link: `<${ORIGIN}/api/v1/courses?enrollment_state=active&per_page=1&page=2>; rel="next"`,
        });
        return json([]);
      }
      if (url.pathname === "/api/v1/courses" && url.searchParams.get("enrollment_state") === "completed") return json([]);
      if (url.pathname === "/api/v1/courses/88") return json({ id: 88 });
      if (url.pathname === "/api/v1/conversations") return json([]);
      if (url.pathname === "/api/v1/courses/88/files") {
        const page = Number(url.searchParams.get("page") ?? "1");
        filePages.push(page);
        const headers: Record<string, string> = page < 25
          ? { link: `<${ORIGIN}/api/v1/courses/88/files?per_page=1&page=${page + 1}>; rel="next"` }
          : {};
        return json([{ id: 1_000 + page }], headers);
      }
      if (url.pathname === "/api/v1/files/1001") {
        return json({ id: 1001, url: `${ORIGIN}/files/1001/download?download_frd=1` });
      }
      if (url.pathname === "/files/1001/download") {
        downloadCalls.push({ url, init });
        return new Response("x", {
          status: 206,
          headers: { "content-type": "application/octet-stream", "content-length": "1", "content-range": "bytes 0-0/1" },
        });
      }
      throw new Error(`Unexpected synthetic URL: ${url.pathname}`);
    });

    const result = await readCanvasBrowserApi({ mode: "probe" }, fetcher);
    expect(result).toMatchObject({
      apiShapePagination: "OK",
      inboxUnreadState: "NO_UNREAD_ITEMS",
      fileMetadata: "AVAILABLE",
      fileVerifier: "MISSING",
      cookielessDownload: "BROWSER_RANGE_AVAILABLE",
    });
    expect(courseListPages).toEqual([1]);
    expect(filePages).toEqual([1]);
    expect(requestedPaths).toContain("/api/v1/files/1001");
    expect(downloadCalls).toHaveLength(1);
    const downloadCall = downloadCalls[0];
    if (!downloadCall) throw new Error("Expected one ranged download request");
    expect(downloadCall.url.search).toBe("?download_frd=1");
    expect(downloadCall.init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "manual",
    });
    expect(new Headers(downloadCall.init.headers).get("range")).toBe("bytes=0-0");
    expect(new Headers(downloadCall.init.headers).has("authorization")).toBe(false);
  });

  it("reports verifierless download refusal separately from missing legacy verifier", async () => {
    const downloadCalls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (value: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/profile")) return profile();
      if (url.pathname === "/api/v1/courses" && url.searchParams.get("enrollment_state") === "active") return json([{ id: 88 }]);
      if (url.pathname === "/api/v1/courses/88") return json({ id: 88 });
      if (url.pathname === "/api/v1/conversations") return json([]);
      if (url.pathname === "/api/v1/courses/88/files") return json([{ id: 1001 }]);
      if (url.pathname === "/api/v1/files/1001") {
        return json({ id: 1001, url: `${ORIGIN}/files/1001/download?download_frd=1` });
      }
      if (url.pathname === "/files/1001/download") {
        downloadCalls.push({ url, init });
        return new Response("", { status: 403, headers: { "content-type": "application/octet-stream" } });
      }
      throw new Error("Unexpected synthetic URL");
    });

    const result = await readCanvasBrowserApi({ mode: "probe" }, fetcher);
    expect(result).toMatchObject({ fileMetadata: "AVAILABLE", fileVerifier: "MISSING", cookielessDownload: "UNAVAILABLE" });
    expect(downloadCalls).toHaveLength(1);
    const downloadCall = downloadCalls[0];
    if (!downloadCall) throw new Error("Expected one ranged download request");
    expect(downloadCall.init.credentials).toBe("omit");
    expect(downloadCall.init.redirect).toBe("manual");
  });

  it("rejects unsafe file URLs before making a ranged request", async () => {
    const unsafeUrls = [
      "https://evil.example/files/1001/download?download_frd=1",
      `${ORIGIN}/files/1002/download?download_frd=1`,
      `${ORIGIN}/files/1001/download?download_frd=1&download_frd=1`,
      `${ORIGIN}/files/1001/download?download_frd=1&token=unexpected`,
    ];

    for (const fileUrl of unsafeUrls) {
      let downloadRequested = false;
      const fetcher = vi.fn(async (value: RequestInfo | URL) => {
        const url = new URL(String(value));
        if (url.pathname.endsWith("/profile")) return profile();
        if (url.pathname === "/api/v1/courses" && url.searchParams.get("enrollment_state") === "active") return json([{ id: 88 }]);
        if (url.pathname === "/api/v1/courses/88") return json({ id: 88 });
        if (url.pathname === "/api/v1/conversations") return json([]);
        if (url.pathname === "/api/v1/courses/88/files") return json([{ id: 1001 }]);
        if (url.pathname === "/api/v1/files/1001") return json({ id: 1001, url: fileUrl });
        if (url.pathname === "/files/1001/download") downloadRequested = true;
        throw new Error("Unexpected synthetic URL");
      });

      const result = await readCanvasBrowserApi({ mode: "probe" }, fetcher);
      expect(result).toMatchObject({ fileMetadata: "AVAILABLE", cookielessDownload: "UNSAFE_LINK" });
      expect(downloadRequested).toBe(false);
    }
  });

  it("checks at most one active and one completed course page when no course is sampled", async () => {
    const sampledCoursePages: URL[] = [];
    const fetcher = vi.fn(async (value: RequestInfo | URL) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/profile")) return profile();
      if (url.pathname === "/api/v1/courses") {
        sampledCoursePages.push(url);
        return json([], {
          link: `<${ORIGIN}${url.pathname}?enrollment_state=${url.searchParams.get("enrollment_state")}&per_page=1&page=2>; rel="next"`,
        });
      }
      if (url.pathname === "/api/v1/conversations") return json([]);
      throw new Error(`Unexpected synthetic URL: ${url.pathname}`);
    });

    const result = await readCanvasBrowserApi({ mode: "probe" }, fetcher);
    expect(result).toMatchObject({ apiShapePagination: "NO_COURSE_SAMPLED", fileMetadata: "NO_COURSE" });
    expect(sampledCoursePages.map((url) => [url.searchParams.get("enrollment_state"), url.searchParams.get("page")]))
      .toEqual([["active", null], ["completed", null]]);
  });

  it("distinguishes a complete empty file list from a sample and rejects unsafe sample links", async () => {
    const runProbe = async (link?: string) => {
      const requestedPaths: string[] = [];
      const fetcher = vi.fn(async (value: RequestInfo | URL) => {
        const url = new URL(String(value));
        requestedPaths.push(url.href);
        if (url.pathname.endsWith("/profile")) return profile();
        if (url.pathname === "/api/v1/courses" && url.searchParams.get("enrollment_state") === "active") return json([{ id: 88 }]);
        if (url.pathname === "/api/v1/courses/88") return json({ id: 88 });
        if (url.pathname === "/api/v1/conversations") return json([]);
        if (url.pathname === "/api/v1/courses/88/files") {
          const headers: Record<string, string> = link ? { link } : {};
          return json([], headers);
        }
        throw new Error(`Unexpected synthetic URL: ${url.href}`);
      });
      return { result: await readCanvasBrowserApi({ mode: "probe" }, fetcher), requestedPaths };
    };

    const complete = await runProbe();
    expect(complete.result).toMatchObject({ fileMetadata: "NO_FILE" });

    const next = await runProbe(`<${ORIGIN}/api/v1/courses/88/files?per_page=1&page=2>; rel="next"`);
    expect(next.result).toMatchObject({ fileMetadata: "NO_FILE_SAMPLED" });
    expect(next.requestedPaths.filter((url) => new URL(url).pathname === "/api/v1/courses/88/files")).toHaveLength(1);

    const unsafe = await runProbe("<https://evil.example/api/v1/courses/88/files?per_page=1&page=2>; rel=next");
    expect(unsafe.result).toMatchObject({ fileMetadata: "UNSAFE_LINK" });
    expect(unsafe.requestedPaths.some((url) => new URL(url).origin === "https://evil.example")).toBe(false);
  });

  it("accepts the supported anti-JSON prefix while rejecting HTML sign-in responses", async () => {
    const prefixed = vi.fn(async () => new Response(")]}'\n{\"id\":41}", {
      headers: { "content-type": "application/json" },
    }));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "profile", expectedUserId: 41 }, prefixed))
      .resolves.toMatchObject({ status: "ok", identity: { userId: 41 } });

    const html = vi.fn(async () => new Response("<!doctype html><html><title>Sign in</title></html>", {
      headers: { "content-type": "text/html" },
    }));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "profile", expectedUserId: 41 }, html))
      .rejects.toMatchObject({ code: "HTML_OR_SSO_REJECTED" });
  });

  it("rejects unsafe pagination, redirects, mismatched course IDs, and 404 as distinct failures", async () => {
    const unsafeLink = vi.fn(async (value: RequestInfo | URL) => {
      const url = new URL(String(value));
      return url.pathname.endsWith("/profile") ? profile() : json([], {
        link: `<https://evil.example/api/v1/courses/88/pages?per_page=1&page=2>; rel="next"`,
      });
    });
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "pages", courseId: 88, expectedUserId: 41, perPage: 1 }, unsafeLink))
      .rejects.toMatchObject({ code: "UNSAFE_URL" });

    const redirect = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
      ? profile()
      : new Response("", { status: 302, headers: { location: `${ORIGIN}/login` } }));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "course", courseId: 88, expectedUserId: 41 }, redirect))
      .rejects.toMatchObject({ code: "REDIRECT_REJECTED" });

    const wrongCourse = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
      ? profile()
      : json([{ id: 77, course_id: 89 }]));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "assignments", courseId: 88, expectedUserId: 41 }, wrongCourse))
      .rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });

    const missing = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
      ? profile()
      : new Response("", { status: 404, headers: { "content-type": "application/json" } }));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "course", courseId: 88, expectedUserId: 41 }, missing))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("marks optional denial as a gap while required denial is incomplete", async () => {
    const denied = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
      ? profile()
      : new Response("", { status: 403, headers: { "content-type": "application/json" } }));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "courseFiles", courseId: 88, expectedUserId: 41 }, denied))
      .resolves.toMatchObject({ status: "gap", reason: "FORBIDDEN_OPTIONAL", items: [] });
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "course", courseId: 88, expectedUserId: 41 }, denied))
      .rejects.toMatchObject({ code: "INCOMPLETE_REQUIRED_AREA" });
  });

  it("forces Inbox detail GET to preserve unread state and enforces size budgets", async () => {
    const calls: URL[] = [];
    const inbox = vi.fn(async (value: RequestInfo | URL) => {
      const url = new URL(String(value));
      calls.push(url);
      if (url.pathname.endsWith("/profile")) return profile();
      return json({ id: 7, messages: [{ body: "Synthetic message" }] });
    });
    await readCanvasBrowserApi({ mode: "read", endpoint: "conversation", conversationId: 7, expectedUserId: 41 }, inbox);
    expect(calls.at(-1)?.searchParams.get("auto_mark_as_read")).toBe("false");
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "profile", expectedUserId: 41, maxBytes: 1 }, inbox))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("pins the versioned native capture envelope", async () => {
    const schema = JSON.parse(await readFile("docs/CANVAS-CAPTURE-SCHEMA.json", "utf8")) as {
      $id: string;
      properties: { schemaVersion: { const: number }; source: { const: string } };
    };
    expect(schema.$id).toBe("https://schemas.duegood.invalid/canvas-capture/v2.json");
    expect(schema.properties.schemaVersion.const).toBe(2);
    expect(schema.properties.source.const).toBe("canvas-browser");
  });
});
