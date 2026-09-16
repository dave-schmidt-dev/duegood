import { spawnSync } from "node:child_process";
import { root, scanContent, scanPath } from "./check-public-tree.mjs";

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: root, encoding });
  if (result.status !== 0) throw new Error("Unable to inspect the staged public tree.");
  return result.stdout;
}

const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], "buffer")
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const failures = [];

for (const relativePath of staged) {
  const pathFinding = scanPath(relativePath);
  if (pathFinding) {
    failures.push(`${relativePath}: ${pathFinding}`);
    continue;
  }
  const contents = git(["show", `:${relativePath}`], "buffer");
  const contentFinding = scanContent(contents);
  if (contentFinding) failures.push(`${relativePath}: ${contentFinding}`);
}

if (failures.length > 0) {
  throw new Error(`Staged public-tree check rejected ${failures.join(", ")}.`);
}
console.log(`Staged public-tree check passed for ${staged.length} staged files.`);
