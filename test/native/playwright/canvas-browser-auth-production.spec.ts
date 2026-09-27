import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { collectCanvasBrowserCapture } from "../../../scripts/canvas-browser-capture.mjs";
import { fetchCanvasFileToStaging, fetchCanvasFileToStagingForTest } from "../../../scripts/canvas-browser-auth-download.mjs";

type LocalServer = { origin: string; close: () => Promise<void> };
type AuthFetchOptions = {
  page: Page;
  fileId: number;
  sourceUrl: string;
  stagingDirectory: string;
  maxBytes?: number;
  progress?: (event: { state: string; byteCount: number }) => void;
  signal?: AbortSignal;
};

const SESSION_COOKIE = "synthetic_session=not-a-real-credential";

test("real Playwright progress binding can be installed twice on one isolated page", async ({ browser }) => {
  const page = await browser.newPage();
  const evaluate = async () => {
    await page.evaluate(async () => {
      const binding = (globalThis as typeof globalThis & Record<string, unknown>)["__duegoodCanvasReaderProgress"];
      if (typeof binding !== "function") throw new Error("progress binding missing");
      await (binding as (state: string) => Promise<void>)("CANVAS_GET_STARTED");
    });
    throw Object.assign(new Error("REQUEST_FAILED"), { code: "REQUEST_FAILED" });
  };
  const collect = () => collectCanvasBrowserCapture({
    expectedUserId: 9,
    page,
    evaluate,
    reader: async () => undefined,
    htmlReader: async () => undefined,
    progress: () => {},
  });

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(collect()).rejects.toMatchObject({ code: "REQUEST_FAILED" });
      await expect(page.evaluate(() => typeof (globalThis as typeof globalThis & Record<string, unknown>)["__duegoodCanvasReaderProgress"]))
        .resolves.toBe("undefined");
    }
  } finally {
    await page.close();
  }
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<LocalServer> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP listener");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function privateTempDirectory(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "duegood-browser-file-test-"));
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { path: directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function testOnlyFetch(context: BrowserContext, options: AuthFetchOptions, origin: string) {
  const previous = process.env.DUEGOOD_SYNTHETIC_TEST;
  process.env.DUEGOOD_SYNTHETIC_TEST = "1";
  try {
    return await fetchCanvasFileToStagingForTest({ ...options, context }, origin);
  } finally {
    if (previous === undefined) delete process.env.DUEGOOD_SYNTHETIC_TEST;
    else process.env.DUEGOOD_SYNTHETIC_TEST = previous;
  }
}

async function loopbackCookieContext(browser: Browser, origin: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  try {
    await context.addCookies([{
      name: "synthetic_session",
      value: "not-a-real-credential",
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    }]);
    return context;
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

async function productionFixture(
  browser: Browser,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  let staging: Awaited<ReturnType<typeof privateTempDirectory>> | undefined;
  let server: LocalServer | undefined;
  let context: BrowserContext | undefined;
  const cleanup = async () => {
    try { await context?.close(); } finally {
      try { await server?.close(); } finally { await staging?.cleanup(); }
    }
  };
  try {
    staging = await privateTempDirectory();
    server = await listen(handler);
    context = await loopbackCookieContext(browser, server.origin);
    const page = await context.newPage();
    await page.goto(`${server.origin}/`, { waitUntil: "domcontentloaded" });
    return { staging, server, context, page, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

test("production helper captures a manual redirect in memory without contacting its Location", async ({ browser }) => {
  let fileRequests = 0;
  let followupContacts = 0;
  let cookieSeen = false;
  let fixtureOrigin = "";
  const fixture = await productionFixture(browser, (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic Canvas</title>");
      return;
    }
    if (request.url === "/followed") {
      followupContacts += 1;
      response.writeHead(200);
      response.end("must not be contacted");
      return;
    }
    fileRequests += 1;
    cookieSeen = (request.headers.cookie ?? "").includes(SESSION_COOKIE);
    response.writeHead(302, { location: `${fixtureOrigin}/followed` });
    response.end();
  });
  fixtureOrigin = fixture.server.origin;
  const { staging, server, context, page } = fixture;
  const progress: Array<{ state: string; byteCount: number }> = [];
  try {
    await expect(fetchCanvasFileToStaging({
      context,
      page,
      fileId: 812,
      sourceUrl: `${server.origin}/files/812/download?download_frd=1`,
      stagingDirectory: staging.path,
    })).rejects.toMatchObject({ code: "INVALID_FILE_URL" });
    expect(fileRequests).toBe(0);
    const result = await testOnlyFetch(context, {
      page,
      fileId: 812,
      sourceUrl: `${server.origin}/files/812/download?download_frd=1`,
      stagingDirectory: staging.path,
      progress: (event) => progress.push(event),
    }, server.origin);
    expect(result).toEqual({ kind: "redirect", fileId: 812, location: `${server.origin}/followed`, sourceAuthenticity: "unverified" });
    expect(fileRequests).toBe(1);
    expect(cookieSeen).toBe(true);
    expect(followupContacts).toBe(0);
    expect(await readdir(staging.path)).toEqual([]);
    expect(JSON.stringify(progress)).not.toContain("/followed");
  } finally {
    await fixture.cleanup();
  }
});

test("production helper refuses a redirect that Rust cannot accept", async ({ browser }) => {
  let fixtureOrigin = "";
  const fixture = await productionFixture(browser, (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic Canvas</title>");
      return;
    }
    response.writeHead(302, { location: `${fixtureOrigin}/followed` });
    response.end();
  });
  fixtureOrigin = fixture.server.origin;
  const { staging, server, context, page } = fixture;
  try {
    await expect(testOnlyFetch(context, {
      page,
      fileId: 816,
      sourceUrl: `${server.origin}/files/816/download?download_frd=1&verifier=synthetic-only`,
      stagingDirectory: staging.path,
    }, server.origin)).rejects.toMatchObject({ code: "REDIRECT_HANDOFF_UNSUPPORTED" });
    expect(await readdir(staging.path)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("production helper bypasses service workers and stages direct 200 bytes privately", async ({ browser }) => {
  const body = Buffer.from("%PDF-1.7\nsynthetic local file bytes");
  let fileRequestCount = 0;
  let fileCookieSeen = false;
  const fixture = await productionFixture(browser, (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic Canvas</title>");
      return;
    }
    if (request.url === "/sw.js") {
      response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
      response.end("self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname.startsWith('/files/'))event.respondWith(new Response('service-worker-response',{status:200,headers:{'content-type':'application/pdf'}}))})");
      return;
    }
    if (request.url === "/files/813/download?download_frd=1") {
      fileRequestCount += 1;
      fileCookieSeen = (request.headers.cookie ?? "").includes(SESSION_COOKIE);
      response.writeHead(200, { "content-type": "application/pdf", "content-length": String(body.length) });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const { staging, server, context, page } = fixture;
  try {
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    const result = await testOnlyFetch(context, {
      page,
      fileId: 813,
      sourceUrl: `${server.origin}/files/813/download?download_frd=1`,
      stagingDirectory: staging.path,
      maxBytes: 128,
    }, server.origin);
    expect(result).toMatchObject({ kind: "staged", fileId: 813, byteCount: body.length, sourceAuthenticity: "unverified" });
    if (result.kind !== "staged") throw new Error("Expected staged response");
    const file = await lstat(result.stagedPath);
    expect(file.isFile()).toBe(true);
    expect(file.mode & 0o777).toBe(0o600);
    expect(await readFile(result.stagedPath)).toEqual(body);
    expect(await readdir(staging.path)).toEqual([path.basename(result.stagedPath)]);
    expect(fileRequestCount).toBe(1);
    expect(fileCookieSeen).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

test("production helper accepts a body exactly equal to the byte cap", async ({ browser }) => {
  const body = Buffer.from("12345678");
  const fixture = await productionFixture(browser, (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic Canvas</title>");
      return;
    }
    response.writeHead(200, { "content-length": String(body.length) });
    response.end(body);
  });
  const { staging, server, context, page } = fixture;
  try {
    const pagesBefore = context.pages().length;
    const urlBefore = page.url();
    let navigations = 0;
    const trackNavigation = () => { navigations += 1; };
    page.on("framenavigated", trackNavigation);
    const result = await testOnlyFetch(context, {
      page,
      fileId: 814,
      sourceUrl: `${server.origin}/files/814/download?download_frd=1`,
      stagingDirectory: staging.path,
      maxBytes: body.length,
    }, server.origin);
    expect(result).toMatchObject({ kind: "staged", fileId: 814, byteCount: body.length, sourceAuthenticity: "unverified" });
    if (result.kind !== "staged") throw new Error("Expected staged response");
    expect(await readFile(result.stagedPath)).toEqual(body);
    expect((await lstat(result.stagedPath)).size).toBe(body.length);
    page.off("framenavigated", trackNavigation);
    expect(context.pages()).toHaveLength(pagesBefore);
    expect(page.url()).toBe(urlBefore);
    expect(navigations).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test("production helper discards an over-cap stream", async ({ browser }) => {
  const body = Buffer.from("123456789");
  const fixture = await productionFixture(browser, (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic Canvas</title>");
      return;
    }
    response.writeHead(200, { "transfer-encoding": "chunked" });
    response.end(body);
  });
  const { staging, server, context, page } = fixture;
  try {
    await expect(testOnlyFetch(context, {
      page,
      fileId: 817,
      sourceUrl: `${server.origin}/files/817/download?download_frd=1`,
      stagingDirectory: staging.path,
      maxBytes: body.length - 1,
    }, server.origin)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(await readdir(staging.path)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("production helper removes partial staging bytes when canceled", async ({ browser }) => {
  const body = Buffer.alloc(160 * 1024, 0x41);
  const fixture = await productionFixture(browser, (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic Canvas</title>");
      return;
    }
    response.writeHead(200, { "content-length": String(body.length) });
    response.end(body);
  });
  const { staging, server, context, page } = fixture;
  const controller = new AbortController();
  const progress: Array<{ state: string; byteCount: number }> = [];
  try {
    const transfer = testOnlyFetch(context, {
      page,
      fileId: 815,
      sourceUrl: `${server.origin}/files/815/download?download_frd=1`,
      stagingDirectory: staging.path,
      progress: (event) => {
        progress.push(event);
        if (event.state === "STREAMING") controller.abort();
      },
      signal: controller.signal,
    }, server.origin);
    await expect(transfer).rejects.toMatchObject({ code: "CANCELED" });
    expect(progress.some(({ state, byteCount }) => state === "STREAMING" && byteCount > 0 && byteCount < body.length)).toBe(true);
    expect(await readdir(staging.path)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});
