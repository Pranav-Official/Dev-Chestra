import type { AgentNode, WorkflowNode } from "@relay/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentTools } from "../src/editor/inspector/AgentTools.js";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import type {
  CliMcpServers,
  DiscoveredMcpServer,
  McpServersClient,
} from "../src/editor/inspector/model/mcp-servers.js";
import { extractMcpTools, ToolsLine } from "../src/run/DetailPanel.js";

const agent: AgentNode = {
  id: "node-agent",
  type: "agent",
  name: "Research",
  cli: "codex",
  prompt: "Find the facts.",
  output: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
  permissions: { network: false, write: ["workspace"] },
  workspace: { mode: "scratch" },
};

function server(overrides: Partial<DiscoveredMcpServer>): DiscoveredMcpServer {
  return {
    id: "global:github",
    name: "github",
    scope: "global",
    transport: "stdio",
    summary: "npx github-mcp",
    source: "/home/user/.config/opencode/opencode.json",
    status: "ready",
    hasSecrets: true,
    ...overrides,
  };
}

function payload(cli: CliMcpServers["cli"] = "codex"): CliMcpServers {
  return {
    cli,
    projectId: "p1",
    servers: [
      server({}),
      server({
        id: "global:neon",
        name: "neon",
        scope: "global",
        transport: "http",
        summary: "https://mcp.neon.tech",
        source: "/home/user/.config/opencode/opencode.json",
        status: "needs-auth",
      }),
      server({
        id: "project:docs",
        name: "docs",
        scope: "project",
        transport: "stdio",
        summary: "node docs-server",
        source: "/proj/opencode.json",
        status: "ready",
        hasSecrets: false,
      }),
      server({
        id: "project:old",
        name: "old",
        scope: "project",
        transport: "sse",
        summary: "https://old.example",
        source: "/proj/opencode.json",
        status: "disabled-in-cli",
        hasSecrets: false,
      }),
      server({
        id: "connector:Notion",
        name: "Notion",
        scope: "connector",
        transport: "http",
        summary: "Notion connector",
        source: "codex account",
        status: "ready",
        hasSecrets: false,
        toolCount: 12,
      }),
    ],
    scanned: ["/home/user/.config/opencode/opencode.json"],
    warnings: [],
  };
}

function fakeClient(data: CliMcpServers): {
  client: McpServersClient;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn().mockResolvedValue(data);
  return { client: { getCliMcpServers: get }, get };
}

function renderTools(node: AgentNode, client: McpServersClient, projectId = "p1") {
  const onPatch = vi.fn();
  render(<AgentTools node={node} projectId={projectId} onPatch={onPatch} mcpClient={client} />);
  return onPatch;
}

