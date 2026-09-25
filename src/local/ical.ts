/** Pure, bounded Canvas iCal normalization. This module never fetches a feed or mutates coursework. */
import { createHash } from "node:crypto";
import ical from "node-ical";
import type { VEvent } from "node-ical";
import type { SourceObservation, SourceReference } from "./acquisition";

export const MAX_ICAL_BYTES = 5 * 1024 * 1024;
export const MAX_ICAL_EVENTS = 2_000;

type EventKind = "assignment-parent" | "discussion-post-checkpoint" | "discussion-reply-checkpoint" | "other-event";
type HeldReason = "unknown-course" | "ambiguous-course" | "unsupported-event" | "floating-time" | "cancelled-event" | "ambiguous-event";

interface IcalCourseIdentity {
  /** Existing local course key; must already be validated by the caller. */
  readonly key: string;
  /** Numeric Canvas course ID from a separately validated course identity. */
  readonly canvasCourseId: string;
}

interface VerifiedCalendarEvent {
  /** Explicit, owner-verified classification for this Canvas calendar event ID. */
  readonly kind: Exclude<EventKind, "assignment-parent">;
  readonly courseId: string;
  readonly parentAssignmentId?: string;
}

interface ExplicitFeedIdentity {
  /** Existing local course key chosen by the owner after a content-free shape check. */
  readonly courseKey: string;
  /** Stable owner-verified identity, independent of the feed UID. */
  readonly stableIdentity: string;
  readonly kind: EventKind;
}

export interface IcalNormalizeOptions {
  readonly institution: string;
  /** Exact expected HTTPS Canvas origin; path, credentials, query, and fragment are forbidden. */
  readonly canvasOrigin: string;
  readonly courses: readonly IcalCourseIdentity[];
  /** Calendar event IDs whose semantics were verified outside the feed. */
  readonly verifiedEvents?: Readonly<Record<string, VerifiedCalendarEvent>>;
  /** Owner mapping for an event with no URL; changed UIDs remain held until remapped. */
  readonly explicitUidMappings?: Readonly<Record<string, ExplicitFeedIdentity>>;
}

interface IcalDateValue {
  readonly kind: "date" | "timed";
  /** YYYY-MM-DD for DATE, UTC ISO timestamp for an explicitly zoned DATE-TIME. */
  readonly value: string;
  readonly zone?: string;
}

interface NormalizedIcalEvent {
  readonly kind: EventKind;
  readonly uid: string;
  readonly course: string;
  readonly canvasCourseId?: string;
  readonly calendarIdentity: string;
  readonly title: string;
  readonly at: IcalDateValue;
  readonly cancelled: false;
  readonly observation: SourceObservation;
}

interface HeldIcalEvent {
  readonly uid: string;
  readonly reason: HeldReason;
  readonly canvasCourseId?: string;
  readonly candidateCourses?: readonly string[];
  readonly cancelled: boolean;
}

export interface IcalNormalization {
  readonly events: readonly NormalizedIcalEvent[];
  readonly observations: readonly SourceObservation[];
  readonly held: readonly HeldIcalEvent[];
  /** A feed is a rolling window. Absence authorizes no removals. */
  readonly deletions: 0;
}

export class IcalNormalizationError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "TOO_LARGE" | "TOO_MANY_EVENTS" | "MALFORMED_CALENDAR" | "UNRESOLVED_TIMEZONE") {
    super(`Calendar normalization failed: ${code}`);
    this.name = "IcalNormalizationError";
  }
}

interface RawEvent {
  readonly uid: string;
  readonly summary?: string;
  readonly start?: string;
  readonly url?: string;
  readonly status?: string;
  readonly methodCancel?: boolean;
  readonly recurrenceId?: string;
}

function safeText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/gu, (_, escaped: string) => escaped === "n" || escaped === "N" ? "\n" : escaped);
}

