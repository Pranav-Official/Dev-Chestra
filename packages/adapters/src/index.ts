import { DevChestraError } from "@devchestra/core";
import type { FakeAdapterOptions } from "./fake.js";
import { getProvider, providerIds } from "./provider.js";
import type { AdapterOptions, AdapterRegistry, CliAdapter, CliId, Invocation } from "./types.js";

export { discoverClaudeModels } from "./claude-model-discovery.js";
export { runCommand } from "./command.js";
export {
  boundCount,
  boundMs,
  type DiscoveryRequestFields,
  hasControl,
  printable,
  validateDiscoveryRequest,
} from "./discovery-util.js";
export { buildChildEnv } from "./env.js";
export {
  acquireFileLock,
  type FileLockOptions,
  type ReleaseFileLock,
  withFileLock,
} from "./file-lock.js";
export {
  isGroupAlive,
  killOrphan,
  killTree,
  matchesProcess,
  readProcessIdentity,
} from "./identity.js";
export { finalizeInvocation, materializeInvocation } from "./invocation.js";
export { CODEX_INTERNAL_CONNECTOR_NAMES } from "./mcp-discovery/codex.js";
export {
  createMcpResolver,
  type DiscoveredMcpServer,
  type InternalMcpServer,
  type McpListResult,
  type McpResolveResult,
  type McpResolver,
  type McpResolverOptions,
  scannedMcpPaths,
} from "./mcp-discovery/index.js";
export { discoverCodexModels } from "./model-catalog.js";
export { discoverOpencodeModels, opencodeConfigIdentity } from "./opencode-discovery.js";
export { piCredentialScope } from "./pi.js";
export { discoverPiModels, piConfigIdentity } from "./pi-discovery.js";
export { classifyExit } from "./plan.js";
export { runAgent } from "./process.js";
export * from "./types.js";

export function createAdapter(id: CliId, options: FakeAdapterOptions = {}): CliAdapter {
  return getProvider(id).adapter(options);
}

export interface AdapterRegistryOptions extends AdapterOptions {
  fakeScript?: unknown[] | string;
  ids?: CliId[];
}

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
} from "./provider.js";
export {
  fakeCatalogMessage,
  getProvider,
  hasProvider,
  isFakeProviderEnabled,
  listProviders,
  prodProviderIds,
  providerIds,
  registerProvider,
} from "./provider.js";

export function createAdapterRegistry(options: AdapterRegistryOptions = {}): AdapterRegistry {
  const ids = options.ids ?? providerIds();
  const cache = new Map<CliId, CliAdapter>();
  return {
    ids: () => [...ids],
    has: (id) => ids.includes(id),
    get: (id) => {
      const existing = cache.get(id);
      if (existing !== undefined) return existing;
      if (!ids.includes(id)) throw new DevChestraError("E_VALIDATION", `Adapter ${id} is disabled`);
      const adapter = createAdapter(id, options);
      cache.set(id, adapter);
      return adapter;
    },
  };
}

/** Safe for logs: no env, stdin, prompt or file contents. */
export function describeInvocation(
  inv: Invocation,
  redact: (text: string) => string = (text) => text,
): { bin: string; args: string[]; cwd: string; files: string[] } {
  return {
    bin: inv.bin,
    args: inv.args.map(redact),
    cwd: inv.cwd,
    files: inv.files.map((file) => file.path),
  };
}
export {
  findWindowsExecutable,
  isWindowsPrivatePath,
  protectWindowsDirectory,
  stopWindowsTree,
  windowsProcessIdentity,
} from "./windows.js";
