import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingsFile } from "@devchestra/schema";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock } from "../src/settings/file-lock.js";
import {
  loadEffectiveModelTiers,
  readSettingsLayer,
  saveSettingsLayer,
  seedLocalModelTiers,
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

describe("settings store safety", () => {
  function devchestra(root: string): string {
    const dir = join(root, ".devchestra");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("refuses a hard-linked .gitignore and leaves the other link untouched", async () => {
    const root = project();
    const dir = devchestra(root);
    writeFileSync(join(root, "other-name"), "node_modules\n");
    linkSync(join(root, "other-name"), join(dir, ".gitignore"));
    const empty = readSettingsLayer(root, "local");
    await expect(saveSettingsLayer(root, "local", high, empty.etag)).rejects.toMatchObject({
      code: "E_FORBIDDEN_PATH",
    });
    expect(readFileSync(join(root, "other-name"), "utf8")).toBe("node_modules\n");
    expect(existsSync(join(dir, "settings.local.json"))).toBe(false);
  });

  it("refuses a hard-linked .gitignore even when it already lists the file", async () => {
    const root = project();
    const dir = devchestra(root);
    writeFileSync(join(root, "other-name"), "settings.local.json\n");
    linkSync(join(root, "other-name"), join(dir, ".gitignore"));
    const empty = readSettingsLayer(root, "local");
    await expect(saveSettingsLayer(root, "local", high, empty.etag)).rejects.toMatchObject({
      code: "E_FORBIDDEN_PATH",
    });
  });

  it("refuses a symlinked .gitignore", async () => {
    const root = project();
    const dir = devchestra(root);
    writeFileSync(join(root, "elsewhere"), "");
    symlinkSync(join(root, "elsewhere"), join(dir, ".gitignore"));
    const empty = readSettingsLayer(root, "local");
    await expect(saveSettingsLayer(root, "local", high, empty.etag)).rejects.toMatchObject({
      code: "E_FORBIDDEN_PATH",
    });
  });

  it("appends to a normal .gitignore by replacing the file and keeping its mode", async () => {
    const root = project();
    const dir = devchestra(root);
    const ignore = join(dir, ".gitignore");
    writeFileSync(ignore, "keep-me", { mode: 0o640 });
    const before = statSync(ignore);
    const empty = readSettingsLayer(root, "local");
    await saveSettingsLayer(root, "local", high, empty.etag);
    const after = statSync(ignore);
    expect(readFileSync(ignore, "utf8")).toBe("keep-me\nsettings.local.json\n");
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.ino).not.toBe(before.ino);
  });

  it("keeps unknown top-level keys when a tier changes and when the last tier is cleared", async () => {
    const root = project();
    const dir = devchestra(root);
    const file = join(dir, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, theme: { dark: true }, models: { low: { cli: "pi" } } }),
    );
    const saved = await saveSettingsLayer(
      root,
      "project",
      { version: 1, models: { low: { cli: "pi" }, high: { cli: "codex" } } },
      readSettingsLayer(root, "project").etag,
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      theme: { dark: true },
      models: { high: { cli: "codex" }, low: { cli: "pi" } },
    });
    const cleared = await saveSettingsLayer(root, "project", { version: 1 }, saved.etag);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, theme: { dark: true } });
    expect(cleared.extras).toEqual({ theme: { dark: true } });
  });

  it("still removes a file that holds no tiers and no unknown keys", async () => {
    const root = project();
    const saved = await saveSettingsLayer(
      root,
      "local",
      high,
      readSettingsLayer(root, "local").etag,
    );
    await saveSettingsLayer(root, "local", { version: 1 }, saved.etag);
    expect(existsSync(join(root, ".devchestra", "settings.local.json"))).toBe(false);
  });

  it("reports E_CONFLICT while another live process holds the lock", async () => {
    const root = project();
    const dir = devchestra(root);
    // Our own pid is alive, so this stands in for another running DevChestra process.
    writeFileSync(join(dir, "settings.lock"), JSON.stringify({ pid: process.pid, token: "other" }));
    const started = Date.now();
    await expect(
      withFileLock(join(dir, "settings.lock"), () => "never", { timeoutMs: 150 }),
    ).rejects.toMatchObject({ code: "E_CONFLICT" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(existsSync(join(dir, "settings.lock"))).toBe(true);
  });

  it("takes over a lock whose owner is dead", async () => {
    const root = project();
    const dir = devchestra(root);
    writeFileSync(join(dir, "settings.lock"), JSON.stringify({ pid: 2 ** 30, token: "dead" }));
    const empty = readSettingsLayer(root, "local");
    await saveSettingsLayer(root, "local", high, empty.etag);
    expect(existsSync(join(dir, "settings.lock"))).toBe(false);
  });

  it("takes over a lock that is older than the stale window", async () => {
    const root = project();
    const dir = devchestra(root);
    const lock = join(dir, "settings.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "old" }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await expect(withFileLock(lock, () => "ran", { timeoutMs: 1000 })).resolves.toBe("ran");
  });

  it("leaves no lock file behind after a save, or after a failed save", async () => {
    const root = project();
    const dir = devchestra(root);
    const empty = readSettingsLayer(root, "local");
    await saveSettingsLayer(root, "local", high, empty.etag);
    await expect(saveSettingsLayer(root, "local", high, empty.etag)).rejects.toMatchObject({
      code: "E_CONFLICT",
    });
    expect(readdirSync(dir).filter((name) => name.endsWith(".lock"))).toEqual([]);
  });

  it("does not release a lock another process took over while it ran", async () => {
    const root = project();
    const lock = join(devchestra(root), "settings.lock");
    await withFileLock(lock, () => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "taker" }));
    });
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("taker");
  });

  it("serializes concurrent saves so each one sees the previous etag", async () => {
    const root = project();
    devchestra(root);
    const etag = readSettingsLayer(root, "local").etag;
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(() => saveSettingsLayer(root, "local", high, etag)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("seeds missing tiers under the lock and leaves nothing behind when none are missing", async () => {
    const root = project();
    expect(await seedLocalModelTiers(root, "pi")).toEqual(["high", "medium", "low"]);
    expect(await seedLocalModelTiers(root, "codex")).toEqual([]);
    expect(readdirSync(join(root, ".devchestra")).filter((name) => name.endsWith(".lock"))).toEqual(
      [],
    );
  });
});
