import { err, isRecord, ok, RelayError, type Result } from "@relay/core";

export type LinearNodeKind = "start" | "agent" | "shell" | "end";

export interface LinearNode {
  readonly id: string;
  readonly type: LinearNodeKind;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface LinearChain {
  readonly nodes: readonly LinearNode[];
  readonly start: LinearNode & { type: "start" };
  readonly end: LinearNode & { type: "end" };
}

export interface RunOptionInput {
  readonly snapshot: unknown;
  readonly budgets?: unknown;
  readonly baseSha?: unknown;
  readonly kind?: unknown;
}

const NODE_ID_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const SUPPORTED_TYPES = new Set<string>(["start", "agent", "shell", "end"]);

function invalid(message: string, details?: unknown): RelayError {
  return new RelayError("E_WORKFLOW_INVALID", message, details === undefined ? {} : { details });
}

function readNodes(snapshot: unknown): Record<string, unknown>[] {
  if (!isRecord(snapshot) || !isRecord(snapshot.graph)) {
    throw invalid("Workflow snapshot must contain a graph object");
  }
  const nodes = snapshot.graph.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw invalid("Workflow graph must contain at least one node");
  }
  return nodes.map((node, index) => {
    if (!isRecord(node)) throw invalid(`Node ${index} must be an object`);
    return node;
  });
}

function readEdges(snapshot: unknown): { from: string; to: string }[] {
  if (!isRecord(snapshot) || !isRecord(snapshot.graph)) {
    throw invalid("Workflow snapshot must contain a graph object");
  }
  const edges = snapshot.graph.edges;
  if (!Array.isArray(edges)) throw invalid("Workflow graph must contain an edges array");
  return edges.map((edge, index) => {
    if (!isRecord(edge) || typeof edge.from !== "string" || typeof edge.to !== "string") {
      throw invalid(`Edge ${index} must have string from/to`);
    }
    if (edge.from.includes(".") || edge.to.includes(".")) {
      throw invalid("P1 supports plain node-to-node edges only", { edge });
    }
    if (edge.from === "$entry" || edge.to === "$exit") {
      throw invalid("P1 supports the top-level graph only; body edges are not supported", {
        edge,
      });
    }
    return { from: edge.from, to: edge.to };
  });
}

/** Shared config validation for the node types the engine can execute. */
export function validateBaseNodeConfig(node: Record<string, unknown>, kind: LinearNodeKind): void {
  if (kind === "start") validateStart(node);
  if (kind === "agent") validateAgent(node);
  if (kind === "shell") validateShell(node);
  if (kind === "end") validateEnd(node);
}

function validateNode(node: Record<string, unknown>): LinearNode {
  const id = node.id;
  const type = node.type;
  if (typeof id !== "string" || !NODE_ID_RE.test(id)) {
    throw invalid("Node id is missing or invalid", { id, node });
  }
  if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
    throw new RelayError(
      "E_WORKFLOW_INVALID",
      `Node type '${String(type)}' is not supported in the P1 linear runner`,
      { details: { nodeId: id, type } },
    );
  }
  const kind = type as LinearNodeKind;
  validateBaseNodeConfig(node, kind);
  return { id, type: kind, raw: Object.freeze({ ...node }) };
}

function validateStart(node: Record<string, unknown>): void {
  if (!Array.isArray(node.params)) throw invalid("Start node params must be an array", node);
  for (const [index, param] of node.params.entries()) {
    if (!isRecord(param) || typeof param.name !== "string" || param.name === "") {
      throw invalid(`Start parameter ${index} must have a name`, param);
    }
    if (
      param.type !== "string" &&
      param.type !== "number" &&
      param.type !== "boolean" &&
      param.type !== "enum"
    ) {
      throw invalid(`Start parameter ${param.name} has an unsupported type`, param);
    }
    if (typeof param.required !== "boolean") {
      throw invalid(`Start parameter ${param.name} must declare required`, param);
    }
    if (param.type === "enum" && !Array.isArray(param.options)) {
      throw invalid(`Enum parameter ${param.name} must declare options`, param);
    }
  }
}

