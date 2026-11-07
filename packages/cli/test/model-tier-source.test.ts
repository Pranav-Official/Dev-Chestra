import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelTierSource } from "../src/model-tier-source.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "devchestra-tier-source-"));
  dirs.push(root);
  mkdirSync(join(root, ".devchestra"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, ".devchestra", name), text);
  }
  return root;
}

const source = (path: string) =>
  createModelTierSource({ projects: { get: (id) => (id === "p1" ? { path } : null) } });

describe("createModelTierSource", () => {
  it("merges the committed and machine-local files, local first", async () => {
    const root = project({
      "settings.json": JSON.stringify({
        version: 1,
        models: { high: { cli: "codex" }, low: { cli: "pi" } },
      }),
      "settings.local.json": JSON.stringify({
        version: 1,
        models: { high: { cli: "claude-code", model: "opus" } },
      }),
    });
    const loaded = await source(root).load("p1");
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value).toEqual({
      high: { ref: { cli: "claude-code", model: "opus" }, source: "local" },
      low: { ref: { cli: "pi" }, source: "project" },
    });
  });

  it("reports an unknown project and a broken settings file as errors", async () => {
    const missing = await source(project()).load("nope");
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected an error");
    expect(missing.error.code).toBe("E_NOT_FOUND");

    const broken = await source(project({ "settings.local.json": "{" })).load("p1");
    expect(broken.ok).toBe(false);
    if (broken.ok) throw new Error("expected an error");
    expect(broken.error.code).toBe("E_MODEL_TIER");
    expect(broken.error.message).toContain("settings.local.json");
  });
});
