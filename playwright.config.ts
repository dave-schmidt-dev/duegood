import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const SECURE_TEST_ORIGIN = "https://127.0.0.1:8788";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(".playwright");

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  outputDir: "test-results",
  use: {
    baseURL: SECURE_TEST_ORIGIN,
    ignoreHTTPSErrors: true,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    launchOptions: {
      // ignoreHTTPSErrors only covers page/fetch requests; Chromium's service-worker
      // script fetch has its own network stack and rejects the self-signed wrangler
      // dev cert regardless, so registration needs the process-level flag too.
      args: ["--ignore-certificate-errors"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev:test",
    url: `${SECURE_TEST_ORIGIN}/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
