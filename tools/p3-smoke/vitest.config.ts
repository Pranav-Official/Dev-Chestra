import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // The fake CLI/script is prod-gated behind DEVCHESTRA_ALLOW_FAKE; tests opt in.
    env: { DEVCHESTRA_ALLOW_FAKE: "1" },
  },
});
