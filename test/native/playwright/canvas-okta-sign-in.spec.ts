import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { attemptAutomaticSignIn, performOktaSignIn } from "../../../scripts/canvas-okta-sign-in.mjs";

const OKTA = "https://marymount.okta.com";
const CANVAS = "https://marymount.instructure.com";
const CREDENTIALS = () => ({
  username: "synthetic.student@example.edu",
  password: "synthetic-password-Zq9!",
  passcodes: [{ notBefore: 0, notAfter: 60_000, code: "424242" }],
});
const NOW = () => 10_000;

type Step = { view: string; body: string; next: string; error?: boolean; extra?: string };

const identifyFields = `<input name="identifier" type="text"><input name="rememberMe" type="checkbox">`;
const passwordField = `<input name="credentials.passcode" type="password">`;
const passcodeField = `<input name="credentials.passcode" type="text">`;

function widget(step: Step) {
  const error = step.error ? `<div class="o-form-error-container"><div class="okta-form-infobox-error">Synthetic error</div></div>` : "";
  return `<!doctype html><title>Synthetic Okta</title>
<div id="okta-sign-in"><div class="siw-main-view ${step.view}">
<form class="ion-form o-form">${error}${step.body}<input type="submit" data-type="save" value="Next"></form>${step.extra ?? ""}
</div></div>
<script>
document.querySelector("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fields = {};
  for (const input of document.querySelectorAll("form input:not([type=submit])")) fields[input.name] = input.type === "checkbox" ? input.checked : input.value;
  await fetch("/__record", { method: "POST", body: JSON.stringify({ view: ${JSON.stringify(step.view)}, fields }) });
  location.href = ${JSON.stringify(step.next)};
});
</script>`;
}

async function routeFakeOkta(context: BrowserContext, steps: Record<string, Step>, raw: Record<string, string> = {}) {
  const records: Array<{ view: string; fields: Record<string, string | boolean> }> = [];
  const outbound: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/__record") {
      records.push(JSON.parse(request.postData() ?? "{}"));
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    const key = `${url.origin}${url.pathname}`;
    if (raw[key] !== undefined) {
      await route.fulfill({ status: 200, contentType: "text/html", body: raw[key] });
      return;
    }
    const step = steps[key];
    if (step) {
      await route.fulfill({ status: 200, contentType: "text/html", body: widget(step) });
      return;
    }
    if (url.origin === CANVAS) {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic Canvas</title>" });
      return;
    }
    outbound.push(url.origin);
    await route.abort();
  });
  return { records, outbound };
}

const success: Record<string, Step> = {
  [`${OKTA}/signin`]: { view: "identify primary-auth", body: identifyFields, next: `${OKTA}/password` },
  [`${OKTA}/password`]: { view: "challenge-authenticator--okta_password", body: passwordField, next: `${OKTA}/select` },
  [`${OKTA}/select`]: {
    view: "select-authenticator-authenticate", body: "", next: `${OKTA}/select`,
    // Mirrors okta-signin-widget 7.51 AuthenticatorVerifyOptions: data-se on .authenticator-button, button.select-factor.
    extra: `<div class="authenticator-row clearfix"><div class="authenticator-button" data-se="okta_verify-push"><a class="button select-factor" href="${OKTA}/push">Okta Verify</a></div></div>`
      + `<div class="authenticator-row clearfix"><div class="authenticator-button" data-se="google_otp"><a class="button select-factor" href="${OKTA}/otp">Google Authenticator</a></div></div>`,
  },
  [`${OKTA}/otp`]: { view: "challenge-authenticator--google_otp", body: passcodeField, next: `${CANVAS}/` },
};

async function signIn(page: Page, url: string) {
  await page.goto(url);
  return performOktaSignIn({ page, credentials: CREDENTIALS(), now: NOW, stepTimeoutMs: 5_000 })
    .then((outcome: unknown) => String(outcome), (error: { code?: string }) => error.code ?? "THREW");
}

test("signs in through identify, password, authenticator choice, and Google Authenticator", async ({ page, context }) => {
  const fake = await routeFakeOkta(context, success);
  expect(await signIn(page, `${OKTA}/signin`)).toBe("SIGNED_IN");
  expect(new URL(page.url()).origin).toBe(CANVAS);
  expect(fake.records).toEqual([
    { view: "identify primary-auth", fields: { identifier: "synthetic.student@example.edu", rememberMe: true } },
    { view: "challenge-authenticator--okta_password", fields: { "credentials.passcode": "synthetic-password-Zq9!" } },
    { view: "challenge-authenticator--google_otp", fields: { "credentials.passcode": "424242" } },
  ]);
  expect(fake.outbound).toEqual([]);
});

