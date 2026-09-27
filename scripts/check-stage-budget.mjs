#!/usr/bin/env node
/** Fail closed when project-local stage count or allocated bytes exceed the fixed pilot budget. */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MAX_STAGE_COUNT = 3;
export const MAX_STAGE_BYTES = 5 * 1024 * 1024 * 1024;

function allocatedSize(stats) {
  return Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size;
}

function inspectTree(root) {
  const pending = [root];
  let allocatedBytes = 0;
  let apparentBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      allocatedBytes += allocatedSize(stats);
      apparentBytes += stats.size;
      continue;
    }
    allocatedBytes += allocatedSize(stats);
    apparentBytes += stats.size;
    if (stats.isDirectory()) {
      for (const name of readdirSync(current)) pending.push(path.join(current, name));
    }
  }
  return { allocatedBytes, apparentBytes };
}

/** Measure real filesystem allocation where stat.blocks exists; otherwise use logical bytes. */
export function measureStageBudget({ stageDirectory = path.join(scriptRoot, ".stage"), maxStageCount = MAX_STAGE_COUNT, maxStageBytes = MAX_STAGE_BYTES } = {}) {
  const requestedStageDirectory = path.resolve(stageDirectory);
  const projectRoot = realpathSync(path.dirname(requestedStageDirectory));
  const canonicalStageDirectory = path.join(projectRoot, path.basename(requestedStageDirectory));
  const stageRoots = listOwnedRoots(canonicalStageDirectory, { excludedNames: new Set([".locks"]), label: ".stage" });
  const scratchDirectory = path.join(projectRoot, ".cache", "stage-tmp");
  const scratchRoots = listOwnedRoots(scratchDirectory, { label: ".cache/stage-tmp" });
  const stageBytes = measureRoots(stageRoots);
  const scratchBytes = measureRoots(scratchRoots);
  const stageCount = stageRoots.length;
  const scratchRootCount = scratchRoots.length;
  const rootCount = stageCount + scratchRootCount;
  const allocatedBytes = stageBytes.allocatedBytes + scratchBytes.allocatedBytes;
  const apparentBytes = stageBytes.apparentBytes + scratchBytes.apparentBytes;
  return {
    stageCount,
    scratchRootCount,
    rootCount,
    stageAllocatedBytes: stageBytes.allocatedBytes,
    scratchAllocatedBytes: scratchBytes.allocatedBytes,
    allocatedBytes,
    apparentBytes,
    maxStageCount,
    maxStageBytes,
  };
}

function listOwnedRoots(directory, { excludedNames = new Set(), label }) {
  let stats;
  try { stats = lstatSync(directory); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${label} budget path must be a real directory`);
  const canonicalDirectory = realpathSync(directory);
  if (canonicalDirectory !== directory) throw new Error(`${label} budget path changed during inspection`);
  const roots = [];
  for (const name of readdirSync(canonicalDirectory).filter((entry) => !excludedNames.has(entry))) {
    const root = path.join(canonicalDirectory, name);
    const rootStats = lstatSync(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error(`unexpected non-directory in ${label}: ${name}`);
    roots.push(root);
  }
  return roots;
}

function measureRoots(roots) {
  let allocatedBytes = 0;
  let apparentBytes = 0;
  for (const root of roots) {
    const size = inspectTree(root);
    allocatedBytes += size.allocatedBytes;
    apparentBytes += size.apparentBytes;
  }
  return { allocatedBytes, apparentBytes };
}

export function assertStageBudget(options = {}) {
  const budget = measureStageBudget(options);
  if (budget.rootCount > budget.maxStageCount || budget.allocatedBytes > budget.maxStageBytes) {
    throw new Error(`stage budget exceeded: ${budget.rootCount}/${budget.maxStageCount} stage and scratch roots, ${budget.allocatedBytes}/${budget.maxStageBytes} allocated bytes`);
  }
  return budget;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const budget = assertStageBudget();
    process.stdout.write(`stage budget: ${budget.rootCount}/${budget.maxStageCount} owned roots ` +
      `(${budget.stageCount} stage, ${budget.scratchRootCount} scratch), ${budget.allocatedBytes}/${budget.maxStageBytes} allocated bytes\n`);
  } catch (error) {
    process.stderr.write(`stage budget: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
