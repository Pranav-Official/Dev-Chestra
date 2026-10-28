import {
  EVENT_TYPES,
  type EventEnvelope,
  type EventType,
  isKnownEventType,
  type KnownEventType,
  parsePath,
} from "@devchestra/core";
import { coreErrorCodeSchema } from "./errors.js";
import {
  actorSchema,
  epochMsSchema,
  eventIdSchema,
  execStatusSchema,
  jsonObjectSchema,
  jsonValueSchema,
  nodeKindSchema,
  pathSchema,
  runCompletionStatusSchema,
  runIdSchema,
  runKindSchema,
  runPauseReasonSchema,
} from "./primitives.js";
import { z } from "./zod.js";

const strict = z.strictObject;
const optionalString = z.string().optional();

export const processStopReasonSchema = z.enum(["exited", "killed", "grace_timeout", "crash"]);

export const validationIssueSchema = strict({
  path: z.string(),
  message: z.string(),
});

const serializedErrorSchema = strict({
  code: coreErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});

const runCreatedPayloadSchema = strict({
  workflowId: z.string(),
  workflowHash: z.string(),
  runNumber: z.number().int().positive(),
  params: jsonObjectSchema,
  budgets: jsonObjectSchema,
  baseSha: optionalString,
  kind: runKindSchema,
});

const runStartedPayloadSchema = strict({});

const runPausedPayloadSchema = strict({
  reason: runPauseReasonSchema,
  detail: optionalString,
  path: pathSchema.optional(),
});

const runResumedPayloadSchema = strict({ reason: z.string() });
const runCancelledPayloadSchema = strict({ by: z.string() });

const runCompletedPayloadSchema = strict({
  status: runCompletionStatusSchema,
  endPath: pathSchema.optional(),
  result: z.unknown().optional(),
  error: serializedErrorSchema.optional(),
});

const runOverrideAddedPayloadSchema = strict({
  nodeId: z.string(),
  kind: z.enum(["prompt_addendum", "param"]),
  value: jsonValueSchema,
  reason: z.string(),
});

const nodeStateInitSchema = strict({
  kind: nodeKindSchema,
  requireSubmission: z.boolean(),
});

const nodeStatePayloadSchema = strict({
  from: execStatusSchema,
  to: execStatusSchema,
  reason: optionalString,
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  init: nodeStateInitSchema.optional(),
});

const nodeAttemptStartedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  mode: z.enum(["fresh", "resume"]),
  cli: optionalString,
  model: optionalString,
  resolvedConfigHash: z.string(),
  nodeKind: nodeKindSchema.optional(),
  requireSubmission: z.boolean().optional(),
});

const nodeSessionCapturedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  cli: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  model: optionalString,
});

const nodeInputResolvedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  inputsHash: z.string(),
  inputs: jsonValueSchema.optional(),
});

const nodeOutputRejectedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  validationAttempt: z.number().int().nonnegative(),
  errors: z.array(validationIssueSchema),
});

const nodeOutputValidatedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  outputId: z.string(),
  outputHash: z.string(),
  schemaHash: optionalString,
});

const nodeOutputRecordedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  outputId: z.string(),
  outputHash: z.string(),
});

const nodeUsagePayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  costSource: z.enum(["reported", "estimated", "none"]),
});

const nodeTranscriptRefPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  file: z.string(),
  bytes: z.number().int().nonnegative(),
});

const nodeWatchdogPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  kind: z.enum(["timeout", "silence", "repeat", "cost"]),
  detail: z.string(),
});

const nodeProcessSpawnedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  pid: z.number().int().positive(),
  pidStart: z.string(),
  binary: z.string(),
  cwd: z.string(),
});

const nodeProcessStoppedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  reason: processStopReasonSchema,
  exitCode: z.number().int().nullable().optional(),
});

const nodeWorkspaceFinalizedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  dir: z.string(),
  commitSha: optionalString,
});

export const gateDecisionEntrySchema = strict({
  branch: z.string(),
  matched: z.boolean(),
  error: optionalString,
});

