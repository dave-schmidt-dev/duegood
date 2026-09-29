const MONTHS = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3],
  ["apr", 4], ["april", 4], ["may", 5], ["jun", 6], ["june", 6], ["jul", 7],
  ["july", 7], ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9], ["september", 9],
  ["oct", 10], ["october", 10], ["nov", 11], ["november", 11], ["dec", 12], ["december", 12],
]);
const DATE = /\b(?:20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/20\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2})\b/giu;
const CLOCK_RANGE = /\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|AM|PM)?)\s*(?:to|[-–—])\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|AM|PM)?)\b/giu;
const CLASS_CONTEXT = /\b(?:class(?:es)?|lecture|meeting|seminar|session|synchronous)\b/iu;
const CLASS_SECTION = /^(?:class(?:es)?|lecture|seminar|synchronous)(?:\s+(?:meetings?|sessions?|schedule))?(?:\s+20\d{2})?\s*[:.]?$/iu;
const EXCLUDED = /\b(?:office\s+hours?|due|deadlines?|assignments?|exams?|quiz(?:zes)?|tests?|holiday)\b/iu;
const OFFICE_OR_DEADLINE = /\b(?:office\s+hours?|due|deadlines?|assignments?)\b/iu;
const CLOCK_TEXT = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/iu;
const CANCELLATION = /\b(?:no\s+(?:class|meeting|session|school)|(?:will|does|do)\s+not\s+meet|won['’]t\s+meet|cancel(?:led|ed|lation)?|postponed|holiday)\b/iu;
const LIMIT_TEXT = 300_000;

function dateValue(token) {
  let m = /^(20\d{2})-(\d{1,2})-(\d{1,2})$/u.exec(token);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/u.exec(token);
  if (m) return validDate(+m[3], +m[1], +m[2]);
  m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})$/iu.exec(token);
  const month = m && MONTHS.get(m[1].toLowerCase());
  return m && month ? validDate(+m[3], month, +m[2]) : null;
}

function validDate(year, month, day) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() + 1 !== month || value.getUTCDate() !== day) return null;
  return { year, iso: year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0") };
}

function datesIn(line) {
  return [...line.matchAll(DATE)].map((match) => {
    const value = dateValue(match[0].replace(/\s+/gu, " ").trim());
    return value ? { ...value, index: match.index ?? 0, length: match[0].length } : null;
  }).filter(Boolean);
}

function timesIn(line) {
  const withoutDates = line.replace(DATE, (value) => " ".repeat(value.length));
  const matches = [...withoutDates.matchAll(CLOCK_RANGE)];
  if (matches.length !== 1) return null;
  const m = matches[0];
  if (!m) return null;
  let a = m[1].replace(/\./gu, "").trim();
  const b = m[2].replace(/\./gu, "").trim();
  const ampmA = /(?:AM|PM)$/iu.test(a);
  const ampmB = /(AM|PM)$/iu.exec(b)?.[1];
  if (ampmA !== (ampmB !== undefined)) {
    if (ampmA || ampmB === undefined) return null;
    a += " " + ampmB;
  }
  const parse = (v) => {
    const p = /^(\d{1,2})(?::(\d{2}))?(AM|PM)?$/iu.exec(v.replace(/\s/gu, "").toUpperCase());
    if (!p) return null;
    const h = +p[1], minute = +(p[2] ?? 0), meridian = p[3];
    if (minute > 59) return null;
    if (meridian) {
      if (h < 1 || h > 12) return null;
      return (h % 12) * 60 + minute + (meridian === "PM" ? 720 : 0);
    }
    if (h > 23 || p[2] === undefined) return null;
    return h * 60 + minute;
  };
  const start = parse(a), end = parse(b);
  if (start === null || end === null || end <= start) return null;
  const hhmm = (n) => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
  return { startTime: hhmm(start), endTime: hhmm(end) };
}

function unresolved(reason) {
  return { status: "unresolved", reason, sessions: [] };
}

