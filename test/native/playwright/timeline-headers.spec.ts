/**
 * Timeline lane headers: real course titles are the primary visible lane labels (a numeric identifier with
 * no supplied name is shown as unknown), the header sticks to the document viewport top
 * while staying aligned with its lanes, and it releases at the timeline end. Runs the Tauri
 * interface with IPC mocked in the page, following desktop-first-run.spec.ts: no Tauri runtime,
 * Worker, or loopback API is involved, and every course and assignment is synthetic.
 */
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COURSES = [
  { key: "2048", title: "Applied Network Defense" },
  { key: "31", title: "Data Ethics in Society" },
  { key: "5001", title: "Statistics for Research, Measurement, and Applied Analytics" },
  { key: "777", title: "" },
  { key: "6002", title: "Secure Cloud Operations and Incident Response" },
] as const;
type SyntheticCourse = (typeof COURSES)[number];
// Matches orderedCourses(): known IT codes first, then normalized course-code order (6002 before 777).
const EXPECTED_LABELS = ["Applied Network Defense", "Data Ethics in Society", "Statistics for Research, Measurement, and Applied Analytics", "Secure Cloud Operations and Incident Response", "Course name unknown"];
const ITEMS: readonly { readonly course: string; readonly day: number }[] = [
  { course: "2048", day: 0 },
  { course: "31", day: 1 },
  { course: "5001", day: 2 },
  { course: "2048", day: 3 },
  { course: "777", day: 3 },
  { course: "31", day: 4 },
  { course: "5001", day: 5 },
  { course: "2048", day: 6 },
  { course: "777", day: 7 },
  { course: "31", day: 8 },
  { course: "5001", day: 9 },
  { course: "2048", day: 9 },
  { course: "6002", day: 10 },
];

const assignmentAt = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

function courseworkDocument(courses: readonly SyntheticCourse[]): string {
  const courseCodes = new Set<string>(courses.map((course) => course.key));
  return JSON.stringify({
    generated: new Date().toISOString(),
    courses: courses.map((course) => ({ key: course.key, code: course.key, ...(course.title === "" ? {} : { title: course.title }), color: "#3a6ea5", folder: course.key })),
    items: ITEMS.filter((item) => courseCodes.has(item.course)).map((item, index) => ({ id: `syn-item-${index}`, course: item.course, kind: "assignment", title: `Synthetic assignment ${String(index + 1)}`, at: assignmentAt(item.day + 0.5), submissionStatus: "unsubmitted", done: false })),
  });
}

/** Runs in the page before the app loads. Must stay self-contained (it is serialized). */
function installTauriMock(coursework: string): void {
  type Callback = (message: unknown) => void;
  const scope = window as unknown as Record<string, unknown>;
  const callbacks = new Map<number, Callback>();
  let nextId = 1;
  scope.isTauri = true;
  scope.__TAURI_INTERNALS__ = {
    transformCallback(callback: Callback): number { const id = nextId; nextId += 1; callbacks.set(id, callback); return id; },
    unregisterCallback(id: number): void { callbacks.delete(id); },
    async invoke(command: string): Promise<unknown> {
      if (command === "store_status") {
        return {
          availability: "ready",
          state: "authoritative",
          dataFolder: "~/Library/Application Support/com.zerodelta.duegood",
          legacyRootSelected: true,
          importedAt: "2026-09-22T12:00:00Z",
          files: 5,
          bytes: 20_480,
          canvasRefreshEnabled: false,
          refreshAvailable: false,
          icalRefreshAvailable: false,
          snapshotInProgress: false,
          problem: null,
        };
      }
      if (command === "read_dashboard_documents") {
        return {
          storeState: "authoritative",
          coursework: { text: coursework, version: "c".repeat(64) },
          refreshHistory: null,
          conversations: null,
          profile: JSON.stringify({ name: "Synthetic Learner" }),
          avatar: null,
          courseExports: {},
        };
      }
      if (command === "read_avatar_bytes") return null;
      throw { code: "internal", message: `unexpected command ${command}` };
    },
  };
}

