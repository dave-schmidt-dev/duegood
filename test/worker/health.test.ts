import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

describe("local Worker health", () => {
  it("reports a healthy shell while authentication stays disabled", async () => {
    const response = await worker.fetch(
      new Request("https://duegood.test/health") as Parameters<typeof worker.fetch>[0],
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok", authentication: "disabled" });
  });

  it("returns an unavailable status instead of an authentication bypass", async () => {
    const response = await worker.fetch(
      new Request("https://duegood.test/api/auth/status") as Parameters<typeof worker.fetch>[0],
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ available: false, reason: "not_configured" });
  });
});
