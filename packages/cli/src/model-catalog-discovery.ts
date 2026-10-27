import { discoverClaudeModels, discoverCodexModels } from "@relay/adapters";
import type { CatalogCli, CliModelItem } from "@relay/server";

export type DiscoveryStatus = "ready" | "unsupported" | "unavailable" | "authRequired";
export type DiscoverySource = "codex-app-server" | "claude-sdk";

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

export function itemSourceForCli(cli: CatalogCli): DiscoverySource | null {
  if (cli === "codex") return "codex-app-server";
  if (cli === "claude-code") return "claude-sdk";
  return null;
}

export function catalogSourceForCli(cli: CatalogCli): "codex-app-server" | "claude-sdk" | "none" {
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

export const discoverCodex: DiscoverCli = (request) => discoverCodexModels(request);

export const discoverClaude: DiscoverCli = (request) => discoverClaudeModels(request);
