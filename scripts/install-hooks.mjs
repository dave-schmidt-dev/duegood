import { access, chmod, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const hooks = [
  ["pre-commit", ["npm run lint", "npm run deadcode"], ["test:all"]],
  ["pre-push", ["npm run test:all"], ["npm run lint", "npm run deadcode"]],
];

function git(...args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

if (!checkOnly) {
  const configured = git("config", "--local", "core.hooksPath", ".githooks");
  if (configured.status !== 0) {
    throw new Error("Unable to configure the repository hooks path.");
  }
  await Promise.all(hooks.map(([name]) => chmod(path.join(root, ".githooks", name), 0o755)));
  console.log("Installed Git-native hooks at .githooks.");
}

const configuredPath = git("config", "--local", "--get", "core.hooksPath");
if (configuredPath.status !== 0 || configuredPath.stdout.trim() !== ".githooks") {
  throw new Error("core.hooksPath is not configured as .githooks; run npm run hooks:install.");
}

for (const [name, required, forbidden] of hooks) {
  const hookPath = path.join(root, ".githooks", name);
  await access(hookPath, constants.X_OK);
  const contents = await readFile(hookPath, "utf8");
  for (const command of required) {
    if (!contents.includes(command)) {
      throw new Error(`${name} is missing ${command}.`);
    }
  }
  for (const command of forbidden) {
    if (contents.includes(command)) {
      throw new Error(`${name} contains forbidden command ${command}.`);
    }
  }
}

console.log("Verified pre-commit lint/dead-code and pre-push test:all hooks.");
