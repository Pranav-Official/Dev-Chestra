import type { RunView } from "@relay/core";
import { DECISION_PROVIDERS, type NormalizedWorkflow, PROD_CLIS } from "@relay/schema";
import { coreErrorCodeSchema } from "./errors.js";
import {
  decisionOutputSchema,
  decisionRoutingSchema,
  gateDecidedPayloadSchema,
  joinResolvedPayloadSchema,
  processStopReasonSchema,
  validationIssueSchema,
} from "./events.js";
import {
  epochMsSchema,
  execStatusSchema,
  jsonValueSchema,
  nodeKindSchema,
  pathSchema,
  runIdSchema,
  runPauseReasonSchema,
  runStatusSchema,
} from "./primitives.js";
import { z } from "./zod.js";

const strict = z.strictObject;

const acceptedResultRefSchema = strict({
  runId: runIdSchema,
  path: pathSchema,
  outputId: z.string(),
  outputHash: z.string(),
  schemaHash: z.string().nullable(),
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  acceptedEventId: z.number().int().nonnegative(),
});

const processSpawnedRefSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  pid: z.number().int().positive(),
  pidStart: z.string(),
  binary: z.string(),
  cwd: z.string(),
});

const processStoppedRefSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  reason: processStopReasonSchema,
  exitCode: z.number().int().nullable(),
});

const workspaceFinalizedRefSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  dir: z.string(),
  commitSha: z.string().nullable(),
});

const workspaceCommittedViewSchema = strict({
  sha: z.string(),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

const transcriptRefViewSchema = strict({
  file: z.string(),
  bytes: z.number().int().nonnegative(),
});

const recordedOutputRefSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  outputId: z.string(),
  outputHash: z.string(),
  eventId: z.number().int().nonnegative(),
});

const execErrorViewSchema = strict({
  code: coreErrorCodeSchema,
  message: z.string(),
});

