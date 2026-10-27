import type { Edge, NodeType, WorkflowFile, WorkflowNode } from "@relay/schema";
import { checkConnection as checkRoutingConnection } from "./routing.js";
import type { ConnectRequest, Position } from "./types.js";

export const SUPPORTED_NODE_TYPES: readonly string[] = [
  "start",
  "agent",
  "shell",
  "gate",
  "join",
  "approval",
  "end",
] as const;

export type { ConnectionCheck } from "./routing.js";

export function isSupportedNodeType(type: string): boolean {
  return (SUPPORTED_NODE_TYPES as readonly string[]).includes(type);
}

export function snap(value: number): number {
  return Math.round(value / 8) * 8;
}

export function snapPosition(position: Position): Position {
  return { x: snap(position.x), y: snap(position.y) };
}

export function nodeIdOfEndpoint(endpoint: string): string {
  return endpoint.split(".")[0] ?? endpoint;
}

export function positionOf(node: WorkflowNode): Position {
  const x = node.ui?.x;
  const y = node.ui?.y;
  return {
    x: typeof x === "number" && Number.isFinite(x) ? x : 0,
    y: typeof y === "number" && Number.isFinite(y) ? y : 0,
  };
}

export function withPosition(
  ui: Record<string, unknown> | undefined,
  position: Position,
): Record<string, unknown> {
  return { ...(ui ?? {}), x: position.x, y: position.y };
}

export function createNodeId(type: string, nodes: readonly WorkflowNode[]): string {
  const used = new Set(nodes.map((node) => node.id));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? type : `${type}${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${type}${Date.now()}`;
}

/** Must match the schema's EDGE_ID_PATTERN maximum (`[A-Za-z0-9._:-]{0,127}`). */
export const MAX_EDGE_ID_LENGTH = 128;

function withSuffix(base: string, suffix: string): string {
  const room = Math.max(1, MAX_EDGE_ID_LENGTH - suffix.length);
  return `${base.slice(0, room)}${suffix}`;
}

export function createEdgeId(source: string, target: string, edges: readonly Edge[]): string {
  const base = `e-${source}-${target}`
    .replace(/[^A-Za-z0-9._:-]/g, "_")
    .slice(0, MAX_EDGE_ID_LENGTH);
  const used = new Set(edges.map((edge) => edge.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = withSuffix(base, `-${index}`);
    if (!used.has(candidate)) return candidate;
  }
  return withSuffix(base, `-${Date.now()}`);
}

/** Palette helper: four small columns so a click-added node is visible immediately. */
export function nextAddPosition(nodes: readonly WorkflowNode[]): Position {
  const index = nodes.length;
  return { x: 32 + (index % 4) * 208, y: 32 + Math.floor(index / 4) * 120 };
}

function defaultAgentOutput(): Record<string, unknown> {
  return { type: "object", additionalProperties: true };
}

export function createDefaultNode(
  type: string,
  nodes: readonly WorkflowNode[],
  position?: Position,
): WorkflowNode {
  const id = createNodeId(type, nodes);
  const suffix = id.slice(type.length);
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  const name = suffix === "" ? label : `${label} ${suffix}`;
  const at = snapPosition(position ?? nextAddPosition(nodes));
  const ui = { x: at.x, y: at.y };
  switch (type) {
    case "start":
      return { id, type: "start", name, params: [], ui } as unknown as WorkflowNode;
    case "agent":
      return {
        id,
        type: "agent",
        name,
        cli: "fake",
        prompt: "Describe the work for this step. Return the result as a JSON object.",
        output: defaultAgentOutput(),
        permissions: { network: false, write: ["workspace"] },
        limits: { timeoutMin: 10, validationRetries: 1, crashRetries: 0 },
        context: { project: "none", workflow: "none" },
        ui,
      } as unknown as WorkflowNode;
    case "shell":
      return {
        id,
        type: "shell",
        name,
        command: "printf '%s\\n' \"hello\"",
        timeoutMin: 2,
        allowFailure: false,
        ui,
      } as unknown as WorkflowNode;
    case "gate":
      return {
        id,
        type: "gate",
        name,
        branches: [
          { id: "branch", when: "true" },
          { id: "otherwise", otherwise: true },
        ],
        ui,
      } as unknown as WorkflowNode;
    case "join":
      return {
        id,
        type: "join",
        name,
        mode: "all",
        inputs: ["input"],
        ui,
      } as unknown as WorkflowNode;
    case "approval":
      return {
        id,
        type: "approval",
        name,
        message: "Please review and approve to continue.",
        irreversible: false,
        ui,
      } as unknown as WorkflowNode;
    case "end":
      return {
        id,
        type: "end",
        name,
        status: "success",
        result: "{}",
        ui,
      } as unknown as WorkflowNode;
    default:
      return { id, type: type as NodeType, name, ui } as unknown as WorkflowNode;
  }
}

export function checkConnection(file: WorkflowFile, request: ConnectRequest) {
  return checkRoutingConnection(file, request);
}

/** Nodes with a directed path to `nodeId`, in graph order. */
export function ancestorNodes(file: WorkflowFile, nodeId: string): WorkflowNode[] {
  const incoming = new Map<string, string[]>();
  for (const edge of file.graph.edges) {
    const source = nodeIdOfEndpoint(edge.from);
    const target = nodeIdOfEndpoint(edge.to);
    const list = incoming.get(target);
    if (list === undefined) incoming.set(target, [source]);
    else list.push(source);
  }
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) continue;
    for (const source of incoming.get(id) ?? []) {
      if (seen.has(source)) continue;
      seen.add(source);
      queue.push(source);
    }
  }
  return file.graph.nodes.filter((node) => seen.has(node.id));
}
