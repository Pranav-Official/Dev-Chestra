import {
  type AdapterRegistry,
  type CliId,
  getProvider,
  isCliId,
  isProdCliId,
} from "@devchestra/adapters";
import { DevChestraError } from "@devchestra/core";
import { PROD_CLI_LABELS } from "@devchestra/schema";
import type { EngineContext } from "./context.js";
import type { PlanNode } from "./graph-plan.js";

/** Plan nodes carry `cli` as unknown; narrow with the guard so an unregistered
 * id fails here instead of compiling through a cast. */
export function readCliId(value: unknown): CliId {
  if (isCliId(value)) return value;
  throw new DevChestraError("E_CLI_MISSING", `Adapter '${String(value)}' is not available`);
}

/** A provider the user turned off in Settings. Refused before any durable work. */
export function cliDisabledError(cli: CliId): DevChestraError {
  const label = isProdCliId(cli) ? PROD_CLI_LABELS[cli] : cli;
  return new DevChestraError(
    "E_CLI_DISABLED",
    `${label} is turned off. Turn it on in Settings > Providers.`,
    { details: { cli } },
  );
}

export interface AgentAdapter {
  provider: ReturnType<typeof getProvider>;
  adapter: ReturnType<AdapterRegistry["get"]>;
}

/**
 * Resolve the CLI adapter for an agent node and enforce the experimental
 * opt-in gate. Experimental providers only run when the caller explicitly
 * allows that production CLI id; everything else fails before any workspace
 * acquisition, process dispatch or durable event.
 */
export function resolveAgentAdapter(ctx: EngineContext, node: PlanNode): AgentAdapter {
  const provider = getProvider(readCliId(node.raw.cli));
  if (ctx.deps.isCliEnabled?.(provider.id) === false) throw cliDisabledError(provider.id);
  const adapter = ctx.deps.adapters.get(provider.id);
  if (provider.experimental) {
    const allowed = ctx.deps.allowExperimentalClis ?? [];
    if (!(isProdCliId(provider.id) && allowed.includes(provider.id))) {
      throw new DevChestraError(
        "E_CLI_MISSING",
        `Adapter '${provider.id}' is not enabled in this build. The caller must opt in with an explicit experimental flag after a live contract check.`,
        { details: { cli: provider.id, behaviorVerified: adapter.evidence.behaviorVerified } },
      );
    }
  }
  return { provider, adapter };
}
