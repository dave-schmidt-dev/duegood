import { describe, expect, it } from "vitest";
import { securityHeaders, withSecurityHeaders } from "../../src/security/headers";

describe("response security headers", () => {
  it("declares a restrictive CSP, no-store caching, no-referrer, and anti-framing/anti-sniffing headers", () => {
    const headers = securityHeaders();

    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("applies exactly the declared header set onto a response without altering its body or status", async () => {
    const original = Response.json({ ok: true }, { status: 201 });
    const secured = withSecurityHeaders(original);

    expect(secured.status).toBe(201);
    await expect(secured.json()).resolves.toEqual({ ok: true });

    const expected = securityHeaders();
    for (const [name, value] of Object.entries(expected)) {
      expect(secured.headers.get(name)).toBe(value);
    }
  });
});