function rawEvents(input: string): RawEvent[] {
  const lines = input.split(/\r\n|\n|\r/u);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/u.test(line)) {
      if (unfolded.length === 0) throw new IcalNormalizationError("MALFORMED_CALENDAR");
      unfolded[unfolded.length - 1] += line.slice(1);
    } else if (line.length > 0) unfolded.push(line);
  }
  if (unfolded[0] !== "BEGIN:VCALENDAR" || unfolded.at(-1) !== "END:VCALENDAR" || !unfolded.includes("VERSION:2.0")) {
    throw new IcalNormalizationError("MALFORMED_CALENDAR");
  }
  const stack: string[] = [];
  const events: RawEvent[] = [];
  let calendarCancelled = false;
  let seenCalendar = false;
  let current: Record<string, string> | null = null;
  for (const line of unfolded) {
    if (line.startsWith("BEGIN:")) {
      const component = line.slice(6);
      if (!/^[A-Z][A-Z0-9-]*$/u.test(component)) throw new IcalNormalizationError("MALFORMED_CALENDAR");
      if (component === "VCALENDAR") {
        if (stack.length !== 0 || seenCalendar) throw new IcalNormalizationError("MALFORMED_CALENDAR");
        seenCalendar = true;
      } else if (stack.length === 0) throw new IcalNormalizationError("MALFORMED_CALENDAR");
      if (component === "VEVENT") {
        if (stack.at(-1) !== "VCALENDAR") throw new IcalNormalizationError("MALFORMED_CALENDAR");
        if (events.length >= MAX_ICAL_EVENTS) throw new IcalNormalizationError("TOO_MANY_EVENTS");
        current = {};
      }
      stack.push(component);
      continue;
    }
    if (line.startsWith("END:")) {
      const component = line.slice(4);
      if (stack.pop() !== component) throw new IcalNormalizationError("MALFORMED_CALENDAR");
      if (component === "VEVENT") {
        if (!current || !current.UID) throw new IcalNormalizationError("MALFORMED_CALENDAR");
        events.push({ uid: current.UID, ...(current.SUMMARY ? { summary: current.SUMMARY } : {}),
          ...(current.DTSTART ? { start: current.DTSTART } : {}),
          ...(current.URL ? { url: current.URL } : {}), ...(current.STATUS ? { status: current.STATUS } : {}),
          ...(current.METHOD === "METHOD:CANCEL" ? { methodCancel: true } : {}),
          ...(current["RECURRENCE-ID"] ? { recurrenceId: current["RECURRENCE-ID"] } : {}) });
        current = null;
      }
      continue;
    }
    if (stack.length === 0 || !line.includes(":")) throw new IcalNormalizationError("MALFORMED_CALENDAR");
    const tzid = /(?:^|;)TZID=([^;:]+)/iu.exec(line.slice(0, line.indexOf(":")))?.[1];
    if (tzid) {
      try { new Intl.DateTimeFormat("en-US", { timeZone: tzid }); }
      catch { throw new IcalNormalizationError("UNRESOLVED_TIMEZONE"); }
    }
    if (stack.at(-1) === "VCALENDAR" && line === "METHOD:CANCEL") calendarCancelled = true;
    if (current && stack.at(-1) === "VEVENT") {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).split(";", 1)[0]!;
      if (["UID", "SUMMARY", "DTSTART", "URL", "STATUS", "METHOD", "RECURRENCE-ID"].includes(name)) {
        if (current[name] !== undefined) throw new IcalNormalizationError("MALFORMED_CALENDAR");
        current[name] = line;
      }
    }
  }
  if (stack.length !== 0 || events.length > MAX_ICAL_EVENTS) throw new IcalNormalizationError("MALFORMED_CALENDAR");
  const value = (line: string) => line.slice(line.indexOf(":") + 1);
  const normalized = events.map((event) => ({
    uid: value(event.uid), ...(event.summary ? { summary: unescapeText(value(event.summary)) } : {}),
    ...(event.start ? { start: event.start } : {}),
    ...(event.url ? { url: value(event.url) } : {}), ...(event.status ? { status: value(event.status) } : {}),
    ...(calendarCancelled || event.methodCancel ? { methodCancel: true } : {}),
    ...(event.recurrenceId ? { recurrenceId: value(event.recurrenceId) } : {}),
  }));
  if (normalized.some((event) => !safeText(event.uid, 500) || (event.summary !== undefined && !safeText(event.summary, 1_000)))) {
    throw new IcalNormalizationError("MALFORMED_CALENDAR");
  }
  return normalized;
}

function calendarDate(raw: string, parsed: Date): IcalDateValue | "floating" {
  const [head, value] = raw.split(":", 2);
  if (!head || !value || !(parsed instanceof Date) || !Number.isFinite(parsed.getTime())) {
    throw new IcalNormalizationError("MALFORMED_CALENDAR");
  }
  if (/;VALUE=DATE(?:;|$)/iu.test(head) || /^\d{8}$/u.test(value)) {
    if (!/^\d{8}$/u.test(value)) throw new IcalNormalizationError("MALFORMED_CALENDAR");
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    if (Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw new IcalNormalizationError("MALFORMED_CALENDAR");
    }
    return { kind: "date", value: date };
  }
  if (!/^\d{8}T\d{6}Z?$/u.test(value)) throw new IcalNormalizationError("MALFORMED_CALENDAR");
  const timezone = /(?:^|;)TZID=([^;:]+)/iu.exec(head)?.[1];
  if (timezone) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); }
    catch { throw new IcalNormalizationError("UNRESOLVED_TIMEZONE"); }
  }
  if (!timezone && !value.endsWith("Z")) return "floating";
  return { kind: "timed", value: parsed.toISOString(), zone: timezone ?? "UTC" };
}

