import { LOOP_EXHAUSTED_HANDLE } from "@devchestra/core";
import { decisionHandles } from "./decision-route.js";
import { HANDLE_ID_PATTERN, NODE_ID_PATTERN } from "./ids.js";
import { validateGate, validateJoin } from "./routing.js";
import type { Edge, GateBranch, Graph, Issue, JoinNode, WorkflowNode } from "./types.js";

export { HANDLE_ID_PATTERN, LOOP_EXHAUSTED_HANDLE, NODE_ID_PATTERN };

const EDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUPPORTED_TYPES = new Set([
  "start",
  "agent",
  "shell",
  "gate",
  "join",
  "approval",
  "decision",
  "loop",
  "foreach",
  "workflow",
  "end",
]);

export interface ResolvedEdge {
  readonly edge: Edge;
  readonly index: number;
  readonly fromNode: string;
  readonly fromHandle: string | null;
  readonly toNode: string;
  readonly toHandle: string | null;
}

export interface GraphAnalysis {
  nodesById: Map<string, WorkflowNode>;
  /** Raw edges keyed by resolved source/target node id. */
  incoming: Map<string, Edge[]>;
  outgoing: Map<string, Edge[]>;
  resolvedEdges: ResolvedEdge[];
  resolvedByEdgeId: Map<string, ResolvedEdge>;
  sourceNodeId(edge: Edge): string | undefined;
  targetNodeId(edge: Edge): string | undefined;
  sourceHandle(edge: Edge): string | null | undefined;
  targetHandle(edge: Edge): string | null | undefined;
  gateBranches(nodeId: string): GateBranch[];
  joinInputs(nodeId: string): string[];
  ancestors(nodeId: string): Set<string>;
  descendants(nodeId: string): Set<string>;
}

interface Endpoint {
  raw: string;
  node: string;
  handle: string | null;
}

function issue(code: string, message: string, pointer: string, nodeId?: string): Issue {
  return {
    severity: "error",
    code,
    message,
    pointer,
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function push(map: Map<string, Edge[]>, key: string, edge: Edge): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [edge]);
  else list.push(edge);
}

function parseEndpoint(raw: string): Endpoint | null {
  if (raw === "" || raw.startsWith("$")) return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return { raw, node: raw, handle: null };
  if (dot === 0 || dot === raw.length - 1) return null;
  if (raw.indexOf(".", dot + 1) >= 0) return null;
  return { raw, node: raw.slice(0, dot), handle: raw.slice(dot + 1) };
}

function endpointIssue(code: string, message: string, pointer: string): Issue {
  return issue(code, message, pointer);
}

