import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs a loop with a >16 KiB parent through references and pins it across reopen", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", join(root, "tools/fixtures/engine/loop-parent-ref.ts")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  expect(output).toContain("loop parent ref ok");
}, 65000);
