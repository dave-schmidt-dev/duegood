import { defineConfig } from "vitest/config";

// Deliberately separate from vitest.config.ts: that config's `cloudflareTest` plugin runs every
// test inside the workerd sandbox pool, which this suite has no need of and cannot use — these
// tests import plain descriptor-returning functions (`src/ui/components/*`, `src/ui/pages/*`),
// never `document`/`fetch`, so a bare Node environment is enough and keeps this suite fast.
export default defineConfig({
  test: {
    include: ["test/ui/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
