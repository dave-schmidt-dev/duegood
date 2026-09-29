import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSyllabusSchedule } from "../../scripts/canvas-syllabus-sessions.mjs";
import { deriveCapturedSyllabusSessions } from "../../scripts/canvas-syllabus-documents.mjs";
import { sanitizeCanvasCaptureItem } from "../../scripts/canvas-browser-capture-sanitize.mjs";

const directories: string[] = [];
const TEXT = "Monday January 14, 2030 Class session 6:00 PM–8:30 PM";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const source = { kind: "course-body", sha256: hash(TEXT) };
const parse = (text: string, extra = {}) => parseSyllabusSchedule(text, { timeZone: "America/New_York", source, ...extra });
type SyntheticResource = {
  endpoint: string; courseId: number | null;
  items: Array<{ id?: number; filename?: string; [key: string]: unknown }>;
};

async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "duegood-syllabus-test-"));
  await chmod(root, 0o700);
  directories.push(root);
  return root;
}

function snapshot(ids = [101], body = "") {
  return {
    activeCourses: { courseIds: ids },
    resources: ids.map((id) => ({
      endpoint: "course", courseId: id,
      items: [{ id, time_zone: "America/New_York", term: { name: "Synthetic 2030" }, syllabus_body: body }],
    })) as SyntheticResource[],
  };
}

async function staged(bytes: Buffer, filename = "COURSE_Syllabus_2030.txt", type = "text/plain") {
  const root = await directory();
  const stagedFile = "a".repeat(32) + ".blob";
  await writeFile(path.join(root, stagedFile), bytes, { mode: 0o600 });
  const capture = snapshot();
  const receipt = { fileId: 77, status: "staged", stagedFile, byteCount: bytes.length, sha256: hash(bytes), contentType: type };
  capture.resources.push(
    { endpoint: "courseFiles", courseId: 101, items: [{ id: 77, filename }] },
    { endpoint: "fileBodies", courseId: null, items: [receipt] },
  );
  return { root, capture, receipt, target: path.join(root, stagedFile) };
}

