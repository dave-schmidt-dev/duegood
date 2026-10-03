import { describe, expect, it, vi } from "vitest";
import { collectCanvasBrowserCapture } from "../../scripts/canvas-browser-capture.mjs";
import { createCanvasFileCapture } from "../../scripts/canvas-browser-capture-files.mjs";

const USER_ID = 41;
const COURSE_ID = 88;
const FILE_ID = 900;
const ORIGIN = "https://marymount.instructure.com";
const FILE_URL = `${ORIGIN}/files/${FILE_ID}/download?verifier=synthetic-file-secret`;
const SYNTHETIC_RUN_ID = 702;
const SYNTHETIC_GENERATION_ID = "d".repeat(32);

type Request = { endpoint: string; courseId?: number; fileId?: number };
type ReaderResult = { status: "ok"; identity: { userId: number }; pages: number; items: Array<Record<string, unknown>> };

function syntheticRead(input: unknown, fileItem: Record<string, unknown> = {}, pageItems: Array<Record<string, unknown>> = []): ReaderResult {
  const request = input as Request;
  const identity = { userId: USER_ID };
  let items: Array<Record<string, unknown>> = [];
  if (request.endpoint === "profile") items = [{ id: USER_ID, account_id: 9, name: "Synthetic" }];
  if (request.endpoint === "coursesActive") {
    items = [{ id: COURSE_ID, name: "SYN-101", url: `${ORIGIN}/courses/${COURSE_ID}` }];
  }
  if (request.endpoint === "course") items = [{ id: COURSE_ID, name: "SYN-101", syllabus_body: "" }];
  if (request.endpoint === "pages") items = pageItems;
  if (["courseFiles", "personalFiles"].includes(request.endpoint)) {
    items = [{ id: FILE_ID, display_name: "Synthetic handout", url: FILE_URL, size: 27, ...fileItem,
      ...(request.endpoint === "courseFiles" ? { description: "<p>file-metadata-sanitize-marker</p>" } : {}) }];
  }
  if (["file", "personalFile"].includes(request.endpoint)) {
    items = [{ id: request.fileId, display_name: "Synthetic handout", url: FILE_URL, size: 27, ...fileItem }];
  }
  return { status: "ok", identity, pages: 1, items };
}

function testCollector(options: { downloadFile?: (input: { fileId: number; sourceUrl: string; expectedSize: number | null }) => unknown;
  fileItem?: Record<string, unknown>; pageItems?: Array<Record<string, unknown>> } = {}) {
  const order: string[] = [];
  const reader = vi.fn((input: unknown) => syntheticRead(input, options.fileItem, options.pageItems));
  const htmlReader = vi.fn(({ html }: { html: string }) => {
    if (html.includes("file-metadata-sanitize-marker")) order.push("sanitize-file-metadata");
    return { text: "Synthetic text", links: [], textTruncated: false, linksTruncated: false };
  });
  const downloadFile = vi.fn(async (input: { fileId: number; sourceUrl: string; expectedSize: number | null }) => {
    order.push(`download:${input.fileId}`);
    return options.downloadFile ? options.downloadFile(input) : {
      kind: "staged",
      fileId: input.fileId,
      stagedFile: `${"b".repeat(32)}.blob`,
      byteCount: 27,
      sha256: "a".repeat(64),
      contentType: "application/pdf",
      sourceAuthenticity: "unverified",
      stagedPath: "/private/tmp/synthetic-private-path",
    };
  });
  const progressEvents: Array<Record<string, unknown>> = [];
  const progress = vi.fn(async (event: Record<string, unknown>) => { progressEvents.push(event); });
  const capture = collectCanvasBrowserCapture({
    expectedUserId: USER_ID,
    runId: SYNTHETIC_RUN_ID,
    generationId: SYNTHETIC_GENERATION_ID,
    reader,
    htmlReader,
    evaluate: async (fn: (input: never) => unknown, input: never) => {
      if (fn === reader) return reader(input);
      if (fn === htmlReader) return htmlReader(input);
      throw new Error("Unexpected evaluator function");
    },
    downloadFile,
    progress,
    now: () => new Date("2026-09-27T12:00:00.000Z"),
  });
  return { capture, downloadFile, order, progressEvents };
}