async function openTimeline(page: Page, courses: readonly SyntheticCourse[] = COURSES): Promise<void> {
  await page.addInitScript(installTauriMock, courseworkDocument(courses));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
  await expect(page.locator(".lane-header .lane-label")).toHaveCount(courses.length);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("keeps header columns aligned in wrapped three and five course lanes", async ({ page }) => {
  for (const width of [1040, 1160]) {
    for (const courses of [COURSES.slice(0, 3), COURSES]) {
      await page.setViewportSize({ width, height: 900 });
      await openTimeline(page, courses);
      await expectNoHorizontalOverflow(page);

      const layout = await page.evaluate(() => {
        const parent = document.querySelector<HTMLElement>(".timeline-layout");
        const timeline = document.querySelector<HTMLElement>(".timeline-shell");
        const rail = document.querySelector<HTMLElement>(".timeline-rail");
        if (parent === null || timeline === null || rail === null) return null;
        const parentRect = parent.getBoundingClientRect();
        const timelineRect = timeline.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        return { parentWidth: parentRect.width, parentRight: parentRect.right, timelineRight: timelineRect.right, railLeft: railRect.left, railRight: railRect.right, railWidth: railRect.width };
      });
      expect(layout).not.toBeNull();
      expect(layout?.railLeft ?? 0).toBeGreaterThanOrEqual((layout?.timelineRight ?? 0) - 0.5);
      expect(layout?.railRight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((layout?.parentRight ?? 0) + 0.5);
      expect(layout?.railWidth ?? 0).toBeGreaterThanOrEqual(220);
      expect(layout?.railWidth ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((layout?.parentWidth ?? 0) * 0.3);

      const deltas = await page.evaluate(() => {
        const headerCells = [...document.querySelectorAll(".lane-header .lane-label")].map((cell) => cell.getBoundingClientRect());
        const firstDay = document.querySelector(".day-slot .course-lanes");
        const lanes = firstDay === null ? [] : [...firstDay.querySelectorAll(".course-lane")].map((lane) => lane.getBoundingClientRect());
        return headerCells.map((cell, index) => {
          const lane = lanes[index];
          return lane === undefined ? null : Math.max(Math.abs(cell.left - lane.left), Math.abs(cell.right - lane.right));
        });
      });
      expect(deltas).toHaveLength(courses.length);
      expect(deltas.every((delta) => delta !== null && delta <= 0.5)).toBe(true);
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
      await expect(page.locator(".rail-due-row .rail-course").first()).toHaveText("2048");
    }
  }
});

for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }] as const) {
  test.describe(`timeline lane headers at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("shows real course titles as the lane labels, with an unknown-name fallback for numeric untitled courses", async ({ page }) => {
      await openTimeline(page);
      const labels = page.locator(".lane-header .lane-label b");
      await expect(labels).toHaveCount(COURSES.length);
      await expect(labels).toHaveText(EXPECTED_LABELS);
      // Titled courses never surface their raw numeric code in the header.
      await expect(page.locator(".lane-header")).not.toContainText("2048");
      await expect(page.locator(".lane-header")).not.toContainText("5001");
      // Course filters retain their Canvas course codes.
      await expect(page.locator(".filters .filter")).toHaveText(["All courses", "2048", "31", "5001", "6002", "777"]);
      await expectNoHorizontalOverflow(page);
    });

    test("sticks the opaque lane header to the document viewport top above the cards", async ({ page }) => {
      await openTimeline(page);
      const styles = await page.evaluate(() => {
        const header = document.querySelector(".lane-header");
        const shell = document.querySelector(".timeline-shell");
        if (header === null || shell === null) return null;
        const headerStyle = getComputedStyle(header);
        return { position: headerStyle.position, top: headerStyle.top, background: headerStyle.backgroundColor, shellOverflow: getComputedStyle(shell).overflow };
      });
      expect(styles).toEqual({ position: "sticky", top: "0px", background: "rgb(17, 27, 36)", shellOverflow: "clip" });
      await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>(".timeline-shell");
        if (shell === null) return;
        window.scrollTo({ top: shell.getBoundingClientRect().top + window.scrollY + shell.offsetHeight * 0.5, behavior: "instant" });
      });
      const pinned = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(".lane-header");
        if (header === null) return null;
        const lane = header.querySelector<HTMLElement>(".lane-label");
        if (lane === null) return null;
        const rect = lane.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, 10);
        return { top: header.getBoundingClientRect().top, aboveCards: hit !== null && hit.closest(".lane-header") === header };
      });
      expect(pinned).not.toBeNull();
      expect(Math.abs(pinned?.top ?? Number.NaN)).toBeLessThanOrEqual(0.5);
      expect(pinned?.aboveCards).toBe(true);
    });

    test("keeps the header lanes aligned and releases the header at the timeline end", async ({ page }) => {
      await openTimeline(page);
      const deltas = await page.evaluate(() => {
        const headerCells = [...document.querySelectorAll(".lane-header .lane-label")].map((cell) => cell.getBoundingClientRect());
        const firstDay = document.querySelector(".day-slot .course-lanes");
        const lanes = firstDay === null ? [] : [...firstDay.querySelectorAll(".course-lane")].map((lane) => lane.getBoundingClientRect());
        return headerCells.map((cell, index) => {
          const lane = lanes[index];
          return lane === undefined ? null : Math.max(Math.abs(cell.left - lane.left), Math.abs(cell.right - lane.right));
        });
      });
      expect(deltas).toHaveLength(COURSES.length);
      expect(deltas.every((delta) => delta !== null && delta <= 1.5)).toBe(true);

      // Lengthen the rail below the timeline, then scroll past the timeline end.
      await page.locator(".rail-more summary").click();
      await page.locator(".timeline-rail").evaluate((rail) => {
        const timeline = document.querySelector<HTMLElement>(".timeline-shell");
        if (timeline !== null) rail.style.minHeight = `${timeline.getBoundingClientRect().height + window.innerHeight}px`;
      });
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
      const releaseLayout = await page.evaluate(() => {
        const scrollRoot = document.scrollingElement;
        const shell = document.querySelector<HTMLElement>(".timeline-shell");
        const header = document.querySelector<HTMLElement>(".lane-header");
        const rect = (element: HTMLElement | null) => {
          if (element === null) return null;
          const bounds = element.getBoundingClientRect();
          return { top: bounds.top, bottom: bounds.bottom, height: bounds.height };
        };
        return {
          scrollRoot: scrollRoot === null ? null : `${scrollRoot.tagName.toLowerCase()}${scrollRoot.id === "" ? "" : `#${scrollRoot.id}`}${scrollRoot.className === "" ? "" : `.${String(scrollRoot.className).replaceAll(" ", ".")}`}`,
          scrollTop: scrollRoot?.scrollTop ?? null,
          maxScrollTop: scrollRoot === null ? null : scrollRoot.scrollHeight - scrollRoot.clientHeight,
          viewportHeight: window.innerHeight,
          shell: rect(shell),
          header: rect(header),
          shellOverflow: shell === null ? null : getComputedStyle(shell).overflow,
        };
      });
      const releasedTop = releaseLayout.header?.top ?? null;
      expect(releasedTop).not.toBeNull();
      expect(releasedTop ?? 0, JSON.stringify(releaseLayout)).toBeLessThan(0);
    });
  });
}
test("renders the self-contained mockup with sticky titled headers at desktop and mobile widths", async ({ page }) => {
  const mockupUrl = pathToFileURL(resolve("docs/mockups/2026-10-01-timeline-headers.html")).href;
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(mockupUrl);
    await expect(page.locator(".lane-label b")).toHaveText([
      "Applied Network Defense",
      "Data Ethics in Society",
      "Statistics for Research and Applied Measurement",
    ]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".timeline-shell");
      if (shell !== null) window.scrollTo({ top: shell.getBoundingClientRect().top + window.scrollY + shell.offsetHeight * 0.5, behavior: "instant" });
    });
    const geometry = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".lane-header");
      const shell = document.querySelector<HTMLElement>(".timeline-shell");
      return { top: header?.getBoundingClientRect().top, scrollY: window.scrollY, shellHeight: shell?.offsetHeight, position: header === null ? null : getComputedStyle(header).position };
    });
    expect(Math.abs(geometry.top ?? Number.NaN), JSON.stringify(geometry)).toBeLessThanOrEqual(0.5);
  }
});
