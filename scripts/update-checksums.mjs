import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicPaths, root } from "./check-public-tree.mjs";

const checksumFile = path.join(root, "SHA256SUMS");

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export async function buildChecksumText() {
  const paths = publicPaths().filter((relativePath) => relativePath !== "SHA256SUMS");
  const records = [];
  for (const relativePath of paths) {
    records.push(`${digest(await readFile(path.join(root, relativePath)))}  ${relativePath}`);
  }
  return `${records.sort((left, right) => left.slice(67).localeCompare(right.slice(67))).join("\n")}\n`;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const text = await buildChecksumText();
  await writeFile(checksumFile, text, "utf8");
  console.log(`Regenerated ${path.relative(root, checksumFile)} for ${text.trim().split(/\r?\n/).length} public candidate files.`);
}
