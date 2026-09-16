import { describe, expect, it } from "vitest";
import { CANVAS_REQUIRED_SCOPE, resolveAuthConfig, type AuthConfigInput } from "../../src/config";

const complete: AuthConfigInput = {
  authMode: "enabled",
  appOrigin: "https://duegood.example.workers.dev",
  institutionOrigin: "https://marymount.instructure.com",
  clientId: "client-123",
  clientSecret: "secret-456",
  scope: CANVAS_REQUIRED_SCOPE,
  keyVersion: "1",
  activeKeyB64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  legacyKeysJson: undefined,
};

describe("auth configuration gate", () => {
  it("enables only when every required input is present and valid", () => {
    expect(resolveAuthConfig(complete)).toMatchObject({ mode: "enabled" });
  });

  it("stays disabled when auth mode is not explicitly enabled", () => {
    expect(resolveAuthConfig({ ...complete, authMode: undefined })).toEqual({
      mode: "disabled",
      reason: "auth_mode_disabled",
    });
    expect(resolveAuthConfig({ ...complete, authMode: "disabled" })).toEqual({
      mode: "disabled",
      reason: "auth_mode_disabled",
    });
  });

  const missingCases: Array<[string, Partial<AuthConfigInput>, string]> = [
    ["app origin", { appOrigin: undefined }, "missing_app_origin"],
    ["app origin scheme", { appOrigin: "http://insecure.example" }, "invalid_app_origin"],
    ["institution origin", { institutionOrigin: undefined }, "missing_institution_origin"],
    ["institution origin scheme", { institutionOrigin: "http://insecure.example" }, "invalid_institution_origin"],
    ["client id", { clientId: undefined }, "missing_client_id"],
    ["client secret", { clientSecret: undefined }, "missing_client_secret"],
    ["scope", { scope: "" }, "invalid_scope"],
    ["scope shape", { scope: "url:GET|/api/v1/courses" }, "invalid_scope"],
    ["key version", { keyVersion: undefined }, "missing_key_version"],
    ["key version shape", { keyVersion: "01" }, "invalid_key_version"],
    ["active key", { activeKeyB64: undefined }, "missing_active_key"],
    ["active key length", { activeKeyB64: "dG9vc2hvcnQ=" }, "invalid_active_key"],
    [
      "active key missing padding",
      { activeKeyB64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY" },
      "invalid_active_key",
    ],
    [
      "active key with embedded newline",
      { activeKeyB64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0\nNTY3ODlhYmNkZWY=" },
      "invalid_active_key",
    ],
    ["legacy keys json", { legacyKeysJson: "not-json" }, "invalid_legacy_keys"],
    ["legacy keys shape", { legacyKeysJson: "[1,2,3]" }, "invalid_legacy_keys"],
    [
      "legacy key length",
      { legacyKeysJson: JSON.stringify({ 2: "dG9vc2hvcnQ=" }) },
      "invalid_legacy_keys",
    ],
    [
      "legacy key version collision",
      { legacyKeysJson: JSON.stringify({ 1: complete.activeKeyB64 }) },
      "key_version_conflict",
    ],
  ];

  it.each(missingCases)("returns disabled for missing/invalid %s", (_label, override, reason) => {
    expect(resolveAuthConfig({ ...complete, ...override })).toEqual({ mode: "disabled", reason });
  });

  it("treats template placeholder strings as absent, not as configured values", () => {
    expect(
      resolveAuthConfig({
        ...complete,
        clientId: "REPLACE_AFTER_ADMIN_ENABLEMENT",
        clientSecret: "REPLACE_WITH_INSTITUTION_ISSUED_SECRET",
      }),
    ).toEqual({ mode: "disabled", reason: "missing_client_id" });
  });

  it("resolves a legacy key ring alongside the active version", () => {
    const legacyKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const result = resolveAuthConfig({
      ...complete,
      legacyKeysJson: JSON.stringify({ 2: legacyKey }),
    });
    expect(result.mode).toBe("enabled");
    if (result.mode !== "enabled") throw new Error("unreachable");
    expect(result.keyRing.activeVersion).toBe(1);
    expect([...result.keyRing.keys.keys()].sort()).toEqual([1, 2]);
    expect(result.redirectUri).toBe("https://duegood.example.workers.dev/auth/canvas/callback");
  });
});
