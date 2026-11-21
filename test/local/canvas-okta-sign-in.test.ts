import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_SIGN_IN_STATE_FILE,
  attemptAutomaticSignIn,
  classifyView,
  clearSignInBlock,
  isOktaUrl,
  recordSignInOutcome,
  requestSsoCredentials,
  selectPasscode,
  waitForSignedInCanvas,
} from "../../scripts/canvas-okta-sign-in.mjs";
import { desktopChromeUserAgent, installedChromeMajor, sessionLaunchOptions } from "../../scripts/canvas-browser-launch.mjs";

const helper = fileURLToPath(new URL("../../scripts/canvas-sso-credentials.mjs", import.meta.url));
const SYNTHETIC_PASSWORD = "synthetic-password-Zq9!";
const directories: string[] = [];

function scratch() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "duegood-okta-"));
  directories.push(directory);
  return directory;
}

function fakeBroker(body: string) {
  const file = path.join(scratch(), "bws-secret-exec");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o700);
  return file;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Okta host allowlist", () => {
  it("accepts only HTTPS on the reviewed hosts without port or userinfo", () => {
    expect(isOktaUrl("https://marymount.okta.com/signin")).toBe(true);
    expect(isOktaUrl("https://sso.marymount.edu/app/x")).toBe(true);
    for (const url of ["http://marymount.okta.com/", "https://marymount.okta.com.evil.example/", "https://evil.example/marymount.okta.com",
      "https://marymount.okta.com:8443/", "https://user:pw@marymount.okta.com/", "https://my.marymount.edu/", "not a url"]) {
      expect(isOktaUrl(url)).toBe(false);
    }
  });
});

describe("Okta view classification", () => {
  const view = (classes: string[], extra: Partial<{ error: boolean; captcha: boolean }> = {}) => classifyView({ classes, error: false, captcha: false, ...extra });
  it("drives only identify, password, Google Authenticator, and selection", () => {
    expect(view(["siw-main-view", "identify", "primary-auth"])).toEqual({ action: "identify" });
    expect(view(["siw-main-view", "challenge-authenticator--okta_password"])).toEqual({ action: "password" });
    expect(view(["siw-main-view", "challenge-authenticator--google_otp"])).toEqual({ action: "passcode" });
    expect(view(["siw-main-view", "select-authenticator-authenticate"])).toEqual({ action: "select" });
  });
  it("fails closed on push, number match, FastPass, enrollment, CAPTCHA, errors, and unknown views", () => {
    expect(view(["challenge-authenticator--okta_verify"])).toEqual({ outcome: "PUSH_OR_NUMBER_CHALLENGE" });
    expect(view(["challenge-poll"])).toEqual({ outcome: "PUSH_OR_NUMBER_CHALLENGE" });
    expect(view(["device-challenge-poll"])).toEqual({ outcome: "FASTPASS_CHALLENGE" });
    expect(view(["enroll-profile"])).toEqual({ outcome: "ENROLLMENT_REQUIRED" });
    expect(view(["select-authenticator-enroll"])).toEqual({ outcome: "ENROLLMENT_REQUIRED" });
    expect(view(["identify"], { captcha: true })).toEqual({ outcome: "CAPTCHA_REQUIRED" });
    expect(view(["challenge-authenticator--okta_password"], { error: true })).toEqual({ outcome: "CREDENTIALS_REJECTED" });
    expect(view(["challenge-authenticator--phone_number"])).toEqual({ outcome: "UNSUPPORTED_AUTHENTICATOR" });
    expect(view(["terminal"])).toEqual({ outcome: "UNKNOWN_PAGE" });
    expect(view([])).toEqual({ outcome: "UNKNOWN_PAGE" });
  });
});

describe("passcode selection", () => {
  const windows = [{ notBefore: 0, notAfter: 30_000, code: "111111" }, { notBefore: 30_000, notAfter: 60_000, code: "222222" }];
  it("uses the current window with margin, else the imminent next one", () => {
    expect(selectPasscode(windows, 10_000)?.code).toBe("111111");
    expect(selectPasscode(windows, 28_000)?.code).toBe("222222");
    expect(selectPasscode(windows, 58_000)).toBeUndefined();
  });
});

