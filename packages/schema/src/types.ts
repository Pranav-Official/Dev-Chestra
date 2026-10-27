import type { RunWorkspaceSelection } from "@relay/core";

/** P1-supported agent CLIs. `fake` is test-only and never a production adapter. */
export type AgentCli = "fake" | "claude-code" | "codex";

export type SuperviseMode = "default" | "checkpoint" | "notify" | "skip";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** A JSON Schema object. The restricted profile is enforced by normalizeOutputSchema. */
export interface JsonSchemaObject {
  [key: string]: unknown;
}

export type ParamType = "string" | "number" | "boolean" | "enum";

export interface WorkflowParam {
  name: string;
  type: ParamType;
  default?: string | number | boolean;
  options?: string[];
  required: boolean;
}

export interface WorkflowBudget {
  maxUsd?: number;
  maxTokens?: number;
  maxActiveMinutes?: number;
}

export interface NodeBase {
  id: string;
  type: string;
  name: string;
  /** Editor layout and other UI-only data. Preserved on parse, stripped on normalize. */
  ui?: Record<string, unknown>;
  supervise?: SuperviseMode;
  /** Env var names passed through to this node. Non-empty is unsupported in P1. */
  env?: string[];
}

export interface StartNode extends NodeBase {
  type: "start";
  params: WorkflowParam[];
}

export type WorkspaceSpec =
  | { mode: "scratch" }
  | { mode: "worktree"; base?: string; setup?: string; from?: string }
  | { mode: "project"; access: "read" | "write" };

/** Normalized workspace selection: scratch, or the run-level git worktree. */
export type NormalizedWorkspaceSpec = { mode: "scratch" } | { mode: "worktree" };

export interface AgentPermissions {
  network: boolean;
  write: ("workspace" | "project")[];
}

export interface AgentLimits {
  timeoutMin?: number;
  validationRetries?: number;
  crashRetries?: number;
  maxQuotaWaitHours?: number;
}

export interface AgentContext {
  project: "none" | "read" | "readwrite";
  workflow: "none" | "read" | "readwrite";
}

export interface AgentNode extends NodeBase {
  type: "agent";
  cli: AgentCli;
  model?: string;
  prompt?: string;
  promptFile?: string;
  output: JsonSchemaObject;
  permissions: AgentPermissions;
  /** Legacy per-node metadata; fresh runs use the run-level workspace choice. */
  workspace?: WorkspaceSpec;
  limits?: AgentLimits;
  context?: AgentContext;
  cliOptions?: Record<string, unknown>;
}

export interface ShellNode extends NodeBase {
  type: "shell";
  command: string;
  /** Legacy per-node metadata; fresh runs use the run-level workspace choice. */
  workspace?: WorkspaceSpec;
  timeoutMin?: number;
  allowFailure?: boolean;
}

export interface EndNode extends NodeBase {
  type: "end";
  status: "success" | "failed" | "rejected";
  result: string;
}

export interface ApprovalNode extends NodeBase {
  type: "approval";
  /** Human prompt. May contain {{ expression }} templates using ancestor scope. */
  message: string;
  criteria?: string[];
  irreversible: boolean;
}

export interface GateBranch {
  id: string;
  when?: string;
  otherwise?: true;
}

export interface GateNode extends NodeBase {
  type: "gate";
  /** Ordered branches. Exactly one `otherwise`, last. */
  branches: GateBranch[];
}

export interface JoinNode extends NodeBase {
  type: "join";
  mode: "first" | "all";
  /** Declared input names, referenced as `joinId.inputName` in edges. */
  inputs: string[];
  output?: JsonSchemaObject;
}

export type WorkflowNode =
  | StartNode
  | AgentNode
  | ShellNode
  | GateNode
  | JoinNode
  | ApprovalNode
  | EndNode;
export type NodeType = WorkflowNode["type"];

export interface Edge {
  id: string;
  from: string;
  to: string;
  /** Editor-only waypoints. Stripped on normalize. */
  ui?: Record<string, unknown>;
}

export interface Graph {
  nodes: WorkflowNode[];
  edges: Edge[];
}

export interface WorkflowFile {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  budget?: WorkflowBudget;
  /** Parsed only so validation can reject it with an actionable message. */
  supervisor?: unknown;
  graph: Graph;
}

export interface NormalizedNodeBase {
  id: string;
  type: NodeType;
  name: string;
  supervise: "default";
  env: string[];
}

export interface NormalizedStartNode extends NormalizedNodeBase {
  type: "start";
  params: WorkflowParam[];
}

