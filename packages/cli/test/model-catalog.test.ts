import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { CliModelCatalog } from "@relay/server";
import { afterEach, describe, expect, it } from "vitest";
import { createModelCatalogService } from "../src/model-catalog.js";
import { executeStart } from "../src/start.js";
import {
  capture,
  claudeReady,
  cleanupModelCatalogTests,
  cleanups,
  type Discover,
  type Discovery,
  deferred,
  envFor,
  executable,
  item,
  options,
  ready,
  tempDir,
  waitFor,
  webRoot,
} from "./model-catalog-helpers.js";

afterEach(cleanupModelCatalogTests);

describe("model catalog cache", () => {
  it("serves GET from cache only and populates it on explicit refresh", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    const calls: Parameters<Discover>[0][] = [];
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      discover: async (input) => {
        calls.push(input);
        return ready();
      },
    });

    const cold = await service.get("project-1", "codex");
    expect(cold.status).toBe("unavailable");
    expect(cold.items).toEqual([]);
    expect(calls).toHaveLength(0);

    const loaded = await service.refresh("project-1", "codex");
    expect(loaded.status).toBe("ready");
    expect(loaded.items.map((entry) => entry.id)).toEqual(["gpt-5-codex"]);
    expect(loaded.scope).toBe("relay-runtime");
    expect(loaded.source).toBe("codex-app-server");
    expect(loaded.fetchedAt).not.toBeNull();
    expect(loaded.expiresAt).toBeGreaterThan(loaded.fetchedAt ?? 0);

    const cached = await service.get("project-1", "codex");
    expect(cached.status).toBe("ready");
    expect(cached.items).toEqual(loaded.items);
    expect(calls).toHaveLength(1);
    await service.close();
  });

  it("expires a ready catalog to stale without spawning and keeps empty ready entries", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    let clock = 1_000;
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      now: () => clock,
      ttlMs: 100,
      discover: async () => {
        calls += 1;
        return ready({ items: [] });
      },
    });
    const loaded = await service.refresh("project-1", "codex");
    expect(loaded.status).toBe("ready");
    clock += 101;
    const stale = await service.get("project-1", "codex");
    expect(stale.status).toBe("stale");
    expect(calls).toBe(1);
    await service.close();
  });

  it("returns stale last-good items when refresh fails", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    let clock = 1_000;
    let mode: "ready" | "fail" = "ready";
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      now: () => clock,
      ttlMs: 100,
      discover: async () =>
        mode === "ready"
          ? ready()
          : {
              status: "unavailable",
              items: [],
              cliVersion: null,
              truncated: false,
              message: "offline",
            },
    });
    await service.refresh("project-1", "codex");
    clock += 101;
    mode = "fail";
    const stale = await service.refresh("project-1", "codex");
    expect(stale.status).toBe("stale");
    expect(stale.items.map((entry) => entry.id)).toEqual(["gpt-5-codex"]);
    expect(stale.message).toBe("offline");
    await service.close();
  });

  it("does not reuse last-good items after the CLI version changes", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    let version = "1.0.0";
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      discover: async () =>
        version === "1.0.0"
          ? ready()
          : {
              status: "unavailable",
              items: [],
              cliVersion: version,
              truncated: false,
              message: "offline",
            },
    });
    expect((await service.refresh("project-1", "codex")).status).toBe("ready");
    version = "2.0.0";
    const failed = await service.refresh("project-1", "codex");
    expect(failed.status).toBe("unavailable");
    expect(failed.items).toEqual([]);
    expect((await service.get("project-1", "codex")).items).toEqual([]);
    await service.close();
  });

  it("coalesces concurrent refresh for one key and enforces a failure cooldown", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    const gate = deferred<void>();
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      discover: async () => {
        calls += 1;
        await gate.promise;
        return ready();
      },
    });
    const first = service.refresh("project-1", "codex");
    const second = service.refresh("project-1", "codex");
    await waitFor(() => calls === 1);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a.items).toEqual(b.items);
    expect(calls).toBe(1);
    await service.close();

    const failing = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      discover: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    const before = calls;
    expect((await failing.refresh("project-2", "codex")).status).toBe("unavailable");
    expect((await failing.refresh("project-2", "codex")).status).toBe("unavailable");
    expect(calls - before).toBe(1);
    await failing.close();
  });

  it("caps concurrent discovery and rejects saturation without queueing", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      discover: async () => {
        calls += 1;
        const gate = deferred<void>();
        gates.set(String(calls), gate);
        await gate.promise;
        return ready();
      },
    });
    const first = service.refresh("project-1", "codex");
    const second = service.refresh("project-2", "codex");
    const third = service.refresh("project-3", "codex");
    await waitFor(() => calls === 2);
    expect((await third).status).toBe("unavailable");
    expect(calls).toBe(2);
    for (const gate of gates.values()) gate.resolve();
    await Promise.all([first, second]);
    await service.close();
  });

  it("aborts owned discovery on close and settles pending refresh", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    let calls = 0;
    let aborted = false;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      discover: async (input) =>
        new Promise<Discovery>((_resolve, reject) => {
          calls += 1;
          input.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    });
    const pending = service.refresh("project-1", "codex");
    await waitFor(() => calls === 1);
    await service.close();
    expect(aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
  });
});

