import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserModelCatalogPort, CatalogCli, CliModelCatalog } from "@relay/server";
import {
  buildContext,
  type CatalogContext,
  configIdentity,
  contextKey,
  identityOf,
} from "./model-catalog-context.js";
import {
  catalogSourceForCli,
  type DiscoverCli,
  type DiscoveryResult,
  discoverClaude,
  discoverCodex,
  itemSourceForCli,
  normalizeItem,
} from "./model-catalog-discovery.js";

const TTL_MS = 5 * 60_000;
const FAILURE_COOLDOWN_MS = 15_000;
const MAX_ENTRIES = 64;
const MAX_CONCURRENT = 2;
const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_ITEMS = 1_000;

export interface ModelCatalogServiceOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  codexBin?: string;
  claudeBin?: string;
  discover?: DiscoverCli;
  discoverClaude?: DiscoverCli;
  now?: () => number;
  ttlMs?: number;
  failureCooldownMs?: number;
  maxEntries?: number;
  maxConcurrent?: number;
}

export interface ModelCatalogService extends BrowserModelCatalogPort {
  close(): Promise<void>;
}

interface CacheEntry {
  catalog: CliModelCatalog;
  cooldownUntil: number;
}

const FAKE_MESSAGE = "This CLI does not provide a model catalog.";
const COLD_MESSAGE = "No model catalog is cached yet. Refresh models to load it.";
const BUSY_MESSAGE = "Model discovery is busy; try again shortly.";
const COOLDOWN_MESSAGE = "Model discovery failed recently; try again shortly.";
const CLOSED_MESSAGE = "Model discovery is shutting down.";
const CHANGED_MESSAGE = "The model discovery context changed; refresh models again.";

function safeMessage(message: string | undefined, fallback: string): string {
  if (message === undefined || message.trim() === "") return fallback;
  let stripped = "";
  for (const char of message) {
    const code = char.codePointAt(0) ?? 0;
    stripped += code < 0x20 || code === 0x7f ? " " : char;
  }
  const cleaned = stripped.replace(/\s+/gu, " ").trim();
  return cleaned === "" ? fallback : cleaned.slice(0, 256);
}

