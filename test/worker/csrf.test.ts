import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/crypto";
import { findOrCreateAccount } from "../../src/db/repository";
import { createSession, rotateSession } from "../../src/auth/session";
import { validateCsrfToken } from "../../src/auth/csrf";
import { CSRF_HEADER_NAME, checkMutationRequest, createMutationRouteRegistry } from "../../src/auth/mutation-routes";

const APP_ORIGIN = "https://duegood.example";

async function makeAccount(canvasUserId: string) {
  return findOrCreateAccount(env.DB, "https://marymount.instructure.com", canvasUserId, 1000);
}

function mutationRequest(headers: Record<string, string>): Request {
  return new Request("https://duegood.example/api/connections", { method: "POST", headers });
}

describe("validateCsrfToken", () => {
  it("accepts the token minted with the session", async () => {
    const account = await makeAccount("csrf-1");
    const created = await createSession(env.DB, account.id, 0);

    await expect(validateCsrfToken(created.session, created.csrfToken)).resolves.toBe(true);
  });

  it("rejects a wrong token", async () => {
    const account = await makeAccount("csrf-2");
    const created = await createSession(env.DB, account.id, 0);

    await expect(validateCsrfToken(created.session, "wrong-token")).resolves.toBe(false);
  });

  it("rejects a missing token", async () => {
    const account = await makeAccount("csrf-3");
    const created = await createSession(env.DB, account.id, 0);

    await expect(validateCsrfToken(created.session, undefined)).resolves.toBe(false);
  });

  it("rotates the CSRF token together with the session token", async () => {
    const account = await makeAccount("csrf-4");
    const original = await createSession(env.DB, account.id, 0);
    const rotated = await rotateSession(env.DB, original.token, account.id, 1000);

    await expect(validateCsrfToken(rotated.session, original.csrfToken)).resolves.toBe(false);
    await expect(validateCsrfToken(rotated.session, rotated.csrfToken)).resolves.toBe(true);
  });

  it("stores exactly the hash of the minted token, not the raw value", async () => {
    const account = await makeAccount("csrf-5");
    const created = await createSession(env.DB, account.id, 0);

    expect(created.session.csrfTokenHash).toBe(await sha256Hex(created.csrfToken));
    expect(created.session.csrfTokenHash).not.toBe(created.csrfToken);
  });
});

describe("checkMutationRequest", () => {
  it("allows a same-origin request (via Origin) with a valid CSRF token", async () => {
    const account = await makeAccount("mutation-1");
    const created = await createSession(env.DB, account.id, 0);
    const request = mutationRequest({ Origin: APP_ORIGIN, [CSRF_HEADER_NAME]: created.csrfToken });

    await expect(checkMutationRequest(request, created.session, APP_ORIGIN)).resolves.toBe(true);
  });

  it("allows a same-origin request via Referer when Origin is absent", async () => {
    const account = await makeAccount("mutation-2");
    const created = await createSession(env.DB, account.id, 0);
    const request = mutationRequest({
      Referer: `${APP_ORIGIN}/settings`,
      [CSRF_HEADER_NAME]: created.csrfToken,
    });

    await expect(checkMutationRequest(request, created.session, APP_ORIGIN)).resolves.toBe(true);
  });

  it("rejects a mismatched Origin even with a valid CSRF token", async () => {
    const account = await makeAccount("mutation-3");
    const created = await createSession(env.DB, account.id, 0);
    const request = mutationRequest({
      Origin: "https://attacker.example",
      [CSRF_HEADER_NAME]: created.csrfToken,
    });

    await expect(checkMutationRequest(request, created.session, APP_ORIGIN)).resolves.toBe(false);
  });

  it("rejects a mismatched Referer when Origin is absent", async () => {
    const account = await makeAccount("mutation-4");
    const created = await createSession(env.DB, account.id, 0);
    const request = mutationRequest({
      Referer: "https://attacker.example/settings",
      [CSRF_HEADER_NAME]: created.csrfToken,
    });

    await expect(checkMutationRequest(request, created.session, APP_ORIGIN)).resolves.toBe(false);
  });

  it("fails closed when both Origin and Referer are absent", async () => {
    const account = await makeAccount("mutation-5");
    const created = await createSession(env.DB, account.id, 0);
    const request = mutationRequest({ [CSRF_HEADER_NAME]: created.csrfToken });

    await expect(checkMutationRequest(request, created.session, APP_ORIGIN)).resolves.toBe(false);
  });

  it("rejects a same-origin request with a missing CSRF token", async () => {
    const account = await makeAccount("mutation-6");
    const created = await createSession(env.DB, account.id, 0);
    const request = mutationRequest({ Origin: APP_ORIGIN });

    await expect(checkMutationRequest(request, created.session, APP_ORIGIN)).resolves.toBe(false);
  });

  it("rejects a same-origin request with a wrong CSRF token", async () => {
    const account = await makeAccount("mutation-7");
    const created = await createSession(env.DB, account.id, 0);
    const request = mutationRequest({ Origin: APP_ORIGIN, [CSRF_HEADER_NAME]: "wrong-token" });

    await expect(checkMutationRequest(request, created.session, APP_ORIGIN)).resolves.toBe(false);
  });
});

describe("mutation route registry", () => {
  it("reports guard requirement only for registered method+path pairs", () => {
    const registry = createMutationRouteRegistry();
    registry.register("POST", "/api/connections");
    registry.register("DELETE", "/api/connections/:id");

    expect(registry.requiresGuard("POST", "/api/connections")).toBe(true);
    expect(registry.requiresGuard("post", "/api/connections")).toBe(true);
    expect(registry.requiresGuard("GET", "/api/connections")).toBe(false);
    expect(registry.requiresGuard("POST", "/api/other")).toBe(false);
  });

  it("lists every registered route", () => {
    const registry = createMutationRouteRegistry();
    registry.register("POST", "/api/connections");
    registry.register("DELETE", "/api/connections/:id");

    expect(registry.list()).toEqual(
      expect.arrayContaining([
        { method: "POST", path: "/api/connections" },
        { method: "DELETE", path: "/api/connections/:id" },
      ]),
    );
    expect(registry.list()).toHaveLength(2);
  });
});