function validateEndpoint(
  endpoint: Endpoint,
  direction: "from" | "to",
  nodesById: Map<string, WorkflowNode>,
  pointer: string,
): Issue | undefined {
  const node = nodesById.get(endpoint.node);
  if (node === undefined) {
    return endpointIssue(
      "E_EDGE_DANGLING",
      `Edge ${direction} references unknown node '${endpoint.node}'.`,
      pointer,
    );
  }
  if (direction === "from") {
    if (endpoint.handle !== null) {
      if (node.type === "gate") {
        if (!HANDLE_ID_PATTERN.test(endpoint.handle)) {
          return endpointIssue(
            "E_EDGE_HANDLE",
            `Gate branch id '${endpoint.handle}' must match ${HANDLE_ID_PATTERN.source}.`,
            pointer,
          );
        }
        if (!node.branches.some((branch) => branch.id === endpoint.handle)) {
          return endpointIssue(
            "E_EDGE_BRANCH",
            `Edge source '${endpoint.raw}' does not name a branch of gate '${node.id}'.`,
            pointer,
          );
        }
        return undefined;
      }
      if (node.type === "approval") {
        if (endpoint.handle !== "rejected") {
          return endpointIssue(
            "E_EDGE_HANDLE",
            `Approval source handle must be 'rejected' ('${node.id}.rejected'); got '${endpoint.handle}'.`,
            pointer,
          );
        }
        return undefined;
      }
      if (node.type === "decision") {
        if (!HANDLE_ID_PATTERN.test(endpoint.handle)) {
          return endpointIssue(
            "E_EDGE_HANDLE",
            `Decision handle id '${endpoint.handle}' must match ${HANDLE_ID_PATTERN.source}.`,
            pointer,
          );
        }
        if (!decisionHandles(node).includes(endpoint.handle)) {
          return endpointIssue(
            "E_EDGE_BRANCH",
            `Edge source '${endpoint.raw}' does not name a handle of decision '${node.id}'.`,
            pointer,
          );
        }
        return undefined;
      }
      if (node.type === "loop") {
        if (endpoint.handle !== LOOP_EXHAUSTED_HANDLE) {
          return endpointIssue(
            "E_EDGE_HANDLE",
            `Loop source handle must be '${LOOP_EXHAUSTED_HANDLE}' ('${node.id}.${LOOP_EXHAUSTED_HANDLE}'); got '${endpoint.handle}'.`,
            pointer,
          );
        }
        return undefined;
      }
      if (node.type === "workflow") {
        if (endpoint.handle !== "failed") {
          return endpointIssue(
            "E_EDGE_HANDLE",
            `Workflow source handle must be 'failed' ('${node.id}.failed'); got '${endpoint.handle}'.`,
            pointer,
          );
        }
        return undefined;
      }
      return endpointIssue(
        "E_EDGE_HANDLE",
        `Edge source '${endpoint.raw}' names a handle, but '${node.id}' is not a gate, approval, decision, loop or workflow.`,
        pointer,
      );
    }
    if (node.type === "gate") {
      return endpointIssue(
        "E_EDGE_HANDLE",
        `Gate '${node.id}' edges must name a branch ('${node.id}.branchId').`,
        pointer,
      );
    }
    if (node.type === "decision") {
      return endpointIssue(
        "E_EDGE_HANDLE",
        `Decision '${node.id}' edges must name a handle ('${node.id}.handleId').`,
        pointer,
      );
    }
    return undefined;
  }

  if (endpoint.handle !== null) {
    if (node.type !== "join") {
      return endpointIssue(
        "E_EDGE_HANDLE",
        `Edge target '${endpoint.raw}' names an input, but '${node.id}' is not a join.`,
        pointer,
      );
    }
    if (!HANDLE_ID_PATTERN.test(endpoint.handle)) {
      return endpointIssue(
        "E_EDGE_HANDLE",
        `Join input name '${endpoint.handle}' must match ${HANDLE_ID_PATTERN.source}.`,
        pointer,
      );
    }
    if (!node.inputs.includes(endpoint.handle)) {
      return endpointIssue(
        "E_EDGE_INPUT",
        `Edge target '${endpoint.raw}' does not name an input of join '${node.id}'.`,
        pointer,
      );
    }
    return undefined;
  }
  if (node.type === "join") {
    return endpointIssue(
      "E_EDGE_HANDLE",
      `Join '${node.id}' edges must name an input ('${node.id}.inputName').`,
      pointer,
    );
  }
  if (node.type === "start") {
    return endpointIssue("E_EDGE_START", "The start node cannot have inbound edges.", pointer);
  }
  return undefined;
}

