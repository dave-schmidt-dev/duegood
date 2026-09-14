/**
 * coursework.js — Fall 2026 coursework timeline.
 *
 * Renders one shared vertical time axis with three course lanes (IT 530 / 540 /
 * 570) so a semester can be worked through in chronological order, checking
 * items off as they are completed. University milestones span all three lanes.
 *
 * The data model is `coursework.json`:
 *   { schema, generated, source, timezone, term, sync, courses: [...], items: [...] }
 * where each item is:
 *   { id:str, course:str, kind:str, title:str, at:"YYYY-MM-DDTHH:MM"|null,
 *     points:num|null, source:str, confidence:str, flags:[str], detail:str,
 *     url:str|null, canvasId:num|null, submissionStatus:str|null,
 *     grade:str|null, score:num|null, done:bool, doneAt:str|null }
 *
 * TIME HANDLING — the one rule this file must not break:
 * `at` is LOCAL wall-clock time in America/New_York with no zone suffix, and is
 * never fed to `new Date()`. Daylight Saving Time ends Sun Nov 1, 2026, in the
 * middle of the term; Canvas already reflects the shift (03:59:59Z before,
 * 04:59:59Z after, both meaning 11:59 PM ET). Sorting the strings
 * lexicographically and formatting them by slicing keeps display and order
 * correct across the transition with zero offset arithmetic. The ONLY place a
 * real clock is consulted is `todayISO()`, which asks Intl for the current date
 * in the course timezone.
 */

/** IANA zone every date in this dataset is expressed in. */
export const TZ = "America/New_York";

/** Item kinds that are context, not deliverables — excluded from progress. */
const NON_GRADABLE = new Set(["session", "milestone"]);

/**
 * Whether an item belongs on the live tracker. Canvas assignment IDs are the
 * authority for gradable work; sessions and milestones are calendar context.
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isLiveTrackerItem(item) {
  return Boolean(item) && (NON_GRADABLE.has(item.kind)
    || (item.source === "canvas" && item.canvasId !== null
      && item.canvasId !== undefined));
}

/**
 * Visible grade text for submitted work. Unsubmitted work gets no badge.
 *
 * @param {object} item
 * @returns {string|null}
 */
export function gradeLabel(item) {
  if (item?.submissionStatus === "pending") return "Grade: Pending";
  if (item?.submissionStatus !== "graded") return null;
  if (typeof item.score === "number" && typeof item.points === "number" && item.points > 0) {
    const percentage = Math.round((item.score / item.points) * 10000) / 100;
    return `Grade: ${item.score}/${item.points} ${percentage}%`;
  }
  if (item.grade !== null && item.grade !== undefined && String(item.grade).trim()) {
    return `Grade: ${item.grade}`;
  }
  if (typeof item.score === "number") {
    return `Grade: ${item.score}`;
  }
  return "Grade: Pending";
}

/** Short weekday names indexed the way `dayOfWeek` returns. */
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ============================================================================
 * Pure helpers (no DOM) — exported for unit tests.
 * ========================================================================== */

/**
 * Split a wall-clock `at` value into its parts without constructing a Date.
 *
 * @param {string|null|undefined} at - "YYYY-MM-DDTHH:MM" local wall clock.
 * @returns {{date:string, time:string, y:number, m:number, d:number,
 *            hh:number, mm:number}|null} Parts, or null if unparseable.
 */
export function parseAt(at) {
  if (typeof at !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at);
  if (!match) return null;
  const [, y, m, d, hh, mm] = match;
  return {
    date: `${y}-${m}-${d}`,
    time: `${hh}:${mm}`,
    y: Number(y), m: Number(m), d: Number(d),
    hh: Number(hh), mm: Number(mm),
  };
}

/**
 * Days in a given month, Gregorian leap rules.
 *
 * @param {number} year - Full year.
 * @param {number} month - 1..12.
 * @returns {number} 28..31.
 */
