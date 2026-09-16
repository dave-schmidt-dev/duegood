import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findOrCreateAccount } from "../../src/db/repository";

describe("institution-scoped account identity", () => {
  it("treats the same Canvas user id at different institutions as distinct accounts", async () => {
    const a = await findOrCreateAccount(env.DB, "https://marymount.instructure.com", "42", 1000);
    const b = await findOrCreateAccount(env.DB, "https://otherschool.instructure.com", "42", 1000);

    expect(a.id).not.toBe(b.id);
  });

  it("returns the same account for a repeated lookup of the same institution-plus-user pair", async () => {
    const first = await findOrCreateAccount(env.DB, "https://marymount.instructure.com", "7", 1000);
    const second = await findOrCreateAccount(env.DB, "https://marymount.instructure.com", "7", 2000);

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });
});
