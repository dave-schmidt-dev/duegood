const CLOCK_RANGE = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)\b/iu;
const CLOCK_TOKEN = /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/giu;
const DATE = /^(?:[a-z]+,?\s+)?(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}|\d{2}))?$/iu;
const MONTH_DATE = /^(?:(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})$/iu;
const MONTHS = new Map([["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3], ["apr", 4], ["april", 4], ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7], ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9], ["september", 9], ["oct", 10], ["october", 10], ["nov", 11], ["november", 11], ["dec", 12], ["december", 12]]);
const WEEKDAY_DATE_PREFIX = /^(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?),\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2}),$/iu;
const WEEKDAY_INDEX = new Map([["sun", 0], ["sunday", 0], ["mon", 1], ["monday", 1], ["tue", 2], ["tuesday", 2], ["wed", 3], ["wednesday", 3], ["thu", 4], ["thursday", 4], ["fri", 5], ["friday", 5], ["sat", 6], ["saturday", 6]]);

const clean = (value) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
const unresolved = (reason = "AMBIGUOUS_SCHEDULE") => ({ status: "unresolved", reason, sessions: [] });

function validDate(year, month, day) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() + 1 === month && value.getUTCDate() === day
    ? value.toISOString().slice(0, 10) : null;
}

function parseClock(match) {
  const value = (hour, minute, meridian) => {
    hour = Number(hour); minute = Number(minute);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const total = (hour % 12) * 60 + minute + (/^p/iu.test(meridian) ? 720 : 0);
    return { total, text: String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0") };
  };
  const start = value(match[1], match[2], match[3]), end = value(match[4], match[5], match[6]);
  return start && end && end.total > start.total ? { startTime: start.text, endTime: end.text } : null;
}

function matchingItemStarts(items, label) {
  label = label.toLowerCase();
  const matches = [];
  for (let start = 0; start < items.length; start += 1) {
    let text = "";
    for (let end = start; end < items.length && end < start + 4; end += 1) {
      text = clean(text + " " + items[end].text).toLowerCase();
      if (text === label) matches.push(items[start].x);
      if (text.length >= label.length) break;
    }
  }
  return matches;
}

function dateAtYear(text, year) {
  const numeric = DATE.exec(clean(text));
  if (numeric) {
    const explicit = numeric[3] ? numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]) : year;
    return explicit === year ? validDate(year, Number(numeric[1]), Number(numeric[2])) : null;
  }
  const written = MONTH_DATE.exec(clean(text));
  if (!written) return null;
  return validDate(year, MONTHS.get(written[1].toLowerCase()), Number(written[2]));
}

function weekdayDateAtYear(text, year) {
  const match = WEEKDAY_DATE_PREFIX.exec(clean(text));
  if (!match) return null;
  const date = validDate(year, MONTHS.get(match[2].toLowerCase()), Number(match[3]));
  return date !== null && new Date(date + "T00:00:00.000Z").getUTCDay() === WEEKDAY_INDEX.get(match[1].toLowerCase()) ? date : null;
}

/** True only for a standalone first-page role heading, never an incidental mention. */
export function isCourseSyllabusFirstPage(page) {
  const rows = Array.isArray(page?.rows) ? page.rows
    : typeof page === "string" ? page.split(/\n/u).map((text) => ({ text })) : [];
  return rows.some((row) => /^course\s+syllabus\s*:?$/iu.test(clean(row?.text)));
}

/**
 * Parses only the verified PDF grammar: separate meeting, semester anchor, and weekly date columns.
 * @param {Array<{text:string,rows:Array<{text:string,line:number,items:Array<{text:string,x:number}>}>}>} pages
 * @param {{timeZone:string,source:{kind:string,fileId:number,sha256:string}}} options
 */
