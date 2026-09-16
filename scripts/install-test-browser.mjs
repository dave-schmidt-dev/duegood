import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playwright = path.join(root, "node_modules", ".bin", "playwright");
const browserDirectory = path.join(root, ".playwright");

console.log("Installing the Chromium build pinned by @playwright/test.");
const result = spawnSync(playwright, ["install", "chromium"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDirectory },
});
if (result.status !== 0) {
  throw new Error("Pinned Chromium installation failed.");
}
console.log("Pinned Chromium is available in the project-local browser cache.");
