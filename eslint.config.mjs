import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // stdout belongs to the MCP transport. Anything that writes to it from
      // library code corrupts the protocol stream, so console is confined to
      // the CLI and the benchmark, which never share a process with the server.
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["src/cli.ts", "src/bench/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    files: ["eslint.config.mjs", "vitest.config.ts", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    rules: { ...tseslint.configs.disableTypeChecked.rules, "no-console": "off" },
    languageOptions: { ...tseslint.configs.disableTypeChecked.languageOptions, globals: { process: "readonly", console: "readonly" } },
  },
);
