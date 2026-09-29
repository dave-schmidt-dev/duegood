import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPdfTextExtractor, loadCurrentCanvasCapture } from "../../scripts/canvas-browser-runtime-loader.mjs";
import { saveCanvasCaptureGeneration } from "../../scripts/canvas-browser-archive.mjs";

afterEach(() => vi.useRealTimers());

function syntheticPdf() {
  const stream = "BT /F1 12 Tf 50 700 Td (Monday January 14, 2030 Class session) Tj 255 0 Td (6:00 PM-8:30 PM) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + Buffer.byteLength(stream) + " >>\nstream\n" + stream + "\nendstream",
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += String(index + 1) + " 0 obj\n" + object + "\nendobj\n"; });
  const start = Buffer.byteLength(text);
  text += "xref\n0 6\n0000000000 65535 f \n" + offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  text += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + start + "\n%%EOF\n";
  return Buffer.from(text);
}

it.each(["load", "text"])("bounds a stalled PDF %s request, emits heartbeats, and destroys its loading task", async (phase) => {
  vi.useFakeTimers();
  const destroy = vi.fn(async () => {});
  const pending = new Promise(() => {});
  const task = { destroy, promise: phase === "load" ? pending : Promise.resolve({
    numPages: 1, getPage: async () => ({ getTextContent: () => pending }),
  }) };
  const progress = vi.fn();
  const extractor = createPdfTextExtractor({ pdfjs: { getDocument: () => task } });
  const result = extractor(Buffer.from("%PDF-synthetic"), { progress });
  await vi.advanceTimersByTimeAsync(20_000);
  await expect(result).resolves.toBeNull();
  expect(progress.mock.calls.length).toBeGreaterThan(1);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("offers bounded first-page structured rows without loading later pages", async () => {
  const getPage = vi.fn(async () => ({ getTextContent: async () => ({ items: [
    { str: "Course Syllabus", transform: [1, 0, 0, 1, 30, 700], hasEOL: true },
  ] }) }));
  const task = { destroy: vi.fn(async () => {}), promise: Promise.resolve({ numPages: 2, getPage }) };
  const extractor = createPdfTextExtractor({ pdfjs: { getDocument: () => task } });
  await expect(extractor(Buffer.from("%PDF-synthetic"), { firstPageOnly: true, structuredRows: true })).resolves.toEqual([{
    text: "Course Syllabus", rows: [{ text: "Course Syllabus", line: 1, items: [{ text: "Course Syllabus", x: 30 }] }],
  }]);
  expect(getPage).toHaveBeenCalledTimes(1);
  expect(getPage).toHaveBeenCalledWith(1);
});

it("allows only bounded page-one discovery beyond the full extraction cap", async () => {
  const getPage = vi.fn(async () => ({ getTextContent: async () => ({ items: [
    { str: "Course Syllabus", transform: [1, 0, 0, 1, 30, 700], hasEOL: true },
  ] }) }));
  const load = (numPages: number) => ({ destroy: vi.fn(async () => {}), promise: Promise.resolve({ numPages, getPage }) });
  const extractor = createPdfTextExtractor({ pdfjs: { getDocument: () => load(81) } });
  await expect(extractor(Buffer.from("%PDF-synthetic"), { firstPageOnly: true })).resolves.toEqual(["Course Syllabus"]);
  await expect(extractor(Buffer.from("%PDF-synthetic"))).resolves.toBeNull();
  expect(getPage).toHaveBeenCalledTimes(1);

  const overDiscoveryLimit = createPdfTextExtractor({ pdfjs: { getDocument: () => load(1001) } });
  await expect(overDiscoveryLimit(Buffer.from("%PDF-synthetic"), { firstPageOnly: true })).resolves.toBeNull();
});

it("drops whitespace-only PDF glyphs before structured table-column matching", async () => {
  const task = { destroy: vi.fn(async () => {}), promise: Promise.resolve({ numPages: 1, getPage: async () => ({
    getTextContent: async () => ({ items: [
      { str: "Class Date", transform: [1, 0, 0, 1, 102, 700] },
      { str: " ", transform: [1, 0, 0, 1, 180, 700] },
      { str: "Due Date", transform: [1, 0, 0, 1, 450, 700] },
      { str: "\t", transform: [1, 0, 0, 1, 470, 700] },
    ] }),
  }) }) };
  const extractor = createPdfTextExtractor({ pdfjs: { getDocument: () => task } });
  await expect(extractor(Buffer.from("%PDF-synthetic"), { structuredRows: true })).resolves.toEqual([{
    text: "Class Date Due Date", rows: [{ text: "Class Date Due Date", line: 1, items: [
      { text: "Class Date", x: 102 }, { text: "Due Date", x: 450 },
    ] }],
  }]);
});

it("loads the real bounded capture bundle and imports split PDF row text through immutable generation saving", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "duegood-capture-pdf-test-")));
  try {
    await chmod(directory, 0o700);
    const helperPath = path.join(directory, "helper");
    await writeFile(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const bytes = syntheticPdf();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const capture = await loadCurrentCanvasCapture(); // Real esbuild/data-URL loader and pinned PDF.js.
    const saveGeneration = vi.fn(saveCanvasCaptureGeneration);
    const progress = vi.fn();
    const result = await capture({
      appDirectory: directory, helperPath, stateHelperPath: helperPath, expectedUserId: 41, protocolVersion: 2,
      context: { pages: () => [{ url: () => "https://marymount.instructure.com/", isClosed: () => false }] },
      progress, saveGeneration,
      withRunLease: async ({ run }: { run: (id: number) => Promise<{ value: unknown }> }) => (await run(52)).value,
      browserFileDownload: async ({ stagingDirectory }: { stagingDirectory: string }) => {
        const stagedFile = "a".repeat(32) + ".blob";
        await writeFile(path.join(stagingDirectory, stagedFile), bytes, { mode: 0o600 });
        return { kind: "staged", stagedFile, fileId: 77, byteCount: bytes.length, sha256,
          contentType: "application/pdf", sourceAuthenticity: "unverified", expectedSize: bytes.length };
      },
      collector: async ({ downloadFile, runId, generationId }: {
        downloadFile: (input: { fileId: number; sourceUrl: string; expectedSize: number }) => Promise<Record<string, unknown>>;
        runId: number; generationId: string;
      }) => {
        const receipt = await downloadFile({ fileId: 77, sourceUrl: "https://marymount.instructure.com/files/77/download", expectedSize: bytes.length });
        return {
          schemaVersion: 2, source: "canvas-browser", complete: false, runId, generationId,
          capturedAt: "2030-01-01T12:00:00Z", identity: { origin: "https://marymount.instructure.com", userId: 41 },
          activeCourses: { complete: true, courseIds: [101] },
          coverageRequirements: { activeCoursesComplete: true, perActiveCourse: ["course", "assignments", "assignmentGroups", "submissions"] },
          resources: [
            { endpoint: "coursesActive", courseId: null, pages: 1, items: [{ id: 101 }] },
            { endpoint: "course", courseId: 101, pages: 1, items: [{ id: 101, time_zone: "America/New_York", syllabus_body: "", term: { name: "Synthetic 2030" } }] },
            ...["assignments", "assignmentGroups", "submissions"].map((endpoint) => ({ endpoint, courseId: 101, pages: 1, items: [] })),
            { endpoint: "courseFiles", courseId: 101, pages: 1, items: [{ id: 77, filename: "Syllabus2030.pdf" }] },
            { endpoint: "fileBodies", courseId: null, pages: 1, items: [{ ...receipt, status: "staged" }] },
          ],
          coverage: [{ endpoint: "coursesActive", courseId: null, status: "complete" },
            ...["course", "assignments", "assignmentGroups", "submissions"].map((endpoint) => ({ endpoint, courseId: 101, status: "complete" }))],
        };
      },
    });
    expect(result.syllabusSessions.courses[0]).toMatchObject({ courseId: 101, status: "complete",
      sessions: [{ date: "2030-01-14", startTime: "18:00", endTime: "20:30", title: "Class session",
        source: { kind: "file", fileId: 77, sha256, page: 1, line: 1 } }] });
    expect(saveGeneration).toHaveBeenCalledTimes(1);
    const pointer = JSON.parse(await readFile(path.join(directory, "canvas-capture-archive", "current.json"), "utf8"));
    const archived = JSON.parse(await readFile(path.join(directory, "canvas-capture-archive", "generations", pointer.generationId, "snapshot.json"), "utf8"));
    expect(archived.syllabusSessions).toEqual(result.syllabusSessions);
    expect(archived.resources.at(-1).items[0].status).toBe("archived");
    expect(progress).toHaveBeenCalledWith("CAPTURE_RUNNING");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reloads changed capture dependencies without replacing the broker process", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "duegood-capture-loader-test-"));
  try {
    const entry = path.join(directory, "entry.mjs");
    const dependency = path.join(directory, "dependency.mjs");
    await writeFile(entry, 'import { value } from "./dependency.mjs"; export const runCanvasCapture = () => value;\n');
    await writeFile(dependency, "export const value = 1;\n");
    expect((await loadCurrentCanvasCapture({ entry }))()).toBe(1);

    await writeFile(dependency, "export const value = 2;\n");
    expect((await loadCurrentCanvasCapture({ entry }))()).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
