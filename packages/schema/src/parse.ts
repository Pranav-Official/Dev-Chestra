import { DevChestraError, err, ok, type Result } from "@devchestra/core";
import { MAX_WORKFLOW_FILE_BYTES } from "./ids.js";
import {
  DECISION_PROVIDERS,
  MODEL_TIERS,
  POLL_PROBE_ID,
  PROD_CLIS,
  type WorkflowFile,
} from "./types.js";
import { z } from "./zod.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  if (!isPlainRecord(value)) return value;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    // Safe for an own "__proto__" key produced by JSON.parse.
    Object.defineProperty(out, key, {
      value: cloneJsonValue(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

const uiSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!isPlainRecord(value)) {
      ctx.addIssue({ code: "custom", message: "ui must be a JSON object" });
    }
  })
  .transform((value) => cloneJsonValue(value) as Record<string, unknown>);
const superviseSchema = z.enum(["default", "checkpoint", "notify", "skip"]);

const nodeBase = {
  id: z.string(),
  name: z.string(),
  ui: uiSchema.optional(),
  supervise: superviseSchema.optional(),
  env: z.array(z.string()).optional(),
};

const paramSchema = z.strictObject({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "enum"]),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
});

const MCP_SERVER_NAME_MAX = 128;
const MCP_SERVERS_MAX = 32;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const MCP_SERVER_NAME_CONTROL = /[\u0000-\u001f\u007f]/;

function mcpSelectionIssue(message: string, path: (string | number)[]) {
  // Zod 4 custom issues carry the message through to the pointer-mapped report below.
  return { code: "custom" as const, message, path };
}

const mcpSelectionSchema = z.strictObject({
  name: z.string(),
  scope: z.enum(["global", "project", "connector"]),
});

const mcpServersSchema = z
  .array(mcpSelectionSchema)
  .max(MCP_SERVERS_MAX)
  .superRefine((servers, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < servers.length; index += 1) {
      const selection = servers[index];
      if (selection === undefined) continue;
      const { name, scope } = selection;
      if (name.length < 1 || name.length > MCP_SERVER_NAME_MAX) {
        ctx.addIssue(
          mcpSelectionIssue(
            `mcpServers[${index}].name must be 1-${MCP_SERVER_NAME_MAX} characters.`,
            [index, "name"],
          ),
        );
        continue;
      }
      if (MCP_SERVER_NAME_CONTROL.test(name)) {
        ctx.addIssue(
          mcpSelectionIssue(`mcpServers[${index}].name must not contain control characters.`, [
            index,
            "name",
          ]),
        );
        continue;
      }
      if (name === "devchestra") {
        ctx.addIssue(
          mcpSelectionIssue(
            `mcpServers[${index}].name 'devchestra' is reserved for DevChestra's own server.`,
            [index, "name"],
          ),
        );
        continue;
      }
      const key = `${scope}:${name}`;
      if (seen.has(key)) {
        ctx.addIssue(mcpSelectionIssue(`mcpServers[${index}] duplicates '${key}'.`, [index]));
      } else {
        seen.add(key);
      }
    }
  });

const workspaceSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("scratch") }),
  z.strictObject({
    mode: z.literal("worktree"),
    base: z.string().optional(),
    setup: z.string().optional(),
    from: z.string().optional(),
  }),
  z.strictObject({
    mode: z.literal("project"),
    access: z.enum(["read", "write"]),
  }),
]);

const limitsSchema = z.strictObject({
  timeoutMin: z.number().optional(),
  validationRetries: z.number().optional(),
  crashRetries: z.number().optional(),
  maxQuotaWaitHours: z.number().optional(),
});

const contextSchema = z.strictObject({
  project: z.enum(["none", "read", "readwrite"]),
  workflow: z.enum(["none", "read", "readwrite"]),
});

const startWebhookSchema = z.strictObject({
  enabled: z.boolean(),
  paramMapping: z.record(z.string(), z.string()).optional(),
});

const pollProbeBase = {
  id: z.literal(POLL_PROBE_ID).optional(),
  name: z.string().optional(),
  ui: uiSchema.optional(),
  supervise: superviseSchema.optional(),
  env: z.array(z.string()).optional(),
};

/** Structural policy shape shared by workflow files and frozen run snapshots. */
export const shellPolicySchema = z.strictObject({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  timeoutSec: z.number().optional(),
  maxOutputBytes: z.number().optional(),
});

