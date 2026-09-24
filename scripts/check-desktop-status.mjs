import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Slice `doc` from the first line-start match of `heading` to (but excluding) the next
 * line-start match of `terminator`, or the end of the document if there is none. */
export function extractSection(doc, heading, terminator) {
  const headingPattern = new RegExp(`^${heading}$`, "mu");
  const headingMatch = headingPattern.exec(doc);
  if (headingMatch === null) return undefined;
  const rest = doc.slice(headingMatch.index + headingMatch[0].length);
  const terminatorMatch = terminator.exec(rest);
  return terminatorMatch ? rest.slice(0, terminatorMatch.index) : rest;
}

/** Parse `- [ ]`/`- [x]` checklist items, joining indented continuation lines onto the
 * item that introduced them so multi-line evidence prose stays attached to its checkbox. */
export function checklistItems(section) {
  const items = [];
  for (const line of section.split("\n")) {
    const checkboxMatch = /^- \[([ x])\](?: (.*))?$/u.exec(line);
    if (checkboxMatch !== null) {
      items.push({ checked: checkboxMatch[1] === "x", label: (checkboxMatch[2] ?? "").trim() });
      continue;
    }
    const continuationMatch = /^\s+(\S.*)$/u.exec(line);
    if (continuationMatch !== null && items.length > 0) {
      const last = items[items.length - 1];
      last.label = `${last.label} ${continuationMatch[1].trim()}`.trim();
    }
  }
  return items;
}

/** A checked item must name concrete evidence — at least one backtick-quoted file, command, or
 * receipt reference — rather than an unverifiable prose claim. */
function namesEvidence(label) {
  return /`[^`]+`/u.test(label);
}

export function validateDesktopPhase1Section(statusDoc) {
  const errors = [];
  const section = extractSection(statusDoc, "## Desktop Phase 1", /^## /mu);
  if (section === undefined) {
    return ["docs/IMPLEMENTATION-STATUS.md has no \"## Desktop Phase 1\" section."];
  }
  const evidenceSection = extractSection(section, "### Evidence", /^### /mu);
  if (evidenceSection === undefined) {
    return ["\"## Desktop Phase 1\" has no \"### Evidence\" subsection."];
  }
  const items = checklistItems(evidenceSection);
  if (items.length === 0) {
    errors.push("\"## Desktop Phase 1\"'s Evidence subsection lists no checklist items.");
  }
  for (const item of items) {
    if (item.label.length === 0) {
      errors.push("\"## Desktop Phase 1\" has a checklist item with no label.");
      continue;
    }
    if (item.checked && !namesEvidence(item.label)) {
      errors.push(`"## Desktop Phase 1" checked item does not name evidence: ${item.label.slice(0, 80)}`);
    }
  }
  return errors;
}

const BANNED_PLAN_SUBSTRINGS = ["reopens the saved source path", "saved source path", "share a runtime exclusion"];
const UNSCOPED_LAUNCHER_BULLET = "- Replacing the private launcher.";

export function checkPlanAbsences(planDoc) {
  const errors = [];
  for (const banned of BANNED_PLAN_SUBSTRINGS) {
    if (planDoc.includes(banned)) {
      errors.push(`docs/IMPLEMENTATION-PLAN.md still contains the retired phrase "${banned}".`);
    }
  }
  const redSection = extractSection(planDoc, "## Red boundaries", /^## /mu);
  if (redSection === undefined) {
    errors.push("docs/IMPLEMENTATION-PLAN.md has no \"## Red boundaries\" section.");
  } else {
    const hasUnscopedBullet = redSection.split("\n").some((line) => line.trim() === UNSCOPED_LAUNCHER_BULLET);
    if (hasUnscopedBullet) {
      errors.push("\"## Red boundaries\" still contains an unscoped \"Replacing the private launcher.\" bullet.");
    }
  }
  return errors;
}

function main() {
  const statusDoc = readFileSync(path.join(root, "docs", "IMPLEMENTATION-STATUS.md"), "utf8");
  const planDoc = readFileSync(path.join(root, "docs", "IMPLEMENTATION-PLAN.md"), "utf8");
  const errors = [...validateDesktopPhase1Section(statusDoc), ...checkPlanAbsences(planDoc)];
  if (errors.length > 0) {
    throw new Error(`Desktop status check failed:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  console.log("Desktop status check passed: \"## Desktop Phase 1\" evidence is well formed and the Phase 7 plan absence checks hold.");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
