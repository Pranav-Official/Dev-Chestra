import { RelayError } from "@relay/core";
import { createClaudeAdapter } from "./claude.js";
import { discoverClaudeModels } from "./claude-model-discovery.js";
import { createCodexAdapter } from "./codex.js";
import { createFakeAdapter } from "./fake.js";
import { discoverCodexModels } from "./model-catalog.js";
import { createOpencodeAdapter } from "./opencode.js";
import { discoverOpencodeModels } from "./opencode-discovery.js";
import { createPiAdapter } from "./pi.js";
import { discoverPiModels } from "./pi-discovery.js";
import type { CliProvider, ModelDiscoveryResult } from "./provider-config.js";
import {
  claudeStatic,
  codexStatic,
  fakeStatic,
  opencodeStatic,
  piStatic,
} from "./provider-config.js";
import type { AdapterOptions, CliId, ProdCliId } from "./types.js";

export type {
  CliProvider,
  ContextIdentityProvider,
  ModelDiscoveryItem,
  ModelDiscoveryProvider,
  ModelDiscoveryRequest,
  ModelDiscoveryResult,
  ModelDiscoverySource,
  ModelDiscoveryStatus,
  PermissionMap,
  ProviderStatic,
} from "./provider-config.js";
export {
  claudePermissionMap,
  codexPermissionMap,
  fakePermissionMap,
  piPermissionMap,
  providerStatics,
} from "./provider-config.js";

const FAKE_CATALOG_MESSAGE = "This CLI does not provide a model catalog.";

async function discoverFake(): Promise<ModelDiscoveryResult> {
  return { status: "unsupported", items: [], cliVersion: null, truncated: false };
}

export const claudeProvider: CliProvider = {
  ...claudeStatic,
  adapter: (options: AdapterOptions = {}) => createClaudeAdapter(options),
  discovery: {
    source: "claude-sdk",
    discover: discoverClaudeModels,
  },
};

export const codexProvider: CliProvider = {
  ...codexStatic,
  adapter: (options: AdapterOptions = {}) => createCodexAdapter(options),
  discovery: {
    source: "codex-app-server",
    discover: discoverCodexModels,
  },
};

export const piProvider: CliProvider = {
  ...piStatic,
  adapter: (options: AdapterOptions = {}) => createPiAdapter(options),
  discovery: {
    source: "pi-list-models",
    discover: discoverPiModels,
  },
};

export const fakeProvider: CliProvider = {
  ...fakeStatic,
  adapter: (options: AdapterOptions = {}) => createFakeAdapter(options),
  discovery: { source: "none", discover: discoverFake },
};

/** Test-only gate: the fake provider is invisible unless explicitly enabled. */
// ponytail: single env flag; promote to a registry option if more test seams appear.
export function isFakeProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.RELAY_ALLOW_FAKE;
  return value === "1" || value === "true";
}

export const opencodeProvider: CliProvider = {
  ...opencodeStatic,
  adapter: (options: AdapterOptions = {}) => createOpencodeAdapter(options),
  discovery: {
    source: "opencode-models",
    discover: discoverOpencodeModels,
  },
};

export function fakeCatalogMessage(): string {
  return FAKE_CATALOG_MESSAGE;
}

const providers = new Map<CliId, CliProvider>();

registerProvider(claudeProvider);
registerProvider(codexProvider);
registerProvider(opencodeProvider);
registerProvider(piProvider);
registerProvider(fakeProvider);

export function registerProvider(provider: CliProvider): void {
  providers.set(provider.id, provider);
}

function requireVisible(id: CliId): void {
  if (id === "fake" && !isFakeProviderEnabled()) {
    throw new RelayError("E_VALIDATION", "Adapter fake is test-only (RELAY_ALLOW_FAKE=1).");
  }
}

export function hasProvider(id: CliId): boolean {
  if (id === "fake" && !isFakeProviderEnabled()) return false;
  return providers.has(id);
}

export function getProvider(id: CliId): CliProvider {
  requireVisible(id);
  const provider = providers.get(id);
  if (provider === undefined) {
    throw new RelayError("E_VALIDATION", `Unknown CLI provider '${String(id)}'`);
  }
  return provider;
}

export function listProviders(): CliProvider[] {
  return [...providers.values()].filter(
    (provider) => provider.id !== "fake" || isFakeProviderEnabled(),
  );
}

export function providerIds(): CliId[] {
  return listProviders().map((provider) => provider.id);
}

/** Production registry ids (no live probes; static registry only). */
export function prodProviderIds(): ProdCliId[] {
  return ["claude-code", "codex", "opencode", "pi"];
}