describe("AgentTools", () => {
  it("renders groups, transports and statuses with the relay row locked on", async () => {
    const { client } = fakeClient(payload());
    renderTools(agent, client);

    expect(await screen.findByTestId("inspector-tools-relay")).toHaveTextContent(
      /locked, always on/,
    );
    expect(screen.getByTestId("inspector-tools-group-global")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-tools-group-project")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-tools-group-connector")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-tools-group-connector")).toHaveTextContent(
      /signed in via Codex/,
    );
    expect(screen.getByTestId("inspector-tools-row-global:github")).toHaveTextContent("stdio");
    expect(screen.getByTestId("inspector-tools-row-global:github")).toHaveTextContent("ready");
    expect(screen.getByTestId("inspector-tools-row-global:neon")).toHaveTextContent("needs auth");
    expect(screen.getByTestId("inspector-tools-row-project:old")).toHaveTextContent(
      "disabled in CLI",
    );
    expect(screen.getByTestId("inspector-tools-row-connector:Notion")).toHaveTextContent(
      /reaches your real account/i,
    );
  });

  it("disables non-ready rows and explains why on hover", async () => {
    const { client } = fakeClient(payload());
    renderTools(agent, client);

    const neon = await screen.findByTestId("inspector-tools-toggle-global:neon");
    expect(neon).toBeDisabled();
    expect(screen.getByTestId("inspector-tools-row-global:neon")).toHaveAttribute(
      "title",
      expect.stringContaining("Needs auth"),
    );
    expect(screen.getByTestId("inspector-tools-row-project:old")).toHaveAttribute(
      "title",
      expect.stringContaining("Disabled in the CLI config"),
    );
    expect(screen.getByTestId("inspector-tools-toggle-global:github")).not.toBeDisabled();
  });

  it("adds a server on toggle with stable scope order", async () => {
    const { client } = fakeClient(payload());
    const onPatch = renderTools(
      { ...agent, mcpServers: [{ name: "docs", scope: "project" }] },
      client,
    );

    fireEvent.click(await screen.findByTestId("inspector-tools-toggle-global:github"));
    expect(onPatch).toHaveBeenLastCalledWith({
      mcpServers: [
        { name: "github", scope: "global" },
        { name: "docs", scope: "project" },
      ],
    });
  });

  it("removes the last server with undefined so the workflow file stays clean", async () => {
    const { client } = fakeClient(payload());
    const onPatch = renderTools(
      { ...agent, mcpServers: [{ name: "docs", scope: "project" }] },
      client,
    );
    fireEvent.click(await screen.findByTestId("inspector-tools-toggle-project:docs"));
    expect(onPatch).toHaveBeenLastCalledWith({ mcpServers: undefined });
  });

  it("ignores a duplicate toggle-on without patching a duplicate entry", async () => {
    const { client } = fakeClient(payload());
    const onPatch = renderTools(
      { ...agent, mcpServers: [{ name: "github", scope: "global" }] },
      client,
    );
    fireEvent.click(await screen.findByTestId("inspector-tools-toggle-global:github"));
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith({});
  });

  it("derives shell from write when absent and writes an explicit boolean on toggle", () => {
    const { client } = fakeClient(payload());
    // write non-empty + shell undefined -> checked (legacy effective value)
    const onPatch = renderTools(agent, client);
    expect(screen.getByTestId("inspector-tools-shell")).toBeChecked();

    fireEvent.click(screen.getByTestId("inspector-tools-shell"));
    expect(onPatch).toHaveBeenLastCalledWith({
      permissions: { network: false, write: ["workspace"], shell: false },
    });
  });

  it("shows an explicit shell:false as off even with write access", () => {
    const { client } = fakeClient(payload());
    renderTools(
      { ...agent, permissions: { network: false, write: ["workspace"], shell: false } },
      client,
    );
    expect(screen.getByTestId("inspector-tools-shell")).not.toBeChecked();
  });

  it("flags saved-but-missing servers with a warning and removes them", async () => {
    const { client } = fakeClient(payload());
    const onPatch = renderTools(
      { ...agent, mcpServers: [{ name: "ghost", scope: "global" }] },
      client,
    );

    const missing = await screen.findByTestId("inspector-tools-missing-0");
    expect(missing).toHaveTextContent("ghost");
    expect(missing).toHaveTextContent("not found");
    fireEvent.click(screen.getByTestId("inspector-tools-missing-remove-0"));
    expect(onPatch).toHaveBeenLastCalledWith({ mcpServers: undefined });
  });

  it("shows the empty state with the CLI add command and hides empty groups", async () => {
    const { client } = fakeClient({ ...payload("opencode"), servers: [] });
    renderTools({ ...agent, cli: "opencode" }, client);

    expect(await screen.findByTestId("inspector-tools-empty")).toHaveTextContent(
      "opencode mcp add",
    );
    expect(screen.queryByTestId("inspector-tools-group-global")).toBeNull();
    expect(screen.queryByTestId("inspector-tools-group-project")).toBeNull();
    expect(screen.queryByTestId("inspector-tools-group-connector")).toBeNull();
  });

  it("shows an error with a working refresh button when discovery fails", async () => {
    const get = vi.fn().mockRejectedValue(new Error("boom"));
    renderTools(agent, { getCliMcpServers: get });

    expect(await screen.findByTestId("inspector-tools-error")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("inspector-tools-refresh"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("never renders secret values smuggled onto a server entry", async () => {
    const tainted = {
      ...server({}),
      env: { MCP_TOKEN: "sk-secret-xyz" },
      headers: { Authorization: "Bearer bearer-secret-xyz" },
    } as unknown as DiscoveredMcpServer;
    const { client } = fakeClient({ ...payload(), servers: [tainted] });
    const { container } = render(
      <AgentTools node={agent} projectId="p1" onPatch={() => undefined} mcpClient={client} />,
    );
    await screen.findByTestId("inspector-tools-row-global:github");
    expect(container.innerHTML).not.toContain("sk-secret-xyz");
    expect(container.innerHTML).not.toContain("bearer-secret-xyz");
  });
});

describe("Agent form Tools placement", () => {
  it("orders sections Prompt, Model, Tools, Output, Permissions, Limits", () => {
    render(<Inspector node={agent} issues={[]} onPatch={() => undefined} />);
    const summaries = Array.from(
      document.querySelectorAll(".inspector-section-summary > span:first-child"),
    ).map((entry) => entry.textContent?.trim() ?? "");
    const order = ["Prompt", "Model", "Tools", "Output", "Permissions", "Limits"];
    let cursor = -1;
    for (const title of order) {
      const index = summaries.findIndex((text, position) => position > cursor && text === title);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(screen.getByTestId("inspector-tools-shell")).toBeInTheDocument();
  });

  it("keeps the CLI change patch to cli+model only", () => {
    const onPatch = vi.fn();
    const node: WorkflowNode = {
      ...agent,
      cli: "codex",
      mcpServers: [{ name: "docs", scope: "project" }],
    };
    render(<Inspector node={node} issues={[]} onPatch={onPatch} />);
    fireEvent.change(screen.getByTestId("inspector-agent-cli"), {
      target: { value: "claude-code" },
    });
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith("node-agent", {
      cli: "claude-code",
      model: undefined,
    });
  });
});

describe("run viewer Tools line", () => {
  it("parses shell and servers from resolved input, ignoring anything else", () => {
    expect(extractMcpTools(null)).toBeNull();
    expect(extractMcpTools({ prompt: "hi" })).toBeNull();
    expect(
      extractMcpTools({
        tools: {
          shell: true,
          servers: [
            { name: "github", scope: "global" },
            { name: "docs", scope: "project", command: "nope", env: { X: "nope" } },
            "junk",
          ],
        },
      }),
    ).toEqual({
      shell: true,
      servers: [
        { name: "github", scope: "global" },
        { name: "docs", scope: "project" },
      ],
    });
    expect(extractMcpTools({ tools: { shell: null, servers: [] } })).toEqual({
      shell: null,
      servers: [],
    });
  });

  it("renders shell state and server chips, and nothing when absent", () => {
    const { rerender } = render(
      <ToolsLine
        data={{ tools: { shell: false, servers: [{ name: "github", scope: "global" }] } }}
      />,
    );
    const line = screen.getByTestId("detail-tools");
    expect(line).toHaveTextContent(/Shell off/);
    expect(line).toHaveTextContent("github · global");

    rerender(<ToolsLine data={{ tools: { shell: null, servers: [] } }} />);
    expect(screen.getByTestId("detail-tools")).toHaveTextContent(/Shell default/);

    rerender(<ToolsLine data={{ prompt: "hi" }} />);
    expect(screen.queryByTestId("detail-tools")).toBeNull();
  });
});
