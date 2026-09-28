import { describe, expect, it, vi } from "vitest";
import { readCanvasBrowserApi } from "../../scripts/canvas-browser-reader.mjs";

const ORIGIN = "https://marymount.instructure.com";
const json = (body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json", ...headers },
});
const profile = () => json({ id: 41, name: "Synthetic learner" });

describe("identity-bound account Canvas reader routes", () => {
  it("uses fixed personal, conversation, group, file-metadata, and bounded calendar GET shapes", async () => {
    const cases = [
      { input: { endpoint: "groups" }, path: "/api/v1/users/self/groups", search: "?per_page=100", item: { id: 6 } },
      { input: { endpoint: "personalFiles" }, path: "/api/v1/users/self/files", search: "?per_page=100", item: { id: 503 } },
      { input: { endpoint: "personalFolders" }, path: "/api/v1/users/self/folders", search: "?per_page=100", item: { id: 8, context_type: "User", context_id: 41 } },
      { input: { endpoint: "personalFile", fileId: 503 }, path: "/api/v1/users/self/files/503", search: "", item: { id: 503, display_name: "Synthetic file" } },
      { input: { endpoint: "inboxAll" }, path: "/api/v1/conversations", search: "?per_page=100", item: { id: 71 } },
      { input: { endpoint: "conversationsSent" }, path: "/api/v1/conversations", search: "?scope=sent&per_page=100", item: { id: 72 } },
      { input: { endpoint: "conversationsArchived" }, path: "/api/v1/conversations", search: "?scope=archived&per_page=100", item: { id: 73 } },
      {
        input: { endpoint: "calendarEvents", calendarStart: "2026-01-01", calendarEnd: "2026-03-31", calendarContextCode: "user_41", perPage: 17 },
        path: "/api/v1/calendar_events",
        search: "?context_codes%5B%5D=user_41&start_date=2026-01-01&end_date=2026-03-31&per_page=17",
        item: { id: 91, context_code: "user_41" },
      },
      { input: { endpoint: "groupFolders", groupId: 6 }, path: "/api/v1/groups/6/folders", search: "?per_page=100", item: { id: 60, context_type: "Group", context_id: 6, context_code: "group_6" } },
      { input: { endpoint: "groupFolderFiles", groupId: 6, folderId: 60 }, path: "/api/v1/folders/60/files", search: "?per_page=100", item: { id: 503, context_type: "Group", context_id: 6 } },
      { input: { endpoint: "groupPages", groupId: 6 }, path: "/api/v1/groups/6/pages", search: "?per_page=100", item: { id: 61, context_code: "group_6" } },
      { input: { endpoint: "groupPage", groupId: 6, pageSlug: "overview" }, path: "/api/v1/groups/6/pages/overview", search: "", item: { id: 61, url: "overview", context_code: "group_6" }, detail: true },
      { input: { endpoint: "groupDiscussions", groupId: 6 }, path: "/api/v1/groups/6/discussion_topics", search: "?per_page=100", item: { id: 62, context_code: "group_6" } },
      { input: { endpoint: "groupDiscussionEntries", groupId: 6, topicId: 62 }, path: "/api/v1/groups/6/discussion_topics/62/entries", search: "?per_page=100", item: { id: 63, context_code: "group_6" } },
      { input: { endpoint: "groupDiscussionReplies", groupId: 6, topicId: 62, entryId: 63 }, path: "/api/v1/groups/6/discussion_topics/62/entries/63/replies", search: "?per_page=100", item: { id: 64, context_code: "group_6" } },
      { input: { endpoint: "file", groupId: 6, fileId: 503 }, path: "/api/v1/groups/6/files/503", search: "", item: { id: 503, context_type: "Group", context_id: 6 }, detail: true },
      {
        input: { endpoint: "calendarEvents", allEvents: true, calendarContextCode: "group_6", groupId: 6 },
        path: "/api/v1/calendar_events",
        search: "?context_codes%5B%5D=group_6&all_events=true&per_page=100",
        item: { id: 92, context_code: "group_6" },
      },
    ];

    for (const { input, path, search, item, detail = false } of cases) {
      const calls: Array<{ url: URL; init: RequestInit }> = [];
      const fetcher = vi.fn(async (value: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(value));
        calls.push({ url, init });
        if (url.pathname === "/api/v1/users/self/profile") return profile();
        return json(detail || path.endsWith("/503") ? item : [item]);
      });
      await expect(readCanvasBrowserApi({ mode: "read", ...input, expectedUserId: 41 }, fetcher))
        .resolves.toMatchObject({ status: "ok", identity: { userId: 41 } });
      expect(calls.map(({ url }) => url.pathname + url.search)).toEqual([
        "/api/v1/users/self/profile",
        path + search,
      ]);
      expect(calls[1]?.init.method).toBe("GET");
      expect(calls[1]?.init.credentials).toBe("same-origin");
      expect(new Headers(calls[1]?.init.headers).has("authorization")).toBe(false);
    }
  });

  it("requires an explicit valid personal-calendar window of at most 90 inclusive days", async () => {
    const fetcher = vi.fn(async () => profile());
    const invalidWindows = [
      {},
      { calendarStart: "2026-02-30", calendarEnd: "2026-03-01" },
      { calendarStart: "2026-03-02", calendarEnd: "2026-03-01" },
      { calendarStart: "2026-01-01", calendarEnd: "2026-04-01" },
    ];
    for (const window of invalidWindows) {
      await expect(readCanvasBrowserApi({ mode: "read", endpoint: "calendarEvents", expectedUserId: 41, ...window }, fetcher))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects personal-folder and calendar records that escape the bound identity", async () => {
    for (const [input, item] of [
      [{ endpoint: "personalFolders" }, { id: 8, context_type: "User", context_id: 42 }],
      [{ endpoint: "calendarEvents", calendarContextCode: "user_41", calendarStart: "2026-03-01", calendarEnd: "2026-03-01" }, { id: 91, context_code: "user_42" }],
    ] as const) {
      const fetcher = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
        ? profile()
        : json([item]));
      await expect(readCanvasBrowserApi({ mode: "read", ...input, expectedUserId: 41 }, fetcher))
        .rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    }
  });

  it("rejects calendar scopes that do not match the explicit context and group records that escape it", async () => {
    for (const request of [
      { endpoint: "calendarEvents", calendarContextCode: "user_42", calendarStart: "2026-03-01", calendarEnd: "2026-03-01" },
      { endpoint: "calendarEvents", calendarContextCode: "group_6", groupId: 7, calendarStart: "2026-03-01", calendarEnd: "2026-03-01" },
    ]) {
      await expect(readCanvasBrowserApi({ mode: "read", ...request, expectedUserId: 41 }, vi.fn(async () => profile())))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    const mismatchedGroup = vi.fn(async (value: RequestInfo | URL) => {
      const url = new URL(String(value));
      return url.pathname.endsWith("/profile")
        ? profile()
        : json([{ id: 60, context_type: "Group", context_id: 7 }]);
    });
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "groupFolderFiles", groupId: 6, folderId: 60, expectedUserId: 41 }, mismatchedGroup))
      .rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  it("keeps opaque Link cursors bounded and constrained to fixed route queries", async () => {
    const calls: URL[] = [];
    const cursor = "opaque_cursor:next-2";
    const fetcher = vi.fn(async (value: RequestInfo | URL) => {
      const url = new URL(String(value));
      calls.push(url);
      if (url.pathname.endsWith("/profile")) return profile();
      if (url.searchParams.get("page") === cursor) return json([{ id: 2 }]);
      return json([{ id: 1 }], {
        link: `<${ORIGIN}/api/v1/conversations?scope=sent&per_page=1&page=opaque_cursor%3Anext-2>; rel="next"`,
      });
    });
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "conversationsSent", expectedUserId: 41, perPage: 1 }, fetcher))
      .resolves.toMatchObject({ status: "ok", pages: 2, items: [{ id: 1 }, { id: 2 }] });
    expect(calls.at(-1)?.searchParams.get("page")).toBe(cursor);
    expect(calls.at(-1)?.searchParams.get("scope")).toBe("sent");

    const unsafeLinks = [
      `<${ORIGIN}/api/v1/conversations?scope=sent&per_page=1&page=2&page=3>; rel="next"`,
      `<${ORIGIN}/api/v1/conversations?scope=sent&per_page=1&page=${"x".repeat(257)}>; rel="next"`,
      `<${ORIGIN}/api/v1/conversations?scope=archived&per_page=1&page=2>; rel="next"`,
      `<${ORIGIN}/api/v1/conversations?scope=sent&per_page=1&page=3>; rel="next"`,
    ];
    for (const link of unsafeLinks) {
      let pageTwoRequested = false;
      const unsafeFetcher = vi.fn(async (value: RequestInfo | URL) => {
        const url = new URL(String(value));
        if (url.pathname.endsWith("/profile")) return profile();
        if (url.searchParams.has("page")) pageTwoRequested = true;
        return json([{ id: 1 }], { link });
      });
      await expect(readCanvasBrowserApi({ mode: "read", endpoint: "conversationsSent", expectedUserId: 41, perPage: 1 }, unsafeFetcher))
        .rejects.toMatchObject({ code: "UNSAFE_URL" });
      expect(pageTwoRequested).toBe(false);
    }
  });

  it("classifies personal files and bounded calendar 403 as coverage gaps", async () => {
    const denied = vi.fn(async (value: RequestInfo | URL) => new URL(String(value)).pathname.endsWith("/profile")
      ? profile()
      : new Response("", { status: 403, headers: { "content-type": "application/json" } }));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "personalFiles", expectedUserId: 41 }, denied))
      .resolves.toMatchObject({ status: "gap", reason: "FORBIDDEN_OPTIONAL" });
    await expect(readCanvasBrowserApi({
      mode: "read", endpoint: "calendarEvents", expectedUserId: 41,
      calendarContextCode: "user_41",
      calendarStart: "2026-03-01", calendarEnd: "2026-03-01",
    }, denied)).resolves.toMatchObject({ status: "gap", reason: "FORBIDDEN_OPTIONAL" });
  });

  it("allows first-account availability probing without emitting the discovered identity", async () => {
    const enrollmentStates: string[] = [];
    const fetcher = vi.fn(async (value: RequestInfo | URL) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/profile")) return profile();
      if (url.pathname === "/api/v1/courses") {
        enrollmentStates.push(url.searchParams.get("enrollment_state") ?? "");
        return json([]);
      }
      if (url.pathname === "/api/v1/conversations") return json([]);
      throw new Error("Unexpected synthetic URL");
    });
    const result = await readCanvasBrowserApi({ mode: "probe" }, fetcher);
    expect(result).toMatchObject({
      signedInContinuity: "OK",
      accountIdentity: "AVAILABLE_UNBOUND",
      apiShapePagination: "NO_COURSES",
      inboxUnreadState: "NO_UNREAD_ITEMS",
      fileMetadata: "NO_COURSE",
      fileVerifier: "NO_COURSE",
      cookielessDownload: "NO_COURSE",
      nativeDownloader: "NOT_TESTED",
    });
    expect(JSON.stringify(result)).not.toContain("41");
    expect(JSON.stringify(result)).not.toContain("Synthetic learner");
    expect(enrollmentStates).toEqual(["active", "completed"]);
  });
});
