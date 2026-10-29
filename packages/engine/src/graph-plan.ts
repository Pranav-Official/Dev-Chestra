import { DevChestraError, err, isRecord, ok, type Result } from "@devchestra/core";
import {
  analyzeGraph,
  type GateBranch,
  validateLoopNode,
  validateWorkflow,
} from "@devchestra/schema";
import { type LinearNodeKind, validateBaseNodeConfig } from "./sequence.js";

export type PlanNodeKind = LinearNodeKind | "gate" | "join" | "approval" | "decision" | "loop";

export interface PlanNode {
  readonly id: string;
  readonly type: PlanNodeKind;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface PlanEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly sourceBranch?: string;
  readonly targetInput?: string;
}

export interface WorkflowPlan {
  /** A body plan uses execution paths as ids while retaining local ids in raw. */
  readonly scope?: Readonly<Record<string, unknown>>;
  readonly body?: boolean;
  readonly nodes: readonly PlanNode[];
  readonly edges: readonly PlanEdge[];
  readonly start: PlanNode;
  readonly ends: readonly PlanNode[];
  readonly byId: ReadonlyMap<string, PlanNode>;
  readonly incoming: ReadonlyMap<string, readonly PlanEdge[]>;
  readonly outgoing: ReadonlyMap<string, readonly PlanEdge[]>;
  readonly gateBranches: ReadonlyMap<string, readonly GateBranch[]>;
  readonly joinInputs: ReadonlyMap<string, readonly string[]>;
  ancestorsOf(nodeId: string): ReadonlySet<string>;
}

export type ScopeSource = WorkflowPlan;

const BASE_TYPES = new Set<string>(["start", "agent", "shell", "end", "approval", "decision"]);
const NODE_ID_RE = /^[a-z][a-z0-9_-]{0,47}$/;

function invalid(message: string, details?: unknown): DevChestraError {
  return new DevChestraError(
    "E_WORKFLOW_INVALID",
    message,
    details === undefined ? {} : { details },
  );
}

function gateBranches(raw: Record<string, unknown>): GateBranch[] {
  const list = Array.isArray(raw.branches) ? raw.branches : [];
  return list.flatMap((entry): GateBranch[] => {
    if (!isRecord(entry) || typeof entry.id !== "string") return [];
    return [
      {
        id: entry.id,
        ...(typeof entry.when === "string" ? { when: entry.when } : {}),
        ...(entry.otherwise === true ? { otherwise: true } : {}),
      },
    ];
  });
}

function joinConfig(raw: Record<string, unknown>): { mode: "first" | "all"; inputs: string[] } {
  return {
    mode: raw.mode === "all" ? "all" : "first",
    inputs: Array.isArray(raw.inputs)
      ? raw.inputs.filter((input): input is string => typeof input === "string")
      : [],
  };
}

function readPlanNode(value: unknown, index: number): PlanNode {
  if (!isRecord(value)) throw invalid(`Node ${index} must be an object`);
  const id = value.id;
  const type = value.type;
  if (typeof id !== "string" || !NODE_ID_RE.test(id)) {
    throw invalid("Node id is missing or invalid", { id, index });
  }
  if (
    typeof type !== "string" ||
    (!BASE_TYPES.has(type) && type !== "gate" && type !== "join" && type !== "loop")
  ) {
    throw new DevChestraError(
      "E_WORKFLOW_INVALID",
      `Node type '${String(type)}' is not supported in this increment`,
      { details: { nodeId: id, type } },
    );
  }
  if (BASE_TYPES.has(type)) {
    if (type !== "approval" && type !== "decision") {
      validateBaseNodeConfig(value, type as LinearNodeKind);
    }
  }
  if (type === "gate") gateBranches(value);
  if (type === "join") joinConfig(value);
  return { id, type: type as PlanNodeKind, raw: Object.freeze({ ...value }) };
}

interface ResolvedEndpoints {
  readonly edges: PlanEdge[];
  readonly incoming: Map<string, PlanEdge[]>;
  readonly outgoing: Map<string, PlanEdge[]>;
}

