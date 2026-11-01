import { DevChestraError, err, hashJson, ok, type Result } from "@devchestra/core";
import { normalizeOutputSchema } from "./output-schema.js";
import type {
  AgentNode,
  ApprovalNode,
  ChildWorkflowNode,
  DecisionNode,
  EndNode,
  ForEachNode,
  GateNode,
  JoinNode,
  JsonSchemaObject,
  LoopNode,
  NormalizedAgentNode,
  NormalizedApprovalNode,
  NormalizedChildWorkflowNode,
  NormalizedDecisionNode,
  NormalizedEndNode,
  NormalizedForEachNode,
  NormalizedGateNode,
  NormalizedJoinNode,
  NormalizedLoopNode,
  NormalizedNode,
  NormalizedShellNode,
  NormalizedStartNode,
  NormalizedWorkflow,
  NormalizedWorkspaceSpec,
  NormalizeOptions,
  ShellNode,
  StartNode,
  StartWebhookConfig,
  WorkflowFile,
  WorkflowNode,
  WorkflowParam,
} from "./types.js";
import { validateWorkflow } from "./validate.js";

const AGENT_DEFAULTS = { timeoutMin: 30, validationRetries: 2, crashRetries: 1 } as const;
const SHELL_DEFAULT_TIMEOUT = 10;

function normalizeParam(param: WorkflowParam): WorkflowParam {
  const out: WorkflowParam = {
    name: param.name,
    type: param.type,
    required: param.required,
  };
  if (param.default !== undefined) out.default = param.default;
  if (param.type === "enum" && param.options !== undefined) out.options = [...param.options];
  return out;
}

function normalizeStart(node: StartNode): NormalizedStartNode {
  return {
    id: node.id,
    type: "start",
    name: node.name,
    supervise: "default",
    env: [],
    params: node.params.map(normalizeParam),
    ...(node.webhook === undefined ? {} : { webhook: normalizeWebhook(node.webhook) }),
  };
}

function normalizeWebhook(webhook: StartWebhookConfig): StartWebhookConfig {
  return {
    enabled: webhook.enabled,
    ...(webhook.paramMapping === undefined ? {} : { paramMapping: { ...webhook.paramMapping } }),
  };
}

function normalizeWorkspace(workspace?: { mode: string }): NormalizedWorkspaceSpec {
  return workspace?.mode === "worktree" ? { mode: "worktree" } : { mode: "scratch" };
}

function resolvePrompt(file: WorkflowFile, node: AgentNode, options: NormalizeOptions): string {
  if (node.prompt !== undefined && node.promptFile !== undefined) {
    throw new DevChestraError("E_WORKFLOW_INVALID", "Agent sets both prompt and promptFile.");
  }
  if (node.prompt !== undefined) return node.prompt;
  if (node.promptFile === undefined) {
    throw new DevChestraError("E_WORKFLOW_INVALID", "Agent has neither prompt nor promptFile.");
  }

  const prompts = options.prompts;
  if (prompts === undefined) {
    throw new DevChestraError(
      "E_WORKFLOW_INVALID",
      `promptFile '${node.promptFile}' requires an inlined prompts map. The schema package never reads files; pass the contents of '${file.id}.prompts/' as options.prompts.`,
      { details: { pointer: "/promptFile", nodeId: node.id } },
    );
  }
  const direct = prompts[node.promptFile];
  const withPrefix = prompts[`${file.id}.prompts/${node.promptFile}`];
  const content = direct ?? withPrefix;
  if (content === undefined) {
    throw new DevChestraError(
      "E_WORKFLOW_INVALID",
      `promptFile '${node.promptFile}' was not supplied in options.prompts (looked up '${node.promptFile}' and '${file.id}.prompts/${node.promptFile}').`,
      { details: { pointer: "/promptFile", nodeId: node.id } },
    );
  }
  return content;
}