export const execViewSchema = strict({
  path: pathSchema,
  nodeId: z.string(),
  status: execStatusSchema,
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  kind: nodeKindSchema.nullable(),
  requiresAcceptedResult: z.boolean(),
  acceptedResult: acceptedResultRefSchema.nullable(),
  recordedOutput: recordedOutputRefSchema.nullable(),
  processSpawned: processSpawnedRefSchema.nullable(),
  processStopped: processStoppedRefSchema.nullable(),
  workspaceFinalized: workspaceFinalizedRefSchema.nullable(),
  validationAttempts: z.number().int().nonnegative(),
  crashAttempts: z.number().int().nonnegative(),
  mode: z.enum(["fresh", "resume"]).nullable(),
  cli: z.string().nullable(),
  sessionId: z.string().nullable(),
  sessionCwd: z.string().nullable(),
  model: z.string().nullable(),
  resolvedConfigHash: z.string().nullable(),
  inputsHash: z.string().nullable(),
  startedAt: epochMsSchema.nullable(),
  endedAt: epochMsSchema.nullable(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  attemptTokensIn: z.number().int().nonnegative(),
  attemptTokensOut: z.number().int().nonnegative(),
  attemptCostUsd: z.number().nonnegative(),
  workspaceDir: z.string().nullable(),
  branch: z.string().nullable(),
  workspaceCommitted: workspaceCommittedViewSchema.nullable(),
  lastValidationErrors: z.array(validationIssueSchema),
  lastTranscript: transcriptRefViewSchema.nullable(),
  lastError: execErrorViewSchema.nullable(),
  /** Durable routing projection; null outside gates/legacy cached views. */
  gateDecision: gateDecidedPayloadSchema.nullable(),
  /** Durable routing projection; null outside joins/legacy cached views. */
  joinResolution: joinResolvedPayloadSchema.nullable(),
  /** Durable approval request; null outside approval nodes or before request. */
  approvalRequest: z
    .strictObject({
      message: z.string(),
      irreversible: z.boolean(),
      criteria: z.array(z.string()).nullable(),
      requestId: z.string().nullable(),
      attempt: z.number().int().positive().nullable(),
      generation: z.number().int().positive().nullable(),
      eventId: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
  /** Durable approval decision; null before resolution. */
  approvalDecision: z
    .strictObject({
      decision: z.enum(["approve", "reject"]),
      by: z.string(),
      note: z.string().nullable(),
      requestId: z.string().nullable(),
      attempt: z.number().int().positive().nullable(),
      generation: z.number().int().positive().nullable(),
      eventId: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
  /** Durable decision answer; null until decision.answered. */
  decision: z
    .strictObject({
      output: decisionOutputSchema,
      routing: decisionRoutingSchema,
      eventId: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});

export const providerViewSchema = strict({
  blockedUntil: epochMsSchema.nullable(),
  kind: z.string().nullable(),
  source: z.string().nullable(),
  reason: z.string().nullable(),
});

export const recViewSchema = strict({
  id: z.string(),
  action: z.string(),
  status: z.enum(["open", "applied", "dismissed", "expired"]),
});

export const runBudgetViewSchema = strict({
  usd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  activeMs: z.number().int().nonnegative(),
  supervisorUsd: z.number().nonnegative(),
});

export const runErrorViewSchema = strict({
  eventId: z.number().int().nonnegative(),
  ts: z.string(),
  path: pathSchema,
  code: coreErrorCodeSchema,
  message: z.string(),
  // error.logged details are optional; legacy/engine events may omit them.
  details: z.unknown().optional(),
});

export const supervisorViewSchema = strict({
  wakes: z.number().int().nonnegative(),
  interventions: z.number().int().nonnegative(),
  recs: z.array(recViewSchema),
});

/** Mirror of the core reducer's `RunView` (the reducer remains authoritative). */
export const runViewSchema = strict({
  status: runStatusSchema,
  runNumber: z.number().int().nonnegative(),
  executions: z.record(z.string(), execViewSchema),
  edges: z.record(z.string(), z.enum(["pending", "active", "dead"])),
  providers: z.record(z.string(), providerViewSchema),
  budget: runBudgetViewSchema,
  activeSince: epochMsSchema.nullable(),
  pausedAt: epochMsSchema.nullable(),
  pausedMs: z.number().int().nonnegative(),
  pauseReason: runPauseReasonSchema.nullable(),
  pauseDetail: z.string().nullable(),
  pausePath: pathSchema.nullable(),
  supervisor: supervisorViewSchema,
  errors: z.array(runErrorViewSchema),
  lastEventId: z.number().int().nonnegative(),
}) as unknown as z.ZodType<RunView>;

const jsonSchemaObjectSchema = z.record(z.string(), jsonValueSchema);

const workflowParamSchema = strict({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "enum"]),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
});

const normalizedNodeBase = {
  id: z.string(),
  name: z.string(),
  supervise: z.literal("default"),
  env: z.array(z.string()),
};

const normalizedWorkspaceSchema = z.discriminatedUnion("mode", [
  strict({ mode: z.literal("scratch") }),
  strict({ mode: z.literal("worktree") }),
]);

const normalizedStartNodeSchema = strict({
  ...normalizedNodeBase,
  type: z.literal("start"),
  params: z.array(workflowParamSchema),
});

const normalizedAgentNodeSchema = strict({
  ...normalizedNodeBase,
  type: z.literal("agent"),
  // Structural allow-list: fake validates everywhere so browser run views can
  // display test runs. Run-time layers enforce the RELAY_ALLOW_FAKE=1 gate.
  cli: z.enum([...PROD_CLIS, "fake"]),
  model: z.string().optional(),
  prompt: z.string(),
  output: jsonSchemaObjectSchema,
  permissions: strict({
    network: z.boolean(),
    write: z.array(z.enum(["workspace", "project"])),
    shell: z.boolean().optional(),
  }),
  mcpServers: z
    .array(
      strict({
        name: z.string().min(1).max(128),
        scope: z.enum(["global", "project", "connector"]),
      }),
    )
    .max(32)
    .optional(),
  workspace: normalizedWorkspaceSchema,
  limits: strict({
    timeoutMin: z.number(),
    validationRetries: z.number().int().nonnegative(),
    crashRetries: z.number().int().nonnegative(),
  }),
  context: strict({
    project: z.literal("none"),
    workflow: z.literal("none"),
  }),
});

const normalizedShellNodeSchema = strict({
  ...normalizedNodeBase,
  type: z.literal("shell"),
  command: z.string(),
  workspace: normalizedWorkspaceSchema,
  timeoutMin: z.number(),
  allowFailure: z.boolean(),
});

const normalizedEndNodeSchema = strict({
  ...normalizedNodeBase,
  type: z.literal("end"),
  status: z.enum(["success", "failed", "rejected"]),
  result: z.string(),
});

const gateBranchSchema = strict({
  id: z.string().min(1),
  when: z.string().optional(),
  otherwise: z.literal(true).optional(),
});

const normalizedGateNodeSchema = strict({
  ...normalizedNodeBase,
  type: z.literal("gate"),
  branches: z.array(gateBranchSchema).min(1),
});

const normalizedJoinNodeSchema = strict({
  ...normalizedNodeBase,
  type: z.literal("join"),
  mode: z.enum(["first", "all"]),
  inputs: z.array(z.string().min(1)).min(1),
  output: jsonSchemaObjectSchema.optional(),
});

const normalizedApprovalNodeSchema = strict({
  ...normalizedNodeBase,
  type: z.literal("approval"),
  message: z.string(),
  criteria: z.array(z.string()).optional(),
  irreversible: z.boolean(),
  // legacy compat: old snapshots may have autoApprove
  autoApprove: z.boolean().optional(),
  minConfidence: z.number().optional(),
});

const decisionModeSchema = z.discriminatedUnion("kind", [
  strict({
    kind: z.literal("boolean"),
    trueAt: z.number().optional(),
    falseAt: z.number().optional(),
  }),
  strict({
    kind: z.literal("choice"),
    options: z.array(strict({ value: z.string(), description: z.string().optional() })),
    branches: z.array(strict({ id: z.string(), values: z.array(z.string()) })),
    minConfidence: z.number().optional(),
  }),
  strict({
    kind: z.literal("score"),
    levels: z.array(strict({ label: z.string(), description: z.string().optional() })),
    bands: z.array(strict({ id: z.string(), atLeast: z.union([z.number(), z.null()]) })),
    minConfidence: z.number().optional(),
  }),
]);

const normalizedDecisionNodeSchema = strict({
  ...normalizedNodeBase,
  type: z.literal("decision"),
  provider: z.enum(DECISION_PROVIDERS),
  model: z.string().optional(),
  state: z.string(),
  instructions: z.string(),
  mode: decisionModeSchema,
  onError: z.enum(["fail", "uncertain"]),
});

export const normalizedNodeSchema = z.discriminatedUnion("type", [
  normalizedStartNodeSchema,
  normalizedAgentNodeSchema,
  normalizedShellNodeSchema,
  normalizedGateNodeSchema,
  normalizedJoinNodeSchema,
  normalizedApprovalNodeSchema,
  normalizedDecisionNodeSchema,
  normalizedEndNodeSchema,
]);

export const normalizedWorkflowSchema = strict({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  graph: strict({
    nodes: z.array(normalizedNodeSchema),
    edges: z.array(
      strict({
        id: z.string(),
        from: z.string(),
        to: z.string(),
      }),
    ),
  }),
}) as unknown as z.ZodType<NormalizedWorkflow>;