function resolveEndpoints(
  rawEdges: readonly unknown[],
  byId: ReadonlyMap<string, PlanNode>,
  gates: ReadonlyMap<string, readonly GateBranch[]>,
  joins: ReadonlyMap<string, readonly string[]>,
): ResolvedEndpoints {
  const edges: PlanEdge[] = [];
  const incoming = new Map<string, PlanEdge[]>();
  const outgoing = new Map<string, PlanEdge[]>();
  const ids = new Set<string>();

  rawEdges.forEach((value, index) => {
    if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string") {
      throw invalid(`Edge ${index} must have string from/to`);
    }
    const fallback = `edge-${index}`;
    const id = typeof value.id === "string" && value.id !== "" ? value.id : fallback;
    if (ids.has(id)) throw invalid(`Duplicate edge id '${id}'`);
    ids.add(id);

    const fromParts = splitEndpoint(value.from, "from", index);
    const toParts = splitEndpoint(value.to, "to", index);
    const source = byId.get(fromParts.node);
    const target = byId.get(toParts.node);
    if (source === undefined) throw invalid(`Edge source '${fromParts.node}' does not exist`);
    if (target === undefined) throw invalid(`Edge target '${toParts.node}' does not exist`);

    if (source.type === "gate") {
      if (fromParts.handle === undefined) {
        throw invalid(`Edge from gate '${source.id}' must use 'gateId.branchId'`);
      }
      const branch = gates.get(source.id)?.find((entry) => entry.id === fromParts.handle);
      if (branch === undefined) {
        throw invalid(`Edge source branch '${source.id}.${fromParts.handle}' does not exist`);
      }
    } else if (source.type === "approval") {
      if (fromParts.handle !== undefined && fromParts.handle !== "rejected") {
        throw invalid(
          `Edge from approval '${source.id}' must be '${source.id}' or '${source.id}.rejected'`,
        );
      }
    } else if (source.type === "decision") {
      if (fromParts.handle === undefined) {
        throw invalid(`Edge from decision '${source.id}' must use 'decisionId.handleId'`);
      }
    } else if (fromParts.handle !== undefined) {
      throw invalid(
        `Edge source '${value.from}' uses a handle on a non-gate/non-approval/non-decision node`,
      );
    }
    if (target.type === "join") {
      if (toParts.handle === undefined) {
        throw invalid(`Edge to join '${target.id}' must use 'joinId.inputName'`);
      }
      if (!(joins.get(target.id) ?? []).includes(toParts.handle)) {
        throw invalid(`Edge target input '${target.id}.${toParts.handle}' does not exist`);
      }
    } else if (toParts.handle !== undefined) {
      throw invalid(`Edge target '${value.to}' uses an input handle on a non-join node`);
    }

    const edge: PlanEdge = {
      id,
      from: source.id,
      to: target.id,
      ...(fromParts.handle === undefined ? {} : { sourceBranch: fromParts.handle }),
      ...(toParts.handle === undefined ? {} : { targetInput: toParts.handle }),
    };
    edges.push(edge);
    push(incoming, edge.to, edge);
    push(outgoing, edge.from, edge);
  });
  return { edges, incoming, outgoing };
}

function splitEndpoint(
  endpoint: string,
  side: "from" | "to",
  index: number,
): { node: string; handle?: string } {
  if (endpoint.startsWith("$")) {
    throw invalid("Top-level routing graphs cannot use $entry or $exit endpoints", {
      side,
      index,
    });
  }
  const dot = endpoint.indexOf(".");
  if (dot === -1) return { node: endpoint };
  const node = endpoint.slice(0, dot);
  const handle = endpoint.slice(dot + 1);
  if (node === "" || handle === "" || handle.includes(".")) {
    throw invalid(`Edge ${side} endpoint '${endpoint}' is malformed`);
  }
  return { node, handle };
}

function push(map: Map<string, PlanEdge[]>, key: string, edge: PlanEdge): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [edge]);
  else list.push(edge);
}

