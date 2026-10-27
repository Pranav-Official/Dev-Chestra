import { RelayError } from "@relay/core";
import { createClaudeAdapter } from "./claude.js";
import { createCodexAdapter } from "./codex.js";
import { createFakeAdapter, type FakeAdapterOptions } from "./fake.js";
import type { AdapterOptions, AdapterRegistry, CliAdapter, CliId, Invocation } from "./types.js";

export { discoverClaudeModels } from "./claude-model-discovery.js";
export { runCommand } from "./command.js";
export { buildChildEnv } from "./env.js";
export {
  isGroupAlive,
  killOrphan,
  killTree,
  matchesProcess,
  readProcessIdentity,
} from "./identity.js";
export { materializeInvocation } from "./invocation.js";
export { discoverCodexModels } from "./model-catalog.js";
export { classifyExit } from "./plan.js";
export { runAgent } from "./process.js";
export * from "./types.js";

export function createAdapter(id: CliId, options: FakeAdapterOptions = {}): CliAdapter {
  switch (id) {
    case "claude-code":
      return createClaudeAdapter(options);
    case "codex":
      return createCodexAdapter(options);
    case "fake":
      return createFakeAdapter(options);
  }
}

export interface AdapterRegistryOptions extends AdapterOptions {
  fakeScript?: unknown[] | string;
  ids?: CliId[];
}

export function createAdapterRegistry(options: AdapterRegistryOptions = {}): AdapterRegistry {
  const ids = options.ids ?? ["fake", "claude-code", "codex"];
  const cache = new Map<CliId, CliAdapter>();
  return {
    ids: () => [...ids],
    has: (id) => ids.includes(id),
    get: (id) => {
      const existing = cache.get(id);
      if (existing !== undefined) return existing;
      if (!ids.includes(id)) throw new RelayError("E_VALIDATION", `Adapter ${id} is disabled`);
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
