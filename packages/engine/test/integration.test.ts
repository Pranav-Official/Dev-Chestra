import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "tools/fixtures/engine/scenarios.ts");
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
const ready = required.every((path) => existsSync(join(root, path)));

describe("engine integration driver", () => {
  it("runs the real store/gateway/shim/fake-child scenarios", () => {
    if (!ready) {
      throw new Error("Engine integration prerequisites are missing; run `pnpm build` first.");
    }
    const output = execFileSync(process.execPath, ["--import", "tsx", script], {
      cwd: root,
      timeout: 120_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).toContain("engine scenarios ok");
  }, 120_000);
});