function reachable(
  startIds: readonly string[],
  next: Map<string, Edge[]>,
  byEdge: Map<Edge, ResolvedEdge>,
  direction: "from" | "to",
): Set<string> {
  const seen = new Set<string>();
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const edge of next.get(id) ?? []) {
      const resolved = byEdge.get(edge);
      const target =
        resolved === undefined ? undefined : resolved[direction === "to" ? "toNode" : "fromNode"];
      if (target !== undefined && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function cycleNodes(adjacency: Map<string, string[]>, ids: string[]): Set<string> {
  const state = new Map<string, 0 | 1 | 2>();
  const inCycle = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    const current = state.get(id) ?? 0;
    if (current === 1) {
      const start = stack.indexOf(id);
      for (const member of stack.slice(start < 0 ? 0 : start)) inCycle.add(member);
      inCycle.add(id);
      return;
    }
    if (current === 2) return;
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) visit(next, stack);
    stack.pop();
    state.set(id, 2);
  };
  for (const id of ids) visit(id, []);
  return inCycle;
}

/**
 * Structural graph analysis for the top-level DAG subset. Returns every issue it
 * can find (no throwing) and pure routing helpers. Handles resolve gate source
 * ('gateId.branchId') and join target ('joinId.inputName') to real nodes.
 */
