import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicPaths, root } from "./check-public-tree.mjs";

const checksumFile = path.join(root, "SHA256SUMS");
const mutablePaths = new Set([".gitignore"]);

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function readBaseline() {
  const text = await readFile(checksumFile, "utf8");
  const records = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`Invalid checksum record on line ${index + 1}.`);
    const [, expected, relativePath] = match;
    if (relativePath === "SHA256SUMS" || path.posix.isAbsolute(relativePath) || relativePath.includes("..")) {
      throw new Error(`Unsafe checksum path on line ${index + 1}.`);
    }
    if (records.has(relativePath)) throw new Error(`Duplicate checksum path: ${relativePath}.`);
    records.set(relativePath, expected);
  }
  return records;
}

async function currentRecords() {
  const records = new Map();
  for (const relativePath of publicPaths()) {
    if (relativePath === "SHA256SUMS") continue;
    records.set(relativePath, digest(await readFile(path.join(root, relativePath))));
  }
  return records;
}

export async function checksumDiff() {
  const [baseline, current] = await Promise.all([readBaseline(), currentRecords()]);
  const added = [];
  const removed = [];
  const changed = [];
  const mutable = [];

  for (const [relativePath, expected] of baseline) {
    if (!current.has(relativePath)) {
      (mutablePaths.has(relativePath) ? mutable : removed).push(relativePath);
    } else if (current.get(relativePath) !== expected) {
      (mutablePaths.has(relativePath) ? mutable : changed).push(relativePath);
    }
  }
  for (const relativePath of current.keys()) {
    if (!baseline.has(relativePath)) added.push(relativePath);
  }

  for (const values of [added, removed, changed, mutable]) values.sort();
  return { added, removed, changed, mutable };
}

function printDiff(diff) {
  console.log("Checksum path diff (non-writing):");
  for (const [label, values] of Object.entries(diff)) {
    console.log(`${label}: ${values.length ? values.join(", ") : "none"}`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const diff = await checksumDiff();
  printDiff(diff);
  if (process.argv.includes("--check") && (diff.added.length || diff.removed.length || diff.changed.length)) {
    throw new Error("Checksum path diff is not clean; run explicit npm run integrity:update after reviewing the declared files.");
  }
}
