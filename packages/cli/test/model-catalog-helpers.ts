import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { CliOptions } from "../src/args.js";
import type { ModelCatalogServiceOptions } from "../src/model-catalog.js";

export type Discover = NonNullable<ModelCatalogServiceOptions["discover"]>;
export type Discovery = Awaited<ReturnType<Discover>>;

export const cleanups: (() => void)[] = [];
const originalPath = process.env.PATH;

export function cleanupModelCatalogTests(): void {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
}

export function tempDir(prefix = "relay-model-catalog-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function executable(dir: string, name = "codex"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

export function item(id = "gpt-5-codex"): Discovery["items"][number] {
  return { id, label: id, source: "codex-app-server" };
}

export function claudeItem(id = "claude-sonnet"): Discovery["items"][number] {
  return { id, label: id, source: "claude-sdk" };
}

export function ready(overrides: Partial<Discovery> = {}): Discovery {
  return {
    status: "ready",
    items: [item()],
    cliVersion: "1.0.0",
    truncated: false,
    ...overrides,
  };
}

export function claudeReady(overrides: Partial<Discovery> = {}): Discovery {
  return {
    status: "ready",
    items: [claudeItem()],
    cliVersion: "2.1.310",
    truncated: false,
    ...overrides,
  };
}

export function envFor(
  path: string,
  home: string,
  codexHome = join(home, ".codex"),
): NodeJS.ProcessEnv {
  return { ...process.env, PATH: path, HOME: home, CODEX_HOME: codexHome };
}

export function claudeEnvFor(
  path: string,
  home: string,
  configDir = join(home, ".claude"),
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: path,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: "test-anthropic-key",
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    command: "start",
    params: {},
    json: false,
    embedded: false,
    nonInteractive: false,
    retryUncertainShell: false,
    allowExperimentalAdapters: false,
    noOpen: true,
    printUrl: false,
    probeDecisions: false,
    ...overrides,
  };
}

export function webRoot(): string {
  const dir = tempDir("relay-model-catalog-web-");
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>relay</title>");
  return dir;
}

export function capture(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