const pollAgentPermissionsSchema = z.strictObject({
  network: z.boolean(),
  write: z.array(z.enum(["workspace", "project"])),
  shell: z.boolean().optional(),
  shellPolicy: shellPolicySchema.optional(),
});

const pollShellProbeSchema = z.strictObject({
  ...pollProbeBase,
  type: z.literal("shell"),
  command: z.string(),
  timeoutMin: z.number().optional(),
  // Engine-owned: allowed through parse so validate can reject with E_POLL_PROBE
  // (same precedent as budget/supervisor). Truly unknown keys still fail strict.
  workspace: z.unknown().optional(),
  allowFailure: z.unknown().optional(),
});

const pollAgentProbeSchema = z.strictObject({
  ...pollProbeBase,
  type: z.literal("agent"),
  // Structural parse allows fake everywhere (warning in validateWorkflow).
  // Run-time layers enforce the DEVCHESTRA_ALLOW_FAKE=1 test-only gate.
  cli: z.enum([...PROD_CLIS, "fake"]).optional(),
  tier: z.enum(MODEL_TIERS).optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  permissions: pollAgentPermissionsSchema.optional(),
  mcpServers: mcpServersSchema.optional(),
  limits: limitsSchema.optional(),
  cliOptions: z.record(z.string(), z.unknown()).optional(),
  // Engine-owned: allowed through parse so validate rejects with E_POLL_PROBE.
  output: z.unknown().optional(),
  workspace: z.unknown().optional(),
  context: z.unknown().optional(),
  promptFile: z.unknown().optional(),
  // Old reduced shape: fail at parse with a clear migration message.
  timeoutMin: z
    .unknown()
    .optional()
    .superRefine((value, ctx) => {
      if (value !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "Poll agent probe timeoutMin was moved: use limits.timeoutMin instead of top-level timeoutMin.",
        });
      }
    }),
});

const startPollingSchema = z.strictObject({
  enabled: z.boolean(),
  probe: z.discriminatedUnion("type", [pollShellProbeSchema, pollAgentProbeSchema]),
  dedupe: z.boolean().optional(),
  workspace: z.enum(["project", "worktree"]).optional(),
});

const startNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("start"),
  params: z.array(paramSchema),
  webhook: startWebhookSchema.optional(),
  polling: startPollingSchema.optional(),
});

const agentNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("agent"),
  // Structural parse allows fake everywhere (warning in validateWorkflow).
  // Run-time layers (CLI startup/run gates, adapter registry) enforce the
  // DEVCHESTRA_ALLOW_FAKE=1 test-only requirement; API DTO schemas keep their own
  // gate for direct API writes.
  cli: z.enum([...PROD_CLIS, "fake"]).optional(),
  tier: z.enum(MODEL_TIERS).optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  promptFile: z.string().optional(),
  output: z.record(z.string(), z.unknown()),
  permissions: z.strictObject({
    network: z.boolean(),
    write: z.array(z.enum(["workspace", "project"])),
    shell: z.boolean().optional(),
    shellPolicy: shellPolicySchema.optional(),
  }),
  mcpServers: mcpServersSchema.optional(),
  workspace: workspaceSchema.optional(),
  limits: limitsSchema.optional(),
  context: contextSchema.optional(),
  cliOptions: z.record(z.string(), z.unknown()).optional(),
});

const shellNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("shell"),
  command: z.string(),
  workspace: workspaceSchema.optional(),
  timeoutMin: z.number().optional(),
  allowFailure: z.boolean().optional(),
});

const gateBranchSchema = z.strictObject({
  id: z.string(),
  when: z.string().optional(),
  otherwise: z.literal(true).optional(),
});

const gateNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("gate"),
  branches: z.array(gateBranchSchema),
});

const joinNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("join"),
  mode: z.enum(["first", "all"]),
  inputs: z.array(z.string()),
  output: z.record(z.string(), z.unknown()).optional(),
});

const endNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("end"),
  status: z.enum(["success", "failed", "rejected"]),
  result: z.string(),
});

const approvalNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("approval"),
  message: z.string(),
  criteria: z.array(z.string()).optional(),
  irreversible: z.boolean(),
});

const decisionOptionSchema = z.strictObject({
  value: z.string(),
  description: z.string().optional(),
});

const decisionBranchSchema = z.strictObject({
  id: z.string(),
  values: z.array(z.string()),
});