/** Decodes supported text entities once, preserving doubly escaped literal text. */
export function decodeSyllabusEntities(input) {
  const entities = { "&nbsp;": " ", "&#160;": " ", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&amp;": "&" };
  return input.replace(/&(?:nbsp|lt|gt|quot|apos|amp);|&#160;/giu, (entity) => entities[entity.toLowerCase()]);
}

function syllabusText(input) {
  return decodeSyllabusEntities(input.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/giu, " ")
    .replace(/<\s*\/(?:p|div|li|tr|h[1-6])\s*>/giu, "\n")
    .replace(/<[^>]{1,2048}>/gu, " "))
    .replace(/[ \t\r]+/gu, " ").trim();
}

/**
 * Keeps cancellation dates internal to capture derivation so separate sources can conflict.
 * @param {string} input
 * @returns {string[]}
 */
export function syllabusCancelledDates(input) {
  if (typeof input !== "string" || input.length > LIMIT_TEXT) return [];
  return [...new Set(syllabusText(input).split(/\n/u).filter((line) => CANCELLATION.test(line))
    .flatMap((line) => datesIn(line).map((date) => date.iso)))];
}

/**
 * Accepts explicit full-year dated meeting rows; never expands a recurrence or header year.
 * @param {string} input
 * @param {{timeZone?:string,termName?:string|null,source?:{kind:string,sha256:string,fileId?:number,page?:number}}} [options]
 * @returns {{status:string,reason?:string,sessions:Array<{date:string,startTime:string,endTime:string,title:string,source:object}>}}
 */
export function parseSyllabusSchedule(input, { timeZone, termName = null, source } = {}) {
  if (typeof input !== "string" || input.length > LIMIT_TEXT) return unresolved(input ? "LIMIT_EXCEEDED" : "NO_SYLLABUS");
  const text = syllabusText(input);
  if (!text) return unresolved("NO_SYLLABUS");
  if (typeof timeZone !== "string" || timeZone.length > 80) return unresolved("SOURCE_UNAVAILABLE");
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); } catch { return unresolved("SOURCE_UNAVAILABLE"); }
  if (!source || !["course-body", "file"].includes(source.kind)
      || !/^[a-f0-9]{64}$/u.test(source.sha256)
      || (source.kind === "file" && (!Number.isSafeInteger(source.fileId) || source.fileId < 1))) {
    return unresolved("SOURCE_UNAVAILABLE");
  }
  const lines = text.split(/\n/u).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 10_000) return unresolved("LIMIT_EXCEEDED");
  const termYears = [...new Set((typeof termName === "string" ? termName.match(/\b20\d{2}\b/gu) ?? [] : []).map(Number))];
  const candidates = [];
  const cancelledDates = new Set(lines.filter((line) => CANCELLATION.test(line))
    .flatMap((line) => datesIn(line).map((date) => date.iso)));
  let sawAmbiguous = false;
  let sawUnclassifiedRow = false;
  let section = "unknown";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (CANCELLATION.test(line)) continue;
    const dates = datesIn(line);
    const clockText = CLOCK_TEXT.test(line);
    if (dates.length === 0 && (OFFICE_OR_DEADLINE.test(line) || !clockText && EXCLUDED.test(line))) {
      section = "excluded";
      continue;
    }
    if (dates.length === 0 && !clockText) {
      if (CLASS_SECTION.test(line)) { section = "class"; continue; }
      if (section !== "excluded" && /:\s*$/u.test(line)) section = "unknown";
    }
    // Excluded sections remain excluded until an explicit class heading starts a new one.
    if (section === "excluded") continue;
    const classRow = CLASS_CONTEXT.test(line) || section === "class";
    if (EXCLUDED.test(line) || /\basynchronous\b/iu.test(line)) {
      if (dates.length > 0 && classRow && (section === "class" || !OFFICE_OR_DEADLINE.test(line))) sawAmbiguous = true;
      continue;
    }
    const times = timesIn(line);
    if (!classRow) {
      if (dates.length > 0 || times || clockText) sawUnclassifiedRow = true;
      continue;
    }
    if (!times) {
      if (dates.length > 0 || clockText) sawAmbiguous = true;
      continue;
    }
    if (dates.length !== 1) {
      sawAmbiguous = true;
      continue;
    }
    if (cancelledDates.has(dates[0].iso)) {
      sawAmbiguous = true;
      continue;
    }
    if (termYears.length > 0 && !termYears.includes(dates[0].year)) {
      sawAmbiguous = true;
      continue;
    }
    candidates.push({ date: dates[0].iso, ...times, line: i + 1 });
  }
  if (sawAmbiguous || sawUnclassifiedRow) return unresolved("AMBIGUOUS_SCHEDULE");
  if (candidates.length === 0) return unresolved("NO_SUPPORTED_SCHEDULE");
  if (candidates.length > 1000) return unresolved("LIMIT_EXCEEDED");
  const byDate = new Map();
  for (const session of candidates) {
    const prior = byDate.get(session.date);
    if (prior && (prior.startTime !== session.startTime || prior.endTime !== session.endTime)) return unresolved("AMBIGUOUS_SCHEDULE");
    if (!prior) byDate.set(session.date, session);
  }
  const sessions = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map((session) => ({
    date: session.date, startTime: session.startTime, endTime: session.endTime,
    title: "Class session",
    source: { ...source, line: session.line },
  }));
  return { status: "complete", sessions };
}
