import { describe, expect, it } from "vitest";
import { isCourseSyllabusFirstPage, parsePdfSyllabusSchedule } from "../../scripts/canvas-syllabus-pdf.mjs";

type Row = { text: string; line: number; items: Array<{ text: string; x: number }> };
const row = (line: number, text: string, items = [{ text, x: 30 }]): Row => ({ text, line, items });
const source = { kind: "file", fileId: 77, sha256: "a".repeat(64) };
const options = { timeZone: "America/New_York", source };

function pages(): Array<{ text: string; rows: Row[] }> {
  return [
    { text: "Course Syllabus\nMeeting Day, Time, and Room Number\nWednesday 6:00 PM - 8:30 PM", rows: [
      row(1, "Course Syllabus"), row(2, "Meeting Day, Time, and Room Number"), row(3, "Wednesday 6:00 PM - 8:30 PM"),
    ] },
    { text: "Class Schedule\nFall 2030 Semester Course Dates", rows: [row(1, "Class Schedule"), row(2, "Fall 2030 Semester Course Dates")] },
    { text: "Weekly Schedule\nClass Date Due Date\nSeptember 4 September 6\nSeptember 11 September 13", rows: [
      row(1, "Weekly Schedule"),
      row(2, "Class Date Due Date", [{ text: "Class Date", x: 30 }, { text: "Due Date", x: 210 }]),
      row(3, "September 4 September 6", [{ text: "September 4", x: 30 }, { text: "September 6", x: 210 }]),
      row(4, "September 11 September 13", [{ text: "September 11", x: 30 }, { text: "September 13", x: 210 }]),
    ] },
  ];
}

describe("receipt-backed PDF syllabus grammar", () => {
  it("derives dates only from the Class Date column with first-page and source proof", () => {
    expect(parsePdfSyllabusSchedule(pages(), options)).toEqual({ status: "complete", sessions: [
      { date: "2030-09-04", startTime: "18:00", endTime: "20:30", title: "Class session", source: { ...source, page: 3, line: 3 } },
      { date: "2030-09-11", startTime: "18:00", endTime: "20:30", title: "Class session", source: { ...source, page: 3, line: 4 } },
    ] });
  });

  it("does not discover an incidental heading or flattened date columns", () => {
    expect(isCourseSyllabusFirstPage("This refers to the Course Syllabus")).toBe(false);
    const flattened = pages();
    flattened[2] = { text: flattened[2]!.text, rows: [
      row(1, "Weekly Schedule"), row(2, "Class Date Due Date", [{ text: "Class Date Due Date", x: 30 }]),
      row(3, "September 4 September 6", [{ text: "September 4 September 6", x: 30 }]),
    ] };
    expect(parsePdfSyllabusSchedule(flattened, options)).toMatchObject({ status: "unresolved", reason: "AMBIGUOUS_SCHEDULE", sessions: [] });
  });

  it("holds office-hour and final-exam clock rows unresolved", () => {
    for (const text of ["Wednesday 6:00 PM - 8:30 PM Office Hours", "Wednesday 6:00 PM - 8:30 PM Final Exam"]) {
      const candidate = pages();
      candidate[0] = { text: candidate[0]!.text, rows: [row(1, "Course Syllabus"), row(2, "Meeting Day, Time, and Room Number"), row(3, text)] };
      expect(parsePdfSyllabusSchedule(candidate, options)).toMatchObject({ status: "unresolved", sessions: [] });
    }
  });

  it("rejects malformed or unrelated Class Date cells while leaving Due Date clocks out of meeting time", () => {
    const continuation = pages();
    continuation[2]!.rows.splice(3, 0, row(4, "2030 September 13", [{ text: "2030", x: 30 }, { text: "September 13", x: 210 }]));
    continuation[2]!.rows[2] = row(3, "Wednesday, September 4, September 6", [{ text: "Wednesday, September 4,", x: 30 }, { text: "September 6", x: 210 }]);
    continuation[2]!.rows[4]!.line = 5;
    const continuationResult = parsePdfSyllabusSchedule(continuation, options);
    if (continuationResult === null) throw new Error("synthetic structured PDF must reach the bounded parser");
    expect(continuationResult.sessions[0]).toMatchObject({ date: "2030-09-04", source: { line: 3 } });

    const split = pages();
    split[2]!.rows[2] = row(3, "September 4 September 6", [
      { text: "September", x: 30 }, { text: "4", x: 82 }, { text: "September 6", x: 210 },
    ]);
    const splitResult = parsePdfSyllabusSchedule(split, options);
    if (splitResult === null) throw new Error("synthetic structured PDF must reach the bounded parser");
    expect(splitResult).toMatchObject({ status: "complete" });
    expect(splitResult.sessions[0]).toMatchObject({ date: "2030-09-04" });

    const invalid = pages();
    invalid[2]!.rows[2] = row(3, "September 31 September 6", [{ text: "September 31", x: 30 }, { text: "September 6", x: 210 }]);
    expect(parsePdfSyllabusSchedule(invalid, options)).toMatchObject({ status: "unresolved", sessions: [] });

    const unrelated = pages();
    unrelated[2]!.rows[2] = row(3, "September 4 Topic September 6", [
      { text: "September 4", x: 30 }, { text: "Topic", x: 70 }, { text: "September 6", x: 210 },
    ]);
    expect(parsePdfSyllabusSchedule(unrelated, options)).toMatchObject({ status: "unresolved", sessions: [] });

    const multiple = pages();
    multiple[2]!.rows[2] = row(3, "September 4 September 5 September 6", [
      { text: "September 4", x: 30 }, { text: "September 5", x: 82 }, { text: "September 6", x: 210 },
    ]);
    expect(parsePdfSyllabusSchedule(multiple, options)).toMatchObject({ status: "unresolved", sessions: [] });

    const invalidWeekday = pages();
    invalidWeekday[2]!.rows.splice(3, 0, row(4, "2030 September 13", [{ text: "2030", x: 30 }, { text: "September 13", x: 210 }]));
    invalidWeekday[2]!.rows[2] = row(3, "Tuesday, September 4, September 6", [{ text: "Tuesday, September 4,", x: 30 }, { text: "September 6", x: 210 }]);
    invalidWeekday[2]!.rows[4]!.line = 5;
    expect(parsePdfSyllabusSchedule(invalidWeekday, options)).toMatchObject({ status: "unresolved", sessions: [] });

    const dueClock = pages();
    dueClock[2]!.rows[2] = row(3, "September 4 September 6 11:59 PM", [
      { text: "September 4", x: 30 }, { text: "September 6 11:59 PM", x: 210 },
    ]);
    const dueResult = parsePdfSyllabusSchedule(dueClock, options);
    if (dueResult === null) throw new Error("synthetic structured PDF must reach the bounded parser");
    expect(dueResult).toMatchObject({ status: "complete" });
    expect(dueResult.sessions[0]).toMatchObject({ date: "2030-09-04", startTime: "18:00", endTime: "20:30" });

    const conflictingClock = pages();
    conflictingClock[0]!.rows[2] = row(3, "Wednesday 6:00 PM - 8:30 PM; 9:00 PM");
    expect(parsePdfSyllabusSchedule(conflictingClock, options)).toMatchObject({ status: "unresolved", sessions: [] });
  });
});
