import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { sanitizeCanvasLink } from "../../scripts/canvas-browser-links.mjs";
import { collectCanvasBrowserCapture as collectCanvasBrowserCaptureImpl } from "../../scripts/canvas-browser-capture.mjs";

const USER_ID = 41;
const COURSE_ID = 900001;
const ORIGIN = "https://marymount.instructure.com";
const SYNTHETIC_RUN_ID = 701;
const SYNTHETIC_GENERATION_ID = "c".repeat(32);
const collectCanvasBrowserCapture = (options: Record<string, unknown>) => collectCanvasBrowserCaptureImpl({
  runId: SYNTHETIC_RUN_ID,
  generationId: SYNTHETIC_GENERATION_ID,
  ...options,
} as Parameters<typeof collectCanvasBrowserCaptureImpl>[0]);

type ReaderRequest = {
  mode: string;
  endpoint: string;
  expectedUserId: number;
  courseId?: number;
  groupId?: number;
  folderId?: number;
  accountId?: number;
  conversationId?: number;
  fileId?: number;
  assignmentId?: number;
  pageSlug?: string;
  moduleId?: number;
  topicId?: number;
  entryId?: number;
  quizId?: number;
  calendarStart?: string;
  calendarEnd?: string;
  calendarContextCode?: string;
};

