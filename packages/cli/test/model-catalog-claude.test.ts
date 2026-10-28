import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelCatalogService } from "../src/model-catalog.js";
import {
  claudeEnvFor,
  claudeItem,
  claudeReady,
  cleanupModelCatalogTests,
  type Discover,
  deferred,
  executable,
  item,
  ready,
  tempDir,
  waitFor,
} from "./model-catalog-helpers.js";

afterEach(cleanupModelCatalogTests);

describe("Claude discovery wiring", () => {
  it("cold GET is cache-only and creates no runtime directory", async () => {
    const dataDir = tempDir();
    const home = tempDir("devchestra-model-catalog-home-");
    const binDir = tempDir("devchestra-model-catalog-bin-");
    executable(binDir, "claude");
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: claudeEnvFor(binDir, home),
      discoverClaude: async () => {
        calls += 1;
        return claudeReady();
      },
    });
    const cold = await service.get("project-1", "claude-code");
    expect(cold).toMatchObject({ status: "unavailable", source: "none", items: [] });
    expect(cold.message).toContain("No model catalog is cached yet");
    expect(readdirSync(dataDir)).toEqual([]);
    expect(calls).toBe(0);
    await service.close();
  });

  it("refresh uses the Claude discovery port and keeps the raw model value", async () => {
    const dataDir = tempDir();
    const home = tempDir("devchestra-model-catalog-home-");
    const binDir = tempDir("devchestra-model-catalog-bin-");
    const bin = executable(binDir, "claude");
    let codexCalls = 0;
    let claudeCalls = 0;
    let seen: Parameters<Discover>[0] | undefined;
    const service = createModelCatalogService({
      dataDir,
      env: claudeEnvFor(binDir, home),
      discover: async () => {
        codexCalls += 1;
        return ready();
      },
      discoverClaude: async (input) => {
        claudeCalls += 1;
        seen = input;
        return claudeReady({
          items: [claudeItem("claude-sonnet-5-5")],
          message: "ignored",
        });
      },
    });
    const loaded = await service.refresh("project-1", "claude-code");
    expect(loaded).toMatchObject({
      cli: "claude-code",
      status: "ready",
      source: "claude-sdk",
      cliVersion: "2.1.310",
    });
    expect(loaded.items).toEqual([
      {
        id: "claude-sonnet-5-5",
        label: "claude-sonnet-5-5",
        source: "claude-sdk",
      },
    ]);
    expect(loaded.fetchedAt).not.toBeNull();
    expect(loaded.expiresAt).toBeGreaterThan(loaded.fetchedAt ?? 0);
    expect(codexCalls).toBe(0);
    expect(claudeCalls).toBe(1);
    expect(seen?.bin).toBe(bin);
    expect(seen?.env?.HOME).toBe(home);
    expect(seen?.env?.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude"));
    expect(seen?.env?.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
    expect(dirname(seen?.cwd ?? "")).toBe(dataDir);

    const cached = await service.get("project-1", "claude-code");
    expect(cached.status).toBe("ready");
    expect(cached.items).toEqual(loaded.items);
    expect(claudeCalls).toBe(1);
    await service.close();
  });

  it("keeps the same binary identity separate per CLI including versions", async () => {
    const dataDir = tempDir();
    const home = tempDir("devchestra-model-catalog-home-");
    const binDir = tempDir("devchestra-model-catalog-bin-");
    const shared = executable(binDir, "shared-cli");
    let codexCalls = 0;
    let claudeCalls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: claudeEnvFor(binDir, home),
      codexBin: shared,
      claudeBin: shared,
      discover: async () => {
        codexCalls += 1;
        return ready({ items: [item("codex-only")], cliVersion: "1.2.3" });
      },
      discoverClaude: async () => {
        claudeCalls += 1;
        return claudeReady({ items: [claudeItem("claude-only")], cliVersion: "2.1.310" });
      },
    });
    const codex = await service.refresh("project-1", "codex");
    const claude = await service.refresh("project-1", "claude-code");
    expect(codex).toMatchObject({ source: "codex-app-server", cliVersion: "1.2.3" });
    expect(codex.items.map((entry) => entry.id)).toEqual(["codex-only"]);
    expect(claude).toMatchObject({ source: "claude-sdk", cliVersion: "2.1.310" });
    expect(claude.items.map((entry) => entry.id)).toEqual(["claude-only"]);
    expect(codexCalls).toBe(1);
    expect(claudeCalls).toBe(1);

    const codexCached = await service.get("project-1", "codex");
    expect(codexCached).toMatchObject({
      status: "ready",
      source: "codex-app-server",
      cliVersion: "1.2.3",
    });
    expect(codexCached.items.map((entry) => entry.id)).toEqual(["codex-only"]);
    const claudeCached = await service.get("project-1", "claude-code");
    expect(claudeCached).toMatchObject({
      status: "ready",
      source: "claude-sdk",
      cliVersion: "2.1.310",
    });
    expect(codexCalls).toBe(1);
    expect(claudeCalls).toBe(1);
    await service.close();
  });

  it("invalidates on Claude config stat changes and ignores .codex metadata", async () => {
    const dataDir = tempDir();
    const home = tempDir("devchestra-model-catalog-home-");
    const binDir = tempDir("devchestra-model-catalog-bin-");
    executable(binDir, "claude");
    mkdirSync(join(dataDir, ".claude"), { recursive: true });
    mkdirSync(join(dataDir, ".codex"), { recursive: true });
    const settings = join(dataDir, ".claude", "settings.json");
    writeFileSync(settings, "{}\n");
    writeFileSync(join(dataDir, ".codex", "config.toml"), "model = 'codex'\n");
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: claudeEnvFor(binDir, home),
      discoverClaude: async () => {
        calls += 1;
        return claudeReady({ items: [claudeItem(`model-${calls}`)] });
      },
    });
    expect((await service.refresh("project-1", "claude-code")).status).toBe("ready");
    writeFileSync(join(dataDir, ".codex", "config.toml"), "model = 'other'\n");
    utimesSync(join(dataDir, ".codex", "config.toml"), new Date(), new Date(Date.now() + 5_000));
    expect((await service.get("project-1", "claude-code")).status).toBe("ready");
    expect(calls).toBe(1);

    writeFileSync(settings, '{"model":"two"}\n');
    utimesSync(settings, new Date(), new Date(Date.now() + 5_000));
    expect((await service.get("project-1", "claude-code")).status).toBe("unavailable");
    const refreshed = await service.refresh("project-1", "claude-code");
    expect(refreshed.status).toBe("ready");
    expect(calls).toBe(2);
    await service.close();
  });

  it("invalidates an in-flight Claude refresh when settings change", async () => {
    const dataDir = tempDir();
    const home = tempDir("devchestra-model-catalog-home-");
    const binDir = tempDir("devchestra-model-catalog-bin-");
    executable(binDir, "claude");
    mkdirSync(join(dataDir, ".claude"), { recursive: true });
    const settings = join(dataDir, ".claude", "settings.json");
    writeFileSync(settings, "{}\n");
    const gate = deferred<void>();
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: claudeEnvFor(binDir, home),
      discoverClaude: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
        return claudeReady({ items: [claudeItem(`model-${calls}`)] });
      },
    });
    const pending = service.refresh("project-1", "claude-code");
    await waitFor(() => calls === 1);
    writeFileSync(settings, '{"model":"changed"}\n');
    utimesSync(settings, new Date(), new Date(Date.now() + 5_000));
    gate.resolve();
    const changed = await pending;
    expect(changed.status).toBe("unavailable");
    expect(changed.message).toContain("context changed");
    await service.close();
  });

  it("single-flights per CLI and keeps stale last-good items on failure", async () => {
    const dataDir = tempDir();
    const home = tempDir("devchestra-model-catalog-home-");
    const binDir = tempDir("devchestra-model-catalog-bin-");
    executable(binDir, "codex");
    executable(binDir, "claude");
    let clock = 1_000;
    let mode: "ready" | "fail" = "ready";
    let claudeCalls = 0;
    const gate = deferred<void>();
    const service = createModelCatalogService({
      dataDir,
      env: claudeEnvFor(binDir, home),
      now: () => clock,
      ttlMs: 100,
      discoverClaude: async () => {
        claudeCalls += 1;
        if (claudeCalls === 1) await gate.promise;
        return mode === "ready"
          ? claudeReady({ items: [claudeItem("claude-kept")] })
          : {
              status: "unavailable",
              items: [],
              cliVersion: null,
              truncated: false,
              message: "offline",
            };
      },
    });
    const first = service.refresh("project-1", "claude-code");
    const second = service.refresh("project-1", "claude-code");
    await waitFor(() => claudeCalls === 1);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a.items).toEqual(b.items);
    expect(claudeCalls).toBe(1);
    clock += 101;
    mode = "fail";
    const stale = await service.refresh("project-1", "claude-code");
    expect(stale.status).toBe("stale");
    expect(stale.items.map((entry) => entry.id)).toEqual(["claude-kept"]);
    expect(stale.message).toBe("offline");
    await service.close();
  });

  it("maps an adapter-reported missing SDK to an honest empty status", async () => {
    const dataDir = tempDir();
    const home = tempDir("devchestra-model-catalog-home-");
    const binDir = tempDir("devchestra-model-catalog-bin-");
    executable(binDir, "claude");
    const service = createModelCatalogService({
      dataDir,
      env: claudeEnvFor(binDir, home),
      discoverClaude: async () => ({
        status: "unavailable",
        items: [],
        cliVersion: null,
        truncated: false,
        message: "Claude Agent SDK is unavailable.",
      }),
    });
    const result = await service.refresh("project-1", "claude-code");
    expect(result).toMatchObject({
      cli: "claude-code",
      status: "unavailable",
      source: "none",
      items: [],
      cliVersion: null,
      message: "Claude Agent SDK is unavailable.",
    });
    await service.close();
  });

  it("sanitizes a thrown Claude discovery failure without leaking details", async () => {
    const dataDir = tempDir();
    const home = tempDir("devchestra-model-catalog-home-");
    const binDir = tempDir("devchestra-model-catalog-bin-");
    executable(binDir, "claude");
    const service = createModelCatalogService({
      dataDir,
      env: claudeEnvFor(binDir, home),
      discoverClaude: async () => {
        throw new Error(
          "missing sdk at /home/person/.claude/.credentials.json token=sk-live-SECRET",
        );
      },
    });
    const result = await service.refresh("project-1", "claude-code");
    expect(result.status).toBe("unavailable");
    expect(result.items).toEqual([]);
    expect(result.message).not.toContain("SECRET");
    expect(result.message).not.toContain("/home/person");
    await service.close();
  });
});
