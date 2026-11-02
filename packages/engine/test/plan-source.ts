import { analyzeWorkflowPlan, type PlanNode, type WorkflowPlan } from "../src/graph-plan.js";

/** Plan for a snapshot; throws the analysis error. */
export function planOf(snapshot: unknown): WorkflowPlan {
  const analyzed = analyzeWorkflowPlan(snapshot);
  if (!analyzed.ok) throw analyzed.error;
  return analyzed.value;
}

export function planNode(plan: WorkflowPlan, id: string): PlanNode {
  const node = plan.byId.get(id);
  if (node === undefined) throw new Error(`Missing plan node ${id}`);
  return node;
}

/** The plan without ancestors, so one node runs without any upstream outputs. */
export function isolated(plan: WorkflowPlan): WorkflowPlan {
  return { ...plan, ancestorsOf: () => new Set<string>() };
}
