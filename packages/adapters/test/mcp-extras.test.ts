import { describe, expect, it } from "vitest";
import {
  type AdapterEvent,
  createAdapter,
  describeInvocation,
  type Invocation,
  type ResolvedMcpServer,
} from "../src/index.js";
import { request } from "./helpers.js";

const STDIO_EXTRA: ResolvedMcpServer = {
  name: "fixture",
  scope: "global",
  transport: "stdio",
  command: "/usr/bin/node",
  args: ["/abs/echo-server.mjs"],
  env: { FIXTURE_MCP_NAME: "fixture", FIXTURE_MCP_SECRET: "sekret-123" },
};

const HTTP_EXTRA: ResolvedMcpServer = {
  name: "web",
  scope: "project",
  transport: "http",
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer hunter2" },
};

function planned(id: "claude-code" | "pi", overrides: Parameters<typeof request>[0] = {}) {
  const result = createAdapter(id).plan(request(overrides));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("plan failed unexpectedly");
  return result.value;
}

function mcpFile(inv: Invocation): { mcpServers: Record<string, unknown> } {
  const file = inv.files.find((entry) => entry.path.endsWith("mcp.json"));
  expect(file?.mode).toBe(0o600);
  return JSON.parse(file?.content ?? "{}") as { mcpServers: Record<string, unknown> };
}

function flagValues(inv: Invocation, flag: string): string[] {
  const out: string[] = [];
  inv.args.forEach((arg, i) => {
    if (arg === flag) out.push(inv.args[i + 1] ?? "");
  });
  return out;
}

describe("claude-code extraMcp", () => {
  it("writes no extras by default and keeps strict config", () => {
    const inv = planned("claude-code");
    expect(Object.keys(mcpFile(inv).mcpServers)).toEqual(["devchestra"]);
    expect(inv.args).toContain("--strict-mcp-config");
    const allowed = flagValues(inv, "--allowedTools").join(",");
    expect(allowed).toContain("mcp__devchestra__*");
    expect(allowed).not.toMatch(/mcp__(?!devchestra__).+\*/);
  });

  it("writes stdio+http extras next to devchestra and allows their tools", () => {
    const inv = planned("claude-code", { extraMcp: [STDIO_EXTRA, HTTP_EXTRA] });
    const servers = mcpFile(inv).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["devchestra", "fixture", "web"]);
    expect(servers.fixture).toEqual({
      command: "/usr/bin/node",
      args: ["/abs/echo-server.mjs"],
      env: { FIXTURE_MCP_NAME: "fixture", FIXTURE_MCP_SECRET: "sekret-123" },
    });
    expect(servers.web).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer hunter2" },
    });
    expect(inv.args).toContain("--strict-mcp-config");
    const allowed = flagValues(inv, "--allowedTools").join(",");
    expect(allowed).toContain("mcp__devchestra__*");
    expect(allowed).toContain("mcp__fixture__*");
    expect(allowed).toContain("mcp__web__*");
  });

  it("keeps secrets in the 0600 file, never in argv", () => {
    const inv = planned("claude-code", { extraMcp: [STDIO_EXTRA, HTTP_EXTRA] });
    const argv = JSON.stringify(inv.args);
    expect(argv).not.toContain("sekret-123");
    expect(argv).not.toContain("hunter2");
    expect(JSON.stringify(describeInvocation(inv))).not.toContain("sekret-123");
    expect(JSON.stringify(describeInvocation(inv))).not.toContain("hunter2");
    expect(inv.files[0]?.content).toContain("sekret-123");
    expect(inv.files[0]?.content).toContain("hunter2");
  });

  it("rejects reserved, duplicate and unsafe server names", () => {
    const adapter = createAdapter("claude-code");
    const bad: ResolvedMcpServer[][] = [
      [{ ...STDIO_EXTRA, name: "devchestra" }],
      [STDIO_EXTRA, { ...STDIO_EXTRA, transport: "http", url: "https://x.example" }],
      [{ ...STDIO_EXTRA, name: "../escape" }],
      [{ ...STDIO_EXTRA, name: "has space" }],
      [{ ...STDIO_EXTRA, name: "" }],
    ];
    for (const extraMcp of bad) {
      expect(adapter.plan(request({ extraMcp })).ok).toBe(false);
    }
  });

  it("rejects extras missing their transport details", () => {
    const adapter = createAdapter("claude-code");
    expect(adapter.plan(request({ extraMcp: [{ ...STDIO_EXTRA, command: "" }] })).ok).toBe(false);
    expect(adapter.plan(request({ extraMcp: [{ ...HTTP_EXTRA, url: "" }] })).ok).toBe(false);
    // Connector entries carry no launch details, so they fail fast instead of skipping.
    expect(
      adapter.plan(
        request({ extraMcp: [{ name: "notion", scope: "connector", transport: "stdio" }] }),
      ).ok,
    ).toBe(false);
  });

  it("surfaces extra-server tool calls in parsed output", () => {
    const parser = createAdapter("claude-code").parser();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "mcp__fixture__fixture_echo", input: {} }],
      },
    });
    const events = [...parser.feed(Buffer.from(`${line}\n`)), ...parser.end()];
    expect(events).toContainEqual({
      t: "tool_call",
      id: "t1",
      name: "mcp__fixture__fixture_echo",
      input: {},
    });
    expect(createAdapter("claude-code").toolRef("submit_result")).toBe(
      "mcp__devchestra__submit_result",
    );
  });
});

