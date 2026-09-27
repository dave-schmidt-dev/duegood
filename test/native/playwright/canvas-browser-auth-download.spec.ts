import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { expect, test, type Page } from "@playwright/test";

type LocalServer = { origin: string; close: () => Promise<void> };
type Header = { name: string; value: string };
type PausedRequest = {
  requestId: string;
  request: { url: string; headers: Record<string, string> };
  responseStatusCode?: number;
  responseHeaders?: Header[];
  redirectedRequestId?: string;
};
type PausedObservation = {
  origin: string;
  pathname: string;
  redirected: boolean;
  hasSessionCookie: boolean;
};
type RedirectObservation = { origin: string; status: number; location?: string };
type InterceptorOptions = {
  allowedOrigins: string[];
  maxBytes: number;
  pageOrigin: string;
};
type Interceptor = {
  paused: PausedObservation[];
  rejected: PausedObservation[];
  redirects: RedirectObservation[];
  errors: string[];
  streamedBytes: number;
  streamEnded: boolean;
  canceled: boolean;
  fulfilled: boolean;
  close: () => Promise<void>;
};

const SESSION_COOKIE = "synthetic_session=not-a-real-credential";

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

function corsHeaders(pageOrigin: string): Record<string, string> {
  return {
    "access-control-allow-origin": pageOrigin,
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": "content-type",
  };
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function selectedResponseHeaders(headers: Header[] = []): Header[] {
  const allowed = new Set([
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-expose-headers",
    "content-type",
  ]);
  return headers.filter(({ name }) => allowed.has(name.toLowerCase()));
}

async function installInterceptor(page: Page, options: InterceptorOptions): Promise<Interceptor> {
  const cdp = await page.context().newCDPSession(page);
  const result: Interceptor = {
    paused: [],
    rejected: [],
    redirects: [],
    errors: [],
    streamedBytes: 0,
    streamEnded: false,
    canceled: false,
    fulfilled: false,
    close: async () => {
      await cdp.send("Fetch.disable").catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
  const allowed = new Set(options.allowedOrigins);

  cdp.on("Fetch.requestPaused", (event) => {
    const paused = event as PausedRequest;
    void (async () => {
      const url = new URL(paused.request.url);
      const observation: PausedObservation = {
        origin: url.origin,
        pathname: url.pathname,
        redirected: paused.redirectedRequestId !== undefined,
        hasSessionCookie: (headerValue(paused.request.headers, "cookie") ?? "").includes(SESSION_COOKIE),
      };
      if (!allowed.has(url.origin)) {
        result.rejected.push(observation);
        await cdp.send("Fetch.failRequest", { requestId: paused.requestId, errorReason: "BlockedByClient" });
        return;
      }
      result.paused.push(observation);

      if (paused.responseStatusCode === undefined) {
        await cdp.send("Fetch.continueRequest", { requestId: paused.requestId, interceptResponse: true });
        return;
      }

      const location = paused.responseHeaders?.find(({ name }) => name.toLowerCase() === "location")?.value;
      if (paused.responseStatusCode >= 300 && paused.responseStatusCode < 400 && location) {
        result.redirects.push({ origin: url.origin, status: paused.responseStatusCode, location });
        await cdp.send("Fetch.continueResponse", { requestId: paused.requestId });
        return;
      }

      const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", { requestId: paused.requestId });
      const chunks: Buffer[] = [];
      let endOfStream = false;
      try {
        while (result.streamedBytes < options.maxBytes) {
          const remaining = options.maxBytes - result.streamedBytes;
          const read = await cdp.send("IO.read", { handle: stream, size: remaining });
          const chunk = read.base64Encoded ? Buffer.from(read.data, "base64") : Buffer.from(read.data, "utf8");
          if (chunk.length > remaining) throw new Error("CDP returned more than the requested stream read size");
          if (chunk.length > 0) chunks.push(chunk);
          result.streamedBytes += chunk.length;
          if (read.eof) {
            endOfStream = true;
            result.streamEnded = true;
            break;
          }
        }

        if (endOfStream) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId: paused.requestId,
            responseCode: paused.responseStatusCode,
            responseHeaders: selectedResponseHeaders(paused.responseHeaders),
            body: Buffer.concat(chunks).toString("base64"),
          });
          result.fulfilled = true;
        } else {
          result.canceled = true;
          await cdp.send("Fetch.failRequest", { requestId: paused.requestId, errorReason: "BlockedByClient" });
        }
      } finally {
        await cdp.send("IO.close", { handle: stream }).catch(() => undefined);
      }
    })().catch((error: unknown) => result.errors.push(error instanceof Error ? error.message : String(error)));
  });

  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  return result;
}

