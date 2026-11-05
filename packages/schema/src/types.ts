import type { RunWorkspaceSelection } from "@devchestra/core";

/** Production agent CLIs. `fake` lives only in the test adapter registry behind DEVCHESTRA_ALLOW_FAKE. */
export const PROD_CLIS = ["claude-code", "codex", "opencode", "pi"] as const;

/** Production CLI id, derived from {@link PROD_CLIS}. This is the only
 * declaration of the supported-CLI set; adapters, engine, server and web
 * derive their CLI types, ids and labels from it. */
export type ProdCliId = (typeof PROD_CLIS)[number];

/** Back-compat alias of {@link ProdCliId} for workflow shape fields. */
export type AgentCli = ProdCliId;

/** Canonical display labels, keyed by {@link ProdCliId}. Provider metadata
 * and the web offline fallback both read these, so each label string is
 * declared exactly once. */
export const PROD_CLI_LABELS: Record<ProdCliId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "Opencode",
  pi: "Pi",
};

const prodCliIds: readonly string[] = PROD_CLIS;

/** Type guard for {@link ProdCliId}. Use it instead of casting CLI ids. */
export function isProdCliId(value: unknown): value is ProdCliId {
  return typeof value === "string" && prodCliIds.includes(value);
}

/** Decision-model providers for `decision` nodes. Jev (TypeSafe AI) and Clef
 * (Cloudflare) share the System One request shape; each id is a fixed host
 * preset in `@devchestra/decisions`. This is the only declaration of the set. */
export const DECISION_PROVIDERS = [
  "typesafe-jev",
  "cloudflare-clef",
  "cloudflare-clef-flash",
] as const;

export type DecisionProviderId = (typeof DECISION_PROVIDERS)[number];

/** Display labels, keyed by {@link DecisionProviderId}. */
export const DECISION_PROVIDER_LABELS: Record<DecisionProviderId, string> = {
  "typesafe-jev": "Jev (TypeSafe AI)",
  "cloudflare-clef": "Clef (Cloudflare)",
  "cloudflare-clef-flash": "Clef-flash (Cloudflare)",
};

const decisionProviderIds: readonly string[] = DECISION_PROVIDERS;

/** Type guard for {@link DecisionProviderId}. */
export function isDecisionProviderId(value: unknown): value is DecisionProviderId {
  return typeof value === "string" && decisionProviderIds.includes(value);
}

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
  /** Env var names passed through to this node. Non-empty is unsupported. */
  env?: string[];
}

/**
 * Webhook support declared by the saved workflow. Arming a trigger is runtime
 * state in the store; tokens and signing secrets never live in the workflow file.
 */
export interface StartWebhookConfig {
  /** Whether this workflow may be armed as a webhook trigger. */
  enabled: boolean;
  /**
   * Parameter name -> dot path into the delivery: `body.<path>` or
   * `headers.<allowlisted-name>`. When present it is authoritative: parameters
   * without an entry take their default or fail as missing.
   */
  paramMapping?: Record<string, string>;
}

/** Node id every embedded probe carries. The probe is a node of its own, not a graph member. */
export const POLL_PROBE_ID = "probe";

/**
 * Poll probe that runs a shell command: a full shell node, so it takes the same
 * fields as a graph shell node. Its stdout is the poll result. `workspace` and
 * `allowFailure` are engine-owned (a non-zero exit is always a probe failure).
 */
export type PollShellProbe = Omit<ShellNode, "workspace" | "allowFailure">;

/**
 * Poll probe that runs an agent: a full agent node (MCP servers, permissions,
 * limits, cliOptions and the rest). The engine owns what the poll contract needs:
 * `output` is generated from the start params, a preamble describing the contract
 * is prepended to `prompt`, and `workspace`, `context` and `promptFile` are not
 * accepted. Permissions are the author's; new probes default to network on, no
 * write tools, shell on.
 */
export type PollAgentProbe = Omit<AgentNode, "output" | "workspace" | "context" | "promptFile">;

export type PollProbe = PollShellProbe | PollAgentProbe;

/**
 * Polling support declared by the saved workflow. Arming (and the interval) is
 * runtime state in the store. The probe runs on a timer and returns nothing, or
 * the start parameters (plus an optional `dedupeKey`) that should start a run.
 */
