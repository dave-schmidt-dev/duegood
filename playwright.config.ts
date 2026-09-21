import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const SECURE_TEST_ORIGIN = "https://127.0.0.1:8788";
/** A second local `wrangler dev` instance, `AUTH_MODE=enabled` with synthetic (non-real, never
 * resolving) Canvas config — see `dev:test:auth` in package.json. Every other spec needs
 * AUTH_MODE=disabled (e.g. shell.spec.ts asserts the disabled-auth shell), so auth-only specs run
 * against this separate origin/port instead of changing the default server's config. */
export const AUTH_TEST_ORIGIN = "https://127.0.0.1:8789";
export const LOCAL_TEST_ORIGIN = "http://127.0.0.1:8790";
// Every spec that needs a signed-in session (the seeded fixture from `dev:test:auth`'s
// `seed:playwright` step) matches here — "phase1" covers all four phase1-*.spec.ts files plus
// accessibility-phase1.spec.ts in one pattern, so a later phase-1 spec never needs this regex
// edited again the way csrf-cookie/session-seed did one at a time.
const AUTH_SPEC_PATTERN = /\/(csrf-cookie|session-seed|.*phase1.*)\.spec\.ts$/;
const LOCAL_SPEC_PATTERN = /\/local-dashboard\.spec\.ts$/;

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(".playwright");

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  // Multiple phase1-*.spec.ts files share one seeded fixture account/course/assignments (see
  // `scripts/seed-playwright-session.ts`) — running spec files in parallel workers would let one
  // file's completion-toggle mutation race another file's read of the same rows. `fullyParallel:
  // false` alone only serializes tests *within* a file; capping workers to 1 serializes across
  // files too, which is what a shared-fixture suite this size actually needs.
  workers: 1,
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
      testIgnore: [AUTH_SPEC_PATTERN, LOCAL_SPEC_PATTERN],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-auth",
      testMatch: AUTH_SPEC_PATTERN,
      use: { ...devices["Desktop Chrome"], baseURL: AUTH_TEST_ORIGIN },
    },
    {
      name: "chromium-local",
      testMatch: LOCAL_SPEC_PATTERN,
      use: { ...devices["Desktop Chrome"], baseURL: LOCAL_TEST_ORIGIN },
    },
  ],
  webServer: [
    {
      command: "npm run dev:test",
      url: `${SECURE_TEST_ORIGIN}/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run dev:test:auth",
      url: `${AUTH_TEST_ORIGIN}/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node scripts/serve-playwright-local.mjs --port 8790",
      url: `${LOCAL_TEST_ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