function daysInMonth(year, month) {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * Day of week for a "YYYY-MM-DD" date, 0=Sunday, using Zeller-style civil
 * arithmetic. Deliberately avoids Date so no timezone can shift the answer.
 *
 * @param {string} date - "YYYY-MM-DD".
 * @returns {number} 0..6, or -1 when the input is not a valid date string.
 */
export function dayOfWeek(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return -1;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  // Shape is not validity. These dates are hand-transcribed from PDFs, so
  // "2026-02-31" is a realistic typo — and without this check the civil
  // arithmetic happily returns a plausible weekday for it, which is far harder
  // to spot than the documented -1 rendering as visible garbage.
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return -1;
  // Days-from-civil (Howard Hinnant's algorithm), then shift to a weekday.
  const yAdj = m <= 2 ? y - 1 : y;
  const era = Math.floor(yAdj / 400);
  const yoe = yAdj - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468; // days since 1970-01-01 (a Thursday)
  return ((days % 7) + 11) % 7; // 1970-01-01 -> 4 (Thu)
}

/**
 * Add a whole number of days to a "YYYY-MM-DD" date string.
 *
 * @param {string} date - "YYYY-MM-DD".
 * @param {number} delta - Days to add (may be negative).
 * @returns {string} The shifted "YYYY-MM-DD".
 */
export function addDays(date, delta) {
  // UTC-only Date math: the value never touches a local timezone, so this is
  // immune to the DST concerns that apply to displayed times.
  const base = Date.UTC(Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  const out = new Date(base + delta * 86400000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`;
}

/**
 * The Monday on or before a date — the key that groups days into term weeks.
 *
 * @param {string} date - "YYYY-MM-DD".
 * @returns {string} That week's Monday as "YYYY-MM-DD".
 */
export function weekStart(date) {
  const dow = dayOfWeek(date);
  const backToMonday = dow === 0 ? 6 : dow - 1; // Sunday closes the week
  return addDays(date, -backToMonday);
}

/**
 * Whole days from `a` to `b` (negative when `b` is earlier).
 *
 * @param {string} a - "YYYY-MM-DD".
 * @param {string} b - "YYYY-MM-DD".
 * @returns {number} Signed day difference.
 */
export function daysBetween(a, b) {
  const toUTC = (s) => Date.UTC(Number(s.slice(0, 4)),
    Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

/**
 * Which week of the term a date falls in, counting from 1.
 *
 * @param {string} date - "YYYY-MM-DD".
 * @param {string} termStart - "YYYY-MM-DD" first day of classes.
 * @returns {number} 1-based term week number.
 */
export function weekNumber(date, termStart) {
  return Math.floor(daysBetween(weekStart(termStart), weekStart(date)) / 7) + 1;
}

/**
 * Format a wall-clock time for display, e.g. "11:59 PM".
 *
 * @param {string} at - "YYYY-MM-DDTHH:MM".
 * @returns {string} Twelve-hour time, or "" when unparseable.
 */
export function formatTime(at) {
  const parts = parseAt(at);
  if (!parts) return "";
  const suffix = parts.hh >= 12 ? "PM" : "AM";
  const hour = parts.hh % 12 === 0 ? 12 : parts.hh % 12;
  return `${hour}:${String(parts.mm).padStart(2, "0")} ${suffix}`;
}

/**
 * Format a date for the timeline gutter, e.g. "Aug 30".
 *
 * @param {string} date - "YYYY-MM-DD".
 * @returns {string} Month abbreviation plus day of month.
 */
export function formatDate(date) {
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${MONTHS[m - 1]} ${d}`;
}

/**
 * Today's date in the course timezone, as "YYYY-MM-DD".
 *
 * The `en-CA` locale renders dates in ISO order, which makes this directly
 * comparable to the stored `at` prefixes.
 *
 * @param {Date} [now] - Injectable clock for tests.
 * @returns {string} "YYYY-MM-DD" in America/New_York.
 */
export function todayISO(now = new Date()) {
  // Derived from nowISO rather than slicing an en-CA formatted string: locale
  // output shape is not contractual, and every date comparison in this file is
  // lexical, so a formatting variation would break sorting silently rather than
  // loudly. nowISO already builds from formatToParts for exactly that reason.
  return nowISO(now).slice(0, 10);
}

/**
 * The current wall-clock moment in the course timezone, in exactly the shape
 * `at` uses so the two are directly comparable with `<` and `>`.
 *
 * Built from `formatToParts` rather than by slicing a formatted string: locale
 * output shape is not contractual, and `hour12: false` yields "24" for midnight
 * in some engines, which would sort after every real timestamp instead of
 * before them. `hourCycle: "h23"` is the part that pins midnight to "00".
 *
 * @param {Date} [now] - Injectable clock for tests.
 * @returns {string} "YYYY-MM-DDTHH:MM" in America/New_York.
 */
export function nowISO(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`
    + `T${get("hour")}:${get("minute")}`;
}

/**
 * Where the "now" marker belongs in a rendered calendar-day sequence: today's
 * row when it is in range, otherwise the top or bottom boundary. The timeline
 * renders every term day, including days without work, so the marker no longer
 * has to jump forward to the next assignment date.
 *
 * @param {{date:string, items:object[]}[]} days - Groups from `groupByDay`.
 * @param {string} now - "YYYY-MM-DDTHH:MM" from `nowISO`.
 * @returns {number} Insert index; `days.length` when everything is past.
 */
export function nowLineIndex(days, now) {
  if (!Array.isArray(days) || typeof now !== "string") return 0;
  const today = now.slice(0, 10);
  for (let i = 0; i < days.length; i += 1) {
    if (days[i].date >= today) return i;
  }
  return days.length;
}

/**
 * A human relative-day label: "today", "tomorrow", "in 3 days", "5 days ago".
 *
 * @param {string} date - "YYYY-MM-DD".
 * @param {string} today - "YYYY-MM-DD".
 * @returns {string} The label, or "" when more than 14 days out.
 */
export function relativeDay(date, today) {
  const delta = daysBetween(today, date);
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta === -1) return "yesterday";
  if (delta > 1 && delta <= 14) return `in ${delta} days`;
  if (delta < -1 && delta >= -14) return `${-delta} days ago`;
  return "";
}

/**
 * Order items within a single day: unfinished before finished, then earlier
 * time first, then course lane order, then id so the sort is total and stable
 * across reloads.
 *
 * @param {object} a
 * @param {object} b
 * @param {string[]} courseOrder - Course keys in lane order.
 * @returns {number}
 */
export function compareItems(a, b, courseOrder = []) {
  // Finished work sinks to the bottom of its lane regardless of time. A day's
  // column is a to-do list, and a 9:30 PM item already checked off should not
  // sit above an 11:59 PM one still owed.
  const doneA = a.done === true;
  const doneB = b.done === true;
  if (doneA !== doneB) return doneA ? 1 : -1;
  const timeA = parseAt(a.at)?.time ?? "";
  const timeB = parseAt(b.at)?.time ?? "";
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  const laneA = courseOrder.indexOf(a.course);
  const laneB = courseOrder.indexOf(b.course);
  if (laneA !== laneB) return laneA - laneB;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Group dated items into ascending calendar days.
 *
 * @param {object[]} items - Items, dated or not.
 * @param {string[]} [courseOrder] - Course keys in lane order.
 * @returns {{date:string, items:object[]}[]} Days with at least one item,
 *   in chronological order. Undated items are omitted.
 */
export function groupByDay(items, courseOrder = []) {
  const byDate = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const parts = parseAt(item.at);
    if (!parts) continue;
    if (!byDate.has(parts.date)) byDate.set(parts.date, []);
    byDate.get(parts.date).push(item);
  }
  return [...byDate.keys()].sort().map((date) => ({
    date,
    items: byDate.get(date).sort((a, b) => compareItems(a, b, courseOrder)),
  }));
}

/**
 * Fill a dated group sequence so every calendar day in the requested range has
 * a row. Existing item arrays are retained; gap days receive an empty array.
 *
 * @param {{date:string, items:object[]}[]} groups - Sparse dated groups.
 * @param {string} start - Inclusive first date as "YYYY-MM-DD".
 * @param {string} end - Inclusive last date as "YYYY-MM-DD".
 * @returns {{date:string, items:object[]}[]} Complete daily sequence.
 */
export function fillCalendarDays(groups, start, end) {
  if (dayOfWeek(start) < 0 || dayOfWeek(end) < 0 || start > end) return [];
  const byDate = new Map((Array.isArray(groups) ? groups : [])
    .map((group) => [group.date, group.items]));
  const days = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    days.push({ date, items: byDate.get(date) ?? [] });
  }
  return days;
}

/**
 * Count completed vs total gradable items for one course.
 * Sessions and milestones are context, not work, so they never count.
 *
 * @param {object[]} items
 * @param {string} courseKey
 * @returns {{done:number, total:number}}
 */
export function progressFor(items, courseKey) {
  let done = 0;
  let total = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (item.course !== courseKey || NON_GRADABLE.has(item.kind)
      || !isLiveTrackerItem(item)) continue;
    total += 1;
    if (item.done) done += 1;
  }
  return { done, total };
}

/**
 * Whether an item is past due and still unchecked.
 *
 * @param {object} item
 * @param {string} today - "YYYY-MM-DD".
 * @returns {boolean}
 */
export function isOverdue(item, today) {
  if (!item || item.done || NON_GRADABLE.has(item.kind)
    || !isLiveTrackerItem(item)) return false;
  const parts = parseAt(item.at);
  return Boolean(parts) && parts.date < today;
}

/**
 * Apply the toolbar filters to the item list.
 *
 * @param {object[]} items
 * @param {{courses:Set<string>, showSessions:boolean, showMilestones:boolean,
 *          hideDone:boolean}} filters
 * @returns {object[]} The visible subset.
 */
export function filterItems(items, filters) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((item) => {
    if (!isLiveTrackerItem(item)) return false;
    if (item.kind === "milestone") return filters.showMilestones !== false;
    if (!filters.courses.has(item.course)) return false;
    if (item.kind === "session" && filters.showSessions === false) return false;
    if (filters.hideDone && item.done) return false;
    return true;
  });
}

/**
 * Validate a loaded coursework document, returning a normalized copy.
 *
 * @param {object} doc - Parsed coursework.json.
 * @returns {{schema:number, courses:object[], items:object[]}} Normalized doc.
 */
export function validateData(doc) {
  const safe = doc && typeof doc === "object" ? doc : {};
  const courses = Array.isArray(safe.courses) ? safe.courses : [];
  const items = (Array.isArray(safe.items) ? safe.items : []).map((item) => ({
    ...item,
    flags: Array.isArray(item.flags) ? item.flags : [],
    done: item.done === true,
    doneAt: typeof item.doneAt === "string" ? item.doneAt : null,
  }));
  return { ...safe, schema: safe.schema ?? 1, courses, items };
}

/* ============================================================================
 * UI + storage wiring.
 * ========================================================================== */

const STORAGE_KEY = "marymount.coursework.filters";
const SAVE_DEBOUNCE_MS = 600;

const state = {
  doc: null,
  // Last server-confirmed document. Optimistic UI changes are always restored
  // from this snapshot if the write fails, so an offline page cannot display a
  // completion state that never reached disk.
  persistedDoc: null,
  mtime: null,
  chromeObserver: null,
  nowTimer: null,
  nowIndex: null,
  // The date render() assumed. render() snapshots todayISO() once, and every
  // date-derived class (--today/--past/--future, .day-rel, --overdue, and which
  // form the now marker takes) hangs off that snapshot. Without remembering it,
  // nothing notices midnight.
  todayRendered: null,
  saveTimer: null,
  // True while a POST is in flight, so a second save re-queues instead of
  // racing the first with a stale mtime.
  saving: false,
  connectionCheck: false,
  persistenceAvailable: false,
  // Survives a re-render. render() rebuilds the toolbar from scratch, so a
  // hardcoded pill there would overwrite an in-flight "Saving…".
  saveStatus: { text: "Saved", variant: "saved" },
  refreshStatus: { text: "Ready", variant: "idle", running: false, detail: "" },
  refreshTimer: null,
  refreshHistory: { events: [] },
  refreshHistoryOpen: false,
  expanded: new Set(),
  filters: {
    courses: new Set(["it530", "it540", "it570"]),
    showSessions: true,
    showMilestones: true,
    hideDone: false,
  },
  el: {},
};

/** Course keys in lane order; univ is rendered as full-width banners. */
function laneOrder() {
  return (state.doc?.courses ?? [])
    .filter((c) => c.key !== "univ")
    .map((c) => c.key);
}

/** Look up a course record by key. */
function courseByKey(key) {
  return (state.doc?.courses ?? []).find((c) => c.key === key) ?? null;
}

/** Create an element with optional class, text and attributes. */
function el(tag, className, text, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Update the save-status pill. */
function setStatus(text, variant = "saved") {
  state.saveStatus = { text, variant };
  const pill = state.el.status;
  if (!pill) return;
  pill.textContent = text;
  pill.className = `save-status save-status--${variant}`;
  // data-state is the stable hook the E2E specs wait on; the visible text is
  // free to change without breaking them.
  pill.dataset.state = variant;
}

/** Return true only when the loopback persistence server answers correctly. */
async function serverAvailable() {
  try {
    const response = await fetch("/healthz", { cache: "no-store" });
    return response.ok && (await response.text()).trim() === "marymount-todo-ok";
  } catch {
    return false;
  }
}

/** Restore the last server-confirmed document and lock mutating controls. */
function enterOfflineState(message = "Offline — not saved") {
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  if (state.persistedDoc) state.doc = structuredClone(state.persistedDoc);
  state.persistenceAvailable = false;
  state.connectionCheck = false;
  setStatus(message, "error");
  render();
}

/** Retry the loopback server, then reload its authoritative document. */
async function reconnect() {
  setStatus("Reconnecting…", "saving");
  if (!(await serverAvailable())) {
    enterOfflineState("Still offline — start coursework.sh");
    return;
  }
  await load({ jump: false });
}

/** Update the persistent Canvas-refresh controls without rebuilding the page. */
function setRefreshStatus(text, variant, running, detail = "") {
  state.refreshStatus = { text, variant, running, detail };
  if (state.el.refreshButton) state.el.refreshButton.disabled = running;
  if (state.el.refreshStatus) {
    state.el.refreshStatus.textContent = text;
    state.el.refreshStatus.className = `refresh-status refresh-status--${variant}`;
    state.el.refreshStatus.dataset.state = variant;
    state.el.refreshStatus.title = detail;
  }
}

/** Return the most recent unreviewed, complete Canvas comparison. */
function latestUnreadRefresh() {
  return state.refreshHistory.events.find((event) => (
    event?.status === "succeeded" && event.acknowledgedAt == null
  )) ?? null;
}

/** Render a concise, grammatically correct refresh result. */
function refreshResultText(event) {
  if (!event || event.status !== "succeeded" || !event.summary) {
    return "Canvas refreshed — comparison unavailable";
  }
  const total = event.summary.total ?? 0;
  if (total === 0) return "Canvas refreshed — No Canvas changes";
  return `Canvas refreshed — ${total} change${total === 1 ? "" : "s"}`;
}

/** Load durable, Canvas-only refresh events without blocking timeline data. */
async function loadRefreshHistory() {
  try {
    const response = await fetch("/refresh-history", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const history = await response.json();
    state.refreshHistory = {
      events: Array.isArray(history?.events) ? history.events : [],
    };
  } catch {
    state.refreshHistory = { events: [] };
  }
}

/** Persist acknowledgement without deleting a refresh audit record. */
async function acknowledgeRefresh(event) {
  try {
    const response = await fetch("/refresh-history/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: event.id }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    state.refreshHistory = {
      events: Array.isArray(result?.history?.events) ? result.history.events : [],
    };
    render();
  } catch {
    setRefreshStatus("Could not mark refresh reviewed", "error", false);
  }
}

/** Poll the server until the current background refresh reaches a terminal state. */
async function pollCanvasRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  try {
    const response = await fetch("/canvas-refresh/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    const detail = Array.isArray(status.lines) ? status.lines.join("\n") : "";
    if (status.state === "running") {
      setRefreshStatus(status.message || "Refreshing Canvas…", "running", true, detail);
      state.refreshTimer = setTimeout(pollCanvasRefresh, 750);
      return;
    }
    if (status.state === "succeeded") {
      await load({ jump: false });
      setRefreshStatus(refreshResultText(status.latestEvent), "succeeded", false, detail);
      return;
    }
    if (status.state === "incomplete") {
      await load({ jump: false });
      setRefreshStatus("Canvas refreshed — comparison unavailable", "error", false, detail);
      return;
    }
    if (status.state === "failed" || status.state === "timed_out") {
      const text = status.state === "timed_out" ? "Refresh timed out" : "Refresh failed";
      setRefreshStatus(text, "error", false, detail);
      return;
    }
    setRefreshStatus("Ready", "idle", false, detail);
  } catch {
    setRefreshStatus("Refresh status unavailable", "error", false);
  }
}

/** Start the fixed, BWS-backed Canvas refresh job. */
async function startCanvasRefresh() {
  setRefreshStatus("Starting Canvas refresh…", "running", true);
  try {
    const response = await fetch("/canvas-refresh", { method: "POST" });
    if (response.status !== 202 && response.status !== 409) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pollCanvasRefresh();
  } catch {
    setRefreshStatus("Could not start refresh", "error", false);
  }
}

/** Persist filter choices locally; they are UI preference, not course data. */
function saveFilters() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      courses: [...state.filters.courses],
      showSessions: state.filters.showSessions,
      showMilestones: state.filters.showMilestones,
      hideDone: state.filters.hideDone,
    }));
  } catch { /* private browsing / quota — filters just won't persist */ }
}

/** Restore filter choices saved by a previous visit. */
function loadFilters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.courses)) state.filters.courses = new Set(saved.courses);
    if (typeof saved.showSessions === "boolean") state.filters.showSessions = saved.showSessions;
    if (typeof saved.showMilestones === "boolean") state.filters.showMilestones = saved.showMilestones;
    if (typeof saved.hideDone === "boolean") state.filters.hideDone = saved.hideDone;
  } catch { /* ignore malformed state */ }
}

/**
 * POST the document back to the server, debounced.
 * The mtime header is the optimistic-concurrency guard: a 409 means the file
 * changed on disk (e.g. the sync script ran) and the page must reload.
 */
function scheduleSave() {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  setStatus("Saving…", "saving");
  state.saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

async function save() {
  state.saveTimer = null;
  // One POST at a time. The mtime header guards against the FILE changing, and
  // it cannot tell "sync_coursework.py ran" from "my own previous POST landed
  // but its fresh mtime hasn't come back yet." A second save overlapping the
  // first would send the stale mtime, take a 409, and reload away a checkbox
  // the user really did tick. Re-queue instead and let the debounce retry.
  if (state.saving) { scheduleSave(); return; }
  state.saving = true;
  try {
    const headers = { "Content-Type": "application/json" };
    if (state.mtime !== null) headers["X-Coursework-Mtime"] = state.mtime;
    const res = await fetch("/coursework", {
      method: "POST",
      headers,
      body: JSON.stringify(state.doc),
    });
    if (res.status === 409) {
      // The file changed underneath us — in practice that means
      // `sync_coursework.py --apply` ran while this page was open, which is a
      // routine workflow here, not an edge case. Re-read from disk so the page
      // stops displaying a checkbox that was never persisted, and say plainly
      // that the change was dropped instead of leaving a lie on screen.
      // Cancel any save queued while this one was in flight: it would mutate
      // the document that load() is about to replace, then report "Saved".
      if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
      await load({ jump: false });
      // Plural on purpose — the debounce means one POST can carry several checks.
      setStatus("Reloaded — unsaved changes dropped", "error");
      return;
    }
    if (!res.ok) {
      enterOfflineState("Save failed — changes rolled back");
      return;
    }
    state.mtime = res.headers.get("X-Coursework-Mtime") ?? state.mtime;
    state.persistedDoc = structuredClone(state.doc);
    state.persistenceAvailable = true;
    setStatus("Saved");
  } catch {
    enterOfflineState("Offline — changes rolled back");
  } finally {
    state.saving = false;
  }
}

/** Verify persistence first, then toggle one item's done flag and save it. */
async function toggleDone(item, checked) {
  if (!state.persistenceAvailable || state.connectionCheck) {
    enterOfflineState("Offline — reconnect before changing items");
    return;
  }
  state.connectionCheck = true;
  setStatus("Checking connection…", "saving");
  render();
  if (!(await serverAvailable())) {
    enterOfflineState();
    return;
  }
  state.connectionCheck = false;
  item.done = checked;
  item.doneAt = checked ? todayISO() : null;
  scheduleSave();
  render();
}

/* ---- Rendering ------------------------------------------------------------ */

/** Build the sticky toolbar. */
function buildToolbar(root) {
  const bar = el("div", "toolbar");

  const courseWrap = el("div", "control");
  courseWrap.append(el("span", "control-label", "Courses"));
  for (const key of laneOrder()) {
    const course = courseByKey(key);
    const btn = el("button", "btn", course?.code ?? key,
      { type: "button", "data-focus-key": `filter-course-${key}` });
    btn.style.setProperty("--accent", course?.color ?? "");
    const sync = () => {
      const on = state.filters.courses.has(key);
      btn.classList.toggle("btn--on", on);
      btn.style.borderColor = on ? (course?.color ?? "") : "";
    };
    btn.addEventListener("click", () => {
      if (state.filters.courses.has(key)) state.filters.courses.delete(key);
      else state.filters.courses.add(key);
      sync();
      saveFilters();
      render();
    });
    sync();
    courseWrap.append(btn);
  }
  bar.append(courseWrap);

  const toggles = el("div", "control");
  toggles.append(el("span", "control-label", "Show"));
  const defs = [
    ["showSessions", "Class sessions"],
    ["showMilestones", "MU calendar"],
  ];
  for (const [flag, label] of defs) {
    const btn = el("button", "btn", label,
      { type: "button", "data-focus-key": `filter-${flag}` });
    const sync = () => btn.classList.toggle("btn--on", state.filters[flag]);
    btn.addEventListener("click", () => {
      state.filters[flag] = !state.filters[flag];
      sync();
      saveFilters();
      render();
    });
    sync();
    toggles.append(btn);
  }
  const hideDone = el("button", "btn", "Hide completed",
    { type: "button", "data-focus-key": "filter-hideDone" });
  const syncHide = () => hideDone.classList.toggle("btn--on", state.filters.hideDone);
  hideDone.addEventListener("click", () => {
    state.filters.hideDone = !state.filters.hideDone;
    syncHide();
    saveFilters();
    render();
  });
  syncHide();
  toggles.append(hideDone);
  bar.append(toggles);

  const jump = el("button", "btn", "Jump to today",
    { type: "button", id: "jump-today", "data-focus-key": "jump-today" });
  jump.addEventListener("click", jumpToToday);
  bar.append(jump);

  const refreshWrap = el("div", "refresh-control");
  const refresh = el("button", "btn btn--refresh", "Refresh Canvas", {
    type: "button",
    "data-testid": "cw-refresh",
    "data-focus-key": "refresh-canvas",
  });
  refresh.disabled = state.refreshStatus.running;
  refresh.addEventListener("click", startCanvasRefresh);
  state.el.refreshButton = refresh;
  const refreshStatus = el(
    "span",
    `refresh-status refresh-status--${state.refreshStatus.variant}`,
    state.refreshStatus.text,
    {
      role: "status",
      "aria-live": "polite",
      "data-testid": "cw-refresh-status",
      "data-state": state.refreshStatus.variant,
      title: state.refreshStatus.detail,
    },
  );
  state.el.refreshStatus = refreshStatus;
  refreshWrap.append(refresh, refreshStatus);
  bar.append(refreshWrap);

  const unread = latestUnreadRefresh();
  const historyButton = el(
    "button",
    "btn btn--refresh-history",
    unread?.summary?.total
      ? `Review ${unread.summary.total} change${unread.summary.total === 1 ? "" : "s"}`
      : "Refresh history",
    {
      type: "button",
      "data-testid": "cw-refresh-changes",
      "aria-expanded": String(state.refreshHistoryOpen),
    },
  );
  historyButton.addEventListener("click", () => {
    state.refreshHistoryOpen = !state.refreshHistoryOpen;
    render();
  });
  bar.append(historyButton);

  // From state, never a literal. toggleDone() calls scheduleSave() (which sets
  // "Saving…") and then render() synchronously; a hardcoded "Saved" here claims
  // the write landed while the debounced POST has not even been issued, and a
  // tab closed inside that window loses the edit with nothing on screen having
  // suggested waiting.
  const { text: statusText, variant: statusVariant } = state.saveStatus;
  state.el.status = el("span", `save-status save-status--${statusVariant}`, statusText,
    { "data-testid": "cw-save-status", "data-state": statusVariant });
  bar.append(state.el.status);
  if (!state.persistenceAvailable) {
    const reconnectButton = el("button", "btn btn--reconnect", "Reconnect", {
      type: "button",
      "data-testid": "cw-reconnect",
      "data-focus-key": "reconnect",
    });
    reconnectButton.addEventListener("click", reconnect);
    bar.append(reconnectButton);
  }

  root.append(bar);
}

/** Use human-readable field labels in the refresh history. */
function refreshFieldLabel(field) {
  return ({ at: "Due date", points: "Points", title: "Title", submissionStatus: "Submission",
    submittedAt: "Submitted", gradedAt: "Graded", grade: "Grade", score: "Score",
    code: "Course code", instructor: "Instructor", meets: "Meeting", canvas: "Canvas link",
    canvasCourseId: "Canvas course" })[field] ?? field;
}

function refreshValue(value) {
  if (value == null || value === "") return "not set";
  return String(value);
}

function changesForItem(itemId) {
  return latestUnreadRefresh()?.changes?.filter((change) => change.itemId === itemId) ?? [];
}

/** Show a durable review panel only when the owner asks to see it. */
function renderRefreshHistory(root) {
  if (!state.refreshHistoryOpen) return;
  const panel = el("section", "refresh-history", null, {
    "aria-label": "Canvas refresh history",
    "data-testid": "cw-refresh-history",
  });
  panel.append(el("h2", null, "Canvas refresh history"));
  const events = state.refreshHistory.events;
  if (!events.length) {
    panel.append(el("p", "refresh-history-empty", "No recorded Canvas refresh yet."));
    root.append(panel);
    return;
  }
  for (const event of events) {
    const entry = el("article", "refresh-event");
    const heading = event.status === "succeeded"
      ? refreshResultText(event).replace("Canvas refreshed — ", "")
      : event.status === "incomplete" ? "Comparison unavailable" : "Refresh failed";
    entry.append(el("h3", null, heading));
    entry.append(el("p", "refresh-event-meta", event.finishedAt ?? "Time unavailable"));
    if (event.status === "succeeded" && event.summary?.total === 0) {
      entry.append(el("p", null, "No Canvas changes."));
    }
    for (const change of event.changes ?? []) {
      const detail = el("div", "refresh-change");
      const prefix = change.kind === "added" ? "Added" : change.kind === "removed" ? "Removed" : "Updated";
      detail.append(el("strong", null, `${prefix}: ${change.title ?? change.course}`));
      for (const field of change.fields ?? []) {
        detail.append(el("div", null,
          `${refreshFieldLabel(field.field)}: ${refreshValue(field.before)} → ${refreshValue(field.after)}`));
      }
      entry.append(detail);
    }
    if (event.status === "succeeded" && event.acknowledgedAt == null) {
      const acknowledge = el("button", "btn btn--refresh-reviewed", "Mark reviewed", { type: "button" });
      acknowledge.addEventListener("click", () => acknowledgeRefresh(event));
      entry.append(acknowledge);
    }
    panel.append(entry);
  }
  root.append(panel);
}

/**
 * Condense the sticky course strip once the page header has scrolled away.
 *
 * At full size the strip costs roughly a third of a laptop viewport, which is
 * a bad trade on a page whose whole job is scrolling through days. Collapsed,
 * it keeps the course colour, name, progress bar and both links — everything
 * needed to stay oriented — and drops the detail you only read once.
 *
 * The observed element sits ABOVE the strip, so collapsing it can never move
 * the sentinel and re-trigger the observer.
 */
function observeChrome() {
  const root = state.el.root;
  if (!root || typeof IntersectionObserver === "undefined") return;
  const sentinel = root.querySelector(".page-head");
  const strip = root.querySelector(".lanes-head");
  if (!sentinel || !strip) return;
  state.chromeObserver?.disconnect();
  state.chromeObserver = new IntersectionObserver(([entry]) => {
    strip.classList.toggle("lanes-head--compact", !entry.isIntersecting);
    measureChrome();
  });
  state.chromeObserver.observe(sentinel);
}

/**
 * Publish the rendered height of the sticky chrome as CSS custom properties.
 *
 * The toolbar and course strip both grow with --scale and with whatever
 * minimum font size the browser enforces, so the scroll offset that keeps a
 * day row out from under them cannot be a hard-coded pixel value. Measuring
 * after each render is cheap and always right.
 */
function measureChrome() {
  const root = state.el.root;
  if (!root) return;
  const bar = root.querySelector(".toolbar");
  const head = root.querySelector(".lanes-head");
  const barH = bar ? Math.ceil(bar.getBoundingClientRect().height) : 0;
  const headH = head ? Math.ceil(head.getBoundingClientRect().height) : 0;
  const style = document.documentElement.style;
  style.setProperty("--toolbar-h", `${barH}px`);
  style.setProperty("--chrome-h", `${barH + headH}px`);
}

/** Scroll to the first day at or after today, clear of the sticky chrome. */
function jumpToToday() {
  // The now marker is the better target than any day row: it is exactly the
  // boundary between done-with and not-yet, and it exists on every day of the
  // term, including the many days that have no row of their own.
  const target = document.querySelector(".now-line, .day-row--now")
    ?? document.querySelector(".day-row--today, .day-row--future");
  // `start` honours scroll-margin-top, so the target lands just below the
  // header with the rest of the term below it; `center` would ignore that
  // budget and put it mid-screen with the past above.
  if (!target) return;
  target.scrollIntoView({ block: "start" });

  // Scrolling collapses the sticky course strip, changing its height after the
  // browser has already resolved scroll-margin-top. Recheck after that reflow
  // and pull the target back below the actual compact header if needed.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    measureChrome();
    const head = state.el.root?.querySelector(".lanes-head");
    if (!head || !target.isConnected) return;
    const gap = target.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
    if (gap < 10) window.scrollBy({ top: gap - 10, behavior: "auto" });
  }));
}

/**
 * Keep the now marker honest without re-rendering the page every tick.
 *
 * Three outcomes, cheapest first: the displayed minute is unchanged, so do
 * nothing; only the label moved, so write the text; or the marker's position in
 * the day sequence changed, which needs a real re-render. The third happens a
 * handful of times a term, and `render()` already preserves scroll position and
 * expanded items, so paying for it there is fine.
 */
function startNowTicker() {
  if (state.nowTimer) clearInterval(state.nowTimer);
  state.nowTimer = setInterval(() => {
    const root = state.el.root;
    if (!root || !state.doc) return;
    const line = root.querySelector(".now-line, .day-row--now");
    if (!line) return;
    const now = nowISO();
    const grouped = groupByDay(filterItems(state.doc.items, state.filters), laneOrder());
    const start = state.doc.term?.start ?? grouped[0]?.date;
    const end = state.doc.term?.finalsEnd ?? grouped[grouped.length - 1]?.date;
    const days = fillCalendarDays(grouped, start, end);
    // Two reasons to pay for a real re-render: the marker moved, or the date
    // changed underneath a page left open overnight. The second is easy to miss
    // — crossing midnight usually does NOT move the marker, because the next
    // undue item is typically more than a day out. Left alone, every
    // date-derived class stays on yesterday until the next reload.
    if (nowLineIndex(days, now) !== state.nowIndex || todayISO() !== state.todayRendered) {
      render();
      return;
    }
    const time = line.querySelector(".now-time, .day-now-time");
    if (time && time.textContent !== formatTime(now)) time.textContent = formatTime(now);
    const date = line.querySelector(".now-date");
    if (date && date.textContent !== formatDate(now.slice(0, 10))) {
      date.textContent = formatDate(now.slice(0, 10));
    }
    // The visible text is only half of it: without this the screen reader keeps
    // announcing whatever time the last full render happened to capture.
    const labelled = line.classList.contains("now-line")
      ? line
      : line.querySelector(".day-now");
    if (labelled) labelled.setAttribute("aria-label", nowLabel(now));
  }, 20000);
}

/** Ask the server to reveal a class folder in the Finder. */
async function revealFolder(key, btn) {
  const original = btn.textContent;
  // The server shells out to `open`, which it allows up to 10s. With no
  // in-flight state the click reads as unregistered, and each repeat click
  // queues another subprocess.
  btn.textContent = "Opening…";
  btn.disabled = true;
  try {
    const res = await fetch(`/reveal?course=${encodeURIComponent(key)}`);
    btn.textContent = res.ok ? "Opened" : "Failed";
  } catch {
    btn.textContent = "Failed";
  } finally {
    btn.disabled = false;
  }
  setTimeout(() => { btn.textContent = original; }, 1500);
}

/** Build the sticky three-column course header strip. */
function renderCourseHeads(root) {
  const head = el("div", "lanes-head");
  head.append(el("div", "lanes-head-spacer", "Date"));

  for (const key of laneOrder()) {
    const course = courseByKey(key);
    const card = el("div", "course-card");
    // Mirrors `data-lane` on the day-row lanes: the column order is data-driven
    // (it follows `courses` in the JSON), so nothing should address a course by
    // position.
    card.dataset.course = course.key;
    card.style.setProperty("--accent", course.color);

    const title = el("h2");
    title.append(el("span", "course-code", `${course.code} `));
    title.append(el("span", "course-name", course.title));
    card.append(title);
    card.append(el("p", "course-meta",
      [course.instructor, course.meets].filter(Boolean).join(" · ")));

    const links = el("div", "course-links");
    if (course.canvas) {
      links.append(el("a", "btn", "Canvas", {
        href: course.canvas, target: "_blank", rel: "noopener",
        "data-focus-key": `course-canvas-${key}`,
      }));
    }
    if (course.folder) {
      const reveal = el("button", "btn", "Class folder",
        { type: "button", title: course.folder,
          "data-focus-key": `course-folder-${key}` });
      reveal.addEventListener("click", () => revealFolder(key, reveal));
      links.append(reveal);
    }
    card.append(links);

    const { done, total } = progressFor(state.doc.items, key);
    const bar = el("div", "progress");
    const fill = el("div", "progress-fill");
    fill.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
    bar.append(fill);
    card.append(bar);
    const text = el("div", "progress-text");
    text.append(el("span", "progress-count", `${done} of ${total} done`));
    if (course.weights) text.append(el("span", "progress-weights", ` · ${course.weights}`));
    card.append(text);

    if (course.flags?.length) {
      const details = el("details", "course-flags");
      details.append(el("summary", null,
        `${course.flags.length} caveat${course.flags.length === 1 ? "" : "s"}`));
      const list = el("ul");
      for (const flag of course.flags) list.append(el("li", null, flag));
      details.append(list);
      card.append(details);
    }

    head.append(card);
  }
  root.append(head);
}

/** Build one item card. */
function renderItem(item, today) {
  const course = courseByKey(item.course);
  const card = el("div", `item item--${item.kind}`);
  card.dataset.itemId = item.id;
  card.style.setProperty("--accent", course?.color ?? "");
  if (item.done) card.classList.add("item--done");
  if (isOverdue(item, today)) card.classList.add("item--overdue");
  // A completed item is a record, not a task. It keeps its place on the day for
  // the audit trail but drops to title + time, because points, confidence, and
  // provenance warnings are decisions nobody has left to make. Clicking the
  // title expands it back to the full card, same as any other item.
  const minimized = item.done && !state.expanded.has(item.id);
  if (minimized) card.classList.add("item--min");

  const head = el("div", "item-head");

  // Sessions are context, not work, so they get no checkbox.
  if (!NON_GRADABLE.has(item.kind)) {
    const box = el("input", "item-check", null,
      { type: "checkbox", "data-focus-key": `item-check-${item.id}` });
    box.checked = item.done;
    box.disabled = !state.persistenceAvailable || state.connectionCheck;
    if (box.disabled) box.title = "Reconnect to the local tracker before changing completion state";
    box.setAttribute("aria-label", `Mark ${item.title} complete`);
    box.addEventListener("change", () => toggleDone(item, box.checked));
    head.append(box);
  }

  const body = el("div", "item-body");
  // A div with a click listener is not a control: no focus, no Enter/Space, no
  // announced state. Detail and Canvas links are the whole payload of an item,
  // so keyboard-only users could not reach any of it.
  const extraId = `item-extra-${item.id}`;
  const title = el("div", "item-title", item.title, {
    role: "button",
    tabindex: "0",
    "aria-expanded": String(state.expanded.has(item.id)),
    "aria-controls": extraId,
    "data-focus-key": `item-title-${item.id}`,
  });
  const toggleExpanded = () => {
    if (state.expanded.has(item.id)) state.expanded.delete(item.id);
    else state.expanded.add(item.id);
    render();
  };
  title.addEventListener("click", toggleExpanded);
  title.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault(); // Space would scroll the page instead.
    toggleExpanded();
  });
  body.append(title);

  const sub = el("div", "item-sub");
  if (item.at) sub.append(el("span", "chip chip--time", formatTime(item.at)));
  const grade = gradeLabel(item);
  if (grade) {
    sub.append(el("span", `chip chip--grade chip--grade-${item.submissionStatus}`, grade));
  }
  const refreshChanges = changesForItem(item.id);
  if (refreshChanges.length) {
    const label = refreshChanges.some((change) => change.kind === "added")
      ? "Added by refresh" : "Updated";
    sub.append(el("span", "chip chip--changed", label));
  }
  if (!minimized) {
    if (typeof item.points === "number" && item.points > 0) {
      sub.append(el("span", "chip chip--pts", `${item.points} pt`));
    }
    if (item.kind !== "session") {
      sub.append(el("span", `chip chip--${item.confidence}`, item.confidence));
    }
  }
  // Deliberately outside the `!minimized` gate: `isOverdue` already returns
  // false for anything done, and only a done item can be minimized, so gating
  // it too would be dead code that implies done-and-overdue is a real state
  // being hidden. It isn't.
  if (isOverdue(item, today)) sub.append(el("span", "chip chip--provisional", "overdue"));
  body.append(sub);

  // Warnings always show on open work — they are the point of the provenance
  // work. Detail and links stay collapsed until the title is clicked.
  if (!minimized) for (const flag of item.flags) body.append(el("div", "item-flag", flag));

  const extra = el("div", "item-extra", null, { id: extraId });
  extra.hidden = !state.expanded.has(item.id);
  if (item.detail) extra.append(el("div", "item-detail", item.detail));
  for (const change of refreshChanges) {
    const update = el("div", "item-refresh-detail");
    if (change.kind === "added") update.textContent = "Added by the latest Canvas refresh.";
    else if (change.kind === "removed") update.textContent = "Removed by the latest Canvas refresh.";
    else {
      update.textContent = (change.fields ?? []).map((field) => (
        `${refreshFieldLabel(field.field)}: ${refreshValue(field.before)} → ${refreshValue(field.after)}`
      )).join(" · ");
    }
    extra.append(update);
  }
  const meta = el("div", "item-detail");
  meta.append(document.createTextNode(`Source: ${item.source}`));
  if (item.url) {
    meta.append(document.createTextNode(" · "));
    meta.append(el("a", null, "Open in Canvas", {
      href: item.url, target: "_blank", rel: "noopener",
      "data-focus-key": `item-canvas-${item.id}`,
    }));
  }
  extra.append(meta);
  body.append(extra);

  head.append(body);
  card.append(head);
  return card;
}

/** Build the timeline: week separators, day rows, lanes, milestone banners. */
function renderTimeline(root, visible, today) {
  const timeline = el("div", "timeline");
  const grouped = groupByDay(visible, laneOrder());
  const termStart = state.doc.term?.start ?? grouped[0]?.date;
  const termEnd = state.doc.term?.finalsEnd ?? grouped[grouped.length - 1]?.date;
  const days = fillCalendarDays(grouped, termStart, termEnd);

  if (!days.length) {
    timeline.append(el("div", "empty", "Nothing matches the current filters."));
    root.append(timeline);
    return;
  }

  const now = nowISO();
  const markerAt = nowLineIndex(days, now);
  // Remembered so the ticker can tell "the minute changed" from "the marker
  // needs to move", and only pay for a re-render in the second case.
  state.nowIndex = markerAt;
  let lastWeek = null;

  for (const [index, day] of days.entries()) {
    // When the boundary lands on a day that has its own row, the marker becomes
    // that row's top edge instead of a separate band. A standalone band above
    // the row would put "NOW 1:38 PM" in one gutter and "WED Aug 26 today" in
    // the next one down, and two stacked labels read as two rows — which makes
    // the rule look like a divider closing out yesterday rather than the line
    // running through today.
    // A day whose only items are milestones renders no .day-row at all, so
    // there would be nothing for the marker to merge INTO — and suppressing the
    // band on top of that loses the marker entirely. 2026-10-16 is exactly that
    // day: one milestone, no coursework.
    const hasDayRow = day.items.length === 0
      || day.items.some((item) => item.kind !== "milestone");
    const mergeIntoRow = index === markerAt && day.date === today && hasDayRow;
    // Emitted before the week separator on purpose: when the boundary lands on
    // the first day of a week, putting the marker after would strand that
    // week's header above the line, in the past.
    if (index === markerAt && !mergeIntoRow) timeline.append(renderNowLine(now));

    const week = weekStart(day.date);
    if (week !== lastWeek) {
      lastWeek = week;
      timeline.append(el("div", "week-sep",
        `Week ${weekNumber(day.date, termStart)} · ${formatDate(week)}`));
    }

    const milestones = day.items.filter((i) => i.kind === "milestone");
    const laneItems = day.items.filter((i) => i.kind !== "milestone");

    const isToday = day.date === today;
    const isPast = day.date < today;

    for (const milestone of milestones) {
      const row = el("div", "milestone-row");
      row.append(renderDayLabel(day.date, today));
      const banner = el("div", "milestone");
      banner.append(document.createTextNode(milestone.title));
      if (milestone.detail) {
        banner.append(el("span", "milestone-detail", ` — ${milestone.detail}`));
      }
      row.append(banner);
      timeline.append(row);
    }

    if (!laneItems.length && milestones.length) continue;

    const row = el("div", "day-row");
    if (!laneItems.length) row.classList.add("day-row--empty");
    if (isToday) row.classList.add("day-row--today");
    else if (isPast) row.classList.add("day-row--past");
    else row.classList.add("day-row--future");
    if (mergeIntoRow) row.classList.add("day-row--now");
    row.append(renderDayLabel(day.date, today));
    // Appended to the ROW, not the gutter cell: it is positioned absolutely
    // onto the row's top border, so it must not become a grid item in the
    // label column. Sitting on the rule is the whole point — a red line with
    // its time label 56px lower reads as an unlabelled divider between two
    // rows, which is exactly how "the line is on yesterday" happens.
    if (mergeIntoRow) row.append(renderNowStamp(now));

    for (const key of laneOrder()) {
      const lane = el("div", "lane");
      lane.dataset.lane = key;
      for (const item of laneItems.filter((i) => i.course === key)) {
        lane.append(renderItem(item, today));
      }
      row.append(lane);
    }
    timeline.append(row);
  }
  // Everything on screen is already past — the term is over, or the filters
  // left only finished work behind.
  if (markerAt >= days.length) timeline.append(renderNowLine(now));
  bindNowLineToNextRow(timeline);
  root.append(timeline);
}

/**
 * Tell the row under the marker to drop its own top border, so the red rule and
 * that row read as one block rather than as a divider hanging off the row above.
 */
function bindNowLineToNextRow(timeline) {
  const line = timeline.querySelector(".now-line");
  const next = line?.nextElementSibling;
  if (!next) return;
  if (next.classList.contains("day-row")) next.classList.add("day-row--after-now");
  else if (next.classList.contains("milestone-row")) next.classList.add("milestone-row--after-now");
  // The band is emitted before the week separator, so on the first day of a
  // week the separator is what sits under the rule. Left alone it keeps its
  // 28px top margin and the rule floats midway between two days again — the
  // original complaint, in a case the fixture never reaches.
  else if (next.classList.contains("week-sep")) next.classList.add("week-sep--after-now");
}

/**
 * The live "you are here" rule across the timeline. Everything above it is due;
 * everything below is not yet.
 */
/**
 * The spoken form of the now marker. Shared so the standalone band and the
 * merged day-row stamp announce identically, and so the ticker can refresh it.
 *
 * @param {string} now - "YYYY-MM-DDTHH:MM" wall clock.
 * @returns {string} The aria-label text.
 */
function nowLabel(now) {
  return `Current time: ${formatDate(now.slice(0, 10))}, ${formatTime(now)}`;
}

function renderNowLine(now) {
  const row = el("div", "now-line");
  row.setAttribute("role", "separator");
  // One stamp on the rule, same shape as the merged form. The date rides along
  // because this form has no day row under it to name the date.
  const label = el("div", "now-label");
  label.append(el("span", "now-tag", "NOW"));
  label.append(el("span", "now-date", formatDate(now.slice(0, 10))));
  label.append(el("span", "now-time", formatTime(now)));
  row.append(label);
  row.setAttribute("aria-label", nowLabel(now));
  return row;
}

/**
 * The "NOW 1:55 PM" stamp for the merged marker form, positioned onto the row's
 * top border by CSS. Hangs off the row rather than the gutter cell so it cannot
 * become a grid item and stack under the date.
 *
 * @param {string} now - Wall clock as "YYYY-MM-DDTHH:MM".
 * @returns {HTMLElement} The stamp element.
 */
function renderNowStamp(now) {
  const stamp = el("div", "day-now");
  // Mirrors renderNowLine(): the two forms are the same UI element, so they
  // must announce identically. Without this the merged form is a plain div and
  // nothing says the row IS the now boundary.
  stamp.setAttribute("role", "separator");
  stamp.setAttribute("aria-label", nowLabel(now));
  stamp.append(el("span", "day-now-tag", "NOW"));
  stamp.append(el("span", "day-now-time", formatTime(now)));
  return stamp;
}

/**
 * Build the left gutter cell for a day: weekday, date, and a relative hint.
 *
 * @param {string} date - "YYYY-MM-DD".
 * @param {string} today - "YYYY-MM-DD".
 * @returns {HTMLElement} The gutter cell.
 */
function renderDayLabel(date, today) {
  const cell = el("div", "day-label");
  cell.append(el("div", "day-dow", DOW[dayOfWeek(date)]));
  cell.append(el("div", "day-date", formatDate(date)));
  const rel = relativeDay(date, today);
  if (rel) cell.append(el("div", "day-rel", rel));
  return cell;
}

/** Build the pinned panel of items that have no due date. */
function renderUndated(root, visible) {
  const undated = visible
    .filter((i) => !parseAt(i.at) && i.kind !== "milestone")
    // Sorted for the same reason a day lane is. Without this the panel renders
    // in raw file order, which put three finished items above the one still
    // open — and now that a finished item also renders condensed, the panel led
    // with three shrunk cards and buried the full-detail one that needs doing.
    .sort((a, b) => compareItems(a, b, laneOrder()));
  if (!undated.length) return;
  const panel = el("div", "undated");
  panel.append(el("h3", null, "No due date — do these whenever"));
  const today = todayISO();
  for (const item of undated) panel.append(renderItem(item, today));
  root.append(panel);
}

/** Full re-render. Cheap enough at this data size to avoid diffing. */
function render() {
  const root = state.el.root;
  if (!root || !state.doc) return;

  const scrollY = window.scrollY;
  // A full rebuild destroys whatever had focus and drops a keyboard user back
  // to the top of the document. That bites hardest on the one control whose
  // own activation causes the re-render: expanding an item detail. Restored
  // below by key, for the same reason scroll position is.
  const focusKey = root.contains(document.activeElement)
    ? document.activeElement.dataset.focusKey ?? null
    : null;
  root.textContent = "";

  const head = el("div", "page-head");
  head.append(el("h1", null, "Fall 2026 coursework"));
  const counts = state.doc.items.filter((i) => isLiveTrackerItem(i)
    && !NON_GRADABLE.has(i.kind));
  const done = counts.filter((i) => i.done).length;
  head.append(el("p", "page-sub",
    `${done} of ${counts.length} items complete · classes ${state.doc.term?.start ?? "?"} `
    + `– ${state.doc.term?.lastClassDay ?? "?"} · finals ${state.doc.term?.finalsStart ?? "?"}`
    + `–${state.doc.term?.finalsEnd ?? "?"} · all times ${TZ}`));
  root.append(head);

  buildToolbar(root);
  renderRefreshHistory(root);
  renderCourseHeads(root);

  const visible = filterItems(state.doc.items, state.filters);
  const today = todayISO();
  // Remembered so the ticker can tell that the calendar day rolled over while
  // this page sat open.
  state.todayRendered = today;
  renderUndated(root, visible);
  renderTimeline(root, visible, today);

  observeChrome();
  measureChrome();
  window.scrollTo(0, scrollY);
  if (focusKey) {
    // preventScroll: .focus() would otherwise scroll the element into view and
    // undo the restore on the line above.
    root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)
      ?.focus({ preventScroll: true });
  }
}

/**
 * Fetch coursework.json and render.
 * `jump` is false when recovering from a save conflict: the reader is mid-page
 * and should not be thrown back to today's row.
 */
async function load({ jump = true } = {}) {
  try {
    const res = await fetch("coursework.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.mtime = res.headers.get("X-Coursework-Mtime");
    state.doc = validateData(await res.json());
    await loadRefreshHistory();
    state.persistedDoc = structuredClone(state.doc);
    state.persistenceAvailable = true;
    state.connectionCheck = false;
    setStatus("Saved");
    render();
    // Land on today rather than August, so the page opens on live work.
    if (jump) requestAnimationFrame(jumpToToday);
  } catch (err) {
    const root = state.el.root;
    if (root) {
      root.textContent = "";
      const empty = el("div", "empty");
      empty.append(el("p", null,
        `Could not load coursework.json (${err.message}). Start the local server with `
        + "./coursework.sh — opening this file directly with file:// will not work."));
      const retry = el("button", "btn btn--reconnect", "Reconnect", {
        type: "button", "data-testid": "cw-reconnect",
      });
      retry.addEventListener("click", reconnect);
      empty.append(retry);
      root.append(empty);
    }
  }
}

/**
 * Initialize the coursework page. Safe to call once the DOM is ready;
 * no-ops if the mount point is missing.
 */
export function initCoursework() {
  if (typeof document === "undefined") return;
  const root = document.getElementById("coursework-root");
  if (!root) return;
  if (root.dataset.cwInit === "1") return; // idempotent guard
  root.dataset.cwInit = "1";
  state.el.root = root;
  loadFilters();
  // The toolbar wraps to a second line on narrow viewports, which changes the
  // chrome height without any re-render of our own.
  window.addEventListener("resize", () => requestAnimationFrame(measureChrome));
  startNowTicker();
  load();
  pollCanvasRefresh();
}

// Guarded entry point: only wire to the DOM in a browser. Importing under Node
// (no `document`) must not execute any DOM code.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCoursework, { once: true });
  } else {
    initCoursework();
  }
}
