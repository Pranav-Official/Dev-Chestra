import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeStdinGuard } from "../src/claude-sdk-spawn.js";
import { type ClaudeModelDiscoveryRequest, discoverClaudeModels } from "../src/index.js";

const STUB = fileURLToPath(new URL("./stubs/claude-cli.mjs", import.meta.url));
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
}

interface Call {
  t: string;
  pid?: number | null;
  argv?: string[];
  cwd?: string;
  env?: Record<string, string | null>;
  frame?: Record<string, unknown>;
  reason?: string;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "relay-claude-discovery-"));
  temps.push(dir);
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  const bin = join(dir, "claude-stub.mjs");
  await copyFile(STUB, bin);
  await chmod(bin, 0o755);
  return {
    dir,
    bin,
    scenarioPath: join(dir, "scenario.json"),
    logPath: join(dir, "calls.log"),
    home,
  };
}

type Options = Omit<Partial<ClaudeModelDiscoveryRequest>, "cwd" | "bin" | "env">;

async function readCalls(path: string): Promise<Call[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Call);
  } catch {
    return [];
  }
}

async function run(
  h: Harness,
  scenario: Record<string, unknown>,
  options: Options = {},
  envExtra: Record<string, string> = {},
): Promise<{ result: Awaited<ReturnType<typeof discoverClaudeModels>>; calls: Call[] }> {
  await writeFile(h.scenarioPath, JSON.stringify(scenario));
  await writeFile(h.logPath, "");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: h.home,
    STUB_SCENARIO: h.scenarioPath,
    STUB_LOG: h.logPath,
    ...envExtra,
  };
  const result = await discoverClaudeModels({
    cwd: h.dir,
    bin: h.bin,
    env,
    timeoutMs: 3_000,
    ...options,
  });
  return { result, calls: await readCalls(h.logPath) };
}

function frames(calls: Call[]): Record<string, unknown>[] {
  return calls
    .filter((call) => call.t === "recv" && call.frame !== undefined)
    .map((call) => call.frame as Record<string, unknown>);
}

