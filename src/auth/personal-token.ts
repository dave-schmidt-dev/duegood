const USERS_SELF_PATH = "/api/v1/users/self";

export type FetchFn = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type PersonalTokenVerification =
  | { readonly ok: true; readonly canvasUserId: string }
  | { readonly ok: false; readonly reason: "invalid_token" | "provider_unreachable" };

/**
 * Verifies a Canvas Personal Access Token by calling `GET /api/v1/users/self` (Instructure's own
 * users API, verified 2026-09-16 against `https://canvas.instructure.com/doc/api/users.html`) and
 * returns the authenticated Canvas user id. Unlike OAuth's `/login/oauth2/token` response, Canvas
 * issues no separate identity payload for a bare PAT — this call IS the identity check, made once
 * at connect time (there is no refresh cycle for a PAT to piggyback on later).
 *
 * A PAT is not a scope-limited credential the way an OAuth grant is: it carries the full scope of
 * whatever its owner can do in Canvas, with no equivalent of `CANVAS_REQUIRED_SCOPE` and no way to
 * request a narrower one. That is the reason this connect path stays owner-only rather than a
 * general onboarding mechanism (see TASKS.md's Personal Access Token entry) — every "read-only,
 * minimal scope" claim elsewhere in this repo's docs describes the OAuth path, not this one.
 *
 * Never logs or echoes `token` — callers must do the same in their own error paths.
 */
export async function verifyPersonalAccessToken(
  institutionOrigin: string,
  token: string,
  fetchFn: FetchFn,
): Promise<PersonalTokenVerification> {
  const target = new URL(USERS_SELF_PATH, institutionOrigin);

  let response: Response;
  try {
    response = await fetchFn(target.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      // Never follow automatically: a redirect target has not been validated, and a login-page
      // redirect on this endpoint means the token didn't authenticate, not that the identity is
      // fine one hop further with the bearer token attached.
      redirect: "manual",
    });
  } catch {
    return { ok: false, reason: "provider_unreachable" };
  }

  if (response.status >= 300 && response.status < 400) return { ok: false, reason: "provider_unreachable" };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "invalid_token" };
  if (!response.ok) return { ok: false, reason: "provider_unreachable" };

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, reason: "provider_unreachable" };
  }
  if (!isRecord(json) || (typeof json.id !== "number" && typeof json.id !== "string")) {
    return { ok: false, reason: "provider_unreachable" };
  }
  return { ok: true, canvasUserId: String(json.id) };
}
