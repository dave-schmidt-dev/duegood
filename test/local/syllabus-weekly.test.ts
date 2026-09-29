import { describe, expect, it } from "vitest";
import { parseWeeklySyllabusSchedule, readSyllabusDocxDocument } from "../../scripts/canvas-syllabus-weekly.mjs";

const source = { kind: "file", fileId: 77, sha256: "a".repeat(64) };
const declaration = "Meeting Day, Time, and Room Number01/04/2027-01/31/2027 Online, Synchronous Wednesday’s 6:15PM - 8:45PM";
const weeks = [
  ["01/04/27", "01/10/27", "Introduction", ""],
  ["01/11/27", "01/17/27", "No Classes - Holiday", ""],
  ["01/18/27", "01/24/27", "Discussion", "Due 01/22/2027 11:59 PM"],
  ["01/25/27", "01/31/27", "Review", ""],
];
const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const paragraph = (text: string, split = false) => "<w:p>" + (split ? text.match(/.{1,3}/gu) ?? [] : [text])
  .map((run) => "<w:r><w:t>" + escapeXml(run) + "</w:t></w:r>").join("") + "</w:p>";
const row = (cells: string[], split = false) => "<w:tr>" + cells.map((cell) => "<w:tc>" + paragraph(cell, split) + "</w:tc>").join("") + "</w:tr>";

function documentXml(options: { declaration?: string; weeks?: string[][]; before?: string; extraDeclaration?: string; split?: boolean; twoCells?: boolean } = {}) {
  const meeting = options.declaration ?? declaration;
  const header = options.twoCells ? ["Meeting Day, Time, and Location", meeting.replace(/^Meeting Day, Time, and Room Number/u, "")] : [meeting];
  return "<w:document><w:body>" + paragraph(options.before ?? "") + "<w:tbl>" + row(header, options.split)
    + (options.extraDeclaration ? row([options.extraDeclaration]) : "") + "</w:tbl>"
    + paragraph("Class Schedule") + "<w:tbl>"
    + row(["Start Date", "End Date", "Topic", "Out-of-class Assignments"], options.split)
    + (options.weeks ?? weeks).map((cells) => row(cells, options.split)).join("") + "</w:tbl></w:body></w:document>";
}

const parse = (options: Parameters<typeof documentXml>[0] = {}) => parseWeeklySyllabusSchedule(
  readSyllabusDocxDocument(documentXml(options))!, { source, timeZone: "America/New_York" },
);