/** Canonical gate.decided payload (core owner, 5.5). `branch: null` means failure. */
export const gateDecidedPayloadSchema = strict({
  branch: z.string().nullable(),
  evaluated: z.array(gateDecisionEntrySchema),
  attempt: z.number().int().positive().optional(),
  generation: z.number().int().positive().optional(),
});

const decisionRequestedPayloadSchema = strict({
  provider: z.string(),
  model: z.string(),
  questionIds: z.array(z.string()),
  attempt: z.number().int().positive().optional(),
  generation: z.number().int().positive().optional(),
});

/** Normalized model answer for one decision question (core DecisionOutput). */
export const decisionOutputSchema = strict({
  kind: z.enum(["boolean", "choice", "score"]),
  value: z.union([z.boolean(), z.string(), z.null()]),
  probability: z.number().optional(),
  score: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().nullable(),
  confidenceSource: z.enum(["provider", "derived"]).nullable(),
  refusal: strict({ reason: optionalString }).optional(),
  model: z.string(),
});

export const decisionRoutingSchema = strict({
  branch: z.string().nullable(),
  reason: z.enum(["matched", "low_confidence", "refused", "error"]),
});

const decisionAnsweredPayloadSchema = strict({
  answers: z
    .array(
      strict({
        id: z.string(),
        kind: z.string(),
        value: jsonValueSchema,
        confidence: z.number().optional(),
        probabilities: z.record(z.string(), z.number()).optional(),
        refusal: optionalString,
      }),
    )
    .optional(),
  latencyMs: z.number().nonnegative().optional(),
  raw: jsonValueSchema.optional(),
  output: decisionOutputSchema.optional(),
  routing: decisionRoutingSchema.optional(),
  usage: strict({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).optional(),
  attempt: z.number().int().positive().optional(),
  generation: z.number().int().positive().optional(),
});

const approvalRequestedPayloadSchema = strict({
  message: z.string(),
  irreversible: z.boolean(),
  autoApprove: z.boolean().optional(),
  minConfidence: z.number().optional(),
  criteria: z.array(z.string()).optional(),
  requestId: z.string().min(1).optional(),
  attempt: z.number().int().positive().optional(),
  generation: z.number().int().positive().optional(),
});

const approvalResolvedPayloadSchema = strict({
  decision: z.enum(["approve", "reject"]),
  by: z.string(),
  edited: z.boolean().optional(),
  note: optionalString,
  requestId: z.string().min(1).optional(),
  attempt: z.number().int().positive().optional(),
  generation: z.number().int().positive().optional(),
});

const mapStartedPayloadSchema = strict({
  itemCount: z.number().int().nonnegative(),
  concurrency: z.number().int().positive(),
  labels: z.array(z.string()),
});

const mapItemStatePayloadSchema = strict({
  index: z.number().int().nonnegative(),
  status: z.string(),
  error: optionalString,
});

const mapCompletedPayloadSchema = strict({
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  outputId: z.string(),
});

const loopRoundStartedPayloadSchema = strict({
  round: z.number().int().positive(),
  carryHash: z.string(),
});

const loopRoundCompletedPayloadSchema = strict({
  round: z.number().int().positive(),
  exitMatched: z.boolean(),
  stalled: z.boolean().optional(),
});

const loopExitedPayloadSchema = strict({
  reason: z.enum(["condition", "max_rounds", "stalled"]),
  rounds: z.number().int().nonnegative(),
});

export const joinResolvedPayloadSchema = strict({
  mode: z.string(),
  active: z.array(z.string()),
  skipped: z.array(z.string()),
  attempt: z.number().int().positive().optional(),
  generation: z.number().int().positive().optional(),
});

const quotaBlockedPayloadSchema = strict({
  provider: z.string(),
  kind: z.enum(["window", "credits", "auth", "rate_limit"]),
  resumeAt: epochMsSchema.optional(),
  resumeAtSource: z.enum(["parsed", "estimated", "unknown"]),
});

const quotaReleasedPayloadSchema = strict({
  provider: z.string(),
  by: z.enum(["timer", "user", "probe"]),
});

const budgetThresholdPayloadSchema = strict({
  budget: z.enum(["usd", "tokens", "minutes", "supervisor_usd"]),
  ratio: z.number(),
});

const budgetExceededPayloadSchema = strict({
  budget: z.enum(["usd", "tokens", "minutes", "supervisor_usd"]),
  limit: z.number(),
  value: z.number(),
});

const workspaceCreatedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  mode: z.string(),
  dir: z.string(),
  branch: optionalString,
  baseSha: optionalString,
});

