import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type CodexModelDiscoveryRequest, discoverCodexModels } from "../src/index.js";

const STUB = fileURLToPath(new URL("./stubs/codex-app-server.mjs", import.meta.url));
const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Harness {
  dir: string;
  bin: string;
  scenarioPath: string;
  logPath: string;
  home: string;
  codexHome: string;
}

interface Call {
  t: string;
  pid?: number;
  argv?: string[];
  env?: Record<string, string | null>;
  method?: string | null;
  id?: number | null;
  params?: unknown;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "relay-codex-discovery-"));
  temps.push(dir);
  const home = join(dir, "home");
  const codexHome = join(dir, "codex-home");
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const bin = join(dir, "codex-stub.mjs");
  await copyFile(STUB, bin);
  await chmod(bin, 0o755);
  return {
    dir,
    bin,
    scenarioPath: join(dir, "scenario.json"),
    logPath: join(dir, "calls.log"),
    home,
    codexHome,
  };
}

type Options = Omit<Partial<CodexModelDiscoveryRequest>, "cwd" | "bin" | "env">;

async function run(
  h: Harness,
  scenario: Record<string, unknown>,
  options: Options = {},
  envExtra: Record<string, string> = {},
): Promise<{ result: Awaited<ReturnType<typeof discoverCodexModels>>; calls: Call[] }> {
  await writeFile(h.scenarioPath, JSON.stringify(scenario));
  await writeFile(h.logPath, "");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: h.home,
    CODEX_HOME: h.codexHome,
    STUB_SCENARIO: h.scenarioPath,
    STUB_LOG: h.logPath,
    ...envExtra,
  };
  const result = await discoverCodexModels({
    cwd: h.dir,
    bin: h.bin,
    env,
    timeoutMs: 3_000,
    ...options,
  });
  const text = await readFile(h.logPath, "utf8");
  const calls = text
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Call);
  return { result, calls };
}

function methods(calls: Call[]): string[] {
  return calls
    .filter((call) => call.t === "recv")
    .map((call) => call.method ?? "")
    .filter((method) => method !== "");
}