export interface NormalizedAgentNode extends NormalizedNodeBase {
  type: "agent";
  cli: AgentCli;
  model?: string;
  prompt: string;
  output: JsonSchemaObject;
  permissions: AgentPermissions;
  workspace: NormalizedWorkspaceSpec;
  limits: Required<Pick<AgentLimits, "timeoutMin" | "validationRetries" | "crashRetries">>;
  context: { project: "none"; workflow: "none" };
}

export interface NormalizedShellNode extends NormalizedNodeBase {
  type: "shell";
  command: string;
  workspace: NormalizedWorkspaceSpec;
  timeoutMin: number;
  allowFailure: boolean;
}

export interface NormalizedGateNode extends NormalizedNodeBase {
  type: "gate";
  branches: GateBranch[];
}

export interface NormalizedJoinNode extends NormalizedNodeBase {
  type: "join";
  mode: "first" | "all";
  inputs: string[];
  output?: JsonSchemaObject;
}

export interface NormalizedEndNode extends NormalizedNodeBase {
  type: "end";
  status: "success" | "failed" | "rejected";
  result: string;
}

export interface NormalizedApprovalNode extends NormalizedNodeBase {
  type: "approval";
  message: string;
  criteria?: string[];
  irreversible: boolean;
}

export type NormalizedNode =
  | NormalizedStartNode
  | NormalizedAgentNode
  | NormalizedShellNode
  | NormalizedGateNode
  | NormalizedJoinNode
  | NormalizedApprovalNode
  | NormalizedEndNode;

export interface NormalizedEdge {
  id: string;
  from: string;
  to: string;
}

export interface NormalizedWorkflow {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  graph: { nodes: NormalizedNode[]; edges: NormalizedEdge[] };
}

export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
  pointer?: string;
  nodeId?: string;
}

export interface RequiresSummary {
  clis: AgentCli[];
  /** Legacy per-node metadata only; ignored for fresh run-level workspaces. */
  networkNodes: { nodeId: string; name: string }[];
  shellCommands: { nodeId: string; command: string; rawSubstitution: boolean }[];
  projectWriteNodes: { nodeId: string; name: string }[];
  /** @deprecated Legacy node worktree metadata; fresh runs use the run-level choice. */
  worktreeNodes: string[];
  providers: string[];
  envVars: string[];
  irreversibleApprovals: string[];
  budget: WorkflowBudget;
}

export interface ValidationContext {
  providers?: string[];
  projectKind?: "git" | "folder";
}

export interface ValidationReport {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  requires: RequiresSummary;
}

export interface NormalizeOptions {
  /** Contents of `<workflowId>.prompts/<name>.md`, keyed by the promptFile value. */
  prompts?: Readonly<Record<string, string>>;
}

export interface ParamValidation {
  ok: boolean;
  /** Provided values plus applied defaults. Do not use when ok is false. */
  value: Record<string, unknown>;
  errors: Issue[];
}

export interface Capabilities {
  readonly schemaVersion: 1;
  readonly nodeTypes: readonly NodeType[];
  readonly clis: readonly AgentCli[];
  /** Legacy per-node parser modes, kept for old documents. */
  readonly workspaces: readonly NormalizedWorkspaceSpec["mode"][];
  /** Run-level selection modes chosen at Start. */
  readonly runWorkspaces: readonly RunWorkspaceSelection["mode"][];
  readonly defaultRunWorkspace: RunWorkspaceSelection["mode"];
  readonly unsupported: readonly string[];
  readonly defaultLimits: {
    readonly agent: { timeoutMin: number; validationRetries: number; crashRetries: number };
    readonly shellTimeoutMin: number;
  };
}

export const SCHEMA_CAPABILITIES: Capabilities = {
  schemaVersion: 1,
  nodeTypes: ["start", "agent", "shell", "gate", "join", "approval", "end"],
  clis: ["fake", "claude-code", "codex"],
  workspaces: ["scratch", "worktree"],
  runWorkspaces: ["project", "existing-worktree", "new-worktree"],
  defaultRunWorkspace: "project",
  unsupported: [
    "node types other than start/agent/shell/gate/join/approval/end",
    "cli opencode/pi",
    "per-node workspace selection (legacy metadata is ignored on fresh runs)",
    "per-node worktree base/setup/from options",
    "agent context reads/writes",
    "supervisor and node supervise modes other than 'default'",
    "workflow budgets",
    "artifact output format",
    "non-empty cliOptions",
    "non-empty env passthrough",
    "raw {{{ }}} template substitution",
    "shell heredocs, comments, trailing-backslash contexts and placeholders inside quotes, backticks or substitutions",
    "approval auto-approve/timeouts/output editing",
  ],
  defaultLimits: {
    agent: { timeoutMin: 30, validationRetries: 2, crashRetries: 1 },
    shellTimeoutMin: 10,
  },
};
