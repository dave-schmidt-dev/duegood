import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GradePreviewError, MAX_GRADE_PDF_BYTES, parseGradeReportPdf, proposePdfGrades } from "../../src/local/grades.ts";

describe("local PDF grade previews", () => {
  it("parses the explicitly supported synthetic layout and proposes only an exact local match", async () => {
    const bytes = await readFile(path.resolve("test/fixtures/synthetic-grade-report.pdf"));
    const rows = await parseGradeReportPdf(bytes);
    expect(rows).toEqual([{ course: "SYN-101", item: "Synthetic Submitted Work", grade: "A-" }]);
    expect(proposePdfGrades(rows, [
      { sourceItemId: "synthetic-submitted", courseCode: "SYN-101", title: "Synthetic Submitted Work", kind: "deadline" },
    ])).toEqual([expect.objectContaining({ course: "SYN-101", item: "Synthetic Submitted Work", grade: "A-", source: "User-confirmed PDF", sourceItemId: "synthetic-submitted", status: "ready" })]);
  });

  it("keeps unmatched or duplicate report rows manual-only", () => {
    const rows = [{ course: "SYN-101", item: "Synthetic Submitted Work", grade: "A-" }] as const;
    expect(proposePdfGrades(rows, [
      { sourceItemId: "one", courseCode: "SYN-101", title: "Synthetic Submitted Work", kind: "deadline" },
      { sourceItemId: "two", courseCode: "SYN-101", title: "Synthetic Submitted Work", kind: "discussion" },
    ])).toEqual([expect.objectContaining({ sourceItemId: null, status: "manual" })]);
  });

  it("rejects oversized bytes before parsing", async () => {
    await expect(parseGradeReportPdf(new Uint8Array(MAX_GRADE_PDF_BYTES + 1))).rejects.toEqual(expect.objectContaining<Partial<GradePreviewError>>({ code: "too_large" }));
  });
});