const decisionLevelSchema = z.strictObject({
  label: z.string(),
  description: z.string().optional(),
});

const decisionBandSchema = z.strictObject({
  id: z.string(),
  atLeast: z.union([z.number(), z.null()]),
});

const decisionModeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("boolean"),
    trueAt: z.number().optional(),
    falseAt: z.number().optional(),
  }),
  z.strictObject({
    kind: z.literal("choice"),
    options: z.array(decisionOptionSchema),
    branches: z.array(decisionBranchSchema),
    minConfidence: z.number().optional(),
  }),
  z.strictObject({
    kind: z.literal("score"),
    levels: z.array(decisionLevelSchema),
    bands: z.array(decisionBandSchema),
    minConfidence: z.number().optional(),
  }),
]);

const decisionNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("decision"),
  provider: z.enum(DECISION_PROVIDERS),
  model: z.string().optional(),
  state: z.string(),
  instructions: z.string(),
  mode: decisionModeSchema,
  // Default "fail" is applied by normalizeWorkflow; the contract type keeps it required.
  onError: z.enum(["fail", "uncertain"]).optional(),
});

const edgeSchema = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  ui: uiSchema.optional(),
});

const childWorkflowNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("workflow"),
  workflowId: z.string(),
  inputs: z.record(z.string(), z.string()),
  output: z.record(z.string(), z.unknown()).optional(),
});

const bodyNodeUnion = z.discriminatedUnion("type", [
  startNodeSchema,
  agentNodeSchema,
  shellNodeSchema,
  gateNodeSchema,
  joinNodeSchema,
  approvalNodeSchema,
  decisionNodeSchema,
  childWorkflowNodeSchema,
  endNodeSchema,
]);

const bodySchema = z.strictObject({
  nodes: z.array(bodyNodeUnion),
  edges: z.array(edgeSchema),
});

const loopNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("loop"),
  mode: z.literal("repeatUntil"),
  maxIterations: z.number(),
  initialState: z.string().optional(),
  nextState: z.string().optional(),
  until: z.string(),
  result: z.string(),
  output: z.record(z.string(), z.unknown()),
  body: bodySchema,
});

const foreachSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("expression"), expression: z.string() }),
  z.strictObject({ kind: z.literal("csv"), path: z.string() }),
]);

const foreachNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.literal("foreach"),
  source: foreachSourceSchema,
  maxItems: z.number().optional(),
  onItemFailure: z.enum(["stop", "continue"]).optional(),
  body: bodySchema,
  result: z.string(),
  output: z.record(z.string(), z.unknown()),
});

const workflowSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  budget: z.record(z.string(), z.unknown()).optional(),
  supervisor: z.unknown().optional(),
  graph: z.strictObject({
    nodes: z.array(
      z.discriminatedUnion("type", [
        startNodeSchema,
        agentNodeSchema,
        shellNodeSchema,
        gateNodeSchema,
        joinNodeSchema,
        approvalNodeSchema,
        decisionNodeSchema,
        loopNodeSchema,
        foreachNodeSchema,
        childWorkflowNodeSchema,
        endNodeSchema,
      ]),
    ),
    edges: z.array(edgeSchema),
  }),
});

/** Structural discovery only; semantic validation remains authoritative. */
export function workflowJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(workflowSchema, { io: "input", unrepresentable: "any" });
}