function validatedStart(raw: string): string {
  const [head, value] = raw.split(":", 2);
  if (!head || !value) {
    throw new IcalNormalizationError("MALFORMED_CALENDAR");
  }
  const parameters = head.split(";");
  if (parameters.shift()?.toUpperCase() !== "DTSTART") {
    throw new IcalNormalizationError("MALFORMED_CALENDAR");
  }
  const dateParameters = parameters.filter((parameter) => parameter.toUpperCase() === "VALUE=DATE");
  const hasOnlyDateParameters = dateParameters.length === parameters.length;
  let canonicalDateStart: string | undefined;
  if (hasOnlyDateParameters && dateParameters.length >= 1 && dateParameters.length <= 2) {
    if (!/^\d{8}$/u.test(value)) throw new IcalNormalizationError("MALFORMED_CALENDAR");
    // Canvas may repeat VALUE=DATE. node-ical receives only a canonical synthetic line.
    canonicalDateStart = `DTSTART;VALUE=DATE:${value}`;
  } else {
    if (dateParameters.length > 0 || !/^DTSTART(?:;TZID=[A-Za-z0-9_\/+.-]+)?$/iu.test(head)) {
      throw new IcalNormalizationError("MALFORMED_CALENDAR");
    }
    if (!/^\d{8}T\d{6}Z?$/u.test(value)) {
      throw new IcalNormalizationError("MALFORMED_CALENDAR");
    }
  }
  const tzid = /;TZID=([^;:]+)/iu.exec(head)?.[1];
  if (tzid) {
    if (value.endsWith("Z")) throw new IcalNormalizationError("MALFORMED_CALENDAR");
    try { new Intl.DateTimeFormat("en-US", { timeZone: tzid }); }
    catch { throw new IcalNormalizationError("UNRESOLVED_TIMEZONE"); }
  }
  const digits = value.slice(0, 8);
  const day = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  if (Number.isNaN(Date.parse(`${day}T12:00:00Z`)) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new IcalNormalizationError("MALFORMED_CALENDAR");
  }
  if (value.includes("T") && (Number(value.slice(9, 11)) > 23 || Number(value.slice(11, 13)) > 59 || Number(value.slice(13, 15)) > 59)) {
    throw new IcalNormalizationError("MALFORMED_CALENDAR");
  }
  return canonicalDateStart ?? raw;
}

interface CanonicalCanvasLink {
  readonly courseId: string;
  readonly type: "assignment" | "event";
  readonly id: string;
  readonly url: string;
}

function canonicalLink(raw: string | undefined, origin: string): CanonicalCanvasLink | null {
  if (!raw || raw.length > 2_048) return null;
  try {
    const url = new URL(raw);
    if (url.origin !== origin || url.username || url.password || url.hash || !/^https:$/u.test(url.protocol)) return null;
    const match = /^\/courses\/([1-9]\d*)\/(assignments|calendar_events)\/([1-9]\d*)\/?$/u.exec(url.pathname);
    if (!match) return null;
    const [, courseId, resource, id] = match;
    return { courseId: courseId!, type: resource === "assignments" ? "assignment" : "event", id: id!, url: `${origin}/courses/${courseId}/${resource}/${id}` };
  } catch { return null; }
}

/**
 * Canvas calendar views omit resource paths, so accept them only when a strictly
 * shaped URL and UID together provide the same resource type and numeric ID.
 */
