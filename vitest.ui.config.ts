import { defineConfig } from "vitest/config";

// Keep the UI contract tests in Node; they exercise descriptor rendering independently from Tauri.
export default defineConfig({
  test: {
    include: ["test/ui/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
