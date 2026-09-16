import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mutableBootstrapPaths = new Set([".gitignore"]);
const checksumText = await readFile(path.join(root, "SHA256SUMS"), "utf8");
const failures = [];
let verified = 0;

for (const [lineNumber, line] of checksumText.split(/\r?\n/).entries()) {
  if (!line) continue;
  const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
  if (!match) {
    failures.push(`line ${lineNumber + 1}: invalid checksum record`);
    continue;
  }
  const [, expected, relativePath] = match;
  if (mutableBootstrapPaths.has(relativePath)) continue;
  try {
    const contents = await readFile(path.join(root, relativePath));
    const actual = createHash("sha256").update(contents).digest("hex");
    if (actual !== expected) failures.push(`${relativePath}: digest mismatch`);
    else verified += 1;
  } catch {
    failures.push(`${relativePath}: missing baseline file`);
  }
}

if (failures.length > 0) {
  throw new Error(`Baseline integrity failed: ${failures.join(", ")}.`);
}
console.log(`Baseline integrity passed for ${verified} immutable package files; .gitignore is Task 1.1 mutable scope.`);
