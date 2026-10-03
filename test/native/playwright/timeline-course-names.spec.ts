import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const COURSES = [
  { key: "4101", title: "Applied Network Defense" },
  { key: "4102", title: "Data Ethics in Society" },
  { key: "4103", title: "Statistics for Research, Measurement, and Applied Analytics" },
] as const;
const EXTRA_COURSES = [
  { key: "4104", title: "Secure Cloud Operations" },
  { key: "4105", title: "Digital Forensics and Incident Response" },
] as const;
const ALL_COURSES = [...COURSES, ...EXTRA_COURSES];
type SyntheticCourse = (typeof ALL_COURSES)[number];
const at = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16);
const assignmentAt = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
const DATE_ONLY_CLASS_DATE = at(10).slice(0, 10);
const TIMED_CLASS_START = at(11);
const DATE_ONLY_DEADLINE = at(9).slice(0, 10);

function courseworkDocument(courses: readonly SyntheticCourse[]): string {
  return JSON.stringify({
    generated: new Date().toISOString(),
    courses: courses.map((course) => ({ ...course, code: course.key, color: "#3a6ea5", folder: course.key })),
    items: [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `synthetic-${String(index)}`,
        course: courses[index % courses.length]?.key ?? "4101",
        kind: "assignment",
        title: `Synthetic assignment ${String(index + 1)}`,
        at: assignmentAt(index + 0.5),
        submissionStatus: "unsubmitted",
        done: false,
      })),
      { id: "synthetic-date-only-deadline", course: "4103", kind: "assignment", title: "Synthetic date-only deadline", at: DATE_ONLY_DEADLINE, submissionStatus: "unsubmitted", done: false },
      { id: "synthetic-date-only-class", course: "4101", kind: "class", title: "Synthetic date-only class", at: DATE_ONLY_CLASS_DATE },
      { id: "synthetic-timed-class", course: "4102", kind: "class", title: "Synthetic timed class", at: TIMED_CLASS_START },
    ],
  });
}

function installTauriMock(document: string): void {
  type Callback = (message: unknown) => void;
  const scope = window as unknown as Record<string, unknown>;
  const callbacks = new Map<number, Callback>();
  let nextId = 1;
  scope.isTauri = true;
  scope.__TAURI_INTERNALS__ = {
    transformCallback(callback: Callback): number { const id = nextId; nextId += 1; callbacks.set(id, callback); return id; },
    unregisterCallback(id: number): void { callbacks.delete(id); },
    async invoke(command: string): Promise<unknown> {
      if (command === "store_status") return {
        availability: "ready", state: "authoritative", dataFolder: "~/Library/Application Support/com.zerodelta.duegood",
        legacyRootSelected: true, importedAt: "2026-09-22T12:00:00Z", files: 5, bytes: 20_480,
        canvasRefreshEnabled: false, refreshAvailable: false, icalRefreshAvailable: false, snapshotInProgress: false, problem: null,
      };
      if (command === "read_dashboard_documents") return {
        storeState: "authoritative", coursework: { text: document, version: "c".repeat(64) }, refreshHistory: null,
        conversations: null, profile: JSON.stringify({ name: "Synthetic Learner" }), avatar: null, courseExports: {},
      };
      if (command === "read_avatar_bytes") return null;
      throw { code: "internal", message: `unexpected synthetic command ${command}` };
    },
  };
}

async function openTimeline(page: Page, courses: readonly SyntheticCourse[] = COURSES): Promise<void> {
  await page.addInitScript(installTauriMock, courseworkDocument(courses));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
  await expect(page.locator(".lane-header .lane-label")).toHaveCount(courses.length);
  await expect(page.locator(".lane-header .lane-label b")).toHaveText(courses.map((course) => course.title));
  await expect(page.locator(".lane-header .lane-marker")).toHaveAttribute("aria-hidden", "true");
}