describe("Canvas file body capture", () => {
  it("downloads a globally unique file before sanitizing and stores only an opaque receipt", async () => {
    const test = testCollector({});
    const capture = await test.capture;
    expect(test.downloadFile).toHaveBeenCalledTimes(1);
    expect(test.downloadFile).toHaveBeenCalledWith({
      fileId: FILE_ID, sourceUrl: FILE_URL, expectedSize: 27,
      modifiedAt: null, updatedAt: null, contentType: null, locked: null, hidden: null,
      lockedForUser: null, hiddenForUser: null,
    });
    expect(test.order.indexOf(`download:${FILE_ID}`)).toBeLessThan(test.order.indexOf("sanitize-file-metadata"));
    expect(capture.resources.find((resource) => resource.endpoint === "fileBodies")?.items).toEqual([{
      fileId: FILE_ID,
      status: "staged",
      expectedSize: 27,
      byteCount: 27,
      sha256: "a".repeat(64),
      contentType: "application/pdf",
      stagedFile: `${"b".repeat(32)}.blob`,
      sourceAuthenticity: "unverified",
    }]);
    const serialized = JSON.stringify(capture);
    expect(serialized).not.toContain("synthetic-file-secret");
    expect(serialized).not.toContain("/files/900/download");
    expect(serialized).not.toContain("synthetic-private-path");
    expect(JSON.stringify(test.progressEvents)).not.toContain("synthetic-file-secret");
  });

  it("turns callback failures into content-free per-file gaps", async () => {
    const test = testCollector({
      downloadFile: async () => {
        throw Object.assign(new Error("https://private.invalid/?token=synthetic-secret"), { code: "HTTP_STATUS_REJECTED" });
      },
    });
    const capture = await test.capture;
    expect(test.downloadFile).toHaveBeenCalledTimes(1);
    expect(capture.resources.find((resource) => resource.endpoint === "fileBodies")?.items).toEqual([
      { fileId: FILE_ID, status: "gap", reason: "HTTP_STATUS_REJECTED" },
    ]);
    expect(JSON.stringify(capture)).not.toMatch(/private\.invalid|synthetic-secret/u);
  });

  it("preserves the fixed native download error code as the per-file gap reason", async () => {
    const test = testCollector({
      downloadFile: async () => {
        throw Object.assign(new Error("synthetic private transfer detail"), { code: "HELPER_DOWNLOAD_REQUEST_FAILED" });
      },
    });
    const capture = await test.capture;
    expect(capture.resources.find((resource) => resource.endpoint === "fileBodies")?.items).toEqual([
      { fileId: FILE_ID, status: "gap", reason: "HELPER_DOWNLOAD_REQUEST_FAILED" },
    ]);
    expect(test.progressEvents).toContainEqual(expect.objectContaining({
      phase: "file-download-complete",
      status: "gap",
      errorCode: "HELPER_DOWNLOAD_REQUEST_FAILED",
    }));
    expect(JSON.stringify(capture)).not.toContain("synthetic private transfer detail");
  });

  it("records a locked file as an explicit omission without attempting a download", async () => {
    const test = testCollector({ fileItem: { locked_for_user: true } });
    const capture = await test.capture;
    expect(test.downloadFile).not.toHaveBeenCalled();
    expect(capture.resources.find((resource) => resource.endpoint === "fileBodies")?.items).toEqual([
      { fileId: FILE_ID, status: "gap", reason: "locked" },
    ]);
  });

  it("passes raw revision evidence to the staging callback content-free", async () => {
    const stamps = { modified_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T11:00:00Z",
      "content-type": "application/pdf", locked: false, hidden: false, locked_for_user: false,
      hidden_for_user: false };
    const test = testCollector({ fileItem: stamps });
    const capture = await test.capture;
    expect(test.downloadFile).toHaveBeenCalledTimes(1);
    expect(test.downloadFile).toHaveBeenCalledWith({
      fileId: FILE_ID, sourceUrl: FILE_URL, expectedSize: 27,
      modifiedAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T11:00:00Z", contentType: "application/pdf",
      locked: false, hidden: false, lockedForUser: false, hiddenForUser: false,
    });
    expect(capture.resources.find((resource) => resource.endpoint === "fileBodies")?.items).toEqual([{
      fileId: FILE_ID,
      status: "staged",
      expectedSize: 27,
      byteCount: 27,
      sha256: "a".repeat(64),
      contentType: "application/pdf",
      stagedFile: `${"b".repeat(32)}.blob`,
      sourceAuthenticity: "unverified",
    }]);
  });
});

describe("Canvas detail gap aggregation", () => {
  it("keeps an invalid page slug blocking after an earlier locked page", async () => {
    const test = testCollector({ pageItems: [
      { id: 901, url: "locked-page", published: true, locked_for_user: true },
      { id: 902, url: "unsafe/page", published: true, locked_for_user: false },
    ] });
    const capture = await test.capture;
    expect(capture.coverage.find((row) => row.endpoint === "page" && row.courseId === COURSE_ID))
      .toMatchObject({ status: "gap", reason: "invalid-slug" });
  });
});

