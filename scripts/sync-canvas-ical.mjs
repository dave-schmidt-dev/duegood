#!/usr/bin/env node
/**
 * Fetches a private Canvas calendar feed into the local, CSRF-protected byte
 * importer. The feed URL is intentionally never accepted from argv or disk.
 */

export const CANVAS_ICAL_ENV = "DUEGOOD_CANVAS_ICAL_URL";
export const ICAL_IMPORT_ORIGIN_ENV = "DUEGOOD_ICAL_IMPORT_ORIGIN";
export const CANVAS_ICAL_ORIGIN = "https://marymount.instructure.com";
export const MAX_ICAL_FETCH_BYTES = 5 * 1024 * 1024;
export const ICAL_FETCH_TIMEOUT_MS = 15_000;

export class IcalFetchError extends Error {
  constructor(code) {
    super(code);
    this.name = "IcalFetchError";
    this.code = code;
  }
}

function fail(code) {
  throw new IcalFetchError(code);
}

/** Validates the only supported private Canvas iCal URL family without retaining it. */
export function validateCanvasIcalUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) fail("INVALID_FEED_URL");
  const authority = /^https:\/\/([^/?#]+)/u.exec(value)?.[1];
  if (authority !== "marymount.instructure.com") fail("INVALID_FEED_URL");
  let url;
  try { url = new URL(value); } catch { fail("INVALID_FEED_URL"); }
  if (url.protocol !== "https:" || url.origin !== CANVAS_ICAL_ORIGIN || url.username || url.password
      || url.port || url.search || url.hash || !/^\/feeds\/calendars\/[A-Za-z0-9_-]+(?:\.ics)?$/u.test(url.pathname)) {
    fail("INVALID_FEED_URL");
  }
  return url;
}

/** Accepts only the broker's fixed loopback destination, never an argv target. */
export function loopbackOrigin(value) {
  if (typeof value !== "string") fail("INVALID_IMPORT_TARGET");
  let target;
  try { target = new URL(value); } catch { fail("INVALID_IMPORT_TARGET"); }
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port
      || target.username || target.password || target.pathname !== "/" || target.search || target.hash
      || value !== target.origin) {
    fail("INVALID_IMPORT_TARGET");
  }
  return target.origin;
}

async function boundedLaunch(readInput, expectedOrigin) {
  const bytes = await readInput();
  if (bytes.byteLength === 0 || bytes.byteLength > 512) fail("INVALID_IMPORT_LAUNCH");
  let launch;
  try { launch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("INVALID_IMPORT_LAUNCH"); }
  if (!launch || typeof launch !== "object" || Array.isArray(launch)
      || Object.keys(launch).length !== 2 || launch.origin !== expectedOrigin
      || typeof launch.csrfToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(launch.csrfToken)) {
    fail("INVALID_IMPORT_LAUNCH");
  }
  return launch.csrfToken;
}

function fetchFailure(error) {
  if (error instanceof IcalFetchError) return error;
  if ((error instanceof DOMException && error.name === "AbortError") || (error && typeof error === "object" && error.name === "AbortError")) return new IcalFetchError("TIMEOUT");
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/dns|getaddrinfo|enotfound|certificate|tls|ssl|handshake/u.test(message)) return new IcalFetchError("DNS_OR_TLS_FAILURE");
  return new IcalFetchError("NETWORK_FAILURE");
}

/** Fetches only bounded bytes, rejecting redirects and every non-calendar response. */
export async function fetchCalendarBytes(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), ICAL_FETCH_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { Accept: "text/calendar" } });
    } catch (error) { throw fetchFailure(error); }
    if (response.status >= 300 && response.status < 400) fail("REDIRECT_REJECTED");
    if (!response.ok || !/^text\/calendar(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) fail("RESPONSE_REJECTED");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && (declared < 0 || declared > MAX_ICAL_FETCH_BYTES)) fail("OVERSIZE");
    if (!response.body) fail("RESPONSE_REJECTED");
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      let part;
      try { part = await reader.read(); } catch (error) { throw fetchFailure(error); }
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_ICAL_FETCH_BYTES) {
        await reader.cancel();
        fail("OVERSIZE");
      }
      chunks.push(part.value);
    }
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  } finally {
    clearTimeout(deadline);
  }
}

async function stdinBytes() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > 512) fail("INVALID_IMPORT_LAUNCH");
    chunks.push(bytes);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

/** Runs the host-only fetcher. Status values are codes/counts only, never feed content or URL text. */
export async function run(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const onStatus = dependencies.onStatus ?? ((status) => process.stderr.write(`duegood-ical: ${status}\n`));
  if (argv.length !== 0) fail("INVALID_IMPORT_TARGET");
  const target = loopbackOrigin(env[ICAL_IMPORT_ORIGIN_ENV]);
  const feed = validateCanvasIcalUrl(env[CANVAS_ICAL_ENV]);
  const token = await boundedLaunch(dependencies.readLaunch ?? stdinBytes, target);
  onStatus("started");
  const bytes = await fetchCalendarBytes(feed, dependencies.fetchImpl);
  onStatus(`downloaded ${bytes.byteLength} bytes`);
  let response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(`${target}/api/local/ical-import`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "text/calendar; charset=utf-8", "X-DueGood-CSRF-Token": token },
      body: bytes,
    });
  } catch (error) { throw fetchFailure(error); }
  if (!response.ok) fail("IMPORT_REJECTED");
  onStatus("completed");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await run();
  } catch (error) {
    const code = error instanceof IcalFetchError ? error.code : "FAILED";
    process.stderr.write(`duegood-ical: failed ${code}\n`);
    process.exitCode = 1;
  }
}
