import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findOrCreateAccount } from "../../src/db/repository";
import { createSession, revokeSessionByToken, rotateSession, validateSession } from "../../src/auth/session";

async function makeAccount(canvasUserId: string) {
  return findOrCreateAccount(env.DB, "https://marymount.instructure.com", canvasUserId, 1000);
}

describe("session ownership", () => {
  it("never validates one account's token as a different account", async () => {
    const accountA = await makeAccount("ownership-a1");
    const accountB = await makeAccount("ownership-b1");
    const sessionA = await createSession(env.DB, accountA.id, 0);
    const sessionB = await createSession(env.DB, accountB.id, 0);

    const validatedA = await validateSession(env.DB, sessionA.token, 0);
    const validatedB = await validateSession(env.DB, sessionB.token, 0);

    expect(validatedA?.accountId).toBe(accountA.id);
    expect(validatedB?.accountId).toBe(accountB.id);
    expect(validatedA?.accountId).not.toBe(validatedB?.accountId);
  });

  it("revoking one account's session leaves another account's session valid", async () => {
    const accountA = await makeAccount("ownership-a2");
    const accountB = await makeAccount("ownership-b2");
    const sessionA = await createSession(env.DB, accountA.id, 0);
    const sessionB = await createSession(env.DB, accountB.id, 0);

    await revokeSessionByToken(env.DB, sessionA.token, 1000);

    await expect(validateSession(env.DB, sessionA.token, 1000)).resolves.toBeUndefined();
    await expect(validateSession(env.DB, sessionB.token, 1000)).resolves.toMatchObject({ accountId: accountB.id });
  });

  it("rotating one of an account's two concurrent sessions leaves the other untouched", async () => {
    const account = await makeAccount("ownership-multi");
    const first = await createSession(env.DB, account.id, 0);
    const second = await createSession(env.DB, account.id, 0);

    const rotated = await rotateSession(env.DB, first.token, account.id, 1000);

    await expect(validateSession(env.DB, first.token, 1000)).resolves.toBeUndefined();
    await expect(validateSession(env.DB, second.token, 1000)).resolves.toMatchObject({ accountId: account.id });
    await expect(validateSession(env.DB, rotated.token, 1000)).resolves.toMatchObject({ accountId: account.id });
  });
});
