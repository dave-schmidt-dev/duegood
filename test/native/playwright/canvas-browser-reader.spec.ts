import { expect, test } from "@playwright/test";
import { readCanvasBrowserApi } from "../../../scripts/canvas-browser-reader.mjs";
import { runCanvasBrowserProbe } from "../../../scripts/canvas-browser-probe.mjs";

const ORIGIN = "https://marymount.instructure.com";

test("browser probe stays content-free, preserves unread state, and withholds cookies from ranged downloads", async ({ page, context }) => {
  const apiCalls: Array<{ url: URL; method: string; cookie: string | null; authorization: string | null; range: string | null }> = [];
  const unreadConversationIds = [7001];
  let unexpectedOutbound = false;
  await context.addCookies([{
    name: "synthetic_session",
    value: "synthetic-cookie-value",
    domain: "marymount.instructure.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) {
      unexpectedOutbound = true;
      await route.abort();
      return;
    }
    if (request.isNavigationRequest() && url.pathname === "/") {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic probe page</title>" });
      return;
    }
    const headers = await request.allHeaders();
    apiCalls.push({
      url,
      method: request.method(),
      cookie: headers.cookie ?? null,
      authorization: headers.authorization ?? null,
      range: headers.range ?? null,
    });
    const body = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/v1/users/self/profile") return body({ id: 41, name: "Synthetic learner", primary_email: "student@example.invalid" });
    if (url.pathname === "/api/v1/courses" && url.searchParams.get("enrollment_state") === "completed") return body([]);
    if (url.pathname === "/api/v1/courses" && url.searchParams.get("page") === "2") return body([]);
    if (url.pathname === "/api/v1/courses") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { link: `<${ORIGIN}/api/v1/courses?enrollment_state=active&per_page=1&page=2>; rel="next"` },
        body: JSON.stringify([{ id: 88, name: "Synthetic course" }]),
      });
    }
    if (url.pathname === "/api/v1/courses/88") return body({ id: 88, name: "Synthetic course" });
    if (url.pathname === "/api/v1/conversations") return body(unreadConversationIds.map((id) => ({ id, subject: "Synthetic Inbox subject", last_message: "Private synthetic text" })));
    if (url.pathname === "/api/v1/conversations/7001") return body({ id: 7001, messages: [{ body: "Private synthetic message" }] });
    if (url.pathname === "/api/v1/courses/88/files") return body([{ id: 9001, display_name: "Synthetic handout.pdf" }]);
    if (url.pathname === "/api/v1/files/9001") return body({ id: 9001, url: `${ORIGIN}/files/9001/download?download_frd=1` });
    if (url.pathname === "/files/9001/download") {
      return route.fulfill({
        status: 206,
        contentType: "application/octet-stream",
        headers: { "content-range": "bytes 0-0/1", "content-length": "1" },
        body: "x",
      });
    }
    await route.abort();
    throw new Error(`Unexpected intercepted path: ${url.pathname}`);
  });

  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(readCanvasBrowserApi, { mode: "probe" });
  expect(result).toEqual({
    signedInContinuity: "OK",
    accountIdentity: "AVAILABLE_UNBOUND",
    apiShapePagination: "OK",
    inboxUnreadState: "UNCHANGED",
    fileMetadata: "AVAILABLE",
    fileVerifier: "MISSING",
    cookielessDownload: "BROWSER_RANGE_AVAILABLE",
    nativeDownloader: "NOT_TESTED",
  });
  expect(unreadConversationIds).toEqual([7001]);
  expect(unexpectedOutbound).toBe(false);
  expect(apiCalls.length).toBeGreaterThan(5);
  expect(apiCalls.filter((call) => call.url.pathname === "/api/v1/courses"
    && call.url.searchParams.get("enrollment_state") === "active")).toHaveLength(1);
  expect(apiCalls.every((call) => call.method === "GET" && call.authorization === null)).toBe(true);
  expect(apiCalls.filter((call) => call.url.pathname.startsWith("/api/")).every((call) => call.cookie === "synthetic_session=synthetic-cookie-value")).toBe(true);
  const detail = apiCalls.find((call) => call.url.pathname === "/api/v1/conversations/7001");
  expect(detail?.url.searchParams.get("auto_mark_as_read")).toBe("false");
  const download = apiCalls.find((call) => call.url.pathname === "/files/9001/download");
  expect(download?.cookie).toBeNull();
  expect(download?.range).toBe("bytes=0-0");
  const report = JSON.stringify(result);
  for (const privateValue of ["Synthetic learner", "student@example.invalid", "Synthetic course", "Synthetic Inbox subject", "Private synthetic text", "Private synthetic message", "Synthetic handout.pdf", "synthetic-cookie-value"]) {
    expect(report).not.toContain(privateValue);
  }
});

