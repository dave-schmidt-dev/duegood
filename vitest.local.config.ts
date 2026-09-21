import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/local/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