export function createModelCatalogService(
  options: ModelCatalogServiceOptions,
): ModelCatalogService {
  const dataDir = resolve(options.dataDir);
  const env = options.env ?? process.env;
  const codexBin = options.codexBin ?? "codex";
  const claudeBin = options.claudeBin ?? "claude";
  const codexDiscover = options.discover ?? discoverCodex;
  const claudeDiscover = options.discoverClaude ?? discoverClaude;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? TTL_MS;
  const cooldownMs = options.failureCooldownMs ?? FAILURE_COOLDOWN_MS;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<CliModelCatalog>>();
  const protectedKeys = new Set<string>();
  const versions = new Map<string, string>();
  const lifetime = new AbortController();
  let active = 0;
  let runtimeDir: string | null = null;
  let closed = false;

  const binFor = (cli: CatalogCli): string => (cli === "codex" ? codexBin : claudeBin);
  const discoverFor = (cli: CatalogCli): DiscoverCli =>
    cli === "codex" ? codexDiscover : claudeDiscover;

  const base = (
    projectId: string,
    cli: CatalogCli,
    status: CliModelCatalog["status"],
    message?: string,
    cliVersion: string | null = null,
  ): CliModelCatalog => ({
    cli,
    projectId,
    status,
    scope: "relay-runtime",
    source: status === "ready" ? catalogSourceForCli(cli) : "none",
    cliVersion,
    items: [],
    fetchedAt: null,
    expiresAt: null,
    truncated: false,
    customSupported: true,
    ...(message === undefined ? {} : { message }),
  });

  const unavailable = (projectId: string, cli: CatalogCli, message: string): CliModelCatalog =>
    base(projectId, cli, "unavailable", message);

  const ensureRuntimeDir = (): string => {
    if (runtimeDir === null) {
      runtimeDir = mkdtempSync(join(dataDir, ".relay-model-catalog-"));
      chmodSync(runtimeDir, 0o700);
    }
    return runtimeDir;
  };

  const contextFor = (cli: CatalogCli, cwd: string): CatalogContext =>
    buildContext(cli, binFor(cli), env, cwd, (memoKey) => {
      const version = versions.get(memoKey) ?? null;
      if (version !== null) {
        versions.delete(memoKey);
        versions.set(memoKey, version);
      }
      return version;
    });

  const cacheKey = (projectId: string, cli: CatalogCli, key: string): string =>
    `${projectId}\0${cli}\0${key}`;

  const touch = (key: string, entry: CacheEntry): void => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      let removed = false;
      for (const candidate of cache.keys()) {
        if (!protectedKeys.has(candidate)) {
          cache.delete(candidate);
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
  };

  const store = (key: string, entry: CacheEntry): void => {
    touch(key, entry);
  };

  const lookup = (projectId: string, cli: CatalogCli, context: CatalogContext): CacheEntry | null =>
    cache.get(cacheKey(projectId, cli, context.key)) ?? null;

  const staleCopy = (catalog: CliModelCatalog, message: string): CliModelCatalog => ({
    ...catalog,
    status: "stale",
    message,
  });

  const failureStatus = (result: DiscoveryResult): CliModelCatalog["status"] => {
    if (result.status === "ready") return "ready";
    if (result.status === "unsupported") return "unsupported";
    if (result.status === "authRequired") return "authRequired";
    return "unavailable";
  };

  const get = async (projectId: string, cli: CatalogCli): Promise<CliModelCatalog> => {
    if (closed) return unavailable(projectId, cli, CLOSED_MESSAGE);
    if (cli === "fake") return base(projectId, cli, "unsupported", FAKE_MESSAGE);

    if (runtimeDir === null) return unavailable(projectId, cli, COLD_MESSAGE);
    let context: CatalogContext;
    try {
      context = contextFor(cli, runtimeDir);
    } catch {
      return unavailable(projectId, cli, COLD_MESSAGE);
    }
    const entry = lookup(projectId, cli, context);
    if (entry === null) return unavailable(projectId, cli, COLD_MESSAGE);
    const catalog = entry.catalog;
    if (catalog.expiresAt !== null && now() > catalog.expiresAt && catalog.status === "ready") {
      return staleCopy(catalog, "The cached model catalog has expired; refresh to update it.");
    }
    return catalog;
  };

  const refresh = async (projectId: string, cli: CatalogCli): Promise<CliModelCatalog> => {
    if (closed) return unavailable(projectId, cli, CLOSED_MESSAGE);
    if (cli === "fake") return base(projectId, cli, "unsupported", FAKE_MESSAGE);

    let context: CatalogContext;
    let cwd: string;
    try {
      cwd = ensureRuntimeDir();
      context = contextFor(cli, cwd);
    } catch {
      return unavailable(projectId, cli, COLD_MESSAGE);
    }
    const key = cacheKey(projectId, cli, context.key);
    const running = inflight.get(key);
    if (running !== undefined) return running;

    const existing = lookup(projectId, cli, context);
    const current = existing?.catalog ?? null;
    if (existing !== null && now() < existing.cooldownUntil) {
      return current !== null && current.items.length > 0
        ? staleCopy(current, COOLDOWN_MESSAGE)
        : {
            ...(current ?? unavailable(projectId, cli, COOLDOWN_MESSAGE)),
            message: COOLDOWN_MESSAGE,
          };
    }
    if (active >= maxConcurrent) {
      return current !== null && current.items.length > 0
        ? staleCopy(current, BUSY_MESSAGE)
        : unavailable(projectId, cli, BUSY_MESSAGE);
    }

    let storedKey = key;
    const task = (async (): Promise<CliModelCatalog> => {
      active += 1;
      protectedKeys.add(key);
      let result: DiscoveryResult;
      try {
        result = await discoverFor(cli)({
          cwd,
          ...(context.binaryPath === null ? {} : { bin: context.binaryPath }),
          env: context.env,
          signal: lifetime.signal,
          timeoutMs: DISCOVERY_TIMEOUT_MS,
        });
      } catch {
        result = {
          status: "unavailable",
          items: [],
          cliVersion: null,
          truncated: false,
          message: "Model discovery failed.",
        };
      } finally {
        active -= 1;
      }
      if (closed) return unavailable(projectId, cli, CLOSED_MESSAGE);

      if (result.cliVersion !== null && result.cliVersion !== "") {
        versions.delete(context.versionKey);
        versions.set(context.versionKey, result.cliVersion);
        while (versions.size > maxEntries) {
          const oldest = versions.keys().next().value;
          if (oldest === undefined) break;
          versions.delete(oldest);
        }
      }
      const postBinaryKey =
        context.binaryPath === null ? "missing" : identityOf(context.binaryPath);
      const postConfigId = configIdentity(cli, context.env, cwd);
      if (postBinaryKey !== context.binaryKey || postConfigId !== context.configId) {
        return unavailable(projectId, cli, CHANGED_MESSAGE);
      }
      const version = versions.get(context.versionKey) ?? null;
      const versioned = contextKey(cli, context.binaryKey, version, context.configId);
      const resultKey = cacheKey(projectId, cli, versioned);
      storedKey = resultKey;
      protectedKeys.add(resultKey);

      if (result.status === "ready") {
        const itemSource = itemSourceForCli(cli);
        if (itemSource === null) return base(projectId, cli, "unsupported", FAKE_MESSAGE);
        const items = result.items
          .slice(0, MAX_ITEMS)
          .map((item) => normalizeItem(item, itemSource));
        const fetchedAt = now();
        const catalog: CliModelCatalog = {
          cli,
          projectId,
          status: "ready",
          scope: "relay-runtime",
          source: itemSource,
          cliVersion: result.cliVersion,
          items,
          fetchedAt,
          expiresAt: fetchedAt + ttlMs,
          truncated: result.truncated || result.items.length > MAX_ITEMS,
          customSupported: true,
          ...(result.message === undefined
            ? {}
            : (() => {
                const message = safeMessage(result.message, "");
                return message === "" ? {} : { message };
              })()),
        };
        store(resultKey, { catalog, cooldownUntil: 0 });
        return catalog;
      }

      const status = failureStatus(result);
      const message = safeMessage(result.message, "Model discovery is unavailable.");
      const versionChanged =
        context.version !== null && version !== null && version !== context.version;
      const prior =
        !versionChanged && current !== null && current.items.length > 0 ? current : null;
      const catalog: CliModelCatalog =
        prior === null
          ? {
              ...base(projectId, cli, status, message, result.cliVersion),
              truncated: result.truncated,
            }
          : {
              ...prior,
              status: "stale",
              message,
            };
      store(resultKey, { catalog, cooldownUntil: now() + cooldownMs });
      return catalog;
    })();

    inflight.set(key, task);
    try {
      return await task;
    } finally {
      inflight.delete(key);
      protectedKeys.delete(key);
      protectedKeys.delete(storedKey);
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    await Promise.allSettled([...inflight.values()]);
    inflight.clear();
    protectedKeys.clear();
    cache.clear();
    if (runtimeDir !== null) {
      try {
        rmSync(runtimeDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of an owned empty directory.
      }
      runtimeDir = null;
    }
  };

  return { get, refresh, close };
}
