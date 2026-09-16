import { expect, test } from "@playwright/test";
import { SECURE_TEST_ORIGIN } from "../../playwright.config";

function requireSecureTestOrigin(candidate: string): URL {
  const url = new URL(candidate);
  if (url.protocol !== "https:") throw new Error("Browser tests require an HTTPS origin.");
  return url;
}

test("uses a secure context with service-worker registration", async ({ page }) => {
  requireSecureTestOrigin(SECURE_TEST_ORIGIN);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.isSecureContext)).toBe(true);
  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, script: ready.active?.scriptURL ?? "" };
  });
  expect(registration.scope).toBe(`${SECURE_TEST_ORIGIN}/`);
  expect(registration.script).toBe(`${SECURE_TEST_ORIGIN}/sw.js`);
});

test("rejects an HTTP fallback", () => {
  expect(() => requireSecureTestOrigin("http://127.0.0.1:8788")).toThrow("HTTPS");
});
