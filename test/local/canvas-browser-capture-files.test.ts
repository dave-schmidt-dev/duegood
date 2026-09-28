import { describe, expect, it, vi } from "vitest";
import { collectCanvasBrowserCapture } from "../../scripts/canvas-browser-capture.mjs";

const USER_ID = 41;
const COURSE_ID = 88;
const FILE_ID = 900;
const ORIGIN = "https://marymount.instructure.com";
const FILE_URL = `${ORIGIN}/files/${FILE_ID}/download?verifier=synthetic-file-secret`;
const SYNTHETIC_RUN_ID = 702;
const SYNTHETIC_GENERATION_ID = "d".repeat(32);

type Request = { endpoint: string; courseId?: number; fileId?: number };
type ReaderResult = { status: "ok"; identity: { userId: number }; pages: number; items: Array<Record<string, unknown>> };

function syntheticRead(input: unknown): ReaderResult {
  const request = input as Request;
  const identity = { userId: USER_ID };
  let items: Array<Record<string, unknown>> = [];
  if (request.endpoint === "profile") items = [{ id: USER_ID, account_id: 9, name: "Synthetic" }];
  if (request.endpoint === "coursesActive") {
    items = [{ id: COURSE_ID, name: "SYN-101", url: `${ORIGIN}/courses/${COURSE_ID}` }];
  }
  if (request.endpoint === "course") items = [{ id: COURSE_ID, name: "SYN-101", syllabus_body: "" }];
  if (["courseFiles", "personalFiles"].includes(request.endpoint)) {
    items = [{ id: FILE_ID, display_name: "Synthetic handout", url: FILE_URL, size: 27,
      ...(request.endpoint === "courseFiles" ? { description: "<p>file-metadata-sanitize-marker</p>" } : {}) }];
  }
  if (["file", "personalFile"].includes(request.endpoint)) {
    items = [{ id: request.fileId, display_name: "Synthetic handout", url: FILE_URL, size: 27 }];
  }
  return { status: "ok", identity, pages: 1, items };
}

function testCollector(options: { downloadFile?: (input: { fileId: number; sourceUrl: string; expectedSize: number | null }) => unknown }) {
  const order: string[] = [];
  const reader = vi.fn(syntheticRead);
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
    expect(test.downloadFile).toHaveBeenCalledWith({ fileId: FILE_ID, sourceUrl: FILE_URL, expectedSize: 27 });
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
});
