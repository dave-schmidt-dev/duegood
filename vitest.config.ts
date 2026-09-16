import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Reads the real migrations/*.sql files here, in the plain Node config-loading process, and
// hands the parsed result to the sandboxed worker pool as a binding below. The pool's own
// runtime cannot do this itself: node:fs reads to arbitrary absolute paths fail inside the
// @cloudflare/vitest-plugin workerd sandbox even when the path string resolves correctly.
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["./test/worker/setup/apply-migrations.ts"],
    fileParallelism: false,
    reporters: ["default"],
  },
});
