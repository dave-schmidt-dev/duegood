/**
 * Automated Marymount Okta sign-in for the Canvas capture broker.
 *
 * Credentials come only from the pinned `duegood-canvas-sso` broker consumer over a
 * private pipe on file descriptor 3. They are typed only into the Okta sign-in widget
 * on the two reviewed Okta hosts over HTTPS, and every unsupported step fails closed
 * with a content-free code. Nothing here logs, persists, or returns a credential.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const CANVAS_ORIGIN = "https://marymount.instructure.com";
export const OKTA_HOSTS = Object.freeze(["marymount.okta.com", "sso.marymount.edu"]);
export const SSO_CONSUMER = "duegood-canvas-sso";
export const AUTO_SIGN_IN_STATE_FILE = "canvas-sso-auto-sign-in.json";
const MAX_HANDOFF_BYTES = 8 * 1024;
const CREDENTIAL_TIMEOUT_MS = 45_000;
const STEP_TIMEOUT_MS = 20_000;
const MAX_STEPS = 6;
const POLL_MS = 250;
/** Passcodes are used only with at least this much of their window left. */
const PASSCODE_MARGIN_MS = 3_000;

/** Outcomes recorded for the owner; all are content-free. */
export const SIGN_IN_OUTCOMES = Object.freeze([
  "SIGNED_IN", "NOT_ON_OKTA", "BLOCKED_AFTER_REJECTION", "CREDENTIALS_UNAVAILABLE", "OKTA_HOST_REJECTED",
  "CREDENTIALS_REJECTED", "PUSH_OR_NUMBER_CHALLENGE", "FASTPASS_CHALLENGE", "ENROLLMENT_REQUIRED",
  "CAPTCHA_REQUIRED", "UNSUPPORTED_AUTHENTICATOR", "AUTHENTICATOR_UNAVAILABLE", "PASSCODE_UNAVAILABLE",
  "UNKNOWN_PAGE", "STEP_TIMEOUT", "STEP_LIMIT_EXCEEDED",
]);
/** Outcomes that may mean a wrong secret; automatic attempts stop until a manual sign-in succeeds. */
const BLOCKING_OUTCOMES = new Set(["CREDENTIALS_REJECTED"]);

export class OktaSignInError extends Error {
  constructor(code) {
    super(code);
    this.name = "OktaSignInError";
    this.code = code;
  }
}

function fail(code) {
  throw new OktaSignInError(code);
}

/** True only for an HTTPS URL on one of the reviewed Okta hosts with no credentials or port. */
export function isOktaUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && OKTA_HOSTS.includes(url.hostname) && url.port === ""
    && url.username === "" && url.password === "";
}

function isCanvasUrl(value) {
  try { return new URL(value).origin === CANVAS_ORIGIN; } catch { return false; }
}

export function defaultBrokerPath(home = homedir()) {
  return path.join(home, ".agent", "bin", "bws-secret-exec");
}

function validHandoff(value) {
  if (!value || typeof value !== "object" || value.format !== "duegood-sso-handoff" || value.version !== 1) return false;
  if (typeof value.username !== "string" || !/^[A-Za-z0-9._@+-]{1,128}$/u.test(value.username)) return false;
  if (typeof value.password !== "string" || value.password.length < 1 || value.password.length > 256) return false;
  if (!Array.isArray(value.passcodes) || value.passcodes.length < 1 || value.passcodes.length > 5) return false;
  return value.passcodes.every((entry) => entry && /^\d{6}$/u.test(entry.code)
    && Number.isSafeInteger(entry.notBefore) && Number.isSafeInteger(entry.notAfter) && entry.notAfter > entry.notBefore);
}

/**
 * Runs the fixed broker consumer and reads one bounded JSON handoff from its fd 3.
 * stdout and stderr are discarded so nothing the consumer prints can reach a log.
 */
