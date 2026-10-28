import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The fake provider is prod-gated behind DEVCHESTRA_ALLOW_FAKE; tests opt in.
    env: { DEVCHESTRA_ALLOW_FAKE: "1" },
  },
});