function docx(xml: string, advertisedSize?: number) {
  const data = Buffer.from(xml);
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(advertisedSize ?? data.length, 24);
  const entries = Buffer.concat([central, name]);
  const prefix = Buffer.concat([local, name, data]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(entries.length, 12); end.writeUInt32LE(prefix.length, 16);
  return Buffer.concat([prefix, entries, end]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("explicit syllabus schedule parser", () => {
  it("parses full-year weekday rows, retains exact source identity, and repeats deterministically", () => {
    const result = parse(TEXT);
    expect(result).toEqual({ status: "complete", sessions: [{
      date: "2030-01-14", startTime: "18:00", endTime: "20:30", title: "Class session", source: { ...source, line: 1 },
    }] });
    expect(parse(TEXT)).toEqual(result);
    expect(parse("Class meetings\nMonday January 14, 2030 18:00-20:30").status).toBe("complete");
  });

  it.each([
    ["", "NO_SYLLABUS"],
    ["Class meets Mondays 18:00-20:30", "AMBIGUOUS_SCHEDULE"],
    ["Class meetings 2030\nJanuary 14 18:00-20:30", "AMBIGUOUS_SCHEDULE"],
    ["Class January 14, 2030 18:00-20:30 and 19:00-21:00", "AMBIGUOUS_SCHEDULE"],
    ["Class January 14, 2030 18:00-20:30\nClass January 14, 2030 19:00-21:00", "AMBIGUOUS_SCHEDULE"],
    ["Office hours Monday January 14, 2030 18:00-20:30", "NO_SUPPORTED_SCHEDULE"],
    ["Class assignment due January 14, 2030 18:00-20:30", "NO_SUPPORTED_SCHEDULE"],
    ["No class Monday January 14, 2030 18:00-20:30", "NO_SUPPORTED_SCHEDULE"],
    ["Class canceled Monday January 14, 2030 18:00-20:30", "NO_SUPPORTED_SCHEDULE"],
    ["Class February 30, 2030 18:00-20:30", "AMBIGUOUS_SCHEDULE"],
  ])("keeps unsupported or ambiguous rows unresolved: %s", (text, reason) => {
    expect(parse(text)).toEqual({ status: "unresolved", reason, sessions: [] });
  });

  it.each(["No class", "Class canceled", "Holiday", "Class will not meet", "Class does not meet", "No school", "Class postponed"])("rejects a meeting whose exact date also says %s", (notice) => {
    const meeting = "Class Monday January 14, 2030 18:00-20:30";
    const cancellation = notice + " January 14, 2030";
    for (const text of [meeting + "\n" + cancellation, cancellation + "\n" + meeting]) {
      expect(parse(text)).toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
    }
    expect(parse(meeting + "\n" + notice + " January 21, 2030").status).toBe("complete");
    expect(parse(cancellation + " 18:00-20:30")).toEqual({ status: "unresolved", reason: "NO_SUPPORTED_SCHEDULE", sessions: [] });
  });

  it("ignores undated classroom numbers but holds dated meetings with no usable time", () => {
    expect(parse("Classroom: 105\nClass meetings in room 208\n" + TEXT)).toMatchObject({ status: "complete", sessions: [{ date: "2030-01-14" }] });
    expect(parse("Class meetings\nMonday January 14, 2030 room 208")).toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
    expect(parse("Class January 14, 2030")).toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it("decodes an entity once without interpreting a doubly escaped clock separator", () => {
    expect(parse("Class January 14, 2030 18:00&nbsp;-20:30").status).toBe("complete");
    expect(parse("Class January 14, 2030 18:00&amp;nbsp;-20:30")).toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it.each(["Office Hours:", "Assignment Deadlines:"])("rejects a weekday meeting row beneath %s", (heading) => {
    expect(parse(heading + "\nMonday January 14, 2030 18:00-20:30"))
      .toEqual({ status: "unresolved", reason: "NO_SUPPORTED_SCHEDULE", sessions: [] });
    expect(parse("Class meetings\n" + heading + "\nMonday January 14, 2030 18:00-20:30"))
      .toEqual({ status: "unresolved", reason: "NO_SUPPORTED_SCHEDULE", sessions: [] });
    expect(parse("Monday January 14, 2030 18:00-20:30").status).toBe("unresolved");
  });

  it("retains every explicit full-year row beneath a class heading beyond a short context window", () => {
    const rows = ["Monday January 14, 2030", "Monday January 21, 2030", "Monday January 28, 2030", "Monday February 4, 2030"];
    const result = parse("Class meetings\n" + rows.map((row) => row + " 18:00-20:30").join("\n"));
    expect(result.status).toBe("complete");
    expect(result.sessions.map((session) => session.date)).toEqual(["2030-01-14", "2030-01-21", "2030-01-28", "2030-02-04"]);
    expect(result.sessions.map((session) => session.source)).toEqual([2, 3, 4, 5].map((line) => ({ ...source, line })));
    expect(parse(rows.map((row) => "Class " + row + " 18:00-20:30").join("\n")).sessions).toHaveLength(4);
  });

  it("keeps distant office-hours rows excluded even when later rows contain class-like wording", () => {
    const rows = [
      "Monday January 14, 2030 18:00-20:30", "Monday January 21, 2030 18:00-20:30",
      "Class questions Monday January 28, 2030 18:00-20:30", "Meeting about class Monday February 4, 2030 18:00-20:30",
    ];
    for (const heading of ["Office Hours:", "Office hours 9:00-11:00", "Assignment Deadlines:", "Deadlines:"]) {
      expect(parse(heading + "\n" + rows.join("\n"))).toEqual({ status: "unresolved", reason: "NO_SUPPORTED_SCHEDULE", sessions: [] });
    }
  });

  it("requires a new explicit class heading to leave an excluded section", () => {
    const result = parse("Office Hours:\nClass questions January 14, 2030 18:00-20:30\nMeetings:\n"
      + "Class discussion January 21, 2030 18:00-20:30\nClass meetings:\nMonday January 28, 2030 18:00-20:30");
    expect(result).toMatchObject({ status: "complete", sessions: [{ date: "2030-01-28", source: { line: 6 } }] });
    expect(result.sessions).toHaveLength(1);
  });

  it("holds a partial list when a dated row has unclear section context", () => {
    expect(parse(TEXT + "\nSchedule notes:\nMonday January 21, 2030 18:00-20:30"))
      .toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
    expect(parse("Monday January 21, 2030 18:00-20:30"))
      .toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
    expect(parse("Schedule:\nMonday January 21, 2030 18:00-20:30"))
      .toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it.each(["test review", "exam review", "quiz review"])("holds the whole class list rather than silently dropping a dated %s row", (topic) => {
    expect(parse("Class meetings\n" + TEXT + "\nClass January 21, 2030 18:00-20:30 (" + topic + ")"))
      .toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it("rejects a term-year conflict, unknown timezone, and text/session limits", () => {
    expect(parse(TEXT, { termName: "Synthetic 2029" }).reason).toBe("AMBIGUOUS_SCHEDULE");
    expect(parse(TEXT, { timeZone: "" }).reason).toBe("SOURCE_UNAVAILABLE");
    expect(parse("x".repeat(300001)).reason).toBe("LIMIT_EXCEEDED");
    expect(parse(Array.from({ length: 1001 }, () => TEXT).join("\n")).reason).toBe("LIMIT_EXCEEDED");
  });
});

describe("capture-owned syllabus documents", () => {
  it.each(["agree", "different cancellation", "different clock", "unresolved sibling"])(
    "requires exact meeting agreement between verified Word revisions: %s", async (revision) => {
      const xml = (clock = "6:15PM", cancelledWeek = 1, allCancelled = false, prose = "") => {
        const paragraph = (text: string) => "<w:p><w:r><w:t>" + text + "</w:t></w:r></w:p>";
        const row = (cells: string[]) => "<w:tr>" + cells.map((cell) => "<w:tc>" + paragraph(cell) + "</w:tc>").join("") + "</w:tr>";
        return "<w:document><w:body>" + paragraph(prose) + "<w:tbl>" + row([
          "Meeting Day, Time, and Room Number01/04/2027-01/31/2027 Online, Synchronous Wednesday’s " + clock + " - 8:45PM",
        ]) + "</w:tbl>" + paragraph("Class Schedule") + "<w:tbl>" + row(["Start Date", "End Date", "Topic"])
          + [[4, 10], [11, 17], [18, 24], [25, 31]].map(([start, end], index) => row([
            "01/" + String(start).padStart(2, "0") + "/27", "01/" + String(end).padStart(2, "0") + "/27",
            allCancelled || index === cancelledWeek ? "No Classes - Holiday" : "Discussion",
          ])).join("") + "</w:tbl></w:body></w:document>";
      };
      const first = docx(xml());
      const { root, capture, receipt } = await staged(first, "syllabus.docx");
      const second = docx(xml(revision === "different clock" ? "7:15PM" : "6:15PM",
        revision === "different cancellation" ? 2 : 1, revision === "unresolved sibling", "Unrelated revised description"));
      const stagedFile = "b".repeat(32) + ".blob";
      await writeFile(path.join(root, stagedFile), second, { mode: 0o600 });
      capture.resources[1]!.items.push({ id: 88, filename: "syllabus-revised.docx" });
      capture.resources.push({ endpoint: "fileBodies", courseId: null, items: [{
        fileId: 88, status: "staged", stagedFile, byteCount: second.length, sha256: hash(second),
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }] });
      const result = (await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root })).courses[0]!;
      if (revision === "agree") {
        expect(result.status).toBe("complete");
        expect(result.sessions.map((session) => session.date)).toEqual(["2027-01-06", "2027-01-20", "2027-01-27"]);
        expect(result.sessions.every((session) => session.source.sha256 === receipt.sha256 && session.source.fileId === 77)).toBe(true);
      } else expect(result).toMatchObject({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
    },
  );

  it("holds the course when a later PDF page has a dated row with no explicit class context", async () => {
    const { root, capture } = await staged(Buffer.from("%PDF-synthetic"), "syllabus.pdf", "application/pdf");
    const result = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root,
      extractPdfText: async () => ["Class meetings\n" + TEXT, "Monday January 21, 2030 18:00-20:30"] });
    expect(result.courses[0]!).toMatchObject({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it("bounds invalid course timezones while preserving another course's valid schedule", async () => {
    for (const invalid of ["x".repeat(81), "Not/AZone", null]) {
      const capture = snapshot([101, 202], TEXT);
      capture.resources[0]!.items[0]!.time_zone = invalid;
      const result = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: await directory() });
      expect(result.courses[0]!).toEqual({ courseId: 101, timeZone: "", status: "unresolved", reason: "SOURCE_UNAVAILABLE", sessions: [] });
      expect(result.courses[1]!).toMatchObject({ courseId: 202, timeZone: "America/New_York", status: "complete", sessions: [{ date: "2030-01-14" }] });
    }
  });

  it("finds a saved document receipt beyond the first fileBodies resource", async () => {
    const { root, capture, receipt } = await staged(Buffer.from(TEXT));
    capture.resources[2]!.items = [];
    capture.resources.push({ endpoint: "fileBodies", courseId: null, items: [receipt] });
    expect((await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root })).courses[0]!.status).toBe("complete");
  });

  it.each(["same resource", "separate resources"])("rejects duplicate receipts in %s without accepting a final valid entry", async (layout) => {
    for (const conflictingHash of [false, true]) {
      const { root, capture, receipt } = await staged(Buffer.from(TEXT));
      const duplicate = { ...receipt, sha256: conflictingHash ? "b".repeat(64) : receipt.sha256 };
      if (layout === "same resource") capture.resources[2]!.items.unshift(duplicate);
      else capture.resources.unshift({ endpoint: "fileBodies", courseId: null, items: [duplicate] });
      expect((await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root })).courses[0]!)
        .toMatchObject({ status: "unresolved", reason: "SOURCE_UNAVAILABLE", sessions: [] });
    }
  });

  it.each(["HTML", "DOCX"])("decodes %s document entities only once before deciding whether a clock is usable", async (format) => {
    const text = "Class January 14, 2030 18:00&amp;nbsp;-20:30";
    const bytes = format === "HTML" ? Buffer.from("<p>" + text + "</p>")
      : docx("<w:document><w:p><w:r><w:t>" + text + "</w:t></w:r></w:p></w:document>");
    const { root, capture } = await staged(bytes, "syllabus." + (format === "HTML" ? "html" : "docx"));
    expect((await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root })).courses[0]!)
      .toMatchObject({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it.each([false, true])("rejects an exact-date cancellation on another PDF page (notice first: %s)", async (noticeFirst) => {
    const { root, capture } = await staged(Buffer.from("%PDF-synthetic"), "syllabus.pdf", "application/pdf");
    const notice = "Class will not meet January 14, 2030";
    const result = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root,
      extractPdfText: async () => noticeFirst ? [notice, TEXT] : [TEXT, notice] });
    expect(result.courses[0]!).toMatchObject({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
    const unrelated = "No class January 21, 2030";
    const retained = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root,
      extractPdfText: async () => noticeFirst ? [unrelated, TEXT] : [TEXT, unrelated] });
    expect(retained.courses[0]!).toMatchObject({ status: "complete",
      sessions: [{ date: "2030-01-14", source: { page: noticeFirst ? 2 : 1, line: 1 } }] });
  });

  it("rejects cancellation conflicts across separately verified source documents and the course body", async () => {
    const { root, capture } = await staged(Buffer.from("%PDF-synthetic"), "syllabus.pdf", "application/pdf");
    const notice = Buffer.from("No school January 14, 2030");
    const stagedFile = "b".repeat(32) + ".blob";
    await writeFile(path.join(root, stagedFile), notice, { mode: 0o600 });
    capture.resources[1]!.items.push({ id: 88, filename: "syllabus-update.txt" });
    capture.resources.push({ endpoint: "fileBodies", courseId: null, items: [{ fileId: 88, status: "staged", stagedFile, byteCount: notice.length, sha256: hash(notice), contentType: "text/plain" }] });
    const options = { snapshot: capture, stagingDirectory: root, extractPdfText: async () => [TEXT] };
    expect((await deriveCapturedSyllabusSessions(options)).courses[0]!)
      .toMatchObject({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
    capture.resources[1]!.items.pop();
    capture.resources[0]!.items[0]!.syllabus_body = "Class postponed January 14, 2030";
    expect((await deriveCapturedSyllabusSessions(options)).courses[0]!)
      .toMatchObject({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it("stops source extraction when the shared elapsed budget expires", async () => {
    const { root, capture } = await staged(Buffer.from("%PDF-synthetic"), "syllabus.pdf", "application/pdf");
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    capture.resources.push(...snapshot([202], TEXT).resources);
    capture.activeCourses.courseIds.push(202);
    const result = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root,
      extractPdfText: async () => { now = 60_001; return [TEXT]; } });
    expect(result.courses[0]!.status).toBe("complete");
    expect(result.courses[1]!).toMatchObject({ courseId: 202, status: "unresolved", reason: "LIMIT_EXCEEDED", sessions: [] });
  });

  it("derives every generic active course and hashes the exact captured body bytes", async () => {
    const capture = snapshot([101, 202, 303], TEXT);
    const result = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: await directory() });
    expect(result.courses.map((course: { courseId: number }) => course.courseId)).toEqual([101, 202, 303]);
    expect(result.courses.every((course: { status: string }) => course.status === "complete")).toBe(true);
    expect(result.courses[0]!.sessions[0]!.source).toEqual({ kind: "course-body", sha256: hash(TEXT), line: 1 });
    expect(await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: await directory() })).toEqual(result);
  });

  it.each([
    [Buffer.from(TEXT), "COURSE_Syllabus_2030.txt", "text/plain"],
    [Buffer.from("<p>" + TEXT + "</p>"), "Syllabus2030.html", "text/html"],
    [docx("<w:document><w:body><w:p><w:r><w:t>" + TEXT + "</w:t></w:r></w:p></w:body></w:document>"), "Syllabi.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ])("extracts only saved verified candidate bytes (%s)", async (bytes, filename, type) => {
    const { root, capture, receipt } = await staged(bytes, filename, type);
    const result = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root });
    expect(result.courses[0]!).toMatchObject({ status: "complete", sessions: [{ date: "2030-01-14", source: { kind: "file", fileId: 77, sha256: receipt.sha256, line: 1 } }] });
  });

  it("does not read unrelated course files or infer a candidate by a matching link title", async () => {
    const { root, capture } = await staged(Buffer.from(TEXT));
    capture.resources[1]!.items.push(...Array.from({ length: 60 }, (_, id) => ({ id: id + 200, filename: "Lecture-" + id + ".pdf" })));
    capture.resources[0]!.items[0]!._canvasLinks = [{ title: "Lecture-0.pdf", safeTarget: null }];
    const extractor = vi.fn();
    const result = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root, extractPdfText: extractor });
    expect(result.courses[0]!.status).toBe("complete");
    expect(extractor).not.toHaveBeenCalled();
  });

  it("rejects hash changes, symlinks, missing receipts, and cross-course metadata", async () => {
    for (const failure of ["hash", "symlink", "receipt", "scope"]) {
      const { root, capture, receipt, target } = await staged(Buffer.from(TEXT));
      if (failure === "hash") receipt.sha256 = "b".repeat(64);
      if (failure === "symlink") {
        await rm(target);
        const other = path.join(root, "other");
        await writeFile(other, TEXT, { mode: 0o600 });
        await symlink(other, target);
      }
      if (failure === "receipt") receipt.status = "unavailable";
      if (failure === "scope") capture.resources[1]!.courseId = 202;
      const result = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root });
      expect(result.courses[0]!.status).toBe("unresolved");
      expect(result.courses[0]!.sessions).toEqual([]);
    }
  });

  it("bounds DOCX expansion, candidate count, total extracted text, and truncated source facts", async () => {
    const bomb = await staged(docx("<w:document/>", 5 * 1024 * 1024), "syllabus.docx");
    expect((await deriveCapturedSyllabusSessions({ snapshot: bomb.capture, stagingDirectory: bomb.root })).courses[0]!.reason).toBe("UNSUPPORTED_DOCUMENT");
    const many = snapshot();
    many.resources.push({ endpoint: "courseFiles", courseId: 101, items: Array.from({ length: 41 }, (_, id) => ({ id: id + 1, filename: "Syllabus-" + id + ".txt" })) });
    expect((await deriveCapturedSyllabusSessions({ snapshot: many, stagingDirectory: await directory() })).courses[0]!.reason).toBe("LIMIT_EXCEEDED");
    const pdf = await staged(Buffer.from("%PDF-synthetic"), "syllabus.pdf", "application/pdf");
    expect((await deriveCapturedSyllabusSessions({ snapshot: pdf.capture, stagingDirectory: pdf.root, extractPdfText: async () => ["x".repeat(300001)] })).courses[0]!.reason).toBe("LIMIT_EXCEEDED");
    const truncated = snapshot([101], TEXT);
    truncated.resources[0]!.items[0]!._canvasTextTruncated = true;
    expect((await deriveCapturedSyllabusSessions({ snapshot: truncated, stagingDirectory: await directory() })).courses[0]!.reason).toBe("LIMIT_EXCEEDED");
  });

  it("keeps PDF source page/line and propagates content-free capture progress", async () => {
    const { root, capture } = await staged(Buffer.from("%PDF-synthetic"), "syllabus.pdf", "application/pdf");
    const progress = vi.fn();
    const result = await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root, progress,
      extractPdfText: async (_bytes: Uint8Array, options: { progress: () => void }) => { options.progress(); return [TEXT]; } });
    expect(result.courses[0]!.sessions[0]!.source).toMatchObject({ kind: "file", fileId: 77, page: 1, line: 1 });
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it("retains exact body-linked file IDs without persisting URLs or accepting another course's link", async () => {
    const sanitized = await sanitizeCanvasCaptureItem({ id: 101, syllabus_body: "<p>Course document</p>" }, {
      endpoint: "course", courseId: 101, itemIndex: 0, htmlReader: () => {},
      evaluatePage: async (_reader: unknown, input: { options: { source: string } }) => ({
        text: "Course document", textTruncated: false, linksTruncated: false,
        links: [101, 202].map((courseId) => ({
          source: input.options.source, title: "Document", asciiHostname: "marymount.instructure.com",
          safeTarget: "https://marymount.instructure.com/courses/" + courseId + "/files/" + (courseId === 101 ? 77 : 88),
          clickable: true,
        })),
      }),
    });
    expect((sanitized as Record<string, unknown>)._canvasSyllabusFileIds).toEqual([77]);
    expect(JSON.stringify(sanitized)).not.toContain("/files/");
    const { root, capture } = await staged(Buffer.from(TEXT), "course-document.txt");
    Object.assign(capture.resources[0]!.items[0]!, sanitized);
    expect((await deriveCapturedSyllabusSessions({ snapshot: capture, stagingDirectory: root })).courses[0]!.status).toBe("complete");
  });
});
