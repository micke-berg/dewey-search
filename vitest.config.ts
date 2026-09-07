import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The embedding model is a ~120 MB download on a cold machine. Tests never
    // touch it (they inject a deterministic fake embedder), but the index
    // build tests do real SQLite IO, which is slower than the 5 s default.
    testTimeout: 30_000,
  },
});
