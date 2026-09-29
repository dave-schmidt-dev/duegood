import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseSyllabusSchedule, syllabusCancelledDates } from "./canvas-syllabus-sessions.mjs";
import { parseWeeklySyllabusSchedule, readSyllabusDocxDocument } from "./canvas-syllabus-weekly.mjs";
import { isCourseSyllabusFirstPage, parsePdfSyllabusSchedule } from "./canvas-syllabus-pdf.mjs";

const FILE_NAME = /^[0-9a-f]{32}\.blob$/u;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_DOCUMENTS_PER_COURSE = 40;
const MAX_DOCUMENTS = 200;
const MAX_DOCX_XML_BYTES = 4 * 1024 * 1024;
const MAX_EXTRACTION_MILLISECONDS = 60_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function zipDocumentXml(bytes) {
  const min = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) return null;
  const entries = bytes.readUInt16LE(end + 10);
  const centralBytes = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  if (entries > 1000 || entries !== bytes.readUInt16LE(end + 8)
      || centralBytes > MAX_DOCX_XML_BYTES || cursor + centralBytes !== end) return null;
  let documentXml = null;
  for (let i = 0; i < entries; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) return null;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (nameLength > 1024 || cursor + 46 + nameLength + extraLength + commentLength > end) return null;
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === "word/document.xml") {
      if (documentXml !== null || (flags & 1) !== 0 || ![0, 8].includes(method)
          || compressed < 1 || uncompressed > MAX_DOCX_XML_BYTES || uncompressed > compressed * 100
          || localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      if (start + compressed > bytes.readUInt32LE(end + 16)
          || bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== name) return null;
      const packed = bytes.subarray(start, start + compressed);
      try {
        const xml = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: MAX_DOCX_XML_BYTES });
        if (xml.length !== uncompressed) return null;
        documentXml = new TextDecoder("utf-8", { fatal: true }).decode(xml);
      } catch { return null; }
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return documentXml;
}

function textDocument(bytes, contentType, fileName) {
  const type = (contentType ?? "").split(";")[0].toLowerCase();
  const ext = path.extname(fileName ?? "").toLowerCase();
  const isHtml = type === "text/html" || ext === ".html" || ext === ".htm";
  const allowed = isHtml || type === "text/plain" || [".txt", ".md", ".text"].includes(ext);
  if (!allowed) return null;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  if (isHtml) {
    text = text.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/giu, " ")
      .replace(/<\s*\/(?:p|div|li|tr|h[1-6])\s*>/giu, "\n")
      .replace(/<[^>]{1,2048}>/gu, " ");
  }
  return text;
}

async function privateStagedBytes(stagingDirectory, receipt) {
  if (typeof receipt.stagedFile !== "string" || !FILE_NAME.test(receipt.stagedFile)
      || !Number.isSafeInteger(receipt.byteCount) || receipt.byteCount < 1
      || receipt.byteCount > MAX_DOCUMENT_BYTES || !HASH.test(receipt.sha256)) return null;
  const target = path.join(stagingDirectory, receipt.stagedFile);
  const directory = await lstat(stagingDirectory).catch(() => null);
  if (!directory?.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o7777) !== 0o700
      || (typeof process.getuid === "function" && directory.uid !== process.getuid())) return null;
  const before = await lstat(target).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.size !== receipt.byteCount
      || (before.mode & 0o7777) !== 0o600
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) return null;
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (before.dev !== opened.dev || before.ino !== opened.ino || opened.nlink !== 1) return null;
    const bytes = await handle.readFile();
    const after = await lstat(target);
    const afterDirectory = await lstat(stagingDirectory);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || after.size !== receipt.byteCount || (after.mode & 0o7777) !== 0o600
        || directory.dev !== afterDirectory.dev || directory.ino !== afterDirectory.ino
        || afterDirectory.isSymbolicLink() || bytes.length !== receipt.byteCount || sha256(bytes) !== receipt.sha256) return null;
    return bytes;
  } catch { return null; }
  finally { await handle?.close(); }
}

function candidatePages(bytes, receipt, file, extractPdfText, progress, options = {}) {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return typeof extractPdfText === "function" ? extractPdfText(bytes, { progress, ...options }) : null;
  }
  if (bytes.subarray(0, 2).toString("ascii") === "PK") {
    return readSyllabusDocxDocument(zipDocumentXml(bytes));
  }
  const text = textDocument(bytes, receipt.contentType, file.filename ?? file.display_name);
  return text === null ? null : [text];
}

function syllabusFile(file, linkedIds) {
  const names = [file?.display_name, file?.filename].filter((value) => typeof value === "string");
  return names.some((name) => /(?:^|[^a-z])syllab(?:us|i)(?:$|[^a-z])/iu.test(name))
    || linkedIds.has(file?.id);
}

function declaredPdfFile(file) {
  const namedPdf = [file?.display_name, file?.filename].some((value) => typeof value === "string" && /\.pdf$/iu.test(value));
  return namedPdf || /^application\/pdf(?:;|$)/iu.test(file?.content_type ?? file?.contentType ?? "");
}

