import { decodeSyllabusEntities } from "./canvas-syllabus-sessions.mjs";

const DAY = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const LABEL = /^meeting\s+day\s*,?\s*time\s*,?\s*and(?:\s+(?:location|room\s+number))?\s*:?\s*/iu;
const DECLARATION = /^(\d{1,2}\/\d{1,2}\/20\d{2})\s*[-–—]\s*(\d{1,2}\/\d{1,2}\/20\d{2})\s+online\s*,?\s*synchronous\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:['’]s|s)?\s+(\d{1,2}:\d{2})\s*(a\.?m\.?|p\.?m\.?)\s*[-–—]\s*(\d{1,2}:\d{2})\s*(a\.?m\.?|p\.?m\.?)\s*$/iu;
const clean = (text) => decodeSyllabusEntities(text).replace(/\s+/gu, " ").trim();
const unresolved = (reason = "AMBIGUOUS_SCHEDULE") => ({ status: "unresolved", reason, sessions: [] });

function paragraphText(xml) {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>|<w:(?:tab|br)\b[^>]*\/>/giu)]
    .map((match) => match[1] ?? " ").join("");
}

function cellText(xml) {
  return [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p\s*>/giu)]
    .map((match) => paragraphText(match[0])).join(" ").trim();
}

/**
 * Preserves Word's literal text runs and table cells before any schedule normalization.
 * @param {string} xml
 * @returns {{text:string,blocks:Array<{text:string,line:number,table?:number,cells?:string[]}>}|null}
 */
export function readSyllabusDocxDocument(xml) {
  if (typeof xml !== "string" || xml.length > 4 * 1024 * 1024) return null;
  const blocks = [];
  let table = 0, characters = 0;
  const append = (text, extra = {}) => {
    text = text.trim();
    if (!text) return;
    characters += text.length;
    blocks.push({ text, line: blocks.length + 1, ...extra });
  };
  for (const token of xml.matchAll(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl\s*>|<w:p\b[^>]*>[\s\S]*?<\/w:p\s*>/giu)) {
    if (token[0].startsWith("<w:tbl")) {
      if ((token[0].match(/<w:tbl\b/giu) ?? []).length !== 1) return null;
      table += 1;
      for (const row of token[0].matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr\s*>/giu)) {
        const cells = [...row[0].matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc\s*>/giu)]
          .map((cell) => cellText(cell[0]));
        if (cells.length > 40) return null;
        append(cells.join(" "), { table, cells });
        if (blocks.length > 10_000 || characters > 300_000) return null;
      }
    } else append(paragraphText(token[0]));
    if (blocks.length > 10_000 || characters > 300_000) return null;
  }
  return { text: blocks.map((block) => block.text).join("\n"), blocks };
}

function date(year, month, day) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const timestamp = Date.UTC(year, month - 1, day);
  const value = new Date(timestamp);
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day
    ? timestamp : null;
}

function fullDate(text) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/u.exec(text);
  return match ? date(+match[3], +match[1], +match[2]) : null;
}

function clock(text, meridian) {
  const [hour, minute] = text.split(":").map(Number);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const minutes = hour % 12 * 60 + minute + (/^p/iu.test(meridian) ? 720 : 0);
  return { minutes, text: String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0") };
}

function declaration(text) {
  const match = DECLARATION.exec(text);
  if (!match) return null;
  const start = fullDate(match[1]), end = fullDate(match[2]);
  const from = clock(match[4], match[5]), to = clock(match[6], match[7]);
  if (start === null || end === null || end < start || !from || !to || to.minutes <= from.minutes) return null;
  return { start, end, weekday: WEEKDAYS.indexOf(match[3].toLowerCase()), startTime: from.text, endTime: to.text };
}

function weekDate(text, bounds) {
  const match = /^(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}|\d{2}))?$/u.exec(clean(text));
  if (!match) return null;
  const boundedYears = [new Date(bounds.start - 6 * DAY).getUTCFullYear(), new Date(bounds.end + 6 * DAY).getUTCFullYear()];
  const years = match[3]?.length === 4 ? [+match[3]]
    : boundedYears.filter((year) => !match[3] || year % 100 === +match[3]);
  const candidates = [...new Set(years)].map((year) => date(year, +match[1], +match[2]))
    .filter((value) => value !== null && value >= bounds.start - 6 * DAY && value <= bounds.end + 6 * DAY);
  return candidates.length === 1 ? candidates[0] : null;
}

function dateColumns(block) {
  const starts = [], ends = [];
  for (let i = 0; i < (block.cells?.length ?? 0); i += 1) {
    const label = clean(block.cells[i]);
    if (/^start\s+date$/iu.test(label)) starts.push(i);
    if (/^end\s+date$/iu.test(label)) ends.push(i);
  }
  return starts.length === 1 && ends.length === 1 ? { start: starts[0], end: ends[0] } : null;
}

