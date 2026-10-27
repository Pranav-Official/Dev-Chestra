import type { Edge, GateNode, JoinNode, WorkflowFile, WorkflowNode } from "@relay/schema";
import { HANDLE_ID_PATTERN } from "@relay/schema";
import type { ConnectRequest } from "./types.js";

export interface ParsedEndpoint {
  nodeId: string;
  /** Gate branch id or Join input name; null for a plain node endpoint. */
  handle: string | null;
}

export interface ConnectionCheck {
  ok: boolean;
  message?: string;
}

export { HANDLE_ID_PATTERN };

const SUPPORTED_TYPES: ReadonlySet<string> = new Set<string>([
  "start",
  "agent",
  "shell",
  "gate",
  "join",
  "approval",
  "end",
]);

export function parseEndpoint(endpoint: string): ParsedEndpoint {
  const dot = endpoint.indexOf(".");
  if (dot < 0) return { nodeId: endpoint, handle: null };
  return { nodeId: endpoint.slice(0, dot), handle: endpoint.slice(dot + 1) };
}

export function nextHandleId(base: string, used: readonly string[]): string {
  const taken = new Set(used);
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}${Date.now()}`;
}

export function addGateBranch(node: GateNode): GateNode {
  const id = nextHandleId(
    "branch",
    node.branches.map((branch) => branch.id),
  );
  const otherwise = node.branches.findIndex((branch) => branch.otherwise === true);
  const next = [...node.branches];
  next.splice(otherwise < 0 ? next.length : otherwise, 0, { id, when: "false" });
  return { ...node, branches: next };
}

export function updateGateBranch(
  node: GateNode,
  branchId: string,
  patch: { id?: string; when?: string },
): GateNode | null {
  let found = false;
  const branches = node.branches.map((branch) => {
    if (branch.id !== branchId) return branch;
    found = true;
    if (branch.otherwise === true) return branch;
    return {
      ...branch,
      ...(patch.id === undefined ? {} : { id: patch.id }),
      ...(patch.when === undefined ? {} : { when: patch.when }),
    };
  });
  return found ? { ...node, branches } : null;
}

/** Move a non-otherwise branch within the when-branches, keeping otherwise last. */
export function moveGateBranch(
  node: GateNode,
  branchId: string,
  direction: "up" | "down",
): GateNode | null {
  const index = node.branches.findIndex((branch) => branch.id === branchId);
  const branch = node.branches[index];
  if (branch === undefined || branch.otherwise === true) return null;
  const lastMovable = node.branches.findIndex((candidate) => candidate.otherwise === true);
  const limit = lastMovable < 0 ? node.branches.length : lastMovable;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= limit) return null;
  const branches = [...node.branches];
  const [moved] = branches.splice(index, 1);
  if (moved === undefined) return null;
  branches.splice(target, 0, moved);
  return { ...node, branches };
}

/** Remove a when-branch. `otherwise` is permanent so a gate always has a fallback. */
export function removeGateBranch(node: GateNode, branchId: string): GateNode | null {
  const branch = node.branches.find((candidate) => candidate.id === branchId);
  if (branch === undefined || branch.otherwise === true) return null;
  return { ...node, branches: node.branches.filter((candidate) => candidate.id !== branchId) };
}

export function addJoinInput(node: JoinNode): JoinNode {
  const name = nextHandleId("input", node.inputs);
  return { ...node, inputs: [...node.inputs, name] };
}

export function renameJoinInput(node: JoinNode, from: string, to: string): JoinNode | null {
  if (!node.inputs.includes(from) || node.inputs.includes(to)) return null;
  return { ...node, inputs: node.inputs.map((name) => (name === from ? to : name)) };
}

export function removeJoinInput(node: JoinNode, name: string): JoinNode | null {
  if (!node.inputs.includes(name)) return null;
  return { ...node, inputs: node.inputs.filter((input) => input !== name) };
}

/**
 * Reject a node patch that would orphan a connected handle. Deletion callers
 * must pass the matching edge ids in the same command so the document stays valid.
 */
export function danglingHandleProblem(
  before: WorkflowNode,
  after: WorkflowNode,
  edges: readonly Edge[],
): string | null {
  if (before.type !== after.type) return "A routing node cannot change its type.";
  if (before.type === "gate" && after.type === "gate") {
    const next = new Set(after.branches.map((branch) => branch.id));
    for (const branch of before.branches) {
      if (next.has(branch.id)) continue;
      const endpoint = `${before.id}.${branch.id}`;
      if (edges.some((edge) => edge.from === endpoint || edge.to === endpoint)) {
        return `Branch '${branch.id}' is connected. Remove its connection in the same edit.`;
      }
    }
  }
  if (before.type === "join" && after.type === "join") {
    const next = new Set(after.inputs);
    for (const input of before.inputs) {
      if (next.has(input)) continue;
      const endpoint = `${before.id}.${input}`;
      if (edges.some((edge) => edge.to === endpoint || edge.from === endpoint)) {
        return `Join input '${input}' is connected. Remove its connection in the same edit.`;
      }
    }
  }
  return null;
}

export function edgesFromGateBranch(file: WorkflowFile, nodeId: string, branchId: string): Edge[] {
  const endpoint = `${nodeId}.${branchId}`;
  return file.graph.edges.filter((edge) => edge.from === endpoint);
}

export function edgesIntoJoinInput(file: WorkflowFile, nodeId: string, inputName: string): Edge[] {
  const endpoint = `${nodeId}.${inputName}`;
  return file.graph.edges.filter((edge) => edge.to === endpoint);
}

function hasPath(file: WorkflowFile, from: string, target: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of file.graph.edges) {
    const source = parseEndpoint(edge.from).nodeId;
    const destination = parseEndpoint(edge.to).nodeId;
    const list = outgoing.get(source);
    if (list === undefined) outgoing.set(source, [destination]);
    else list.push(destination);
  }
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    if (id === target) return true;
    seen.add(id);
    for (const next of outgoing.get(id) ?? []) queue.push(next);
  }
  return false;
}

/**
 * Editor-side preflight for R4/R9/R10 and local cycles. The schema validator is
 * authoritative; this runs before mutating the document so the canvas can toast.
 */
export function checkConnection(file: WorkflowFile, request: ConnectRequest): ConnectionCheck {
  const sourceEndpoint = parseEndpoint(request.source);
  const targetEndpoint = parseEndpoint(request.target);
  const source = file.graph.nodes.find((node) => node.id === sourceEndpoint.nodeId);
  const target = file.graph.nodes.find((node) => node.id === targetEndpoint.nodeId);
  if (source === undefined || target === undefined) {
    return { ok: false, message: "Both nodes must exist before they can be connected." };
  }
  if (!SUPPORTED_TYPES.has(source.type) || !SUPPORTED_TYPES.has(target.type)) {
    return {
      ok: false,
      message:
        "This editor can only connect Start, Agent, Shell, Gate, Join, Approval and End nodes.",
    };
  }
  if (source.id === target.id) {
    return { ok: false, message: "A node cannot connect to itself." };
  }
  if (source.type === "end") {
    return { ok: false, message: "An End node cannot have an outgoing connection." };
  }
  if (target.type === "start") {
    return { ok: false, message: "A Start node cannot have an incoming connection." };
  }

  let from = source.id;
  if (source.type === "gate") {
    if (
      sourceEndpoint.handle === null ||
      !(source as GateNode).branches.some((branch) => branch.id === sourceEndpoint.handle)
    ) {
      return {
        ok: false,
        message: "Pick a Gate branch handle before connecting from a gate.",
      };
    }
    from = `${source.id}.${sourceEndpoint.handle}`;
  } else if (source.type === "approval") {
    if (sourceEndpoint.handle !== null && sourceEndpoint.handle !== "rejected") {
      return { ok: false, message: "Approval has only approved (plain) and rejected handles." };
    }
    from = sourceEndpoint.handle === "rejected" ? `${source.id}.rejected` : source.id;
  } else if (sourceEndpoint.handle !== null && sourceEndpoint.handle !== "out") {
    return { ok: false, message: "That node has no such output handle." };
  }

  let to = target.id;
  if (target.type === "join") {
    if (targetEndpoint.handle === null || !target.inputs.includes(targetEndpoint.handle)) {
      return {
        ok: false,
        message: "Pick a Join input handle before connecting into a join.",
      };
    }
    to = `${target.id}.${targetEndpoint.handle}`;
  } else if (targetEndpoint.handle !== null && targetEndpoint.handle !== "in") {
    return { ok: false, message: "That node has no such input handle." };
  }

  if (file.graph.edges.some((edge) => edge.from === from && edge.to === to)) {
    return { ok: false, message: "That connection already exists." };
  }

  const incoming = file.graph.edges.filter((edge) => parseEndpoint(edge.to).nodeId === target.id);
  if (target.type === "join") {
    if (incoming.some((edge) => edge.to === to)) {
      return {
        ok: false,
        message: `The Join input '${targetEndpoint.handle}' already has a connection.`,
      };
    }
  } else if (incoming.length > 0) {
    return {
      ok: false,
      message:
        "That input already has a connection. Use a Join node to merge branches instead of adding a second inbound edge.",
    };
  }

  if (hasPath(file, target.id, source.id)) {
    return { ok: false, message: "That connection would create a cycle." };
  }
  return { ok: true };
}
