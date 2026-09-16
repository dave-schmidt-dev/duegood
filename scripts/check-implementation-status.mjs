import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parsePhaseArg(argv) {
  const flagIndex = argv.indexOf("--phase");
  if (flagIndex === -1 || argv[flagIndex + 1] === undefined) {
    throw new Error("Usage: check-implementation-status.mjs --phase <n>");
  }
  const phase = Number.parseInt(argv[flagIndex + 1], 10);
  if (!Number.isInteger(phase) || phase < 1) {
    throw new Error(`--phase must be a positive integer, got ${argv[flagIndex + 1]}.`);
  }
  return phase;
}

function extractSection(doc, heading, nextHeadingPattern) {
  const start = doc.indexOf(heading);
  if (start === -1) return undefined;
  const rest = doc.slice(start + heading.length);
  const nextMatch = rest.match(nextHeadingPattern);
  return nextMatch ? rest.slice(0, nextMatch.index) : rest;
}

function checkboxLines(section) {
  return [...section.matchAll(/^- \[([ x])\]/gmu)].map((match) => match[1] === "x");
}

const phase = parsePhaseArg(process.argv.slice(2));
const statusPath = path.join(root, "docs", "IMPLEMENTATION-STATUS.md");
const doc = readFileSync(statusPath, "utf8");
const manifest = JSON.parse(readFileSync(path.join(root, "test", "test-membership.json"), "utf8"));

const phaseHeading = `## Phase ${phase} `;
const phaseSection = extractSection(doc, phaseHeading, /^## Phase /mu);
if (phaseSection === undefined) {
  throw new Error(`${statusPath} has no "${phaseHeading.trim()}" section.`);
}

const evidenceSection = extractSection(phaseSection, "### Evidence", /^### /mu);
if (evidenceSection === undefined) {
  throw new Error(`Phase ${phase}'s section has no "### Evidence" subsection.`);
}
const evidenceChecks = checkboxLines(evidenceSection);
if (evidenceChecks.length === 0) {
  throw new Error(`Phase ${phase}'s Evidence subsection lists no checklist items.`);
}
const uncheckedEvidence = evidenceChecks.filter((checked) => !checked).length;
if (uncheckedEvidence > 0) {
  throw new Error(`Phase ${phase}'s Evidence subsection has ${uncheckedEvidence} unfinished item(s) — not done yet.`);
}

const gatesSection = extractSection(phaseSection, "### External gates", /^### /mu);
if (gatesSection === undefined) {
  throw new Error(`Phase ${phase}'s section has no "### External gates" subsection.`);
}
const gateChecks = checkboxLines(gatesSection);
if (gateChecks.length === 0) {
  throw new Error(`Phase ${phase}'s External gates subsection lists no checklist items.`);
}
const falselyClaimedGates = gateChecks.filter((checked) => checked).length;
if (falselyClaimedGates > 0) {
  throw new Error(
    `Phase ${phase}'s External gates subsection marks ${falselyClaimedGates} item(s) done — Cloudflare deployment, ` +
      "Marymount OAuth, live Canvas calls, and human review must never be claimed by this repository.",
  );
}

const expectedCounts = [
  { label: "worker test files", count: manifest.worker.tests.length },
  { label: "UI contract test files?", count: manifest.ui.tests.length },
  { label: "browser test files", count: manifest.browser.tests.length },
];
for (const { label, count } of expectedCounts) {
  const pattern = new RegExp(`\\*\\*${count}\\*\\* ${label}`, "u");
  if (!pattern.test(phaseSection)) {
    throw new Error(
      `Phase ${phase}'s section does not quote "**${count}** ${label.replace("?", "")}" — ` +
        `test/test-membership.json now lists ${count}, but the doc has drifted from it.`,
    );
  }
}

console.log(`Phase ${phase}: all Evidence items checked, all External gates honestly unchecked, test counts match test-membership.json.`);
