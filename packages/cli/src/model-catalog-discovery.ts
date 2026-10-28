import { type CliId, getProvider } from "@relay/adapters";
import type { CatalogCli, CliModelItem } from "@relay/server";

export type DiscoveryStatus = "ready" | "unsupported" | "unavailable" | "authRequired";
export type DiscoverySource =
  | "codex-app-server"
  | "claude-sdk"
  | "opencode-models"
  | "pi-list-models";

export interface DiscoveryItem {
  id: string;
  label: string;
  provider?: string;
  description?: string;
  aliases?: string[];
  isDefault?: boolean;
  source: DiscoverySource;
}

export interface DiscoveryResult {
  status: DiscoveryStatus;
  items: DiscoveryItem[];
  cliVersion: string | null;
  truncated: boolean;
  message?: string;
}

export interface DiscoveryRequest {
  cwd: string;
  bin?: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type DiscoverCli = (request: DiscoveryRequest) => Promise<DiscoveryResult>;

function toDiscoverySource(source: string): DiscoverySource | null {
  return source === "codex-app-server" ||
    source === "claude-sdk" ||
    source === "opencode-models" ||
    source === "pi-list-models"
    ? source
    : null;
}

export function itemSourceForCli(cli: CatalogCli): DiscoverySource | null {
  return toDiscoverySource(getProvider(cli as CliId).discovery.source);
}

export function catalogSourceForCli(cli: CatalogCli): DiscoverySource | "none" {
  return itemSourceForCli(cli) ?? "none";
}

export function normalizeItem(item: DiscoveryItem, source: DiscoverySource): CliModelItem {
  return {
    id: item.id,
    label: item.label,
    ...(item.provider === undefined ? {} : { provider: item.provider }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.aliases === undefined ? {} : { aliases: item.aliases }),
    ...(item.isDefault === undefined ? {} : { isDefault: item.isDefault }),
    source,
  };
}

// Registry-backed discovery. The CLI catalog only models the codex/claude
// sources (matching the API schema); the provider registry may know more, so
// the wider registry result is narrowed at this boundary. No live CLI is
// contacted here: these only run when the catalog service calls them (tests
// inject stand-ins instead).
export const discoverCodex: DiscoverCli = (request) =>
  getProvider("codex").discovery.discover(request) as Promise<DiscoveryResult>;

export const discoverClaude: DiscoverCli = (request) =>
  getProvider("claude-code").discovery.discover(request) as Promise<DiscoveryResult>;
