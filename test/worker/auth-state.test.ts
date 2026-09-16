import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { OAUTH_STATE_LIFETIME_SECONDS, consumeOauthAttempt, createOauthAttempt } from "../../src/auth/oauth-state";

const INSTITUTION = "https://marymount.instructure.com";
const REDIRECT_URI = "https://duegood.example/auth/canvas/callback";
const BINDING = "pre-auth-cookie-value";

async function start(now = 0) {
  return createOauthAttempt(env.DB, { institutionOrigin: INSTITUTION, redirectUri: REDIRECT_URI, browserBinding: BINDING }, now);
}

describe("oauth state machine", () => {
  it("creates and consumes a valid attempt", async () => {
    const created = await start();

    const consumed = await consumeOauthAttempt(
      env.DB,
      { state: created.state, institutionOrigin: INSTITUTION, redirectUri: REDIRECT_URI, browserBinding: BINDING },
      100,
    );

    expect(consumed?.id).toBe(created.attempt.id);
  });

  it("rejects an unknown state", async () => {
    await start();

    const consumed = await consumeOauthAttempt(
      env.DB,
      { state: "not-a-real-state", institutionOrigin: INSTITUTION, redirectUri: REDIRECT_URI, browserBinding: BINDING },
      100,
    );

    expect(consumed).toBeUndefined();
  });

  it("rejects an expired attempt", async () => {
    const created = await start(0);

    const pastExpiry = OAUTH_STATE_LIFETIME_SECONDS * 1000 + 1;
    const consumed = await consumeOauthAttempt(
      env.DB,
      { state: created.state, institutionOrigin: INSTITUTION, redirectUri: REDIRECT_URI, browserBinding: BINDING },
      pastExpiry,
    );

    expect(consumed).toBeUndefined();
  });

  it("rejects a mismatched institution", async () => {
    const created = await start();

    const consumed = await consumeOauthAttempt(
      env.DB,
      {
        state: created.state,
        institutionOrigin: "https://other.instructure.com",
        redirectUri: REDIRECT_URI,
        browserBinding: BINDING,
      },
      100,
    );

    expect(consumed).toBeUndefined();
  });

  it("rejects a mismatched redirect URI", async () => {
    const created = await start();

    const consumed = await consumeOauthAttempt(
      env.DB,
      {
        state: created.state,
        institutionOrigin: INSTITUTION,
        redirectUri: "https://attacker.example/callback",
        browserBinding: BINDING,
      },
      100,
    );

    expect(consumed).toBeUndefined();
  });

  it("rejects a mismatched browser binding", async () => {
    const created = await start();

    const consumed = await consumeOauthAttempt(
      env.DB,
      {
        state: created.state,
        institutionOrigin: INSTITUTION,
        redirectUri: REDIRECT_URI,
        browserBinding: "a-different-browser",
      },
      100,
    );

    expect(consumed).toBeUndefined();
  });

  it("rejects replaying an already-consumed state", async () => {
    const created = await start();
    const params = { state: created.state, institutionOrigin: INSTITUTION, redirectUri: REDIRECT_URI, browserBinding: BINDING };

    const first = await consumeOauthAttempt(env.DB, params, 100);
    expect(first?.id).toBe(created.attempt.id);

    const replay = await consumeOauthAttempt(env.DB, params, 200);
    expect(replay).toBeUndefined();
  });

  it("lets only one of two concurrent consumes for the same state win", async () => {
    const created = await start();
    const params = { state: created.state, institutionOrigin: INSTITUTION, redirectUri: REDIRECT_URI, browserBinding: BINDING };

    const [first, second] = await Promise.all([
      consumeOauthAttempt(env.DB, params, 100),
      consumeOauthAttempt(env.DB, params, 100),
    ]);

    const winners = [first, second].filter((result) => result !== undefined);
    expect(winners).toHaveLength(1);
  });

  it("never stores the raw state or browser binding", async () => {
    const created = await start();

    const row = await env.DB.prepare("SELECT state_hash, binding_hash FROM oauth_states WHERE id = ?1")
      .bind(created.attempt.id)
      .first<{ state_hash: string; binding_hash: string }>();

    expect(row?.state_hash).not.toBe(created.state);
    expect(row?.binding_hash).not.toBe(BINDING);
  });
});
