import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs two fresh agent rounds through the real gateway and MCP shim", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", join(root, "tools/fixtures/engine/loops.ts")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  expect(output).toContain("loop agent integration ok");
}, 65000);