/**
 * Derives bounded class facts only from this capture's exact same-course syllabus sources.
 * @param {{snapshot:object,stagingDirectory:string,extractPdfText?:(bytes:Uint8Array,options:{progress:()=>void})=>Promise<string[]|null>,progress?:()=>void}} options
 */
export async function deriveCapturedSyllabusSessions({
  snapshot, stagingDirectory, extractPdfText, progress = () => {},
}) {
  const resources = snapshot?.resources;
  if (!Array.isArray(resources)) return { schemaVersion: 1, courses: [] };
  const activeIds = new Set(snapshot?.activeCourses?.courseIds ?? []);
  const courseResources = resources.filter((resource) => resource?.endpoint === "course");
  const fileResources = resources.filter((resource) => resource?.endpoint === "courseFiles" && Number.isSafeInteger(resource.courseId));
  const bodyResources = resources.filter((resource) => resource?.endpoint === "fileBodies");
  const malformedReceipts = bodyResources.some((resource) => !Array.isArray(resource.items));
  const bodyReceipts = new Map();
  for (const resource of bodyResources) {
    for (const receipt of Array.isArray(resource.items) ? resource.items : []) {
      const matching = bodyReceipts.get(receipt?.fileId) ?? [];
      matching.push(receipt);
      bodyReceipts.set(receipt?.fileId, matching);
    }
  }
  let totalFiles = 0, totalBytes = 0;
  const startedAt = Date.now();
  const output = [];
  for (const resource of courseResources) {
    const course = resource.items?.length === 1 ? resource.items[0] : null;
    const courseId = course?.id;
    if (!activeIds.has(courseId) || resource.courseId !== courseId || resource.groupId != null) continue;
    let timeZone = "";
    if (typeof course?.time_zone === "string" && course.time_zone.length <= 80) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: course.time_zone }).format(0);
        timeZone = course.time_zone;
      } catch { /* An unresolved course must not carry unbounded or invalid zone text. */ }
    }
    const termName = course?.term?.name ?? null;
    const sourceResults = [];
    const weeklyResults = [];
    const cancelledDates = new Set();
    const recordSource = (text, source) => {
      for (const date of syllabusCancelledDates(text)) cancelledDates.add(date);
      sourceResults.push(parseSyllabusSchedule(text, { timeZone, termName, source }));
    };
    const body = course?.syllabus_body;
    if (!timeZone) {
      output.push({ courseId, timeZone: "", status: "unresolved", reason: "SOURCE_UNAVAILABLE", sessions: [] });
      continue;
    }
    if (Date.now() - startedAt >= MAX_EXTRACTION_MILLISECONDS) {
      output.push({ courseId, timeZone, status: "unresolved", reason: "LIMIT_EXCEEDED", sessions: [] });
      continue;
    }
    if (course?._canvasTextTruncated === true || course?._canvasLinksTruncated === true) {
      output.push({ courseId, timeZone, status: "unresolved", reason: "LIMIT_EXCEEDED", sessions: [] });
      continue;
    }
    if (typeof body === "string" && body.trim()) {
      const source = { kind: "course-body", sha256: sha256(Buffer.from(body, "utf8")) };
      recordSource(body, source);
    }
    const linkedIds = new Set((course?._canvasSyllabusFileIds ?? [])
      .filter((id) => Number.isSafeInteger(id) && id > 0));
    const courseFiles = fileResources.filter((item) => item.courseId === courseId && item.groupId == null)
      .flatMap((item) => item.items ?? []);
    const designatedFiles = courseFiles.filter((file) => syllabusFile(file, linkedIds));
    // An explicit Canvas syllabus link or name remains authoritative. Only courses without one
    // may inspect every receipt-backed PDF for the standalone first-page role heading.
    const files = designatedFiles.length > 0 ? designatedFiles : courseFiles.filter(declaredPdfFile);
    if (files.length > MAX_DOCUMENTS_PER_COURSE || totalFiles + files.length > MAX_DOCUMENTS) {
      output.push({ courseId, timeZone, status: "unresolved", reason: "LIMIT_EXCEEDED", sessions: [] });
      continue;
    }
    let unavailable = false, limited = false, unsupported = false;
    for (const file of files) {
      if (Date.now() - startedAt >= MAX_EXTRACTION_MILLISECONDS) { limited = true; break; }
      const receipts = bodyReceipts.get(file.id);
      const receipt = receipts?.length === 1 ? receipts[0] : null;
      if (malformedReceipts || !receipt || receipt.status !== "staged") {
        unavailable = true;
        continue;
      }
      if (receipt.byteCount > MAX_DOCUMENT_BYTES || totalBytes + receipt.byteCount > MAX_TOTAL_BYTES) {
        limited = true;
        continue;
      }
      totalFiles += 1;
      totalBytes += receipt.byteCount;
      await progress();
      const bytes = await privateStagedBytes(stagingDirectory, receipt);
      if (!bytes) { unavailable = true; continue; }
      let pages;
      const source = { kind: "file", fileId: file.id, sha256: receipt.sha256 };
      const isPdf = bytes.subarray(0, 5).toString("ascii") === "%PDF-";
      if (isPdf) {
        let firstPage;
        try { firstPage = await candidatePages(bytes, receipt, file, extractPdfText, progress, { firstPageOnly: true, structuredRows: true }); } catch { firstPage = null; }
        const designated = syllabusFile(file, linkedIds);
        if (!Array.isArray(firstPage) || firstPage.length !== 1) {
          if (!designated) { unavailable = true; continue; }
        } else {
          const structuredFirstPage = Array.isArray(firstPage[0]?.rows);
          if (structuredFirstPage && isCourseSyllabusFirstPage(firstPage[0])) {
            try { pages = await candidatePages(bytes, receipt, file, extractPdfText, progress, { structuredRows: true }); } catch { pages = null; }
            if (!Array.isArray(pages) || pages.length === 0 || pages.length > 80) { unavailable = true; continue; }
            const result = parsePdfSyllabusSchedule(pages, { timeZone, source });
            if (result === null) { unsupported = true; continue; }
            sourceResults.push(result);
            continue;
          }
          // Legacy explicit filename/link candidates retain their existing full-year-row parser.
          // Additional PDFs are discovered only through the standalone first-page heading above.
          if (!designated) {
            if (!structuredFirstPage) unavailable = true;
            continue;
          }
        }
      }
      try { pages = await candidatePages(bytes, receipt, file, extractPdfText, progress); } catch { pages = null; }
      if (pages && !Array.isArray(pages) && typeof pages.text === "string") {
        const weekly = parseWeeklySyllabusSchedule(pages, { timeZone, source });
        if (weekly !== null) {
          for (const date of syllabusCancelledDates(pages.text)) cancelledDates.add(date);
          weeklyResults.push(weekly);
          sourceResults.push(weekly);
          continue;
        }
        pages = [pages.text];
      }
      if (!pages || !Array.isArray(pages) || pages.length === 0) {
        unsupported = true;
        continue;
      }
      if (pages.length > 80 || pages.some((page) => typeof page !== "string")
          || pages.reduce((sum, page) => sum + page.length, 0) > 300_000) { limited = true; continue; }
      for (let page = 0; page < pages.length; page += 1) {
        recordSource(pages[page], { ...source, ...(isPdf ? { page: page + 1 } : {}) });
      }
    }
    const complete = sourceResults.filter((result) => result.status === "complete");
    const weeklySignatures = weeklyResults.map((result) => JSON.stringify(result.sessions
      .map((session) => [session.date, session.startTime, session.endTime]).sort()));
    const ambiguous = sourceResults.some((result) => result.reason === "AMBIGUOUS_SCHEDULE")
      || new Set(weeklySignatures).size > 1;
    if (unavailable || ambiguous || limited || sourceResults.some((result) => result.reason === "LIMIT_EXCEEDED")) {
      output.push({ courseId, timeZone, status: "unresolved",
        reason: limited || sourceResults.some((result) => result.reason === "LIMIT_EXCEEDED") ? "LIMIT_EXCEEDED"
          : unavailable ? "SOURCE_UNAVAILABLE" : "AMBIGUOUS_SCHEDULE", sessions: [] });
      continue;
    }
    const sessions = complete.flatMap((result) => result.sessions);
    if (sessions.some((session) => cancelledDates.has(session.date))) {
      output.push({ courseId, timeZone, status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
      continue;
    }
    const unique = new Map();
    for (const session of sessions) {
      const key = session.date + "|" + session.startTime + "|" + session.endTime;
      if (!unique.has(key)) unique.set(key, session);
    }
    const byDate = new Map();
    for (const session of unique.values()) {
      const prior = byDate.get(session.date);
      if (prior && (prior.startTime !== session.startTime || prior.endTime !== session.endTime)) {
        byDate.set(session.date, "ambiguous");
      } else if (!prior) byDate.set(session.date, session);
    }
    if ([...byDate.values()].includes("ambiguous")) {
      output.push({ courseId, timeZone, status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
    } else if (unique.size > 1000) {
      output.push({ courseId, timeZone, status: "unresolved", reason: "LIMIT_EXCEEDED", sessions: [] });
    } else if (unique.size > 0) {
      output.push({ courseId, timeZone, status: "complete", sessions: [...byDate.values()] });
    } else {
      const reason = sourceResults.some((result) => result.reason === "SOURCE_UNAVAILABLE")
        ? "SOURCE_UNAVAILABLE" : unsupported ? "UNSUPPORTED_DOCUMENT" : sourceResults.length === 0 ? "NO_SYLLABUS"
          : sourceResults.some((result) => result.reason === "AMBIGUOUS_SCHEDULE")
            ? "AMBIGUOUS_SCHEDULE" : "NO_SUPPORTED_SCHEDULE";
      output.push({ courseId, timeZone, status: "unresolved", reason, sessions: [] });
    }
  }
  return { schemaVersion: 1, courses: output };
}