export function requestSsoCredentials({
  brokerPath = defaultBrokerPath(),
  spawnProcess = spawn,
  timeoutMs = CREDENTIAL_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(brokerPath, [SSO_CONSUMER, "--"], {
        stdio: ["ignore", "ignore", "ignore", "pipe"],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", HOME: homedir(), LANG: "en_US.UTF-8" },
        windowsHide: true,
      });
    } catch {
      reject(new OktaSignInError("CREDENTIALS_UNAVAILABLE"));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        for (const chunk of chunks) chunk.fill(0);
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(new OktaSignInError("CREDENTIALS_UNAVAILABLE")), timeoutMs);
    const handoff = child.stdio?.[3];
    if (!handoff) {
      finish(new OktaSignInError("CREDENTIALS_UNAVAILABLE"));
      return;
    }
    handoff.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_HANDOFF_BYTES) {
        chunk.fill(0);
        finish(new OktaSignInError("CREDENTIALS_UNAVAILABLE"));
        return;
      }
      chunks.push(chunk);
    });
    handoff.on("error", () => finish(new OktaSignInError("CREDENTIALS_UNAVAILABLE")));
    child.on("error", () => finish(new OktaSignInError("CREDENTIALS_UNAVAILABLE")));
    child.on("close", (code) => {
      const bytes = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      let parsed;
      try { parsed = code === 0 ? JSON.parse(bytes.toString("utf8")) : undefined; } catch { parsed = undefined; }
      bytes.fill(0);
      if (!validHandoff(parsed)) finish(new OktaSignInError("CREDENTIALS_UNAVAILABLE"));
      else finish(undefined, parsed);
    });
  });
}

/** Chooses a passcode whose window still has a safe margin, or undefined. */
export function selectPasscode(passcodes, nowMs) {
  return passcodes.find((entry) => entry.notBefore <= nowMs && entry.notAfter - nowMs >= PASSCODE_MARGIN_MS)
    ?? passcodes.find((entry) => entry.notBefore > nowMs && entry.notBefore - nowMs <= PASSCODE_MARGIN_MS);
}

/** Reads the widget's current view without returning any page text. */
async function readView(page) {
  return page.evaluate(() => {
    const view = globalThis.document.querySelector("#okta-sign-in .siw-main-view, .siw-main-view");
    const errors = globalThis.document.querySelector(
      ".o-form-has-errors .okta-form-infobox-error, .o-form-error-container .okta-form-infobox-error, .o-form-input-error");
    const captcha = globalThis.document.querySelector(
      "iframe[src*='hcaptcha'], iframe[src*='recaptcha'], iframe[src*='captcha'], .captcha, [data-se='captcha']");
    return {
      classes: view ? [...view.classList].filter((name) => /^[a-z0-9_-]{1,80}$/u.test(name)) : [],
      error: Boolean(errors),
      captcha: Boolean(captcha),
    };
  });
}

/** Maps a widget view to the next action or a fail-closed outcome. */
export function classifyView(view) {
  if (view.captcha) return { outcome: "CAPTCHA_REQUIRED" };
  if (view.error) return { outcome: "CREDENTIALS_REJECTED" };
  const names = new Set(view.classes);
  if (names.size === 0) return { outcome: "UNKNOWN_PAGE" };
  const has = (prefix) => [...names].some((name) => name === prefix || name.startsWith(`${prefix}--`));
  if ([...names].some((name) => name.includes("okta_verify") || name.includes("fastpass"))) return { outcome: "PUSH_OR_NUMBER_CHALLENGE" };
  if (has("challenge-poll") || has("challenge-authenticator--okta_verify")) return { outcome: "PUSH_OR_NUMBER_CHALLENGE" };
  if (has("device-challenge-poll") || has("launch-authenticator") || has("device-assurance-grace-period")) return { outcome: "FASTPASS_CHALLENGE" };
  if ([...names].some((name) => name.startsWith("enroll") || name.startsWith("select-authenticator-enroll"))) return { outcome: "ENROLLMENT_REQUIRED" };
  if (names.has("identify")) return { action: "identify" };
  if (names.has("challenge-authenticator--okta_password")) return { action: "password" };
  if (names.has("challenge-authenticator--google_otp")) return { action: "passcode" };
  if (names.has("select-authenticator-authenticate")) return { action: "select" };
  if ([...names].some((name) => name.startsWith("challenge-authenticator--"))) return { outcome: "UNSUPPORTED_AUTHENTICATOR" };
  return { outcome: "UNKNOWN_PAGE" };
}

function assertOktaPage(page) {
  if (!isOktaUrl(page.url())) fail("OKTA_HOST_REJECTED");
}

async function fillField(page, selector, value) {
  assertOktaPage(page);
  const field = page.locator(`.siw-main-view ${selector}`).first();
  if (await field.count() !== 1) fail("UNKNOWN_PAGE");
  await field.fill(value, { timeout: 5_000 });
}

