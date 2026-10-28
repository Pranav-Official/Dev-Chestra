import type { RelayError, Result } from "@relay/core";
import type { McpScope, McpSelection, ProdCliId } from "@relay/schema";
import type { ResolvedMcpServer, RunRequest } from "../types.js";

/**
 * What the UI sees. Mirrors `DiscoveredMcpServer` in `@relay/api` (adapters
 * cannot import `@relay/api`, so the shape is duplicated here and kept
 * compatible by a compile-time check in the server tests). Never carries env
 * values, header values, tokens or URL credentials.
 */
export interface DiscoveredMcpServer {
  /** Stable: `${scope}:${name}`. */
  id: string;
  /** Name in the CLI config. */
  name: string;
  scope: McpScope;
  transport: "stdio" | "http" | "sse";
  /** Short summary: `command + first arg` or the URL host only. Never secrets. */
  summary: string;
  /** Config file path, shown on hover. */
  source: string;
  status: "ready" | "needs-trust" | "needs-auth" | "disabled-in-cli" | "invalid";
  /** Env vars or headers are present (names only). */
  hasSecrets: boolean;
  /** Connectors only: how many tools the connector exposes, when known. */
  toolCount?: number;
}

export interface McpListResult {
  servers: DiscoveredMcpServer[];
  warnings: string[];
}

/** Everything the engine passes to adapters: selected servers plus the full known list. */
export interface McpResolveResult {
  extra: ResolvedMcpServer[];
  known: NonNullable<RunRequest["knownMcp"]>;
}

export interface McpResolver {
  /** Everything the CLI knows for this project. Names only (no secrets). Never throws. */
  list(cli: ProdCliId, projectDir: string): Promise<McpListResult>;
  /**
   * Selected servers with launch details. Fails (never skips) when one is
   * missing, untrusted, needs auth, disabled or invalid. The error message
   * names the server and reason, never secrets.
   */
  resolve(
    cli: ProdCliId,
    projectDir: string,
    selection: readonly McpSelection[],
  ): Promise<Result<McpResolveResult, RelayError>>;
}

export interface McpResolverOptions {
  /** Test seam: fake home dir. Defaults to `env.HOME` or the OS home. */
  home?: string;
  /** Test seam: environment overrides. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Reader output: discovered fields plus the secret values resolve() needs. */
export interface InternalMcpServer extends DiscoveredMcpServer {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Connectors only: id of the connector inside the CLI's built-in apps server. */
  connectorId?: string;
}

export interface ReaderResult {
  servers: InternalMcpServer[];
  /** Config locations that were read (absolute paths). */
  scanned: string[];
  warnings: string[];
}
