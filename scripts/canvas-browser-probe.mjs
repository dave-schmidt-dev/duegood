import { access, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { readCanvasBrowserApi } from "./canvas-browser-reader.mjs";
import { waitForCanvasProfile } from "./canvas-browser-session-wait.mjs";

const ORIGIN = "https://marymount.instructure.com";
const PROFILE_DIR = path.join(homedir(), "Library", "Application Support", "DueGood", "canvas-capture-profile");
const ATTENDED_WAIT_MS = 5 * 60_000;
const ATTENDED_POLL_MS = 1_000;
const PROBE_BUDGET_MS = 90_000;
const PROBE_HEARTBEAT_MS = 10_000;
const SESSION_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Due Good Canvas session</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #101820; color: #eef3f6; font: 16px system-ui, sans-serif; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  p { line-height: 1.5; color: #c5d1d9; }
</style>
<main><h1>Due Good Canvas session is active</h1>
<p>You can minimize this window. Keep Chrome open to preserve the current session.</p></main>
</html>`;
const UNAVAILABLE = Object.freeze({
  signedInContinuity: "UNAVAILABLE",
  accountIdentity: "UNAVAILABLE",
  apiShapePagination: "UNAVAILABLE",
  inboxUnreadState: "UNAVAILABLE",
  fileMetadata: "UNAVAILABLE",
  fileVerifier: "UNAVAILABLE",
  cookielessDownload: "UNAVAILABLE",
  nativeDownloader: "NOT_TESTED",
});

/** A browser-only check cannot certify the separate native file downloader. */
export function classifyProbe(checks) {
  if (checks.accountIdentity === "MISMATCH") return "IDENTITY_MISMATCH";
  if (checks.signedInContinuity !== "OK") return "SESSION_UNAVAILABLE";
  return checks.nativeDownloader === "VERIFIED" ? "COMPLETE" : "PARTIAL";
}

async function expectedUserIdFromArgs(args) {
  if (args.length === 0) return { kind: "unbound" };
  if (args.length !== 1 || args[0] !== "--confirm-local-binding" || !process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return { kind: "invalid" };
  }
  process.stderr.write("LOCAL_BINDING_INPUT=Enter the owner-confirmed Canvas user ID (input hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const finish = (kind, id) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      resolve({ kind, id });
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish("invalid");
        if (character === "\r" || character === "\n") {
          const id = Number(value);
          return finish(Number.isSafeInteger(id) && id > 0 ? "bound" : "invalid", id);
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (/\d/.test(character) && value.length < 16) value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

function print(status, checks) {
  process.stdout.write(`${JSON.stringify({ status, checks })}\n`);
}

async function profileLockPresent() {
  try {
    await access(PROFILE_DIR);
    await lstat(path.join(PROFILE_DIR, "SingletonLock"));
    return true;
  } catch { return false; }
}

async function restrictToProbeReads(context) {
  const handler = async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { return route.abort(); }
    const apiPath = /^\/api\/v1\/(?:users\/self\/profile|courses(?:\/\d+)?|courses\/\d+\/files|conversations(?:\/\d+)?|files\/\d+)$/.test(url.pathname);
    const filePath = /^\/files\/\d+\/download$/.test(url.pathname);
    if (request.isNavigationRequest() || request.method() !== "GET" || url.origin !== ORIGIN
        || request.resourceType() !== "fetch" || (!apiPath && !filePath)) {
      return route.abort();
    }
    return route.fallback();
  };
  await context.route("**/*", handler);
  return handler;
}

/** Run the content-free probe in a launched browser context and always close it. */
export async function runCanvasBrowserProbe({
  launchContext,
  context: providedContext = undefined,
  closeContext = true,
  attended = false,
  expectedUserId = undefined,
  waitTimeoutMs = ATTENDED_WAIT_MS,
  pollIntervalMs = ATTENDED_POLL_MS,
  progress = () => {},
}) {
  let context = providedContext;
  if (!context) {
    try {
      context = await launchContext();
    } catch {
      return { status: "CHROME_UNAVAILABLE", checks: UNAVAILABLE };
    }
  }
  let heartbeat;
  let cdp;
  let probeRoute;
  try {
    let page = context.pages()[0] ?? await context.newPage();
    cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

    if (attended) {
      await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      progress("WAITING_FOR_OWNER_SIGN_IN");
      const signedInPage = await waitForCanvasProfile(context, waitTimeoutMs, pollIntervalMs);
      if (!signedInPage) return { status: "SESSION_UNAVAILABLE", checks: UNAVAILABLE };
      page = signedInPage;
      progress("CANVAS_SESSION_AVAILABLE");
      probeRoute = await restrictToProbeReads(context);
      await signedInPage.setContent(SESSION_PAGE);
    } else {
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          let requestOrigin;
          try { requestOrigin = new URL(request.url()).origin; } catch { requestOrigin = ""; }
          if (requestOrigin !== ORIGIN) return route.abort();
          if (request.url() === `${ORIGIN}/`) {
            return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Canvas session probe</title>" });
          }
        }
        return route.continue();
      });
      await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    }

    const request = expectedUserId === undefined
      ? { mode: "probe", timeoutMs: PROBE_BUDGET_MS }
      : { mode: "probe", expectedUserId, timeoutMs: PROBE_BUDGET_MS };
    progress("CHECKING_CANVAS_SESSION");
    progress("PROBE_RUNNING");
    heartbeat = setInterval(() => progress("PROBE_HEARTBEAT"), PROBE_HEARTBEAT_MS);
    const checks = await page.evaluate(readCanvasBrowserApi, request);
    return { status: classifyProbe(checks), checks };
  } catch {
    return { status: "SESSION_UNAVAILABLE", checks: UNAVAILABLE };
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (probeRoute) await context.unroute("**/*", probeRoute).catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
    if (closeContext) await context.close().catch(() => undefined);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const attended = args.includes("--attended");
  const bindingArgs = args.filter((argument) => argument !== "--attended");
  if (args.filter((argument) => argument === "--attended").length > 1) {
    print("INVALID_CONFIGURATION", UNAVAILABLE);
    process.exitCode = 2;
    return;
  }
  const binding = await expectedUserIdFromArgs(bindingArgs);
  if (binding.kind === "invalid") {
    print("INVALID_CONFIGURATION", UNAVAILABLE);
    process.exitCode = 2;
    return;
  }
  const expectedUserId = binding.id;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const profilePath = path.resolve(PROFILE_DIR);
  if (profilePath === projectRoot || profilePath.startsWith(`${projectRoot}${path.sep}`)) {
    print("INVALID_CONFIGURATION", UNAVAILABLE);
    process.exitCode = 2;
    return;
  }
  if (await profileLockPresent()) {
    print("PROFILE_BUSY", UNAVAILABLE);
    process.exitCode = 2;
    return;
  }

  process.stderr.write(`PROBE_PROGRESS=${attended ? "LAUNCHING_HEADED_CHROME" : "LAUNCHING_DEDICATED_CHROME"}\n`);
  try {
    await mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
    const result = await runCanvasBrowserProbe({
      launchContext: () => chromium.launchPersistentContext(PROFILE_DIR, {
        channel: "chrome",
        headless: !attended,
        args: ["--disable-http-cache"],
        timeout: 20_000,
      }),
      attended,
      expectedUserId,
      progress: (status) => process.stderr.write(`PROBE_PROGRESS=${status}\n`),
    });
    print(result.status, result.checks);
    process.exitCode = result.status === "COMPLETE" ? 0 : result.status === "CHROME_UNAVAILABLE" ? 1 : result.status === "INVALID_CONFIGURATION" ? 2 : 1;
  } catch {
    print("CHROME_UNAVAILABLE", UNAVAILABLE);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