export function analyzeGraph(graph: Graph): { analysis: GraphAnalysis; issues: Issue[] } {
  const issues: Issue[] = [];
  const nodesById = new Map<string, WorkflowNode>();
  const incoming = new Map<string, Edge[]>();
  const outgoing = new Map<string, Edge[]>();
  const resolvedEdges: ResolvedEdge[] = [];
  const resolvedByEdgeId = new Map<string, ResolvedEdge>();
  const byEdge = new Map<Edge, ResolvedEdge>();
  const adjacency = new Map<string, string[]>();

  graph.nodes.forEach((node, index) => {
    const pointer = `/graph/nodes/${index}`;
    if (!SUPPORTED_TYPES.has(node.type)) {
      issues.push(
        issue(
          "E_NODE_TYPE",
          `Unsupported node type '${node.type}'; supported types are start, agent, shell, gate, join, approval, decision, loop, foreach, workflow, end.`,
          `${pointer}/type`,
          node.id,
        ),
      );
    }
    if (!NODE_ID_PATTERN.test(node.id)) {
      issues.push(
        issue(
          "E_NODE_ID",
          `Node id '${node.id}' must match ${NODE_ID_PATTERN.source}; ids must be JSONata-safe (no hyphens).`,
          `${pointer}/id`,
          node.id,
        ),
      );
    } else if (node.id === "start" && node.type !== "start") {
      issues.push(
        issue(
          "E_NODE_ID_RESERVED",
          "The node id 'start' is reserved for the start node because 'start' names run parameters in expressions.",
          `${pointer}/id`,
          node.id,
        ),
      );
    }
    if (nodesById.has(node.id)) {
      issues.push(
        issue("E_NODE_DUPLICATE", `Duplicate node id '${node.id}'.`, `${pointer}/id`, node.id),
      );
    } else {
      nodesById.set(node.id, node);
    }
    if (node.type === "gate") issues.push(...validateGate(node, pointer));
  });

  const edgeIds = new Set<string>();
  graph.edges.forEach((edge, index) => {
    const pointer = `/graph/edges/${index}`;
    if (typeof edge.id !== "string" || !EDGE_ID_PATTERN.test(edge.id)) {
      issues.push(
        issue(
          "E_EDGE_ID",
          `Edge id '${String(edge.id)}' must match ${EDGE_ID_PATTERN.source}.`,
          `${pointer}/id`,
        ),
      );
    }
    if (typeof edge.id === "string") {
      if (edgeIds.has(edge.id)) {
        issues.push(issue("E_EDGE_DUPLICATE", `Duplicate edge id '${edge.id}'.`, `${pointer}/id`));
      }
      edgeIds.add(edge.id);
    }

    let valid = true;
    const from = typeof edge.from === "string" ? parseEndpoint(edge.from) : null;
    const to = typeof edge.to === "string" ? parseEndpoint(edge.to) : null;
    if (from === null) {
      issues.push(
        issue(
          "E_EDGE_UNSUPPORTED",
          `Edge source '${String(edge.from)}' is not supported in the top-level graph.`,
          `${pointer}/from`,
        ),
      );
      valid = false;
    }
    if (to === null) {
      issues.push(
        issue(
          "E_EDGE_UNSUPPORTED",
          `Edge target '${String(edge.to)}' is not supported in the top-level graph.`,
          `${pointer}/to`,
        ),
      );
      valid = false;
    }
    if (from !== null) {
      const problem = validateEndpoint(from, "from", nodesById, `${pointer}/from`);
      if (problem !== undefined) {
        issues.push(problem);
        valid = false;
      }
    }
    if (to !== null) {
      const problem = validateEndpoint(to, "to", nodesById, `${pointer}/to`);
      if (problem !== undefined) {
        issues.push(problem);
        valid = false;
      }
    }
    if (!valid || from === null || to === null) return;

    const resolved: ResolvedEdge = {
      edge,
      index,
      fromNode: from.node,
      fromHandle: from.handle,
      toNode: to.node,
      toHandle: to.handle,
    };
    resolvedEdges.push(resolved);
    resolvedByEdgeId.set(edge.id, resolved);
    byEdge.set(edge, resolved);
    push(incoming, to.node, edge);
    push(outgoing, from.node, edge);
    const list = adjacency.get(from.node);
    if (list === undefined) adjacency.set(from.node, [to.node]);
    else if (!list.includes(to.node)) list.push(to.node);
  });

  const starts = graph.nodes.filter((node) => node.type === "start");
  const ends = graph.nodes.filter((node) => node.type === "end");
  if (starts.length !== 1) {
    issues.push(
      issue(
        "E_START_COUNT",
        `Workflow must have exactly one start node (found ${starts.length}).`,
        "/graph/nodes",
      ),
    );
  }
  if (ends.length === 0) {
    issues.push(issue("E_END_COUNT", "Workflow must have at least one end node.", "/graph/nodes"));
  }

  const joinInputs = new Map<string, string[]>();
  graph.nodes.forEach((node, index) => {
    const pointer = `/graph/nodes/${index}`;
    const inbound = incoming.get(node.id) ?? [];
    const outbound = outgoing.get(node.id) ?? [];
    if (node.type === "start") {
      if (inbound.length !== 0) {
        issues.push(
          issue("E_CHAIN_START", "The start node cannot have inbound edges.", pointer, node.id),
        );
      }
      return;
    }
    if (node.type === "end") {
      if (outbound.length !== 0) {
        issues.push(
          issue("E_CHAIN_END", "The end node cannot have outbound edges.", pointer, node.id),
        );
      }
      if (inbound.length > 1) {
        issues.push(
          issue(
            "E_CHAIN_IN",
            `End node '${node.id}' has more than one inbound edge (found ${inbound.length}).`,
            pointer,
            node.id,
          ),
        );
      }
      return;
    }
    if (node.type === "join") {
      const checked = validateJoin(node, pointer);
      issues.push(...checked.issues);
      const declared = [...checked.inputs].sort();
      joinInputs.set(node.id, declared);
      for (const input of declared) {
        const count = inbound.filter((edge) => byEdge.get(edge)?.toHandle === input).length;
        if (count !== 1) {
          issues.push(
            issue(
              "E_JOIN_INPUT_EDGES",
              `Join '${node.id}' input '${input}' must have exactly one inbound edge (found ${count}).`,
              pointer,
              node.id,
            ),
          );
        }
      }
      return;
    }

    if (inbound.length > 1) {
      issues.push(
        issue(
          "E_CHAIN_IN",
          `Node '${node.id}' has more than one inbound edge; only joins may merge inputs (found ${inbound.length}).`,
          pointer,
          node.id,
        ),
      );
    }
    const gateInbound = inbound.some((edge) => {
      const resolved = byEdge.get(edge);
      return resolved !== undefined && resolved.fromHandle !== null;
    });
    if (gateInbound && inbound.length > 1) {
      issues.push(
        issue(
          "E_GATE_INBOUND",
          `Node '${node.id}' receives a gate branch edge, so that branch must be its only inbound edge.`,
          pointer,
          node.id,
        ),
      );
    }
  });
  for (const node of graph.nodes) {
    if (node.type === "join") {
      if (!joinInputs.has(node.id)) joinInputs.set(node.id, [...node.inputs].sort());
    }
  }

  const startIds = starts.map((node) => node.id);
  const endIds = ends.map((node) => node.id);
  const forward = reachable(startIds, outgoing, byEdge, "to");
  const backward: Set<string> = (() => {
    const seen = new Set<string>();
    const queue = [...endIds];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      for (const edge of incoming.get(id) ?? []) {
        const resolved = byEdge.get(edge);
        if (resolved !== undefined && !seen.has(resolved.fromNode)) queue.push(resolved.fromNode);
      }
    }
    return seen;
  })();

  graph.nodes.forEach((node, index) => {
    if (!forward.has(node.id)) {
      issues.push(
        issue(
          "E_UNREACHABLE",
          `Node '${node.id}' is not reachable from the start node.`,
          `/graph/nodes/${index}/id`,
          node.id,
        ),
      );
    }
    if (!backward.has(node.id)) {
      issues.push(
        issue(
          "E_NO_END",
          `Node '${node.id}' cannot reach an end node.`,
          `/graph/nodes/${index}/id`,
          node.id,
        ),
      );
    }
  });

  const cyclic = cycleNodes(
    adjacency,
    graph.nodes.map((node) => node.id),
  );
  for (const id of cyclic) {
    const index = graph.nodes.findIndex((node) => node.id === id);
    issues.push(
      issue(
        "E_CYCLE",
        `Node '${id}' participates in a cycle; the top-level graph must be acyclic.`,
        `/graph/nodes/${Math.max(index, 0)}`,
        id,
      ),
    );
  }

  const ancestorCache = new Map<string, Set<string>>();
  const ancestors = (nodeId: string): Set<string> => {
    const cached = ancestorCache.get(nodeId);
    if (cached !== undefined) return cached;
    const found = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) continue;
      for (const edge of incoming.get(id) ?? []) {
        const resolved = byEdge.get(edge);
        if (resolved === undefined || found.has(resolved.fromNode)) continue;
        found.add(resolved.fromNode);
        queue.push(resolved.fromNode);
      }
    }
    ancestorCache.set(nodeId, found);
    return found;
  };

  const descendantCache = new Map<string, Set<string>>();
  const descendants = (nodeId: string): Set<string> => {
    const cached = descendantCache.get(nodeId);
    if (cached !== undefined) return cached;
    const found = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) continue;
      for (const edge of outgoing.get(id) ?? []) {
        const resolved = byEdge.get(edge);
        if (resolved === undefined || found.has(resolved.toNode)) continue;
        found.add(resolved.toNode);
        queue.push(resolved.toNode);
      }
    }
    descendantCache.set(nodeId, found);
    return found;
  };

  const analysis: GraphAnalysis = {
    nodesById,
    incoming,
    outgoing,
    resolvedEdges,
    resolvedByEdgeId,
    sourceNodeId: (edge) => byEdge.get(edge)?.fromNode,
    targetNodeId: (edge) => byEdge.get(edge)?.toNode,
    sourceHandle: (edge) => byEdge.get(edge)?.fromHandle,
    targetHandle: (edge) => byEdge.get(edge)?.toHandle,
    gateBranches: (nodeId) => {
      const node = nodesById.get(nodeId);
      return node?.type === "gate" ? node.branches : [];
    },
    joinInputs: (nodeId) => {
      const node = nodesById.get(nodeId);
      if (node?.type !== "join") return [];
      return joinInputs.get(nodeId) ?? [...(node as JoinNode).inputs].sort();
    },
    ancestors,
    descendants,
  };

  return { analysis, issues };
}
