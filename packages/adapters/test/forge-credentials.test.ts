import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forgeCredentialFile, resolveForgeCredentials } from "../src/forge-credentials.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("forge credential opt-in", () => {
  it("loads nothing by default and supplies a scoped helper only on request", () => {
    const root = mkdtempSync(join(tmpdir(), "dc-forge-"));
    roots.push(root);
    expect(resolveForgeCredentials(root, root, undefined)).toEqual({ env: {}, secrets: [] });
    const file = forgeCredentialFile(root, root);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ token: "sentinel-github-token" }), { mode: 0o600 });
    const resolved = resolveForgeCredentials(root, root, ["github"]);
    expect(resolved.env.GH_TOKEN).toBe("sentinel-github-token");
    expect(resolved.env.GIT_CONFIG_VALUE_1).toBe("!gh auth git-credential");
    expect(resolved.secrets).toEqual(["sentinel-github-token"]);
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      expect(() => resolveForgeCredentials(root, root, ["github"])).toThrow(
        "GitHub credential unavailable",
      );
    }
  });
  it("rejects unknown credential kinds", () => {
    expect(() => resolveForgeCredentials("/tmp", "/tmp", ["unknown"])).toThrow("Unsupported");
  });
});