function calendarViewLink(raw: string | undefined, uid: string, origin: string): CanonicalCanvasLink | null {
  if (!raw || raw.length > 2_048) return null;
  const uidMatch = /^event-(assignment|calendar-event)-([1-9]\d*)$/u.exec(uid);
  if (!uidMatch) return null;
  try {
    const url = new URL(raw);
    if (url.origin !== origin || url.username || url.password || url.pathname !== "/calendar") return null;
    const expectedKeys = new Set(["include_contexts", "month", "year"]);
    if (url.searchParams.size !== expectedKeys.size || [...url.searchParams.keys()].some((key) => !expectedKeys.has(key))) return null;
    const courseMatch = /^course_([1-9]\d*)$/u.exec(url.searchParams.get("include_contexts") ?? "");
    const month = url.searchParams.get("month");
    const year = url.searchParams.get("year");
    if (!courseMatch || !/^(?:0?[1-9]|1[0-2])$/u.test(month ?? "") || !/^[1-9]\d{3}$/u.test(year ?? "")) return null;
    const [, uidType, id] = uidMatch;
    const expectedFragment = uidType === "assignment" ? `#assignment_${id}` : `#calendar_event_${id}`;
    if (url.hash !== expectedFragment) return null;
    const resource = uidType === "assignment" ? "assignments" : "calendar_events";
    return {
      courseId: courseMatch[1]!, type: uidType === "assignment" ? "assignment" : "event", id: id!,
      url: `${origin}/courses/${courseMatch[1]}/${resource}/${id}`,
    };
  } catch { return null; }
}

