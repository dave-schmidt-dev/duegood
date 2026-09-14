# Phase 1: OAuth and Cloudflare before feature work

**Current state:** no institution approval, Cloudflare account access, developer key, deployment, or live OAuth test has been established by this handoff. All configuration values below are placeholders or non-secret proposals.

## 1. Establish the cloud foundation

Use an owner-controlled account and confirm **Workers Free**, available D1 capacity, and quota use by any existing applications. The budget is zero, not “a small monthly bill is probably fine.” Disable any workflow that silently upgrades the plan. An account with other paid services needs explicit review of those services before assuming this app cannot incur charges.

Choose a stable provider-supplied HTTPS origin for a `duegood` deployment. Name/origin availability is not guaranteed. Use a separate staging deployment and, ideally, separate institution test credentials. Do not use production secrets on untrusted preview builds.

The first deployable slice should contain a public static landing page and a minimal health endpoint, with all authentication and registration disabled until security work is present. The legacy reference files are not that slice. Use a dedicated frontend output directory; never make the entire repo an asset directory.

Create one D1 database for the pilot after verifying current per-database limits. Record its non-secret binding and identifier in the actual project config. Create migrations for the phase-1 identity, connection, session, and source/student-state boundary. Do not try to deploy the complete future schema before a tested first slice.

The inert `templates/wrangler.example.jsonc` illustrates route/config shape; an agent must create and validate real application code first. Current static-assets docs support routing `/api/*` and `/auth/*` through the Worker [F5].

## 2. Request the correct Canvas key

Ask the Marymount Canvas administrator to review an **API developer key for OAuth authorization-code access**, not an LTI launch key. A normal student account cannot self-approve the integration. Campus enablement is an external dependency [C1, C3].

Start from `templates/MARYMOUNT-ADMIN-REQUEST.md` after choosing the actual deployment origin and responsible support contact. Do not send a request with invented callbacks or unsupported privacy promises.

Requested minimum resource scopes, to confirm against current endpoint docs and the admin's available options:

```text
url:GET|/api/v1/courses
url:GET|/api/v1/courses/:course_id/assignments
```

Ask for **Allow Include Parameters** so assignment responses can include the current user's submission. Without it, scoped-key requests may ignore those includes [C3]. Do not broaden to all scopes to make a permission error disappear. If submission data is unavailable, display that limitation; a fallback endpoint requires its own approved scope and tested student access.

Token exchange supplies a Canvas user identifier [C2]. Do not request profiles, classmates, rosters, or email merely for convenience. Do not use `/auth/userinfo` as a replacement for the coursework token grant; that mode does not return an API access token [C1, C2].

If modules or checkpoint features later require more scopes, request the specific addition then. New scope availability may require reauthorization; test the institution's actual configuration [C3].

## 3. Proposed endpoints and authorization flow

These are **Due Good application routes to implement**, not existing endpoints in the reference code:

| Route | Contract |
| --- | --- |
| `POST /auth/canvas/start` | Initiate authorization for a configured institution; same-origin check and bounded rate |
| `GET /auth/canvas/callback` | Validate and consume a one-time state; exchange code on the server |
| `POST /auth/logout` | Invalidate Due Good session and clear account-specific browser state |
| `POST /api/connection/disconnect` | Stop new imports, revoke/delete Canvas credentials, invalidate running jobs |
| `GET /api/me` | Minimal authenticated identity/connection status, no credentials |
| `GET /api/courses` | Identity-scoped cached courses and freshness |
| `POST /api/sync` | Begin or coalesce a bounded refresh for allowed courses |
| `POST /api/sync/:id/continue` | Resume only an owned, current job; no user-supplied fetch URL |

Proposed callback shape: `https://<actual-origin>/auth/canvas/callback`. Configure and enforce the exact URI in the app even if provider matching is broader. Store allowed origins/paths in configuration, never derive a privileged token destination from request input.

Proposed flow:

