import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "test", "test-membership.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function list(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, ".playwright") },
  });
  if (result.status !== 0) {
    throw new Error(`Test discovery failed for ${command} ${args.join(" ")}.`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

for (const testPath of [...manifest.worker.tests, ...manifest.ui.tests, ...manifest.browser.tests]) {
  if (!existsSync(path.join(root, testPath))) {
    throw new Error(`Membership names missing test ${testPath}.`);
  }
}

for (const runner of [manifest.worker.focusedRunner, manifest.worker.fullRunner]) {
  const script = packageJson.scripts[runner];
  if (typeof script !== "string" || script.includes("playwright")) {
    throw new Error(`${runner} must be a non-browser runner.`);
  }
  const discovery = list(path.join(root, "node_modules", ".bin", "vitest"), [
    "list",
    "--config",
    "vitest.config.ts",
    "test/worker",
  ]);
  for (const testPath of manifest.worker.tests) {
    if (!discovery.includes(testPath)) {
      throw new Error(`${runner} does not discover ${testPath}.`);
    }
  }
}

{
  const script = packageJson.scripts[manifest.ui.focusedRunner];
  if (typeof script !== "string" || script.includes("playwright")) {
    throw new Error(`${manifest.ui.focusedRunner} must be a non-browser runner.`);
  }
  const discovery = list(path.join(root, "node_modules", ".bin", "vitest"), ["list", "--config", "vitest.ui.config.ts"]);
  for (const testPath of manifest.ui.tests) {
    if (!discovery.includes(testPath)) {
      throw new Error(`${manifest.ui.focusedRunner} does not discover ${testPath}.`);
    }
  }
}

const browserDiscovery = list(path.join(root, "node_modules", ".bin", "playwright"), ["test", "--list"]);
for (const testPath of manifest.browser.tests) {
  if (!browserDiscovery.includes(path.basename(testPath))) {
    throw new Error(`test:all browser batch does not discover ${testPath}.`);
  }
}

const allScript = packageJson.scripts[manifest.browser.inclusiveRunner];
if (typeof allScript !== "string" || !allScript.includes("npm run test:browser")) {
  throw new Error("test:all must contain the single browser batch.");
}
for (const runner of manifest.browser.forbiddenRunners) {
  if ((packageJson.scripts[runner] ?? "").includes("playwright")) {
    throw new Error(`${runner} must not execute browser tests.`);
  }
}

console.log(`Verified ${manifest.worker.tests.length} worker tests in both non-browser runners.`);
console.log(`Verified ${manifest.ui.tests.length} UI contract tests in ${manifest.ui.focusedRunner}.`);
console.log(`Verified ${manifest.browser.tests.length} browser tests are reserved for test:all.`);
