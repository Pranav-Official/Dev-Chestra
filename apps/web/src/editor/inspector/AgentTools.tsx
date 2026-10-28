import type { AgentCli, AgentNode, McpScope, McpSelection } from "@relay/schema";
import { MCP_SCOPES, PROD_CLI_LABELS } from "@relay/schema";
import { LockKeyhole, RefreshCw, TriangleAlert } from "lucide-react";
import { CheckboxField, InfoTip } from "./fields/fields.js";
import type { DiscoveredMcpServer, McpServersClient } from "./model/mcp-servers.js";
import { useCliMcpServers } from "./model/useCliMcpServers.js";
import type { PatchOf } from "./types.js";

const SCOPE_ORDER: Record<McpScope, number> = { global: 0, project: 1, connector: 2 };

const GROUP_LABELS: { scope: McpScope; label: string }[] = [
  { scope: "global", label: "Global" },
  { scope: "project", label: "Project" },
  { scope: "connector", label: "Account connectors" },
];

const STATUS_TEXT = {
  ready: "ready",
  "needs-trust": "needs trust",
  "needs-auth": "needs auth",
  "disabled-in-cli": "disabled in CLI",
  invalid: "invalid",
} as const;

const ADD_COMMANDS: Record<AgentCli, string> = {
  "claude-code": "claude mcp add",
  codex: "codex mcp add",
  opencode: "opencode mcp add",
  pi: "pi mcp add",
};

/** Effective shell access: explicit `permissions.shell`, else the legacy write rule. */
export function effectiveShell(node: AgentNode): boolean {
  return node.permissions.shell ?? node.permissions.write.length > 0;
}

function statusReason(server: DiscoveredMcpServer, cliLabel: string): string | null {
  switch (server.status) {
    case "ready":
      return null;
    case "needs-trust":
      return "Needs trust: project server from an untrusted source.";
    case "needs-auth":
      return `Needs auth: sign in with ${cliLabel} to enable.`;
    case "disabled-in-cli":
      return "Disabled in the CLI config.";
    case "invalid":
      return "Invalid server entry.";
  }
}

function asMcpScope(scope: string): McpScope | null {
  return (MCP_SCOPES as readonly string[]).includes(scope) ? (scope as McpScope) : null;
}

