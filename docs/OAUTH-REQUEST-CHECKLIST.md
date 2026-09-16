# Canvas OAuth developer key request checklist

**Purpose:** confirm every value against the actual implementation before sending
`templates/MARYMOUNT-ADMIN-REQUEST.md` to Marymount's Canvas administrator. That template has
bracket placeholders — do not send it as-is.

## 1. Prerequisites (do these first, in order)

1. Authenticate a Cloudflare account (`wrangler login`) and deploy the Worker to a stable HTTPS
   origin — a `workers.dev` subdomain is fine for the pilot. This becomes `APP_ORIGIN`.
2. Create the production D1 database (`wrangler d1 create duegood`) and apply
   `migrations/0001_identity.sql`.
3. Have a real, reviewable security/privacy page or document ready to attach or link — the
   template asks for one.
4. Have a real support/operator contact to put in the template.

None of these are things an agent can do: Cloudflare account auth and resource creation are
Red/prohibited actions per this project's standing agent rules.

## 2. Values to fill into the template

- **Application origin**: `https://<your-actual-origin>` from step 1.1 above.
- **Exact OAuth redirect**: `https://<your-actual-origin>/auth/canvas/callback`. This is not
  configurable — `src/config.ts`'s `CANVAS_CALLBACK_PATH` is a fixed constant, so the redirect URI
  is always `${APP_ORIGIN}/auth/canvas/callback`. Give the admin this exact string; Canvas matches
  it exactly.
- **Initial read scopes**: exactly `src/config.ts`'s `CANVAS_REQUIRED_SCOPE` —
  ```text
  url:GET|/api/v1/courses url:GET|/api/v1/courses/:course_id/assignments
  ```
  One space-separated string, not two repeated `scope` parameters — Canvas does not treat those as
  equivalent. If this ever needs to change, change `CANVAS_REQUIRED_SCOPE` first and this doc
  second, never the other way around.
- **Include-parameter setting**: ask for "Allow Include Parameters" so a later submission-status
  feature can request the current user's own submission inline.
- **Source repository**: `https://github.com/dave-schmidt-dev/duegood` (already public).

## 3. What to ask the admin for, explicitly

- A confidential **API developer key for OAuth authorization-code access** (server-held
  `client_secret`) — not an LTI launch key.
- Do not ask about or expect a PKCE/public-client option. Verified 2026-09-16 directly against
  Instructure's own OAuth2 endpoint reference (developerdocs.instructure.com): Canvas defines no
  `code_challenge`/`code_verifier`/`code_challenge_method` parameter on any grant. There is nothing
  to request here — `src/auth/oauth-profile.ts` is confidential-flow-only for exactly this reason.
- The issued `client_id` and `client_secret`.

## 4. After receiving `client_id`/`client_secret`

1. Store both in Bitwarden Secrets Manager immediately. Never in chat, a file, an issue, or
   anywhere in plaintext.
2. `client_id` is not secret — set it as a plain Cloudflare Worker var (`CANVAS_CLIENT_ID`).
   `client_secret` must be a Worker **secret** (`wrangler secret put CANVAS_CLIENT_SECRET`), never
   a `vars` entry. See `templates/.dev.vars.example` for the local-dev shape (placeholders only).
3. Generate `TOKEN_ENCRYPTION_ACTIVE_KEY_B64` as 32 random bytes, base64-encoded, from a secure
   local generator whose output isn't retained in shell history or a log; store it in Bitwarden
   alongside the OAuth credentials.
4. Only then set `AUTH_MODE=enabled`. `loadAuthConfig` (`src/config.ts`) fails closed to
   `disabled` if `APP_ORIGIN`, `CANVAS_ORIGIN`, `CANVAS_CLIENT_ID`, `CANVAS_CLIENT_SECRET`, or the
   key-ring vars are missing or still placeholder values, so there's no way to half-enable this by
   accident.
5. Run one real end-to-end login against a real Marymount test account before inviting any pilot
   user — the automated test suite covers the protocol against fixtures and mocks, not Marymount's
   actual Canvas instance.

## Do not

- Do not broaden the requested scope to make a permission error disappear — request the specific
  additional scope instead (see `docs/01-SETUP.md` §2).
- Do not send `client_secret` to an agent in chat, ever, for any reason.
