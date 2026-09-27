#!/usr/bin/env node
/** Report or remove stale, unheld direct-child Due Good roots from approved temp locations. */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIN_AGE_MS = 24 * 60 * 60 * 1_000;

function matchesName(name) {
  return name.startsWith("duegood-") && name.length > "duegood-".length;
}

function allocatedSize(stats) {
  return Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size;
}

export function parseLsofResult(result) {
  if (result.error || result.status !== 0 || typeof result.stdout !== "string" || result.stdout.length === 0) return null;
  if (/warning|incomplete/i.test(String(result.stderr ?? ""))) return null;
  return result.stdout.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
}

export function listHeldPathsViaLsof() {
  return parseLsofResult(spawnSync("lsof", ["-Fn"], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
  }));
}

/** Return newest write time and both logical and allocated bytes; symlinks are never followed. */
export function inspectTree(root, onProgress = () => {}) {
  let newestMs = 0;
  let apparentBytes = 0;
  let allocatedBytes = 0;
  let scanned = 0;
  let lastProgress = Date.now();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let stats;
    try { stats = lstatSync(current); } catch { return null; }
    newestMs = Math.max(newestMs, stats.mtimeMs);
    apparentBytes += stats.size;
    allocatedBytes += allocatedSize(stats);
    scanned += 1;
    if (Date.now() - lastProgress >= 5_000) {
      onProgress(scanned);
      lastProgress = Date.now();
    }
    if (!stats.isDirectory()) continue;
    let children;
    try { children = readdirSync(current); } catch { return null; }
    for (const child of children) pending.push(join(current, child));
  }
  return { newestMs, apparentBytes, allocatedBytes, scanned };
}

/** The final authorization check uses canonical paths and direct-child containment. */
export function isSweepAuthorized(candidate, canonicalTmp) {
  return dirname(candidate) === canonicalTmp && matchesName(basename(candidate));
}

function canonicalHeldPaths(paths) {
  return paths.map((open) => {
    try { return realpathSync(open); } catch { return open; }
  });
}

function isHeld(candidate, held) {
  return held.some((open) => open === candidate || open.startsWith(`${candidate}/`));
}

function resolveRoots({ tmpDir, tmpDirs }) {
  if (tmpDirs) return { paths: tmpDirs, allowMissing: false };
  if (tmpDir) return { paths: [tmpDir], allowMissing: false };
  return { paths: [...new Set([tmpdir(), "/private/tmp"])], allowMissing: true };
}