function academicDeadline(text, bounds, interval) {
  const match = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*,?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\s*,?\s+(20\d{2}))?\s*[,;:–—-]?\s+midterm((?:\s+[\p{L}\p{N}\p{P}]{1,40}){0,4})\s+due\s+by\s+(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)\s*\.?$/iu.exec(text);
  if (!match) return false;
  if (/\b(?:class\w*|meet\w*|cancel\w*|reschedul\w*|postpone\w*|async\w*|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/iu.test(match[5])) return false;
  const years = match[4] ? [+match[4]] : [new Date(bounds.start).getUTCFullYear(), new Date(bounds.end).getUTCFullYear()];
  const dates = [...new Set(years)].map((year) => date(year, MONTHS.indexOf(match[2].toLowerCase()) + 1, +match[3]))
    .filter((value) => value !== null && value >= interval.start && value <= interval.end
      && new Date(value).getUTCDay() === WEEKDAYS.indexOf(match[1].toLowerCase()));
  return dates.length === 1 && clock(match[6].includes(":") ? match[6] : match[6] + ":00", match[7]) !== null;
}

/**
 * Uses a labelled synchronous declaration for recurrence and validates its class date table.
 * Missing grammar returns null; recognized uncertainty never returns a partial meeting list.
 * @param {{text:string,blocks:Array<{text:string,line:number,table?:number,cells?:string[]}>}} document
 * @param {{timeZone:string,source:{kind:string,fileId?:number,sha256:string,page?:number}}} options
 * @returns {{status:string,reason?:string,sessions:Array<{date:string,startTime:string,endTime:string,title:string,source:object}>}|null}
 */
export function parseWeeklySyllabusSchedule(document, { timeZone, source }) {
  const labelled = document.blocks.filter((block) => LABEL.test(clean(block.text)));
  if (labelled.length === 0) return null;
  if (document.text.length > 300_000 || document.blocks.length > 10_000) return unresolved("LIMIT_EXCEEDED");
  if (typeof timeZone !== "string" || timeZone.length > 80 || !source || source.kind !== "file"
      || !Number.isSafeInteger(source.fileId) || source.fileId < 1 || !/^[a-f0-9]{64}$/u.test(source.sha256)) return unresolved("SOURCE_UNAVAILABLE");
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); } catch { return unresolved("SOURCE_UNAVAILABLE"); }
  const declarations = labelled.map((block) => declaration(clean(block.text).replace(LABEL, "")));
  if (declarations.some((value) => value === null)) return unresolved();
  const bounds = declarations[0];
  if (declarations.some((value) => JSON.stringify(value) !== JSON.stringify(bounds))) return unresolved();
  if (bounds.end - bounds.start >= 366 * DAY) return unresolved("LIMIT_EXCEEDED");
  const headings = document.blocks.filter((block) => /^class\s+schedule\s*:?\s*$/iu.test(clean(block.text)));
  if (headings.length !== 1) return unresolved();
  const headers = document.blocks.filter((block) => block.line > headings[0].line && block.table !== undefined && dateColumns(block));
  if (headers.length !== 1) return unresolved();
  const header = headers[0], columns = dateColumns(header);
  const rows = document.blocks.filter((block) => block.table === header.table && block.line > header.line);
  if (rows.length > 60) return unresolved("LIMIT_EXCEEDED");
  if (rows.length === 0) return unresolved();
  const exclusions = [];
  for (const row of rows) {
    if (!row.cells || row.cells.length !== header.cells.length) return unresolved();
    const start = weekDate(row.cells[columns.start], bounds), end = weekDate(row.cells[columns.end], bounds);
    if (start === null || end === null || end < start
        || end < bounds.start || start > bounds.end) return unresolved();
    const noteCells = row.cells.filter((_cell, index) => index !== columns.start && index !== columns.end);
    const notes = clean(noteCells.join(" "));
    const negatives = noteCells.map(clean).filter((cell) => /\bno\s+class(?:es)?\b/iu.test(cell));
    const cancelled = negatives.length > 0;
    if (cancelled && end - start > 6 * DAY) return unresolved();
    const meetingNotes = clean(row.cells.filter((_cell, index) => index !== columns.start && index !== columns.end
      && !/^out[- ]of[- ]class\s+assignments?$/iu.test(clean(header.cells[index])))
      .filter((cell) => !academicDeadline(clean(cell), bounds, { start, end })).join(" "));
    if (/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/iu.test(meetingNotes)
        || /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/iu.test(meetingNotes)
        || /\b(?:cancel\w*|postpone\w*|asynchronous|reschedul\w*|make[- ]?up|no\s+school|will\s+not\s+meet|does\s+not\s+meet)\b/iu.test(notes)
        || negatives.some((cell) => /\b(?:except|unless|instead|on)\b/iu.test(cell))
        || !cancelled && /\bholiday\b/iu.test(notes)) return unresolved();
    if (cancelled) exclusions.push({ start, end });
  }
  const sessions = [];
  for (let timestamp = bounds.start; timestamp <= bounds.end; timestamp += DAY) {
    if (new Date(timestamp).getUTCDay() !== bounds.weekday) continue;
    if (!exclusions.some((interval) => interval.start <= timestamp && interval.end >= timestamp)) sessions.push({
      date: new Date(timestamp).toISOString().slice(0, 10), startTime: bounds.startTime, endTime: bounds.endTime,
      title: "Class session", source: { ...source, line: labelled[0].line },
    });
  }
  if (sessions.length > 1000) return unresolved("LIMIT_EXCEEDED");
  return sessions.length ? { status: "complete", sessions } : unresolved("NO_SUPPORTED_SCHEDULE");
}