describe("Canvas file revision conflicts", () => {
  const T1 = "2026-09-01T10:00:00Z";
  const T2 = "2026-09-02T10:00:00Z";
  const stagedName = (call: number) => `${"a".repeat(31)}${call.toString(16)}.blob`;
  const stagedHash = (call: number) => `${"a".repeat(63)}${call.toString(16)}`;

  function directCapture({ reusedFirst = false } = {}) {
    const calls: Array<Record<string, unknown>> = [];
    let call = 0;
    const downloadFile = vi.fn(async (input: { fileId: number }) => {
      call += 1;
      calls.push({ ...input });
      return {
        kind: "staged" as const,
        fileId: input.fileId,
        stagedFile: stagedName(call),
        byteCount: 27,
        sha256: stagedHash(call),
        contentType: "application/pdf",
        sourceAuthenticity: "unverified" as const,
        ...(reusedFirst && call === 1 ? { reused: true } : {}),
      };
    });
    const events: Array<Record<string, unknown>> = [];
    const capture = createCanvasFileCapture({ downloadFile,
      progress: async (event: Record<string, unknown>) => { events.push(event); } });
    return { capture, downloadFile, calls, events };
  }

  const file = (modifiedAt: string) => ({ id: 900, url: FILE_URL, size: 27, modified_at: modifiedAt,
    updated_at: modifiedAt, "content-type": "application/pdf", locked: false, hidden: false,
    locked_for_user: false, hidden_for_user: false });

  it("passes content-free revision evidence for a single record", async () => {
    const direct = directCapture();
    await direct.capture.capture(file(T1));
    expect(direct.calls).toEqual([{ fileId: 900, sourceUrl: FILE_URL, expectedSize: 27,
      modifiedAt: T1, updatedAt: T1, contentType: "application/pdf",
      locked: false, hidden: false, lockedForUser: false, hiddenForUser: false }]);
    expect(direct.capture.finish()).toEqual([{ fileId: 900, status: "staged", expectedSize: 27,
      byteCount: 27, sha256: stagedHash(1), contentType: "application/pdf",
      stagedFile: stagedName(1), sourceAuthenticity: "unverified" }]);
  });

  it("re-downloads instead of keeping reused bytes when a duplicate record conflicts", async () => {
    const direct = directCapture({ reusedFirst: true });
    await direct.capture.capture(file(T1));
    await direct.capture.capture(file(T2));
    await direct.capture.capture(file(T1));
    expect(direct.downloadFile).toHaveBeenCalledTimes(2);
    expect(direct.calls[1]).toMatchObject({ fileId: 900, modifiedAt: null, updatedAt: null, contentType: null });
    expect(direct.capture.finish()).toEqual([{ fileId: 900, status: "staged", expectedSize: 27,
      byteCount: 27, sha256: stagedHash(2), contentType: "application/pdf",
      stagedFile: stagedName(2), sourceAuthenticity: "unverified" }]);
  });

  it("forces a download when duplicate MIME metadata conflicts at the same revision", async () => {
    const direct = directCapture({ reusedFirst: true });
    await direct.capture.capture(file(T1));
    await direct.capture.capture({ ...file(T1), "content-type": "text/plain" });
    expect(direct.downloadFile).toHaveBeenCalledTimes(2);
    expect(direct.calls[1]).toMatchObject({ modifiedAt: null, updatedAt: null, contentType: null });
    expect(direct.capture.finish()).toEqual([{ fileId: 900, status: "staged", expectedSize: 27,
      byteCount: 27, sha256: stagedHash(2), contentType: "application/pdf",
      stagedFile: stagedName(2), sourceAuthenticity: "unverified" }]);
  });

  it("keeps one receipt for agreeing duplicate records", async () => {
    const direct = directCapture({ reusedFirst: true });
    await direct.capture.capture(file(T1));
    await direct.capture.capture(file(T1));
    expect(direct.downloadFile).toHaveBeenCalledTimes(1);
    expect(direct.capture.finish()).toEqual([{ fileId: 900, status: "staged", expectedSize: 27,
      byteCount: 27, sha256: stagedHash(1), contentType: "application/pdf",
      stagedFile: stagedName(1), sourceAuthenticity: "unverified" }]);
  });

  it("keeps an already downloaded receipt when a duplicate record conflicts", async () => {
    const direct = directCapture();
    await direct.capture.capture(file(T1));
    await direct.capture.capture(file(T2));
    expect(direct.downloadFile).toHaveBeenCalledTimes(1);
    expect(direct.capture.finish()).toEqual([{ fileId: 900, status: "staged", expectedSize: 27,
      byteCount: 27, sha256: stagedHash(1), contentType: "application/pdf",
      stagedFile: stagedName(1), sourceAuthenticity: "unverified" }]);
  });

  it("does not pass stale revision evidence to reuse after conflicting metadata arrives before a URL", async () => {
    const direct = directCapture();
    const first = { ...file(T1), url: undefined };
    await direct.capture.capture(first);
    await direct.capture.capture(file(T2));
    expect(direct.calls).toHaveLength(1);
    expect(direct.calls[0]).toMatchObject({ fileId: 900, sourceUrl: FILE_URL,
      modifiedAt: null, updatedAt: null, contentType: null });
    expect(direct.capture.finish()).toHaveLength(1);
  });
});
