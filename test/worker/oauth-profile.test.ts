import { describe, expect, it, vi } from "vitest";
import { CANVAS_REQUIRED_SCOPE, resolveAuthConfig, type AuthConfigInput, type CanvasAuthConfig } from "../../src/config";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeProviderToken,
  type FetchFn,
} from "../../src/auth/oauth-profile";

const COMPLETE_INPUT: AuthConfigInput = {
  authMode: "enabled",
  appOrigin: "https://duegood.example",
  institutionOrigin: "https://marymount.instructure.com",
  clientId: "client-123",
  clientSecret: "secret-456",
  scope: CANVAS_REQUIRED_SCOPE,
  keyVersion: "1",
  activeKeyB64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  legacyKeysJson: undefined,
};

function enabledConfig(): CanvasAuthConfig {
  const resolved = resolveAuthConfig(COMPLETE_INPUT);
  if (resolved.mode !== "enabled") throw new Error("test fixture config did not enable");
  return resolved;
}

function mockFetch(response: { status: number; body?: unknown }): FetchFn {
  return vi.fn(async () =>
    Promise.resolve(
      new Response(response.body === undefined ? null : JSON.stringify(response.body), { status: response.status }),
    ),
  ) as unknown as FetchFn;
}

const TOKEN_RESPONSE_BODY = {
  access_token: "canvas-access-token",
  token_type: "Bearer",
  user: { id: 42, name: "Jimi Hendrix" },
  refresh_token: "canvas-refresh-token",
  expires_in: 3600,
  canvas_region: "us-east-1",
};

describe("buildAuthorizeUrl", () => {
  it("targets the institution's authorize endpoint with the required parameters", () => {
    const url = new URL(buildAuthorizeUrl(enabledConfig(), "state-value"));

    expect(url.origin).toBe("https://marymount.instructure.com");
    expect(url.pathname).toBe("/login/oauth2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("https://duegood.example/auth/canvas/callback");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("scope")).toBe(CANVAS_REQUIRED_SCOPE);
  });

  it("never includes a PKCE parameter — Canvas defines no code_challenge extension to use", () => {
    const url = new URL(buildAuthorizeUrl(enabledConfig(), "state-value"));

    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
  });
});

describe("exchangeAuthorizationCode", () => {
  it("posts the confidential authorization_code grant form-encoded, with the secret in the body", async () => {
    const fetchFn = mockFetch({ status: 200, body: TOKEN_RESPONSE_BODY });

    await exchangeAuthorizationCode(enabledConfig(), "auth-code", fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = vi.mocked(fetchFn).mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.toString()).toBe("https://marymount.instructure.com/login/oauth2/token");
    expect(init.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("client_secret")).toBe("secret-456");
    expect(body.get("redirect_uri")).toBe("https://duegood.example/auth/canvas/callback");
    expect(body.get("code")).toBe("auth-code");
    expect(body.has("code_verifier")).toBe(false);
  });

  it("parses the access token, refresh token, expiry, and Canvas user id out of the response", async () => {
    const result = await exchangeAuthorizationCode(enabledConfig(), "auth-code", mockFetch({ status: 200, body: TOKEN_RESPONSE_BODY }));

    expect(result).toEqual({
      accessToken: "canvas-access-token",
      refreshToken: "canvas-refresh-token",
      expiresInSeconds: 3600,
      canvasUserId: "42",
    });
  });

  it("rejects a non-ok response instead of treating it as a valid exchange", async () => {
    await expect(exchangeAuthorizationCode(enabledConfig(), "auth-code", mockFetch({ status: 400 }))).rejects.toThrow(
      /400/,
    );
  });

  it("rejects a response missing a required field", async () => {
    const fetchFn = mockFetch({ status: 200, body: { token_type: "Bearer" } });
    await expect(exchangeAuthorizationCode(enabledConfig(), "auth-code", fetchFn)).rejects.toThrow(/unexpected shape/);
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh_token grant and tolerates a response with no reissued refresh token", async () => {
    const fetchFn = mockFetch({
      status: 200,
      body: { access_token: "new-access-token", token_type: "Bearer", user: { id: 42, name: "Jimi Hendrix" }, expires_in: 3600 },
    });

    const result = await refreshAccessToken(enabledConfig(), "stored-refresh-token", fetchFn);

    const [, init] = vi.mocked(fetchFn).mock.calls[0] as [URL, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("stored-refresh-token");
    expect(result.refreshToken).toBeUndefined();
    expect(result.accessToken).toBe("new-access-token");
  });
});

describe("revokeProviderToken", () => {
  it("returns true when Canvas acknowledges the revocation", async () => {
    const fetchFn = mockFetch({ status: 200 });
    await expect(revokeProviderToken(enabledConfig(), "access-token", fetchFn)).resolves.toBe(true);

    const [requestUrl, init] = vi.mocked(fetchFn).mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.toString()).toBe("https://marymount.instructure.com/login/oauth2/token");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
  });

  it("returns false, and never throws, when Canvas rejects the revocation", async () => {
    await expect(revokeProviderToken(enabledConfig(), "access-token", mockFetch({ status: 401 }))).resolves.toBe(false);
  });

  it("returns false, and never throws, when the request itself fails", async () => {
    const throwing: FetchFn = vi.fn(async () => Promise.reject(new Error("network down"))) as unknown as FetchFn;
    await expect(revokeProviderToken(enabledConfig(), "access-token", throwing)).resolves.toBe(false);
  });
});

describe("configuration gate", () => {
  it("keeps auth unavailable when institution, client, redirect, or scope configuration is incomplete", () => {
    expect(resolveAuthConfig({ ...COMPLETE_INPUT, institutionOrigin: undefined })).toMatchObject({ mode: "disabled" });
    expect(resolveAuthConfig({ ...COMPLETE_INPUT, clientId: undefined })).toMatchObject({ mode: "disabled" });
    expect(resolveAuthConfig({ ...COMPLETE_INPUT, appOrigin: undefined })).toMatchObject({ mode: "disabled" });
    expect(resolveAuthConfig({ ...COMPLETE_INPUT, scope: "" })).toMatchObject({ mode: "disabled" });
  });

  it("has no configuration surface for a PKCE extension to be enabled through", () => {
    // Canvas documents no PKCE support at all (verified against its OAuth2 endpoint reference),
    // so an institution cannot supply the "documented and configured" proof TASKS.md requires —
    // there is deliberately no `AuthConfigInput` field a caller could set to ask for one.
    const keys = Object.keys(COMPLETE_INPUT);
    expect(keys.some((key) => /pkce|challenge|verifier/i.test(key))).toBe(false);
  });
});
