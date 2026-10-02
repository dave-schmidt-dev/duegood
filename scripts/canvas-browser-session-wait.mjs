const ORIGIN = "https://marymount.instructure.com";
export const CANVAS_PROFILE_WAIT_TIMEOUT_MS = 5 * 60_000;
export const CANVAS_PROFILE_POLL_INTERVAL_MS = 1_000;
const MAX_PROFILE_REQUEST_TIMEOUT_MS = 5_000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Waits on the broker's existing Canvas page for its same-origin authenticated profile. */
export async function waitForCanvasProfile(context, timeoutMs = CANVAS_PROFILE_WAIT_TIMEOUT_MS,
  pollIntervalMs = CANVAS_PROFILE_POLL_INTERVAL_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CANVAS_PROFILE_WAIT_TIMEOUT_MS
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1
      || pollIntervalMs > CANVAS_PROFILE_POLL_INTERVAL_MS) throw new Error("SESSION_WAIT_LIMIT_REJECTED");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (Date.now() >= deadline) break;
      let sameOrigin = false;
      try { sameOrigin = new URL(page.url()).origin === ORIGIN; } catch { /* The broker page may still be opening. */ }
      if (!sameOrigin) continue;
      try {
        const requestTimeoutMs = Math.max(1, Math.min(MAX_PROFILE_REQUEST_TIMEOUT_MS, deadline - Date.now()));
        const available = await page.evaluate(async ({ origin, requestTimeoutMs }) => {
          if (globalThis.location.origin !== origin) return false;
          const controller = new AbortController();
          const timer = globalThis.setTimeout(() => controller.abort(), requestTimeoutMs);
          try {
            const response = await fetch(`${origin}/api/v1/users/self/profile`, {
              method: "GET",
              credentials: "same-origin",
              redirect: "manual",
              cache: "no-store",
              headers: { Accept: "application/json" },
              signal: controller.signal,
            });
            const responseUrl = new URL(response.url);
            const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
            return response.status === 200 && responseUrl.origin === origin
              && responseUrl.pathname === "/api/v1/users/self/profile" && responseUrl.search === ""
              && contentType === "application/json";
          } finally {
            globalThis.clearTimeout(timer);
          }
        }, { origin: ORIGIN, requestTimeoutMs });
        if (available) return page;
      } catch { /* SSO may still be navigating or the page may have closed. */ }
    }
    if (Date.now() < deadline) await delay(Math.min(pollIntervalMs, deadline - Date.now()));
  }
  return undefined;
}
