import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const TEST_ORIGIN = "http://127.0.0.1:8791";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(".playwright");

export default defineConfig({
  testDir: "./test/native/playwright",
  testMatch: ["desktop-first-run.spec.ts", "canvas-browser-reader.spec.ts", "canvas-browser-auth-download.spec.ts", "canvas-browser-auth-production.spec.ts", "timeline-headers.spec.ts", "timeline-course-names.spec.ts"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  outputDir: "test-results",
  use: {
    baseURL: TEST_ORIGIN,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "node scripts/serve-tauri-test-assets.mjs --port 8791",
    url: `${TEST_ORIGIN}/`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
