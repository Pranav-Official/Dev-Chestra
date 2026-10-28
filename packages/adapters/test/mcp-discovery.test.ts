import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_INTERNAL_CONNECTOR_NAMES,
  createMcpResolver,
  type McpResolverOptions,
} from "../src/index.js";

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeHome(): Promise<{ home: string; project: string }> {
  const home = await mkdtemp(join(tmpdir(), "devchestra-mcp-home-"));
  const project = await mkdtemp(join(tmpdir(), "devchestra-mcp-proj-"));
  temps.push(home, project);
  return { home, project };
}

function opts(home: string, env: Record<string, string> = {}): McpResolverOptions {
  return { home, env: { ...process.env, ...env } };
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

const SECRET = "sk-live-PLANTED-SECRET-abc123";
const SECRET_URL = `https://user:${SECRET}@mcp.example.com:8443/deep/path?token=${SECRET}`;

describe("mcp-discovery", () => {
  it("claude: reads user, local and project servers with approval states", async () => {
    const { home, project } = await makeHome();
    await write(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          global: { command: "npx", args: ["@x/y", "--flag"], env: { A: "planted-env-value" } },
        },
        projects: {
          [project]: {
            mcpServers: { local: { command: "/bin/srv", args: [] } },
            enabledMcpjsonServers: [],
            disabledMcpjsonServers: [],
          },
        },
      }),
    );
    await write(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          ready: { command: "ready-bin", args: [] },
          unapproved: { command: "u-bin", args: [] },
          off: { command: "o-bin", args: [] },
        },
      }),
    );
    await write(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        enabledMcpjsonServers: ["ready"],
        disabledMcpjsonServers: ["off"],
      }),
    );
    const resolver = createMcpResolver(opts(home));
    const { servers, warnings } = await resolver.list("claude-code", project);
    expect(warnings).toEqual([]);
    const byId = new Map(servers.map((s) => [s.id, s]));
    expect(byId.get("global:global")).toMatchObject({
      name: "global",
      scope: "global",
      transport: "stdio",
      summary: "npx @x/y",
      status: "ready",
      hasSecrets: true,
    });
    expect(byId.get("project:local")).toMatchObject({ scope: "project", status: "ready" });
    expect(byId.get("project:ready")).toMatchObject({ status: "ready" });
    expect(byId.get("project:unapproved")).toMatchObject({ status: "needs-trust" });
    expect(byId.get("project:off")).toMatchObject({ status: "disabled-in-cli" });
    // No secret values leak into the listing.
    expect(JSON.stringify(servers)).not.toContain("planted-env-value");
  });

  it("claude: project servers are ready with a note when no settings exist", async () => {
    const { home, project } = await makeHome();
    await write(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "docs-bin", args: [] } } }),
    );
    const resolver = createMcpResolver(opts(home));
    const { servers, warnings } = await resolver.list("claude-code", project);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "docs", status: "ready" });
    expect(warnings.some((w) => w.includes('"docs"'))).toBe(true);
  });

  it("claude: honours CLAUDE_CONFIG_DIR for settings and .claude.json", async () => {
    const { home, project } = await makeHome();
    const configDir = join(home, "custom-config");
    await write(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { wrong: { command: "wrong-bin", args: [] } },
        projects: {},
      }),
    );
    await write(
      join(configDir, "..", ".claude.json"),
      JSON.stringify({ mcpServers: { right: { command: "right-bin", args: [] } } }),
    );
    const resolver = createMcpResolver(opts(home, { CLAUDE_CONFIG_DIR: configDir }));
    const { servers } = await resolver.list("claude-code", project);
    expect(servers.map((s) => s.name)).toEqual(["right"]);
  });

  it("claude: malformed files are skipped with a warning, never thrown", async () => {
    const { home, project } = await makeHome();
    await write(join(home, ".claude.json"), "{ not json");
    await write(join(project, ".mcp.json"), JSON.stringify({ mcpServers: "nope" }));
    const resolver = createMcpResolver(opts(home));
    const { servers, warnings } = await resolver.list("claude-code", project);
    expect(servers).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => !w.includes("not json"))).toBe(true);
  });

  it("codex: reads global TOML, project trust and disabled servers", async () => {
    const { home, project } = await makeHome();
    await write(
      join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.github]",
        'command = "npx"',
        'args = ["-y", "@x/github"]',
        'env_vars = ["GITHUB_TOKEN"]',
        "",
        "[mcp_servers.docs]",
        'url = "https://docs.example.com/mcp"',
        "enabled = false",
        "",
        `[projects."${project}"]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    await write(
      join(project, ".codex", "config.toml"),
      ["[mcp_servers.local]", 'command = "local-bin"', ""].join("\n"),
    );
    const resolver = createMcpResolver(opts(home));
    const { servers, warnings } = await resolver.list("codex", project);
    expect(warnings).toEqual([]);
    const byId = new Map(servers.map((s) => [s.id, s]));
    expect(byId.get("global:github")).toMatchObject({
      transport: "stdio",
      summary: "npx -y",
      status: "ready",
      hasSecrets: true,
    });
    expect(byId.get("global:docs")).toMatchObject({
      transport: "http",
      summary: "docs.example.com",
      status: "disabled-in-cli",
    });
    expect(byId.get("project:local")).toMatchObject({ status: "ready" });
  });

  it("codex: untrusted project servers are listed as needs-trust", async () => {
    const { home, project } = await makeHome();
    await write(join(home, ".codex", "config.toml"), 'model = "x"\n');
    await write(
      join(project, ".codex", "config.toml"),
      ["[mcp_servers.sneaky]", 'command = "sneaky-bin"', ""].join("\n"),
    );
    const resolver = createMcpResolver(opts(home));
    const { servers } = await resolver.list("codex", project);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: "sneaky",
      scope: "project",
      status: "needs-trust",
      summary: "untrusted project config",
    });
  });

  it("codex: honours CODEX_HOME and parses connectors hiding internals", async () => {
    const { home, project } = await makeHome();
    const codexHome = join(home, "chx");
    const cacheDir = join(codexHome, "cache", "codex_apps_tools");
    await write(join(codexHome, "config.toml"), "");
    const tools = [
      { connector_id: "connector_a", connector_name: "GitHub", name: "a" },
      { connector_id: "connector_a", connector_name: "GitHub", name: "b" },
      { connector_id: "connector_b", connector_name: "Sites", name: "c" },
      { connector_id: "connector_c", connector_name: "Figma", name: "d" },
    ];
    await write(join(cacheDir, "x.json"), JSON.stringify({ tools }));
    for (const hidden of CODEX_INTERNAL_CONNECTOR_NAMES) {
      expect(typeof hidden).toBe("string");
    }
    const resolver = createMcpResolver(opts(home, { CODEX_HOME: codexHome }));
    const { servers } = await resolver.list("codex", project);
    const connectors = servers.filter((s) => s.scope === "connector");
    expect(connectors.map((c) => c.name).sort()).toEqual(["Figma", "GitHub"]);
    expect(connectors.find((c) => c.name === "GitHub")).toMatchObject({
      id: "connector:GitHub",
      transport: "http",
      status: "ready",
      toolCount: 2,
      summary: "2 tools",
      hasSecrets: false,
    });
    expect(connectors.find((c) => c.name === "GitHub")?.source).toContain("x.json");
  });

  it("opencode: reads flat and nested forms, project override and disabled", async () => {
    const { home, project } = await makeHome();
    await write(
      join(home, ".config", "opencode", "opencode.json"),
      [
        "{",
        "  // global servers",
        '  "mcp": {',
        '    "flat": { "type": "local", "command": ["bun", "x", "run", "srv"], "enabled": true },',
        '    "off": { "type": "remote", "url": "https://off.example.com/mcp", "enabled": false },',
        '    "servers": { "nested": { "type": "remote", "url": "https://n.example.com/a?b=c" } }',
        "  }",
        "}",
      ].join("\n"),
    );
    await write(
      join(project, "opencode.json"),
      JSON.stringify({
        mcp: { proj: { type: "local", command: ["node", "srv.mjs"], environment: { K: "v" } } },
      }),
    );
    const resolver = createMcpResolver(opts(home));
    const { servers, warnings } = await resolver.list("opencode", project);
    expect(warnings).toEqual([]);
    const byId = new Map(servers.map((s) => [s.id, s]));
    expect(byId.get("global:flat")).toMatchObject({
      transport: "stdio",
      summary: "bun x",
      status: "ready",
    });
    expect(byId.get("global:off")).toMatchObject({
      transport: "http",
      summary: "off.example.com",
      status: "disabled-in-cli",
      hasSecrets: false,
    });
    expect(byId.get("global:nested")).toMatchObject({
      summary: "n.example.com",
      status: "ready",
    });
    expect(byId.get("project:proj")).toMatchObject({ status: "ready", hasSecrets: true });
  });

  it("opencode: honours XDG_CONFIG_HOME and marks invalid entries", async () => {
    const { home, project } = await makeHome();
    const xdg = join(home, "xdg");
    await write(
      join(xdg, "opencode", "opencode.json"),
      JSON.stringify({ mcp: { bad: { type: "local" }, good: { command: "x" } } }),
    );
    const resolver = createMcpResolver(opts(home, { XDG_CONFIG_HOME: xdg }));
    const { servers } = await resolver.list("opencode", project);
    const byId = new Map(servers.map((s) => [s.id, s]));
    expect(byId.get("global:bad")).toMatchObject({ status: "invalid" });
    expect(byId.get("global:good")).toMatchObject({ status: "ready" });
  });

  it("pi: reads global config and gates project config on trust.json", async () => {
    const { home, project } = await makeHome();
    await write(
      join(home, ".pi", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { g: { command: "g-bin", args: ["a", "b"] } } }),
    );
    await write(join(home, ".pi", "agent", "trust.json"), JSON.stringify({ [project]: true }));
    await write(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { p: { command: "p-bin", args: [] } } }),
    );
    const resolver = createMcpResolver(opts(home));
    const { servers } = await resolver.list("pi", project);
    expect(new Map(servers.map((s) => [s.id, s])).get("project:p")).toMatchObject({
      status: "ready",
      summary: "p-bin",
    });
    expect(new Map(servers.map((s) => [s.id, s])).get("global:g")).toMatchObject({
      summary: "g-bin a",
    });
  });

  it("pi: untrusted project servers are listed as needs-trust", async () => {
    const { home, project } = await makeHome();
    await write(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { p: { command: "p-bin", args: [] } } }),
    );
    const resolver = createMcpResolver(opts(home));
    const { servers } = await resolver.list("pi", project);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ status: "needs-trust" });
  });

  it("pi: honours PI_CODING_AGENT_DIR", async () => {
    const { home, project } = await makeHome();
    const agentDir = join(home, "agent-dir");
    await write(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "a-bin", args: [] } } }),
    );
    const resolver = createMcpResolver(opts(home, { PI_CODING_AGENT_DIR: agentDir }));
    const { servers } = await resolver.list("pi", project);
    expect(servers.map((s) => s.name)).toEqual(["a"]);
  });

  it("resolve: returns launch details and fails fast with secret-free errors", async () => {
    const { home, project } = await makeHome();
    await write(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        mcp: {
          good: {
            type: "remote",
            url: SECRET_URL,
            headers: { Authorization: `Bearer ${SECRET}` },
          },
          off: { type: "local", command: ["x"], enabled: false },
          bad: { type: "local" },
        },
      }),
    );
    const resolver = createMcpResolver(opts(home));
    const good = await resolver.resolve("opencode", project, [{ name: "good", scope: "global" }]);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.extra).toHaveLength(1);
      expect(good.value.extra[0]).toMatchObject({
        name: "good",
        scope: "global",
        transport: "http",
        url: SECRET_URL,
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      expect(good.value.known).toContainEqual({ name: "good", scope: "global" });
    }
    for (const selection of [
      { name: "missing", scope: "global" },
      { name: "off", scope: "global" },
      { name: "bad", scope: "global" },
    ] as const) {
      const result = await resolver.resolve("opencode", project, [selection]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain(`"${selection.name}"`);
        expect(result.error.message).not.toContain(SECRET);
        expect(JSON.stringify(result.error)).not.toContain(SECRET);
      }
    }
  });

  it("resolve: rejects needs-trust selections", async () => {
    const { home, project } = await makeHome();
    await write(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { p: { command: "p-bin", args: [] } } }),
    );
    const resolver = createMcpResolver(opts(home));
    const result = await resolver.resolve("pi", project, [{ name: "p", scope: "project" }]);
    expect(result.ok).toBe(false);
  });

  it("never leaks planted secrets through list()", async () => {
    const { home, project } = await makeHome();
    await write(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { a: { command: "a-bin", args: [], env: { TOKEN: SECRET } } },
        projects: { [project]: { mcpServers: { b: { command: "b-bin", args: [] } } } },
      }),
    );
    await write(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { c: { url: SECRET_URL, headers: { H: SECRET } } } }),
    );
    await write(
      join(home, ".codex", "config.toml"),
      ["[mcp_servers.d]", `command = "d-bin"`, `[mcp_servers.d.env]`, `KEY = "${SECRET}"`, ""].join(
        "\n",
      ),
    );
    await write(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ mcp: { e: { type: "remote", url: SECRET_URL } } }),
    );
    await write(
      join(home, ".pi", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { f: { command: "f-bin", args: [], env: { K: SECRET } } } }),
    );
    const resolver = createMcpResolver(opts(home));
    for (const cli of ["claude-code", "codex", "opencode", "pi"] as const) {
      const { servers, warnings } = await resolver.list(cli, project);
      const blob = JSON.stringify({ servers, warnings });
      expect(blob).not.toContain(SECRET);
      expect(blob).not.toContain("user@");
      expect(blob).not.toContain("/deep/path");
      expect(blob).not.toContain("token=");
      for (const server of servers) {
        expect(server.summary).not.toContain(SECRET);
        expect(server.source).not.toContain(SECRET);
      }
    }
  });

  it("summaries strip credentials, paths and query strings", async () => {
    const { home, project } = await makeHome();
    await write(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ mcp: { r: { type: "remote", url: SECRET_URL } } }),
    );
    const resolver = createMcpResolver(opts(home));
    const { servers } = await resolver.list("opencode", project);
    expect(servers[0]?.summary).toBe("mcp.example.com");
  });
});
