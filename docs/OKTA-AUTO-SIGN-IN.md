# Automated Okta sign-in for Canvas refresh

Refresh runs headless and reports when sign-in needs your help. Verification used synthetic Okta pages. Live Marymount sign-in remains unverified.

## What it does

When the Canvas session in the dedicated capture profile has expired, the session broker opens the Canvas login path, which redirects to Marymount Okta. If the page is the Okta sign-in widget on an allowed host, the broker:

1. Runs the fixed broker consumer `duegood-canvas-sso` through `~/.agent/bin/bws-secret-exec`.
2. Reads one bounded JSON handoff from that consumer on file descriptor 3. The consumer's stdout and stderr are discarded.
3. Types the username, password, and a Google Authenticator code into the widget.
4. Waits for Canvas to confirm the session, as it did before.

The TOTP seed never leaves the consumer. The consumer generates codes for the current and next two 30-second windows and hands over only those codes.

Credentials are typed only on `https://marymount.okta.com` and `https://sso.marymount.edu` (no port, no user info). The host is checked before every fill and click. Every other case fails closed and records a content-free outcome code:

| Outcome | Meaning |
|---|---|
| `PUSH_OR_NUMBER_CHALLENGE` | Okta Verify push, number match, or FastPass prompt |
| `FASTPASS_CHALLENGE` | Device challenge or authenticator launch |
| `ENROLLMENT_REQUIRED` | Okta asks to enroll a factor (for example, a new-device prompt) |
| `CAPTCHA_REQUIRED` | A CAPTCHA is present |
| `UNSUPPORTED_AUTHENTICATOR` | A challenge other than password or Google Authenticator |
| `AUTHENTICATOR_UNAVAILABLE` | The authenticator list has no Google Authenticator option |
| `CREDENTIALS_REJECTED` | The widget shows an error after a submit |
| `OKTA_HOST_REJECTED` | The page is, or moves to, a host that is neither Okta nor Canvas |
| `CREDENTIALS_UNAVAILABLE` | The broker consumer failed or returned an invalid handoff |
| `UNKNOWN_PAGE`, `STEP_TIMEOUT`, `STEP_LIMIT_EXCEEDED` | Anything else |

The last outcome is stored in `~/Library/Application Support/DueGood/canvas-sso-auto-sign-in.json` (mode 0600). For a fail-closed widget view, the record also lists the widget's CSS class names (no page text), which helps diagnose a failed live run. Unsupported first views fail before any credential is fetched, and silent SSO that lands on Canvas fetches nothing. After `CREDENTIALS_REJECTED`, automatic attempts stop until you sign in by hand once; this protects the account from lockout. In visible mode, any failure leaves the Chrome window open for the normal attended sign-in.

## One-time setup

### 1. Check that Okta allows Google Authenticator

Sign in to `https://marymount.okta.com`, open **Settings** (or **Security Methods**) from your name menu, and look for **Google Authenticator**. If it is not offered, stop here: automated sign-in cannot work without an administrator change, and the attended sign-in stays in use.

### 2. Enroll a code app with the setup key

1. In **Security Methods**, choose **Set up** next to **Google Authenticator**.
2. When the QR code appears, choose **Can't scan?**. Okta shows a setup key (a base32 string).
3. Add that key to your phone's authenticator app as well, so you keep a manual way in.
4. Enter the current 6-digit code from the phone to finish enrollment.
5. Keep the setup key only long enough to store it in OpenBao in the next step.

Do not remove Okta Verify. Automated sign-in chooses Google Authenticator from the authenticator list when Okta offers a choice.

### 3. Store the three values in OpenBao

Create one KV v2 secret on the `kv` mount:

- Path: `dm5mbp/DUEGOOD_MARYMOUNT_SSO` (API path `kv/data/dm5mbp/DUEGOOD_MARYMOUNT_SSO`, readable by the existing `dm5mbp` AppRole policy)
- Keys:
  - `username`: your Okta username
  - `password`: your Okta password
  - `totp_seed`: the setup key from step 2 (spaces and hyphens are ignored)

Run the helper in your own terminal; it prompts with hidden input, writes all three keys in one KV v2 write with the existing `importer` AppRole from the bws project, verifies each by SHA-256 read-back, and prints only OK/FAIL. It can show the current 6-digit code so you can confirm the setup key matches your phone before anything is stored.

```sh
~/Documents/Projects/duegood/scripts/store-sso-credentials.py
```

No agent reads or prints these values.

### 4. Register the broker consumer

After the branch is merged to `main`, add this entry to `CONSUMERS` in `~/Documents/Projects/bws/bws-secret-exec.py`. Set `executable_sha256` to the SHA-256 of the merged helper (`shasum -a 256 scripts/canvas-sso-credentials.mjs`), then add a pin test like the one for `duegood-canvas-ical` and add the name to the OpenBao backend list in the broker tests.

```python
"duegood-canvas-sso": Consumer(
    executable=Path("/Users/dave/Documents/Projects/duegood/scripts/canvas-sso-credentials.mjs"),
    executable_sha256="<sha256 of the merged helper>",
    mode="multi",
    backend="openbao", openbao_role="dm5mbp",
    openbao_mappings=(
        ("dm5mbp/DUEGOOD_MARYMOUNT_SSO#username", "DUEGOOD_SSO_USERNAME"),
        ("dm5mbp/DUEGOOD_MARYMOUNT_SSO#password", "DUEGOOD_SSO_PASSWORD"),
        ("dm5mbp/DUEGOOD_MARYMOUNT_SSO#totp_seed", "DUEGOOD_SSO_TOTP_SEED"),
    ),
),
```

By code reading, the broker's `multi` mode `execve`s the helper without closing inherited descriptors, so the handoff pipe on fd 3 should reach it; this has not run against the real broker yet. The helper refuses arguments, refuses a terminal or regular file on fd 3, and writes only a content-free `DUEGOOD_SSO_HANDOFF=<code>` line to stderr on failure.

## Interactive sign-in and headless refresh

1. Stop the capture broker with `npm run canvas:session -- stop`.
2. Open the private Chrome profile with `npm run canvas:session -- start --headed` and finish any required sign-in or survey.
3. Stop the visible session with `npm run canvas:session -- stop`.
4. Run `npm run canvas:session -- refresh`. App and CLI refreshes use the same profile in headless mode. A sign-in failure ends the capture and reports its reason.

After sign-in, capture waits briefly for the Canvas evaluation reminder. It uses the visible close link or “Do It Later”. If dismissal fails, visible sessions report `SURVEY_POPUP_BLOCKING` and wait for the owner until the sign-in deadline. Headless sessions fail immediately with the same code.
