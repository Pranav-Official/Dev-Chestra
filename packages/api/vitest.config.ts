import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    // The fake CLI is prod-gated behind RELAY_ALLOW_FAKE; tests opt in.
    env: { RELAY_ALLOW_FAKE: "1" },
  },
});
