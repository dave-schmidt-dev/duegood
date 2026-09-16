import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bannedNames = new Set([
  "courses.json",
  "coursework.json",
  "coursework-refresh-history.json",
  "coursework.sh",
]);
const bannedExtensions = new Set([".pem", ".key", ".db", ".sqlite", ".sqlite3"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const allowedImageRoot = "test/browser/__screenshots__/";
const privateReferenceHashes = new Map([
  ["13485099d0cb205d4108f0de36b510059035b4bcae9f785b65e253c8d09b191a", "supplied design reference image"],
  ["248255d61f8219484333a86261e23780bba1ae87e7ac5db51a947fbe481689e8", "supplied design reference image"],
]);

export function scanPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (bannedNames.has(path.posix.basename(normalized))) {
    return "private source filename";
  }
  if (bannedExtensions.has(path.posix.extname(normalized).toLowerCase())) {
    return "credential or database extension";
  }
  if (imageExtensions.has(path.posix.extname(normalized).toLowerCase()) && !normalized.startsWith(allowedImageRoot)) {
    return "image outside the synthetic browser snapshot directory";
  }
  if (/^\.(?:adjudicator|contrarian|domain-specialist|fresh-eyes)-/.test(normalized)) {
    return "local review prompt";
  }
  if (normalized.startsWith(".evidence/") || normalized.startsWith(".logs/")) {
    return "local evidence or log path";
  }
  return null;
}

export function scanContent(contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (privateReferenceHashes.has(digest)) {
    return privateReferenceHashes.get(digest);
  }

  const text = bytes.toString("utf8");
  const privateKeyMarker = ["BEGIN", "PRIVATE", "KEY"].join(" ");
  const tokenName = ["CANVAS", "API", "TOKEN"].join("_");
  const assignment = new RegExp(`${tokenName}\\s*=\\s*[^\\s<]+`, "i");
  const privateDataMarkers = [
    /(?:access|refresh)[_-]?token\\s*[:=]\\s*[A-Za-z0-9._~-]{12,}/i,
    /(?:student|learner)[_-](?:name|email|id)\\s*[:=]\\s*[^<>{}\s][^\n]*/i,
    /(?:coursework|student)[_-]?(?:export|record|feed)[_-]?(?:url|path)\\s*[:=]\\s*[^<>{}\s][^\n]*/i,
  ];
  if (text.includes(privateKeyMarker) || assignment.test(text) || privateDataMarkers.some((marker) => marker.test(text))) {
    return "explicit secret marker";
  }
  return null;
}

export function publicPaths() {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
  });
  if (result.status !== 0) {
    throw new Error("Unable to enumerate the public candidate tree.");
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

async function main() {
  const failures = [];
  const files = publicPaths();
  for (const relativePath of files) {
    const pathFinding = scanPath(relativePath);
    if (pathFinding) {
      failures.push(`${relativePath}: ${pathFinding}`);
      continue;
    }
    const contentFinding = scanContent(await readFile(path.join(root, relativePath)));
    if (contentFinding) failures.push(`${relativePath}: ${contentFinding}`);
  }
  if (failures.length > 0) {
    throw new Error(`Public-tree check rejected ${failures.join(", ")}.`);
  }
  console.log(`Public-tree check passed for ${files.length} candidate files.`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