function canonicalStructure(graph: Record<string, unknown>, nodes: readonly unknown[]): void {
  const edges = (graph.edges as unknown[]).map((value, index) =>
    isRecord(value)
      ? {
          ...value,
          id: typeof value.id === "string" && value.id !== "" ? value.id : `edge-${index}`,
        }
      : value,
  );
  const issue = analyzeGraph({ nodes, edges } as never).issues.find(
    (entry) => entry.severity === "error",
  );
  if (issue !== undefined) {
    throw invalid(`${issue.code}: ${issue.message}`, {
      ...(issue.pointer === undefined ? {} : { pointer: issue.pointer }),
      ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
    });
  }
}

/** Reuse the canonical R17 checker without adopting schema's other launch policies. */
function canonicalJoinOutput(snapshot: unknown): void {
  if (!isRecord(snapshot) || !isRecord(snapshot.graph)) return;
  try {
    const report = validateWorkflow({
      schemaVersion: 1,
      id: typeof snapshot.id === "string" ? snapshot.id : "workflow",
      name: typeof snapshot.name === "string" ? snapshot.name : "Workflow",
      graph: snapshot.graph,
    } as never);
    const issue = report.errors.find((entry) => entry.code === "E_JOIN_OUTPUT");
    if (issue !== undefined) {
      throw invalid(issue.message, {
        ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
      });
    }
  } catch (error) {
    if (error instanceof DevChestraError) throw error;
  }
}

/**
 * Validate and freeze a top-level routing graph. The plan is the only source of
 * edge/readiness logic; callers never trust a mutable in-memory queue.
 */
export function analyzeWorkflowPlan(snapshot: unknown): Result<WorkflowPlan, DevChestraError> {
  try {
    if (!isRecord(snapshot) || !isRecord(snapshot.graph)) {
      throw invalid("Workflow snapshot must contain a graph object");
    }
    const graph = snapshot.graph;
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      throw invalid("Workflow graph must contain at least one node");
    }
    if (!Array.isArray(graph.edges)) throw invalid("Workflow graph must contain an edges array");
    const nodes = graph.nodes.map(readPlanNode);
    const byId = new Map<string, PlanNode>();
    for (const node of nodes) {
      if (byId.has(node.id)) throw invalid(`Duplicate node id '${node.id}'`, { nodeId: node.id });
      byId.set(node.id, node);
    }
    const starts = nodes.filter((node) => node.type === "start");
    const ends = nodes.filter((node) => node.type === "end");
    if (starts.length !== 1) throw invalid("Workflow must have exactly one start node");
    if (ends.length === 0) throw invalid("Workflow must have at least one end node");
    const start = starts[0] as PlanNode;
    const gates = new Map<string, readonly GateBranch[]>();
    const joins = new Map<string, readonly string[]>();
    for (const node of nodes) {
      if (node.type === "gate") gates.set(node.id, gateBranches(node.raw as never));
      if (node.type === "join") joins.set(node.id, joinConfig(node.raw).inputs);
    }
    canonicalStructure(
      graph,
      nodes.map((node) => node.raw),
    );
    canonicalJoinOutput(snapshot);
    const resolved = resolveEndpoints(graph.edges, byId, gates, joins);

    const cache = new Map<string, Set<string>>();
    const ancestorsOf = (nodeId: string): ReadonlySet<string> => {
      const cached = cache.get(nodeId);
      if (cached !== undefined) return cached;
      const found = new Set<string>();
      const queue = [nodeId];
      while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined) continue;
        for (const edge of resolved.incoming.get(id) ?? []) {
          if (found.has(edge.from)) continue;
          found.add(edge.from);
          queue.push(edge.from);
        }
      }
      cache.set(nodeId, found);
      return found;
    };

    for (const node of nodes) {
      if (node.type !== "loop") continue;
      const issue = validateLoopNode(node.raw, {
        parentAllowed: new Set(["start", ...ancestorsOf(node.id)]),
      }).find((issue) => issue.severity === "error");
      if (issue) throw invalid(issue.message, { nodeId: node.id, pointer: issue.pointer });
    }

    return ok({
      nodes,
      edges: resolved.edges,
      start,
      ends,
      byId,
      incoming: resolved.incoming,
      outgoing: resolved.outgoing,
      gateBranches: gates,
      joinInputs: joins,
      ancestorsOf,
    });
  } catch (error) {
    if (error instanceof DevChestraError) return err(error);
    throw error;
  }
}