async function submit(page) {
  assertOktaPage(page);
  const button = page.locator(".siw-main-view input[type='submit'][data-type='save'], .siw-main-view button[type='submit']").first();
  if (await button.count() !== 1) fail("UNKNOWN_PAGE");
  await button.click({ timeout: 5_000 });
}

async function waitForChange(page, previousKey, deadline) {
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    if (isCanvasUrl(page.url())) return { left: true };
    if (!isOktaUrl(page.url())) return { left: true };
    let view;
    try { view = await readView(page); } catch { continue; }
    const key = `${view.classes.join(" ")}|${view.error}|${view.captcha}`;
    if (key !== previousKey && view.classes.length > 0) return { view };
  }
  fail("STEP_TIMEOUT");
}

/**
 * Completes one Okta sign-in on the given page. Returns "SIGNED_IN" when the page leaves
 * Okta for Canvas; the caller still verifies the Canvas session itself.
 */
export async function performOktaSignIn({ page, credentials, now = Date.now, stepTimeoutMs = STEP_TIMEOUT_MS }) {
  assertOktaPage(page);
  let view = await readView(page);
  for (let step = 0; step < MAX_STEPS; step += 1) {
    assertOktaPage(page);
    const next = classifyView(view);
    if (next.outcome) fail(next.outcome);
    if (next.action === "identify") {
      await fillField(page, "input[name='identifier']", credentials.username);
      const remember = page.locator(".siw-main-view input[type='checkbox'][name='rememberMe']").first();
      if (await remember.count() === 1 && !(await remember.isChecked())) {
        await remember.check({ force: true, timeout: 5_000 }).catch(() => undefined);
      }
      const combinedPassword = page.locator(".siw-main-view input[name='credentials.passcode'][type='password']");
      if (await combinedPassword.count() === 1) await fillField(page, "input[name='credentials.passcode'][type='password']", credentials.password);
    } else if (next.action === "password") {
      await fillField(page, "input[name='credentials.passcode'][type='password']", credentials.password);
    } else if (next.action === "passcode") {
      const passcode = selectPasscode(credentials.passcodes, now());
      if (!passcode) fail("PASSCODE_UNAVAILABLE");
      if (passcode.notBefore > now()) await page.waitForTimeout(passcode.notBefore - now());
      await fillField(page, "input[name='credentials.passcode']:not([type='password'])", passcode.code);
    } else if (next.action === "select") {
      assertOktaPage(page);
      const option = page.locator(".siw-main-view [data-se='google_otp'] [data-se='button'], .siw-main-view [data-se='google_otp'] .select-factor").first();
      if (await option.count() !== 1) fail("AUTHENTICATOR_UNAVAILABLE");
      const key = `${view.classes.join(" ")}|${view.error}|${view.captcha}`;
      await option.click({ timeout: 5_000 });
      const changed = await waitForChange(page, key, Date.now() + stepTimeoutMs);
      if (changed.left) return isCanvasUrl(page.url()) ? "SIGNED_IN" : fail("OKTA_HOST_REJECTED");
      view = changed.view;
      continue;
    }
    const key = `${view.classes.join(" ")}|${view.error}|${view.captcha}`;
    await submit(page);
    const changed = await waitForChange(page, key, Date.now() + stepTimeoutMs);
    if (changed.left) return isCanvasUrl(page.url()) ? "SIGNED_IN" : fail("OKTA_HOST_REJECTED");
    view = changed.view;
  }
  fail("STEP_LIMIT_EXCEEDED");
}

