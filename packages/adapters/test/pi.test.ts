import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AdapterEvent,
  createAdapter,
  describeInvocation,
  discoverPiModels,
  getProvider,
  materializeInvocation,
  type PiModelDiscoveryRequest,
  piConfigIdentity,
  piCredentialScope,
  providerIds,
} from "../src/index.js";
import { request, TOKEN } from "./helpers.js";

const STUB = fileURLToPath(new URL("./stubs/pi-cli.mjs", import.meta.url));
const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function stubBin(): Promise<{ dir: string; bin: string; logPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "devchestra-pi-"));
  temps.push(dir);
  const bin = join(dir, "pi-stub.mjs");
  await copyFile(STUB, bin);
  await chmod(bin, 0o755);
  return { dir, bin, logPath: join(dir, "calls.log") };
}

function envFor(logPath: string, scenario: Record<string, unknown>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/nonexistent-home",
    STUB_LOG: logPath,
    STUB_SCENARIO_JSON: JSON.stringify(scenario),
  };
}

async function calls(logPath: string): Promise<{ argv: string[] }[]> {
  const text = await readFile(logPath, "utf8");
  return text
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { argv: string[] });
}

function discoveryReq(
  cwd: string,
  logPath: string,
  scenario: Record<string, unknown>,
  extra: Partial<PiModelDiscoveryRequest> = {},
): PiModelDiscoveryRequest {
  return {
    cwd,
    env: envFor(logPath, scenario),
    timeoutMs: 5_000,
    ...extra,
  };
}

function parseAll(text: string, chunks: number): AdapterEvent[] {
  const parser = createAdapter("pi", { piBin: "/nonexistent-pi" }).parser();
  const buffer = Buffer.from(text);
  const size = Math.max(1, Math.ceil(buffer.length / chunks));
  const out: AdapterEvent[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    out.push(...parser.feed(buffer.subarray(offset, Math.min(offset + size, buffer.length))));
  }
  return [...out, ...parser.end()];
}

const STREAM = [
  '{"type":"session","version":3,"id":"01a17f07-a112-774b-8984-a85600c262d6","cwd":"/work"}',
  '{"type":"agent_start"}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls"}}],"usage":{"input":100,"output":20,"totalTokens":120,"cost":{"total":0.001}},"stopReason":"toolUse"}}',
  '{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}',
  '{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_2","toolName":"read","content":[{"type":"text","text":"data"}],"isError":true}}',
  '{"type":"turn_end","message":{"role":"assistant","content":[],"usage":{"input":100,"output":20,"totalTokens":120,"cost":{"total":0.001}},"stopReason":"stop"},"toolResults":[]}',
  '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"Connection error."}',
  '{"type":"agent_settled","aborted":false}',
  "not json at all",
].join("\n");

