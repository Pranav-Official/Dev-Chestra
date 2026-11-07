import { DevChestraError, hashJson, isRecord } from "@devchestra/core";
import { applyModelTiers, type EffectiveModelTiers, MODEL_TIERS } from "@devchestra/schema";
import { analyzeWorkflowPlan } from "./graph-plan.js";
import type { WorkflowResolver } from "./types.js";

export const WORKFLOW_MAX_DEPTH = 8;
export const WORKFLOW_MAX_TOTAL = 32;

/** Includes calls in controller bodies; discovery never evaluates dynamic inputs. */
export function referencedWorkflowIds(snapshot: unknown): string[] {
  const ids = new Set<string>();
  const visit = (graph: unknown): void => {
    if (!isRecord(graph) || !Array.isArray(graph.nodes)) return;
    for (const node of graph.nodes) {
      if (!isRecord(node)) continue;
      if (node.type === "workflow" && typeof node.workflowId === "string") ids.add(node.workflowId);
      if (node.type === "foreach" || node.type === "loop") visit(node.body);
    }
  };
  visit(isRecord(snapshot) ? snapshot.graph : undefined);
  return [...ids];
}

/** Stand-in mapping so a still-tiered definition can be structurally analyzed. Never stored or run. */
const ANALYSIS_TIERS: EffectiveModelTiers = Object.fromEntries(
  MODEL_TIERS.map((tier) => [tier, { ref: { cli: "claude-code" }, source: "project" }]),
);

/** Structure checks need a provider on every agent; a tier only has one once a machine maps it. */
function analyzable(snapshot: unknown): unknown {
  return applyModelTiers(snapshot, ANALYSIS_TIERS).snapshot;
}

/**
 * Canonical, project-scoped dependency freeze before any run side effects.
 * Definitions are loaded once; DFS checks cycles and memoizes subtree height,
 * so shared DAGs are legal and depth limits hold even along a longer reused path.
 */
export async function freezeWorkflowBundle(options: {
  projectId: string;
  rootSnapshot: unknown;
  rootWorkflowId: string;
  dependencies?: Readonly<Record<string, unknown>> | undefined;
  resolver?: WorkflowResolver | undefined;
  /**
   * Applied to every child definition before it is stored in the bundle (model tiers). Without
   * it the bundle keeps the authored definitions, which is what a trigger stores when armed so
   * each firing resolves tiers on the machine that runs it.
   */
  transform?: ((snapshot: unknown) => Promise<unknown>) | undefined;
}): Promise<{ bundle: Record<string, unknown>; hashes: Record<string, string> }> {
  const rootPlan = analyzeWorkflowPlan(analyzable(options.rootSnapshot));
  if (!rootPlan.ok) throw rootPlan.error;
  const bundle: Record<string, unknown> = Object.create(null);
  const hashes: Record<string, string> = Object.create(null);
  const visiting = new Set([options.rootWorkflowId]);
  const heights = new Map<string, number>();

  const visit = async (id: string): Promise<number> => {
    if (visiting.has(id)) {
      throw new DevChestraError("E_WORKFLOW_INVALID", `Workflow call cycle detected at '${id}'`, {
        details: { chain: [...visiting, id] },
      });
    }
    const cachedHeight = heights.get(id);
    if (cachedHeight !== undefined) return cachedHeight;
    if (Object.keys(bundle).length >= WORKFLOW_MAX_TOTAL) {
      throw new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Workflow bundle exceeds ${WORKFLOW_MAX_TOTAL} definitions`,
      );
    }
    // Stop excessive recursion before loading any deeper definition.
    if (visiting.size > WORKFLOW_MAX_DEPTH) {
      throw new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Workflow call depth exceeds ${WORKFLOW_MAX_DEPTH}`,
      );
    }
    visiting.add(id);
    let snapshot: unknown;
    if (options.dependencies && Object.hasOwn(options.dependencies, id)) {
      snapshot = options.dependencies[id];
    } else {
      if (!options.resolver) {
        throw new DevChestraError(
          "E_WORKFLOW_INVALID",
          `Workflow '${id}' has no frozen definition and no workflowResolver is configured`,
        );
      }
      const resolved = await options.resolver.resolve(options.projectId, id);
      if (!resolved.ok) throw resolved.error;
      if (resolved.value.id !== id) {
        throw new DevChestraError(
          "E_WORKFLOW_INVALID",
          "Workflow resolver returned a mismatched id",
          {
            details: { expected: id, received: resolved.value.id },
          },
        );
      }
      snapshot = resolved.value.normalized;
    }
    if (options.transform !== undefined) snapshot = await options.transform(snapshot);
    const plan = analyzeWorkflowPlan(analyzable(snapshot));
    if (!plan.ok) throw plan.error;
    bundle[id] = snapshot;
    hashes[id] = await hashJson(snapshot);
    let height = 1;
    for (const child of referencedWorkflowIds(snapshot)) {
      height = Math.max(height, 1 + (await visit(child)));
    }
    visiting.delete(id);
    if (height > WORKFLOW_MAX_DEPTH) {
      throw new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Workflow call depth exceeds ${WORKFLOW_MAX_DEPTH}`,
      );
    }
    heights.set(id, height);
    return height;
  };
  for (const id of referencedWorkflowIds(options.rootSnapshot)) await visit(id);
  return { bundle, hashes };
}

export function bundleSnapshotFor(bundle: Record<string, unknown>, workflowId: string): unknown {
  if (!Object.hasOwn(bundle, workflowId)) {
    throw new DevChestraError(
      "E_NOT_FOUND",
      `Frozen workflow '${workflowId}' is missing from the bundle`,
      {
        details: { workflowId },
      },
    );
  }
  return bundle[workflowId];
}