export interface StartPollingConfig {
  /** Whether this workflow may be armed as a polling trigger. */
  enabled: boolean;
  probe: PollProbe;
  /** Skip a result whose dedupe key was already triggered within 7 days. Defaults to true. */
  dedupe?: boolean;
  /**
   * Where the probe runs. `project` is the registered project root, read-only, with no
   * checkout. `worktree` is a fresh worktree per tick. Defaults to `project`.
   */
  workspace?: "project" | "worktree";
}

export interface StartNode extends NodeBase {
  type: "start";
  params: WorkflowParam[];
  webhook?: StartWebhookConfig;
  polling?: StartPollingConfig;
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
  /** Built-in shell tool. Absent keeps the legacy rule: shell follows `write` being non-empty. */
  shell?: boolean;
  /**
   * Opt into command guardrails through DevChestra exec, with the native shell off.
   * Allowed programs retain host filesystem/network access, independently of network/write.
   * Only valid when `shell` is not `false`; supported on macOS/Linux.
   */
  shellPolicy?: ShellPolicy;
}

export interface ShellPolicy {
  /** Allowlist regex sources matched against the canonical command. Non-empty means allowlist mode. */
  allow?: string[];
  /** Denylist regex sources matched against the canonical command. Evaluated before `allow`. */
  deny?: string[];
  /** Per-command timeout in seconds. */
  timeoutSec?: number;
  /** Per-command output cap in bytes. */
  maxOutputBytes?: number;
}