describe("pi plan", () => {
  it("builds -p --mode json argv with prompt after -- and token only in files/env", () => {
    const adapter = createAdapter("pi", { piBin: "/bin/pi" });
    const result = adapter.plan(request({ model: "opencode-go/kimi-k3", prompt: "-do it" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bin).toBe("/bin/pi");
    expect(result.value.args).toEqual([
      "-p",
      "--mode",
      "json",
      "--session-dir",
      "/pi-sessions",
      "--provider",
      "opencode-go",
      "--model",
      "opencode-go/kimi-k3",
      "--exclude-tools",
      "edit,write,bash,powershell,web_search,web_fetch",
      "--no-approve",
      "--",
      "-do it",
    ]);
    expect(result.value.cwd).toBe("/work");
    expect(JSON.stringify(result.value.args)).not.toContain(TOKEN);
    expect(JSON.stringify(describeInvocation(result.value))).not.toContain(TOKEN);
    expect(result.value.files).toHaveLength(1);
    expect(result.value.files[0]?.path).toBe("/run/pi-home/mcp.json");
    expect(result.value.files[0]?.mode).toBe(0o600);
    const mcp = JSON.parse(result.value.files[0]?.content ?? "{}") as {
      mcpServers: { devchestra: { exposure: string; env: Record<string, string> } };
    };
    expect(mcp.mcpServers.devchestra.exposure).toBe("direct");
    expect(mcp.mcpServers.devchestra.env.DEVCHESTRA_EXEC_TOKEN).toBe(TOKEN);
    expect(result.value.env.PI_CODING_AGENT_DIR).toBe("/run/pi-home");
    expect(result.value.env.DEVCHESTRA_EXEC_TOKEN).toBe(TOKEN);
    expect(result.value.stdin).toBeUndefined();
  });

  it("resumes via --session-id and honors explicit approve/provider", () => {
    const adapter = createAdapter("pi");
    const resumed = adapter.plan(
      request({
        mode: "resume",
        sessionId: "01a17f07-a112-774b-8984-a85600c262d6",
        model: "kimi-k3",
        permissions: { network: true, write: ["workspace"], extraReadDirs: [] },
        cliOptions: { approve: true, provider: "opencode-go" },
      }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.args).toContain("--session-id");
    expect(resumed.value.args).toContain("01a17f07-a112-774b-8984-a85600c262d6");
    expect(resumed.value.args).toContain("--approve");
    expect(resumed.value.args).not.toContain("--no-approve");
    expect(resumed.value.args).not.toContain("--exclude-tools");
  });

  it("rejects unsafe sessions, stray options and provider without model", () => {
    const adapter = createAdapter("pi");
    expect(adapter.plan(request({ mode: "resume", sessionId: "../escape" })).ok).toBe(false);
    expect(adapter.plan(request({ mode: "resume" })).ok).toBe(false);
    expect(adapter.plan(request({ cliOptions: { sandbox: "x" } })).ok).toBe(false);
    expect(adapter.plan(request({ cliOptions: { approve: "yes" } })).ok).toBe(false);
    expect(adapter.plan(request({ cliOptions: { provider: "opencode-go" } })).ok).toBe(false);
    expect(adapter.plan(request({ model: "x", cliOptions: { provider: "../evil" } })).ok).toBe(
      false,
    );
    expect(adapter.plan(request({ mcp: { serverName: "other" } } as never)).ok).toBe(false);
  });
});

describe("pi parser", () => {
  it("maps session, text, tool lifecycle, usage, turn_end and notices", () => {
    const events = parseAll(STREAM, 1);
    expect(events.map((event) => event.t)).toEqual([
      "session",
      "text",
      "tool_call",
      "usage",
      "tool_result",
      "tool_result",
      "turn_end",
      "notice",
      "raw",
    ]);
    expect(events[0]).toEqual({ t: "session", sessionId: "01a17f07-a112-774b-8984-a85600c262d6" });
    expect(events[2]).toMatchObject({ t: "tool_call", id: "call_1", name: "bash" });
    expect(events[3]).toEqual({
      t: "usage",
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.001,
      cumulative: false,
    });
    expect(events[4]).toMatchObject({ t: "tool_result", id: "call_1", ok: true, summary: "ok" });
    expect(events[5]).toMatchObject({ t: "tool_result", id: "call_2", ok: false });
    expect(events[6]).toMatchObject({ t: "turn_end", isError: false });
    expect(events[7]).toMatchObject({ t: "notice", level: "warn" });
  });

  it("dedupes tool calls seen in deltas and reports error turns", () => {
    const text = [
      '{"type":"message_update","usage":{"input":10,"output":1,"totalTokens":11,"cost":{"total":0}},"assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"call_9","name":"read","arguments":{"path":"x"}}}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_9","name":"read","arguments":{"path":"x"}}],"usage":{"input":10,"output":1,"totalTokens":11,"cost":{"total":0}},"stopReason":"toolUse"}}',
      '{"type":"turn_end","message":{"role":"assistant","content":[],"usage":{"input":10,"output":1,"totalTokens":11,"cost":{"total":0}},"stopReason":"error","errorMessage":"boom"},"toolResults":[]}',
    ].join("\n");
    const events = parseAll(text, 4);
    expect(events.filter((event) => event.t === "tool_call")).toHaveLength(1);
    expect(events.filter((event) => event.t === "usage")).toHaveLength(1);
    expect(events).toContainEqual({ t: "turn_end", isError: true, text: "boom" });
  });

  it("is chunk-boundary safe", () => {
    expect(parseAll(STREAM, 53)).toEqual(parseAll(STREAM, 1));
  });

  it("counts each completed message once and keeps message_end text authoritative", () => {
    const text = [
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hel"}}',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"hello"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"usage":{"input":100,"output":5},"stopReason":"stop"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"world"}],"usage":{"input":110,"output":7},"stopReason":"stop"}}',
      '{"type":"turn_end","message":{"role":"assistant","content":[],"usage":{"input":110,"output":7},"stopReason":"stop"},"toolResults":[]}',
    ].join("\n");
    const events = parseAll(text, 1);
    expect(events.filter((event) => event.t === "text")).toEqual([
      { t: "text", role: "assistant", text: "hello" },
      { t: "text", role: "assistant", text: "world" },
    ]);
    expect(events.filter((event) => event.t === "usage")).toEqual([
      { t: "usage", tokensIn: 100, tokensOut: 5, cumulative: false },
      { t: "usage", tokensIn: 110, tokensOut: 7, cumulative: false },
    ]);
    expect(events.filter((event) => event.t === "turn_end")).toEqual([
      { t: "turn_end", isError: false },
    ]);
  });
});

describe("pi discovery", () => {
  it("parses the list-models table with provider/model and skips the header", async () => {
    const { dir, bin, logPath } = await stubBin();
    const result = await discoverPiModels(
      discoveryReq(
        dir,
        logPath,
        {
          table:
            "provider      model                   context  max-out  thinking  images\nopencode-go   kimi-k3                 1.0M     131.1K   yes       yes   \nnvidia        moonshotai/kimi-k2.6    262.1K   262.1K   yes       yes   \n",
        },
        { bin },
      ),
    );
    expect(result.status).toBe("ready");
    expect(result.cliVersion).toBe("1.4.0");
    expect(result.items).toEqual([
      {
        id: "opencode-go/kimi-k3",
        label: "kimi-k3",
        provider: "opencode-go",
        source: "pi-list-models",
      },
      {
        id: "nvidia/moonshotai/kimi-k2.6",
        label: "moonshotai/kimi-k2.6",
        provider: "nvidia",
        source: "pi-list-models",
      },
    ]);
    const argv = (await calls(logPath)).map((call) => call.argv);
    expect(argv[0]).toEqual(["--version"]);
    expect(argv[1]).toEqual(["--list-models"]);
  });

  it("passes search positionally, caps models and rejects dash searches", async () => {
    const { dir, bin, logPath } = await stubBin();
    const searched = await discoverPiModels(
      discoveryReq(dir, logPath, {}, { bin, search: "kimi" }),
    );
    expect(searched.status).toBe("ready");
    expect((await calls(logPath)).at(-1)?.argv).toEqual(["--list-models", "kimi"]);
    const many = Array.from(
      { length: 5 },
      (_, i) => `opencode-go   m${i}   1M   1K   yes   no`,
    ).join("\n");
    const capped = await discoverPiModels(
      discoveryReq(dir, logPath, { table: `provider model\n${many}\n` }, { bin, maxModels: 2 }),
    );
    expect(capped.items).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    const dashed = await discoverPiModels(
      discoveryReq(dir, logPath, {}, { bin, search: "--help" }),
    );
    expect(dashed.status).toBe("unavailable");
    expect((await calls(logPath)).some((call) => call.argv.includes("--help"))).toBe(false);
  });

  it("keeps already-qualified model ids without doubling the provider", async () => {
    const { dir, bin, logPath } = await stubBin();
    const result = await discoverPiModels(
      discoveryReq(
        dir,
        logPath,
        { table: "provider   model\nopencode-go  opencode-go/kimi-k3\n" },
        { bin },
      ),
    );
    expect(result.status).toBe("ready");
    expect(result.items).toEqual([
      {
        id: "opencode-go/kimi-k3",
        label: "opencode-go/kimi-k3",
        provider: "opencode-go",
        source: "pi-list-models",
      },
    ]);
  });

  it("links the canonical auth/models/settings store into the isolated home", async () => {
    const base = await mkdtemp(join(tmpdir(), "devchestra-pi-home-"));
    temps.push(base);
    const canonical = join(base, "home", ".pi", "agent");
    await mkdir(canonical, { recursive: true });
    for (const name of ["auth.json", "models.json", "settings.json"]) {
      await writeFile(join(canonical, name), `{"${name}":true}\n`);
    }
    const execDir = join(base, "exec");
    await mkdir(execDir, { recursive: true });
    const adapter = createAdapter("pi", { piBin: "/bin/pi" });
    const result = adapter.plan(
      request({
        env: { PATH: "/usr/bin:/bin", HOME: join(base, "home") },
        execDir,
        cwd: base,
        // Provider keys must reach the child so API-key providers
        // authenticate without auth.json as well.
        mcp: {
          serverName: "devchestra",
          command: "/usr/bin/node",
          args: ["/abs/shim.js"],
          env: { DEVCHESTRA_EXEC_TOKEN: TOKEN, OPENCODE_API_KEY: "oc-test-key" },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const links = result.value.files.filter((file) => file.symlink !== undefined);
    expect(links.map((file) => file.path).sort()).toEqual(
      ["auth.json", "models.json", "settings.json"]
        .map((name) => join(execDir, "pi-home", name))
        .sort(),
    );
    expect(links.every((file) => file.symlink?.startsWith(canonical))).toBe(true);
    expect(result.value.env.OPENCODE_API_KEY).toBe("oc-test-key");
    await materializeInvocation(result.value);
    expect(await readlink(join(execDir, "pi-home", "auth.json"))).toBe(
      join(canonical, "auth.json"),
    );
    // Writes through the link persist back to the canonical store.
    await writeFile(join(execDir, "pi-home", "auth.json"), '{"refreshed":true}\n');
    expect(await readFile(join(canonical, "auth.json"), "utf8")).toBe('{"refreshed":true}\n');
  });

  it("scopes the credential lock to the canonical store only when it exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "devchestra-pi-scope-"));
    temps.push(base);
    const home = join(base, "home");
    expect(piCredentialScope({ PATH: "/usr/bin", HOME: home }, base)).toBeNull();
    const canonical = join(home, ".pi", "agent");
    await mkdir(canonical, { recursive: true });
    expect(piCredentialScope({ PATH: "/usr/bin", HOME: home }, base)).toBeNull();
    await writeFile(join(canonical, "auth.json"), "{}\n");
    expect(piCredentialScope({ PATH: "/usr/bin", HOME: home }, base)).toBe(canonical);
    expect(
      piCredentialScope({ PATH: "/usr/bin", HOME: home, PI_CODING_AGENT_DIR: canonical }, base),
    ).toBe(canonical);
  });

  it("keeps the isolated home self-contained when no canonical store exists", async () => {
    const adapter = createAdapter("pi", { piBin: "/bin/pi" });
    const result = adapter.plan(request({ model: "opencode-go/kimi-k3" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toHaveLength(1);
    expect(result.value.files[0]).toMatchObject({ path: "/run/pi-home/mcp.json" });
  });

  it("maps empty catalogs to authRequired and missing binaries to unavailable", async () => {
    const { dir, bin, logPath } = await stubBin();
    const auth = await discoverPiModels(
      discoveryReq(
        dir,
        logPath,
        {
          table: "provider  model\n",
          stderr: "No models available. Use /login to log in.",
        },
        { bin },
      ),
    );
    expect(auth.status).toBe("authRequired");
    expect(auth.items).toEqual([]);
    const missing = await discoverPiModels({
      cwd: dir,
      bin: join(dir, "missing-pi"),
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 2_000,
    });
    expect(missing.status).toBe("unavailable");
    expect(missing.message).toBe("Pi CLI was not found.");
  });

  it("stats mcp.json/models.json/auth.json for context identity without reading values", async () => {
    const base = await mkdtemp(join(tmpdir(), "devchestra-pi-identity-"));
    temps.push(base);
    const home = join(base, "agent");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "mcp.json"), '{"mcpServers":{}}');
    const withFiles = piConfigIdentity({ PI_CODING_AGENT_DIR: home }, base);
    expect(withFiles).toContain("mcp.json:f:");
    expect(withFiles).toContain("models.json:missing");
    expect(withFiles).toContain("auth.json:missing");
    expect(withFiles).not.toContain("mcpServers");
    const missing = piConfigIdentity({ HOME: join(base, "nope") }, base);
    expect(missing).toContain("mcp.json:missing");
    expect(missing).toContain("auth.json:missing");
  });
});

describe("pi wiring", () => {
  it("registers the adapter, probe, toolRef and identity", async () => {
    expect(providerIds()).toContain("pi");
    const provider = getProvider("pi");
    expect(provider.modelArg).toBe("--model");
    expect(provider.contextIdentity.configFiles).toEqual(["mcp.json", "models.json", "auth.json"]);
    const adapter = createAdapter("pi", { piBin: "/bin/pi" });
    expect(adapter.id).toBe("pi");
    expect(adapter.toolRef("submit_result")).toBe("mcp__devchestra__submit_result");
    expect(
      adapter.classify(
        {
          code: 1,
          signal: null,
          killedBy: null,
          durationMs: 1,
          pid: 1,
          stdoutBytes: 0,
          stderrBytes: 0,
          sawTurnEnd: false,
          groupStopped: true,
          tail: { stderr: "", stdout: "" },
        },
        { stderr: "", stdout: "" },
      ),
    ).toEqual({ kind: "crash", exitCode: 1, signal: null });

    const { bin, logPath } = await stubBin();
    const probed = await adapter.probe(
      { bin, env: envFor(logPath, {}), timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(probed).toMatchObject({ ok: true, version: "1.4.0" });
  });
});