describe("credential handoff from the pinned consumer", () => {
  it("reads the real helper's fd 3 handoff through a broker and nothing else", async () => {
    const broker = fakeBroker([
      `[ "$1" = "duegood-canvas-sso" ] && [ "$2" = "--" ] && [ "$#" = 2 ] || exit 9`,
      `echo "stdout noise ${SYNTHETIC_PASSWORD}"`,
      `DUEGOOD_SSO_USERNAME=synthetic.student@example.edu DUEGOOD_SSO_PASSWORD='${SYNTHETIC_PASSWORD}' DUEGOOD_SSO_TOTP_SEED=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ exec ${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`,
    ].join("\n"));
    const credentials = await requestSsoCredentials({ brokerPath: broker });
    expect(credentials).toMatchObject({ username: "synthetic.student@example.edu", password: SYNTHETIC_PASSWORD });
    expect(credentials.passcodes).toHaveLength(3);
  });

  it("rejects invalid JSON, a non-zero exit, oversized output, a missing broker, and a hung broker", async () => {
    const cases = [
      fakeBroker(`printf 'not json' >&3`),
      fakeBroker(`printf '{"format":"duegood-sso-handoff","version":1}' >&3; exit 0`),
      fakeBroker(`exit 1`),
      fakeBroker(`head -c 20000 /dev/zero >&3`),
      path.join(scratch(), "missing-broker"),
    ];
    for (const brokerPath of cases) {
      await expect(requestSsoCredentials({ brokerPath })).rejects.toMatchObject({ code: "CREDENTIALS_UNAVAILABLE" });
    }
    await expect(requestSsoCredentials({ brokerPath: fakeBroker("exec sleep 5"), timeoutMs: 200 }))
      .rejects.toMatchObject({ code: "CREDENTIALS_UNAVAILABLE" });
  });
});

describe("rejection block and outcome record", () => {
  it("records a private content-free outcome and blocks retries only after a rejection", async () => {
    const directory = scratch();
    await recordSignInOutcome(directory, "CREDENTIALS_REJECTED", new Date("2026-11-21T12:00:00Z"));
    const file = path.join(directory, AUTO_SIGN_IN_STATE_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      format: "duegood-sso-auto-sign-in", version: 1, outcome: "CREDENTIALS_REJECTED", blocked: true, at: "2026-11-21T12:00:00.000Z",
    });
    const getCredentials = vi.fn();
    const page = { url: () => "https://marymount.okta.com/signin", evaluate: async () => ({ classes: ["siw-main-view", "identify"], error: false, captcha: false }) };
    const context = { pages: () => [page] };
    expect(await attemptAutomaticSignIn({ context, appDirectory: directory, getCredentials, settleMs: 50 })).toBe("BLOCKED_AFTER_REJECTION");
    expect(getCredentials).not.toHaveBeenCalled();
    await clearSignInBlock(directory);
    const progress = vi.fn();
    expect(await attemptAutomaticSignIn({
      context, appDirectory: directory, progress, settleMs: 50,
      getCredentials: async () => { throw Object.assign(new Error("x"), { code: "CREDENTIALS_UNAVAILABLE" }); },
    })).toBe("UNKNOWN_PAGE");
    expect(progress).toHaveBeenCalledWith("SIGNING_IN_AUTOMATICALLY");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ outcome: "UNKNOWN_PAGE", blocked: false });
  });

  it("does nothing when no page is on Okta", async () => {
    const getCredentials = vi.fn();
    const context = { pages: () => [{ url: () => "about:blank" }] };
    expect(await attemptAutomaticSignIn({ context, appDirectory: scratch(), getCredentials, settleMs: 50 })).toBe("NOT_ON_OKTA");
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it("fails closed on an unsupported first view without fetching credentials and records its classes", async () => {
    const directory = scratch();
    const getCredentials = vi.fn();
    const progress = vi.fn();
    const page = { url: () => "https://marymount.okta.com/signin", evaluate: async () => ({ classes: ["siw-main-view", "challenge-poll--okta_verify", "mfa-verify"], error: false, captcha: false }) };
    expect(await attemptAutomaticSignIn({ context: { pages: () => [page] }, appDirectory: directory, getCredentials, progress, settleMs: 50 }))
      .toBe("PUSH_OR_NUMBER_CHALLENGE");
    expect(getCredentials).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path.join(directory, AUTO_SIGN_IN_STATE_FILE), "utf8")))
      .toMatchObject({ outcome: "PUSH_OR_NUMBER_CHALLENGE", blocked: false, view: ["siw-main-view", "challenge-poll--okta_verify", "mfa-verify"] });
  });

  it("treats a Canvas page past its login path as silent SSO and an unrendered widget as unknown after the settle wait", async () => {
    const getCredentials = vi.fn();
    const canvas = { url: () => "https://marymount.instructure.com/courses" };
    expect(await attemptAutomaticSignIn({ context: { pages: () => [canvas] }, appDirectory: scratch(), getCredentials, settleMs: 5_000 })).toBe("NOT_ON_OKTA");
    const blank = { url: () => "https://marymount.okta.com/signin", evaluate: async () => ({ classes: [], error: false, captcha: false }) };
    expect(await attemptAutomaticSignIn({ context: { pages: () => [blank] }, appDirectory: scratch(), getCredentials, settleMs: 50 })).toBe("UNKNOWN_PAGE");
    expect(getCredentials).not.toHaveBeenCalled();
  });
});

