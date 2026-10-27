import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const engineRoot = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(engineRoot, "test/fixtures/routing-scenario.mjs");
const required = [
  "packages/engine/dist/index.js",
  "packages/server/dist/index.js",
  "packages/store/dist/index.js",
  "packages/schema/dist/index.js",
  "packages/adapters/dist/index.js",
  "packages/workspaces/dist/index.js",
  "packages/mcp/dist/bin/shim.js",
  "tools/fake-agent/dist/main.js",
];

describe("engine routing integration driver", () => {
  it("runs a real store/gateway/shim/fake-agent gate and join with restart", () => {
    if (!required.every((path) => existsSync(join(repo, path)))) {
      throw new Error("Routing integration prerequisites are missing; run `pnpm build` first.");
    }
    const output = execFileSync(process.execPath, [script], {
      cwd: repo,
      timeout: 120_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).toContain("engine routing scenarios ok");
  }, 120_000);
});
