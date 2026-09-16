/** Canvas OAuth requires one space-separated scope value; repeating the parameter is not
 * equivalent, so the exact minimal-scope string is fixed here rather than left configurable. */
export const CANVAS_REQUIRED_SCOPE =
  "url:GET|/api/v1/courses url:GET|/api/v1/courses/:course_id/assignments";

const CANVAS_CALLBACK_PATH = "/auth/canvas/callback";

export interface KeyRing {
  readonly activeVersion: number;
  /** Active version plus every still-referenced legacy version, for decrypt-only use.
   * `Uint8Array<ArrayBuffer>`, not the bare (ArrayBufferLike-defaulted) type, so these values are
   * directly usable with Web Crypto's `BufferSource`-typed APIs without a cast at the call site. */
  readonly keys: ReadonlyMap<number, Uint8Array<ArrayBuffer>>;
}

export interface CanvasAuthConfig {
  readonly appOrigin: string;
  readonly institutionOrigin: string;
  /** Undefined when the OAuth developer key hasn't been issued yet — see
   * `docs/OAUTH-REQUEST-CHECKLIST.md`. `AUTH_MODE` can still be `"enabled"` without these; routes
   * that need the OAuth client (`handleStart`/`handleCallback`/refresh) check for `undefined`
   * themselves and return `oauth_not_configured` rather than this ever blocking the whole config. */
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly redirectUri: string;
  readonly scope: string;
  readonly keyRing: KeyRing;
}

type AuthConfigDisabledReason =
  | "auth_mode_disabled"
  | "missing_app_origin"
  | "invalid_app_origin"
  | "missing_institution_origin"
  | "invalid_institution_origin"
  | "invalid_scope"
  | "missing_key_version"
  | "invalid_key_version"
  | "missing_active_key"
  | "invalid_active_key"
  | "invalid_legacy_keys"
  | "key_version_conflict";

export type AuthConfig =
  | { readonly mode: "disabled"; readonly reason: AuthConfigDisabledReason }
  | ({ readonly mode: "enabled" } & CanvasAuthConfig);

export interface AuthConfigInput {
  readonly authMode: string | undefined;
  readonly appOrigin: string | undefined;
  readonly institutionOrigin: string | undefined;
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly scope: string;
  readonly keyVersion: string | undefined;
  readonly activeKeyB64: string | undefined;
  readonly legacyKeysJson: string | undefined;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Templates mark every placeholder with this prefix; treat any surviving copy as absent. */
function isPlaceholder(value: string): boolean {
  return value.length === 0 || value.startsWith("REPLACE_");
}

/** Exact unpadded-free base64 shape for 32 bytes: 43 data characters plus one '=' pad. */
const BASE64_32_BYTE_KEY = /^[A-Za-z0-9+/]{43}=$/;

function decodeBase64Key(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64_32_BYTE_KEY.test(value)) return undefined;
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return undefined;
  }
  if (decoded.length !== 32) return undefined;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function disabled(reason: AuthConfigDisabledReason): AuthConfig {
  return { mode: "disabled", reason };
}

export function resolveAuthConfig(input: AuthConfigInput): AuthConfig {
  if (input.authMode !== "enabled") return disabled("auth_mode_disabled");

  const { appOrigin, institutionOrigin, scope } = input;
  if (appOrigin === undefined || isPlaceholder(appOrigin)) return disabled("missing_app_origin");
  if (!isHttpsUrl(appOrigin)) return disabled("invalid_app_origin");
  if (institutionOrigin === undefined || isPlaceholder(institutionOrigin)) {
    return disabled("missing_institution_origin");
  }
  if (!isHttpsUrl(institutionOrigin)) return disabled("invalid_institution_origin");
  if (isPlaceholder(scope) || !/^\S+ \S+$/.test(scope)) return disabled("invalid_scope");

  const clientId = input.clientId !== undefined && !isPlaceholder(input.clientId) ? input.clientId : undefined;
  const clientSecret =
    input.clientSecret !== undefined && !isPlaceholder(input.clientSecret) ? input.clientSecret : undefined;

  if (input.keyVersion === undefined || isPlaceholder(input.keyVersion)) {
    return disabled("missing_key_version");
  }
  const activeVersion = Number.parseInt(input.keyVersion, 10);
  if (!Number.isInteger(activeVersion) || activeVersion < 1 || String(activeVersion) !== input.keyVersion) {
    return disabled("invalid_key_version");
  }

  if (input.activeKeyB64 === undefined || isPlaceholder(input.activeKeyB64)) {
    return disabled("missing_active_key");
  }
  const activeKey = decodeBase64Key(input.activeKeyB64);
  if (!activeKey) return disabled("invalid_active_key");

  const keys = new Map<number, Uint8Array<ArrayBuffer>>([[activeVersion, activeKey]]);
  if (input.legacyKeysJson !== undefined && !isPlaceholder(input.legacyKeysJson)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.legacyKeysJson);
    } catch {
      return disabled("invalid_legacy_keys");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return disabled("invalid_legacy_keys");
    }
    for (const [versionText, keyValue] of Object.entries(parsed as Record<string, unknown>)) {
      const version = Number.parseInt(versionText, 10);
      if (!Number.isInteger(version) || version < 1 || String(version) !== versionText) {
        return disabled("invalid_legacy_keys");
      }
      if (typeof keyValue !== "string") return disabled("invalid_legacy_keys");
      const key = decodeBase64Key(keyValue);
      if (!key) return disabled("invalid_legacy_keys");
      if (keys.has(version)) return disabled("key_version_conflict");
      keys.set(version, key);
    }
  }

  const redirectUri = `${appOrigin}${CANVAS_CALLBACK_PATH}`;
  return {
    mode: "enabled",
    appOrigin,
    institutionOrigin,
    clientId,
    clientSecret,
    redirectUri,
    scope,
    keyRing: { activeVersion, keys },
  };
}

export interface AuthConfigEnv {
  readonly AUTH_MODE?: string;
  readonly APP_ORIGIN?: string;
  readonly CANVAS_ORIGIN?: string;
  readonly CANVAS_CLIENT_ID?: string;
  readonly CANVAS_CLIENT_SECRET?: string;
  readonly TOKEN_KEY_VERSION?: string;
  readonly TOKEN_ENCRYPTION_ACTIVE_KEY_B64?: string;
  readonly TOKEN_ENCRYPTION_LEGACY_KEYS_JSON?: string;
}

export function loadAuthConfig(env: AuthConfigEnv): AuthConfig {
  return resolveAuthConfig({
    authMode: env.AUTH_MODE,
    appOrigin: env.APP_ORIGIN,
    institutionOrigin: env.CANVAS_ORIGIN,
    clientId: env.CANVAS_CLIENT_ID,
    clientSecret: env.CANVAS_CLIENT_SECRET,
    scope: CANVAS_REQUIRED_SCOPE,
    keyVersion: env.TOKEN_KEY_VERSION,
    activeKeyB64: env.TOKEN_ENCRYPTION_ACTIVE_KEY_B64,
    legacyKeysJson: env.TOKEN_ENCRYPTION_LEGACY_KEYS_JSON,
  });
}