describe("explicit bounded weekly syllabus declarations", () => {
  it("joins split Word runs literally and retains all covered meetings except an exact No Classes week", () => {
    const result = parse({ split: true });
    expect(result).toEqual({ status: "complete", sessions: [
      { date: "2027-01-06", startTime: "18:15", endTime: "20:45", title: "Class session", source: { ...source, line: 1 } },
      { date: "2027-01-20", startTime: "18:15", endTime: "20:45", title: "Class session", source: { ...source, line: 1 } },
      { date: "2027-01-27", startTime: "18:15", endTime: "20:45", title: "Class session", source: { ...source, line: 1 } },
    ] });
    expect(parse()).toEqual(result);
    expect(parse({ twoCells: true })).toEqual(result);
    expect(readSyllabusDocxDocument(documentXml({ split: true }))!.blocks[0]!.text).toBe(declaration);
  });

  it("uses the labelled declaration rather than office hours, withdrawal dates, or assignment clocks", () => {
    const result = parse({ before: "Office hours Thursday 9:00AM - 10:00AM. Last day to withdraw from class 02/05/2028." });
    expect(result!.status).toBe("complete");
    expect(result!.sessions.map((session) => session.date)).toEqual(["2027-01-06", "2027-01-20", "2027-01-27"]);
    const ordinary = readSyllabusDocxDocument("<w:document>" + paragraph("Office hours Wednesday 6:15PM - 8:45PM")
      + paragraph("Last day to withdraw from class 01/31/2027") + "</w:document>")!;
    expect(parseWeeklySyllabusSchedule(ordinary, { source, timeZone: "America/New_York" })).toBeNull();
  });

  it.each([
    declaration.replace("01/04/2027", "01/04/27"),
    declaration.replace("6:15PM", "6:15"),
    declaration.replace("Wednesday", "Wednesday and Thursday"),
    declaration.replace("8:45PM", "5:45PM"),
    declaration.replace("01/31/2027", "01/31/2026"),
    declaration.replace("Room Number", "Office Hours"),
  ])("holds a recognized incomplete or conflicting declaration", (invalid) => {
    expect(parse({ declaration: invalid })).toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it.each(["Thursday", "7:15PM", "01/04/2028"])("rejects inconsistent repeated declarations: %s", (replacement) => {
    const changed = replacement === "Thursday" ? declaration.replace("Wednesday", replacement)
      : replacement === "7:15PM" ? declaration.replace("6:15PM", replacement) : declaration.replace("01/04/2027", replacement);
    expect(parse({ extraDeclaration: changed })!.reason).toBe("AMBIGUOUS_SCHEDULE");
  });

  it("retains declaration meetings across overlapping, full-term, seven-day, and gapped positive coursework ranges", () => {
    const expected = parse();
    for (const variant of [
      weeks.slice(1), [...weeks, weeks[0]!],
      weeks.map((cells, i) => i ? cells : ["01/04", "01/12", ...cells.slice(2)]),
      weeks.map((cells, i) => i ? cells : ["01/04/27", "01/11/27", ...cells.slice(2)]),
      [["01/04/27", "01/31/27", "Coursework across term", ""], ...weeks],
      [weeks[1]!, weeks[3]!],
    ]) expect(parse({ weeks: variant })).toEqual(expected);
  });

  it("rejects malformed, reversed, wrong-year, and unbound table dates despite a valid declaration", () => {
    const variants = [
      weeks.map((cells, i) => i ? cells : ["01/04/26", ...cells.slice(1)]),
      weeks.map((cells, i) => i ? cells : ["not a date", ...cells.slice(1)]),
      weeks.map((cells, i) => i ? cells : ["01/10/27", "01/04/27", ...cells.slice(2)]),
      weeks.map((cells, i) => i ? cells : ["02/30/27", ...cells.slice(1)]),
      weeks.map((cells, i) => i ? cells : ["02/14/27", "02/20/27", ...cells.slice(2)]),
    ];
    for (const variant of variants) expect(parse({ weeks: variant })).toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
    const noYear = weeks.map((cells) => cells.map((cell, index) => index < 2 ? cell.slice(0, 5) : cell));
    expect(parse({ weeks: noYear })!.status).toBe("complete");
  });

  it("holds wide or conditional exclusions rather than removing an uncertain meeting", () => {
    for (const [start, end, negative] of [
      ["01/04/27", "01/11/27", "No Classes"],
      ["01/04/27", "01/31/27", "No Classes"],
      ["01/04/27", "01/10/27", "No Classes unless the instructor confirms"],
      ["01/04/27", "01/10/27", "No Classes except Wednesday"],
    ]) expect(parse({ weeks: [[start!, end!, negative!, ""]] }))
      .toEqual({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it("distinguishes a complete labelled midterm due deadline from a meeting override", () => {
    const expected = parse();
    for (const topic of [
      "Sunday January 10 Midterm is due by 11 PM",
      "Sunday, January 10, 2027 Midterm exam due by 11:30 PM",
      "Sunday January 10 Midterm assignment will be due by 11 PM",
      "Sunday January 10 Midterm Quiz-2 (online) draft due by 11 PM",
      "Sunday January 10 Midterm [case-1] is due by 11 PM",
      "Sunday January 10 Midterm case-study 2 final draft due by 11 PM",
    ]) expect(parse({ weeks: weeks.map((cells, i) => i ? cells : [cells[0]!, cells[1]!, topic, ""]) })).toEqual(expected);
    for (const topic of [
      "Monday January 10 Midterm is due by 11 PM",
      "Sunday February 30 Midterm is due by 11 PM",
      "Sunday January 10 Midterm is due by 13 PM",
      "Sunday January 10 Midterm exam meets at 11 PM",
      "Sunday January 10 Midterm exam due by 11 PM; Class rescheduled",
      "Sunday January 10 Midterm is due by 11 PM; No class",
      "Sunday January 10 Midterm class-review due by 11 PM",
      "Sunday January 10 Midterm meeting due by 11 PM",
      "Sunday January 10 Midterm rescheduled due by 11 PM",
      "Sunday January 10 Midterm postponed due by 11 PM",
      "Sunday January 10 Midterm cancelled due by 11 PM",
      "Sunday January 10 Midterm asynchronous due by 11 PM",
      "Sunday January 10 Midterm Wednesday due by 11 PM",
      "Sunday January 10 Midterm 7PM review due by 11 PM",
      "Sunday January 10 Midterm title has more than four tokens due by 11 PM",
    ]) expect(parse({ weeks: weeks.map((cells, i) => i ? cells : [cells[0]!, cells[1]!, topic, ""]) })!.reason).toBe("AMBIGUOUS_SCHEDULE");
  });

  it.each(["Class Wednesday 7:15PM", "Class Thursday", "Class postponed", "No school", "Holiday", "No Classes except Wednesday", "Class will not meet"])(
    "holds unsupported week exceptions or clock overrides: %s", (topic) => {
      const changed = weeks.map((cells, i) => i ? cells : [cells[0]!, cells[1]!, topic, ""]);
      expect(parse({ weeks: changed })!.reason).toBe("AMBIGUOUS_SCHEDULE");
    },
  );

  it("bounds declarations, rows, source location, and invalid source/zone facts", () => {
    expect(parse({ declaration: declaration.replace("01/31/2027", "01/31/2028") })!.reason).toBe("LIMIT_EXCEEDED");
    expect(parse({ weeks: Array.from({ length: 61 }, () => weeks[0]!) })!.reason).toBe("LIMIT_EXCEEDED");
    const document = readSyllabusDocxDocument(documentXml())!;
    expect(parseWeeklySyllabusSchedule(document, { source, timeZone: "Not/AZone" })!.reason).toBe("SOURCE_UNAVAILABLE");
    expect(parseWeeklySyllabusSchedule(document, { source: { ...source, fileId: 0 }, timeZone: "UTC" })!.reason).toBe("SOURCE_UNAVAILABLE");
    expect(readSyllabusDocxDocument("<w:document>" + paragraph("x".repeat(300001)) + "</w:document>")).toBeNull();
    expect(parseWeeklySyllabusSchedule({ ...document, text: "x".repeat(300001) }, { source, timeZone: "UTC" })!.reason).toBe("LIMIT_EXCEEDED");
  });

  it("decodes XML entities only once in the weekly declaration", () => {
    expect(parse({ declaration: declaration.replace("6:15PM", "6:15&amp;nbsp;PM") })!.reason).toBe("AMBIGUOUS_SCHEDULE");
  });
});
