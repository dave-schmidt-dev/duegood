declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    AUTH_MODE: "disabled" | "enabled";
    APP_ORIGIN?: string;
    CANVAS_ORIGIN?: string;
    CANVAS_CLIENT_ID?: string;
    CANVAS_CLIENT_SECRET?: string;
    TOKEN_KEY_VERSION?: string;
    TOKEN_ENCRYPTION_ACTIVE_KEY_B64?: string;
    TOKEN_ENCRYPTION_LEGACY_KEYS_JSON?: string;
  }
}

type Env = Cloudflare.Env;
