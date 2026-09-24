import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanPath } from "../../scripts/check-public-tree.mjs";
import { checkPlanAbsences, checklistItems, validateDesktopPhase1Section } from "../../scripts/check-desktop-status.mjs";

const ROOT = path.resolve(__dirname, "..", "..");

const PASSING_STATUS_DOC = `# Status

## Phase 1 — OAuth and Cloudflare foundation

### Evidence (local only)

- [x] Task 1.1 — something.

## Desktop Phase 1

### Evidence

- [x] Task 1.0 — Establish the pipeline.
      Evidence: \`npm run check:desktop-status\` exits 0.
- [ ] Task 1.1 — Add \`src-tauri/\`.
`;

const PASSING_PLAN_DOC = `# Plan

## Phase 7 — Tauri desktop application (single authority)

Some description with no banned phrases.

## Red boundaries

- Replacing the private launcher, except inside this plan's attended Phase 7 cutover authorized by the owner on 2026-09-22.
- Commit, push, deployment, or publication.

## Completion boundary

Done.
`;

describe("validateDesktopPhase1Section", () => {
  it("passes a well-formed section with named evidence on checked items", () => {
    expect(validateDesktopPhase1Section(PASSING_STATUS_DOC)).toEqual([]);
  });

  it("fails when the section is missing", () => {
    expect(validateDesktopPhase1Section("# Status\n\n## Phase 1 — x\n")).toEqual([
      'docs/IMPLEMENTATION-STATUS.md has no "## Desktop Phase 1" section.',
    ]);
  });

  it("fails a checked item that names no concrete evidence", () => {
    const doc = PASSING_STATUS_DOC.replace(
      "- [x] Task 1.0 — Establish the pipeline.\n      Evidence: `npm run check:desktop-status` exits 0.",
      "- [x] Task 1.0 — Establish the pipeline with no backtick evidence at all.",
    );
    const errors = validateDesktopPhase1Section(doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/does not name evidence/);
  });

  it("allows an unchecked item with no evidence", () => {
    const doc = PASSING_STATUS_DOC.replace("- [ ] Task 1.1 — Add `src-tauri/`.", "- [ ] Task 1.1 — Add src-tauri.");
    expect(validateDesktopPhase1Section(doc)).toEqual([]);
  });

  it("joins indented continuation lines onto the checklist item that introduced them", () => {
    const items = checklistItems("- [x] Task 1.0 — first line\n      second line with `evidence`.\n- [ ] Task 1.1 — other\n");
    expect(items).toEqual([
      { checked: true, label: "Task 1.0 — first line second line with `evidence`." },
      { checked: false, label: "Task 1.1 — other" },
    ]);
  });
});

describe("checkPlanAbsences", () => {
  it("passes a plan document with none of the retired phrases and a scoped launcher bullet", () => {
    expect(checkPlanAbsences(PASSING_PLAN_DOC)).toEqual([]);
  });

  it("rejects each retired phrase", () => {
    for (const banned of ["reopens the saved source path", "saved source path", "share a runtime exclusion"]) {
      const doc = `${PASSING_PLAN_DOC}\n\nStray text that ${banned} somewhere.\n`;
      const errors = checkPlanAbsences(doc);
      expect(errors.some((error) => error.includes(banned))).toBe(true);
    }
  });

  it("rejects an unscoped 'Replacing the private launcher.' bullet", () => {
    const doc = PASSING_PLAN_DOC.replace(
      "- Replacing the private launcher, except inside this plan's attended Phase 7 cutover authorized by the owner on 2026-09-22.",
      "- Replacing the private launcher.",
    );
    const errors = checkPlanAbsences(doc);
    expect(errors.some((error) => error.includes("unscoped"))).toBe(true);
  });
});

describe("the repository's real documents", () => {
  it("pass the desktop status check", () => {
    const statusDoc = readFileSync(path.join(ROOT, "docs", "IMPLEMENTATION-STATUS.md"), "utf8");
    const planDoc = readFileSync(path.join(ROOT, "docs", "IMPLEMENTATION-PLAN.md"), "utf8");
    expect([...validateDesktopPhase1Section(statusDoc), ...checkPlanAbsences(planDoc)]).toEqual([]);
  });
});

describe("check-public-tree.mjs src-tauri/icons allowance", () => {
  it("allows PNG images under src-tauri/icons/", () => {
    expect(scanPath("src-tauri/icons/icon.png")).toBeNull();
  });

  it("still rejects a PNG outside the allowed roots", () => {
    expect(scanPath("random/icon.png")).toBe("image outside the synthetic browser snapshot directory");
  });
});