async function readState(appDirectory) {
  try {
    const parsed = JSON.parse(await readFile(path.join(appDirectory, AUTO_SIGN_IN_STATE_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch { return undefined; }
}

/** Records the last content-free outcome atomically in the private app directory. */
export async function recordSignInOutcome(appDirectory, outcome, at = new Date()) {
  if (!SIGN_IN_OUTCOMES.includes(outcome)) outcome = "UNKNOWN_PAGE";
  const directory = await lstat(appDirectory).catch(() => undefined);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) return;
  const target = path.join(appDirectory, AUTO_SIGN_IN_STATE_FILE);
  const temporary = path.join(appDirectory, `.${AUTO_SIGN_IN_STATE_FILE}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({
        format: "duegood-sso-auto-sign-in", version: 1, outcome,
        blocked: BLOCKING_OUTCOMES.has(outcome), at: at.toISOString(),
      })}\n`);
    } finally { await handle.close(); }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Clears a rejection block after the owner signs in manually and Canvas is verified. */
export async function clearSignInBlock(appDirectory) {
  const state = await readState(appDirectory);
  if (state?.blocked === true) await unlink(path.join(appDirectory, AUTO_SIGN_IN_STATE_FILE)).catch(() => undefined);
}

function scrub(credentials) {
  if (!credentials) return;
  credentials.password = "";
  credentials.username = "";
  for (const entry of credentials.passcodes ?? []) entry.code = "";
  credentials.passcodes = [];
}

/**
 * Attempts one automated sign-in when a broker page is on the Okta sign-in widget.
 * Returns the content-free outcome; the caller falls back to the attended wait.
 * @param {{ context: any, appDirectory: string, progress?: (status: string) => void,
 *   getCredentials?: () => Promise<any>, now?: () => number, stepTimeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export async function attemptAutomaticSignIn({
  context,
  appDirectory,
  progress = () => {},
  getCredentials = requestSsoCredentials,
  now = Date.now,
  stepTimeoutMs = STEP_TIMEOUT_MS,
}) {
  const page = context.pages().find((candidate) => isOktaUrl(candidate.url()));
  if (!page) return "NOT_ON_OKTA";
  const state = await readState(appDirectory);
  if (state?.blocked === true) return "BLOCKED_AFTER_REJECTION";
  progress?.("SIGNING_IN_AUTOMATICALLY");
  let credentials;
  let outcome;
  try {
    credentials = await getCredentials();
    outcome = await performOktaSignIn({ page, credentials, now, stepTimeoutMs });
  } catch (error) {
    outcome = error instanceof OktaSignInError && SIGN_IN_OUTCOMES.includes(error.code) ? error.code : "UNKNOWN_PAGE";
  } finally {
    scrub(credentials);
  }
  await recordSignInOutcome(appDirectory, outcome).catch(() => undefined);
  return outcome;
}

const PRECHECK_MS = 5_000;
const SSO_REDIRECT_MS = 15_000;

async function reachOkta(context, deadline) {
  if (context.pages().some((candidate) => isOktaUrl(candidate.url()))) return;
  const canvasPage = context.pages().find((candidate) => isCanvasUrl(candidate.url()));
  if (!canvasPage || typeof canvasPage.goto !== "function") return;
  // An expired Canvas page does not redirect until it navigates; the fixed login path starts SSO.
  await canvasPage.goto(`${CANVAS_ORIGIN}/login`, {
    waitUntil: "domcontentloaded", timeout: Math.max(1, Math.min(SSO_REDIRECT_MS, deadline - Date.now())),
  }).catch(() => undefined);
}

/**
 * Waits for an authenticated Canvas page, first trying the automated Okta sign-in.
 * In attended mode the owner can still sign in by hand for the rest of the budget; in
 * headless mode a failed automated attempt ends the wait at once.
 * @param {{ context: any, appDirectory: string, progress?: (status: string) => void,
 *   waitForCanvasPage: (context: any, timeoutMs: number, pollMs: number) => Promise<any>,
 *   automaticSignIn?: (options: any) => Promise<string>, attendedSignIn?: boolean,
 *   timeoutMs: number, pollIntervalMs: number }} options
 */
export async function waitForSignedInCanvas({
  context,
  appDirectory,
  progress = () => {},
  waitForCanvasPage,
  automaticSignIn = attemptAutomaticSignIn,
  attendedSignIn = true,
  timeoutMs,
  pollIntervalMs,
}) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const quick = Math.min(PRECHECK_MS, timeoutMs);
  let page = await waitForCanvasPage(context, quick, Math.min(pollIntervalMs, quick));
  if (page) return page;
  if (Date.now() < deadline) await reachOkta(context, deadline);
  const outcome = await automaticSignIn({ context, appDirectory, progress });
  if (!attendedSignIn && !["SIGNED_IN", "NOT_ON_OKTA"].includes(outcome)) return undefined;
  if (Date.now() >= deadline) return undefined;
  page = await waitForCanvasPage(context, remaining(), Math.min(pollIntervalMs, remaining()));
  if (page && outcome !== "SIGNED_IN") await clearSignInBlock(appDirectory).catch(() => undefined);
  return page;
}
