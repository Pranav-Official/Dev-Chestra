import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // The fake CLI is prod-gated behind DEVCHESTRA_ALLOW_FAKE; tests opt in.
    env: { DEVCHESTRA_ALLOW_FAKE: "1" },
    hookTimeout: 30_000,
  },
});
