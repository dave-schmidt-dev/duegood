import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, type EncryptedCredential } from "../../src/crypto";
import type { KeyRing } from "../../src/config";

function randomKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

function ringOf(activeVersion: number, keys: Record<number, Uint8Array<ArrayBuffer>>): KeyRing {
  return { activeVersion, keys: new Map(Object.entries(keys).map(([v, k]) => [Number(v), k])) };
}

describe("credential envelope", () => {
  it("round-trips plaintext through the active key version", async () => {
    const ring = ringOf(1, { 1: randomKey() });
    const identity = { accountId: 7, connectionId: crypto.randomUUID() };

    const encrypted = await encryptCredential(ring, identity, "canvas-access-token");
    const decrypted = await decryptCredential(ring, identity, encrypted);

    expect(decrypted).toBe("canvas-access-token");
    expect(encrypted.keyVersion).toBe(1);
  });

  it("rejects decryption under a different account id (associated data mismatch)", async () => {
    const ring = ringOf(1, { 1: randomKey() });
    const connectionId = crypto.randomUUID();
    const encrypted = await encryptCredential(ring, { accountId: 1, connectionId }, "secret");

    await expect(decryptCredential(ring, { accountId: 2, connectionId }, encrypted)).rejects.toThrow();
  });

  it("rejects decryption under a different connection id (associated data mismatch)", async () => {
    const ring = ringOf(1, { 1: randomKey() });
    const accountId = 1;
    const encrypted = await encryptCredential(ring, { accountId, connectionId: crypto.randomUUID() }, "secret");

    await expect(
      decryptCredential(ring, { accountId, connectionId: crypto.randomUUID() }, encrypted),
    ).rejects.toThrow();
  });

  it("never cross-decrypts when account and connection ids are swapped between two credentials", async () => {
    // Both fields are fixed-width in the associated data (8-byte account id, 36-byte UUID), so no
    // pair of distinct (accountId, connectionId) values can serialize to the same bytes the way a
    // delimiter-free string concatenation could. This locks that property in rather than relying
    // on it holding by construction alone.
    const ring = ringOf(1, { 1: randomKey() });
    const identityA = { accountId: 1, connectionId: crypto.randomUUID() };
    const identityB = { accountId: 100_000_001, connectionId: crypto.randomUUID() };

    const encryptedA = await encryptCredential(ring, identityA, "token-a");
    const encryptedB = await encryptCredential(ring, identityB, "token-b");

    await expect(decryptCredential(ring, identityB, encryptedA)).rejects.toThrow();
    await expect(decryptCredential(ring, identityA, encryptedB)).rejects.toThrow();
  });

  it("decrypts a credential encrypted under a now-legacy key version", async () => {
    const sharedKey = randomKey();
    const originalRing = ringOf(1, { 1: sharedKey });
    const identity = { accountId: 3, connectionId: crypto.randomUUID() };
    const encrypted = await encryptCredential(originalRing, identity, "legacy-token");

    const rotatedRing = ringOf(2, { 2: randomKey(), 1: sharedKey });
    const decrypted = await decryptCredential(rotatedRing, identity, encrypted);

    expect(decrypted).toBe("legacy-token");
    expect(encrypted.keyVersion).toBe(1);
  });

  it("rejects decryption when the envelope's key version is absent from the ring", async () => {
    const ring = ringOf(1, { 1: randomKey() });
    const identity = { accountId: 1, connectionId: crypto.randomUUID() };
    const encrypted = await encryptCredential(ring, identity, "secret");

    const ringWithoutVersion1 = ringOf(2, { 2: randomKey() });
    await expect(decryptCredential(ringWithoutVersion1, identity, encrypted)).rejects.toThrow(
      /key version 1 not present/,
    );
  });

  it("rejects an envelope with an unsupported format version byte", async () => {
    const ring = ringOf(1, { 1: randomKey() });
    const identity = { accountId: 1, connectionId: crypto.randomUUID() };
    const encrypted = await encryptCredential(ring, identity, "secret");

    const raw = Uint8Array.from(atob(encrypted.envelopeB64), (c) => c.charCodeAt(0));
    raw[0] = 99;
    const corrupted: EncryptedCredential = { ...encrypted, envelopeB64: btoa(String.fromCharCode(...raw)) };

    await expect(decryptCredential(ring, identity, corrupted)).rejects.toThrow(/unsupported credential envelope/);
  });

  it("rejects a connection id that is not a canonical 36-character UUID", async () => {
    const ring = ringOf(1, { 1: randomKey() });
    await expect(encryptCredential(ring, { accountId: 1, connectionId: "not-a-uuid" }, "secret")).rejects.toThrow(
      /36-character UUID/,
    );
  });

  it("produces a fresh random nonce for every encryption, even for identical plaintext", async () => {
    const ring = ringOf(1, { 1: randomKey() });
    const identity = { accountId: 1, connectionId: crypto.randomUUID() };

    const first = await encryptCredential(ring, identity, "same-plaintext");
    const second = await encryptCredential(ring, identity, "same-plaintext");

    expect(first.envelopeB64).not.toBe(second.envelopeB64);
  });
});
