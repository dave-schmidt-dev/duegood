const ORIGIN = "https://marymount.instructure.com";

/** Reads only the numeric Canvas self ID for the one-time local account binding. */
export async function readCanvasIdentity({ context }) {
  const page = await context.newPage();
  try {
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 20_000 });
    return await page.evaluate(async (origin) => {
      if (globalThis.location.origin !== origin) return undefined;
      const controller = new AbortController();
      const timer = globalThis.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(`${origin}/api/v1/users/self/profile`, {
          method: "GET", credentials: "same-origin", redirect: "manual", cache: "no-store",
          headers: { Accept: "application/json" }, signal: controller.signal,
        });
        const url = new URL(response.url);
        if (response.status !== 200 || url.origin !== origin
            || url.pathname !== "/api/v1/users/self/profile" || url.search
            || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
          return undefined;
        }
        if (!response.body) return undefined;
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 256 * 1024) { await reader.cancel(); return undefined; }
          chunks.push(next.value);
        }
        const combined = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(combined);
        let json = text.replace(/^\uFEFF/u, "").trimStart();
        if (json.startsWith("while(1);")) json = json.slice(9).trimStart();
        else if (json.startsWith(")]}'")) json = json.slice(4).replace(/^,?\s*/u, "");
        let profile;
        try { profile = JSON.parse(json); } catch { return undefined; }
        return Number.isSafeInteger(profile?.id) && profile.id > 0 ? profile.id : undefined;
      } finally { globalThis.clearTimeout(timer); }
    }, ORIGIN);
  } finally { await page.close(); }
}