async function openPage(page: Page, source: LocalServer): Promise<string> {
  // localhost is used for the page while all destination fixtures use 127.0.0.1,
  // making the browser requests cross-origin without leaving loopback.
  const pageOrigin = source.origin.replace("127.0.0.1", "localhost");
  await page.goto(`${pageOrigin}/`, { waitUntil: "domcontentloaded" });
  await page.context().addCookies([{
    name: "synthetic_session",
    value: "not-a-real-credential",
    url: pageOrigin,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  return pageOrigin;
}

function redirect(status: ServerResponse, location: string, pageOrigin: string): void {
  status.writeHead(302, { location, ...corsHeaders(pageOrigin) });
  status.end();
}

test("CDP pauses every redirect target before contact and rejects a denied host", async ({ browser }) => {
  let sourceSawCookie = false;
  let allowedSawCookie = false;
  let deniedContacts = 0;
  let sourceOrigin = "";
  let allowedOrigin = "";
  const denied = await listen((_request, response) => {
    deniedContacts += 1;
    response.writeHead(200, corsHeaders(sourceOrigin));
    response.end("should never reach this server");
  });
  const allowed = await listen((request, response) => {
    allowedSawCookie = (request.headers.cookie ?? "").includes(SESSION_COOKIE);
    if (request.url === "/to-denied") return redirect(response, `${denied.origin}/never`, sourceOrigin);
    response.writeHead(404);
    response.end();
  });
  allowedOrigin = allowed.origin;
  const source = await listen((request, response) => {
    sourceSawCookie = (request.headers.cookie ?? "").includes(SESSION_COOKIE);
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic source</title>");
      return;
    }
    if (request.url === "/start") return redirect(response, `${allowedOrigin}/to-denied`, sourceOrigin);
    response.writeHead(404);
    response.end();
  });
  sourceOrigin = source.origin.replace("127.0.0.1", "localhost");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openPage(page, source);
    const interceptor = await installInterceptor(page, { allowedOrigins: [sourceOrigin, allowedOrigin], maxBytes: 128, pageOrigin: sourceOrigin });
    try {
      const fetchResult = await page.evaluate(async () => {
        try {
          await fetch("/start", { credentials: "include" });
          return "unexpected success";
        } catch {
          return "blocked";
        }
      });
      expect(fetchResult).toBe("blocked");
      expect(sourceSawCookie).toBe(true);
      expect(allowedSawCookie).toBe(false);
      expect(deniedContacts).toBe(0);
      expect(interceptor.paused.map(({ origin }) => origin)).toContain(sourceOrigin);
      expect(interceptor.paused.map(({ origin }) => origin)).toContain(allowedOrigin);
      expect(interceptor.rejected).toEqual([{
        origin: denied.origin,
        pathname: "/never",
        redirected: true,
        hasSessionCookie: false,
      }]);
      expect(interceptor.errors).toEqual([]);
    } finally {
      await interceptor.close();
    }
  } finally {
    await context.close();
    await Promise.all([source.close(), allowed.close(), denied.close()]);
  }
});

test("manual browser redirect exposes Location to CDP without contacting its destination", async ({ browser }) => {
  let sourceOrigin = "";
  let deniedContacts = 0;
  let sourceSawCookie = false;
  const denied = await listen((_request, response) => {
    deniedContacts += 1;
    response.writeHead(200);
    response.end("must remain untouched");
  });
  const source = await listen((request, response) => {
    sourceSawCookie = (request.headers.cookie ?? "").includes(SESSION_COOKIE);
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic source</title>");
      return;
    }
    if (request.url === "/manual") return redirect(response, `${denied.origin}/file`, sourceOrigin);
    response.writeHead(404);
    response.end();
  });
  sourceOrigin = source.origin.replace("127.0.0.1", "localhost");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openPage(page, source);
    const interceptor = await installInterceptor(page, { allowedOrigins: [sourceOrigin], maxBytes: 128, pageOrigin: sourceOrigin });
    try {
      const response = await page.evaluate(async () => {
        const result = await fetch("/manual", { credentials: "same-origin", redirect: "manual" });
        return { type: result.type, status: result.status };
      });
      expect(response).toEqual({ type: "opaqueredirect", status: 0 });
      expect(sourceSawCookie).toBe(true);
      expect(deniedContacts).toBe(0);
      expect(interceptor.redirects).toEqual([{
        origin: sourceOrigin,
        status: 302,
        location: `${denied.origin}/file`,
      }]);
      expect(interceptor.rejected).toHaveLength(0);
      expect(interceptor.errors).toEqual([]);
    } finally {
      await interceptor.close();
    }
  } finally {
    await context.close();
    await Promise.all([source.close(), denied.close()]);
  }
});

