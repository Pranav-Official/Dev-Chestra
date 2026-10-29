import { DevChestraError, formatPath, parsePath } from "@devchestra/core";
import type { PlanEdge, PlanNode, WorkflowPlan } from "./graph-plan.js";

/** Instantiate an already validated body; never rewrite its expressions or raw node ids. */
export function instantiateBody(
  plan: WorkflowPlan,
  controller: string,
  iteration: number,
  scope: Readonly<Record<string, unknown>>,
): WorkflowPlan {
  const parsed = parsePath(controller);
  if (!parsed.ok) throw parsed.error;
  const segments = parsed.value;
  const last = segments.at(-1);
  if (last === undefined)
    throw new DevChestraError("E_INTERNAL", "Loop controller must have a node path");
  const prefix = formatPath([...segments.slice(0, -1), { node: last.node, round: iteration }]);
  const path = (id: string): string => `${prefix}/${id}`;
  const nodes: PlanNode[] = plan.nodes.map((node) => ({ ...node, id: path(node.id) }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const nodeAt = (id: string): PlanNode => {
    const node = byId.get(path(id));
    if (!node) throw new DevChestraError("E_INTERNAL", `Unknown body node '${id}'`);
    return node;
  };
  const edges: PlanEdge[] = plan.edges.map((edge) => ({
    ...edge,
    id: path(edge.id),
    from: path(edge.from),
    to: path(edge.to),
  }));
  const incoming = new Map<string, PlanEdge[]>();
  const outgoing = new Map<string, PlanEdge[]>();
  for (const edge of edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  return {
    nodes,
    edges,
    byId,
    incoming,
    outgoing,
    start: nodeAt(plan.start.id),
    ends: plan.ends.map((node) => nodeAt(node.id)),
    gateBranches: new Map([...plan.gateBranches].map(([id, branches]) => [path(id), branches])),
    joinInputs: new Map([...plan.joinInputs].map(([id, inputs]) => [path(id), inputs])),
    body: true,
    scope,
    ancestorsOf(id) {
      const local = byId.get(id)?.raw.id;
      if (typeof local !== "string")
        throw new DevChestraError("E_INTERNAL", `Unknown body node '${id}'`);
      return new Set([...plan.ancestorsOf(local)].map(path));
    },
  };
}
