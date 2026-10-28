import { homedir } from "node:os";
import { err, ok, RelayError, type Result } from "@relay/core";
import type { McpSelection, ProdCliId } from "@relay/schema";
import type { ResolvedMcpServer } from "../types.js";
import { discoverClaudeServers } from "./claude.js";
import { discoverCodexServers } from "./codex.js";
import { discoverOpenCodeServers } from "./opencode.js";
import { discoverPiServers } from "./pi.js";
import type {
  DiscoveredMcpServer,
  InternalMcpServer,
  McpListResult,
  McpResolveResult,
  McpResolver,
  McpResolverOptions,
  ReaderResult,
} from "./types.js";

export type {
  DiscoveredMcpServer,
  InternalMcpServer,
  McpListResult,
  McpResolveResult,
  McpResolver,
  McpResolverOptions,
};

function effectiveHome(options: McpResolverOptions): string {
  if (options.home !== undefined && options.home !== "") return options.home;
  const env = options.env ?? process.env;
  const fromEnv = env.HOME;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  try {
    return homedir();
  } catch {
    return "";
  }
}

function readAll(cli: ProdCliId, projectDir: string, options: McpResolverOptions): ReaderResult {
  const opts = { home: effectiveHome(options), env: options.env ?? process.env };
  switch (cli) {
    case "claude-code":
      return discoverClaudeServers(projectDir, opts);
    case "codex":
      return discoverCodexServers(projectDir, opts);
    case "opencode":
      return discoverOpenCodeServers(projectDir, opts);
    case "pi":
      return discoverPiServers(projectDir, opts);
  }
}

function toDiscovered(server: InternalMcpServer): DiscoveredMcpServer {
  const { command, args, cwd, env, url, headers, connectorId, ...rest } = server;
  void command;
  void args;
  void cwd;
  void env;
  void url;
  void headers;
  void connectorId;
  return rest;
}

function toResolved(server: InternalMcpServer): ResolvedMcpServer {
  return {
    name: server.name,
    scope: server.scope,
    transport: server.transport,
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    ...(server.env === undefined ? {} : { env: server.env }),
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(server.headers === undefined ? {} : { headers: server.headers }),
    ...(server.connectorId === undefined ? {} : { connectorId: server.connectorId }),
  };
}

/** Error naming the server and reason. Never includes paths with secrets or any value. */
function selectionError(
  code: "E_NOT_FOUND" | "E_VALIDATION" | "E_CONFLICT",
  selection: McpSelection,
  reason: string,
): RelayError {
  return new RelayError(code, `MCP server "${selection.name}" (${selection.scope}): ${reason}.`);
}

function resolveOne(
  servers: InternalMcpServer[],
  selection: McpSelection,
): Result<ResolvedMcpServer, RelayError> {
  const found = servers.find(
    (server) => server.name === selection.name && server.scope === selection.scope,
  );
  if (found === undefined) {
    return err(selectionError("E_NOT_FOUND", selection, "not found in the CLI config"));
  }
  switch (found.status) {
    case "needs-trust":
      return err(selectionError("E_CONFLICT", selection, "project config is not trusted"));
    case "needs-auth":
      return err(selectionError("E_CONFLICT", selection, "needs authentication in the CLI"));
    case "disabled-in-cli":
      return err(selectionError("E_CONFLICT", selection, "disabled in the CLI config"));
    case "invalid":
      return err(selectionError("E_VALIDATION", selection, "has an invalid config entry"));
    case "ready":
      return ok(toResolved(found));
  }
}

export function createMcpResolver(options: McpResolverOptions = {}): McpResolver {
  return {
    async list(cli, projectDir): Promise<McpListResult> {
      try {
        const result = readAll(cli, projectDir, options);
        return { servers: result.servers.map(toDiscovered), warnings: result.warnings };
      } catch {
        return { servers: [], warnings: ["MCP discovery failed; no servers listed."] };
      }
    },

    async resolve(cli, projectDir, selection): Promise<Result<McpResolveResult, RelayError>> {
      let result: ReaderResult;
      try {
        result = readAll(cli, projectDir, options);
      } catch {
        return err(new RelayError("E_INTERNAL", "MCP discovery failed."));
      }
      const extra: ResolvedMcpServer[] = [];
      for (const item of selection) {
        const resolved = resolveOne(result.servers, item);
        if (!resolved.ok) return resolved;
        extra.push(resolved.value);
      }
      return ok({
        extra,
        known: result.servers.map((server) => ({
          name: server.name,
          scope: server.scope,
          ...(server.connectorId === undefined ? {} : { connectorId: server.connectorId }),
        })),
      });
    },
  };
}

/** Config locations that were read, for the HTTP route's `scanned` field. */
export function scannedMcpPaths(
  cli: ProdCliId,
  projectDir: string,
  options: McpResolverOptions = {},
): string[] {
  try {
    return readAll(cli, projectDir, options).scanned;
  } catch {
    return [];
  }
}
