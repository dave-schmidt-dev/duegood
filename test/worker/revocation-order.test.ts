import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createConnection,
  deleteConnection,
  findOrCreateAccount,
  isKeyVersionRetirable,
  revokeConnection,
} from "../../src/db/repository";

async function makeAccount(canvasUserId: string) {
  return findOrCreateAccount(env.DB, "https://marymount.instructure.com", canvasUserId, 1000);
}

describe("connection revocation order", () => {
  it("rejects deleting a connection that has never been revoked", async () => {
    const account = await makeAccount("revocation-order-1");
    const connection = await createConnection(env.DB, {
      id: crypto.randomUUID(),
      accountId: account.id,
      keyVersion: 1,
      encryptedAccessToken: "envelope",
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      now: 1000,
    });

    await expect(deleteConnection(env.DB, connection.id)).rejects.toThrow(/not found or not yet revoked/);
  });

  it("permits delete only after revoke, in that order", async () => {
    const account = await makeAccount("revocation-order-2");
    const connection = await createConnection(env.DB, {
      id: crypto.randomUUID(),
      accountId: account.id,
      keyVersion: 1,
      encryptedAccessToken: "envelope",
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      now: 1000,
    });

    const revoked = await revokeConnection(env.DB, connection.id, 2000);
    expect(revoked.status).toBe("revoked");
    expect(revoked.generation).toBe(connection.generation + 1);
    expect(revoked.revokedAt).toBe(2000);

    await expect(deleteConnection(env.DB, connection.id)).resolves.toBeUndefined();
  });

  it("rejects revoking a connection that is already revoked", async () => {
    const account = await makeAccount("revocation-order-3");
    const connection = await createConnection(env.DB, {
      id: crypto.randomUUID(),
      accountId: account.id,
      keyVersion: 1,
      encryptedAccessToken: "envelope",
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      now: 1000,
    });

    await revokeConnection(env.DB, connection.id, 2000);
    await expect(revokeConnection(env.DB, connection.id, 3000)).rejects.toThrow(/already revoked/);
  });

  it("rejects retiring a key version still referenced by a connection, and permits it once deleted", async () => {
    const account = await makeAccount("revocation-order-4");
    const connection = await createConnection(env.DB, {
      id: crypto.randomUUID(),
      accountId: account.id,
      keyVersion: 7,
      encryptedAccessToken: "envelope",
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      now: 1000,
    });

    expect(await isKeyVersionRetirable(env.DB, 7)).toBe(false);

    // Still referenced while merely revoked — the encrypted row still exists under that version.
    await revokeConnection(env.DB, connection.id, 2000);
    expect(await isKeyVersionRetirable(env.DB, 7)).toBe(false);

    await deleteConnection(env.DB, connection.id);
    expect(await isKeyVersionRetirable(env.DB, 7)).toBe(true);
  });
});
