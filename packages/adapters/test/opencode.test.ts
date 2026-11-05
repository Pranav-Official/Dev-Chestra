import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAdapter,
  describeInvocation,
  discoverOpencodeModels,
  type OpencodeModelDiscoveryRequest,
  opencodeConfigIdentity,
} from "../src/index.js";
import { splitOpencodeMcpTool } from "../src/opencode.js";
import { FIXTURES, fixtureJson, fixtureText, request, TOKEN } from "./helpers.js";

const STANDIN = resolve(FIXTURES, "..", "opencode", "standin.mjs");
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
  pid?: number;
  argv?: string[];
  env?: Record<string, string | null>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "devchestra-opencode-"));
  temps.push(dir);
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  const bin = join(dir, "opencode-standin.mjs");
  await copyFile(STANDIN, bin);
  await chmod(bin, 0o755);
  return {
    dir,
    bin,
    scenarioPath: join(dir, "scenario.json"),
    logPath: join(dir, "calls.log"),
    home,
  };
}

type Options = Omit<Partial<OpencodeModelDiscoveryRequest>, "cwd" | "bin" | "env">;

async function run(
  h: Harness,
  scenario: Record<string, unknown>,
  options: Options = {},
  envExtra: Record<string, string> = {},
): Promise<{ result: Awaited<ReturnType<typeof discoverOpencodeModels>>; calls: Call[] }> {
  await writeFile(h.scenarioPath, JSON.stringify(scenario));
  await writeFile(h.logPath, "");
  const result = await discoverOpencodeModels({
    cwd: h.dir,
    bin: h.bin,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: h.home,
      STUB_SCENARIO: h.scenarioPath,
      STUB_LOG: h.logPath,
      ...envExtra,
    },
    timeoutMs: 5_000,
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

describe("opencode plan", () => {
  it("matches the fresh golden argv and keeps the token out of argv", () => {
    const adapter = createAdapter("opencode");
    const result = adapter.plan(
      request({
        model: "opencode/gpt-5",
        permissions: { network: false, write: [], extraReadDirs: [] },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bin).toBe("opencode");
    expect(result.value.args).toEqual(fixtureJson("golden", "opencode-fresh.json").args);
    expect(JSON.stringify(result.value.args)).not.toContain(TOKEN);
    expect(JSON.stringify(describeInvocation(result.value))).not.toContain(TOKEN);
    expect(result.value.files).toEqual([]);
    expect(result.value.stdin).toBeUndefined();
    expect(result.value.env.DEVCHESTRA_EXEC_TOKEN).toBe(TOKEN);
    // MCP attaches through inline config, not argv or files: env alone
    // never registers a server with the child.
    const inline = JSON.parse(result.value.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      mcp?: Record<string, Record<string, unknown>>;
    };
    expect(inline.mcp?.devchestra).toMatchObject({
      type: "local",
      command: ["/usr/bin/node", "/abs/shim.js"],
      environment: {
        DEVCHESTRA_EXEC_TOKEN: TOKEN,
        DEVCHESTRA_GATEWAY_URL: "http://127.0.0.1:4310",
        DEVCHESTRA_TOOLSET: "agent",
      },
      enabled: true,
    });
    expect(JSON.stringify(result.value.env.OPENCODE_CONFIG_CONTENT)).toContain(TOKEN);
  });

  it("matches resume argv with --session and uses --standalone and no --dir", () => {
    const adapter = createAdapter("opencode");
    const result = adapter.plan(
      request({ mode: "resume", sessionId: "ses_494719016ffe85dkDMj0FPRbHK" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.args).toEqual(fixtureJson("golden", "opencode-resume.json").args);
    expect(result.value.args).toContain("--session");
    expect(result.value.cwd).toBe("/work");
  });

  it("passes discovered ids through --model verbatim", () => {
    const adapter = createAdapter("opencode");
    const id = "opencode/gpt-5.1-codex-max";
    const result = adapter.plan(request({ model: id }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flag = result.value.args.indexOf("--model");
    expect(flag).toBeGreaterThan(-1);
    expect(result.value.args[flag + 1]).toBe(id);
  });

  it("attaches the MCP config on resume and prefixes the submit tool", () => {
    const adapter = createAdapter("opencode");
    expect(adapter.toolRef("submit_result")).toBe("devchestra_submit_result");
    const resumed = adapter.plan(
      request({ mode: "resume", sessionId: "ses_494719016ffe85dkDMj0FPRbHK" }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.env.OPENCODE_CONFIG_CONTENT).toContain('"devchestra"');
    expect(
      adapter.plan(
        request({
          mcp: {
            serverName: "other",
            command: "/usr/bin/node",
            args: ["/abs/shim.js"],
            env: { DEVCHESTRA_EXEC_TOKEN: TOKEN },
          },
        }),
      ).ok,
    ).toBe(false);
  });

  it("rejects unknown options, bad sessions, prompts and models", () => {
    const adapter = createAdapter("opencode");
    expect(adapter.plan(request({ cliOptions: { sandbox: "x" } })).ok).toBe(false);
    expect(adapter.plan(request({ mode: "resume", sessionId: "not-a-session" })).ok).toBe(false);
    expect(adapter.plan(request({ mode: "resume" })).ok).toBe(false);
    expect(
      adapter.plan(request({ mode: "resume", sessionId: "11111111-1111-4111-8111-111111111111" }))
        .ok,
    ).toBe(false);
    expect(adapter.plan(request({ prompt: "" })).ok).toBe(false);
    expect(adapter.plan(request({ model: "bad\u0000model" })).ok).toBe(false);
    expect(adapter.plan(request({ model: "has\ncontrol" })).ok).toBe(false);
    expect(adapter.plan(request({ prompt: `x`.repeat(257 * 1024) })).ok).toBe(false);
  });

  it("never emits bypass/danger flags", () => {
    const adapter = createAdapter("opencode");
    const planned = adapter.plan(
      request({ permissions: { network: true, write: ["workspace"], extraReadDirs: [] } }),
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const joined = planned.value.args.join(" ");
    expect(joined).not.toContain("bypass");
    expect(joined).not.toContain("danger");
    expect(joined).toContain("--standalone");
    expect(joined).not.toContain("--dir");
  });
});

describe("opencode parser", () => {
  const text = fixtureText("streams", "opencode", "basic.ndjson");

  function parse(input: string, chunks: number) {
    const parser = createAdapter("opencode").parser();
    const size = Math.max(1, Math.ceil(Buffer.byteLength(input) / chunks));
    const buffer = Buffer.from(input);
    const output = [];
    for (let offset = 0; offset < buffer.length; offset += size) {
      output.push(...parser.feed(buffer.subarray(offset, Math.min(offset + size, buffer.length))));
    }
    return [...output, ...parser.end()];
  }

  it("maps session, tool, text, usage deltas and turn_end", () => {
    const events = parse(text, 1);
    expect(events.map((event) => event.t)).toEqual([
      "session",
      "tool_call",
      "tool_result",
      "text",
      "usage",
      "text",
      "usage",
      "turn_end",
    ]);
    expect(events[0]).toEqual({ t: "session", sessionId: "ses_494719016ffe85dkDMj0FPRbHK" });
    expect(events[1]).toMatchObject({ t: "tool_call", id: "call_submit_1", name: "submit_result" });
    expect(events[2]).toEqual({
      t: "tool_result",
      id: "call_submit_1",
      ok: true,
      summary: "accepted",
    });
    expect(events[4]).toEqual({
      t: "usage",
      tokensIn: 21772,
      tokensOut: 110,
      costUsd: 0,
      cumulative: false,
    });
    expect(events[6]).toMatchObject({ t: "usage", tokensIn: 671, tokensOut: 8 });
    expect(events[7]).toEqual({ t: "turn_end", isError: false });
  });

  it("is chunk-boundary safe", () => {
    expect(parse(text, 97)).toEqual(parse(text, 1));
  });

  it("emits per-step usage directly instead of subtracting across steps", () => {
    const step = (input: number, output: number): string =>
      `{"type":"step_finish","part":{"tokens":{"input":${input},"output":${output}},"cost":0}}\n`;
    const events = parse(`${step(100, 5)}${step(110, 7)}`, 1);
    expect(events).toEqual([
      { t: "usage", tokensIn: 100, tokensOut: 5, costUsd: 0, cumulative: false },
      { t: "usage", tokensIn: 110, tokensOut: 7, costUsd: 0, cumulative: false },
    ]);
  });

  it("maps error events to failed turn_end and unknown lines to raw", () => {
    const events = parse(
      '{"type":"error","timestamp":1,"sessionID":"ses_abc123","error":{"name":"APIError","data":{"message":"Rate limit exceeded"}}}\n{"type":"future","x":1}\nnot json\n',
      2,
    );
    expect(events[0]).toEqual({ t: "session", sessionId: "ses_abc123" });
    expect(events[1]).toEqual({ t: "turn_end", isError: true, text: "Rate limit exceeded" });
    expect(events[2]).toEqual({ t: "raw", line: '{"type":"future","x":1}' });
    expect(events[3]).toEqual({ t: "raw", line: "not json" });
  });
});

describe("opencode classify", () => {
  const exit = {
    code: 0,
    signal: null,
    killedBy: null,
    durationMs: 1,
    pid: 1,
    stdoutBytes: 0,
    stderrBytes: 0,
    sawTurnEnd: false,
    groupStopped: true,
    tail: { stderr: "", stdout: "" },
  } as const;

  it("classifies exits without guessing quotas", () => {
    const adapter = createAdapter("opencode");
    expect(adapter.classify(exit, { stderr: "", stdout: "" })).toEqual({ kind: "ok" });
    expect(
      adapter.classify({ ...exit, code: 1, signal: null }, { stderr: "boom", stdout: "" }),
    ).toEqual({ kind: "crash", exitCode: 1, signal: null });
    expect(
      adapter.classify({ ...exit, killedBy: "timeout", code: null, signal: "SIGTERM" }, exit.tail),
    ).toEqual({ kind: "timeout" });
    expect(
      adapter.classify({ ...exit, killedBy: "cancel", code: null, signal: "SIGTERM" }, exit.tail),
    ).toEqual({ kind: "cancelled" });
  });
});

describe("discoverOpencodeModels", () => {
  it("parses provider/model lines with exact id passthrough", async () => {
    const h = await harness();
    const { result, calls } = await run(h, {
      models: ["opencode/gpt-5", "anthropic/claude-sonnet-4-5", "opencode/gpt-5"],
    });
    expect(result.status).toBe("ready");
    expect(result.cliVersion).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.items).toEqual([
      {
        id: "opencode/gpt-5",
        label: "opencode/gpt-5",
        provider: "opencode",
        source: "opencode-models",
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        label: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        source: "opencode-models",
      },
    ]);
    expect(calls.find((call) => call.t === "spawn")?.argv).toEqual(["models"]);
  });

  it("reads verbose name labels and flags malformed lines as truncated", async () => {
    const h = await harness();
    const { result, calls } = await run(
      h,
      {
        verbose: [
          "opencode/beam-free",
          "{",
          '  "name": "Beam Free",',
          "}",
          "not an id at all",
          "opencode/big-pickle",
          "{",
          '  "name": "Big Pickle",',
          "}",
        ],
      },
      { verbose: true },
    );
    expect(result.status).toBe("ready");
    expect(result.truncated).toBe(true);
    expect(result.items.map((item) => [item.id, item.label])).toEqual([
      ["opencode/beam-free", "Beam Free"],
      ["opencode/big-pickle", "Big Pickle"],
    ]);
    expect(calls.find((call) => call.t === "spawn")?.argv).toEqual(["models", "--verbose"]);
  });

  it("caps items at maxModels and reports truncation", async () => {
    const h = await harness();
    const { result } = await run(h, { models: ["a/one", "b/two", "c/three"] }, { maxModels: 2 });
    expect(result.status).toBe("ready");
    expect(result.truncated).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual(["a/one", "b/two"]);
  });

  it("reports authRequired without echoing provider output", async () => {
    const h = await harness();
    const { result } = await run(h, {
      exitCode: 1,
      stderr: "Please run `opencode auth login` (token sk-live-secret)",
    });
    expect(result.status).toBe("authRequired");
    expect(result.message).toBe("Opencode requires authentication to list models.");
    expect(JSON.stringify(result)).not.toContain("sk-live-secret");
  });

  it("reports unsupported, missing and oversize safely", async () => {
    const h = await harness();
    const unsupported = await run(h, { exitCode: 2, stderr: "error: unknown flag --nope" });
    expect(unsupported.result.status).toBe("unsupported");

    const missing = await discoverOpencodeModels({
      cwd: h.dir,
      bin: join(h.dir, "no-such-binary"),
      env: { PATH: "/usr/bin:/bin", HOME: h.home },
      timeoutMs: 2_000,
    });
    expect(missing.status).toBe("unavailable");
    expect(missing.message).toBe("Opencode CLI was not found.");

    const oversize = await run(
      h,
      { models: [`opencode/${"x".repeat(200)}`] },
      { maxStdoutBytes: 64 },
    );
    expect(oversize.result.status).toBe("unavailable");
    expect(oversize.result.message).toBe("Opencode model output exceeded safe limits.");
  });

  it("honours cancellation", async () => {
    const h = await harness();
    const controller = new AbortController();
    controller.abort();
    const result = await discoverOpencodeModels({
      cwd: h.dir,
      bin: h.bin,
      env: { PATH: "/usr/bin:/bin", HOME: h.home },
      signal: controller.signal,
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Opencode model discovery was cancelled.");
  });
});

describe("opencodeConfigIdentity", () => {
  async function configHome(): Promise<{ home: string; dir: string }> {
    const home = await mkdtemp(join(tmpdir(), "devchestra-opencode-id-"));
    temps.push(home);
    const dir = join(home, ".config", "opencode");
    await mkdir(dir, { recursive: true });
    return { home, dir };
  }

  it("stats only opencode.json and auth.json, never their contents", async () => {
    const { home, dir } = await configHome();
    await writeFile(join(dir, "opencode.json"), '{"secret":"shh"}\n');
    await writeFile(join(dir, "auth.json"), '{"token":"tok"}\n');
    await writeFile(join(dir, "other.json"), "unrelated\n");
    const identity = opencodeConfigIdentity({ HOME: home }, dir);
    expect(identity).toContain("opencode.json:f:");
    expect(identity).toContain("auth.json:f:");
    expect(identity).not.toContain("other.json");
    expect(identity).not.toContain("shh");
    expect(identity).not.toContain("tok");
  });

  it("marks missing files and honours XDG_CONFIG_HOME", async () => {
    const { home } = await configHome();
    const missing = opencodeConfigIdentity({ HOME: home }, home);
    expect(missing).toContain("opencode.json:missing");
    expect(missing).toContain("auth.json:missing");

    const xdg = await mkdtemp(join(tmpdir(), "devchestra-opencode-xdg-"));
    temps.push(xdg);
    const xdgDir = join(xdg, "opencode");
    await mkdir(xdgDir, { recursive: true });
    await writeFile(join(xdgDir, "opencode.json"), "{}\n");
    const identity = opencodeConfigIdentity({ HOME: "/nonexistent", XDG_CONFIG_HOME: xdg }, home);
    expect(identity).toContain("opencode.json:f:");
    expect(identity).toContain("auth.json:missing");
  });
});

describe("opencode mcp selection", () => {
  const SECRET = "header-secret-value-xyz";

  function planned(overrides: Parameters<typeof request>[0]) {
    const adapter = createAdapter("opencode");
    const result = adapter.plan(request(overrides));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("plan failed unexpectedly");
    return result.value;
  }

  function inlineConfig(inv: { env: Record<string, string> }): Record<string, unknown> {
    return JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>;
  }

  it("attaches stdio and remote extras with enabled:true", () => {
    const inv = planned({
      extraMcp: [
        {
          name: "fixture",
          scope: "global",
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["echo-server.mjs"],
          env: { FIXTURE_MCP_NAME: "fixture" },
          cwd: "/work",
        },
        {
          name: "remote",
          scope: "project",
          transport: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: `Bearer ${SECRET}` },
        },
      ],
    });
    const config = inlineConfig(inv);
    expect(config.mcp).toMatchObject({
      devchestra: { type: "local", enabled: true },
      fixture: {
        type: "local",
        command: ["/usr/bin/node", "echo-server.mjs"],
        environment: { FIXTURE_MCP_NAME: "fixture" },
        cwd: "/work",
        enabled: true,
      },
      remote: {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: `Bearer ${SECRET}` },
        enabled: true,
      },
    });
    // Secrets travel in the child env, never in argv.
    expect(JSON.stringify(inv.args)).not.toContain(SECRET);
    expect(JSON.stringify(describeInvocation(inv))).not.toContain(SECRET);
  });

  it("switches off known-but-unselected servers and never devchestra", () => {
    const inv = planned({
      extraMcp: [
        {
          name: "fixture",
          scope: "global",
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["x.mjs"],
        },
      ],
      knownMcp: [
        { name: "fixture", scope: "global" },
        { name: "other", scope: "global" },
        { name: "docs", scope: "project" },
        { name: "devchestra", scope: "global" },
      ],
    });
    const config = inlineConfig(inv);
    const mcp = config.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.other).toEqual({ enabled: false });
    expect(mcp.docs).toEqual({ enabled: false });
    expect(mcp.fixture).toMatchObject({ enabled: true, type: "local" });
    expect(mcp.devchestra).toMatchObject({ enabled: true, type: "local" });
  });

  it("emits no mcp extras when the engine selected nothing", () => {
    const inv = planned({});
    const config = inlineConfig(inv);
    expect(Object.keys(config.mcp as Record<string, unknown>)).toEqual(["devchestra"]);
    expect(config.permission).toBeUndefined();
  });

  it("denies bash only when shell is false", () => {
    const off = inlineConfig(
      planned({
        permissions: { network: false, write: ["workspace"], extraReadDirs: [], shell: false },
      }),
    );
    expect(off.permission).toEqual({ bash: "deny" });
    const on = inlineConfig(
      planned({ permissions: { network: false, write: [], extraReadDirs: [], shell: true } }),
    );
    expect(on.permission).toBeUndefined();
    const legacy = inlineConfig(planned({}));
    expect(legacy.permission).toBeUndefined();
  });

  it("rejects unsafe names, devchestra, duplicates and missing launch details", () => {
    const adapter = createAdapter("opencode");
    const bad = [
      { extraMcp: [{ name: "evil.name", scope: "global", transport: "stdio", command: "x" }] },
      { extraMcp: [{ name: "devchestra", scope: "global", transport: "stdio", command: "x" }] },
      {
        extraMcp: [
          { name: "dup", scope: "global", transport: "stdio", command: "x" },
          { name: "dup", scope: "global", transport: "stdio", command: "y" },
        ],
      },
      { extraMcp: [{ name: "nocmd", scope: "global", transport: "stdio" }] },
      { extraMcp: [{ name: "nourl", scope: "global", transport: "http" }] },
      { knownMcp: [{ name: "evil name", scope: "global" }] },
    ] as Parameters<typeof request>[0][];
    for (const overrides of bad) {
      expect(adapter.plan(request(overrides)).ok).toBe(false);
    }
  });
});

describe("splitOpencodeMcpTool", () => {
  const servers = ["devchestra", "fixture", "my-server"];

  it("splits <server>_<tool> on the longest known prefix", () => {
    expect(splitOpencodeMcpTool("devchestra_submit_result", servers)).toEqual({
      server: "devchestra",
      tool: "submit_result",
    });
    expect(splitOpencodeMcpTool("fixture_fixture_echo", servers)).toEqual({
      server: "fixture",
      tool: "fixture_echo",
    });
    expect(splitOpencodeMcpTool("my-server_do_thing", servers)).toEqual({
      server: "my-server",
      tool: "do_thing",
    });
  });

  it("returns null for built-ins and unknown servers", () => {
    expect(splitOpencodeMcpTool("bash", servers)).toBeNull();
    expect(splitOpencodeMcpTool("read", servers)).toBeNull();
    expect(splitOpencodeMcpTool("unknown_tool", servers)).toBeNull();
    expect(splitOpencodeMcpTool("devchestra_", servers)).toBeNull();
    expect(splitOpencodeMcpTool("devchestra_submit_result", [])).toBeNull();
  });

  it("prefers the longest server prefix on overlap", () => {
    expect(splitOpencodeMcpTool("ab_c", ["a", "ab"])).toEqual({ server: "ab", tool: "c" });
  });
});
describe("opencode probe", () => {
  it("reports the standin version and fails safe when missing", async () => {
    const h = await harness();
    const adapter = createAdapter("opencode", { opencodeBin: h.bin });
    const controller = new AbortController();
    const probed = await adapter.probe({}, controller.signal);
    expect(probed.ok).toBe(true);
    expect(probed.version).toBe("1.19.4");

    const missing = createAdapter("opencode", { opencodeBin: join(h.dir, "no-such-binary") });
    const failed = await missing.probe({}, controller.signal);
    expect(failed.ok).toBe(false);
    expect(failed.version).toBeNull();
  });
});
