import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("static asset boundary", () => {
  it("serves only generated browser assets and excludes Worker modules", async () => {
    const rootResponse = await env.ASSETS.fetch("https://duegood.test/");
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("content-type")).toContain("text/html");

    const sourceResponse = await env.ASSETS.fetch("https://duegood.test/src/index.ts");
    expect(sourceResponse.status).toBe(404);

    const browserBundle = await env.ASSETS.fetch("https://duegood.test/app.js");
    expect(browserBundle.status).toBe(200);
    const source = await browserBundle.text();
    expect(source).not.toContain("D1Database");
    expect(source).not.toContain("AUTH_MODE");
    expect(source).not.toContain("/health");
  });
});
