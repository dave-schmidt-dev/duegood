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
  return section.split("\n").filter((line) => line.startsWith("- [")).map((line) => {
    const match = /^- \[([ x])\](?: (.*))?$/u.exec(line);
    if (match === null) throw new Error(`Malformed checklist line: ${line}`);
    return { checked: match[1] === "x", label: match[2] ?? "" };
  });
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
const uncheckedEvidence = evidenceChecks.filter(({ checked }) => !checked).length;
if (uncheckedEvidence > 0) {
  throw new Error(`Phase ${phase}'s Evidence subsection has ${uncheckedEvidence} unfinished item(s) — not done yet.`);
}

const historicalSection = extractSection(phaseSection, "### Verified historical external evidence", /^### /mu);
if (historicalSection === undefined) {
  throw new Error(`Phase ${phase}'s section has no "### Verified historical external evidence" subsection.`);
}
const expectedEvidenceRows = [
  "| Repository Canvas tests | Synthetic only; mocked `fetchImpl` calls do not establish live Canvas access. |",
  "| Owner-local Canvas integration | Local read-only operation is documented in `README.md`; Inbox and profile approval and activation are recorded there, while live outcomes remain private external evidence that this repository cannot independently verify. |",
  "| Production D1 configuration | A production database binding is present in `wrangler.jsonc`; the repository does not independently prove live provisioning or deployment. |",
  "| Public Worker deployment | Not established; the public Worker remains offline. |",
  "| Public Canvas OAuth | Not established; institution approval remains outstanding. |",
];
for (const evidenceRow of expectedEvidenceRows) {
  if (!historicalSection.includes(evidenceRow)) {
    throw new Error(
      `Phase ${phase}'s historical evidence table is missing or has changed a required evidence state.`,
    );
  }
}

const gatesSection = extractSection(phaseSection, "### Remaining external gates", /^### /mu);
if (gatesSection === undefined) {
  throw new Error(`Phase ${phase}'s section has no "### Remaining external gates" subsection.`);
}
const gateChecks = checkboxLines(gatesSection);
const expectedGates = [
  { label: "Public Worker activation/deployment", pattern: /Public Worker activation\/deployment/u },
  { label: "Marymount Canvas OAuth developer-key approval", pattern: /Marymount Canvas OAuth developer-key approval/u },
  { label: "Human screen-reader review and nontechnical-student pilot", pattern: /Human screen-reader review and nontechnical-student pilot/u },
];
if (gateChecks.length !== expectedGates.length) {
  throw new Error(
    `Phase ${phase}'s remaining-gates checklist has ${gateChecks.length} item(s); expected ${expectedGates.length}.`,
  );
}
for (const expectedGate of expectedGates) {
  const matches = gateChecks.filter(({ label }) => expectedGate.pattern.test(label));
  if (matches.length !== 1 || matches[0]?.checked) {
    throw new Error(
      `Phase ${phase}'s remaining gates must contain exactly one unchecked ${expectedGate.label} item.`,
    );
  }
}
if (!gatesSection.includes("Repository suites remain synthetic")) {
  throw new Error(
    `Phase ${phase}'s remaining external gates must state that repository suites remain synthetic.`,
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

console.log(`Phase ${phase}: Evidence items checked, historical evidence is linked, external gates remain open, and test counts match test-membership.json.`);