describe("claude-code shell toggle", () => {
  const cases: {
    shell: boolean | undefined;
    write: ("workspace" | "project")[];
    allowed: boolean;
    denied: boolean;
  }[] = [
    { shell: undefined, write: [], allowed: false, denied: true },
    { shell: undefined, write: ["workspace"], allowed: true, denied: false },
    { shell: true, write: [], allowed: true, denied: false },
    { shell: true, write: ["workspace"], allowed: true, denied: false },
    { shell: false, write: [], allowed: false, denied: true },
    { shell: false, write: ["workspace"], allowed: false, denied: true },
  ];
  for (const { shell, write, allowed, denied } of cases) {
    it(`shell=${String(shell)} write=${write.join(",") || "none"}`, () => {
      const permissions = { network: false, write, extraReadDirs: [] as string[] };
      const inv = planned(
        "claude-code",
        shell === undefined ? { permissions } : { permissions: { ...permissions, shell } },
      );
      const allowedTools = flagValues(inv, "--allowedTools").join(",").split(",");
      const deniedTools = flagValues(inv, "--disallowedTools").join(",").split(",");
      expect(allowedTools.includes("Bash")).toBe(allowed);
      expect(deniedTools.includes("Bash")).toBe(denied);
    });
  }

  it("keeps the cliOptions.allowedTools conflict check working", () => {
    const adapter = createAdapter("claude-code");
    // Explicit Bash allow conflicts with shell=false denial.
    expect(
      adapter.plan(
        request({
          permissions: { network: false, write: [], extraReadDirs: [], shell: false },
          cliOptions: { allowedTools: ["Bash"] },
        }),
      ).ok,
    ).toBe(false);
    // Unrelated allows still pass alongside the shell toggle.
    expect(
      adapter.plan(
        request({
          permissions: { network: false, write: [], extraReadDirs: [], shell: false },
          cliOptions: { allowedTools: ["mcp__fixture__*"] },
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("pi extraMcp", () => {
  it("writes no extras by default", () => {
    const inv = planned("pi");
    expect(Object.keys(mcpFile(inv).mcpServers)).toEqual(["devchestra"]);
  });

  it("writes stdio+http extras in Pi's mcpServers shape", () => {
    const inv = planned("pi", { extraMcp: [STDIO_EXTRA, HTTP_EXTRA] });
    const servers = mcpFile(inv).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["devchestra", "fixture", "web"]);
    expect(servers.fixture).toEqual({
      command: "/usr/bin/node",
      args: ["/abs/echo-server.mjs"],
      env: { FIXTURE_MCP_NAME: "fixture", FIXTURE_MCP_SECRET: "sekret-123" },
    });
    expect(servers.web).toEqual({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer hunter2" },
    });
    expect(servers.devchestra).toMatchObject({ exposure: "direct" });
  });

  it("keeps secrets in the 0600 file, never in argv", () => {
    const inv = planned("pi", { extraMcp: [STDIO_EXTRA, HTTP_EXTRA] });
    const argv = JSON.stringify(inv.args);
    expect(argv).not.toContain("sekret-123");
    expect(argv).not.toContain("hunter2");
    expect(JSON.stringify(describeInvocation(inv))).not.toContain("sekret-123");
    expect(JSON.stringify(describeInvocation(inv))).not.toContain("hunter2");
    const file = inv.files.find((entry) => entry.path.endsWith("mcp.json"));
    expect(file?.content).toContain("sekret-123");
    expect(file?.content).toContain("hunter2");
  });

  it("rejects reserved, duplicate and unsafe server names", () => {
    const adapter = createAdapter("pi");
    const bad: ResolvedMcpServer[][] = [
      [{ ...STDIO_EXTRA, name: "devchestra" }],
      [STDIO_EXTRA, { ...STDIO_EXTRA, transport: "http", url: "https://x.example" }],
      [{ ...STDIO_EXTRA, name: "../escape" }],
      [{ ...STDIO_EXTRA, name: "has space" }],
      [{ ...STDIO_EXTRA, name: "" }],
      [{ ...STDIO_EXTRA, env: { "not an env": "x" } }],
    ];
    for (const extraMcp of bad) {
      expect(adapter.plan(request({ extraMcp })).ok).toBe(false);
    }
  });

  it("rejects extras missing their transport details", () => {
    const adapter = createAdapter("pi");
    expect(adapter.plan(request({ extraMcp: [{ ...STDIO_EXTRA, command: "" }] })).ok).toBe(false);
    expect(adapter.plan(request({ extraMcp: [{ ...HTTP_EXTRA, url: "" }] })).ok).toBe(false);
  });

  it("surfaces extra-server tool calls in parsed output", () => {
    const parser = createAdapter("pi").parser();
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "mcp_fixture_fixture_echo",
      args: { text: "hi" },
    });
    const events: AdapterEvent[] = [...parser.feed(Buffer.from(`${line}\n`)), ...parser.end()];
    expect(events).toContainEqual({
      t: "tool_call",
      id: "call_1",
      name: "mcp_fixture_fixture_echo",
      input: { text: "hi" },
    });
  });
});

describe("pi shell toggle", () => {
  function excluded(shell: boolean | undefined, write: ("workspace" | "project")[]): string[] {
    const permissions = { network: false, write, extraReadDirs: [] as string[] };
    const inv = planned(
      "pi",
      shell === undefined ? { permissions } : { permissions: { ...permissions, shell } },
    );
    return flagValues(inv, "--exclude-tools").join(",").split(",").filter(Boolean);
  }

  it("keeps legacy behaviour when shell is undefined", () => {
    expect(excluded(undefined, [])).toContain("bash");
    expect(excluded(undefined, [])).toContain("powershell");
    expect(excluded(undefined, ["workspace"])).not.toContain("bash");
  });

  it("shell=false excludes bash and powershell even when write is on", () => {
    expect(excluded(false, ["workspace"])).toEqual(expect.arrayContaining(["bash", "powershell"]));
    // No duplication with the legacy read-only set either.
    const readOnly = excluded(false, []);
    expect(readOnly.filter((tool) => tool === "bash")).toHaveLength(1);
    expect(readOnly.filter((tool) => tool === "powershell")).toHaveLength(1);
  });

  it("shell=true keeps bash even when read-only", () => {
    const tools = excluded(true, []);
    expect(tools).not.toContain("bash");
    expect(tools).toContain("edit");
    expect(tools).toContain("write");
  });
});