function normalizeAgent(
  file: WorkflowFile,
  node: AgentNode,
  options: NormalizeOptions,
): NormalizedAgentNode {
  const output = normalizeOutputSchema(node.output);
  if (!output.ok) throw output.error;

  const prompt = resolvePrompt(file, node, options);
  const limits = node.limits ?? {};
  const out: NormalizedAgentNode = {
    id: node.id,
    type: "agent",
    name: node.name,
    supervise: "default",
    env: [],
    cli: node.cli,
    prompt,
    output: output.value,
    permissions: {
      network: node.permissions.network,
      write: [...new Set(node.permissions.write)].sort(),
      ...(node.permissions.shell === undefined ? {} : { shell: node.permissions.shell }),
    },
    workspace: normalizeWorkspace(node.workspace),
    limits: {
      timeoutMin: limits.timeoutMin ?? AGENT_DEFAULTS.timeoutMin,
      validationRetries: limits.validationRetries ?? AGENT_DEFAULTS.validationRetries,
      crashRetries: limits.crashRetries ?? AGENT_DEFAULTS.crashRetries,
    },
    context: { project: "none", workflow: "none" },
  };
  if (node.model !== undefined) out.model = node.model;
  // Absent stays absent: only DevChestra's own server runs for the node.
  if (node.mcpServers !== undefined) {
    out.mcpServers = node.mcpServers.map((selection) => ({
      name: selection.name,
      scope: selection.scope,
    }));
  }
  return out;
}

function normalizeShell(node: ShellNode): NormalizedShellNode {
  return {
    id: node.id,
    type: "shell",
    name: node.name,
    supervise: "default",
    env: [],
    command: node.command,
    workspace: normalizeWorkspace(node.workspace),
    timeoutMin: node.timeoutMin ?? SHELL_DEFAULT_TIMEOUT,
    allowFailure: node.allowFailure ?? false,
  };
}

function normalizeGate(node: GateNode): NormalizedGateNode {
  return {
    id: node.id,
    type: "gate",
    name: node.name,
    supervise: "default",
    env: [],
    branches: node.branches.map((branch) =>
      branch.otherwise === true
        ? { id: branch.id, otherwise: true }
        : { id: branch.id, when: branch.when as string },
    ),
  };
}

function normalizeJoin(node: JoinNode): NormalizedJoinNode {
  const out: NormalizedJoinNode = {
    id: node.id,
    type: "join",
    name: node.name,
    supervise: "default",
    env: [],
    mode: node.mode,
    inputs: [...new Set(node.inputs)].sort(),
  };
  if (node.output !== undefined) {
    const output = normalizeOutputSchema(node.output);
    if (!output.ok) throw output.error;
    out.output = output.value;
  }
  return out;
}

function normalizeEnd(node: EndNode): NormalizedEndNode {
  return {
    id: node.id,
    type: "end",
    name: node.name,
    supervise: "default",
    env: [],
    status: node.status,
    result: node.result,
  };
}

function normalizeApproval(node: ApprovalNode): NormalizedApprovalNode {
  const out: NormalizedApprovalNode = {
    id: node.id,
    type: "approval",
    name: node.name,
    supervise: "default",
    env: [],
    message: node.message,
    irreversible: node.irreversible,
  };
  if (node.criteria !== undefined) out.criteria = [...node.criteria];
  return out;
}

function normalizeDecision(node: DecisionNode): NormalizedDecisionNode {
  const out: NormalizedDecisionNode = {
    id: node.id,
    type: "decision",
    name: node.name,
    supervise: "default",
    env: [],
    provider: node.provider,
    state: node.state,
    instructions: node.instructions,
    mode: structuredClone(node.mode),
    onError: node.onError ?? "fail",
  };
  if (node.model !== undefined) out.model = node.model;
  return out;
}