function validateWorkspace(node: Record<string, unknown>, nodeType: string): void {
  const workspace = node.workspace;
  // Legacy node workspace is optional; run-level selection drives fresh runs.
  if (workspace === undefined) return;
  if (isRecord(workspace) && workspace.mode === "scratch") return;
  // Legacy metadata for old documents; fresh runs use the run-level choice.
  if (isRecord(workspace) && workspace.mode === "project") return;
  if (isRecord(workspace) && workspace.mode === "worktree") {
    for (const key of ["base", "setup", "from"] as const) {
      if (workspace[key] !== undefined) {
        throw new RelayError(
          "E_WORKFLOW_INVALID",
          `worktree.${key} is not supported; worktrees start from the project HEAD`,
          { details: { nodeId: node.id, workspace } },
        );
      }
    }
    return;
  }
  throw new RelayError(
    "E_WORKFLOW_INVALID",
    `P1 supports scratch or worktree workspaces only (${nodeType} node)`,
    { details: { nodeId: node.id, workspace } },
  );
}

function validateAgent(node: Record<string, unknown>): void {
  if (typeof node.cli !== "string" || node.cli === "") {
    throw invalid("Agent node must declare a cli", node);
  }
  if (typeof node.prompt !== "string") {
    throw invalid("Agent node prompt must be inlined during normalization", node);
  }
  if (node.promptFile !== undefined) {
    throw invalid("Agent promptFile must be inlined during normalization", node);
  }
  if (!isRecord(node.output) || node.output.type !== "object") {
    throw invalid("Agent node output must be an object schema", node);
  }
  if (containsArtifact(node.output)) {
    throw new RelayError(
      "E_WORKFLOW_INVALID",
      "Artifact outputs are not supported in the P1 linear runner",
      { details: { nodeId: node.id } },
    );
  }
  if (!isRecord(node.permissions)) {
    throw invalid("Agent node permissions are required", node);
  }
  const write = node.permissions.write;
  if (Array.isArray(write) && write.includes("project")) {
    throw new RelayError(
      "E_WORKFLOW_INVALID",
      "Project write access is not supported in the P1 linear runner",
      { details: { nodeId: node.id } },
    );
  }
  if (node.context !== undefined) {
    if (!isRecord(node.context)) throw invalid("Agent context must be an object", node);
    if (node.context.project !== undefined && node.context.project !== "none") {
      throw new RelayError(
        "E_WORKFLOW_INVALID",
        "Context banks are not supported in the P1 linear runner",
        { details: { nodeId: node.id, context: node.context } },
      );
    }
    if (node.context.workflow !== undefined && node.context.workflow !== "none") {
      throw new RelayError(
        "E_WORKFLOW_INVALID",
        "Context banks are not supported in the P1 linear runner",
        { details: { nodeId: node.id, context: node.context } },
      );
    }
  }
  validateWorkspace(node, "agent");
  validateLimits(node);
}

function validateShell(node: Record<string, unknown>): void {
  if (typeof node.command !== "string") throw invalid("Shell node command must be a string", node);
  validateWorkspace(node, "shell");
  if (typeof node.timeoutMin !== "number") throw invalid("Shell node timeoutMin is required", node);
}

function validateEnd(node: Record<string, unknown>): void {
  if (node.status !== "success" && node.status !== "failed" && node.status !== "rejected") {
    throw invalid("End node status must be success, failed or rejected", node);
  }
  if (typeof node.result !== "string")
    throw invalid("End node result expression is required", node);
}

function validateLimits(node: Record<string, unknown>): void {
  if (node.limits === undefined) return;
  if (!isRecord(node.limits)) throw invalid("Agent limits must be an object", node);
  for (const key of ["validationRetries", "crashRetries"] as const) {
    const value = node.limits[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw invalid(`Agent limits.${key} must be a non-negative integer`, node);
    }
  }
}

function containsArtifact(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsArtifact);
  if (!isRecord(value)) return false;
  if (value.format === "relay-artifact") return true;
  return Object.values(value).some(containsArtifact);
}

