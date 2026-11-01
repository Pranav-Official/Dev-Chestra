import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@devchestra/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/index.js";
import { MIGRATIONS } from "../src/migrate.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-provider-settings-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "devchestra.db");
}

function open(file: string, clock = new FakeClock(1_700_000_000_000)): Store {
  const store = openStore({ file, clock });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });
  return store;
}

describe("provider settings", () => {
  it("treats a missing row as enabled", () => {
    const store = open(tempFile());

    expect(store.providerSettings.disabled().size).toBe(0);
    expect(store.providerSettings.list()).toEqual([]);
  });

  it("disables and re-enables a provider", () => {
    const store = open(tempFile());

    store.providerSettings.setEnabled("codex", false);
    expect([...store.providerSettings.disabled()]).toEqual(["codex"]);

    store.providerSettings.setEnabled("codex", true);
    expect(store.providerSettings.disabled().size).toBe(0);
  });

  it("lists stored rows with the enabled flag and update time", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const store = open(tempFile(), clock);

    store.providerSettings.setEnabled("pi", false);
    clock.advance(500);
    store.providerSettings.setEnabled("claude-code", true);
    store.providerSettings.setEnabled("pi", true);

    expect(store.providerSettings.list()).toEqual([
      { cli: "claude-code", enabled: true, updatedAt: 1_700_000_000_500 },
      { cli: "pi", enabled: true, updatedAt: 1_700_000_000_500 },
    ]);
  });

  it("keeps values across reopening the database", () => {
    const file = tempFile();
    const first = open(file);
    first.providerSettings.setEnabled("opencode", false);
    first.close();

    const reopened = open(file);
    expect([...reopened.providerSettings.disabled()]).toEqual(["opencode"]);
  });

  it("keeps settings when migrations run again on an upgraded database", () => {
    const file = tempFile();
    const first = open(file);
    first.providerSettings.setEnabled("codex", false);
    first.close();

    const second = open(file);
    expect([...second.providerSettings.disabled()]).toEqual(["codex"]);
    second.close();

    const raw = new Database(file, { readonly: true });
    expect(raw.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    raw.close();
  });
});