function normalizeLoopBody(
  file: WorkflowFile,
  node: LoopNode,
  options: NormalizeOptions,
): NormalizedLoopNode["body"] {
  const nodes = node.body.nodes
    .map((child) => {
      if (child.type === "loop" || child.type === "foreach") {
        throw new DevChestraError("E_WORKFLOW_INVALID", "Nested controllers are not supported.");
      }
      return normalizeNode(file, child, options);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = node.body.edges
    .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { nodes, edges };
}

function normalizeLoop(
  file: WorkflowFile,
  node: LoopNode,
  options: NormalizeOptions,
): NormalizedLoopNode {
  const output = normalizeOutputSchema(node.output);
  if (!output.ok) throw output.error;
  return {
    id: node.id,
    type: "loop",
    name: node.name,
    supervise: "default",
    env: [],
    mode: "repeatUntil",
    maxIterations: node.maxIterations,
    initialState: node.initialState ?? "{}",
    nextState: node.nextState ?? "loop.state",
    until: node.until,
    result: node.result,
    output: output.value,
    body: normalizeLoopBody(file, node, options),
  };
}

function normalizeForEachBody(
  file: WorkflowFile,
  node: ForEachNode,
  options: NormalizeOptions,
): NormalizedLoopNode["body"] {
  const nodes = node.body.nodes
    .map((child) => {
      if (child.type === "loop" || child.type === "foreach") {
        throw new DevChestraError("E_WORKFLOW_INVALID", "Nested controllers are not supported.");
      }
      return normalizeNode(file, child, options);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = node.body.edges
    .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { nodes, edges };
}

function normalizeForEach(
  file: WorkflowFile,
  node: ForEachNode,
  options: NormalizeOptions,
): NormalizedForEachNode {
  const output = normalizeOutputSchema(node.output);
  if (!output.ok) throw output.error;
  return {
    id: node.id,
    type: "foreach",
    name: node.name,
    supervise: "default",
    env: [],
    source: structuredClone(node.source),
    maxItems: node.maxItems ?? 1000,
    onItemFailure: node.onItemFailure ?? "stop",
    result: node.result,
    output: output.value,
    body: normalizeForEachBody(file, node, options),
  };
}

function normalizeChildWorkflow(node: ChildWorkflowNode): NormalizedChildWorkflowNode {
  const out: NormalizedChildWorkflowNode = {
    id: node.id,
    type: "workflow",
    name: node.name,
    supervise: "default",
    env: [],
    workflowId: node.workflowId,
    inputs: { ...node.inputs },
  };
  if (node.output !== undefined) {
    const output = normalizeOutputSchema(node.output);
    if (!output.ok) throw output.error;
    out.output = output.value;
  }
  return out;
}

function normalizeNode(
  file: WorkflowFile,
  node: WorkflowNode,
  options: NormalizeOptions,
): NormalizedNode {
  switch (node.type) {
    case "start":
      return normalizeStart(node);
    case "agent":
      return normalizeAgent(file, node, options);
    case "shell":
      return normalizeShell(node);
    case "gate":
      return normalizeGate(node);
    case "join":
      return normalizeJoin(node);
    case "approval":
      return normalizeApproval(node as ApprovalNode);
    case "decision":
      return normalizeDecision(node as DecisionNode);
    case "loop":
      return normalizeLoop(file, node, options);
    case "foreach":
      return normalizeForEach(file, node as ForEachNode, options);
    case "workflow":
      return normalizeChildWorkflow(node as ChildWorkflowNode);
    case "end":
      return normalizeEnd(node);
  }
}

/**
 * Validate, apply explicit defaults, inline promptFile from the supplied map,
 * strip UI data, sort nodes/edges by id and normalize output schemas. Returns a
 * snapshot that can be hashed and persisted. The caller must persist the
 * snapshot; schema does no I/O.
 */
export function normalizeWorkflow(
  file: WorkflowFile,
  options: NormalizeOptions = {},
): Result<NormalizedWorkflow, DevChestraError> {
  const report = validateWorkflow(file);
  if (!report.ok) {
    const first = report.errors[0];
    return err(
      new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Workflow is invalid: ${first?.message ?? "unknown error"}`,
        { details: { issues: report.errors } },
      ),
    );
  }

  try {
    const nodes = file.graph.nodes
      .map((node) => normalizeNode(file, node, options))
      .sort((left, right) => left.id.localeCompare(right.id));
    const edges = file.graph.edges
      .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const workflow: NormalizedWorkflow = {
      schemaVersion: 1,
      id: file.id,
      name: file.name,
      graph: { nodes, edges },
    };
    if (file.description !== undefined) workflow.description = file.description;
    return ok(workflow);
  } catch (error) {
    return err(
      error instanceof DevChestraError
        ? error
        : new DevChestraError("E_INTERNAL", "Could not normalize workflow", { cause: error }),
    );
  }
}

/** Deterministic SHA-256 over the normalized workflow via core hashJson. */
export async function hashWorkflow(workflow: NormalizedWorkflow): Promise<string> {
  return hashJson(workflow);
}

/** Hash a normalized output schema. Throws DevChestraError if the schema is invalid. */
export async function hashOutputSchema(schema: JsonSchemaObject): Promise<string> {
  const normalized = normalizeOutputSchema(schema);
  if (!normalized.ok) throw normalized.error;
  return hashJson(normalized.value);
}
