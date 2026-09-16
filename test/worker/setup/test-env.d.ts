declare namespace Cloudflare {
  interface Env {
    readonly TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
