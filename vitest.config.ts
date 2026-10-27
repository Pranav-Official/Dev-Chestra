import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/test-data/**"],
    passWithNoTests: true,
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
