import type { ElementDescriptor } from "../dom";
import type { DashboardCourse, DashboardSourceStatus } from "./dashboard";

const COLORS = ["#365e8d", "#8b7840", "#4e785f", "#8a5d72", "#67717f"] as const;
const KNOWN_ORDER: Readonly<Record<string, number>> = { IT530: 0, IT540: 1, IT570: 2 };

export function el(tag: string, text?: string, attrs?: Record<string, string>, children?: readonly ElementDescriptor[]): ElementDescriptor {
  return { tag, ...(text === undefined ? {} : { text }), ...(attrs === undefined ? {} : { attrs }), ...(children === undefined ? {} : { children }) };
}

export function key(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9]/g, ""); }

export function code(value: string): string {
  const match = /^(IT)(\d+)$/.exec(key(value));
  return match ? `${match[1]} ${match[2]}` : value;
}

export function orderedCourses(courses: readonly DashboardCourse[]): readonly DashboardCourse[] {
  return [...courses].sort((a, b) => (KNOWN_ORDER[key(a.courseCode)] ?? 100) - (KNOWN_ORDER[key(b.courseCode)] ?? 100)
    || key(a.courseCode).localeCompare(key(b.courseCode)) || a.id.localeCompare(b.id));
}

export function color(courses: readonly DashboardCourse[], courseCode: string): string {
  const index = Math.max(0, orderedCourses(courses).findIndex((course) => key(course.courseCode) === key(courseCode)));
  return COLORS[index % COLORS.length] ?? COLORS[0];
}

export function isDateOnly(value: string | number | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function asDate(value: string | number | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const date = new Date(isDateOnly(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) || isDateOnly(value) && dayKey(date) !== value ? undefined : date;
}

export function formatted(value: string | number | null | undefined, withTime = false): string {
  const date = asDate(value);
  return date === undefined ? "Unknown" : new Intl.DateTimeFormat("en-US", withTime && !isDateOnly(value)
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" }).format(date);
}

export function empty(text: string): ElementDescriptor { return el("div", text, { class: "empty-state", role: "status" }); }

export function heading(eyebrow: string, title: string, copy: string, count?: string): ElementDescriptor {
  return el("header", undefined, { class: "subpage-heading" }, [
    el("div", undefined, undefined, [el("p", eyebrow, { class: "eyebrow" }), el("h1", title), el("p", copy)]),
    ...(count === undefined ? [] : [el("div", count, { class: "page-count" })]),
  ]);
}

export function courseworkIsVerified(source: DashboardSourceStatus, courses: readonly DashboardCourse[]): boolean {
  const emptyCatalogVerified = courses.length === 0
    && source.browserFreshness?.current === true
    && source.browserFreshness.reason === "verified-import"
    && source.browserFreshness.sections.some((section) => section.endpoint === "coursesActive" && section.courseId === null && section.current);
  return (source.coursework === "synced" || emptyCatalogVerified) && source.browserFreshness?.current !== false;
}
