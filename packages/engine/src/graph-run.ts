import {
  deriveRouting,
  type RoutingEdgeState,
  type RoutingExecutionState,
  type RoutingGraph,
  type RoutingView,
} from "@relay/core";
import type { JoinRouting } from "./exec-routing.js";
import type { WorkflowPlan } from "./graph-plan.js";

export function routingGraph(plan: WorkflowPlan): RoutingGraph {
  return {
    nodes: plan.nodes.map((node) => {
      const branches = plan.gateBranches.get(node.id);
      const inputs = plan.joinInputs.get(node.id);
      return {
        id: node.id,
        type: node.type,
        ...(branches === undefined
          ? {}
          : { branches: branches.map((branch) => ({ id: branch.id })) }),
        ...(node.raw.mode === "first" || node.raw.mode === "all" ? { mode: node.raw.mode } : {}),
        ...(inputs === undefined ? {} : { inputs }),
      };
    }),
    edges: plan.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.sourceBranch === undefined ? {} : { sourceHandle: edge.sourceBranch }),
      ...(edge.targetInput === undefined ? {} : { targetHandle: edge.targetInput }),
    })),
  };
}

export function derivePlanRouting(
  plan: WorkflowPlan,
  executions: Readonly<Record<string, RoutingExecutionState>>,
): RoutingView {
  return deriveRouting(routingGraph(plan), executions);
}

export function joinRoutingFor(
  plan: WorkflowPlan,
  joinId: string,
  routing: RoutingView,
): JoinRouting {
  const active: string[] = [];
  const skipped: string[] = [];
  for (const edge of plan.incoming.get(joinId) ?? []) {
    const state: RoutingEdgeState = routing.edges[edge.id] ?? "pending";
    if (edge.targetInput === undefined) continue;
    if (state === "active") active.push(edge.targetInput);
    if (state === "dead") skipped.push(edge.targetInput);
  }
  return { active, skipped };
}
