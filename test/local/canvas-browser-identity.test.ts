import { afterEach, describe, expect, it, vi } from "vitest";
import { readCanvasIdentity } from "../../scripts/canvas-browser-identity.mjs";

const origin = "https://marymount.instructure.com";
afterEach(() => vi.unstubAllGlobals());

function contextFor(body: string, status = 200) {
  const page = {
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async (callback: (value: string) => Promise<number | undefined>, value: string) => callback(value)),
    close: vi.fn(async () => undefined),
  };
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("fetch", vi.fn(async () => {
    const response = new Response(body, { status, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: `${origin}/api/v1/users/self/profile` });
    return response;
  }));
  return { page, context: { newPage: async () => page } };
}

describe("numeric Canvas identity read", () => {
  it("accepts an anti-JSON-prefixed self profile without returning its other fields", async () => {
    const { page, context } = contextFor('while(1);{"id":41,"name":"synthetic private"}');
    expect(await readCanvasIdentity({ context })).toBe(41);
    expect(page.goto).toHaveBeenCalledWith(origin, expect.objectContaining({ waitUntil: "domcontentloaded" }));
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated and malformed profiles", async () => {
    const first = contextFor('{"id":41}', 401);
    expect(await readCanvasIdentity({ context: first.context })).toBeUndefined();
    const second = contextFor('<html>sign in</html>');
    expect(await readCanvasIdentity({ context: second.context })).toBeUndefined();
    expect(second.page.close).toHaveBeenCalledTimes(1);
  });
});
