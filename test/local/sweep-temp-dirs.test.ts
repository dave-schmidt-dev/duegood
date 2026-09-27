import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSweepAuthorized, MIN_AGE_MS, parseLsofResult, parseSweepArgs, sweepTempDirs } from "../../scripts/sweep-temp-dirs.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type SweepTestOptions = {
  tmpDir?: string;
  tmpDirs?: string[];
  apply?: boolean;
  now?: number;
  listHeldPaths?: () => string[] | null;
  log?: (message: string) => void;
};

function runSweep(options: SweepTestOptions) {
  return sweepTempDirs(options as never);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "duegood-sweep-spec-"));
  roots.push(root);
  return realpathSync(root);
}

function oldRoot(parent: string, name: string, now: number): string {
  const root = join(parent, name);
  mkdirSync(root);
  const file = join(root, "payload");
  writeFileSync(file, "synthetic");
  const old = new Date(now - MIN_AGE_MS - 60_000);
  utimesSync(file, old, old);
  utimesSync(root, old, old);
  return root;
}

describe("Due Good temp backlog collector", () => {
  it("dry-runs only old direct-child stage and smoke roots without removing them", () => {
    const parent = fixture();
    const now = Date.now();
    const stage = oldRoot(parent, "duegood-tauri-stage-old", now);
    const smoke = oldRoot(parent, "duegood-tauri-ui-smoke-old", now);
    oldRoot(parent, "unrelated-old", now);
    mkdirSync(join(parent, "duegood-tauri-stage-fresh"));
    const result = runSweep({ tmpDir: parent, now, listHeldPaths: () => [], log: () => {} });
    expect(result.status).toBe(0);
    expect(result.summary).toMatchObject({ candidates: 3, eligible: 2, removed: 0, skippedFresh: 1 });
    expect(result.summary.apparentBytes).toBeGreaterThan(0);
    expect(realpathSync(stage)).toBe(stage);
    expect(realpathSync(smoke)).toBe(smoke);
  });

  it("scans both temp roots for every duegood-* root, including former cache names", () => {
    const first = fixture();
    const second = fixture();
    const now = Date.now();
    oldRoot(first, "duegood-phase4-old", now);
    oldRoot(second, "duegood-ical-stage-old", now);
    oldRoot(first, "duegood-uv-cache", now);
    oldRoot(second, "duegood-harvest-uv-cache", now);
    const result = runSweep({ tmpDirs: [first, second], now, listHeldPaths: () => [], log: () => {} });
    expect(result.status).toBe(0);
    expect(result.summary).toMatchObject({ roots: 2, candidates: 4, eligible: 4, excludedCaches: 0, removed: 0 });
    expect(result.summary.allocatedBytes).toBeGreaterThan(0);
  });

  it("applies only to eligible synthetic roots and preserves unrelated, fresh, and held roots", () => {
    const parent = fixture();
    const now = Date.now();
    const eligible = oldRoot(parent, "duegood-tauri-stage-eligible", now);
    const held = oldRoot(parent, "duegood-tauri-ui-smoke-held", now);
    const fresh = join(parent, "duegood-tauri-stage-fresh");
    mkdirSync(fresh);
    const unrelated = oldRoot(parent, "unrelated-old", now);

    const result = runSweep({
      tmpDir: parent,
      apply: true,
      now,
      listHeldPaths: () => [join(held, "payload")],
      log: () => {},
    });

    expect(result.status).toBe(0);
    expect(result.summary).toMatchObject({
      candidates: 3,
      eligible: 1,
      removed: 1,
      skippedFresh: 1,
      skippedHeld: 1,
      failed: 0,
      refused: 0,
    });
    expect(existsSync(eligible)).toBe(false);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("skips held canonical paths and symlink roots", () => {
    const parent = fixture();
    const now = Date.now();
    const stage = oldRoot(parent, "duegood-tauri-stage-held", now);
    const outside = fixture();
    symlinkSync(outside, join(parent, "duegood-tauri-stage-link"));
    const alias = join(parent, "alias");
    symlinkSync(stage, alias);
    const result = runSweep({ tmpDir: parent, now, listHeldPaths: () => [join(alias, "payload")], log: () => {} });
    expect(result.summary).toMatchObject({ candidates: 2, eligible: 0, skippedHeld: 1, skippedSymlink: 1 });
    expect(isSweepAuthorized(outside, parent)).toBe(false);
  });

  it("keeps an old root when a nested file changed within 24 hours", () => {
    const parent = fixture();
    const now = Date.now();
    const stage = oldRoot(parent, "duegood-tauri-stage-recent-file", now);
    writeFileSync(join(stage, "recent"), "synthetic");
    const result = runSweep({ tmpDir: parent, now, listHeldPaths: () => [], log: () => {} });
    expect(result.summary).toMatchObject({ candidates: 1, eligible: 0, skippedFresh: 1 });
  });

  it("refuses even a dry run when lsof fails or reports incomplete output", () => {
    const parent = fixture();
    oldRoot(parent, "duegood-tauri-stage-old", Date.now());
    const result = runSweep({ tmpDir: parent, listHeldPaths: () => null, log: () => {} });
    expect(result.status).toBe(1);
    expect(result.summary.eligible).toBe(0);
    expect(parseLsofResult({ status: 1, stdout: "p1\nn/private/tmp/held\n" })).toBeNull();
    expect(parseLsofResult({ status: 0, stdout: "p1\n", stderr: "WARNING: incomplete" })).toBeNull();
    expect(parseLsofResult({ status: 0, stdout: "p1\nn/private/tmp/held\n", stderr: "" })).toEqual(["/private/tmp/held"]);
  });

  it("rechecks lsof before apply and preserves roots when the second snapshot fails", () => {
    const parent = fixture();
    const now = Date.now();
    const candidate = oldRoot(parent, "duegood-phase4-apply", now);
    let calls = 0;
    const result = runSweep({
      tmpDir: parent, apply: true, now,
      listHeldPaths: () => (++calls === 1 ? [] : null), log: () => {},
    });
    expect(result.status).toBe(1);
    expect(calls).toBe(2);
    expect(existsSync(candidate)).toBe(true);
    expect(result.summary.removed).toBe(0);
  });

  it("accepts only the explicit apply flag", () => {
    expect(parseSweepArgs([])).toEqual({ apply: false });
    expect(parseSweepArgs(["--apply"])).toEqual({ apply: true });
    expect(parseSweepArgs(["--apply", "--anything"])).toHaveProperty("error");
  });
});