test("refuses to fill anything on an unreviewed host or over plain HTTP", async ({ page, context }) => {
  const lookalike = { view: "identify primary-auth", body: identifyFields, next: `${CANVAS}/` };
  const fake = await routeFakeOkta(context, {
    "https://marymount-okta.example.com/signin": lookalike,
    "http://marymount.okta.com/signin": lookalike,
  });
  for (const url of ["https://marymount-okta.example.com/signin", "http://marymount.okta.com/signin"]) {
    expect(await signIn(page, url)).toBe("OKTA_HOST_REJECTED");
    expect(await page.locator("input[name='identifier']").inputValue()).toBe("");
  }
  expect(fake.records).toEqual([]);
});

test("stops when Okta redirects mid-flow to a host that is neither Okta nor Canvas", async ({ page, context }) => {
  const fake = await routeFakeOkta(context, {
    [`${OKTA}/signin`]: { view: "identify primary-auth", body: identifyFields, next: "https://collector.example.net/password" },
    "https://collector.example.net/password": { view: "challenge-authenticator--okta_password", body: passwordField, next: `${CANVAS}/` },
  });
  expect(await signIn(page, `${OKTA}/signin`)).toBe("OKTA_HOST_REJECTED");
  expect(fake.records.map((record) => record.view)).toEqual(["identify primary-auth"]);
});

for (const [name, view, outcome] of [
  ["push-only Okta Verify", "challenge-authenticator--okta_verify", "PUSH_OR_NUMBER_CHALLENGE"],
  ["number match", "challenge-poll", "PUSH_OR_NUMBER_CHALLENGE"],
  ["FastPass", "device-challenge-poll", "FASTPASS_CHALLENGE"],
  ["new-device enrollment", "select-authenticator-enroll", "ENROLLMENT_REQUIRED"],
  ["unsupported authenticator", "challenge-authenticator--phone_number", "UNSUPPORTED_AUTHENTICATOR"],
] as const) {
  test(`fails closed after the password on a ${name} challenge`, async ({ page, context }) => {
    const fake = await routeFakeOkta(context, {
      [`${OKTA}/signin`]: { view: "identify primary-auth", body: identifyFields, next: `${OKTA}/password` },
      [`${OKTA}/password`]: { view: "challenge-authenticator--okta_password", body: passwordField, next: `${OKTA}/next` },
      [`${OKTA}/next`]: { view, body: passcodeField, next: `${CANVAS}/` },
    });
    expect(await signIn(page, `${OKTA}/signin`)).toBe(outcome);
    expect(fake.records.map((record) => record.view)).toEqual(["identify primary-auth", "challenge-authenticator--okta_password"]);
    expect(new URL(page.url()).origin).toBe(OKTA);
  });
}

test("fails closed on a rejected password, a CAPTCHA, and an unknown page", async ({ page, context }) => {
  const fake = await routeFakeOkta(context, {
    [`${OKTA}/signin`]: { view: "identify primary-auth", body: identifyFields, next: `${OKTA}/password` },
    [`${OKTA}/password`]: { view: "challenge-authenticator--okta_password", body: passwordField, next: `${OKTA}/rejected` },
    [`${OKTA}/rejected`]: { view: "challenge-authenticator--okta_password", body: passwordField, next: `${CANVAS}/`, error: true },
    [`${OKTA}/captcha`]: { view: "identify primary-auth", body: identifyFields, next: `${CANVAS}/`, extra: `<iframe src="about:blank#hcaptcha" data-se="captcha"></iframe>` },
  }, { [`${OKTA}/maintenance`]: "<!doctype html><title>Synthetic maintenance</title><p>Down</p>" });
  expect(await signIn(page, `${OKTA}/signin`)).toBe("CREDENTIALS_REJECTED");
  expect(fake.records).toHaveLength(2);
  expect(await signIn(page, `${OKTA}/captcha`)).toBe("CAPTCHA_REQUIRED");
  expect(await signIn(page, `${OKTA}/maintenance`)).toBe("UNKNOWN_PAGE");
  expect(fake.records).toHaveLength(2);
});

