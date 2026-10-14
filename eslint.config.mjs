import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "tests/fixtures/**", "release/**", "test-results/**", "playwright-report/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/main/**/*.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.js", "*.config.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", module: "writable", require: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
