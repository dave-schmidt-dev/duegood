import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".playwright/**",
      "reference/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "spikes/**",
    ],
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    ...eslint.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended.map((configuration) => ({
    ...configuration,
    files: ["src/**/*.ts", "test/**/*.ts", "*.config.ts"],
  })),
  {
    files: ["src/ui/**/*.ts", "test/native/playwright/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
  },
);