const SUPPORTED_NODE_TYPES = new Set([
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
const SUPPORTED_CLIS = new Set<string>([...PROD_CLIS]);

/** `fake` parses only for the test adapter registry behind DEVCHESTRA_ALLOW_FAKE. */
// ponytail: env-gated test hook; a shared registry module if more flags appear.
export function isFakeCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DEVCHESTRA_ALLOW_FAKE;
  return value === "1" || value === "true";
}

function pointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "";
  return `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function precheck(raw: unknown): DevChestraError | undefined {
  const root = record(raw);
  if (root === undefined) {
    return new DevChestraError("E_WORKFLOW_INVALID", "Workflow must be a JSON object");
  }
  if (root.schemaVersion !== 1) {
    const version = root.schemaVersion;
    const hint =
      typeof version === "number" && version > 1
        ? " This file was written by a newer build; upgrade DevChestra instead of editing it."
        : "";
    return new DevChestraError(
      "E_WORKFLOW_INVALID",
      `Unsupported schemaVersion ${String(version)}; this build supports schemaVersion 1.${hint}`,
      { details: { pointer: "/schemaVersion" } },
    );
  }
  const graph = record(root.graph);
  if (graph !== undefined && Array.isArray(graph.nodes)) {
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const node = record(graph.nodes[i]);
      if (node === undefined) continue;
      const type = node.type;
      if (typeof type === "string" && !SUPPORTED_NODE_TYPES.has(type)) {
        return new DevChestraError(
          "E_WORKFLOW_INVALID",
          `Unsupported node type '${type}' at graph.nodes[${i}]. Supported types: start, agent, shell, gate, join, approval, decision, loop, foreach, workflow, end.`,
          { details: { pointer: `/graph/nodes/${i}/type` } },
        );
      }
      if (type === "loop" || type === "foreach") {
        const body = record(node.body);
        const bodyNodes = body !== undefined ? body.nodes : undefined;
        if (Array.isArray(bodyNodes)) {
          for (let j = 0; j < bodyNodes.length; j += 1) {
            const child = record(bodyNodes[j]);
            if (child === undefined) continue;
            const childType = child.type;
            if (childType === "loop" || childType === "foreach") {
              return new DevChestraError(
                "E_WORKFLOW_INVALID",
                `Nested controllers are not supported (${type} body node '${String(child.id ?? j)}' at graph.nodes[${i}].body.nodes[${j}] has type '${String(childType)}'). Use a separate workflow with a loop.`,
                { details: { pointer: `/graph/nodes/${i}/body/nodes/${j}/type` } },
              );
            }
            if (typeof childType === "string" && !SUPPORTED_NODE_TYPES.has(childType)) {
              return new DevChestraError(
                "E_WORKFLOW_INVALID",
                `Unsupported node type '${childType}' at graph.nodes[${i}].body.nodes[${j}].`,
                { details: { pointer: `/graph/nodes/${i}/body/nodes/${j}/type` } },
              );
            }
          }
        }
      }
      if (type === "agent") {
        const cli = node.cli;
        if (typeof cli === "string" && !SUPPORTED_CLIS.has(cli)) {
          if (cli === "fake") {
            // Structural parse allows fake everywhere so browser authoring and
            // validation can display it with a warning. Run-time enforces the
            // test-only gate (DEVCHESTRA_ALLOW_FAKE=1) at startup/run/adapter layers.
            continue;
          }
          return new DevChestraError(
            "E_WORKFLOW_INVALID",
            `Unsupported agent CLI '${cli}' at graph.nodes[${i}]. Supported CLIs: ${[...PROD_CLIS].join(", ")}.`,
            { details: { pointer: `/graph/nodes/${i}/cli` } },
          );
        }
      }
    }
  }
  return undefined;
}

/**
 * Structural parse (Zod, strict objects). Unknown fields are rejected. Semantic
 * rules, unsupported options and expressions are checked by validateWorkflow.
 */
export function parseWorkflow(raw: unknown): Result<WorkflowFile, DevChestraError> {
  const precheckError = precheck(raw);
  if (precheckError !== undefined) return err(precheckError);

  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      pointer: pointer(issue.path),
      message: issue.message,
    }));
    const first = issues[0];
    const suffix = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
    return err(
      new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Invalid workflow${first?.pointer ? ` at ${first.pointer}` : ""}: ${first?.message ?? "parse failed"}${suffix}`,
        { details: { issues } },
      ),
    );
  }

  return ok(parsed.data as WorkflowFile);
}

/** Parse workflow JSON text. JSON syntax errors are reported as E_WORKFLOW_INVALID. */
export function parseWorkflowJson(text: string): Result<WorkflowFile, DevChestraError> {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_WORKFLOW_FILE_BYTES) {
    return err(
      new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Workflow file exceeds the ${MAX_WORKFLOW_FILE_BYTES}-byte limit.`,
        { details: { bytes, maxBytes: MAX_WORKFLOW_FILE_BYTES } },
      ),
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return err(
      new DevChestraError(
        "E_WORKFLOW_INVALID",
        `Workflow is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  return parseWorkflow(raw);
}

/**
 * Authoring alias for the structural parser. A draft may be an incomplete
 * graph (missing start, end or edges); semantic rules are checked separately by
 * validateWorkflow and are always required before execution.
 */
export const parseWorkflowDraft = parseWorkflow;

/** Authoring alias for parseWorkflowJson; same structural, strict contract. */
export const parseWorkflowDraftJson = parseWorkflowJson;