function identifier(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** Parse a complete synthetic or owner-provided text value after enforcing byte and event caps. */
export async function normalizeCanvasIcal(input: string | Uint8Array, options: IcalNormalizeOptions): Promise<IcalNormalization> {
  if (!options || typeof options.institution !== "string" || !safeText(options.institution, 160)
      || !Array.isArray(options.courses)) throw new IcalNormalizationError("INVALID_INPUT");
  let origin: string;
  try {
    const url = new URL(options.canvasOrigin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch { throw new IcalNormalizationError("INVALID_INPUT"); }
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > MAX_ICAL_BYTES) throw new IcalNormalizationError("TOO_LARGE");
  let text: string;
  try { text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input); }
  catch { throw new IcalNormalizationError("MALFORMED_CALENDAR"); }
  const raw = rawEvents(text);
  // node-ical can warn with UID or malformed field text. Give it only synthetic UIDs and
  // validated date lines; keep private titles, URLs, and original UIDs out of its input.
  const safeStarts = raw.map((event) => event.start === undefined ? undefined : validatedStart(event.start));
  const parserText = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${raw.map((_, index) =>
    `BEGIN:VEVENT\r\nUID:SYNTHETIC-${index}\r\nSUMMARY:Synthetic\r\n${safeStarts[index] ? `${safeStarts[index]}\r\n` : ""}END:VEVENT\r\n`,
  ).join("")}END:VCALENDAR\r\n`;
  let parsed: Awaited<ReturnType<typeof ical.async.parseICS>>;
  try { parsed = await ical.async.parseICS(parserText); }
  catch { throw new IcalNormalizationError("MALFORMED_CALENDAR"); }
  const parsedEvents = Object.values(parsed).filter((entry): entry is VEvent => entry?.type === "VEVENT");
  if (parsedEvents.length !== raw.length) throw new IcalNormalizationError("MALFORMED_CALENDAR");
  const byUid = new Map(parsedEvents.map((event) => [event.uid, event]));
  const uidCounts = new Map<string, number>();
  for (const event of raw) uidCounts.set(event.uid, (uidCounts.get(event.uid) ?? 0) + 1);
  const courseMap = new Map<string, string[]>();
  const courseKeys = new Map<string, number>();
  for (const course of options.courses) {
    if (!course || typeof course.key !== "string" || !safeText(course.key, 160)
        || typeof course.canvasCourseId !== "string" || !/^[1-9]\d*$/u.test(course.canvasCourseId)) {
      throw new IcalNormalizationError("INVALID_INPUT");
    }
    courseKeys.set(course.key, (courseKeys.get(course.key) ?? 0) + 1);
    const matches = courseMap.get(course.canvasCourseId) ?? [];
    matches.push(course.key);
    courseMap.set(course.canvasCourseId, matches);
  }
  const events: NormalizedIcalEvent[] = [];
  const held: HeldIcalEvent[] = [];
  const seenIdentities = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const parsedEvent = byUid.get(`SYNTHETIC-${index}`);
    if (!parsedEvent) throw new IcalNormalizationError("MALFORMED_CALENDAR");
    const link = canonicalLink(item.url, origin) ?? calendarViewLink(item.url, item.uid, origin);
    const cancelled = item.methodCancel === true || item.status?.toUpperCase() === "CANCELLED";
    const courseCandidates = link ? [...new Set(courseMap.get(link.courseId) ?? [])].sort() : [];
    const base = { uid: item.uid, ...(link ? { canvasCourseId: link.courseId } : {}), cancelled };
    if (cancelled) { held.push({ ...base, reason: "cancelled-event" }); continue; }
    if (item.recurrenceId || (uidCounts.get(item.uid) ?? 0) > 1 && !raw.some((entry) => entry.uid === item.uid && entry.recurrenceId)) {
      held.push({ ...base, reason: "ambiguous-event" }); continue;
    }
    if (!item.start || !item.summary || !parsedEvent.start) { held.push({ ...base, reason: "unsupported-event" }); continue; }
    const at = calendarDate(item.start, parsedEvent.start);
    if (at === "floating") { held.push({ ...base, reason: "floating-time" }); continue; }
    const explicit = item.url === undefined ? options.explicitUidMappings?.[item.uid] : undefined;
    if (!link && !explicit) { held.push({ ...base, reason: "unsupported-event" }); continue; }
    if (link && courseCandidates.length === 0) { held.push({ ...base, reason: "unknown-course" }); continue; }
    if (link && (courseCandidates.length !== 1 || (courseKeys.get(courseCandidates[0]!) ?? 0) !== 1)) {
      held.push({ ...base, reason: "ambiguous-course", candidateCourses: courseCandidates }); continue;
    }
    if (explicit && (courseKeys.get(explicit.courseKey) ?? 0) !== 1) {
      held.push({ ...base, reason: (courseKeys.get(explicit.courseKey) ?? 0) === 0 ? "unknown-course" : "ambiguous-course" }); continue;
    }
    let kind: EventKind;
    let stableIdentity: string;
    if (explicit) {
      if (!["assignment-parent", "discussion-post-checkpoint", "discussion-reply-checkpoint", "other-event"].includes(explicit.kind)) {
        throw new IcalNormalizationError("INVALID_INPUT");
      }
      kind = explicit.kind;
      stableIdentity = explicit.stableIdentity;
      const expected = kind === "assignment-parent" ? /^assignment:[1-9]\d*$/u
        : kind === "other-event" ? /^event:[1-9]\d*$/u
          : new RegExp(`^assignment:[1-9]\\d+:checkpoint:${kind}$`, "u");
      if (!expected.test(stableIdentity)) throw new IcalNormalizationError("INVALID_INPUT");
    } else if (link?.type === "assignment") {
      kind = "assignment-parent";
      stableIdentity = `assignment:${link.id}`;
    } else {
      const verified = options.verifiedEvents?.[link!.id];
      if (!verified || verified.courseId !== link!.courseId) { held.push({ ...base, reason: "ambiguous-event" }); continue; }
      if (!["discussion-post-checkpoint", "discussion-reply-checkpoint", "other-event"].includes(verified.kind)) {
        throw new IcalNormalizationError("INVALID_INPUT");
      }
      kind = verified.kind;
      if (kind !== "other-event" && !/^[1-9]\d*$/u.test(verified.parentAssignmentId ?? "")) {
        throw new IcalNormalizationError("INVALID_INPUT");
      }
      stableIdentity = kind === "other-event" ? `event:${link!.id}` : `assignment:${verified.parentAssignmentId}:checkpoint:${kind}`;
    }
    const course = explicit?.courseKey ?? courseCandidates[0]!;
    const scopedIdentity = JSON.stringify([options.institution, course, stableIdentity]);
    if (seenIdentities.has(scopedIdentity)) {
      const previousIndex = events.findIndex((entry) => entry.calendarIdentity === stableIdentity && entry.course === course);
      if (previousIndex >= 0) {
        const [previous] = events.splice(previousIndex, 1);
        held.push({ uid: previous!.uid, ...(link ? { canvasCourseId: link.courseId } : {}), cancelled: false, reason: "ambiguous-event" });
      }
      held.push({ ...base, reason: "ambiguous-event" }); continue;
    }
    seenIdentities.add(scopedIdentity);
    const reference: SourceReference = { institution: options.institution, course, source: "ical", id: stableIdentity };
    const fields = { kind: kind === "assignment-parent" ? "assignment" : kind === "other-event" ? "event" : "discussion-checkpoint",
      title: item.summary, at: at.value, ...(link ? { url: link.url } : {}) };
    const observation: SourceObservation = { localId: `ical-${identifier([options.institution, course, stableIdentity])}`, course, reference, fields };
    events.push({ kind, uid: item.uid, course, ...(link ? { canvasCourseId: link.courseId } : {}),
      calendarIdentity: stableIdentity, title: item.summary, at, cancelled: false, observation });
  }
  events.sort((a, b) => a.observation.localId.localeCompare(b.observation.localId));
  held.sort((a, b) => a.uid.localeCompare(b.uid));
  return { events, observations: events.map((event) => event.observation), held, deletions: 0 };
}
