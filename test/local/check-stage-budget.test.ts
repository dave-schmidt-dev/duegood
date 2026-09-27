import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertStageBudget, measureStageBudget } from "../../scripts/check-stage-budget.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function projectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "duegood-stage-budget-"));
  roots.push(root);
  return root;
}

describe("project stage budget", () => {
  it("counts only stage roots and measures allocated bytes without traversing lock or Cargo cache", () => {
    const project = projectRoot();
    const directory = path.join(project, ".stage");
    const scratch = path.join(project, ".cache", "stage-tmp");
    const cargo = path.join(project, ".cache", "cargo-target");
    mkdirSync(path.join(directory, ".locks"), { recursive: true });
    mkdirSync(path.join(directory, "tauri"));
    mkdirSync(path.join(scratch, "tauri"), { recursive: true });
    mkdirSync(cargo, { recursive: true });
    writeFileSync(path.join(directory, "tauri", "payload"), "synthetic allocation");
    writeFileSync(path.join(scratch, "tauri", "payload"), "scratch allocation");
    writeFileSync(path.join(cargo, "large-shared-cache"), Buffer.alloc(4 * 1024 * 1024));
    const budget = measureStageBudget({ stageDirectory: directory });
    expect(budget.stageCount).toBe(1);
    expect(budget.scratchRootCount).toBe(1);
    expect(budget.rootCount).toBe(2);
    expect(budget.allocatedBytes).toBeGreaterThan(0);
    expect(budget.allocatedBytes).toBeLessThan(4 * 1024 * 1024);
    expect(assertStageBudget({ stageDirectory: directory, maxStageCount: 2, maxStageBytes: 128 * 1024 })).toMatchObject({ rootCount: 2 });
    expect(() => assertStageBudget({ stageDirectory: directory, maxStageCount: 1 })).toThrow(/stage and scratch roots/);
  });

  it("fails when a scratch root exceeds the allocated-byte cap", () => {
    const project = projectRoot();
    const directory = path.join(project, ".stage");
    const scratch = path.join(project, ".cache", "stage-tmp", "tauri");
    mkdirSync(directory, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, "oversized"), Buffer.alloc(1024 * 1024));
    const budget = measureStageBudget({ stageDirectory: directory });
    expect(budget.scratchRootCount).toBe(1);
    expect(budget.scratchAllocatedBytes).toBeGreaterThan(0);
    expect(() => assertStageBudget({ stageDirectory: directory, maxStageBytes: 4096 })).toThrow(/stage budget exceeded/);
  });
});
