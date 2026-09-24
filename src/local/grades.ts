/** Bounded, local-only parsing for a deliberately narrow PDF grade-report layout. */

export const MAX_GRADE_PDF_BYTES = 1_000_000;
const MAX_GRADE_PDF_PAGES = 8;
const MAX_GRADE_PDF_CHARACTERS = 24_000;
const MAX_GRADE_REPORT_ROWS = 24;
const MAX_GRADE_PARSE_MS = 2_500;

export class GradePreviewError extends Error {
  constructor(readonly code: "too_large" | "unsupported" | "timed_out") {
    super("grade report needs manual entry");
  }
}

export interface ParsedGradeRow {
  readonly course: string;
  readonly item: string;
  readonly grade: string;
}

export interface GradePreviewEvent {
  readonly sourceItemId: string;
  readonly courseCode: string;
  readonly title: string;
  readonly kind: string | null;
}

export interface GradePreviewProposal {
  readonly id: string;
  readonly course: string;
  readonly item: string;
  readonly grade: string;
  readonly source: "User-confirmed PDF";
  readonly sourceItemId: string | null;
  readonly status: "ready" | "manual";
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function boundedText(value: string, maximum: number): string | null {
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function rowsFromText(text: string): readonly ParsedGradeRow[] {
  // This marker prevents us from guessing at generic Canvas/browser print layouts. The parser
  // intentionally supports only a reviewed report whose text is Course/Item/Grade triplets.
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines[0] !== "DUEGOOD GRADE REPORT") throw new GradePreviewError("unsupported");
  const rows: ParsedGradeRow[] = [];
  for (let index = 1; index < lines.length;) {
    const course = /^Course:\s*(.+)$/u.exec(lines[index] ?? "")?.[1];
    const item = /^Item:\s*(.+)$/u.exec(lines[index + 1] ?? "")?.[1];
    const grade = /^Grade:\s*(.+)$/u.exec(lines[index + 2] ?? "")?.[1];
    if (course === undefined || item === undefined || grade === undefined) throw new GradePreviewError("unsupported");
    const checked = [boundedText(course, 80), boundedText(item, 240), boundedText(grade, 80)];
    if (checked.some((value) => value === null) || rows.length >= MAX_GRADE_REPORT_ROWS) throw new GradePreviewError("unsupported");
    rows.push({ course: checked[0]!, item: checked[1]!, grade: checked[2]! });
    index += 3;
  }
  if (rows.length === 0) throw new GradePreviewError("unsupported");
  return rows;
}

/**
 * Extracts text from a local PDF without retaining bytes or raw text after this call returns.
 * The PDF is never fetched, stored, or logged.
 */
export async function parseGradeReportPdf(bytes: Uint8Array): Promise<readonly ParsedGradeRow[]> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_GRADE_PDF_BYTES) throw new GradePreviewError("too_large");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new GradePreviewError("timed_out")), MAX_GRADE_PARSE_MS); });
  let destroy: (() => Promise<void>) | undefined;
  try {
    return await Promise.race([timeout, (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, verbosity: 0 });
      destroy = async () => { await loadingTask.destroy(); };
      const document = await loadingTask.promise;
      if (document.numPages < 1 || document.numPages > MAX_GRADE_PDF_PAGES) throw new GradePreviewError("unsupported");
      let text = "";
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const content = await document.getPage(pageNumber).then((page) => page.getTextContent());
        const pageText = content.items.map((item) => "str" in item ? item.str : "").join("\n");
        if (text.length + pageText.length > MAX_GRADE_PDF_CHARACTERS) throw new GradePreviewError("unsupported");
        text += `${pageText}\n`;
      }
      return rowsFromText(text);
    })()]);
  } catch (error) {
    if (error instanceof GradePreviewError) throw error;
    throw new GradePreviewError("unsupported");
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (destroy !== undefined) await destroy().catch(() => undefined);
  }
}

/** Exact course-and-title matching makes unsupported or ambiguous reports manual-only. */
export function proposePdfGrades(rows: readonly ParsedGradeRow[], events: readonly GradePreviewEvent[]): readonly GradePreviewProposal[] {
  return rows.map((row, index) => {
    const matches = events.filter((event) => event.kind !== "class" && normalized(event.courseCode) === normalized(row.course) && normalized(event.title) === normalized(row.item));
    const match = matches.length === 1 ? matches[0] : undefined;
    return {
      id: `pdf-${String(index + 1)}`,
      course: row.course,
      item: row.item,
      grade: row.grade,
      source: "User-confirmed PDF",
      sourceItemId: match?.sourceItemId ?? null,
      status: match === undefined ? "manual" : "ready",
    };
  });
}
