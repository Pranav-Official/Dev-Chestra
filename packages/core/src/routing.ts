import type { LoopOutcome, NodeKind } from "./events.js";
import { loopTerminalOutcome } from "./reducer-types.js";
import type { ExecStatus } from "./transitions.js";

/** Derived edge state from spec 12.4. Edges are never stored. */
export type RoutingEdgeState = "pending" | "active" | "dead";

export interface RoutingGraphEdge {
  id: string;
  /** Full endpoint (`gateId.branchId`) or a plain node id with sourceHandle. */
  from: string;
  /** Full endpoint (`joinId.inputName`) or a plain node id with targetHandle. */
  to: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface RoutingGraphNode {
  id: string;
  type: NodeKind | string;
  branches?: readonly { id: string }[];
  mode?: "first" | "all" | string;
  inputs?: readonly string[];
}

export interface RoutingGraph {
  nodes: readonly RoutingGraphNode[];
  edges: readonly RoutingGraphEdge[];
}

export interface RoutingExecutionState {
  status: ExecStatus | string;
  kind?: string | null;
  gateDecision?: { branch: string | null } | null;
  joinResolution?: unknown;
  // requestId is intentionally unused by routing (only `decision` matters)
  // but must accept null: ExecView carries null for legacy decisions, and
  // callers pass run views straight in without mapping.
  approvalDecision?: { decision: "approve" | "reject"; requestId?: string | null } | null;
  decision?: { routing: { branch: string | null } } | null;
  /**
   * Durable loop controller (ExecView.loop passes straight in). A succeeded
   * loop with no controller or no terminal round is a legacy success.
   */
  loop?: {
    rounds: readonly { done: boolean; outcome?: LoopOutcome | null }[];
  } | null;
}

/** Source handle of a loop's iteration-budget-exhausted output. */
export const LOOP_EXHAUSTED_HANDLE = "exhausted";

export interface RoutingView {
  /** Keyed by edge id. */
  edges: Record<string, RoutingEdgeState>;
  /** Dispatchable nodes (missing/pending/ready, or resumable interrupted). */
  ready: string[];
  /** Unstarted nodes whose inbound edges are all settled and none is active. */
  skipped: string[];
  /** `join` mode `first` nodes with more than one active inbound edge. */
  conflicts: string[];
}

const PENDING_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "ready",
  "running",
  "validating",
  "waiting_approval",
  "waiting_quota",
  "interrupted",
]);
const DEAD_STATUSES: ReadonlySet<string> = new Set(["skipped", "cancelled", "failed", "rejected"]);
const UNSTARTED_STATUSES: ReadonlySet<string> = new Set(["pending", "ready"]);
const DISPATCHABLE_STATUSES: ReadonlySet<string> = new Set(["pending", "ready", "interrupted"]);

function endpoint(
  value: string,
  explicit: string | null | undefined,
): { nodeId: string; handle: string | null } {
  if (explicit !== undefined && explicit !== null) return { nodeId: value, handle: explicit };
  const dot = value.indexOf(".");
  return dot < 0
    ? { nodeId: value, handle: null }
    : { nodeId: value.slice(0, dot), handle: value.slice(dot + 1) };
}

function edgeState(
  edge: RoutingGraphEdge,
  nodes: ReadonlyMap<string, RoutingGraphNode>,
  executions: Readonly<Record<string, RoutingExecutionState>>,
): RoutingEdgeState {
  const source = endpoint(edge.from, edge.sourceHandle);
  const node = nodes.get(source.nodeId);
  const execution = executions[source.nodeId];
  const status = execution?.status ?? "pending";
  if (PENDING_STATUSES.has(status)) return "pending";
  // Approval rejected without .rejected edge is terminal rejected, all outgoing dead.
  // Approval rejected with .rejected edge is succeeded with decision reject, selective.
  if (DEAD_STATUSES.has(status)) return "dead";
  if (status !== "succeeded") return "pending";
  if (node?.type === "gate") {
    const chosen = execution?.gateDecision?.branch ?? null;
    return chosen !== null && source.handle === chosen ? "active" : "dead";
  }
  if (node?.type === "decision") {
    const chosen = execution?.decision?.routing.branch ?? null;
    return chosen !== null && source.handle === chosen ? "active" : "dead";
  }
  if (node?.type === "loop") {
    // Plain endpoint = condition met (and every legacy loop); `.exhausted`
    // activates only when the durable terminal round hit the iteration limit.
    const exhausted = loopTerminalOutcome(execution?.loop) === "iteration_limit";
    return (source.handle === LOOP_EXHAUSTED_HANDLE) === exhausted ? "active" : "dead";
  }
  if (node?.type === "approval") {
    const decision = execution?.approvalDecision?.decision;
    if (decision !== "approve" && decision !== "reject") return "dead";
    const isRejected = decision === "reject";
    if (source.handle === "rejected") return isRejected ? "active" : "dead";
    return isRejected ? "dead" : "active";
  }
  return "active";
}

/**
 * Pure, browser-safe routing derivation for the engine and viewer. It accepts
 * the workflow graph snapshot and the durable execution projection; it does not
 * import `@devchestra/schema`, write state, or run expressions.
 */
export function deriveRouting(
  graph: RoutingGraph,
  executions: Readonly<Record<string, RoutingExecutionState>>,
): RoutingView {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges: Record<string, RoutingEdgeState> = {};
  const inbound = new Map<string, RoutingGraphEdge[]>();
  for (const edge of graph.edges) {
    edges[edge.id] = edgeState(edge, nodes, executions);
    const target = endpoint(edge.to, edge.targetHandle).nodeId;
    const list = inbound.get(target);
    if (list === undefined) inbound.set(target, [edge]);
    else list.push(edge);
  }

  const ready: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  for (const node of graph.nodes) {
    const execution = executions[node.id];
    const status = execution?.status ?? "pending";
    if (status === "succeeded" || DEAD_STATUSES.has(status)) continue;
    const inboundEdges = inbound.get(node.id) ?? [];
    if (inboundEdges.length === 0) {
      if (node.type === "start" && DISPATCHABLE_STATUSES.has(status)) ready.push(node.id);
      continue;
    }
    const states = inboundEdges.map((edge) => edges[edge.id] ?? "pending");
    if (states.some((state) => state === "pending")) continue;
    const active = states.filter((state) => state === "active").length;
    if (active === 0) {
      if (UNSTARTED_STATUSES.has(status)) skipped.push(node.id);
      continue;
    }
    if (node.type === "join" && node.mode === "first" && active > 1) {
      conflicts.push(node.id);
      continue;
    }
    if (DISPATCHABLE_STATUSES.has(status)) ready.push(node.id);
  }

  return { edges, ready, skipped, conflicts };
}
