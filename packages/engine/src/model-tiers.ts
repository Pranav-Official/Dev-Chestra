import { DevChestraError } from "@devchestra/core";
import { applyModelTiers, collectModelTierUses, unmappedTierMessage } from "@devchestra/schema";
import type { ModelTierSource } from "./types.js";

/**
 * Wraps a tier source so settings are read at most once, on first use, and every caller shares
 * that one result (a failed load included). One run launch uses one wrapper for the root and
 * every child workflow, so a settings edit made mid-launch cannot give them different mappings.
 * Never reuse a wrapper across launches: each launch must see the settings as they are then.
 */
export function memoizeModelTierSource(
  source: ModelTierSource | undefined,
): ModelTierSource | undefined {
  if (source === undefined) return undefined;
  let loaded: ReturnType<ModelTierSource["load"]> | undefined;
  return {
    load(projectId) {
      loaded ??= source.load(projectId);
      return loaded;
    },
  };
}

/**
 * Replaces every tiered agent node in a snapshot with the provider and model this machine
 * maps that tier to. A snapshot with no tiered nodes is returned untouched and never reads
 * settings. Throws `E_MODEL_TIER` before any run side effect when a tier cannot be resolved,
 * so a workflow committed with tiers fails fast on a machine that has not mapped them.
 */
export async function resolveModelTiers<T>(options: {
  projectId: string;
  snapshot: T;
  source: ModelTierSource | undefined;
}): Promise<T> {
  if (collectModelTierUses(options.snapshot).length === 0) return options.snapshot;
  if (options.source === undefined) {
    throw new DevChestraError(
      "E_MODEL_TIER",
      "This workflow uses model tiers but no project settings source is configured.",
    );
  }
  const loaded = await options.source.load(options.projectId);
  if (!loaded.ok) throw loaded.error;
  const applied = applyModelTiers(options.snapshot, loaded.value);
  if (applied.unresolved.length > 0) {
    throw new DevChestraError("E_MODEL_TIER", unmappedTierMessage(applied.unresolved), {
      details: { unresolved: applied.unresolved },
    });
  }
  return applied.snapshot;
}