test("attended probe waits for sign-in in its browser context, probes there, and closes it", async ({ browser }) => {
  let context: Awaited<ReturnType<typeof browser.newContext>>;
  let signedIn = false;
  let profileReady = false;
  let closed = false;
  let sessionPageVisible = false;
  let signalFirstUnauthenticatedProfile!: () => void;
  let signalFirstHtmlProfile!: () => void;
  const firstUnauthenticatedProfile = new Promise<void>((resolve) => { signalFirstUnauthenticatedProfile = resolve; });
  const firstHtmlProfile = new Promise<void>((resolve) => { signalFirstHtmlProfile = resolve; });
  const profileRequests: Array<{ state: string; hasSessionCookie: boolean }> = [];
  const paths: string[] = [];

  const probe = runCanvasBrowserProbe({
    attended: true,
    waitTimeoutMs: 2_000,
    pollIntervalMs: 10,
    progress: () => {},
    launchContext: async () => {
      context = await browser.newContext();
      const close = context.close.bind(context);
      context.close = async () => {
        sessionPageVisible = await context.pages()[0]?.getByRole("heading", {
          name: "Due Good Canvas session is active",
        }).isVisible() ?? false;
        closed = true;
        await close();
      };
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== ORIGIN) return route.abort();
        paths.push(url.pathname);
        const respond = (value: unknown, status = 200) => route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(value),
        });
        if (request.isNavigationRequest() && url.pathname === "/") {
          return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic sign-in</title>" });
        }
        if (url.pathname === "/api/v1/users/self/profile") {
          const headers = await request.allHeaders();
          const hasSessionCookie = headers.cookie?.includes("synthetic_session=active") ?? false;
          if (!signedIn) {
            profileRequests.push({ state: "unauthenticated", hasSessionCookie });
            signalFirstUnauthenticatedProfile();
            return respond({}, 401);
          }
          if (!profileReady) {
            profileRequests.push({ state: "html_sign_in", hasSessionCookie });
            signalFirstHtmlProfile();
            return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Sign in</title>" });
          }
          profileRequests.push({ state: "profile_api", hasSessionCookie });
          return respond({ id: 41, name: "Synthetic learner" });
        }
        if (url.pathname === "/api/v1/courses") return respond([]);
        if (url.pathname === "/api/v1/conversations") return respond([]);
        return route.abort();
      });
      return context;
    },
  });

  await firstUnauthenticatedProfile;
  await context!.addCookies([{
    name: "synthetic_session",
    value: "active",
    url: ORIGIN,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
  signedIn = true;
  await firstHtmlProfile;
  profileReady = true;
  const result = await probe;

  expect(result).toMatchObject({
    status: "PARTIAL",
    checks: {
      signedInContinuity: "OK",
      accountIdentity: "AVAILABLE_UNBOUND",
      apiShapePagination: "NO_COURSES",
      inboxUnreadState: "NO_UNREAD_ITEMS",
      fileMetadata: "NO_COURSE",
      fileVerifier: "NO_COURSE",
      cookielessDownload: "NO_COURSE",
      nativeDownloader: "NOT_TESTED",
    },
  });
  expect(profileRequests).toEqual([
    { state: "unauthenticated", hasSessionCookie: false },
    { state: "html_sign_in", hasSessionCookie: true },
    { state: "profile_api", hasSessionCookie: true },
    { state: "profile_api", hasSessionCookie: true },
  ]);
  expect(paths).toContain("/api/v1/courses");
  expect(paths).toContain("/api/v1/conversations");
  expect(sessionPageVisible).toBe(true);
  expect(closed).toBe(true);
});

test("attended probe closes its browser context when sign-in never completes", async ({ browser }) => {
  let closed = false;
  const result = await runCanvasBrowserProbe({
    attended: true,
    waitTimeoutMs: 50,
    pollIntervalMs: 10,
    progress: () => {},
    launchContext: async () => {
      const context = await browser.newContext();
      const close = context.close.bind(context);
      context.close = async () => {
        closed = true;
        await close();
      };
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (route.request().isNavigationRequest()) {
          return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic sign-in</title>" });
        }
        return route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
      });
      return context;
    },
  });

  expect(result).toMatchObject({ status: "SESSION_UNAVAILABLE" });
  expect(closed).toBe(true);
});
