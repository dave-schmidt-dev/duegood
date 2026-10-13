import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanContent, scanPath } from "../../scripts/check-public-tree.mjs";
import { createOwnedScratchRoot } from "../../scripts/owned-scratch-root.mjs";
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

describe("check-public-tree.mjs docs/motifs allowance", () => {
  it("allows a motif PNG under the exact docs/motifs/ path", () => {
    expect(scanPath("docs/motifs/2026-10-12/frames/library-navigation-stacked-books-dark.png")).toBeNull();
  });

  it("still rejects an image under the adjacent docs/motifs-private/ prefix", () => {
    expect(scanPath("docs/motifs-private/2026-10-12/frames/icon.png")).toBe("image outside the synthetic browser snapshot directory");
  });

  it("still rejects images under other adjacent prefixes", () => {
    for (const candidate of ["docs/motifs2/icon.png", "notdocs/motifs/icon.png", "docs/motifs.png"]) {
      expect(scanPath(candidate)).toBe("image outside the synthetic browser snapshot directory");
    }
  });

  it("still rejects private content even when the path is permitted", () => {
    const privateKeyMarker = ["BEGIN", "PRIVATE", "KEY"].join(" ");
    const tokenName = ["CANVAS", "API", "TOKEN"].join("_");
    expect(scanPath("docs/motifs/2026-10-12/frames/library-navigation-stacked-books-dark.png")).toBeNull();
    expect(scanContent(privateKeyMarker)).toBe("explicit secret marker");
    expect(scanContent(`${tokenName} = "abcdef1234567890"`)).toBe("explicit secret marker");
  });
});

const SYNTHETIC_MOTIF_PATH = "docs/motifs/2026-10-12/synthetic-motif.png";
const SYNTHETIC_SENTINEL_BYTES = Buffer.from("synthetic-public-motif-sentinel-not-private-bytes\n", "utf8");
const SYNTHETIC_MOTIF_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const FIXTURE_GIT_ENVIRONMENT: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function syntheticCryptoPreloadSource(): string {
  return [
    '"use strict";',
    'const crypto = require("node:crypto");',
    'const { syncBuiltinESMExports } = require("node:module");',
    `const SYNTHETIC_SENTINEL = Buffer.from(${JSON.stringify(SYNTHETIC_SENTINEL_BYTES.toString("utf8"))}, "utf8");`,
    'const KNOWN_BLOCKED_HASH = "13485099d0cb205d4108f0de36b510059035b4bcae9f785b65e253c8d09b191a";',
    "const realCreateHash = crypto.createHash;",
    "crypto.createHash = function syntheticAwareCreateHash(algorithm, options) {",
    "  const hash = realCreateHash.call(this, algorithm, options);",
    '  if (String(algorithm).toLowerCase() !== "sha256") return hash;',
    "  const chunks = [];",
    "  const realUpdate = hash.update.bind(hash);",
    "  const realDigest = hash.digest.bind(hash);",
    "  hash.update = function syntheticAwareUpdate(data, encoding) {",
    '    chunks.push(typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data));',
    "    return realUpdate(data, encoding);",
    "  };",
    "  hash.digest = function syntheticAwareDigest(encoding) {",
    "    const bytes = Buffer.concat(chunks);",
    "    if (bytes.length === SYNTHETIC_SENTINEL.length && bytes.equals(SYNTHETIC_SENTINEL)) return KNOWN_BLOCKED_HASH;",
    "    return realDigest(encoding);",
    "  };",
    "  return hash;",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n");
}

function buildPublicTreeFixture(scratchRoot: string, motifBytes: Buffer): { fixtureRoot: string; preloadPath: string } {
  const fixtureRoot = path.join(scratchRoot, "fixture");
  const motifPath = path.join(fixtureRoot, ...SYNTHETIC_MOTIF_PATH.split("/"));
  mkdirSync(path.dirname(motifPath), { recursive: true });
  mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
  copyFileSync(path.join(ROOT, "scripts", "check-public-tree.mjs"), path.join(fixtureRoot, "scripts", "check-public-tree.mjs"));
  writeFileSync(motifPath, motifBytes);
  const preloadPath = path.join(fixtureRoot, "synthetic-crypto-preload.cjs");
  writeFileSync(preloadPath, syntheticCryptoPreloadSource());
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: fixtureRoot, env: FIXTURE_GIT_ENVIRONMENT, stdio: "pipe" });
  execFileSync("git", ["add", "--all"], { cwd: fixtureRoot, env: FIXTURE_GIT_ENVIRONMENT, stdio: "pipe" });
  return { fixtureRoot, preloadPath };
}

function runPublicTreeCli(fixture: { fixtureRoot: string; preloadPath: string }) {
  return spawnSync(process.execPath, ["--require", fixture.preloadPath, "scripts/check-public-tree.mjs"], {
    cwd: fixture.fixtureRoot,
    encoding: "utf8",
    env: FIXTURE_GIT_ENVIRONMENT,
    timeout: 30_000,
  });
}

describe("check-public-tree.mjs CLI content scanning", () => {
  const temporaryRoots: Array<ReturnType<typeof createOwnedScratchRoot>> = [];

  afterEach(() => {
    for (const scratch of temporaryRoots.splice(0)) scratch.cleanup();
  });

  function buildFixture(motifBytes: Buffer): { fixtureRoot: string; preloadPath: string } {
    const scratch = createOwnedScratchRoot("public-tree-cli");
    temporaryRoots.push(scratch);
    return buildPublicTreeFixture(scratch.root, motifBytes);
  }

  it("rejects a known blocked reference digest under the allowed docs/motifs/ path", () => {
    const fixture = buildFixture(SYNTHETIC_SENTINEL_BYTES);
    expect(scanPath(SYNTHETIC_MOTIF_PATH)).toBeNull();
    const result = runPublicTreeCli(fixture);
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(SYNTHETIC_MOTIF_PATH);
    expect(output).toContain("supplied design reference image");
  });

  it("passes a positive synthetic motif PNG through the same CLI", () => {
    const fixture = buildFixture(SYNTHETIC_MOTIF_PNG);
    const result = runPublicTreeCli(fixture);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Public-tree check passed");
  });
});