export function sweepTempDirs({
  tmpDir, tmpDirs, apply = false, now = Date.now(),
  listHeldPaths = listHeldPathsViaLsof, log = console.log,
} = {}) {
  const summary = { roots: 0, candidates: 0, eligible: 0, removed: 0, apparentBytes: 0, allocatedBytes: 0,
    excludedCaches: 0, skippedFresh: 0, skippedHeld: 0, skippedSymlink: 0, skippedUnreadable: 0, refused: 0, failed: 0 };
  const configured = resolveRoots({ tmpDir, tmpDirs });
  const canonicalRoots = [];
  for (const root of configured.paths) {
    if (configured.allowMissing && !existsSync(root)) continue;
    try { canonicalRoots.push(realpathSync(root)); } catch {
      log(`sweep: cannot resolve temp directory ${root}`);
      return { status: 1, summary };
    }
  }
  const uniqueRoots = [...new Set(canonicalRoots)];
  if (uniqueRoots.length === 0) return { status: 0, summary };
  summary.roots = uniqueRoots.length;

  log(`sweep: checking open paths with lsof across ${uniqueRoots.length} temp root(s)`);
  let held = listHeldPaths();
  if (held === null) {
    log("sweep: lsof failed or returned incomplete results; refusing to sweep");
    return { status: 1, summary };
  }
  held = canonicalHeldPaths(held);
  const cutoffMs = now - MIN_AGE_MS;
  const removals = [];

  for (const canonicalTmp of uniqueRoots) {
    let names;
    try { names = readdirSync(canonicalTmp).filter(matchesName).sort(); } catch {
      log(`sweep: cannot list temp directory ${canonicalTmp}`);
      return { status: 1, summary };
    }
    summary.candidates += names.length;
    for (const name of names) {
      log(`sweep: inspecting ${name} under ${canonicalTmp}`);
      const candidate = join(canonicalTmp, name);
      let stats;
      try { stats = lstatSync(candidate); } catch { summary.skippedUnreadable += 1; continue; }
      if (stats.isSymbolicLink() || !stats.isDirectory()) { summary.skippedSymlink += 1; continue; }
      if (stats.mtimeMs > cutoffMs) { summary.skippedFresh += 1; continue; }
      let canonicalCandidate;
      try { canonicalCandidate = realpathSync(candidate); } catch { summary.skippedUnreadable += 1; continue; }
      if (!isSweepAuthorized(canonicalCandidate, canonicalTmp)) { summary.refused += 1; continue; }
      if (isHeld(canonicalCandidate, held)) { summary.skippedHeld += 1; continue; }
      const tree = inspectTree(canonicalCandidate, (scanned) => log(`sweep: ${name} scanned ${scanned} entries`));
      if (tree === null) { summary.skippedUnreadable += 1; continue; }
      if (tree.newestMs > cutoffMs) { summary.skippedFresh += 1; continue; }
      summary.eligible += 1;
      summary.apparentBytes += tree.apparentBytes;
      summary.allocatedBytes += tree.allocatedBytes;
      if (!apply) continue;

      removals.push({ candidate, canonicalCandidate, canonicalTmp, name });
    }
  }

  if (apply && removals.length > 0) {
    log(`sweep: rechecking open paths before removing ${removals.length} eligible root(s)`);
    held = listHeldPaths();
    if (held === null) {
      log("sweep: lsof failed or returned incomplete results; refusing removals");
      return { status: 1, summary };
    }
    held = canonicalHeldPaths(held);
    for (const [index, { candidate, canonicalCandidate, canonicalTmp, name }] of removals.entries()) {
      const report = (result) => log(`sweep: ${index + 1}/${removals.length} ${result} ${name}`);
      try {
        const latest = lstatSync(candidate);
        if (latest.isSymbolicLink() || !latest.isDirectory() || realpathSync(candidate) !== canonicalCandidate ||
            !isSweepAuthorized(canonicalCandidate, canonicalTmp)) {
          summary.refused += 1;
          report("skipped (path changed)");
          continue;
        }
        if (isHeld(canonicalCandidate, held)) {
          summary.skippedHeld += 1;
          report("skipped (open handle)");
          continue;
        }
        const latestTree = inspectTree(canonicalCandidate, (scanned) => log(`sweep: rechecked ${name} scanned ${scanned} entries`));
        if (latestTree === null) {
          summary.skippedUnreadable += 1;
          report("skipped (unreadable)");
          continue;
        }
        if (latestTree.newestMs > cutoffMs) {
          summary.skippedFresh += 1;
          report("skipped (recently modified)");
          continue;
        }
        rmSync(canonicalCandidate, { recursive: true, force: true });
        summary.removed += 1;
        report("removed");
      } catch {
        summary.failed += 1;
        report("failed");
      }
    }
  }
  log(`sweep ${apply ? "applied" : "dry-run"}: roots=${summary.roots} candidates=${summary.candidates} eligible=${summary.eligible} ` +
    `apparentBytes=${summary.apparentBytes} allocatedBytes=${summary.allocatedBytes} removed=${summary.removed} held=${summary.skippedHeld} ` +
    `fresh=${summary.skippedFresh} symlink=${summary.skippedSymlink} unreadable=${summary.skippedUnreadable} refused=${summary.refused} failed=${summary.failed}`);
  return { status: summary.failed > 0 || summary.refused > 0 ? 1 : 0, summary };
}

export function parseSweepArgs(args) {
  if (args.length === 0) return { apply: false };
  if (args.length === 1 && args[0] === "--apply") return { apply: true };
  return { error: "usage: npm run sweep:temp [-- --apply]" };
}

if (process.argv[1] && (resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url)) {
  const args = parseSweepArgs(process.argv.slice(2));
  if ("error" in args) { console.error(args.error); process.exitCode = 2; }
  else process.exitCode = sweepTempDirs(args).status;
}
