import { describe, expect, it } from "vitest";
import { MAX_ICAL_BYTES, MAX_ICAL_EVENTS, IcalNormalizationError, normalizeCanvasIcal } from "../../src/local/ical";

const origin = "https://canvas.synthetic.invalid";
const options = {
  institution: "synthetic.institution.invalid",
  canvasOrigin: origin,
  courses: [{ key: "course-a", canvasCourseId: "42" }],
  verifiedEvents: {
    "101": { kind: "discussion-post-checkpoint", courseId: "42", parentAssignmentId: "5" },
    "102": { kind: "discussion-reply-checkpoint", courseId: "42", parentAssignmentId: "5" },
    "103": { kind: "other-event", courseId: "42" },
  },
} as const;

function event(uid: string, url: string, extra = "", summary = "Synthetic work", start = "DTSTART:20300120T150000Z"): string {
  return `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20300101T000000Z\r\nSUMMARY:${summary}\r\n${start}\r\nURL:${url}\r\n${extra}END:VEVENT\r\n`;
}
function feed(...events: string[]): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Due Good//Synthetic Test//EN\r\n${events.join("")}END:VCALENDAR\r\n`;
}
const assignment = `${origin}/courses/42/assignments/5`;
const calendarEvent = (id: string) => `${origin}/courses/42/calendar_events/${id}`;

 describe("bounded Canvas iCal normalizer", () => {
  it("uses verified assignment identity across changed override UIDs and keeps checkpoints separate", async () => {
    const first = await normalizeCanvasIcal(feed(
      event("uid-parent-original", assignment),
      event("uid-post", calendarEvent("101")),
      event("uid-reply", calendarEvent("102")),
      event("uid-class", calendarEvent("103")),
    ), options);
    const override = await normalizeCanvasIcal(feed(event("uid-parent-override", assignment)), options);
    expect(first.events.map((entry) => entry.kind).sort()).toEqual([
      "assignment-parent", "discussion-post-checkpoint", "discussion-reply-checkpoint", "other-event",
    ]);
    expect(first.events.find((entry) => entry.kind === "assignment-parent")?.observation.localId)
      .toBe(override.events[0]?.observation.localId);
    expect(new Set(first.events.map((entry) => entry.observation.localId)).size).toBe(4);
    expect(first.events.find((entry) => entry.kind === "discussion-post-checkpoint")?.calendarIdentity)
      .toBe("assignment:5:checkpoint:discussion-post-checkpoint");
    expect(first.observations.every((entry) => !("canvasId" in entry.fields))).toBe(true);
    expect(first.deletions).toBe(0);
    expect(override.deletions).toBe(0);
  });

  it("preserves date-only values, explicit UTC, and IANA zoned times without guessing floating time", async () => {
    const day = await normalizeCanvasIcal(feed(event("day", assignment, "", "Synthetic date", "DTSTART;VALUE=DATE:20300120")), options);
    expect(day.events[0]?.at).toEqual({ kind: "date", value: "2030-01-20" });
    const utc = await normalizeCanvasIcal(feed(event("utc", assignment)), options);
    expect(utc.events[0]?.at).toEqual({ kind: "timed", value: "2030-01-20T15:00:00.000Z", zone: "UTC" });
    const zoned = await normalizeCanvasIcal(feed(event("zoned", assignment, "", "Synthetic zoned", "DTSTART;TZID=America/New_York:20300120T150000")), options);
    expect(zoned.events[0]?.at).toEqual({ kind: "timed", value: "2030-01-20T20:00:00.000Z", zone: "America/New_York" });
    const floating = await normalizeCanvasIcal(feed(event("floating", assignment, "", "Synthetic floating", "DTSTART:20300120T150000")), options);
    expect(floating).toMatchObject({ observations: [], held: [{ reason: "floating-time" }], deletions: 0 });
  });

  it("unfolds lines and unescapes calendar text", async () => {
    const input = feed(event("folded", assignment, "", "Synthetic\\, folded\\; title\\nline\r\n continuation"));
    const result = await normalizeCanvasIcal(input, options);
    expect(result.events[0]?.title).toBe("Synthetic, folded; title\nlinecontinuation");
  });

  it("holds unknown or ambiguous courses, unsupported links, and unverified calendar events", async () => {
    const input = feed(event("unknown", `${origin}/courses/999/assignments/5`), event("unverified", calendarEvent("900")),
      event("foreign", "https://foreign.synthetic.invalid/courses/42/assignments/5"));
    const result = await normalizeCanvasIcal(input, options);
    expect(result.observations).toEqual([]);
    expect(result.held.map((entry) => entry.reason).sort()).toEqual(["ambiguous-event", "unknown-course", "unsupported-event"]);
    const ambiguous = await normalizeCanvasIcal(feed(event("ambiguous", assignment)), {
      ...options, courses: [{ key: "course-a", canvasCourseId: "42" }, { key: "course-b", canvasCourseId: "42" }],
    });
    expect(ambiguous.held).toMatchObject([{ reason: "ambiguous-course", candidateCourses: ["course-a", "course-b"] }]);
  });

  it("accepts an explicit owner mapping for a missing course link and holds a changed unmapped UID", async () => {
    const noUrl = (uid: string) => event(uid, assignment).replace(`URL:${assignment}\r\n`, "");
    const mapped = await normalizeCanvasIcal(feed(noUrl("owner-mapped")), {
      ...options,
      explicitUidMappings: { "owner-mapped": { courseKey: "course-a", kind: "assignment-parent", stableIdentity: "assignment:5" } },
    });
    const linked = await normalizeCanvasIcal(feed(event("verified-link", assignment)), options);
    expect(mapped.events[0]?.observation.localId).toBe(linked.events[0]?.observation.localId);
    expect(mapped.events[0]).not.toHaveProperty("canvasCourseId");
    expect(mapped.observations[0]?.fields).not.toHaveProperty("url");
    const changed = await normalizeCanvasIcal(feed(noUrl("changed-uid")), {
      ...options,
      explicitUidMappings: { "owner-mapped": { courseKey: "course-a", kind: "assignment-parent", stableIdentity: "assignment:5" } },
    });
    expect(changed).toMatchObject({ observations: [], held: [{ reason: "unsupported-event" }], deletions: 0 });
  });

  it("holds cancellations and repeated identities without inferring deletion", async () => {
    const result = await normalizeCanvasIcal(feed(event("cancelled", assignment, "STATUS:CANCELLED\r\n"),
      event("first", calendarEvent("101")), event("second", calendarEvent("101"))), options);
    expect(result.observations).toHaveLength(0);
    expect(result.held.map((entry) => entry.reason).sort()).toEqual(["ambiguous-event", "ambiguous-event", "cancelled-event"]);
    expect(result.deletions).toBe(0);
  });

  it("rejects malformed, incomplete, oversized, overcount, and unresolved timezone input with content-free errors", async () => {
    const rejects = async (input: string, code: IcalNormalizationError["code"]) => {
      await expect(normalizeCanvasIcal(input, options)).rejects.toMatchObject({ code, message: `Calendar normalization failed: ${code}` });
    };
    await rejects("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:secret-sentinel", "MALFORMED_CALENDAR");
    await rejects(feed(event("bad-zone", assignment, "", "Synthetic zone", "DTSTART;TZID=Unknown/Nope:20300120T150000")), "UNRESOLVED_TIMEZONE");
    await rejects("x".repeat(MAX_ICAL_BYTES + 1), "TOO_LARGE");
    await rejects(feed(...Array.from({ length: MAX_ICAL_EVENTS + 1 }, (_, index) => event(`id-${index}`, assignment))), "TOO_MANY_EVENTS");
  });

  it("holds calendar and event METHOD:CANCEL without treating them as deletion", async () => {
    const eventMethod = await normalizeCanvasIcal(feed(event("event-cancel", assignment, "METHOD:CANCEL\r\n")), options);
    expect(eventMethod).toMatchObject({ observations: [], held: [{ reason: "cancelled-event" }], deletions: 0 });
    const wholeCalendar = feed(event("calendar-cancel", assignment)).replace("VERSION:2.0\r\n", "VERSION:2.0\r\nMETHOD:CANCEL\r\n");
    const calendarMethod = await normalizeCanvasIcal(wholeCalendar, options);
    expect(calendarMethod).toMatchObject({ observations: [], held: [{ reason: "cancelled-event" }], deletions: 0 });
  });

  it("holds recurrence overrides and missing-summary events while retaining unrelated observations", async () => {
    const recurrence = event("shared", assignment, "RECURRENCE-ID:20300120T150000Z\r\n", "Override");
    const cancelledNoSummary = "BEGIN:VEVENT\r\nUID:cancel-no-title\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n";
    const missingSummary = "BEGIN:VEVENT\r\nUID:missing-title\r\nDTSTART:20300120T150000Z\r\nURL:"
      + assignment + "\r\nEND:VEVENT\r\n";
    const result = await normalizeCanvasIcal(feed(event("shared", assignment), recurrence,
      cancelledNoSummary, missingSummary, event("valid", calendarEvent("103"))), options);
    expect(result.observations).toHaveLength(2);
    expect(result.held.map((entry) => entry.reason).sort()).toEqual([
      "ambiguous-event", "cancelled-event", "unsupported-event",
    ]);
    expect(result.deletions).toBe(0);
  });

  it("keeps source content out of parser warnings and rejects a second calendar envelope", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const input = feed(event("synthetic-private-sentinel", assignment, "DURATION:private-sentinel\r\n"));
      expect((await normalizeCanvasIcal(input, options)).observations).toHaveLength(1);
      expect(warnings).toEqual([]);
      await expect(normalizeCanvasIcal(input + input, options)).rejects.toMatchObject({ code: "MALFORMED_CALENDAR" });
    } finally { console.warn = originalWarn; }
  });

  it("returns idempotent normalized output for identical complete input", async () => {
    const input = feed(event("stable", assignment));
    expect(await normalizeCanvasIcal(input, options)).toEqual(await normalizeCanvasIcal(input, options));
  });
});
