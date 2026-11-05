import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingsFile } from "@devchestra/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadEffectiveModelTiers,
  readSettingsLayer,
  saveSettingsLayer,
} from "../src/settings/store.js";

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "devchestra-settings-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const high: SettingsFile = { version: 1, models: { high: { cli: "claude-code", model: "opus" } } };

describe("settings store", () => {
  it("reads a missing file as an empty document with a stable etag", () => {
    const root = project();
    const first = readSettingsLayer(root, "local");
    expect(first).toMatchObject({ exists: false, document: { version: 1 }, warnings: [] });
    expect(readSettingsLayer(root, "project").etag).toBe(first.etag);
  });

  it("saves the local layer privately and keeps it out of git", async () => {
    const root = project();
    const empty = readSettingsLayer(root, "local");
    const saved = await saveSettingsLayer(root, "local", high, empty.etag);
    expect(saved).toMatchObject({ exists: true, document: high });
    const file = join(root, ".devchestra", "settings.local.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(high);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, ".devchestra", ".gitignore"), "utf8")).toContain(
      "settings.local.json",
    );
  });

  it("leaves an existing .devchestra/.gitignore intact and adds the entry once", async () => {
    const root = project();
    mkdirSync(join(root, ".devchestra"));
    writeFileSync(join(root, ".devchestra", ".gitignore"), "review-artifacts/");
    let layer = readSettingsLayer(root, "local");
    layer = await saveSettingsLayer(root, "local", high, layer.etag);
    await saveSettingsLayer(
      root,
      "local",
      { version: 1, models: { low: { cli: "pi" } } },
      layer.etag,
    );
    expect(readFileSync(join(root, ".devchestra", ".gitignore"), "utf8")).toBe(
      "review-artifacts/\nsettings.local.json\n",
    );
  });

  it("does not ignore the committed layer", async () => {
    const root = project();
    const empty = readSettingsLayer(root, "project");
    await saveSettingsLayer(root, "project", high, empty.etag);
    expect(existsSync(join(root, ".devchestra", ".gitignore"))).toBe(false);
    expect(statSync(join(root, ".devchestra", "settings.json")).mode & 0o777).toBe(0o644);
  });

  it("rejects a stale etag and removes the file when the document empties", async () => {
    const root = project();
    const empty = readSettingsLayer(root, "local");
    const saved = await saveSettingsLayer(root, "local", high, empty.etag);
    await expect(saveSettingsLayer(root, "local", high, empty.etag)).rejects.toMatchObject({
      code: "E_CONFLICT",
    });
    const cleared = await saveSettingsLayer(root, "local", { version: 1 }, saved.etag);
    expect(cleared.exists).toBe(false);
    expect(existsSync(join(root, ".devchestra", "settings.local.json"))).toBe(false);
  });

  it("names the file when its content is not valid settings", () => {
    const root = project();
    mkdirSync(join(root, ".devchestra"));
    writeFileSync(join(root, ".devchestra", "settings.local.json"), "{broken");
    expect(() => readSettingsLayer(root, "local")).toThrow(/settings\.local\.json is not valid/);
    expect(() => loadEffectiveModelTiers(root)).toThrow(/settings\.local\.json is not valid/);
  });

  it("refuses a symlinked settings file", () => {
    const root = project();
    mkdirSync(join(root, ".devchestra"));
    writeFileSync(join(root, "elsewhere.json"), JSON.stringify(high));
    symlinkSync(join(root, "elsewhere.json"), join(root, ".devchestra", "settings.local.json"));
    expect(() => readSettingsLayer(root, "local")).toThrow(/regular file/);
  });

  it("merges the layers with the local file winning", async () => {
    const root = project();
    await saveSettingsLayer(
      root,
      "project",
      {
        version: 1,
        models: { high: { cli: "claude-code", model: "opus" }, low: { cli: "pi" } },
      },
      readSettingsLayer(root, "project").etag,
    );
    await saveSettingsLayer(
      root,
      "local",
      { version: 1, models: { high: { cli: "codex" } } },
      readSettingsLayer(root, "local").etag,
    );
    expect(loadEffectiveModelTiers(root)).toEqual({
      high: { ref: { cli: "codex" }, source: "local" },
      low: { ref: { cli: "pi" }, source: "project" },
    });
  });

  it("reports a missing project folder as a conflict", () => {
    expect(() => loadEffectiveModelTiers(join(tmpdir(), "devchestra-no-such-dir"))).toThrow(
      /Project path is missing/,
    );
  });
});
