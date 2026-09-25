#!/usr/bin/env node
/** Report or remove stale Due Good staging roots directly under the system temp folder. */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PREFIXES = Object.freeze(["duegood-tauri-stage-", "duegood-tauri-ui-smoke-"]);
export const MIN_AGE_MS = 2 * 60 * 60 * 1_000;

function matchesName(name) {
  return PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
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

/** Return the newest write time and apparent size; symlinks are counted, never followed. */
export function inspectTree(root, onProgress = () => {}) {
  let newestMs = 0;
  let bytes = 0;
  let scanned = 0;
  let lastProgress = Date.now();
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop();
    let stat;
    try { stat = lstatSync(path); } catch { return null; }
    newestMs = Math.max(newestMs, stat.mtimeMs);
    bytes += stat.size;
    scanned += 1;
    if (Date.now() - lastProgress >= 5_000) {
      onProgress(scanned);
      lastProgress = Date.now();
    }
    if (!stat.isDirectory()) continue;
    let children;
    try { children = readdirSync(path); } catch { return null; }
    for (const child of children) pending.push(join(path, child));
  }
  return { newestMs, bytes };
}

/** The final authorization check uses canonical paths, not the spelling from readdir. */
export function isSweepAuthorized(candidate, canonicalTmp) {
  return dirname(candidate) === canonicalTmp && matchesName(basename(candidate));
}

export function sweepTempDirs({
  tmpDir = tmpdir(), apply = false, now = Date.now(),
  listHeldPaths = listHeldPathsViaLsof, log = console.log,
} = {}) {
  const summary = { candidates: 0, eligible: 0, removed: 0, apparentBytes: 0,
    skippedFresh: 0, skippedHeld: 0, skippedSymlink: 0, skippedUnreadable: 0, refused: 0, failed: 0 };
  let canonicalTmp;
  try { canonicalTmp = realpathSync(tmpDir); } catch {
    log("sweep: cannot resolve temp directory");
    return { status: 1, summary };
  }
  log("sweep: checking open paths with lsof");
  const held = listHeldPaths();
  if (held === null) {
    log("sweep: lsof failed or returned incomplete results; refusing to sweep");
    return { status: 1, summary };
  }
  const canonicalHeld = held.map((open) => {
    try { return realpathSync(open); } catch { return open; }
  });
  let names;
  try { names = readdirSync(canonicalTmp).filter(matchesName).sort(); } catch {
    log("sweep: cannot list temp directory");
    return { status: 1, summary };
  }
  summary.candidates = names.length;
  const cutoffMs = now - MIN_AGE_MS;
  for (const [index, name] of names.entries()) {
    log(`sweep: inspecting ${index + 1}/${names.length} ${name}`);
    const path = join(canonicalTmp, name);
    let stat;
    try { stat = lstatSync(path); } catch { summary.skippedUnreadable += 1; continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) { summary.skippedSymlink += 1; continue; }
    if (stat.mtimeMs > cutoffMs) { summary.skippedFresh += 1; continue; }
    let canonicalPath;
    try { canonicalPath = realpathSync(path); } catch { summary.skippedUnreadable += 1; continue; }
    if (!isSweepAuthorized(canonicalPath, canonicalTmp)) { summary.refused += 1; continue; }
    if (canonicalHeld.some((open) => open === canonicalPath || open.startsWith(`${canonicalPath}/`))) {
      summary.skippedHeld += 1;
      continue;
    }
    const tree = inspectTree(canonicalPath, (scanned) => log(`sweep: ${name} scanned ${scanned} entries`));
    if (tree === null) { summary.skippedUnreadable += 1; continue; }
    if (tree.newestMs > cutoffMs) { summary.skippedFresh += 1; continue; }
    summary.eligible += 1;
    summary.apparentBytes += tree.bytes;
    if (!apply) continue;
    // A replacement symlink or moved directory must never turn a collected name into a target.
    try {
      if (!lstatSync(path).isDirectory() || realpathSync(path) !== canonicalPath || !isSweepAuthorized(canonicalPath, canonicalTmp)) {
        summary.refused += 1;
        continue;
      }
      rmSync(canonicalPath, { recursive: true, force: true });
      summary.removed += 1;
    } catch { summary.failed += 1; }
  }
  log(`sweep ${apply ? "applied" : "dry-run"}: candidates=${summary.candidates} eligible=${summary.eligible} ` +
    `apparentBytes=${summary.apparentBytes} removed=${summary.removed} held=${summary.skippedHeld} ` +
    `fresh=${summary.skippedFresh} symlink=${summary.skippedSymlink} ` +
    `unreadable=${summary.skippedUnreadable} refused=${summary.refused} failed=${summary.failed}`);
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