const workspaceCommittedPayloadSchema = strict({
  attempt: z.number().int().positive(),
  generation: z.number().int().positive(),
  sha: z.string(),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

const workspaceRemovedPayloadSchema = strict({ dir: z.string() });

const contextReadPayloadSchema = strict({
  scope: z.enum(["project", "workflow"]),
  watermark: z.number().int().nonnegative(),
});

const contextWrittenPayloadSchema = strict({
  scope: z.enum(["project", "workflow"]),
  entryId: z.string(),
  topic: z.string(),
  kind: z.enum(["append", "supersede", "propose"]),
  status: z.string(),
});

const pinUsedPayloadSchema = strict({
  nodeId: z.string(),
  fromRunId: z.string(),
});

const supervisorWokePayloadSchema = strict({
  wakeId: z.string(),
  reasons: z.array(z.string()),
  digestHash: z.string(),
});

const supervisorRecommendedPayloadSchema = strict({
  recId: z.string(),
  action: z.string(),
  args: jsonValueSchema,
  confidence: z.number().optional(),
  reasoning: z.string(),
});

const supervisorAppliedPayloadSchema = strict({
  recId: z.string(),
  action: z.string(),
  outcome: z.string(),
});

const supervisorDismissedPayloadSchema = strict({ recId: z.string() });

const checkpointOpenedPayloadSchema = strict({
  reason: z.literal("supervise_checkpoint"),
});

const checkpointClosedPayloadSchema = strict({
  outcome: z.enum(["proceed", "retry", "escalated", "user"]),
});

const errorLoggedPayloadSchema = strict({
  code: coreErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});

/** One schema per known `EventEnvelope.type` payload (spec catalog). */
export const eventPayloadSchemas = {
  "run.created": runCreatedPayloadSchema,
  "run.started": runStartedPayloadSchema,
  "run.paused": runPausedPayloadSchema,
  "run.resumed": runResumedPayloadSchema,
  "run.cancelled": runCancelledPayloadSchema,
  "run.completed": runCompletedPayloadSchema,
  "run.override.added": runOverrideAddedPayloadSchema,
  "node.state": nodeStatePayloadSchema,
  "node.attempt.started": nodeAttemptStartedPayloadSchema,
  "node.session.captured": nodeSessionCapturedPayloadSchema,
  "node.input.resolved": nodeInputResolvedPayloadSchema,
  "node.output.rejected": nodeOutputRejectedPayloadSchema,
  "node.output.validated": nodeOutputValidatedPayloadSchema,
  "node.output.recorded": nodeOutputRecordedPayloadSchema,
  "node.usage": nodeUsagePayloadSchema,
  "node.transcript.ref": nodeTranscriptRefPayloadSchema,
  "node.watchdog": nodeWatchdogPayloadSchema,
  "node.process.spawned": nodeProcessSpawnedPayloadSchema,
  "node.process.stopped": nodeProcessStoppedPayloadSchema,
  "node.workspace.finalized": nodeWorkspaceFinalizedPayloadSchema,
  "gate.decided": gateDecidedPayloadSchema,
  "decision.requested": decisionRequestedPayloadSchema,
  "decision.answered": decisionAnsweredPayloadSchema,
  "approval.requested": approvalRequestedPayloadSchema,
  "approval.resolved": approvalResolvedPayloadSchema,
  "map.started": mapStartedPayloadSchema,
  "map.item.state": mapItemStatePayloadSchema,
  "map.completed": mapCompletedPayloadSchema,
  "loop.round.started": loopRoundStartedPayloadSchema,
  "loop.round.completed": loopRoundCompletedPayloadSchema,
  "loop.exited": loopExitedPayloadSchema,
  "join.resolved": joinResolvedPayloadSchema,
  "quota.blocked": quotaBlockedPayloadSchema,
  "quota.released": quotaReleasedPayloadSchema,
  "budget.threshold": budgetThresholdPayloadSchema,
  "budget.exceeded": budgetExceededPayloadSchema,
  "workspace.created": workspaceCreatedPayloadSchema,
  "workspace.committed": workspaceCommittedPayloadSchema,
  "workspace.removed": workspaceRemovedPayloadSchema,
  "context.read": contextReadPayloadSchema,
  "context.written": contextWrittenPayloadSchema,
  "pin.used": pinUsedPayloadSchema,
  "supervisor.woke": supervisorWokePayloadSchema,
  "supervisor.recommended": supervisorRecommendedPayloadSchema,
  "supervisor.applied": supervisorAppliedPayloadSchema,
  "supervisor.dismissed": supervisorDismissedPayloadSchema,
  "checkpoint.opened": checkpointOpenedPayloadSchema,
  "checkpoint.closed": checkpointClosedPayloadSchema,
  "error.logged": errorLoggedPayloadSchema,
} satisfies Record<KnownEventType, z.ZodType>;

const envelopeBaseShape = {
  id: eventIdSchema,
  runId: runIdSchema,
  ts: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO timestamp"),
  path: pathSchema,
  actor: actorSchema,
};

const knownEnvelopes = EVENT_TYPES.map((type) =>
  strict({
    ...envelopeBaseShape,
    type: z.literal(type),
    v: z.literal(1),
    payload: eventPayloadSchemas[type],
  }),
);

export const knownEventEnvelopeSchema = z.union(
  knownEnvelopes as [(typeof knownEnvelopes)[number], ...(typeof knownEnvelopes)[number][]],
);

/**
 * Forward-compatible envelope for a future event type or a newer payload
 * version. `v = 1` for a known type must use its typed schema.
 */
export const unknownEventEnvelopeSchema = strict({
  ...envelopeBaseShape,
  type: z.string().min(1),
  v: z.number().int().min(1),
  payload: z.unknown(),
}).superRefine((value, ctx) => {
  if (value.v === 1 && isKnownEventType(value.type)) {
    ctx.addIssue({
      code: "custom",
      message: "Known event types at v=1 must use their typed payload schema",
      path: ["type"],
    });
  }
});

export const eventEnvelopeSchema = z.union([knownEventEnvelopeSchema, unknownEventEnvelopeSchema]);

export const eventTypeSchema = z
  .string()
  .refine((value): value is KnownEventType => isKnownEventType(value), "Unknown event type")
  .transform((value) => value as EventType);

export const runEventsQuerySchema = strict({
  after: z.coerce.number().int().nonnegative().optional(),
  upTo: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  types: z
    .preprocess(
      (value) =>
        typeof value === "string"
          ? value
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
          : value,
      z.array(eventTypeSchema).optional(),
    )
    .optional(),
  pathPrefix: z
    .string()
    .superRefine((value, ctx) => {
      const parsed = parsePath(value);
      if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error.message });
    })
    .optional(),
});

export type RunEventsQuery = z.infer<typeof runEventsQuerySchema>;

export interface EventPageResponse {
  events: EventEnvelope[];
  nextAfter: number;
  hasMore: boolean;
  watermark: number;
}

export const eventPageResponseSchema = z.strictObject({
  events: z.array(eventEnvelopeSchema),
  nextAfter: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  watermark: z.number().int().nonnegative(),
}) as unknown as z.ZodType<EventPageResponse>;