function spawnCall(calls: Call[]): Call {
  const call = calls.find((entry) => entry.t === "spawn");
  if (call === undefined) throw new Error("stub did not log a spawn");
  return call;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("discoverCodexModels", () => {
  it("speaks only initialize/initialized/model-list and normalizes items", async () => {
    const h = await harness();
    const { result, calls } = await run(h, {
      version: "codex-cli/9.9.9",
      pages: [
        {
          data: [
            {
              id: "rpc-1",
              model: "gpt-5-codex",
              displayName: "GPT-5 Codex",
              description: "Coding model",
              provider: "openai",
              aliases: ["gpt-5"],
              isDefault: true,
            },
            { id: "rpc-2", model: "gpt-5-codex", displayName: "duplicate model" },
            { id: "rpc-1", model: "gpt-5-other" },
            { id: "rpc-3", model: "hidden-model", hidden: true },
            { id: "rpc-4", model: "gpt-5-mini", displayName: "Mini" },
          ],
          nextCursor: "c1",
        },
        { data: [{ id: "rpc-5", model: "gpt-5-nano" }], nextCursor: null },
      ],
    });

    expect(result.status).toBe("ready");
    expect(result.cliVersion).toBe("9.9.9");
    expect(result.truncated).toBe(false);
    expect(result.items.map((item) => item.id)).toEqual([
      "gpt-5-codex",
      "gpt-5-mini",
      "gpt-5-nano",
    ]);

    const codex = result.items[0];
    expect(codex).toEqual({
      id: "gpt-5-codex",
      label: "GPT-5 Codex",
      description: "Coding model",
      provider: "openai",
      aliases: ["gpt-5"],
      isDefault: true,
      source: "codex-app-server",
    });
    expect(JSON.stringify(result)).not.toContain("rpc-1");

    expect(spawnCall(calls).argv).toEqual(["app-server", "--listen", "stdio://"]);
    expect(methods(calls)).toEqual(["initialize", "initialized", "model/list", "model/list"]);
    const lists = calls.filter((call) => call.method === "model/list");
    expect(lists[0]?.params).toEqual({ includeHidden: false, limit: 100 });
    expect(lists[1]?.params).toEqual({ includeHidden: false, limit: 100, cursor: "c1" });
    expect(
      calls.some((call) => /thread|turn|login|config|session|account/i.test(call.method ?? "")),
    ).toBe(false);
  });

  it("decodes multibyte identifiers and labels split across stdout chunks", async () => {
    const h = await harness();
    const { result } = await run(h, {
      fragmentUtf8: true,
      pages: [
        {
          data: [{ id: "rpc-é", model: "m-é", displayName: "Modèle-😀" }],
          nextCursor: null,
        },
      ],
    });
    expect(result.status).toBe("ready");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("m-é");
    expect(result.items[0]?.label).toBe("Modèle-😀");
  });

  it("fails safely on a server-initiated request without executing it", async () => {
    const h = await harness();
    const { result, calls } = await run(h, { serverRequest: true, pages: [] });
    expect(result.status).toBe("unsupported");
    expect(result.items).toEqual([]);
    expect(
      methods(calls).every((method) =>
        ["initialize", "initialized", "model/list"].includes(method),
      ),
    ).toBe(true);
    expect(methods(calls)).not.toContain("account/login/start");
  });

  it("reports authRequired without echoing the RPC message", async () => {
    const h = await harness();
    const { result } = await run(h, {
      initError: { code: 401, message: "login required for sk-live-secret" },
    });
    expect(result.status).toBe("authRequired");
    expect(result.message).toBe("Codex requires authentication to list models.");
    expect(JSON.stringify(result)).not.toContain("sk-live-secret");
  });

  it("returns a canned unavailable error for an unclassified RPC failure", async () => {
    const h = await harness();
    const { result } = await run(h, {
      initError: { code: -32603, message: "sk-live-secret-value" },
    });
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("sk-live-secret-value");
  });

  it("maps method-not-found to unsupported", async () => {
    const h = await harness();
    const { result } = await run(h, {
      listError: { code: -32601, message: "Method not found" },
    });
    expect(result.status).toBe("unsupported");
    expect(result.items).toEqual([]);
  });

  it("maps malformed protocol, oversize stdout and oversize stderr to unavailable", async () => {
    const malformed = await harness();
    const badPage = await run(malformed, { malformed: "page" });
    expect(badPage.result.status).toBe("unavailable");

    const badInit = await harness();
    const badInitialize = await run(badInit, { malformed: "initialize" });
    expect(badInitialize.result.status).toBe("unavailable");

    const badJson = await harness();
    const invalidJson = await run(badJson, { malformed: "json" });
    expect(invalidJson.result.status).toBe("unavailable");

    const bigOut = await harness();
    const oversizeStdout = await run(bigOut, { stdoutOversize: 4_096 }, { maxStdoutBytes: 128 });
    expect(oversizeStdout.result.status).toBe("unavailable");
    expect(oversizeStdout.result.message).toBe("Codex app-server output exceeded safe limits.");

    const bigErr = await harness();
    const oversizeStderr = await run(
      bigErr,
      { stderr: "sk-live-secret".repeat(100) },
      { maxStderrBytes: 64 },
    );
    expect(oversizeStderr.result.status).toBe("unavailable");
    expect(JSON.stringify(oversizeStderr.result)).not.toContain("sk-live-secret");
  });

  it("caps pages, models, repeated cursors and unsafe entries", async () => {
    const maxPages = await harness();
    const pagesResult = await run(
      maxPages,
      {
        pages: [
          { data: [{ id: "r1", model: "m1" }], nextCursor: "c1" },
          { data: [{ id: "r2", model: "m2" }], nextCursor: "c2" },
          { data: [{ id: "r3", model: "m3" }], nextCursor: null },
        ],
      },
      { maxPages: 2 },
    );
    expect(pagesResult.result.status).toBe("ready");
    expect(pagesResult.result.items.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(pagesResult.result.truncated).toBe(true);

    const repeated = await harness();
    const repeatedResult = await run(repeated, {
      pages: [
        { data: [{ id: "r1", model: "m1" }], nextCursor: "c1" },
        { data: [{ id: "r2", model: "m2" }], nextCursor: "c1" },
      ],
    });
    expect(repeatedResult.result.truncated).toBe(true);
    expect(repeatedResult.result.items.map((item) => item.id)).toEqual(["m1", "m2"]);

    const maxModels = await harness();
    const modelsResult = await run(
      maxModels,
      {
        pages: [
          {
            data: [
              { id: "r1", model: "m1" },
              { id: "r2", model: "m2" },
              { id: "r3", model: "m3" },
            ],
            nextCursor: null,
          },
        ],
      },
      { maxModels: 2 },
    );
    expect(modelsResult.result.truncated).toBe(true);
    expect(modelsResult.result.items.map((item) => item.id)).toEqual(["m1", "m2"]);

    const exact = await harness();
    const exactResult = await run(
      exact,
      {
        pages: [
          { data: [{ id: "r1", model: "m1" }], nextCursor: "c1" },
          { data: [{ id: "r2", model: "m2" }], nextCursor: null },
        ],
      },
      { maxModels: 2, maxPages: 2 },
    );
    expect(exactResult.result.truncated).toBe(false);
    expect(exactResult.result.items.map((item) => item.id)).toEqual(["m1", "m2"]);

    const caps = await harness();
    const capsResult = await run(caps, {
      pages: [
        {
          data: [
            { id: "r0", model: "m".repeat(300) },
            { id: "r1", model: "bad\u0000model" },
            {
              id: "r2",
              model: "valid-model",
              displayName: `${"L".repeat(300)}\u0000bad`,
              description: "D".repeat(2_000),
              provider: "P".repeat(200),
              aliases: Array.from(
                { length: 40 },
                (_, i) => `${"a".repeat(250)}${String(i).padStart(3, "0")}`,
              ),
              isDefault: false,
            },
            { id: "r3", model: "other" },
          ],
          nextCursor: null,
        },
      ],
    });
    expect(capsResult.result.status).toBe("ready");
    expect(capsResult.result.truncated).toBe(true);
    const capped = capsResult.result.items.find((item) => item.id === "valid-model");
    expect(capped?.label.length).toBe(256);
    expect(capped?.description?.length).toBe(1024);
    expect(capped?.provider?.length).toBe(128);
    expect(capped?.aliases?.length).toBe(32);
    expect(capped?.aliases?.every((alias) => alias.length <= 256)).toBe(true);
    expect(capped?.isDefault).toBe(false);
    for (const item of capsResult.result.items) {
      expect(hasControl(item.id)).toBe(false);
      expect(hasControl(item.label)).toBe(false);
    }
  });

  it("bounds init timeout, total timeout with ignored notifications, and abort", async () => {
    const init = await harness();
    const initTimeout = await run(
      init,
      { delayMs: 2_000 },
      { initTimeoutMs: 100, timeoutMs: 2_000 },
    );
    expect(initTimeout.result.status).toBe("unavailable");
    expect(initTimeout.result.message).toBe("Codex model discovery timed out.");
    const initPid = spawnCall(initTimeout.calls).pid;
    expect(initPid).toBeDefined();
    expect(alive(initPid as number)).toBe(false);

    const idle = await harness();
    const totalTimeout = await run(
      idle,
      { noResponse: true, notifications: 1_000, notificationDelayMs: 20 },
      { timeoutMs: 300, initTimeoutMs: 2_000, idleTimeoutMs: 2_000 },
    );
    expect(totalTimeout.result.status).toBe("unavailable");
    expect(totalTimeout.result.message).toBe("Codex model discovery timed out.");
    expect(methods(totalTimeout.calls).filter((method) => method === "model/list")).toHaveLength(1);
    expect(alive(spawnCall(totalTimeout.calls).pid as number)).toBe(false);

    const aborted = await harness();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const abortResult = await run(
      aborted,
      { delayMs: 2_000 },
      { signal: controller.signal, timeoutMs: 2_000 },
    );
    expect(abortResult.result.status).toBe("unavailable");
    expect(abortResult.result.message).toBe("Codex model discovery was cancelled.");
    expect(alive(spawnCall(abortResult.calls).pid as number)).toBe(false);
  });

  it("settles when the child closes early or immediately after the final page", async () => {
    const early = await harness();
    const earlyResult = await run(early, { exitDuringInit: true });
    expect(earlyResult.result.status).toBe("unavailable");
    expect(earlyResult.result.message).toBe("Codex app-server closed the connection unexpectedly.");

    const after = await harness();
    const afterResult = await run(after, {
      pages: [{ data: [{ id: "r1", model: "m1" }], nextCursor: null }],
      exitAfterLastPage: true,
    });
    expect(afterResult.result.status).toBe("ready");
    expect(afterResult.result.items.map((item) => item.id)).toEqual(["m1"]);
  });

  it("kills owned descendants on timeout and never signals an unrelated process", async () => {
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    sentinel.unref();
    const sentinelPid = sentinel.pid;
    expect(sentinelPid).toBeDefined();
    try {
      const h = await harness();
      const { result, calls } = await run(
        h,
        { descendant: true, noResponse: true, notifications: 0 },
        { timeoutMs: 400, initTimeoutMs: 2_000, idleTimeoutMs: 2_000, graceMs: 50 },
      );
      expect(result.status).toBe("unavailable");
      const descendant = calls.find((call) => call.t === "descendant")?.pid;
      expect(descendant).toBeDefined();
      await sleep(100);
      expect(alive(descendant as number)).toBe(false);
      expect(alive(sentinelPid as number)).toBe(true);
    } finally {
      try {
        process.kill(-(sentinelPid as number), "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("passes the caller environment through unchanged and writes no config", async () => {
    const h = await harness();
    const configPath = join(h.home, "config.toml");
    const authPath = join(h.codexHome, "auth.json");
    await writeFile(configPath, 'model = "sentinel"\n');
    await writeFile(authPath, '{"sentinel":true}\n');
    const previous = process.env.RELAY_LEAK_SENTINEL;
    process.env.RELAY_LEAK_SENTINEL = "host-only";
    try {
      const { result, calls } = await run(
        h,
        { pages: [{ data: [{ id: "r1", model: "m1" }], nextCursor: null }] },
        {},
        { UNRELATED_SECRET: "dummy-not-a-real-secret" },
      );
      expect(result.status).toBe("ready");
      const env = spawnCall(calls).env ?? {};
      expect(env.HOME).toBe(h.home);
      expect(env.CODEX_HOME).toBe(h.codexHome);
      expect(env.UNRELATED_SECRET).toBe("dummy-not-a-real-secret");
      expect(env.STUB_SCENARIO).toBe(h.scenarioPath);
      expect(env.RELAY_LEAK_SENTINEL).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.RELAY_LEAK_SENTINEL;
      else process.env.RELAY_LEAK_SENTINEL = previous;
    }
    expect(await readFile(configPath, "utf8")).toBe('model = "sentinel"\n');
    expect(await readFile(authPath, "utf8")).toBe('{"sentinel":true}\n');
  });

  it("returns a safe unavailable result when the binary is missing", async () => {
    const h = await harness();
    const missing = join(h.dir, "missing-codex");
    await writeFile(h.logPath, "");
    const result = await discoverCodexModels({
      cwd: h.dir,
      bin: missing,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h.home },
      timeoutMs: 2_000,
    });
    expect(result.status).toBe("unavailable");
    expect(result.items).toEqual([]);
    expect(result.cliVersion).toBeNull();
    expect(JSON.stringify(result)).not.toContain(missing);
  });
});
