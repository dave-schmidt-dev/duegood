import { describe, expect, it, vi } from "vitest";
import {
  COURSE_ID,
  USER_ID,
  collectCanvasBrowserCapture,
  successfulResult,
  testDependencies,
  type ReaderRequest,
} from "./canvas-browser-collector-fixture";
import { readCanvasBrowserApi } from "../../scripts/canvas-browser-reader.mjs";

const emptyList = () => ({
  status: "ok",
  identity: { userId: USER_ID },
  pages: 1,
  items: [],
});

function baseResult(request: ReaderRequest) {
  if (["groups", "personalFiles", "personalFolders"].includes(request.endpoint)) return emptyList();
  return successfulResult(request);
}

function stagedFile(fileId: number) {
  return {
    kind: "staged",
    fileId,
    byteCount: 1,
    sha256: "a".repeat(64),
    contentType: "application/octet-stream",
    stagedFile: `${fileId.toString(16).padStart(32, "0")}.blob`,
    sourceAuthenticity: "unverified",
  };
}

async function captureWith(resultFor: (request: ReaderRequest) => unknown, downloadFile = vi.fn(async ({ fileId }: { fileId: number }) => stagedFile(fileId))) {
  const deps = testDependencies({ resultFor: (request) => {
    const result = resultFor(request);
    if (result instanceof Error) throw result;
    return result;
  } });
  const capture = await collectCanvasBrowserCapture({
    expectedUserId: USER_ID,
    evaluate: deps.evaluate,
    reader: deps.reader,
    htmlReader: deps.htmlReader,
    downloadFile,
  });
  return { capture, deps, downloadFile };
}