export const MCP_SCOPES = ["global", "project", "connector"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** A server the user switched on for an agent node. Names only: never commands, URLs or secrets. */
export interface McpSelection {
  name: string;
  scope: McpScope;
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
  /** Extra MCP servers (besides DevChestra's own). Absent or empty means only `devchestra`. */
  mcpServers?: McpSelection[];
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

export const DECISION_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DECISION_UNCERTAIN_HANDLE = "uncertain";

export interface DecisionBooleanMode {
  kind: "boolean";
  trueAt?: number;
  falseAt?: number;
}

export interface DecisionChoiceMode {
  kind: "choice";
  options: { value: string; description?: string }[];
  branches: { id: string; values: string[] }[];
  minConfidence?: number;
}

export interface DecisionScoreMode {
  kind: "score";
  levels: { label: string; description?: string }[];
  bands: { id: string; atLeast: number | null }[];
  minConfidence?: number;
}

export type DecisionMode = DecisionBooleanMode | DecisionChoiceMode | DecisionScoreMode;

export interface DecisionNode extends NodeBase {
  type: "decision";
  provider: DecisionProviderId;
  model?: string;
  /** Template over run params and ancestor outputs (same engine as prompts/shell). */
  state: string;
  /** 1..4000 chars question for the decision model. */
  instructions: string;
  mode: DecisionMode;
  onError: "fail" | "uncertain";
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

export const LOOP_MODE = "repeatUntil" as const;
export type LoopMode = typeof LOOP_MODE;

/** Bounds for bounded Repeat-until loops. Runtime also bounds state bytes. */
export const LOOP_MAX_ITERATIONS = 1000;
export const LOOP_MIN_ITERATIONS = 1;
/** Per-value JSON cap for loop state/result (16 KiB; store event cap is 64 KiB). */
export const LOOP_STATE_MAX_BYTES = 16 * 1024;
/** Body node ids reserved for loop scope roots. */
export const LOOP_RESERVED_BODY_IDS: readonly string[] = ["loop", "result"];

/** Bounds for foreach fan-out. */
export const FOREACH_MAX_ITEMS = 1000;
export const FOREACH_MIN_ITEMS = 1;
export const FOREACH_DEFAULT_MAX_ITEMS = 1000;
/** Body node ids reserved for foreach scope roots (bare `foreach` in bodies). */
export const FOREACH_RESERVED_BODY_IDS: readonly string[] = ["foreach", "result"];
/** Source handle of a child-workflow failure output. Plain endpoint = success. */
export const WORKFLOW_FAILED_HANDLE = "failed";
/** Max depth/total for transitive child-workflow freeze (engine canonical). */
export const WORKFLOW_MAX_DEPTH = 8;
export const WORKFLOW_MAX_DEPENDENCIES = 32;

export interface LoopNode extends NodeBase {
  type: "loop";
  mode: LoopMode;
  maxIterations: number;
  /** Expression evaluated once in parent scope. Defaults to '{}'. */
  initialState?: string;
  /** Expression evaluated when continuing. Defaults to 'loop.state'. */
  nextState?: string;
  /** Boolean expression over the current result. */
  until: string;
  /** Expression over body outputs (end ancestors, not end output). */
  result: string;
  output: JsonSchemaObject;
  body: Graph;
}

export type ForeachSource =
  | { kind: "expression"; expression: string }
  | { kind: "csv"; path: string };

export interface ForEachNode extends NodeBase {
  type: "foreach";
  source: ForeachSource;
  /** 1..1000, defaults to 1000. */
  maxItems?: number;
  /** Defaults to "stop". */
  onItemFailure?: "stop" | "continue";
  body: Graph;
  /** Per-item result expression over End ancestors plus foreach scope. */
  result: string;
  /** Per-item output schema. */
  output: JsonSchemaObject;
}

export interface ChildWorkflowNode extends NodeBase {
  type: "workflow";
  /** Same managed-workflow id rules as file stems. */
  workflowId: string;
  /** Bare JSONata per target param. */
  inputs: Record<string, string>;
  /** Optional successful child-result object schema. */
  output?: JsonSchemaObject;
}

export type WorkflowNode =
  | StartNode
  | AgentNode
  | ShellNode
  | GateNode
  | JoinNode
  | ApprovalNode
  | DecisionNode
  | LoopNode
  | ForEachNode
  | ChildWorkflowNode
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
  webhook?: StartWebhookConfig;
  polling?: StartPollingConfig;
}

export interface NormalizedAgentNode extends NormalizedNodeBase {
  type: "agent";
  cli: AgentCli;
  model?: string;
  prompt: string;
  output: JsonSchemaObject;
  permissions: AgentPermissions;
  mcpServers?: McpSelection[];
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

export interface NormalizedDecisionNode extends NormalizedNodeBase {
  type: "decision";
  provider: DecisionProviderId;
  model?: string;
  state: string;
  instructions: string;
  mode: DecisionMode;
  onError: "fail" | "uncertain";
}

export interface NormalizedLoopBody {
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
}

export interface NormalizedLoopNode extends NormalizedNodeBase {
  type: "loop";
  mode: LoopMode;
  maxIterations: number;
  initialState: string;
  nextState: string;
  until: string;
  result: string;
  output: JsonSchemaObject;
  body: NormalizedLoopBody;
}

export interface NormalizedForEachNode extends NormalizedNodeBase {
  type: "foreach";
  source: ForeachSource;
  maxItems: number;
  onItemFailure: "stop" | "continue";
  body: NormalizedLoopBody;
  result: string;
  output: JsonSchemaObject;
}

export interface NormalizedChildWorkflowNode extends NormalizedNodeBase {
  type: "workflow";
  workflowId: string;
  inputs: Record<string, string>;
  output?: JsonSchemaObject;
}

/** Body children exclude nested loops by validation (type allows, validator rejects). */
export type NormalizedBodyNode = Exclude<
  NormalizedNode,
  NormalizedLoopNode | NormalizedForEachNode
>;

export type NormalizedNode =
  | NormalizedStartNode
  | NormalizedAgentNode
  | NormalizedShellNode
  | NormalizedGateNode
  | NormalizedJoinNode
  | NormalizedApprovalNode
  | NormalizedDecisionNode
  | NormalizedLoopNode
  | NormalizedForEachNode
  | NormalizedChildWorkflowNode
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
  disabledClis?: string[];
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
  nodeTypes: [
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
  ],
  clis: [...PROD_CLIS],
  workspaces: ["scratch", "worktree"],
  runWorkspaces: ["project", "existing-worktree", "new-worktree"],
  defaultRunWorkspace: "project",
  unsupported: [
    "node types other than start/agent/shell/gate/join/approval/decision/loop/foreach/workflow/end",
    "cli fake (test-only, behind DEVCHESTRA_ALLOW_FAKE)",
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
