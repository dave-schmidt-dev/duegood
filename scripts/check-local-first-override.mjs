import { readFileSync } from "node:fs";

const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const exact = "For the current owner-authorized local replacement plan, work in this order: (1) qualify the isolated local executor, (2) capture the private legacy contract without exposing private data, (3) build the local coursework source and daily interface, and (4) rehearse a reversible cutover; OAuth and Cloudflare work are deferred.";
if (!agents.includes(exact)) throw new Error("The exact local-first owner override is missing.");

const retained = [
  "Never ask students to paste Canvas personal tokens.",
  "Keep credentials server-side.",
  "Bind all data access to the authenticated student and institution.",
  "An incomplete import cannot delete tasks or announce a fully successful refresh.",
  "Distinguish Canvas submission state from a student's completion checkbox.",
  "Do not put real coursework, grades, instructor messages, personal schedules",
  "No background synchronization claim without an actually implemented scheduler.",
  "Do not claim university approval, legal compliance, working OAuth, zero-cost capacity, or security certification without evidence.",
];
for (const statement of retained) {
  if (!agents.includes(statement)) throw new Error(`Non-ordering non-negotiable is missing: ${statement}`);
}
console.log("Local-first override and retained non-negotiables verified.");