export function parsePdfSyllabusSchedule(pages, { timeZone, source }) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 80 || !isCourseSyllabusFirstPage(pages[0])) return null;
  if (typeof timeZone !== "string" || timeZone.length > 80 || source?.kind !== "file"
      || !Number.isSafeInteger(source.fileId) || source.fileId < 1 || !/^[a-f0-9]{64}$/u.test(source.sha256)) return unresolved("SOURCE_UNAVAILABLE");
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); } catch { return unresolved("SOURCE_UNAVAILABLE"); }
  if (pages.some((page) => !Array.isArray(page?.rows) || typeof page.text !== "string" || page.text.length > 300_000)) return null;

  const meetingRows = pages.flatMap((page, pageIndex) => page.rows.map((row) => ({ ...row, page: pageIndex + 1 })))
    .filter((row) => /^meeting\s+day\s*,?\s*time\s*,?\s*and\s+room\s+number\s*:?$/iu.test(clean(row.text)));
  if (meetingRows.length !== 1) return unresolved();
  const pageRows = pages[meetingRows[0].page - 1].rows;
  const next = pageRows.find((row) => row.line === meetingRows[0].line + 1);
  const clockMatches = [...clean(next?.text).matchAll(new RegExp(CLOCK_RANGE.source, CLOCK_RANGE.flags.replace("g", "") + "g"))];
  const clockTokens = [...clean(next?.text).matchAll(CLOCK_TOKEN)];
  if (!next || clockMatches.length !== 1 || clockTokens.length !== 2 || /\b(?:office\s+hours?|final\s+exam)\b/iu.test(next.text)) return unresolved();
  const clock = parseClock(clockMatches[0]);
  if (!clock) return unresolved();

  const anchors = pages.flatMap((page, pageIndex) => page.rows.map((row) => ({ ...row, page: pageIndex + 1 })))
    .filter((row) => /^fall\s+(20\d{2})\b.*\bsemester\s+course\s+dates\s*:?$/iu.test(clean(row.text)));
  const classPages = pages.map((page, index) => ({ page, number: index + 1 }))
    .filter(({ page }) => page.rows.some((row) => /^class\s+schedule\s*:?$/iu.test(clean(row.text))));
  if (anchors.length !== 1 || classPages.length !== 1 || anchors[0].page !== classPages[0].number) return unresolved();
  const year = Number(/^fall\s+(20\d{2})/iu.exec(clean(anchors[0].text))[1]);

  const weeklyPages = pages.map((page, index) => ({ page, number: index + 1 }))
    .filter(({ page }) => page.rows.some((row) => /^weekly\s+schedule\s*:?$/iu.test(clean(row.text))));
  if (weeklyPages.length !== 1) return unresolved();
  const weekly = weeklyPages[0];
  const headers = weekly.page.rows.filter((row) => {
    const items = Array.isArray(row.items) ? row.items : [];
    const classes = matchingItemStarts(items, "class date"), dues = matchingItemStarts(items, "due date");
    return classes.length === 1 && dues.length === 1 && Math.abs(classes[0] - dues[0]) >= 20;
  });
  if (headers.length !== 1) return unresolved();
  const header = headers[0];
  const classX = matchingItemStarts(header.items, "class date")[0], dueX = matchingItemStarts(header.items, "due date")[0];
  const headerXs = [...new Set(header.items.map((item) => item.x).filter(Number.isFinite))].sort((a, b) => a - b);
  const leftHeader = headerXs.filter((x) => x < classX - 10).at(-1);
  const rightHeader = headerXs.find((x) => x > classX + 10);
  if (leftHeader === undefined && rightHeader === undefined) return unresolved();
  const lower = leftHeader === undefined ? -Infinity : (leftHeader + classX) / 2;
  const upper = rightHeader === undefined ? Infinity : (rightHeader + classX) / 2;
  if (!(classX > lower && classX < upper) || dueX > lower && dueX < upper) return unresolved();
  const rows = weekly.page.rows.filter((row) => row.line > header.line);
  if (rows.length === 0 || rows.length > 100) return unresolved(rows.length > 100 ? "LIMIT_EXCEEDED" : "AMBIGUOUS_SCHEDULE");
  if (rows.some((row) => /\b(?:office\s+hours?|final\s+exam|cancel\w*|postpone\w*|holiday|no\s+class(?:es)?)\b/iu.test(row.text))) return unresolved();
  const sessions = [];
  const classCell = (row) => clean(row.items.filter((item) => item.x > lower && item.x < upper && clean(item.text))
    .sort((a, b) => a.x - b.x).map((item) => item.text).join(" "));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const cell = classCell(row);
    if (!cell) continue;
    let date = dateAtYear(cell, year);
    if (date === null) {
      date = weekdayDateAtYear(cell, year);
      const continuation = rows[index + 1];
      if (date === null || !continuation || classCell(continuation) !== String(year)) return unresolved();
      index += 1;
    }
    sessions.push({ date, startTime: clock.startTime, endTime: clock.endTime,
      title: "Class session", source: { ...source, page: weekly.number, line: row.line } });
  }
  if (sessions.length === 0) return unresolved("NO_SUPPORTED_SCHEDULE");
  const unique = new Map();
  for (const session of sessions) {
    if (unique.has(session.date)) return unresolved();
    unique.set(session.date, session);
  }
  return { status: "complete", sessions: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
