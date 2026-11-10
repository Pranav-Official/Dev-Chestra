import type { AgentCli, AgentNode, McpScope, McpSelection } from "@devchestra/schema";
import { MCP_SCOPES, PROD_CLI_LABELS } from "@devchestra/schema";
import { Lock, RefreshCw } from "lucide-react";
import { CheckboxField } from "./fields/fields.js";
import type { DiscoveredMcpServer, McpServersClient } from "./model/mcp-servers.js";
import { useCliMcpServers } from "./model/useCliMcpServers.js";
import { ShellPolicyEditor } from "./ShellPolicyEditor.js";
import { permissionsWithoutShellPolicy } from "./shellPolicyModel.js";
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

/**
 * Effective shell access: explicit `permissions.shell`; otherwise a present
 * shell policy turns shell on, and without one the legacy write rule decides.
 */
export function effectiveShell(node: AgentNode): boolean {
  const { shell, shellPolicy, write } = node.permissions;
  if (shell !== undefined) return shell;
  return shellPolicy !== undefined || write.length > 0;
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
    <li
      className={`inspector-tools-row${switchable ? "" : " unavailable"}`}
      data-testid={`inspector-tools-row-${server.id}`}
      title={title}
    >
      <label className="inspector-tools-label" htmlFor={toggleId}>
        <span className="inspector-tools-name">{server.name}</span>
        <span className="inspector-tools-meta">
          {switchable ? server.transport : `${server.transport} · ${STATUS_TEXT[server.status]}`}
        </span>
      </label>
      <input
        id={toggleId}
        className="inspector-switch"
        data-testid={toggleId}
        type="checkbox"
        checked={checked}
        disabled={!switchable}
        title={reason ?? undefined}
        onChange={(event) => onToggle(event.currentTarget.checked)}
      />
    </li>
  );
}

export function AgentTools({
  node,
  projectId,
  resolvedCli,
  onPatch,
  mcpClient,
}: {
  node: AgentNode;
  projectId?: string | undefined;
  /** The provider to list servers for. Defaults to the node's own; a tiered node passes the one its tier maps to here. */
  resolvedCli?: AgentCli | undefined;
  onPatch: (patch: PatchOf<AgentNode>) => void;
  mcpClient?: McpServersClient | undefined;
}) {
  const cli = resolvedCli ?? node.cli;
  const cliLabel = cli === undefined ? "the provider" : PROD_CLI_LABELS[cli];
  const tiered = node.tier !== undefined;
  const { data, loading, error, refresh } = useCliMcpServers({
    // No provider to ask yet (a tier that is not set on this machine): list nothing.
    projectId: cli === undefined ? undefined : projectId,
    cli: cli ?? "claude-code",
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
        hint="Let the agent run commands in the workspace"
        checked={effectiveShell(node)}
        onChange={(shell) =>
          onPatch({
            permissions: shell
              ? { ...node.permissions, shell: true }
              : { ...permissionsWithoutShellPolicy(node.permissions), shell: false },
          })
        }
        help="The CLI's built-in shell tool. Advisory only: DevChestra is not an OS sandbox."
      />
      <ShellPolicyEditor node={node} onPatch={onPatch} />
      <CheckboxField
        id="inspector-tools-github"
        label="GitHub credential in container"
        checked={node.credentials?.includes("github") ?? false}
        onChange={(enabled) => onPatch({ credentials: enabled ? ["github"] : [] })}
        help="Only for container runs. Gives this agent the project's configured GitHub token. Prefer a separate publish step after approval."
      />
      <div className="inspector-tools-block">
        <div className="inspector-tools-head">
          <span className="inspector-tools-title">MCP servers</span>
          <button
            type="button"
            className="inspector-icon-btn inspector-tools-refresh"
            data-testid="inspector-tools-refresh"
            aria-label={loading === "refresh" ? "Refreshing" : "Refresh the server list"}
            disabled={loading !== "idle" || projectId === undefined}
            onClick={refresh}
            title="Refresh the server list"
          >
            <RefreshCw
              size={13}
              aria-hidden="true"
              className={loading === "refresh" ? "spin" : undefined}
            />
          </button>
        </div>
        {tiered && cli !== undefined ? (
          <p className="inspector-muted" data-testid="inspector-tools-tier-note">
            Listing servers for {cliLabel}, this machine&apos;s provider for the tier.
          </p>
        ) : null}
        <ul className="inspector-tools-list">
          <li
            className="inspector-tools-row inspector-tools-locked"
            data-testid="inspector-tools-devchestra"
          >
            <span className="inspector-tools-label">
              <span className="inspector-tools-name">DevChestra tools</span>
              <span className="inspector-tools-meta">Always on</span>
            </span>
            <Lock size={13} aria-hidden="true" className="inspector-tools-lock" />
          </li>
        </ul>
        {loading === "load" ? (
          <p className="inspector-muted" data-testid="inspector-tools-loading">
            Loading MCP servers…
          </p>
        ) : error !== null ? (
          <p className="inspector-error" data-testid="inspector-tools-error" role="alert">
            {error}
          </p>
        ) : cli === undefined ? (
          <p className="inspector-muted" data-testid="inspector-tools-notier">
            {tiered
              ? "Servers are listed once this tier is set on this machine."
              : "Pick a provider to list its MCP servers."}
          </p>
        ) : data === null ? (
          <p className="inspector-muted" data-testid="inspector-tools-noproject">
            Open a project to list the CLI&apos;s MCP servers.
          </p>
        ) : servers.length === 0 && !showMissing ? (
          <p className="inspector-muted" data-testid="inspector-tools-empty">
            No MCP servers found. Add one with <span className="mono">{ADD_COMMANDS[cli]}</span>.
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
                      <span className="inspector-tools-group-sub">via {cliLabel}</span>
                    ) : null}
                  </p>
                  <ul className="inspector-tools-list">
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
                  </ul>
                </div>
              );
            })}
            {showMissing ? (
              <div data-testid="inspector-tools-group-missing">
                <p className="inspector-tools-group-label">Saved but not found</p>
                <ul className="inspector-tools-list">
                  {missing.map((entry, index) => (
                    <li
                      key={`${entry.scope}:${entry.name}`}
                      className="inspector-tools-row unavailable"
                      data-testid={`inspector-tools-missing-${index}`}
                    >
                      <span className="inspector-tools-label">
                        <span className="inspector-tools-name">{entry.name}</span>
                        <span className="inspector-tools-meta">{entry.scope} · not found</span>
                      </span>
                      <button
                        type="button"
                        className="btn sm ghost danger"
                        data-testid={`inspector-tools-missing-remove-${index}`}
                        onClick={() => onPatch(toggleMcpSelection(node, entry, false))}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
