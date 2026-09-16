import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findOrCreateAccount } from "../../src/db/repository";
import {
  ABSOLUTE_SESSION_LIFETIME_SECONDS,
  IDLE_SESSION_LIFETIME_SECONDS,
  buildSessionClearCookie,
  buildSessionCookie,
  createSession,
  revokeSessionByToken,
  rotateSession,
  touchSessionActivity,
  validateSession,
} from "../../src/auth/session";

async function makeAccount(canvasUserId: string) {
  return findOrCreateAccount(env.DB, "https://marymount.instructure.com", canvasUserId, 1000);
}

describe("session lifecycle", () => {
  it("creates and validates a session for the correct account", async () => {
    const account = await makeAccount("lifecycle-1");
    const created = await createSession(env.DB, account.id, 0);

    const validated = await validateSession(env.DB, created.token, 0);
    expect(validated?.accountId).toBe(account.id);
    expect(validated?.id).toBe(created.session.id);
  });

  it("rejects an unknown token", async () => {
    await expect(validateSession(env.DB, "not-a-real-token", 0)).resolves.toBeUndefined();
  });

  it("rejects a revoked session", async () => {
    const account = await makeAccount("lifecycle-2");
    const created = await createSession(env.DB, account.id, 0);

    await revokeSessionByToken(env.DB, created.token, 1000);

    await expect(validateSession(env.DB, created.token, 1000)).resolves.toBeUndefined();
  });

  it("rejects a session past its idle expiry", async () => {
    const account = await makeAccount("lifecycle-3");
    const created = await createSession(env.DB, account.id, 0);

    const pastIdle = IDLE_SESSION_LIFETIME_SECONDS * 1000 + 1;
    await expect(validateSession(env.DB, created.token, pastIdle)).resolves.toBeUndefined();
  });

  it("rejects a session past its absolute expiry even when activity keeps touching it", async () => {
    const account = await makeAccount("lifecycle-4");
    const created = await createSession(env.DB, account.id, 0);

    // Advance in steps just under the idle window, touching each time to simulate continuous
    // activity. touchSessionActivity is a no-op once `now` passes the absolute boundary, so the
    // idle window stops being refreshed there regardless of how often it's called.
    const step = IDLE_SESSION_LIFETIME_SECONDS * 1000 - 100_000;
    let now = 0;
    while (now < ABSOLUTE_SESSION_LIFETIME_SECONDS * 1000) {
      now += step;
      await touchSessionActivity(env.DB, created.session.id, now);
    }

    await expect(validateSession(env.DB, created.token, now)).resolves.toBeUndefined();
  });

  it("rotates at the authentication boundary: old token dies, new token authenticates", async () => {
    const account = await makeAccount("lifecycle-5");
    const original = await createSession(env.DB, account.id, 0);

    const rotated = await rotateSession(env.DB, original.token, account.id, 1000);

    await expect(validateSession(env.DB, original.token, 1000)).resolves.toBeUndefined();
    const validated = await validateSession(env.DB, rotated.token, 1000);
    expect(validated?.accountId).toBe(account.id);
  });

  it("rotates cleanly with no prior token, for a first-time login", async () => {
    const account = await makeAccount("lifecycle-6");
    const rotated = await rotateSession(env.DB, undefined, account.id, 0);

    const validated = await validateSession(env.DB, rotated.token, 0);
    expect(validated?.accountId).toBe(account.id);
  });

  it("builds a session cookie with exactly the required __Host- attributes", () => {
    const cookie = buildSessionCookie("token-value");

    expect(cookie).toMatch(/^__Host-duegood_session=token-value;/);
    expect(cookie).toMatch(/;\s*Secure(;|$)/);
    expect(cookie).toMatch(/;\s*HttpOnly(;|$)/);
    expect(cookie).toMatch(/;\s*Path=\/(;|$)/);
    expect(cookie).toMatch(/;\s*SameSite=Lax(;|$)/);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("builds a clearing cookie with the same attributes and Max-Age=0", () => {
    const cookie = buildSessionClearCookie();

    expect(cookie).toMatch(/^__Host-duegood_session=;/);
    expect(cookie).toMatch(/;\s*Secure(;|$)/);
    expect(cookie).toMatch(/;\s*HttpOnly(;|$)/);
    expect(cookie).toMatch(/;\s*Max-Age=0(;|$)/);
    expect(cookie).not.toMatch(/Domain=/i);
  });
});
