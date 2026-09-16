import { expect, test } from "@playwright/test";

/**
 * Proves Chromium's real cookie jar — not just this app's own parsing — accepts a `__Host-`
 * prefixed cookie set by this server. Uses `/auth/canvas/start` rather than a full login: that
 * route sets `__Host-duegood_oauth_binding` with no token exchange and no real Canvas network
 * call (`CANVAS_ORIGIN` here is a synthetic, deliberately non-resolving origin — see
 * `dev:test:auth`), so it exercises the exact `__Host-` attribute set (Secure, Path=/, no Domain)
 * the session and CSRF cookies also use, without needing a synthetic-OAuth test harness. If any
 * required attribute were wrong, Chromium would silently refuse to store the cookie at all rather
 * than raise a visible error — so the presence of the cookie below is itself the assertion.
 */
test("browser accepts and stores the __Host- OAuth binding cookie with its required attributes", async ({
  page,
  context,
}) => {
  // The redirect target (a synthetic, non-resolving Canvas origin) will fail to load; only the
  // first hop's Set-Cookie response matters here, so the navigation error itself is expected.
  await page.goto("/auth/canvas/start", { waitUntil: "commit" }).catch(() => undefined);

  const cookies = await context.cookies();
  const binding = cookies.find((cookie) => cookie.name === "__Host-duegood_oauth_binding");

  expect(binding).toBeDefined();
  expect(binding?.secure).toBe(true);
  expect(binding?.httpOnly).toBe(true);
  expect(binding?.sameSite).toBe("Lax");
  expect(binding?.path).toBe("/");
});