test("CDP streams a browser-authenticated cross-origin response under the byte cap without exposing cookies", async ({ browser }) => {
  const body = Buffer.from("synthetic-file-content");
  let sourceOrigin = "";
  let sourceSawCookie = false;
  let allowedSawCookie = false;
  let allowedOrigin = "";
  const allowed = await listen((request, response) => {
    allowedSawCookie = (request.headers.cookie ?? "").includes(SESSION_COOKIE);
    response.writeHead(200, { "content-type": "application/octet-stream", ...corsHeaders(sourceOrigin) });
    response.end(body);
  });
  allowedOrigin = allowed.origin;
  const source = await listen((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic source</title>");
      return;
    }
    sourceSawCookie = (request.headers.cookie ?? "").includes(SESSION_COOKIE);
    if (request.url === "/download") return redirect(response, `${allowedOrigin}/file`, sourceOrigin);
    response.writeHead(404);
    response.end();
  });
  sourceOrigin = source.origin.replace("127.0.0.1", "localhost");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openPage(page, source);
    const interceptor = await installInterceptor(page, { allowedOrigins: [sourceOrigin, allowedOrigin], maxBytes: 64, pageOrigin: sourceOrigin });
    try {
      const fetched = await page.evaluate(async () => {
        const response = await fetch("/download", { credentials: "include" });
        return { status: response.status, body: await response.text() };
      });
      expect(fetched).toEqual({ status: 200, body: body.toString() });
      expect(interceptor.streamedBytes).toBe(body.length);
      expect(interceptor.streamedBytes).toBeLessThanOrEqual(64);
      expect(interceptor.streamEnded).toBe(true);
      expect(interceptor.fulfilled).toBe(true);
      expect(interceptor.canceled).toBe(false);
      expect(sourceSawCookie).toBe(true);
      expect(allowedSawCookie).toBe(false);
      expect(interceptor.paused.some(({ pathname, origin }) => origin === allowedOrigin && pathname === "/file")).toBe(true);
      expect(interceptor.errors).toEqual([]);
      expect(JSON.stringify(interceptor)).not.toContain("not-a-real-credential");
    } finally {
      await interceptor.close();
    }
  } finally {
    await context.close();
    await Promise.all([source.close(), allowed.close()]);
  }
});

test("CDP cancels an oversized response after reading at most the configured bytes", async ({ browser }) => {
  const chunk = Buffer.from("0123456789abcdef");
  let sourceOrigin = "";
  let allowedOrigin = "";
  let responseClosedBeforeFinish = false;
  const allowed = await listen((request, response) => {
    if (request.url !== "/large") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream", ...corsHeaders(sourceOrigin) });
    let sent = 0;
    const timer = setInterval(() => {
      if (response.destroyed) {
        clearInterval(timer);
        return;
      }
      sent += 1;
      response.write(chunk);
      if (sent === 200) {
        clearInterval(timer);
        response.end();
      }
    }, 5);
    response.on("finish", () => clearInterval(timer));
    response.on("close", () => {
      clearInterval(timer);
      if (!response.writableFinished) responseClosedBeforeFinish = true;
    });
  });
  allowedOrigin = allowed.origin;
  const source = await listen((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic source</title>");
      return;
    }
    if (request.url === "/download") return redirect(response, `${allowedOrigin}/large`, sourceOrigin);
    response.writeHead(404);
    response.end();
  });
  sourceOrigin = source.origin.replace("127.0.0.1", "localhost");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openPage(page, source);
    const cap = 17;
    const interceptor = await installInterceptor(page, { allowedOrigins: [sourceOrigin, allowedOrigin], maxBytes: cap, pageOrigin: sourceOrigin });
    try {
      const fetchResult = await page.evaluate(async () => {
        try {
          await fetch("/download", { credentials: "include" });
          return "unexpected success";
        } catch {
          return "canceled";
        }
      });
      await expect.poll(() => responseClosedBeforeFinish, { timeout: 3_000 }).toBe(true);
      expect(fetchResult).toBe("canceled");
      expect(interceptor.streamedBytes).toBe(cap);
      expect(interceptor.streamedBytes).toBeLessThanOrEqual(cap);
      expect(interceptor.streamEnded).toBe(false);
      expect(interceptor.canceled).toBe(true);
      expect(interceptor.fulfilled).toBe(false);
      expect(interceptor.errors).toEqual([]);
    } finally {
      await interceptor.close();
    }
  } finally {
    await context.close();
    await Promise.all([source.close(), allowed.close()]);
  }
});

test("CDP can stream the bounded response before browser CORS rejects it", async ({ browser }) => {
  const body = Buffer.from("synthetic-cross-origin-body-without-cors");
  let sourceOrigin = "";
  let allowedOrigin = "";
  const allowed = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(body);
  });
  allowedOrigin = allowed.origin;
  const source = await listen((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>synthetic source</title>");
      return;
    }
    if (request.url === "/download") return redirect(response, `${allowedOrigin}/file`, sourceOrigin);
    response.writeHead(404);
    response.end();
  });
  sourceOrigin = source.origin.replace("127.0.0.1", "localhost");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openPage(page, source);
    const interceptor = await installInterceptor(page, { allowedOrigins: [sourceOrigin, allowedOrigin], maxBytes: 128, pageOrigin: sourceOrigin });
    try {
      const fetchResult = await page.evaluate(async () => {
        try {
          await fetch("/download", { credentials: "include" });
          return "unexpected success";
        } catch {
          return "blocked by browser CORS";
        }
      });
      expect(fetchResult).toBe("blocked by browser CORS");
      expect(interceptor.streamedBytes).toBe(body.length);
      expect(interceptor.streamEnded).toBe(true);
      expect(interceptor.fulfilled).toBe(true);
      expect(interceptor.canceled).toBe(false);
      expect(interceptor.errors).toEqual([]);
    } finally {
      await interceptor.close();
    }
  } finally {
    await context.close();
    await Promise.all([source.close(), allowed.close()]);
  }
});