function fakeHtmlReader({ html, options }: { html: string; options: { source: string; baseUrl: string } }) {
  const links = [...html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)]
    .map((match) => sanitizeCanvasLink(match[1] as string, {
      source: options.source,
      title: (match[2] ?? "").replace(/<[^>]*>/gu, " ").trim(),
      baseUrl: options.baseUrl,
    }));
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\b(?:https?:)?\/\/[^\s<>"'`]+/giu, " [link] ")
    .replace(/verifier\s*=\s*[^\s&;,<>"'`]+/giu, "[redacted]")
    .replace(/[\s\u00a0]+/gu, " ")
    .replace(/\s+([.,!?;:])/gu, "$1")
    .trim();
  return { text, links, textTruncated: false, linksTruncated: false };
}

function successfulResult(request: ReaderRequest) {
  const identity = { userId: USER_ID };
  const one = (item: Record<string, unknown>) => ({ status: "ok", identity, pages: 1, items: [item] });
  const list = (items: Array<Record<string, unknown>>, pages = 1) => ({ status: "ok", identity, pages, items });
  switch (request.endpoint) {
    case "profile": return one({
      id: USER_ID,
      account_id: 41,
      name: "Synthetic Student",
      calendar_ics: `${ORIGIN}/feeds/calendar?token=synthetic-feed-secret`,
    });
    case "coursesActive": return list([{ id: COURSE_ID, name: "SYN-101" }], 2);
    case "coursesCompleted": return list([]);
    case "course": return one({ id: request.courseId, name: "Synthetic Course", syllabus_body: "<p>Course overview</p>" });
    case "courseTabs": return list(request.courseId === COURSE_ID ? [{ id: "home", label: "Home" }] : []);
    case "assignments": return list(request.courseId === COURSE_ID
      ? [{
        id: 501,
        course_id: COURSE_ID,
        name: "Synthetic assignment",
        published: true,
        description: "<p>Read <a title=\"Guide\" href=\"/courses/900001/files/900/download?verifier=synthetic-html-secret\">the guide</a> and <a href=\"/courses/900001/files/901/download\">the plain file</a>.</p><script>synthetic-script-secret</script>",
        discussion_topic: { url: `${ORIGIN}/courses/900001/discussion_topics/7?access_token=synthetic-nested-secret` },
      }]
      : []);
    case "assignmentGroups": return list(request.courseId === COURSE_ID ? [{ id: 10, name: "Assignments" }] : []);
    case "submissions": return list(request.courseId === COURSE_ID ? [{ assignment_id: 501, user_id: USER_ID, submitted_at: "2026-09-01T00:00:00Z" }] : []);
    case "submission": return one({ assignment_id: request.assignmentId, user_id: USER_ID, submission_comments: [{ comment: "Synthetic teacher feedback" }] });
    case "pages": return list(request.courseId === COURSE_ID
      ? [{ page_id: 1, url: "overview", title: "Overview", published: true, body: "<p>Page text</p>" }]
      : []);
    case "page": return one({ page_id: 1, url: request.pageSlug, title: "Overview detail", published: true, body: "<p>Detail text</p>" });
    case "modules": return list(request.courseId === COURSE_ID ? [{ id: 2, name: "Week One", state: "unlocked" }] : []);
    case "moduleItems": return list([{ id: 21, module_id: request.moduleId, title: "Page item" }]);
    case "discussions": return list(request.courseId === COURSE_ID ? [{ id: 6, title: "Welcome", published: true }] : []);
    case "discussionEntries": return list([{ id: 61, message: "<p>Synthetic post</p>" }]);
    case "discussionReplies": return list([{ id: 62, parent_id: request.entryId, message: "<p>Synthetic reply</p>" }]);
    case "announcements": return list(request.courseId === COURSE_ID ? [{ id: 31, message: "<p>Synthetic announcement</p>" }] : []);
    case "quizzes": return list(request.courseId === COURSE_ID ? [{ id: 101, title: "Review quiz", published: true }] : []);
    case "quiz": return one({ id: request.quizId, title: "Review quiz detail", published: true });
    case "courseFiles": return list([{ id: 900, display_name: "Guide", url: `${ORIGIN}/files/900/download?verifier=synthetic-file-secret` }]);
    case "folders": return list([{ id: 1, name: "Course Files" }]);
    case "groups": return list([{ id: 7, name: "Synthetic Group" }]);
    case "groupFolders": return list([{ id: 70, name: "Group Files", context_type: "Group", context_id: 7 }]);
    case "groupFolderFiles": return list([{
      id: 901,
      folder_id: request.folderId,
      context_type: "Group",
      context_id: request.groupId,
      display_name: "Group reading",
      url: `${ORIGIN}/files/901/download?verifier=synthetic-group-file-secret`,
    }]);
    case "groupPages": return list([{ page_id: 7, url: "group-overview", title: "Group overview", published: true }]);
    case "groupPage": return one({ page_id: 7, url: request.pageSlug, title: "Group page", published: true, body: "<p>Group page body</p>" });
    case "groupDiscussions": return list([{ id: 71, title: "Group discussion", published: true }]);
    case "groupDiscussionEntries": return list([{ id: 711, message: "<p>Group post</p>" }]);
    case "groupDiscussionReplies": return list([{ id: 712, parent_id: request.entryId, message: "<p>Group reply</p>" }]);
    case "personalFiles": return list([{ id: 900, display_name: "Personal Guide", url: `${ORIGIN}/files/900/download?verifier=synthetic-personal-file-secret` }]);
    case "personalFolders": return list([{ id: 17, name: "Personal Folder" }]);
    case "file": return one({
      id: request.fileId,
      ...(request.groupId === undefined ? {} : { context_type: "Group", context_id: request.groupId }),
      display_name: request.groupId === undefined ? "Course file detail" : "Group file detail",
      url: `${ORIGIN}/files/${request.fileId}/download?verifier=synthetic-file-detail-secret`,
    });
    case "personalFile": return one({ id: request.fileId, display_name: "Personal file detail", url: `${ORIGIN}/files/${request.fileId}/download?verifier=synthetic-personal-detail-secret` });
    case "inbox": return list([{ id: 300, subject: "Synthetic thread" }]);
    case "inboxAll": return list([{ id: 300, subject: "Unread thread" }, { id: 301, subject: "Read thread" }]);
    case "conversationsSent": return list([{ id: 301, subject: "Sent thread" }, { id: 302, subject: "Another sent thread" }]);
    case "conversationsArchived": return list([{ id: 302, subject: "Archived thread" }, { id: 303, subject: "Other archived thread" }]);
    case "conversation": return one({ id: request.conversationId, subject: "Synthetic thread", messages: [{ body: "<p>Private-looking message content</p>" }] });
    case "calendarEvents": return list([{
      id: 808,
      title: "Synthetic event",
      context_code: request.calendarContextCode,
      start_at: "2026-09-27T12:00:00Z",
    }]);
    default: throw new Error(`Unexpected endpoint ${request.endpoint}`);
  }
}

function testDependencies(overrides: {
  resultFor?: (request: ReaderRequest) => unknown;
  progress?: (event: Record<string, unknown>) => void | Promise<void>;
} = {}) {
  const reader = vi.fn((input: unknown) => (overrides.resultFor ?? successfulResult)(input as ReaderRequest));
  const htmlReader = (input: unknown) => fakeHtmlReader(input as Parameters<typeof fakeHtmlReader>[0]);
  const evaluate = vi.fn(async (fn: (input: unknown) => unknown, input: unknown) => {
    if (fn === reader) return reader(input as ReaderRequest);
    if (fn === htmlReader) return htmlReader(input);
    throw new Error("Unexpected evaluator function");
  });
  const progressEvents: Record<string, unknown>[] = [];
  const progress = vi.fn(async (event: Record<string, unknown>) => {
    progressEvents.push(event);
    await overrides.progress?.(event);
  });
  return { reader, htmlReader, evaluate, progress, progressEvents };
}

describe("synthetic Canvas metadata collector", () => {
  it("captures only complete fixed-endpoint reads, sanitizes nested links and records endpoint gaps", async () => {
    const deps = testDependencies();
    const capture = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: deps.evaluate,
      reader: deps.reader,
      htmlReader: deps.htmlReader,
      progress: deps.progress,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
    });

    expect(capture).toMatchObject({
      schemaVersion: 2,
      source: "canvas-browser",
      runId: SYNTHETIC_RUN_ID,
      generationId: SYNTHETIC_GENERATION_ID,
      capturedAt: "2026-09-27T12:00:00.000Z",
      complete: false,
      identity: { origin: ORIGIN, userId: USER_ID, accountId: 41 },
      activeCourses: { complete: true, courseIds: [COURSE_ID] },
      coverageRequirements: {
        activeCoursesComplete: true,
        perActiveCourse: ["course", "assignments", "assignmentGroups", "submissions"],
      },
    });
    expect(capture.resources.find((resource) => resource.endpoint === "coursesActive")?.pages).toBe(2);
    expect(capture.coverage).toContainEqual({ endpoint: "coursesActive", courseId: null, status: "complete" });
    for (const endpoint of ["course", "assignments", "assignmentGroups", "submissions"]) {
      expect(capture.coverage).toContainEqual({ endpoint, courseId: COURSE_ID, status: "complete" });
    }
    expect(capture.resources.some((resource) => resource.endpoint === "assignments" && resource.courseId === COURSE_ID)).toBe(true);
    expect(capture.resources.some((resource) => resource.endpoint === "conversation")).toBe(true);
    expect(capture.resources.map((resource) => resource.endpoint)).toEqual(expect.arrayContaining([
      "courseTabs", "assignments", "assignmentGroups", "submissions", "submission", "pages", "page",
      "modules", "moduleItems", "discussions", "discussionEntries", "discussionReplies",
      "announcements", "quizzes", "quiz", "courseFiles", "folders", "file",
      "groups", "personalFiles", "personalFolders", "personalFile", "inboxAll",
      "conversationsSent", "conversationsArchived", "calendarEvents",
    ]));
    for (const endpoint of [
      "course", "courseTabs", "assignments", "assignmentGroups", "submissions", "pages", "page",
      "modules", "moduleItems", "discussions", "discussionEntries", "discussionReplies",
      "announcements", "quizzes", "quiz", "courseFiles", "folders",
    ]) {
      expect(capture.coverage).toContainEqual({ endpoint, courseId: COURSE_ID, status: "complete" });
    }
    for (const endpoint of ["groups", "personalFiles", "personalFolders", "personalFile", "file", "inboxAll", "conversationsSent", "conversationsArchived"]) {
      expect(capture.coverage).toContainEqual({ endpoint, courseId: null, status: "complete" });
    }
    for (const endpoint of ["groupFolders", "groupFolderFiles", "groupPages", "groupPage", "groupDiscussions", "groupDiscussionEntries", "groupDiscussionReplies"]) {
      expect(capture.coverage).toContainEqual({ endpoint, courseId: null, groupId: 7, status: "complete" });
    }
    expect(capture.coverage).toContainEqual({ endpoint: "calendarEvents", courseId: null, contextCode: "user_41", status: "complete" });
    expect(capture.coverage).toContainEqual({ endpoint: "calendarEvents", courseId: null, contextCode: "account_41", status: "complete" });
    expect(capture.coverage).toContainEqual({ endpoint: "calendarEvents", courseId: COURSE_ID, contextCode: `course_${COURSE_ID}`, status: "complete" });
    expect(capture.coverage).toContainEqual({ endpoint: "calendarEvents", courseId: null, groupId: 7, contextCode: "group_7", status: "complete" });
    expect(capture.coverage).toContainEqual({ endpoint: "fileBodies", courseId: null, status: "gap", reason: "not-attempted" });
    expect(capture.coverage.some((entry) => entry.endpoint === "calendarEventsHistory")).toBe(false);
    expect(capture.coverage).toContainEqual({ endpoint: "assignmentGroups", courseId: COURSE_ID, status: "complete" });
    expect(capture.coverage).toContainEqual({ endpoint: "calendar", courseId: COURSE_ID, status: "gap", reason: "not-attempted" });

    const assignment = capture.resources.find((resource) => resource.endpoint === "assignments" && resource.courseId === COURSE_ID)?.items[0] as Record<string, unknown> | undefined;
    expect(assignment?.description).toBe("Read the guide and the plain file.");
    expect(assignment?._canvasLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ safeTarget: null, clickable: false, reason: "access-url-removed" }),
      expect.objectContaining({ safeTarget: null, clickable: false, reason: "file-url-removed" }),
    ]));
    expect(assignment?.discussion_topic).toMatchObject({ url: null });

    const courseFile = capture.resources.find((resource) => resource.endpoint === "courseFiles")?.items[0] as Record<string, unknown> | undefined;
    const fileDetail = capture.resources.find((resource) => resource.endpoint === "file")?.items[0] as Record<string, unknown> | undefined;
    const personalFileDetail = capture.resources.find((resource) => resource.endpoint === "personalFile")?.items[0] as Record<string, unknown> | undefined;
    expect(courseFile?.url).toBeNull();
    expect(courseFile?._canvasLinks).toEqual([]);
    expect(fileDetail?.url).toBeNull();
    expect(fileDetail?._canvasLinks).toEqual([]);
    expect(personalFileDetail?.url).toBeNull();
    expect(personalFileDetail?._canvasLinks).toEqual([]);

    const serialized = JSON.stringify(capture);
    for (const privateValue of [
      "synthetic-feed-secret",
      "synthetic-html-secret",
      "synthetic-nested-secret",
      "synthetic-file-secret",
      "synthetic-personal-file-secret",
      "synthetic-file-detail-secret",
      "synthetic-personal-detail-secret",
      "synthetic-group-file-secret",
      "synthetic-script-secret",
      "calendar_ics",
    ]) expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain("/courses/900001/files/900/download");
    expect(serialized).not.toContain("/files/900/download");
    expect(JSON.stringify(deps.progressEvents)).not.toMatch(/https?:|synthetic/u);
    expect(deps.progressEvents.filter((event) => event.phase === "request-start")).toHaveLength(deps.reader.mock.calls.length);
    expect(deps.progressEvents.filter((event) => event.phase === "request-complete")).toHaveLength(deps.reader.mock.calls.length);
    expect(deps.reader.mock.calls.every(([input]) => (input as ReaderRequest).expectedUserId === USER_ID)).toBe(true);
    expect(deps.reader.mock.calls.some(([input]) => {
      const request = input as ReaderRequest;
      return request.endpoint === "conversation" && request.conversationId === 300;
    })).toBe(true);
    const requests = deps.reader.mock.calls.map(([input]) => input as ReaderRequest);
    const conversationRequests = requests.filter((request) => request.endpoint === "conversation");
    expect(conversationRequests.map((request) => request.conversationId)).toEqual([300, 301, 302, 303]);
    expect(requests.filter((request) => request.endpoint === "file" && request.fileId === 900)).toHaveLength(1);
    expect(requests.filter((request) => request.endpoint === "file" && request.fileId === 901 && request.groupId === 7)).toHaveLength(1);
    expect(requests.filter((request) => request.endpoint === "personalFile" && request.fileId === 900)).toHaveLength(1);
    expect(requests.find((request) => request.endpoint === "calendarEvents")).toMatchObject({
      allEvents: true,
      calendarContextCode: "user_41",
    });
    expect(requests.filter((request) => request.endpoint === "calendarEvents").map((request) => request.calendarContextCode))
      .toEqual(["user_41", "account_41", "course_900001", "group_7"]);
    expect(capture.resources).toContainEqual(expect.objectContaining({ endpoint: "calendarEvents", contextCode: "group_7", groupId: 7 }));
    expect(capture.resources).toContainEqual(expect.objectContaining({ endpoint: "courseFiles", groupId: 7 }));
    expect(capture.resources).toContainEqual(expect.objectContaining({ endpoint: "pages", groupId: 7 }));
    expect(capture.resources).toContainEqual(expect.objectContaining({ endpoint: "discussions", groupId: 7 }));
    const schema = JSON.parse(readFileSync(new URL("../../docs/CANVAS-CAPTURE-SCHEMA.json", import.meta.url), "utf8")) as {
      properties: { resources: { items: { properties: { endpoint: { enum: string[] } } } } };
    };
    const allowedResourceEndpoints = new Set(schema.properties.resources.items.properties.endpoint.enum);
    expect(capture.resources.every((resource) => allowedResourceEndpoints.has(resource.endpoint))).toBe(true);
    expect(requests.every((request) => request.expectedUserId === USER_ID)).toBe(true);
    const requestFor = (endpoint: string) => deps.reader.mock.calls
      .map(([input]) => input as ReaderRequest)
      .find((request) => request.endpoint === endpoint && request.courseId === COURSE_ID);
    expect(requestFor("page")?.pageSlug).toBe("overview");
    expect(requestFor("moduleItems")?.moduleId).toBe(2);
    expect(requestFor("discussionEntries")?.topicId).toBe(6);
    expect(requestFor("discussionReplies")).toMatchObject({ topicId: 6, entryId: 61 });
    expect(requestFor("submission")?.assignmentId).toBe(501);
    expect(requestFor("quiz")?.quizId).toBe(101);
  });

  it("requires a native run and reserved generation ID before collecting", async () => {
    // @ts-expect-error Missing lease linkage is the behavior this case rejects.
    await expect(collectCanvasBrowserCaptureImpl({ expectedUserId: USER_ID,
      evaluate: vi.fn(), reader: vi.fn(), htmlReader: vi.fn() })).rejects.toThrow("CAPTURE_LINKAGE_REQUIRED");
  });

  it("stages group-owned file bodies through the shared file capture callback", async () => {
    const deps = testDependencies();
    const downloadFile = vi.fn(async ({ fileId }: { fileId: number }) => ({
      kind: "staged",
      fileId,
      byteCount: 1,
      stagedFile: "d".repeat(32) + ".blob",
      sha256: "e".repeat(64),
      contentType: "application/pdf",
      sourceAuthenticity: "unverified",
    }));
    const capture = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: deps.evaluate,
      reader: deps.reader,
      htmlReader: deps.htmlReader,
      downloadFile,
    });
    expect(downloadFile.mock.calls.some(([request]) => request.fileId === 901)).toBe(true);
    expect(capture.resources.find((resource) => resource.endpoint === "fileBodies")?.items)
      .toContainEqual(expect.objectContaining({ fileId: 901, status: "staged" }));
    expect(capture.resources).toContainEqual(expect.objectContaining({ endpoint: "courseFiles", groupId: 7 }));
    expect(capture.resources).toContainEqual(expect.objectContaining({ endpoint: "file", groupId: 7 }));
  });

  it("requires the owner-confirmed user ID and stops before course reads on a profile mismatch", async () => {
    const missingBinding = testDependencies();
    await expect(collectCanvasBrowserCapture({
      expectedUserId: undefined as unknown as number,
      evaluate: missingBinding.evaluate,
      reader: missingBinding.reader,
      htmlReader: missingBinding.htmlReader,
    })).rejects.toMatchObject({ code: "EXPECTED_USER_ID_REQUIRED" });
    expect(missingBinding.reader).not.toHaveBeenCalled();

    const mismatch = testDependencies({
      resultFor: () => ({
        status: "ok",
        identity: { userId: USER_ID + 1 },
        pages: 1,
        items: [{ id: USER_ID + 1 }],
      }),
    });
    await expect(collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: mismatch.evaluate,
      reader: mismatch.reader,
      htmlReader: mismatch.htmlReader,
      progress: mismatch.progress,
    })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(mismatch.reader).toHaveBeenCalledTimes(1);
  });

  it("fails closed for partial pages and missing mandatory per-course sections", async () => {
    const partial = testDependencies({
      resultFor: (request) => request.endpoint === "coursesActive"
        ? { status: "sampled", identity: { userId: USER_ID }, pages: 1, items: [{ id: COURSE_ID }] }
        : successfulResult(request),
    });
    await expect(collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: partial.evaluate,
      reader: partial.reader,
      htmlReader: partial.htmlReader,
    })).rejects.toMatchObject({ code: "PAGINATION_INCOMPLETE" });

    const assignmentsGap = testDependencies({
      resultFor: (request) => request.endpoint === "assignments"
        ? { status: "gap", reason: "FORBIDDEN_OPTIONAL", identity: { userId: USER_ID }, pages: 0, items: [] }
        : successfulResult(request),
    });
    await expect(collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: assignmentsGap.evaluate,
      reader: assignmentsGap.reader,
      htmlReader: assignmentsGap.htmlReader,
    })).rejects.toMatchObject({ code: "REQUIRED_SECTION_INCOMPLETE" });
  });

  it("accepts documented optional-section gaps and keeps progress errors content-free", async () => {
    const deniedOptionalEndpoints = [
      "pages", "modules", "discussions", "quizzes", "submission", "groups", "personalFiles",
      "personalFolders", "inboxAll", "conversationsSent", "conversationsArchived", "calendarEvents",
      "conversation", "file",
    ];
    const optionalGap = testDependencies({
      resultFor: (request) => deniedOptionalEndpoints.includes(request.endpoint)
        ? { status: "gap", reason: "FORBIDDEN_OPTIONAL", identity: { userId: USER_ID }, pages: 0, items: [] }
        : successfulResult(request),
    });
    const capture = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: optionalGap.evaluate,
      reader: optionalGap.reader,
      htmlReader: optionalGap.htmlReader,
    });
    expect(capture.resources.some((resource) => resource.endpoint === "pages")).toBe(false);
    expect(capture.coverage).toContainEqual({ endpoint: "pages", courseId: COURSE_ID, status: "gap", reason: "forbidden-optional" });
    for (const endpoint of ["page", "moduleItems", "discussionEntries", "discussionReplies", "quiz"]) {
      expect(capture.coverage).toContainEqual({ endpoint, courseId: COURSE_ID, status: "gap", reason: "not-attempted" });
    }
    expect(capture.coverage).toContainEqual({ endpoint: "submission", courseId: COURSE_ID, status: "gap", reason: "forbidden-optional" });
    for (const endpoint of ["groups", "personalFiles", "personalFolders", "inboxAll", "conversationsSent", "conversationsArchived", "conversation", "file"]) {
      expect(capture.coverage).toContainEqual({ endpoint, courseId: null, status: "gap", reason: "forbidden-optional" });
    }
    expect(capture.coverage).toContainEqual({ endpoint: "calendarEvents", courseId: null, contextCode: "user_41", status: "gap", reason: "forbidden-optional" });
    expect(capture.coverage).toContainEqual({ endpoint: "calendarEvents", courseId: null, contextCode: "account_41", status: "gap", reason: "forbidden-optional" });
    expect(capture.coverage).toContainEqual({ endpoint: "calendarEvents", courseId: COURSE_ID, contextCode: `course_${COURSE_ID}`, status: "gap", reason: "forbidden-optional" });
    expect(capture.coverage).toContainEqual({ endpoint: "personalFile", courseId: null, status: "gap", reason: "not-attempted" });

    const failedRead = testDependencies({
      resultFor: (request) => request.endpoint === "profile"
        ? successfulResult(request)
        : Promise.reject(new Error("https://private.invalid/?token=synthetic-secret")),
    });
    await expect(collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: failedRead.evaluate,
      reader: failedRead.reader,
      htmlReader: failedRead.htmlReader,
      progress: failedRead.progress,
    })).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    expect(JSON.stringify(failedRead.progressEvents)).not.toMatch(/private\.invalid|synthetic-secret|https?:/u);
  });

  it("bridges fixed per-request reader statuses through an injected page binding", async () => {
    const deps = testDependencies();
    let readerProgress: ((state: string) => Promise<void>) | undefined;
    const bindings: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const page = {
      exposeFunction: vi.fn(async (_name: string, callback: (state: string) => Promise<void>) => {
        if (readerProgress) throw new Error("binding already exists");
        readerProgress = callback;
        const binding = { dispose: vi.fn(async () => { readerProgress = undefined; }) };
        bindings.push(binding);
        return binding;
      }),
    };
    const evaluate = vi.fn(async (fn: (input: unknown) => unknown, input: unknown) => {
      if (fn === deps.reader) {
        await readerProgress?.("CANVAS_GET_STARTED");
        const result = await deps.evaluate(fn, input);
        await readerProgress?.("CANVAS_GET_FINISHED");
        await readerProgress?.("https://private.invalid/?token=ignored");
        return result;
      }
      return deps.evaluate(fn, input);
    });

    const capture = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      page,
      evaluate,
      reader: deps.reader,
      htmlReader: deps.htmlReader,
      progress: deps.progress,
    });

    expect(capture.resources.length).toBeGreaterThan(0);
    expect(page.exposeFunction).toHaveBeenCalledWith("__duegoodCanvasReaderProgress", expect.any(Function));
    expect(bindings[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(readerProgress).toBeUndefined();
    const refreshed = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      page,
      evaluate,
      reader: deps.reader,
      htmlReader: deps.htmlReader,
      progress: deps.progress,
    });
    expect(refreshed.resources.length).toBeGreaterThan(0);
    expect(page.exposeFunction).toHaveBeenCalledTimes(2);
    expect(bindings).toHaveLength(2);
    expect(bindings.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    expect(deps.progressEvents.some((event) => event.phase === "canvas-request-start")).toBe(true);
    expect(deps.progressEvents.some((event) => event.phase === "canvas-request-complete")).toBe(true);
    expect(JSON.stringify(deps.progressEvents)).not.toMatch(/private\.invalid|ignored|https?:|synthetic/u);
  });

  it("rejects unsafe page slugs and skips locked or unpublished content", async () => {
    const deps = testDependencies({
      resultFor: (request) => {
        if (request.endpoint === "pages" && request.courseId === COURSE_ID) {
          return { status: "ok", identity: { userId: USER_ID }, pages: 1, items: [{ page_id: 1, url: "../unsafe?token=synthetic-private", published: true }] };
        }
        if (request.endpoint === "modules" && request.courseId === COURSE_ID) {
          return { status: "ok", identity: { userId: USER_ID }, pages: 1, items: [{ id: 2, state: "locked", published: true }] };
        }
        if (request.endpoint === "discussions" && request.courseId === COURSE_ID) {
          return { status: "ok", identity: { userId: USER_ID }, pages: 1, items: [{ id: 6, published: false }] };
        }
        if (request.endpoint === "quizzes" && request.courseId === COURSE_ID) {
          return { status: "ok", identity: { userId: USER_ID }, pages: 1, items: [{ id: 101, published: false }] };
        }
        return successfulResult(request);
      },
    });
    const capture = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: deps.evaluate,
      reader: deps.reader,
      htmlReader: deps.htmlReader,
    });

    const requestedEndpoints = deps.reader.mock.calls.map(([input]) => (input as ReaderRequest).endpoint);
    for (const endpoint of ["page", "moduleItems", "discussionEntries", "discussionReplies", "quiz"]) {
      expect(requestedEndpoints).not.toContain(endpoint);
    }
    for (const endpoint of ["page", "moduleItems", "discussionEntries", "discussionReplies", "quiz"]) {
      expect(capture.coverage).toContainEqual({ endpoint, courseId: COURSE_ID, status: "gap", reason: "not-attempted" });
    }
    expect(JSON.stringify(capture)).not.toContain("synthetic-private");
  });

  it("caps per-page detail enumeration and reports the unattempted remainder", async () => {
    const deps = testDependencies({
      resultFor: (request) => request.endpoint === "pages" && request.courseId === COURSE_ID
        ? {
          status: "ok",
          identity: { userId: USER_ID },
          pages: 1,
          items: Array.from({ length: 1002 }, (_, index) => ({
            page_id: index + 1,
            url: `page-${index + 1}`,
            title: `Synthetic page ${index + 1}`,
            published: true,
          })),
        }
        : successfulResult(request),
    });
    const capture = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: deps.evaluate,
      reader: deps.reader,
      htmlReader: deps.htmlReader,
    });
    const pageRequests = deps.reader.mock.calls
      .map(([input]) => input as ReaderRequest)
      .filter((request) => request.endpoint === "page" && request.courseId === COURSE_ID);

    expect(pageRequests).toHaveLength(1000);
    expect(pageRequests[0]?.pageSlug).toBe("page-1");
    expect(pageRequests.at(-1)?.pageSlug).toBe("page-1000");
    expect(capture.coverage).toContainEqual({ endpoint: "page", courseId: COURSE_ID, status: "gap", reason: "not-attempted" });
  });

  it("caps personal file detail reads and records denied and unattempted coverage", async () => {
    const deps = testDependencies({
      resultFor: (request) => {
        if (request.endpoint === "personalFiles") {
          return {
            status: "ok",
            identity: { userId: USER_ID },
            pages: 1,
            items: Array.from({ length: 1501 }, (_, index) => ({ id: index + 1, display_name: `File ${index + 1}` })),
          };
        }
        if (request.endpoint === "personalFile") {
          return { status: "gap", reason: "FORBIDDEN_OPTIONAL", identity: { userId: USER_ID }, pages: 0, items: [] };
        }
        return successfulResult(request);
      },
    });
    const capture = await collectCanvasBrowserCapture({
      expectedUserId: USER_ID,
      evaluate: deps.evaluate,
      reader: deps.reader,
      htmlReader: deps.htmlReader,
    });
    const personalFileRequests = deps.reader.mock.calls
      .map(([input]) => input as ReaderRequest)
      .filter((request) => request.endpoint === "personalFile");

    expect(personalFileRequests).toHaveLength(1500);
    expect(personalFileRequests[0]?.fileId).toBe(1);
    expect(personalFileRequests.at(-1)?.fileId).toBe(1500);
    expect(capture.coverage).toContainEqual({ endpoint: "personalFile", courseId: null, status: "gap", reason: "forbidden-optional" });
    expect(capture.coverage).toContainEqual({ endpoint: "personalFile", courseId: null, status: "gap", reason: "not-attempted" });
  });

  it("records an optional request failure as a gap and keeps later sections", async () => {
    const deps = testDependencies({ resultFor: (request) => {
      if (request.endpoint === "quizzes") throw new Error("page.evaluate: Error: REQUEST_FAILED");
      return successfulResult(request);
    } });
    const capture = await collectCanvasBrowserCapture({ expectedUserId: USER_ID,
      evaluate: deps.evaluate, reader: deps.reader, htmlReader: deps.htmlReader });
    expect(capture.coverage).toContainEqual({ endpoint: "quizzes", courseId: COURSE_ID,
      status: "gap", reason: "request-failed" });
    expect(capture.coverage).toContainEqual({ endpoint: "quiz", courseId: COURSE_ID,
      status: "gap", reason: "not-attempted" });
    expect(capture.resources.some((resource) => resource.endpoint === "courseFiles")).toBe(true);
  });

  it("accepts replies whose immediate parent is another reply under the requested entry", async () => {
    const deps = testDependencies({ resultFor: (request) => request.endpoint === "discussionReplies"
      ? { status: "ok", identity: { userId: USER_ID }, pages: 1,
        items: [{ id: 62, parent_id: 61 }, { id: 63, parent_id: 62 }] }
      : successfulResult(request) });
    const capture = await collectCanvasBrowserCapture({ expectedUserId: USER_ID,
      evaluate: deps.evaluate, reader: deps.reader, htmlReader: deps.htmlReader });
    expect(capture.resources.find((resource) => resource.endpoint === "discussionReplies" && resource.courseId === COURSE_ID)?.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 63, parent_id: 62 })]));
  });

  it("records an unproven optional 404 as a gap across Playwright's error boundary", async () => {
    const deps = testDependencies({ resultFor: (request) => {
      if (request.endpoint === "quizzes") throw new Error("page.evaluate: Error: NOT_FOUND");
      return successfulResult(request);
    } });
    const capture = await collectCanvasBrowserCapture({ expectedUserId: USER_ID,
      evaluate: deps.evaluate, reader: deps.reader, htmlReader: deps.htmlReader });
    expect(capture.coverage).toContainEqual({ endpoint: "quizzes", courseId: COURSE_ID,
      status: "gap", reason: "not-found" });
    expect(capture.resources.some((resource) => resource.endpoint === "quizzes" && resource.courseId === COURSE_ID)).toBe(false);
  });

  it("allows a file callback to take over ten minutes but fails after the thirty-minute capture budget", async () => {
    const baseTime = Date.now();
    let elapsedMs = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => baseTime + elapsedMs);
    const stagedFile = {
      kind: "staged",
      fileId: 900,
      byteCount: 9,
      stagedFile: "a".repeat(32) + ".blob",
      sha256: "b".repeat(64),
      contentType: "application/pdf",
      sourceAuthenticity: "unverified",
    };
    const captureWithDelay = (delayMs: number) => {
      const deps = testDependencies({ resultFor: (request) => request.endpoint === "groups"
        ? { status: "ok", identity: { userId: USER_ID }, pages: 1, items: [] }
        : successfulResult(request) });
      return collectCanvasBrowserCapture({
        expectedUserId: USER_ID,
        evaluate: deps.evaluate,
        reader: deps.reader,
        htmlReader: deps.htmlReader,
        downloadFile: async () => {
          elapsedMs += delayMs;
          return stagedFile;
        },
        now: () => new Date("2026-09-27T12:00:00.000Z"),
      });
    };

    try {
      const capture = await captureWithDelay(11 * 60_000);
      expect(capture.resources.find((resource) => resource.endpoint === "fileBodies")?.items)
        .toEqual([expect.objectContaining({ fileId: 900, status: "staged" })]);

      elapsedMs = 0;
      await expect(captureWithDelay(30 * 60_000 + 1))
        .rejects.toMatchObject({ code: "CAPTURE_BUDGET_EXCEEDED" });
    } finally {
      clock.mockRestore();
    }
  });

});
