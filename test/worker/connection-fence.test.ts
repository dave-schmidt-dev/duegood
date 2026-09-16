import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assertConnectionFence,
  createConnection,
  deleteConnection,
  findOrCreateAccount,
  getActiveConnection,
  revokeConnection,
} from "../../src/db/repository";

async function makeConnection(canvasUserId: string) {
  const account = await findOrCreateAccount(env.DB, "https://marymount.instructure.com", canvasUserId, 1000);
  return createConnection(env.DB, {
    id: crypto.randomUUID(),
    accountId: account.id,
    keyVersion: 1,
    encryptedAccessToken: "envelope",
    encryptedRefreshToken: null,
    accessTokenExpiresAt: null,
    now: 1000,
  });
}

describe("connection fence", () => {
  it("passes for an active connection at its current generation", async () => {
    const connection = await makeConnection("fence-1");
    await expect(assertConnectionFence(env.DB, connection.id, connection.generation)).resolves.toBeUndefined();
  });

  it("returns a revoked connection with an incremented generation", async () => {
    const connection = await makeConnection("fence-2");
    const revoked = await revokeConnection(env.DB, connection.id, 2000);

    expect(revoked.status).toBe("revoked");
    expect(revoked.generation).toBe(connection.generation + 1);
  });

  it("rejects a fence check against a connection's now-stale generation after revoke", async () => {
    const connection = await makeConnection("fence-3");
    await revokeConnection(env.DB, connection.id, 2000);

    await expect(assertConnectionFence(env.DB, connection.id, connection.generation)).rejects.toThrow(
      /not active/,
    );
    expect(await getActiveConnection(env.DB, connection.id)).toBeUndefined();
  });

  it("rejects local access to a removed connection after revoke-then-delete", async () => {
    const connection = await makeConnection("fence-4");
    await revokeConnection(env.DB, connection.id, 2000);
    await deleteConnection(env.DB, connection.id);

    expect(await getActiveConnection(env.DB, connection.id)).toBeUndefined();
    await expect(assertConnectionFence(env.DB, connection.id, connection.generation)).rejects.toThrow(
      /not active/,
    );
  });

  it("rejects a fence check against an unknown connection id", async () => {
    await expect(assertConnectionFence(env.DB, crypto.randomUUID(), 1)).rejects.toThrow(/not active/);
  });
});