describe("signed-in Canvas wait", () => {
  const canvasPage = { url: () => "https://marymount.instructure.com/" };

  it("returns an existing session without attempting sign-in", async () => {
    const automaticSignIn = vi.fn();
    const page = await waitForSignedInCanvas({
      context: { pages: () => [canvasPage] }, appDirectory: scratch(), automaticSignIn,
      waitForCanvasPage: async () => canvasPage, timeoutMs: 1000, pollIntervalMs: 10,
    });
    expect(page).toBe(canvasPage);
    expect(automaticSignIn).not.toHaveBeenCalled();
  });

  it("ends a headless wait at once when automatic sign-in fails closed", async () => {
    const waitForCanvasPage = vi.fn(async () => undefined);
    const page = await waitForSignedInCanvas({
      context: { pages: () => [] }, appDirectory: scratch(), attendedSignIn: false,
      automaticSignIn: async () => "PUSH_OR_NUMBER_CHALLENGE", waitForCanvasPage, timeoutMs: 60_000, pollIntervalMs: 10,
    });
    expect(page).toBeUndefined();
    expect(waitForCanvasPage).toHaveBeenCalledTimes(1);
  });

  it("keeps the attended fallback and clears a block after a manual sign-in", async () => {
    const directory = scratch();
    await recordSignInOutcome(directory, "CREDENTIALS_REJECTED");
    let calls = 0;
    const page = await waitForSignedInCanvas({
      context: { pages: () => [] }, appDirectory: directory,
      automaticSignIn: async () => "BLOCKED_AFTER_REJECTION",
      waitForCanvasPage: async () => (calls++ === 0 ? undefined : canvasPage), timeoutMs: 60_000, pollIntervalMs: 10,
    });
    expect(page).toBe(canvasPage);
    expect(() => statSync(path.join(directory, AUTO_SIGN_IN_STATE_FILE))).toThrow();
  });
});

describe("headless launch options", () => {
  it("rejects any broker argument other than a single --headless", () => {
    const broker = fileURLToPath(new URL("../../scripts/canvas-browser-session.mjs", import.meta.url));
    for (const args of [["--visible"], ["--headless", "--headless"], ["--headless=1"]]) {
      const result = spawnSync(process.execPath, [broker, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch() } });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("SESSION_BROKER=INVALID_CONFIGURATION\n");
    }
  });

  it("keeps visible mode by default and replaces the HeadlessChrome user agent when headless", async () => {
    expect(await sessionLaunchOptions()).toEqual({ channel: "chrome", headless: false, args: ["--disable-http-cache"], timeout: 20_000 });
    const headless = await sessionLaunchOptions({ headless: true, chromeMajor: async () => 142 });
    expect(headless).toMatchObject({ channel: "chrome", headless: true });
    expect(headless.userAgent).toBe(desktopChromeUserAgent(142));
    expect(headless.userAgent).not.toMatch(/Headless/u);
    expect(() => desktopChromeUserAgent(Number.NaN)).toThrow("HEADLESS_USER_AGENT_UNAVAILABLE");
  });

  it("reads the Chrome major version from bundle metadata and refuses an unreadable bundle", async () => {
    const plist = path.join(scratch(), "Info.plist");
    writeFileSync(plist, "<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>142.0.7444.60</string></dict></plist>");
    expect(await installedChromeMajor(plist)).toBe(142);
    await expect(installedChromeMajor(path.join(scratch(), "missing.plist"))).rejects.toThrow("HEADLESS_USER_AGENT_UNAVAILABLE");
  });
});