1. Set a random pre-auth browser cookie; create a short-lived server-side OAuth attempt containing a hash of a cryptographically random `state`, institution, exact redirect URI, expiry, and browser-session binding.
2. Redirect only to the allowlisted institution's `/login/oauth2/auth` with one space-separated `scope` value, `response_type=code`, the client ID, exact redirect URI, and state. Canvas documents that repeating the scope parameter is not equivalent [C2].
3. On callback, validate state and cookie binding, age, institution, and one-time use before consuming the code. Reject unsolicited callbacks, duplicate state parameters, and replays. On denial, show a safe recovery screen without retaining an authorized connection.
4. Exchange the code at the same institution's `/login/oauth2/token`, server-side, with the client secret. Do not log callback query strings, request bodies, response bodies, or authorization headers.
5. Validate the returned identity and token response. Create/find the account by institution + Canvas user ID. Encrypt credentials before storage and issue a new opaque Due Good session.
6. Redirect immediately to a clean app URL. No third-party resources or analytics on the callback route; set no-store and no-referrer behavior.

These session/state controls are proposed safeguards informed by OAuth guidance [S1]. Verify PKCE support before selecting an OAuth library's provider settings; the checked Canvas endpoint table does not establish a public-client PKCE flow. Do not assume PKCE removes the documented client-secret requirement.

## 4. Credentials and sessions

Store the application client secret and the token-encryption key as **Worker secrets**, not public vars. The student does not supply or manage them. Encrypted per-student access/refresh tokens live in D1, with key version and authenticated binding to the connection identity.

Proposed encryption: AES-256-GCM through a standard runtime implementation, a fresh random nonce for each encryption, and associated data including account/connection identifiers and format version. Do not invent cryptography. Plan key rotation before holding real student credentials. Keep decryption capability confined to the server; operator access remains a trust boundary, so do not describe this as end-to-end encryption.

Use opaque, high-entropy server sessions with a hash stored in D1. Proposed production cookie: `__Host-duegood_session`, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, no Domain. Apply Origin checking plus CSRF protection for state-changing routes. Use server expiry/revocation, and avoid a session-row write on every asset request.

Local secrets belong in an ignored `.dev.vars`, not an exported frontend environment variable. `templates/.dev.vars.example` contains placeholders only. Production secret setup may use the dashboard or reviewed `wrangler secret put` commands; that command deploys a new version, so treat it as a deployment action [F6].

## 5. Refresh, expiry, logout, and deletion

Use returned `expires_in` with a small clock-skew allowance. Refresh once under a connection-scoped lock, not simultaneously for every course. The documented refresh response may omit `refresh_token`; retain the stored one rather than overwriting it with null [C1, C2]. Apply returned token changes atomically with a credential version check.

Retry authentication once where appropriate. Distinguish a token authentication problem from a resource-level permission denial. A revoked/invalid grant should become “Reconnect Canvas,” not an infinite retry loop.

Logout invalidates the Due Good session, not necessarily Canvas consent. Disconnect attempts the provider's documented revocation, stops jobs, deletes stored credentials, and retains or removes coursework according to the explicitly chosen product policy [C2]. Report revocation uncertainty honestly if the provider is unreachable; do not silently keep using the credentials. A subsequent account deletion must prevent in-flight jobs from restoring data.

## 6. First vertical-slice gate

**Mock gate:** simulate authorization denial, invalid state, wrong institution, successful exchange, refresh omission, and revocation. Import a synthetic course and persist one student action. Verify cross-user API denial.

**Deployment gate:** HTTPS, correct Worker routing, no public private assets, configured free plan, database binding/migration, secrets absent from bundles/logs, and a clean disabled-auth state when configuration is incomplete.

**Live gate:** with enabled institutional credentials and a consenting test student, complete login, show correct identity, select one course, import all its pages, refresh a token, preserve a personal action during sync, disconnect, and reconnect. Record actual permissions and included fields without committing the response bodies.

If institutional approval is pending, mark only the live gate blocked. Build and test all other pieces; do not broaden access or use classmates' personal tokens to bypass the dependency.