function toggleMcpSelection(
  node: AgentNode,
  server: { name: string; scope: McpScope },
  enabled: boolean,
): PatchOf<AgentNode> {
  const current = node.mcpServers ?? [];
  if (enabled) {
    if (current.some((entry) => entry.name === server.name && entry.scope === server.scope)) {
      return {};
    }
    const added: McpSelection = { name: server.name, scope: server.scope };
    const next: McpSelection[] = [...current, added].sort(
      (a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.name.localeCompare(b.name),
    );
    return { mcpServers: next };
  }
  const next = current.filter(
    (entry) => !(entry.name === server.name && entry.scope === server.scope),
  );
  return { mcpServers: next.length > 0 ? next : undefined };
}

function ServerRow({
  server,
  cliLabel,
  checked,
  onToggle,
}: {
  server: DiscoveredMcpServer;
  cliLabel: string;
  checked: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const reason = statusReason(server, cliLabel);
  const switchable = server.status === "ready";
  const toggleId = `inspector-tools-toggle-${server.id}`;
  const title =
    reason === null
      ? `${server.summary} · ${server.source}`
      : `${reason} ${server.summary} · ${server.source}`;
  return (
    <div
      className="inspector-field inspector-check-field inspector-toggle inspector-tools-row"
      data-testid={`inspector-tools-row-${server.id}`}
      title={title}
    >
      <div className="inspector-check">
        <input
          id={toggleId}
          data-testid={toggleId}
          type="checkbox"
          checked={checked}
          disabled={!switchable}
          title={reason ?? undefined}
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
        <label htmlFor={toggleId}>
          <span className="inspector-tools-name">{server.name}</span>
          <span className="chip mono">{server.transport}</span>
          <span className="chip">{STATUS_TEXT[server.status]}</span>
        </label>
      </div>
      {server.scope === "connector" ? (
        <p className="inspector-tools-warn">
          <TriangleAlert size={11} aria-hidden="true" />
          <span>Reaches your real account.</span>
        </p>
      ) : null}
    </div>
  );
}

export function AgentTools({
  node,
  projectId,
  onPatch,
  mcpClient,
}: {
  node: AgentNode;
  projectId?: string | undefined;
  onPatch: (patch: PatchOf<AgentNode>) => void;
  mcpClient?: McpServersClient | undefined;
}) {
  const cliLabel = PROD_CLI_LABELS[node.cli];
  const { data, loading, error, refresh } = useCliMcpServers({
    projectId,
    cli: node.cli,
    nodeId: node.id,
    client: mcpClient,
  });
  const selected = node.mcpServers ?? [];
  const servers = data?.servers ?? [];
  const missing = selected.filter(
    (entry) =>
      !servers.some((server) => server.name === entry.name && server.scope === entry.scope),
  );
  const showMissing = data !== null && missing.length > 0;

  return (
    <div className="inspector-stack" data-testid="inspector-tools">
      <CheckboxField
        id="inspector-tools-shell"
        label="Shell commands"
        checked={effectiveShell(node)}
        onChange={(shell) => onPatch({ permissions: { ...node.permissions, shell } })}
        help="Built-in shell tool of the CLI, not a sandbox."
      />
      <div className="inspector-tools-divided">
        <div className="inspector-tools-subhead">
          <span>MCP servers</span>
          <InfoTip id="inspector-tools-mcp-help">
            Only Relay tools plus the servers switched on here are attached. Everything else the CLI
            knows stays off for this run.
          </InfoTip>
          <button
            type="button"
            className="btn sm ghost inspector-tools-refresh"
            data-testid="inspector-tools-refresh"
            disabled={loading !== "idle" || projectId === undefined}
            onClick={refresh}
            title="Refresh the server list"
          >
            <RefreshCw size={12} aria-hidden="true" />
            <span>{loading === "refresh" ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>
        <div
          className="inspector-tools-row inspector-tools-locked"
          data-testid="inspector-tools-relay"
        >
          <LockKeyhole size={12} aria-hidden="true" />
          <span className="inspector-tools-name">Relay tools</span>
          <span className="inspector-muted">locked, always on</span>
        </div>
        {loading === "load" ? (
          <p className="inspector-muted" data-testid="inspector-tools-loading">
            Loading MCP servers…
          </p>
        ) : error !== null ? (
          <p className="inspector-error" data-testid="inspector-tools-error" role="alert">
            {error}
          </p>
        ) : data === null ? (
          <p className="inspector-muted" data-testid="inspector-tools-noproject">
            Open a project to list the CLI&apos;s MCP servers.
          </p>
        ) : servers.length === 0 && !showMissing ? (
          <p className="inspector-muted" data-testid="inspector-tools-empty">
            No MCP servers found. Add one with{" "}
            <span className="mono">{ADD_COMMANDS[node.cli]}</span>.
          </p>
        ) : (
          <>
            {GROUP_LABELS.map(({ scope, label }) => {
              const group = servers.filter((server) => server.scope === scope);
              if (group.length === 0) return null;
              return (
                <div key={scope} data-testid={`inspector-tools-group-${scope}`}>
                  <p className="inspector-tools-group-label">
                    {label}
                    {scope === "connector" ? (
                      <span className="inspector-muted"> · signed in via {cliLabel}</span>
                    ) : null}
                  </p>
                  <div className="inspector-stack">
                    {group.map((server) => (
                      <ServerRow
                        key={server.id}
                        server={server}
                        cliLabel={cliLabel}
                        checked={selected.some(
                          (entry) => entry.name === server.name && entry.scope === server.scope,
                        )}
                        onToggle={(enabled) => {
                          const scope = asMcpScope(server.scope);
                          if (scope === null) return;
                          onPatch(toggleMcpSelection(node, { name: server.name, scope }, enabled));
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            {showMissing ? (
              <div data-testid="inspector-tools-group-missing">
                <p className="inspector-tools-group-label">Saved but not found</p>
                <div className="inspector-stack">
                  {missing.map((entry, index) => (
                    <div
                      key={`${entry.scope}:${entry.name}`}
                      className="inspector-tools-row inspector-tools-missing"
                      data-testid={`inspector-tools-missing-${index}`}
                    >
                      <span className="inspector-tools-name">{entry.name}</span>
                      <span className="chip mono">{entry.scope}</span>
                      <span className="chip">not found</span>
                      <button
                        type="button"
                        className="btn sm ghost danger"
                        data-testid={`inspector-tools-missing-remove-${index}`}
                        onClick={() => onPatch(toggleMcpSelection(node, entry, false))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
