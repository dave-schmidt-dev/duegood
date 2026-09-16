declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    AUTH_MODE: "disabled";
  }
}

type Env = Cloudflare.Env;