describe("model catalog context", () => {
  it("uses a neutral empty cwd under the data dir and preserves auth env", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const codexHome = tempDir("relay-model-catalog-codex-");
    writeFileSync(join(codexHome, "auth.json"), "{}");
    const first = tempDir("relay-model-catalog-path-");
    const second = tempDir("relay-model-catalog-path-");
    const bin = executable(second);
    let seen: Parameters<Discover>[0] | undefined;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(`${first}:${second}`, home, codexHome),
      discover: async (input) => {
        seen = input;
        return ready();
      },
    });
    await service.refresh("project-1", "codex");
    expect(seen).toBeDefined();
    if (seen === undefined) return;
    expect(dirname(seen.cwd)).toBe(dataDir);
    expect(seen.cwd.startsWith(`${dataDir}${sep}`)).toBe(true);
    expect(readdirSync(seen.cwd)).toEqual([]);
    expect(seen.bin).toBe(bin);
    expect(seen.env?.HOME).toBe(home);
    expect(seen.env?.CODEX_HOME).toBe(codexHome);
    await service.close();
  });

  it("resolves relative PATH entries against the neutral runtime cwd", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const host = mkdtempSync(join(process.cwd(), ".relay-model-catalog-host-"));
    cleanups.push(() => rmSync(host, { recursive: true, force: true }));
    const hostBin = executable(join(host, "bin"));
    const relativeHost = relative(process.cwd(), dirname(hostBin));
    let seen: Parameters<Discover>[0] | undefined;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(`${relativeHost}:/usr/bin`, home),
      discover: async (input) => {
        seen = input;
        return ready();
      },
    });
    await service.refresh("project-1", "codex");
    expect(seen).toBeDefined();
    expect(seen?.bin).not.toBe(hostBin);
    await service.close();
  });

  it("invalidates cache when an ancestor config changes during discovery", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    mkdirSync(join(dataDir, ".codex"));
    const config = join(dataDir, ".codex", "config.toml");
    writeFileSync(config, "model = 'one'\n");
    const gate = deferred<void>();
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      discover: async (_input) => {
        calls += 1;
        if (calls === 1) await gate.promise;
        return ready({ items: [item(`model-${calls}`)] });
      },
    });
    const pending = service.refresh("project-1", "codex");
    await waitFor(() => calls === 1);
    writeFileSync(config, "model = 'two'\n");
    utimesSync(config, new Date(), new Date(Date.now() + 5_000));
    gate.resolve();
    const changed = await pending;
    expect(changed.status).toBe("unavailable");
    expect(changed.message).toContain("context changed");
    const next = await service.refresh("project-1", "codex");
    expect(next.status).toBe("ready");
    expect(calls).toBe(2);
    await service.close();
  });

  it("ignores unrelated Codex cache writes during and after discovery", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    const codexHome = tempDir("relay-model-catalog-codex-");
    executable(binDir);
    mkdirSync(join(dataDir, ".codex"), { recursive: true });
    const gate = deferred<void>();
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home, codexHome),
      discover: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
        return ready();
      },
    });
    const pending = service.refresh("project-1", "codex");
    await waitFor(() => calls === 1);
    writeFileSync(join(codexHome, "models_cache.json"), '{"one":1}\n');
    writeFileSync(join(dataDir, ".codex", "models_cache.json"), '{"one":1}\n');
    gate.resolve();
    const loaded = await pending;
    expect(loaded.status).toBe("ready");

    writeFileSync(join(codexHome, "models_cache.json"), '{"two":2}\n');
    writeFileSync(join(dataDir, ".codex", "models_cache.json"), '{"two":2}\n');
    expect((await service.get("project-1", "codex")).status).toBe("ready");
    await service.close();
  });

  it("discards when a named Codex auth file changes during discovery", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    const codexHome = tempDir("relay-model-catalog-codex-");
    executable(binDir);
    const auth = join(codexHome, "auth.json");
    writeFileSync(auth, "{}\n");
    const gate = deferred<void>();
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home, codexHome),
      discover: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
        return ready();
      },
    });
    const pending = service.refresh("project-1", "codex");
    await waitFor(() => calls === 1);
    writeFileSync(auth, '{"token":"changed"}\n');
    utimesSync(auth, new Date(), new Date(Date.now() + 5_000));
    gate.resolve();
    const changed = await pending;
    expect(changed.status).toBe("unavailable");
    expect(changed.message).toContain("context changed");
    await service.close();
  });

  it("invalidates cache when the PATH-resolved binary is replaced", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    const bin = executable(binDir);
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      discover: async () => {
        calls += 1;
        return ready();
      },
    });
    await service.refresh("project-1", "codex");
    expect((await service.get("project-1", "codex")).status).toBe("ready");
    const replacement = join(binDir, "codex-new");
    writeFileSync(replacement, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    chmodSync(replacement, 0o755);
    renameSync(replacement, bin);
    expect((await service.get("project-1", "codex")).status).toBe("unavailable");
    await service.refresh("project-1", "codex");
    expect(calls).toBe(2);
    await service.close();
  });

  it("returns an honest unsupported catalog for opencode without discovery", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    let calls = 0;
    const service = createModelCatalogService({
      dataDir,
      env: envFor(binDir, home),
      discover: async () => {
        calls += 1;
        return ready();
      },
      discoverClaude: async () => {
        calls += 1;
        return claudeReady();
      },
    });
    const opencode = await service.refresh("project-1", "opencode");
    expect(opencode.cli).toBe("opencode");
    expect(opencode.items).toEqual([]);
    expect(["unsupported", "unavailable"]).toContain(opencode.status);
    expect(calls).toBe(0);
    await service.close();
  });
});