describe("linked Canvas file capture", () => {
  it("fetches a link-only course file when the Files tab is forbidden", async () => {
    const resultFor = (request: ReaderRequest) => {
      if (request.endpoint === "courseFiles") {
        return { status: "gap", reason: "FORBIDDEN_OPTIONAL", identity: { userId: USER_ID }, pages: 0, items: [] };
      }
      return baseResult(request);
    };
    const { capture, deps, downloadFile } = await captureWith(resultFor);
    const fileRequests = deps.reader.mock.calls.map(([input]) => input as ReaderRequest)
      .filter((request) => request.endpoint === "file" && request.fileId === 901);

    expect(fileRequests).toHaveLength(1);
    expect(capture.resources).toContainEqual(expect.objectContaining({ endpoint: "file", courseId: COURSE_ID,
      items: [expect.objectContaining({ id: 901 })] }));
    expect(capture.resources.find((resource) => resource.endpoint === "fileBodies")?.items)
      .toContainEqual(expect.objectContaining({ fileId: 901, status: "staged" }));
    expect(downloadFile).toHaveBeenCalledWith(expect.objectContaining({ fileId: 901 }));
    expect(capture.complete).toBe(true);
  });

  it("collects topic, entry, singular attachment, reply, and embedded recent-reply IDs once", async () => {
    const resultFor = (request: ReaderRequest) => {
      if (request.endpoint === "groups") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1, items: [{ id: 7, name: "Group" }] };
      }
      if (request.endpoint === "groupPages") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ page_id: 7, url: "group-overview", title: "Group page", published: true, attachments: [{ id: 1208 }] }] };
      }
      if (request.endpoint === "groupDiscussions") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ id: 71, title: "Group topic", message: "<p>Group prompt</p>", published: true, attachments: [{ id: 1209 }] }] };
      }
      if (request.endpoint === "groupDiscussionEntries") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ id: 711, message: "Group entry", attachment: { id: 1210 } }] };
      }
      if (request.endpoint === "groupDiscussionReplies") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ id: 712, parent_id: request.entryId, attachments: [{ id: 1211 }] }] };
      }
      if (request.endpoint === "discussions") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ id: 6, title: "Topic", message: "<p>Synthetic prompt</p>", published: true, attachments: [{ id: 1201 }] }] };
      }
      if (request.endpoint === "discussionEntries") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ id: 61, message: "Entry", attachments: [{ id: 1202 }], attachment: { id: 1203 } }] };
      }
      if (request.endpoint === "discussionReplies") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ id: 62, parent_id: 61, attachment: { id: 1204 }, recent_replies: [{ id: 63, attachments: [{ id: 1205 }] }] }] };
      }
      if (request.endpoint === "pages") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ page_id: 1, url: "overview", title: "Overview", published: true, attachments: [{ id: 1206 }] }] };
      }
      if (request.endpoint === "announcements") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ id: 31, message: "Announcement", attachments: [{ id: 1207 }] }] };
      }
      return baseResult(request);
    };
    const { capture, deps, downloadFile } = await captureWith(resultFor);
    const expectedIds = [1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208, 1209, 1210, 1211];
    for (const fileId of expectedIds) {
      expect(deps.reader.mock.calls.map(([input]) => input as ReaderRequest)
        .filter((request) => request.endpoint === "file" && request.fileId === fileId)).toHaveLength(1);
    }
    expect(downloadFile.mock.calls.map(([request]) => request.fileId)).toEqual(expect.arrayContaining(expectedIds));
    expect(capture.resources.find((resource) => resource.endpoint === "fileBodies")?.items
      .filter((receipt) => expectedIds.includes(receipt.fileId as number))).toHaveLength(expectedIds.length);
  });

  it("deduplicates IDs shared by attachments and ignores cross-origin file paths", async () => {
    const resultFor = (request: ReaderRequest) => {
      if (request.endpoint === "assignments") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1, items: [{
          id: 501, course_id: COURSE_ID, name: "Assignment", published: true,
          attachments: [{ id: 1301 }, { id: 1301 }],
          description: "<a href=\"https://outside.example/files/1302\">Outside</a> <a href=\"https://marymount.instructure.com/courses/999/files/1303\">Other course</a> <a href=\"/files/1304\">Course file</a>",
        }] };
      }
      if (request.endpoint === "discussions") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1,
          items: [{ id: 6, title: "Topic", message: "<p>Synthetic prompt</p>", published: true, attachments: [{ id: 1301 }] }] };
      }
      return baseResult(request);
    };
    const { capture, deps, downloadFile } = await captureWith(resultFor);
    const requests = deps.reader.mock.calls.map(([input]) => input as ReaderRequest);
    const assignment = capture.resources.find((resource) => resource.endpoint === "assignments"
      && resource.courseId === COURSE_ID)?.items[0] as Record<string, unknown>;
    expect(requests.filter((request) => request.endpoint === "file" && request.fileId === 1301)).toHaveLength(1);
    expect(requests.some((request) => request.endpoint === "file" && request.fileId === 1302)).toBe(false);
    expect(requests.some((request) => request.endpoint === "file" && request.fileId === 1303)).toBe(false);
    expect(requests.filter((request) => request.endpoint === "file" && request.fileId === 1304)).toHaveLength(1);
    expect(capture.resources)
      .toContainEqual(expect.objectContaining({ endpoint: "file", courseId: COURSE_ID,
        items: [expect.objectContaining({ id: 1304 })] }));
    expect(assignment.attachments).toEqual([{ id: 1301 }, { id: 1301 }]);
    expect(assignment._canvasLinkedFiles).toEqual([{ courseId: COURSE_ID, fileId: 1304 }]);
    expect(downloadFile.mock.calls.filter(([request]) => request.fileId === 1301)).toHaveLength(1);
  });

  it.each([
    ["forbidden", (request: ReaderRequest) => request.endpoint === "file" && request.fileId === 901
      ? { status: "gap", reason: "FORBIDDEN_OPTIONAL", identity: { userId: USER_ID }, pages: 0, items: [] }
      : undefined, "forbidden-optional"],
    ["not found", (request: ReaderRequest) => request.endpoint === "file" && request.fileId === 901
      ? Object.assign(new Error("page.evaluate: Error: NOT_FOUND"), { code: "NOT_FOUND" })
      : undefined, "not-found"],
    ["locked", (request: ReaderRequest) => request.endpoint === "file" && request.fileId === 901
      ? Object.assign(new Error("page.evaluate: Error: FILE_LOCKED"), { code: "FILE_LOCKED" })
      : undefined, "locked"],
    ["network failure", (request: ReaderRequest) => request.endpoint === "file" && request.fileId === 901
      ? Object.assign(new Error("page.evaluate: Error: REQUEST_FAILED"), { code: "REQUEST_FAILED" })
      : undefined, "request-failed"],
  ])("records a linked metadata %s with its coverage reason", async (_label, override, reason) => {
    const resultFor = (request: ReaderRequest) => {
      const overridden = (override as (input: ReaderRequest) => unknown)(request);
      if (overridden !== undefined) return overridden;
      return baseResult(request);
    };
    const { capture } = await captureWith(resultFor);
    expect(capture.coverage).toContainEqual(expect.objectContaining({ endpoint: "file", courseId: COURSE_ID,
      status: "gap", reason }));
    if (reason === "request-failed") expect(capture.complete).toBe(false);
    else expect(capture.complete).toBe(true);
  });

  it("treats file-route 401 as locked only after profile identity succeeds", async () => {
    const fileCalls: string[] = [];
    const authenticated = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      fileCalls.push(url.pathname);
      return url.pathname.endsWith("/profile")
        ? new Response(JSON.stringify({ id: USER_ID }), { headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    });
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "file", fileId: 1401,
      expectedUserId: USER_ID }, authenticated)).rejects.toMatchObject({ code: "FILE_LOCKED" });
    expect(fileCalls).toEqual(["/api/v1/users/self/profile", "/api/v1/files/1401"]);

    const unauthenticated = vi.fn(async () => new Response("{}", {
      status: 401, headers: { "content-type": "application/json" },
    }));
    await expect(readCanvasBrowserApi({ mode: "read", endpoint: "file", fileId: 1401,
      expectedUserId: USER_ID }, unauthenticated)).rejects.toMatchObject({ code: "SESSION_FAILURE" });
    expect(unauthenticated).toHaveBeenCalledTimes(1);
  });

  it("marks the refresh partial when the linked-file detail cap is exceeded", async () => {
    const resultFor = (request: ReaderRequest) => {
      if (request.endpoint === "assignments") {
        return { status: "ok", identity: { userId: USER_ID }, pages: 1, items: [{
          id: 501, course_id: COURSE_ID, name: "Assignment", published: true,
          attachments: Array.from({ length: 1001 }, (_, index) => ({ id: 20_000 + index })),
        }] };
      }
      return baseResult(request);
    };
    const { capture, deps } = await captureWith(resultFor);
    const linkedRequests = deps.reader.mock.calls.map(([input]) => input as ReaderRequest)
      .filter((request) => request.endpoint === "file" && request.fileId !== 900);
    expect(linkedRequests).toHaveLength(1000);
    expect(capture.coverage).toContainEqual({ endpoint: "file", courseId: COURSE_ID,
      status: "gap", reason: "detail-budget" });
    expect(capture.complete).toBe(false);
  });
});
