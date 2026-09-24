import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_SECTIONS = [
  "## Course import",
  "## canvas-export and materials",
  "## Inbox",
  "## Profile",
  "## Broker",
  "## Orchestration",
];

const VALID_STATUS_PREFIXES = ["confirmed", "unknown", "intentionally changed"];
const REASON_REQUIRED_PREFIXES = ["unknown", "intentionally changed"];

/** Slice `doc` from the first line-start match of `heading` to (but excluding) the next
 * line-start `## ` heading, or the end of the document if there is none. */
export function extractSection(doc, heading) {
  const headingPattern = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu");
  const headingMatch = headingPattern.exec(doc);
  if (headingMatch === null) return undefined;
  const rest = doc.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingMatch = /^## /mu.exec(rest);
  return nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
}

export function validateRequiredSections(doc) {
  const errors = [];
  for (const heading of REQUIRED_SECTIONS) {
    if (extractSection(doc, heading) === undefined) {
      errors.push(`docs/REFRESH-CONTRACT.md is missing the required section "${heading}".`);
    }
  }
  return errors;
}

/** Parse `| # | Contract row | Status |`-style data rows (leading cell is an integer) out of a
 * markdown table, skipping header and separator rows. */
export function parseContractTableRows(section) {
  const rows = [];
  for (const line of section.split("\n")) {
    if (!/^\|\s*\d+\s*\|/u.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    rows.push({ raw: line, cells });
  }
  return rows;
}

function validateStatusCell(statusCell) {
  const matchedPrefix = VALID_STATUS_PREFIXES.find(
    (prefix) => statusCell === prefix || statusCell.startsWith(`${prefix} `) || statusCell.startsWith(`${prefix}—`) || statusCell.startsWith(`${prefix} —`),
  );
  if (matchedPrefix === undefined) {
    return `status cell does not start with confirmed/unknown/intentionally changed: "${statusCell.slice(0, 80)}"`;
  }
  if (REASON_REQUIRED_PREFIXES.includes(matchedPrefix)) {
    const afterPrefix = statusCell.slice(matchedPrefix.length);
    const reason = afterPrefix.replace(/^[\s—-]+/u, "").trim();
    if (reason.length === 0) {
      return `status "${matchedPrefix}" has no reason after it: "${statusCell.slice(0, 80)}"`;
    }
  }
  return undefined;
}

export function validateSectionStatuses(doc) {
  const errors = [];
  for (const heading of REQUIRED_SECTIONS) {
    const section = extractSection(doc, heading);
    if (section === undefined) continue;
    const rows = parseContractTableRows(section);
    if (rows.length === 0) {
      errors.push(`"${heading}" has no contract table rows.`);
      continue;
    }
    for (const { cells } of rows) {
      if (cells.length !== 3) {
        errors.push(`"${heading}" has a table row that is not a 3-column (#, contract row, status) row: ${cells.join(" | ").slice(0, 80)}`);
        continue;
      }
      const statusError = validateStatusCell(cells[2]);
      if (statusError !== undefined) {
        errors.push(`"${heading}" row ${cells[0]}: ${statusError}`);
      }
    }
  }
  return errors;
}

export function validateContractDoc(doc) {
  return [...validateRequiredSections(doc), ...validateSectionStatuses(doc)];
}

/** Recursively collect every string value in a JSON document. */
function collectStrings(value, out) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) collectStrings(value[key], out);
  }
  return out;
}

/** Find every `http(s)://host...`-shaped substring embedded in free text, not just whole-string
 * URLs, since fixture prose can mention a URL mid-sentence. */
function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s"'<>)]+/gu);
  return matches ?? [];
}

export function validateFixtureSynthetic(fixtureDoc, label) {
  if (fixtureDoc.synthetic !== true) {
    return [`${label} is not marked "synthetic": true.`];
  }
  return [];
}

export function validateFixtureOrigins(fixtureDoc, label) {
  const errors = [];
  const strings = collectStrings(fixtureDoc, []);
  for (const text of strings) {
    for (const url of extractUrls(text)) {
      let hostname;
      try {
        hostname = new URL(url).hostname;
      } catch {
        errors.push(`${label} contains an unparsable URL: ${url.slice(0, 80)}`);
        continue;
      }
      if (!hostname.endsWith(".invalid")) {
        errors.push(`${label} uses a non-.invalid origin: ${url.slice(0, 80)}`);
      }
    }
  }
  return errors;
}

export function validateFixtureDoc(fixtureDoc, label) {
  return [...validateFixtureSynthetic(fixtureDoc, label), ...validateFixtureOrigins(fixtureDoc, label)];
}

function main() {
  const contractDoc = readFileSync(path.join(root, "docs", "REFRESH-CONTRACT.md"), "utf8");
  const mockFixture = JSON.parse(readFileSync(path.join(root, "test", "fixtures", "refresh-canvas-mock.json"), "utf8"));
  const expectedStoreFixture = JSON.parse(readFileSync(path.join(root, "test", "fixtures", "refresh-expected-store.json"), "utf8"));

  const errors = [
    ...validateContractDoc(contractDoc),
    ...validateFixtureDoc(mockFixture, "test/fixtures/refresh-canvas-mock.json"),
    ...validateFixtureDoc(expectedStoreFixture, "test/fixtures/refresh-expected-store.json"),
  ];

  if (errors.length > 0) {
    throw new Error(`Refresh contract check failed:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  console.log(`Refresh contract check passed: all ${REQUIRED_SECTIONS.length} sections present with valid statuses; both fixtures are synthetic and .invalid-only.`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