function startCall(calls: Call[]): Call {
  const call = calls.find((entry) => entry.t === "start");
  if (call === undefined) throw new Error("stub did not log a start");
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("discoverClaudeModels", () => {
  it("speaks only initialize and normalizes exact dynamic ModelInfo values", async () => {
    const h = await harness();
    const nonce = `claude-nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nonceAlias = `${nonce}-alias`;
    const sentinelSettings = join(h.home, "settings.json");
    await writeFile(sentinelSettings, '{"sentinel":true}\n');
    const previous = process.env.RELAY_LEAK_SENTINEL;
    process.env.RELAY_LEAK_SENTINEL = "host-only";
    try {
      const { result, calls } = await run(
        h,
        {
          models: [
            {
              value: nonceAlias,
              resolvedModel: "claude-sonnet-5",
              displayName: "Alias 🧪",
              description: "Dynamic",
            },
            { value: "__proto__", displayName: "Proto" },
            { value: "constructor", displayName: "Ctor" },
            { value: "toString", displayName: "Str" },
            { value: "default", displayName: "Default" },
            {
              value: "modèle-😀",
              displayName: "Modèle-😀",
              description: "Unicode",
            },
            {
              value: "valid-provider",
              displayName: "Provider",
              provider: " Bedrock ",
              aliases: ["alias-a", "alias-a", "alias-b"],
              isDefault: true,
            },
            { value: "bad\u0000id", displayName: "Bad" },
            { value: "x".repeat(300), displayName: "Long" },
            { value: "sonnet", displayName: "Duplicate one" },
            { value: "sonnet", displayName: "Duplicate two" },
          ],
        },
        {},
        { UNRELATED_SECRET: "dummy-not-a-real-secret" },
      );

      expect(result.status).toBe("ready");
      expect(result.cliVersion).toBe("2.1.296");
      expect(result.truncated).toBe(true);
      expect(result.items.map((item) => item.id)).toEqual([
        nonceAlias,
        "__proto__",
        "constructor",
        "toString",
        "default",
        "modèle-😀",
        "valid-provider",
        "sonnet",
      ]);

      expect(result.items[0]).toEqual({
        id: nonceAlias,
        label: "Alias 🧪",
        description: "Dynamic",
        source: "claude-sdk",
      });
      expect(JSON.stringify(result.items[0])).not.toContain("resolvedModel");
      expect(JSON.stringify(result.items[0])).not.toContain("claude-sonnet-5");

      const provider = result.items.find((item) => item.id === "valid-provider");
      expect(provider).toEqual({
        id: "valid-provider",
        label: "Provider",
        provider: "Bedrock",
        aliases: ["alias-a", "alias-b"],
        isDefault: true,
        source: "claude-sdk",
      });

      const received = frames(calls);
      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe("control_request");
      expect(received[0]?.request).toMatchObject({ subtype: "initialize" });
      expect(JSON.stringify(received)).not.toContain('"type":"user"');

      const start = startCall(calls);
      expect(start.cwd).toBe(h.dir);
      const argv = start.argv ?? [];
      for (const flag of [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "--setting-sources=user,project,local",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--settings",
      ]) {
        expect(argv).toContain(flag);
      }
      expect(argv.some((arg) => arg.includes("disableAllHooks"))).toBe(true);
      for (const flag of [
        "--model",
        "--resume",
        "--continue",
        "--mcp-config",
        "--plugin-dir",
        "--allowedTools",
        "--disallowedTools",
        "--permission-prompt-tool",
        "--add-dir",
      ]) {
        expect(argv).not.toContain(flag);
      }

      expect(start.env?.HOME).toBe(h.home);
      expect(start.env?.UNRELATED_SECRET).toBe("dummy-not-a-real-secret");
      expect(start.env?.RELAY_LEAK_SENTINEL).toBeNull();
      expect(await readFile(sentinelSettings, "utf8")).toBe('{"sentinel":true}\n');

      const exit = calls.find((call) => call.t === "stdin_closed");
      expect(exit).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.RELAY_LEAK_SENTINEL;
      else process.env.RELAY_LEAK_SENTINEL = previous;
    }
  });

  it("caps reported text at the public API bounds without truncating ids", async () => {
    const h = await harness();
    const { result } = await run(h, {
      models: [
        {
          value: "caps",
          displayName: "😀".repeat(200),
          description: "D".repeat(2_000),
          provider: "P".repeat(200),
          aliases: [
            "L".repeat(300),
            ...Array.from(
              { length: 40 },
              (_, index) => `${String(index).padStart(2, "0")}-${"a".repeat(250)}`,
            ),
          ],
          isDefault: false,
        },
        { value: "fallback-label" },
      ],
    });
    expect(result.status).toBe("ready");
    const capped = result.items.find((item) => item.id === "caps");
    expect(capped?.label.length).toBeLessThanOrEqual(256);
    const last = capped?.label.charCodeAt((capped?.label.length ?? 1) - 1) ?? 0;
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(capped?.description?.length).toBe(1024);
    expect(capped?.provider?.length).toBe(128);
    expect(capped?.aliases?.length).toBe(32);
    expect(capped?.aliases?.every((alias) => alias.length <= 256)).toBe(true);
    expect(capped?.isDefault).toBe(false);
    expect(result.items.find((item) => item.id === "fallback-label")?.label).toBe("fallback-label");
  });

  it("caps the model count and reports truncation", async () => {
    const h = await harness();
    const { result } = await run(
      h,
      {
        models: [{ value: "m1" }, { value: "m2" }, { value: "m3" }],
      },
      { maxModels: 2 },
    );
    expect(result.status).toBe("ready");
    expect(result.items.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(result.truncated).toBe(true);
  });

  it("returns ready for an empty catalog and safe unsupported/protocol states", async () => {
    const empty = await harness();
    const emptyResult = await run(empty, { models: [] });
    expect(emptyResult.result.status).toBe("ready");
    expect(emptyResult.result.items).toEqual([]);
    expect(emptyResult.result.truncated).toBe(false);

    const noModels = await harness();
    const missing = await run(noModels, { noModels: true });
    expect(missing.result.status).toBe("unsupported");
    expect(missing.result.items).toEqual([]);
    expect(missing.result.message).toBe(
      "This Claude Code version does not report a model catalog.",
    );

    const malformed = await harness();
    const bad = await run(malformed, { models: "not-an-array" });
    expect(bad.result.status).toBe("unavailable");
    expect(bad.result.message).toBe("Claude Code returned an invalid initialization response.");
  });

  it("maps auth, compatibility and generic initialize errors to canned messages", async () => {
    const auth = await harness();
    const authResult = await run(auth, {
      mode: "error",
      error: "login required for sk-live-secret",
    });
    expect(authResult.result.status).toBe("authRequired");
    expect(authResult.result.message).toBe("Claude requires authentication to list models.");
    expect(JSON.stringify(authResult.result)).not.toContain("sk-live-secret");

    const compat = await harness();
    const compatResult = await run(compat, {
      mode: "error",
      error: "unsupported minimum version 9.9.9",
    });
    expect(compatResult.result.status).toBe("unsupported");

    const generic = await harness();
    const genericResult = await run(generic, {
      mode: "error",
      error: "sk-live-secret-value failed",
    });
    expect(genericResult.result.status).toBe("unavailable");
    expect(genericResult.result.message).toBe("Claude model discovery is unavailable.");
    expect(JSON.stringify(genericResult.result)).not.toContain("sk-live-secret-value");
  });

  it("bounds stdout, stderr, time and abort, and stops the owned process", async () => {
    const bigOut = await harness();
    const stdout = await run(
      bigOut,
      { mode: "oversizeStdout", bytes: 2 * 1024 * 1024 },
      { maxStdoutBytes: 128, timeoutMs: 2_000, graceMs: 100 },
    );
    expect(stdout.result.status).toBe("unavailable");
    expect(stdout.result.message).toBe("Claude Code output exceeded safe limits.");
    const stdoutPid = startCall(stdout.calls).pid;
    expect(stdoutPid).toBeDefined();
    expect(alive(stdoutPid as number)).toBe(false);

    const bigErr = await harness();
    const stderr = await run(
      bigErr,
      { mode: "oversizeStderr", bytes: 128 * 1024 },
      { maxStderrBytes: 64, timeoutMs: 2_000, graceMs: 100 },
    );
    expect(stderr.result.status).toBe("unavailable");
    expect(JSON.stringify(stderr.result)).not.toContain("ssssssss");

    const timedOut = await harness();
    const timeout = await run(timedOut, { mode: "noReply" }, { timeoutMs: 300, graceMs: 100 });
    expect(timeout.result.status).toBe("unavailable");
    expect(timeout.result.message).toBe("Claude model discovery timed out.");
    expect(alive(startCall(timeout.calls).pid as number)).toBe(false);

    const aborted = await harness();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const abort = await run(
      aborted,
      { mode: "noReply" },
      { signal: controller.signal, timeoutMs: 2_000, graceMs: 100 },
    );
    expect(abort.result.status).toBe("unavailable");
    expect(abort.result.message).toBe("Claude model discovery was cancelled.");
    expect(alive(startCall(abort.calls).pid as number)).toBe(false);
  });

  it("returns a safe missing result and never leaks the requested path", async () => {
    const h = await harness();
    const missing = join(h.dir, "does-not-exist-claude");
    await writeFile(h.logPath, "");
    const result = await discoverClaudeModels({
      cwd: h.dir,
      bin: missing,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h.home },
      timeoutMs: 1_000,
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Claude Code executable was not found.");
    expect(result.items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(missing);
    expect(await readCalls(h.logPath)).toEqual([]);
  });

  it("settles on child early close and still succeeds when the child exits after the reply", async () => {
    const early = await harness();
    const earlyResult = await run(early, { mode: "exit" }, { graceMs: 100 });
    expect(earlyResult.result.status).toBe("unavailable");
    expect(earlyResult.result.message).toBe("Claude Code closed the connection unexpectedly.");
    expect(alive(startCall(earlyResult.calls).pid as number)).toBe(false);

    const after = await harness();
    const afterResult = await run(after, { mode: "exitAfterReply" }, { graceMs: 500 });
    expect(afterResult.result.status).toBe("ready");
    expect(afterResult.result.items.map((item) => item.id)).toEqual([
      "sonnet",
      "claude-explicit-1",
    ]);
    expect(alive(startCall(afterResult.calls).pid as number)).toBe(false);
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
        { mode: "descendant" },
        { timeoutMs: 400, graceMs: 50 },
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
        // Already gone.
      }
    }
  });

  it("blocks SDK tool responses before delivery and fails closed", async () => {
    const h = await harness();
    const { result, calls } = await run(
      h,
      { mode: "canUseTool" },
      { timeoutMs: 800, graceMs: 100 },
    );
    expect(result.status).toBe("unavailable");
    const received = frames(calls);
    expect(received.some((frame) => frame.type === "control_response")).toBe(false);
    expect(received.some((frame) => frame.type === "user")).toBe(false);
    expect(alive(startCall(calls).pid as number)).toBe(false);
  });

  it("lets the CLI exit cooperatively on SDK close", async () => {
    const h = await harness();
    const { result, calls } = await run(h, {}, { graceMs: 500 });
    expect(result.status).toBe("ready");
    expect(calls.some((call) => call.t === "stdin_closed")).toBe(true);
    expect(calls.some((call) => call.t === "sigterm")).toBe(false);
    const start = startCall(calls);
    expect(start.pid).toBeDefined();
    expect(alive(start.pid as number)).toBe(false);
  });
});

function writeTo(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

function endStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()));
}

describe("createClaudeStdinGuard", () => {
  it("forwards a fragmented initialize as one NDJSON line and ends the underlying stdin", async () => {
    const forwarded: string[] = [];
    let violations = 0;
    let ended = false;
    const guard = createClaudeStdinGuard({
      forward: (text, callback) => {
        forwarded.push(text);
        callback();
      },
      end: (callback) => {
        ended = true;
        callback();
      },
      onViolation: () => {
        violations += 1;
      },
    });

    const initialize = JSON.stringify({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "initialize" },
    });
    await writeTo(guard, initialize.slice(0, 12));
    expect(forwarded).toEqual([]);
    await writeTo(guard, `${initialize.slice(12)}\n`);
    expect(forwarded).toEqual([`${initialize}\n`]);
    await writeTo(guard, "\n");
    expect(forwarded).toEqual([`${initialize}\n`]);
    expect(violations).toBe(0);

    await endStream(guard);
    expect(ended).toBe(true);
    expect(violations).toBe(0);
  });

  it("allows only the initialize cancel and rejects prompts and forged responses", async () => {
    const forwarded: string[] = [];
    let violations = 0;
    const guard = createClaudeStdinGuard({
      forward: (text, callback) => {
        forwarded.push(text);
        callback();
      },
      end: (callback) => callback(),
      onViolation: () => {
        violations += 1;
      },
    });

    const initialize = JSON.stringify({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "initialize" },
    });
    await writeTo(guard, `${initialize}\n`);
    const cancel = JSON.stringify({
      type: "control_cancel_request",
      request_id: "r1",
    });
    await writeTo(guard, cancel);
    await writeTo(guard, JSON.stringify({ type: "user", message: { role: "user" } }));
    expect(forwarded).toEqual([`${initialize}\n`, `${cancel}\n`]);
    expect(violations).toBe(1);

    const forged = createClaudeStdinGuard({
      forward: (text, callback) => {
        forwarded.push(text);
        callback();
      },
      end: (callback) => callback(),
      onViolation: () => {
        violations += 1;
      },
    });
    await writeTo(forged, `${initialize}\n`);
    await writeTo(
      forged,
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "r1" },
      }),
    );
    expect(violations).toBe(2);
    expect(forwarded).toEqual([`${initialize}\n`, `${cancel}\n`, `${initialize}\n`]);

    const duplicate = createClaudeStdinGuard({
      forward: (text, callback) => {
        forwarded.push(text);
        callback();
      },
      end: (callback) => callback(),
      onViolation: () => {
        violations += 1;
      },
    });
    await writeTo(duplicate, `${initialize}\n`);
    await writeTo(duplicate, `${initialize}\n`);
    expect(violations).toBe(3);
  });
});