describe("startup wiring", () => {
  it("closes owned discovery before the listener and settles a pending refresh", async () => {
    const dataDir = tempDir();
    const home = tempDir("relay-model-catalog-home-");
    const binDir = tempDir("relay-model-catalog-bin-");
    executable(binDir);
    const out = capture();
    const controller = new AbortController();
    const order: string[] = [];
    let pending: Promise<CliModelCatalog> | undefined;
    const running = executeStart(options({ port: 0 }), dataDir, {
      webRoot: webRoot(),
      stdout: out,
      signal: controller.signal,
      openBrowser: () => undefined,
      createModelCatalog: (dir) =>
        createModelCatalogService({
          dataDir: dir,
          env: envFor(binDir, home),
          discover: async (input) =>
            new Promise<Discovery>((_resolve, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => {
                  order.push("catalog-abort");
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            }),
        }),
      startBrowserServer: async (wiring) => {
        pending = wiring.modelCatalog.refresh("project-1", "codex");
        return {
          url: "http://127.0.0.1:4821",
          port: 4821,
          close: async () => {
            order.push("listener-close");
          },
        };
      },
    });
    await waitFor(() => pending !== undefined);
    controller.abort();
    await expect(running).resolves.toBe(0);
    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
    expect(order).toEqual(["catalog-abort", "listener-close"]);
    expect(existsSync(join(dataDir, "server.json"))).toBe(false);
  });
});
