import { describe, expect, it, vi } from "vitest";
import { verifyPersonalAccessToken, type FetchFn } from "../../src/auth/personal-token";
import { CANVAS_USER_AGENT } from "../../src/canvas/user-agent";

const INSTITUTION = "https://marymount.instructure.com";

function mockFetch(response: { status: number; body?: unknown }): FetchFn {
  return vi.fn(async () =>
    Promise.resolve(
      new Response(response.body === undefined ? null : JSON.stringify(response.body), { status: response.status }),
    ),
  ) as unknown as FetchFn;
}

describe("verifyPersonalAccessToken", () => {
  it("targets the institution's users/self endpoint with the bearer token attached", async () => {
    const fetchFn = mockFetch({ status: 200, body: { id: 42, name: "Jimi Hendrix" } });

    await verifyPersonalAccessToken(INSTITUTION, "student-pasted-token", fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = vi.mocked(fetchFn).mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("https://marymount.instructure.com/api/v1/users/self");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer student-pasted-token");
    // Instructure rejects requests with no User-Agent — Workers' fetch() sends none by default.
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(CANVAS_USER_AGENT);
    // Never follows a redirect automatically — a redirect target is unvalidated, so the safe
    // behavior is to stop rather than resend the bearer token one hop further.
    expect(init.redirect).toBe("manual");
  });

  it("returns the Canvas user id on a valid token, numeric id", async () => {
    const result = await verifyPersonalAccessToken(INSTITUTION, "token", mockFetch({ status: 200, body: { id: 42, name: "x" } }));
    expect(result).toEqual({ ok: true, canvasUserId: "42" });
  });

  it("returns the Canvas user id on a valid token, string id", async () => {
    const result = await verifyPersonalAccessToken(INSTITUTION, "token", mockFetch({ status: 200, body: { id: "42", name: "x" } }));
    expect(result).toEqual({ ok: true, canvasUserId: "42" });
  });

  it.each([401, 403])("reports invalid_token on a %i response — the token itself was rejected", async (status) => {
    const result = await verifyPersonalAccessToken(INSTITUTION, "bad-token", mockFetch({ status }));
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("reports provider_unreachable on a redirect rather than following it", async () => {
    const fetchFn = vi.fn(async () => Promise.resolve(new Response(null, { status: 302 }))) as unknown as FetchFn;
    const result = await verifyPersonalAccessToken(INSTITUTION, "token", fetchFn);
    expect(result).toEqual({ ok: false, reason: "provider_unreachable" });
  });

  it("reports provider_unreachable on a server error", async () => {
    const result = await verifyPersonalAccessToken(INSTITUTION, "token", mockFetch({ status: 500 }));
    expect(result).toEqual({ ok: false, reason: "provider_unreachable" });
  });

  it("reports provider_unreachable when the request itself fails, and never throws", async () => {
    const throwing: FetchFn = vi.fn(async () => Promise.reject(new Error("network down"))) as unknown as FetchFn;
    await expect(verifyPersonalAccessToken(INSTITUTION, "token", throwing)).resolves.toEqual({
      ok: false,
      reason: "provider_unreachable",
    });
  });

  it("reports provider_unreachable on a response missing the required id field", async () => {
    const result = await verifyPersonalAccessToken(INSTITUTION, "token", mockFetch({ status: 200, body: { name: "no id here" } }));
    expect(result).toEqual({ ok: false, reason: "provider_unreachable" });
  });
});