test("never logs, records, or reports a credential", async ({ page, context }) => {
  await routeFakeOkta(context, {
    ...success,
    [`${OKTA}/otp`]: { view: "challenge-authenticator--google_otp", body: passcodeField, next: `${OKTA}/rejected` },
    [`${OKTA}/rejected`]: { view: "challenge-authenticator--google_otp", body: passcodeField, next: `${CANVAS}/`, error: true },
  });
  const directory = mkdtempSync(path.join(os.tmpdir(), "duegood-okta-redaction-"));
  const output: string[] = [];
  const capture = (stream: NodeJS.WriteStream) => {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      output.push(String(chunk));
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    return () => { stream.write = original; };
  };
  const restore = [capture(process.stdout), capture(process.stderr)];
  const consoleSpy: string[] = [];
  page.on("console", (message) => consoleSpy.push(message.text()));
  const progress: string[] = [];
  const handed = CREDENTIALS();
  try {
    await page.goto(`${OKTA}/signin`);
    const outcome = await attemptAutomaticSignIn({
      context, appDirectory: directory, progress: (status: string) => { progress.push(status); },
      getCredentials: async () => handed, now: NOW, stepTimeoutMs: 5_000,
    });
    expect(outcome).toBe("CREDENTIALS_REJECTED");
    expect(progress).toEqual(["SIGNING_IN_AUTOMATICALLY"]);
    const files = readdirSync(directory);
    expect(files).toEqual(["canvas-sso-auto-sign-in.json"]);
    const recorded = readFileSync(path.join(directory, files[0] ?? ""), "utf8");
    const everything = [recorded, ...output, ...consoleSpy, ...progress, outcome].join("\n");
    for (const secret of ["synthetic.student@example.edu", "synthetic-password-Zq9!", "424242"]) expect(everything).not.toContain(secret);
    expect(handed).toEqual({ username: "", password: "", passcodes: [] });
  } finally {
    for (const undo of restore) undo();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waits for a widget that renders late, then signs in", async ({ page, context }) => {
  const late = widget(success[`${OKTA}/signin`] as Step).replace('<div id="okta-sign-in">', '<div id="okta-sign-in" hidden>')
    .replace("<script>", '<script>setTimeout(() => { const root = document.getElementById("okta-sign-in"); const view = root.querySelector(".siw-main-view"); view.dataset.classes = view.className; view.className = ""; root.hidden = false; setTimeout(() => { view.className = view.dataset.classes; }, 600); }, 0);\n');
  const fake = await routeFakeOkta(context, success, { [`${OKTA}/late`]: late });
  await page.goto(`${OKTA}/late`);
  const directory = mkdtempSync(path.join(os.tmpdir(), "duegood-okta-late-"));
  try {
    const outcome = await attemptAutomaticSignIn({ context, appDirectory: directory, getCredentials: async () => CREDENTIALS(), now: NOW, stepTimeoutMs: 5_000, settleMs: 5_000 });
    expect(outcome).toBe("SIGNED_IN");
    expect(fake.records).toHaveLength(3);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("silent SSO through an Okta interstitial never fetches credentials", async ({ page, context }) => {
  await routeFakeOkta(context, {}, {
    [`${OKTA}/app/sso`]: `<!doctype html><title>Synthetic redirect</title><script>setTimeout(() => { location.href = "${CANVAS}/courses"; }, 300);</script>`,
  });
  await page.goto(`${OKTA}/app/sso`);
  let fetched = false;
  const directory = mkdtempSync(path.join(os.tmpdir(), "duegood-okta-silent-"));
  try {
    const outcome = await attemptAutomaticSignIn({
      context, appDirectory: directory, getCredentials: async () => { fetched = true; return CREDENTIALS(); }, now: NOW, settleMs: 5_000,
    });
    expect(outcome).toBe("NOT_ON_OKTA");
    expect(fetched).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("tolerates a brief redirect hop through another host before Canvas", async ({ page, context }) => {
  const fake = await routeFakeOkta(context, {
    ...success,
    [`${OKTA}/otp`]: { view: "challenge-authenticator--google_otp", body: passcodeField, next: "https://hop.example.net/relay" },
  }, { "https://hop.example.net/relay": `<!doctype html><title>Synthetic hop</title><script>setTimeout(() => { location.href = "${CANVAS}/"; }, 500);</script>` });
  expect(await signIn(page, `${OKTA}/signin`)).toBe("SIGNED_IN");
  expect(fake.records).toHaveLength(3);
});