test("keeps the upcoming rail beside aligned wrapped three and five course lanes", async ({ page }) => {
  for (const width of [1040, 1160]) {
    for (const courses of [COURSES, ALL_COURSES]) {
      await page.setViewportSize({ width, height: 900 });
      await openTimeline(page, courses);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${width}px with ${courses.length} courses`).toBeLessThanOrEqual(0);
      const layout = await page.evaluate(() => {
        const parent = document.querySelector<HTMLElement>(".timeline-layout");
        const timeline = document.querySelector<HTMLElement>(".timeline-shell");
        const rail = document.querySelector<HTMLElement>(".timeline-rail");
        if (parent === null || timeline === null || rail === null) return null;
        const parentRect = parent.getBoundingClientRect();
        const timelineRect = timeline.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        return {
          parentWidth: parentRect.width,
          parentRight: parentRect.right,
          timelineRight: timelineRect.right,
          railLeft: railRect.left,
          railRight: railRect.right,
          railWidth: railRect.width,
        };
      });
      expect(layout).not.toBeNull();
      expect(layout?.railLeft ?? 0).toBeGreaterThanOrEqual((layout?.timelineRight ?? 0) - 0.5);
      expect(layout?.railRight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((layout?.parentRight ?? 0) + 0.5);
      expect(layout?.railWidth ?? 0).toBeGreaterThanOrEqual(220);
      expect(layout?.railWidth ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((layout?.parentWidth ?? 0) * 0.3);

      const deltas = await gridDeltas(page);
      expect(deltas, `${width}px with ${courses.length} courses`).not.toBeNull();
      expect(deltas?.every((delta) => delta <= 0.5)).toBe(true);
      const wrappedTitleCount = await page.locator(".lane-label b").evaluateAll((labels) => labels.filter((label) => {
        const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
        return label.getBoundingClientRect().height >= lineHeight * 1.8;
      }).length);
      expect(wrappedTitleCount, `${width}px with ${courses.length} courses`).toBeGreaterThan(0);
      const thirdTitleWrapped = await page.locator(".lane-label b").nth(2).evaluate((label) => {
        const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
        return label.getBoundingClientRect().height >= lineHeight * 1.8;
      });
      expect(thirdTitleWrapped, `third course title wraps at ${width}px with ${courses.length} courses`).toBe(true);

      const railDates = await page.locator(".rail-due-row .rail-date").evaluateAll((dates) => dates.map((date) => (date as HTMLTimeElement).dateTime));
      expect(railDates.length).toBeGreaterThan(0);
      expect(railDates).toEqual([...railDates].sort((left, right) => Date.parse(left) - Date.parse(right)));
      await expect(page.locator(".rail-due-row .rail-date strong").first()).toBeVisible();
      await expect(page.locator(".rail-due-row .rail-course").first()).toHaveText("4101");
    }
  }
});

async function gridDeltas(page: Page): Promise<number[] | null> {
  return page.evaluate(() => {
    const header = document.querySelector(".lane-header");
    const row = document.querySelector(".day-slot");
    if (header === null || row === null) return null;
    const headerCells = [header.querySelector(".lane-summary"), header.querySelector(".lane-marker"), ...header.querySelectorAll(".lane-label")];
    const rowCells = [row.querySelector(".day-date"), row.querySelector(".day-rail"), ...row.querySelectorAll(".course-lane")];
    if (headerCells.length !== rowCells.length) return null;
    return headerCells.flatMap((cell, index) => {
      const rowCell = rowCells[index];
      if (!(cell instanceof HTMLElement) || !(rowCell instanceof HTMLElement)) return [Number.POSITIVE_INFINITY];
      const head = cell.getBoundingClientRect();
      const body = rowCell.getBoundingClientRect();
      return [Math.abs(head.left - body.left), Math.abs(head.right - body.right)];
    });
  });
}

async function paintedDividerEvidence(page: Page): Promise<{
  summaryRightWidth: string;
  summaryRightStyle: string;
  markerRightWidth: string;
  markerRightStyle: string;
  markerLine: { x: number; width: number; color: string; top: string; bottom: string } | null;
  dayLine: { x: number; width: number; color: string; top: string; bottom: string } | null;
  headerBorders: { x: number; width: string; style: string; color: string }[];
  courseBorders: { x: number; width: string; style: string; color: string }[];
}> {
  return page.evaluate(() => {
    const summary = document.querySelector<HTMLElement>(".lane-summary");
    const marker = document.querySelector<HTMLElement>(".lane-marker");
    const header = document.querySelector<HTMLElement>(".lane-header");
    const dayRail = document.querySelector<HTMLElement>(".day-slot:not(.today) .day-rail");
    if (summary === null || marker === null || header === null || dayRail === null) throw new Error("Synthetic timeline divider fixtures are missing.");
    const pseudoLine = (element: HTMLElement, pseudo: string) => {
      const style = getComputedStyle(element, pseudo);
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + Number.parseFloat(style.left),
        width: Number.parseFloat(style.width),
        color: style.backgroundColor,
        top: style.top,
        bottom: style.bottom,
      };
    };
    const border = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        x: element.getBoundingClientRect().left + Number.parseFloat(style.borderLeftWidth) / 2,
        width: style.borderLeftWidth,
        style: style.borderLeftStyle,
        color: style.borderLeftColor,
      };
    };
    const summaryStyle = getComputedStyle(summary);
    const markerStyle = getComputedStyle(marker);
    return {
      summaryRightWidth: summaryStyle.borderRightWidth,
      summaryRightStyle: summaryStyle.borderRightStyle,
      markerRightWidth: markerStyle.borderRightWidth,
      markerRightStyle: markerStyle.borderRightStyle,
      markerLine: pseudoLine(marker, "::before"),
      dayLine: pseudoLine(dayRail, "::before"),
      headerBorders: [...header.querySelectorAll(".lane-label")].map(border),
      courseBorders: [...dayRail.closest(".day-slot")?.querySelectorAll<HTMLElement>(".course-lane") ?? []].map(border),
    };
  });
}

test("keeps named header date, marker, and course columns aligned before and during scroll", async ({ page }) => {
  const evidence = resolve(".logs/delivery/timeline-painted-borders-desktop.png");
  mkdirSync(resolve(".logs/delivery"), { recursive: true });

  for (const viewport of [{ width: 1280, height: 704 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await openTimeline(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    const beforeScroll = await gridDeltas(page);
    expect(beforeScroll).not.toBeNull();
    expect(beforeScroll?.every((delta) => delta <= 0.5)).toBe(true);
    const paintBefore = await paintedDividerEvidence(page);
    expect(paintBefore.summaryRightWidth).toBe("0px");
    expect(paintBefore.summaryRightStyle).toBe("none");
    expect(paintBefore.markerRightWidth).toBe("0px");
    expect(paintBefore.markerRightStyle).toBe("none");
    expect(paintBefore.headerBorders).toHaveLength(COURSES.length);
    expect(paintBefore.courseBorders).toHaveLength(COURSES.length);
    expect(paintBefore.markerLine).not.toBeNull();
    expect(paintBefore.dayLine).not.toBeNull();
    expect(paintBefore.markerLine?.width).toBe(1);
    expect(paintBefore.dayLine?.width).toBe(1);
    expect(paintBefore.markerLine?.color).toBe(paintBefore.dayLine?.color);
    expect(Math.abs((paintBefore.markerLine?.x ?? Number.NaN) - (paintBefore.dayLine?.x ?? 0))).toBeLessThanOrEqual(0.5);
    expect(paintBefore.markerLine?.top).toBe("0px");
    expect(paintBefore.markerLine?.bottom).toBe("0px");
    expect(paintBefore.dayLine?.top).toBe("0px");
    expect(paintBefore.dayLine?.bottom).toBe("0px");
    for (const [index, headerBorder] of paintBefore.headerBorders.entries()) {
      const courseBorder = paintBefore.courseBorders[index];
      expect(headerBorder.width).toBe("1px");
      expect(headerBorder.style).toBe("solid");
      expect(courseBorder).toEqual(headerBorder);
    }

    const dateOnlyCard = page.locator(".event-card").filter({ has: page.getByRole("heading", { level: 2, name: "Synthetic date-only class" }) });
    await expect(dateOnlyCard.locator(".event-time")).toHaveText("Time not specified");
    await expect(dateOnlyCard.locator("time")).toHaveAttribute("datetime", DATE_ONLY_CLASS_DATE);
    const dateOnlyDeadline = page.locator(".event-card").filter({ has: page.getByRole("heading", { level: 2, name: "Synthetic date-only deadline" }) });
    await expect(dateOnlyDeadline.locator(".event-time")).toHaveText("11:59 PM");
    await expect(dateOnlyDeadline.locator(".event-time")).toHaveAttribute("title", "No time supplied; 11:59 PM assumed.");
    await expect(dateOnlyDeadline.locator("time")).toHaveAttribute("datetime", DATE_ONLY_DEADLINE);
    const timedCard = page.locator(".event-card").filter({ has: page.getByRole("heading", { level: 2, name: "Synthetic timed class" }) });
    await expect(timedCard.locator(".event-time")).not.toHaveText("Time not specified");
    await expect(timedCard.locator("time")).toHaveAttribute("datetime", TIMED_CLASS_START);

    await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".lane-header");
      if (header !== null) window.scrollTo({ top: window.scrollY + header.getBoundingClientRect().top + 120, behavior: "instant" });
    });
    const afterScroll = await gridDeltas(page);
    const stickyTop = await page.locator(".lane-header").evaluate((header) => header.getBoundingClientRect().top);
    expect(afterScroll).not.toBeNull();
    expect(afterScroll?.every((delta) => delta <= 0.5)).toBe(true);
    expect(Math.abs(stickyTop)).toBeLessThanOrEqual(0.5);
    const paintAfter = await paintedDividerEvidence(page);
    expect(paintAfter.summaryRightWidth).toBe("0px");
    expect(paintAfter.markerRightWidth).toBe("0px");
    expect(paintAfter.markerLine?.width).toBe(1);
    expect(paintAfter.dayLine?.width).toBe(1);
    expect(paintAfter.markerLine?.color).toBe(paintAfter.dayLine?.color);
    expect(Math.abs((paintAfter.markerLine?.x ?? Number.NaN) - (paintAfter.dayLine?.x ?? 0))).toBeLessThanOrEqual(0.5);
    expect(paintAfter.markerLine?.top).toBe("0px");
    expect(paintAfter.markerLine?.bottom).toBe("0px");
    expect(paintAfter.dayLine?.top).toBe("0px");
    expect(paintAfter.dayLine?.bottom).toBe("0px");
    expect(paintAfter.headerBorders).toHaveLength(COURSES.length);
    expect(paintAfter.courseBorders).toHaveLength(COURSES.length);
    for (const [index, headerBorder] of paintAfter.headerBorders.entries()) {
      const courseBorder = paintAfter.courseBorders[index];
      expect(headerBorder.width).toBe("1px");
      expect(headerBorder.style).toBe("solid");
      expect(courseBorder).toEqual(headerBorder);
    }

    if (viewport.width === 1280) await page.screenshot({ path: evidence });

    const topActions = page.locator(".top-actions");
    await expect(topActions.getByRole("button", { name: "Recovery", exact: true })).toHaveCount(0);
    await expect(topActions.getByRole("button", { name: "Export", exact: true })).toHaveCount(0);
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More", exact: true }).click();
    const more = page.locator('[data-page-panel="more"]');
    await expect(more.getByRole("button", { name: "Recovery", exact: true })).toBeVisible();
    await expect(more.getByRole("button", { name: "Export", exact: true })).toBeVisible();
  }
});