function validateChainShape(nodes: LinearNode[], edges: { from: string; to: string }[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const next = new Map<string, string>();
  const inbound = new Map<string, number>();
  for (const node of nodes) inbound.set(node.id, 0);
  for (const edge of edges) {
    if (!byId.has(edge.from)) throw invalid(`Edge source '${edge.from}' does not exist`, edge);
    if (!byId.has(edge.to)) throw invalid(`Edge target '${edge.to}' does not exist`, edge);
    if (next.has(edge.from)) {
      throw invalid("P1 supports a single linear chain; a node has more than one outgoing edge", {
        nodeId: edge.from,
      });
    }
    next.set(edge.from, edge.to);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }

  const starts = nodes.filter((node) => node.type === "start");
  const ends = nodes.filter((node) => node.type === "end");
  if (starts.length !== 1) throw invalid("Workflow must have exactly one start node");
  if (ends.length !== 1) throw invalid("Workflow must have exactly one end node");
  const start = starts[0];
  const end = ends[0];
  if (start === undefined || end === undefined) throw invalid("Missing start or end node");

  for (const node of nodes) {
    const out = next.has(node.id) ? 1 : 0;
    const inCount = inbound.get(node.id) ?? 0;
    if (node.id === start.id) {
      if (inCount !== 0) throw invalid("Start node cannot have an inbound edge");
      if (out !== 1) throw invalid("Start node must have exactly one outgoing edge");
    } else if (node.id === end.id) {
      if (inCount !== 1) throw invalid("End node must have exactly one inbound edge");
      if (out !== 0) throw invalid("End node cannot have an outgoing edge");
    } else if (inCount !== 1 || out !== 1) {
      throw invalid(
        "Every middle node in the P1 chain must have one inbound and one outbound edge",
        {
          nodeId: node.id,
          inbound: inCount,
          outbound: out,
        },
      );
    }
  }

  const seen = new Set<string>();
  let current: string | undefined = start.id;
  while (current !== undefined) {
    if (seen.has(current)) throw invalid("Workflow graph contains a cycle", { nodeId: current });
    seen.add(current);
    current = next.get(current);
  }
  if (seen.size !== nodes.length) {
    throw invalid("Workflow contains nodes that are not on the start-to-end chain", {
      unreachable: nodes.map((node) => node.id).filter((id) => !seen.has(id)),
    });
  }
}

export function analyzeLinearWorkflow(snapshot: unknown): Result<LinearChain, RelayError> {
  try {
    const nodes = readNodes(snapshot).map(validateNode);
    const edges = readEdges(snapshot);
    validateChainShape(nodes, edges);
    const start = nodes.find((node) => node.type === "start") as LinearNode & { type: "start" };
    const end = nodes.find((node) => node.type === "end") as LinearNode & { type: "end" };
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const next = new Map(edges.map((edge) => [edge.from, edge.to]));
    const ordered: LinearNode[] = [];
    let current: string | undefined = start.id;
    while (current !== undefined) {
      const node: LinearNode | undefined = byId.get(current);
      if (node === undefined) throw invalid(`Edge references missing node '${current}'`);
      ordered.push(node);
      current = next.get(current);
    }
    return ok({ nodes: ordered, start, end });
  } catch (error) {
    if (error instanceof RelayError) return err(error);
    throw error;
  }
}

export function validateRunOptions(input: RunOptionInput): Result<null, RelayError> {
  try {
    if (input.kind !== undefined && input.kind !== "run") {
      throw invalid("Only kind 'run' is supported in the P1 linear runner", { kind: input.kind });
    }
    if (input.baseSha !== undefined && input.baseSha !== null) {
      if (typeof input.baseSha !== "string" || input.baseSha === "") {
        throw invalid("baseSha must be a non-empty string when supplied");
      }
      throw invalid(
        "Worktree base selection is not supported; worktrees start from the project HEAD at first acquisition",
      );
    }
    if (input.budgets === undefined || input.budgets === null) return ok(null);
    if (!isRecord(input.budgets)) throw invalid("budgets must be an object");
    for (const key of Object.keys(input.budgets)) {
      throw invalid(`Budget '${key}' is not enforced in the P1 linear runner; remove it`);
    }
    return ok(null);
  } catch (error) {
    if (error instanceof RelayError) return err(error);
    throw error;
  }
}

export function nodeById(chain: LinearChain, id: string): LinearNode | undefined {
  return chain.nodes.find((node) => node.id === id);
}
