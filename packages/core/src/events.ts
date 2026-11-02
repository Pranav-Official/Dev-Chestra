import type { ErrorCode } from "./error.js";
import type { RunId } from "./ids.js";
import type { Path } from "./path.js";
import type { ExecStatus } from "./transitions.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Actor = "engine" | "scheduler" | "user" | "supervisor" | "agent" | "system";

export type NodeKind =
  | "start"
  | "agent"
  | "shell"
  | "end"
  | "gate"
  | "join"
  | "approval"
  | "decision"
  | "map"
  | "loop"
  | "workflow"
  | "foreach"
  | "supervisor";

export type RunKind = "run" | "node_test" | "poll_probe";
export type RunPauseReason =
  | "quota"
  | "budget"
  | "user"
  | "approval_cap"
  | "shutdown"
  | "uncertain_side_effect";
export type RunCompletionStatus = "success" | "failed" | "rejected" | "cancelled";

export interface SerializedError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface RunCreatedPayload {
  workflowId: string;
  workflowHash: string;
  runNumber: number;
  params: JsonObject;
  budgets: JsonObject;
  baseSha?: string;
  kind: RunKind;
}

export interface RunPausedPayload {
  reason: RunPauseReason;
  detail?: string;
  path?: Path;
}

export interface RunResumedPayload {
  reason: string;
}

export interface RunCancelledPayload {
  by: string;
}

export interface RunCompletedPayload {
  status: RunCompletionStatus;
  endPath?: Path;
  result?: unknown;
  error?: SerializedError;
}

export interface RunOverrideAddedPayload {
  nodeId: string;
  kind: "prompt_addendum" | "param";
  value: JsonValue;
  reason: string;
}

export interface NodeStateInit {
  kind: NodeKind;
  requireSubmission: boolean;
}

export interface NodeStatePayload {
  from: ExecStatus;
  to: ExecStatus;
  reason?: string;
  attempt: number;
  generation: number;
  init?: NodeStateInit;
}

export interface NodeAttemptStartedPayload {
  attempt: number;
  generation: number;
  mode: "fresh" | "resume";
  cli?: string;
  model?: string;
  resolvedConfigHash: string;
  nodeKind?: NodeKind;
  requireSubmission?: boolean;
}

export interface NodeSessionCapturedPayload {
  attempt: number;
  generation: number;
  cli: string;
  sessionId: string;
  cwd: string;
  model?: string;
}

export interface NodeInputResolvedPayload {
  attempt: number;
  generation: number;
  inputsHash: string;
  inputs?: JsonValue;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface NodeOutputRejectedPayload {
  attempt: number;
  generation: number;
  validationAttempt: number;
  errors: ValidationIssue[];
}

export interface NodeOutputValidatedPayload {
  attempt: number;
  generation: number;
  outputId: string;
  outputHash: string;
  schemaHash?: string;
}

export interface NodeOutputRecordedPayload {
  attempt: number;
  generation: number;
  outputId: string;
  outputHash: string;
}

export interface NodeUsagePayload {
  attempt: number;
  generation: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  costSource: "reported" | "estimated" | "none";
}

export interface NodeTranscriptRefPayload {
  attempt: number;
  generation: number;
  file: string;
  bytes: number;
}

export interface NodeWatchdogPayload {
  attempt: number;
  generation: number;
  kind: "timeout" | "silence" | "repeat" | "cost";
  detail: string;
}

export type ProcessStopReason = "exited" | "killed" | "grace_timeout" | "crash";

export interface NodeProcessSpawnedPayload {
  attempt: number;
  generation: number;
  pid: number;
  pidStart: string;
  binary: string;
  cwd: string;
}

export interface NodeProcessStoppedPayload {
  attempt: number;
  generation: number;
  reason: ProcessStopReason;
  exitCode?: number | null;
}

export interface NodeWorkspaceFinalizedPayload {
  attempt: number;
  generation: number;
  dir: string;
  commitSha?: string;
}

export interface GateEvaluationEntry {
  branch: string;
  matched: boolean;
  error?: string;
}

export interface GateDecidedPayload {
  /** Null when evaluation failed; the gate and run fail instead of falling through. */
  branch: string | null;
  evaluated: GateEvaluationEntry[];
  /** Engine-emitted invocation fence; optional for older events. */
  attempt?: number;
  generation?: number;
}

export interface DecisionRequestedPayload {
  provider: string;
  model: string;
  questionIds: string[];
  /** Engine-emitted invocation fence; optional for older events. */
  attempt?: number;
  generation?: number;
}

/** Normalized model answer for one decision question (contract section 4). */
export interface DecisionOutput {
  kind: "boolean" | "choice" | "score";
  /** boolean: probability >= 0.5; choice: option; score: level label at round(score); null when refused. */
  value: boolean | string | null;
  /** boolean only: P(true). */
  probability?: number;
  /** score only: fractional, 0-based. */
  score?: number;
  /** choice: by option; score: by level label. */
  probabilities?: Record<string, number>;
  /** null compares false in expressions. */
  confidence: number | null;
  confidenceSource: "provider" | "derived" | null;
  refusal?: { reason?: string };
  /** Resolved model from the provider response. */
  model: string;
}

export type DecisionRoutingReason = "matched" | "low_confidence" | "refused" | "error";

export interface DecisionAnsweredPayload {
  /** Legacy provider answers; optional so new output-first events still parse. */
  answers?: {
    id: string;
    kind: string;
    value: JsonValue;
    confidence?: number;
    probabilities?: Record<string, number>;
    refusal?: string;
  }[];
  latencyMs?: number;
  raw?: JsonValue;
  /** Normalized answer; present on new events, absent on legacy ones. */
  output?: DecisionOutput;
  routing?: { branch: string | null; reason: DecisionRoutingReason };
  usage?: { inputTokens: number; outputTokens: number };
  /** Engine-emitted invocation fence; optional for older events. */
  attempt?: number;
  generation?: number;
}

export interface ApprovalRequestedPayload {
  message: string;
  irreversible: boolean;
  /** Optional human criteria from ApprovalNode.criteria (string[]) */
  criteria?: string[];
  /** Stable server-issued identity; fencing + stale-UI protection */
  requestId?: string;
  /** Invocation fence; optional for legacy events */
  attempt?: number;
  generation?: number;
  /** Legacy; always false because approvals are human-only. */
  autoApprove?: boolean;
  minConfidence?: number;
}

export interface ApprovalResolvedPayload {
  decision: "approve" | "reject";
  by: string;
  note?: string;
  /** Must match the requestId from approval.requested */
  requestId?: string;
  attempt?: number;
  generation?: number;
  edited?: boolean;
}

export interface MapStartedPayload {
  itemCount: number;
  concurrency: number;
  labels: string[];
}

export interface MapItemStatePayload {
  index: number;
  status: string;
  error?: string;
}

export interface MapCompletedPayload {
  done: number;
  failed: number;
  outputId: string;
}

export interface LoopRoundStartedPayload {
  round: number;
  carryHash: string;
}

export interface LoopRoundCompletedPayload {
  round: number;
  exitMatched: boolean;
  stalled?: boolean;
}

export interface LoopExitedPayload {
  reason: "condition" | "max_rounds" | "stalled";
  rounds: number;
}

export type WorkflowChildStatus = "succeeded" | "failed" | "rejected" | "cancelled";

export interface WorkflowLinkedPayload {
  childRunId: string;
  workflowId: string;
  workflowHash: string;
  attempt: number;
  generation: number;
}

export interface WorkflowCompletedPayload {
  childRunId: string;
  status: WorkflowChildStatus;
  /** Durable output id for the child envelope (small ref, never hydrated result). */
  resultRef: string | null;
  attempt: number;
  generation: number;
}

export interface ForeachStartedPayload {
  total: number;
  maxItems: number;
  /** Durable foreach_sources row id; event never carries items. */
  sourceId: string;
  sourceHash: string;
  /** Optional immutable parent capture ref (resolved from foreach_sources on resume). */
  parentRef?: { kind: "devchestra.execution-context/v1"; captureId: string };
  attempt: number;
  generation: number;
}

export type ForeachItemStatus = "succeeded" | "failed" | "rejected" | "skipped";

export interface ForeachItemDecidedPayload {
  index: number;
  status: ForeachItemStatus;
  /** Durable foreach_items ref (output id) for the mapped per-item result. */
  resultRef?: string | null;
  attempt: number;
  generation: number;
}

export interface LoopStartedPayload {
  /** Always 1; the controller starts iteration 1 once, idempotently. */
  iteration: number;
  /** Legacy inline parent scope (events written before reference-backed captures). */
  parent?: JsonObject;
  /**
   * Reference-backed parent capture (new events). Tagged and versioned; the
   * manifest lives in context_captures, never in the event payload.
   * Exactly one of `parent` / `parentRef` is present on valid events.
   */
  parentRef?: { kind: "devchestra.execution-context/v1"; captureId: string };
  /** Initial carried state for iteration 1. */
  state: JsonObject;
  /** Engine-emitted invocation fence; optional for older events. */
  attempt?: number;
  generation?: number;
}

/**
 * Why a loop reached its terminal round. `done` keeps meaning "the stop
 * condition matched"; `iteration_limit` is a budget-exhausted terminal round
 * (`done=false`) that routes downstream instead of failing the run.
 */
export type LoopOutcome = "condition_met" | "iteration_limit";

export const LOOP_OUTCOMES: readonly LoopOutcome[] = ["condition_met", "iteration_limit"];

export interface LoopIterationDecidedPayload {
  /** 1-based round this decision belongs to; round != retry attempt. */
  iteration: number;
  /** Validated body result for the round. */
  result: JsonValue;
  /** True when the stop condition matched; false to continue. */
  done: boolean;
  /** Carried state for the next round; absent retains current state. */
  nextState?: JsonObject;
  /**
   * Explicit terminal outcome. `condition_met` requires `done=true`;
   * `iteration_limit` requires `done=false` and no `nextState`. Absent on
   * continuing rounds and on legacy events (`done=true` then implies
   * `condition_met`).
   */
  outcome?: LoopOutcome;
  /** Engine-emitted invocation fence; optional for older events. */
  attempt?: number;
  generation?: number;
}

export interface JoinResolvedPayload {
  mode: string;
  /** Resolved input names that were active. */
  active: string[];
  /** Declared input names that were dead/skipped. */
  skipped: string[];
  /** Engine-emitted invocation fence; optional for older events. */
  attempt?: number;
  generation?: number;
}

export interface QuotaBlockedPayload {
  provider: string;
  kind: "window" | "credits" | "auth" | "rate_limit";
  resumeAt?: number;
  resumeAtSource: "parsed" | "estimated" | "unknown";
}

export interface QuotaReleasedPayload {
  provider: string;
  by: "timer" | "user" | "probe";
}

export interface BudgetThresholdPayload {
  budget: "usd" | "tokens" | "minutes" | "supervisor_usd";
  ratio: number;
}

export interface BudgetExceededPayload {
  budget: "usd" | "tokens" | "minutes" | "supervisor_usd";
  limit: number;
  value: number;
}

export interface WorkspaceCreatedPayload {
  attempt: number;
  generation: number;
  mode: string;
  dir: string;
  branch?: string;
  baseSha?: string;
}

export interface WorkspaceCommittedPayload {
  attempt: number;
  generation: number;
  sha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface WorkspaceRemovedPayload {
  dir: string;
}

export interface ContextReadPayload {
  scope: "project" | "workflow";
  watermark: number;
}

export interface ContextWrittenPayload {
  scope: "project" | "workflow";
  entryId: string;
  topic: string;
  kind: "append" | "supersede" | "propose";
  status: string;
}

export interface PinUsedPayload {
  nodeId: string;
  fromRunId: string;
}

export interface SupervisorWokePayload {
  wakeId: string;
  reasons: string[];
  digestHash: string;
}

export interface SupervisorRecommendedPayload {
  recId: string;
  action: string;
  args: JsonValue;
  confidence?: number;
  reasoning: string;
}

export interface SupervisorAppliedPayload {
  recId: string;
  action: string;
  outcome: string;
}

export interface SupervisorDismissedPayload {
  recId: string;
}

export interface CheckpointOpenedPayload {
  reason: "supervise_checkpoint";
}

export interface CheckpointClosedPayload {
  outcome: "proceed" | "retry" | "escalated" | "user";
}

export interface ErrorLoggedPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export const EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.workspace_waiting",
  "run.paused",
  "run.resumed",
  "run.cancelled",
  "run.completed",
  "run.override.added",
  "node.state",
  "node.attempt.started",
  "node.session.captured",
  "node.input.resolved",
  "node.output.rejected",
  "node.output.validated",
  "node.output.recorded",
  "node.usage",
  "node.transcript.ref",
  "node.watchdog",
  "node.process.spawned",
  "node.process.stopped",
  "node.workspace.finalized",
  "gate.decided",
  "decision.requested",
  "decision.answered",
  "approval.requested",
  "approval.resolved",
  "map.started",
  "map.item.state",
  "map.completed",
  "loop.round.started",
  "loop.round.completed",
  "loop.exited",
  "loop.started",
  "loop.iteration.decided",
  "workflow.linked",
  "workflow.completed",
  "foreach.started",
  "foreach.item.decided",
  "join.resolved",
  "quota.blocked",
  "quota.released",
  "budget.threshold",
  "budget.exceeded",
  "workspace.created",
  "workspace.committed",
  "workspace.removed",
  "context.read",
  "context.written",
  "pin.used",
  "supervisor.woke",
  "supervisor.recommended",
  "supervisor.applied",
  "supervisor.dismissed",
  "checkpoint.opened",
  "checkpoint.closed",
  "error.logged",
] as const;

export type KnownEventType = (typeof EVENT_TYPES)[number];

export interface EventPayloads {
  "run.created": RunCreatedPayload;
  "run.started": Record<string, never>;
  "run.workspace_waiting": Record<string, never>;
  "run.paused": RunPausedPayload;
  "run.resumed": RunResumedPayload;
  "run.cancelled": RunCancelledPayload;
  "run.completed": RunCompletedPayload;
  "run.override.added": RunOverrideAddedPayload;
  "node.state": NodeStatePayload;
  "node.attempt.started": NodeAttemptStartedPayload;
  "node.session.captured": NodeSessionCapturedPayload;
  "node.input.resolved": NodeInputResolvedPayload;
  "node.output.rejected": NodeOutputRejectedPayload;
  "node.output.validated": NodeOutputValidatedPayload;
  "node.output.recorded": NodeOutputRecordedPayload;
  "node.usage": NodeUsagePayload;
  "node.transcript.ref": NodeTranscriptRefPayload;
  "node.watchdog": NodeWatchdogPayload;
  "node.process.spawned": NodeProcessSpawnedPayload;
  "node.process.stopped": NodeProcessStoppedPayload;
  "node.workspace.finalized": NodeWorkspaceFinalizedPayload;
  "gate.decided": GateDecidedPayload;
  "decision.requested": DecisionRequestedPayload;
  "decision.answered": DecisionAnsweredPayload;
  "approval.requested": ApprovalRequestedPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "map.started": MapStartedPayload;
  "map.item.state": MapItemStatePayload;
  "map.completed": MapCompletedPayload;
  "loop.round.started": LoopRoundStartedPayload;
  "loop.round.completed": LoopRoundCompletedPayload;
  "loop.exited": LoopExitedPayload;
  "loop.started": LoopStartedPayload;
  "loop.iteration.decided": LoopIterationDecidedPayload;
  "workflow.linked": WorkflowLinkedPayload;
  "workflow.completed": WorkflowCompletedPayload;
  "foreach.started": ForeachStartedPayload;
  "foreach.item.decided": ForeachItemDecidedPayload;
  "join.resolved": JoinResolvedPayload;
  "quota.blocked": QuotaBlockedPayload;
  "quota.released": QuotaReleasedPayload;
  "budget.threshold": BudgetThresholdPayload;
  "budget.exceeded": BudgetExceededPayload;
  "workspace.created": WorkspaceCreatedPayload;
  "workspace.committed": WorkspaceCommittedPayload;
  "workspace.removed": WorkspaceRemovedPayload;
  "context.read": ContextReadPayload;
  "context.written": ContextWrittenPayload;
  "pin.used": PinUsedPayload;
  "supervisor.woke": SupervisorWokePayload;
  "supervisor.recommended": SupervisorRecommendedPayload;
  "supervisor.applied": SupervisorAppliedPayload;
  "supervisor.dismissed": SupervisorDismissedPayload;
  "checkpoint.opened": CheckpointOpenedPayload;
  "checkpoint.closed": CheckpointClosedPayload;
  "error.logged": ErrorLoggedPayload;
}

export type EventType = KnownEventType | (string & {});

export interface EventEnvelopeBase {
  readonly id: number;
  readonly runId: RunId;
  readonly ts: string;
  readonly path: Path;
  readonly actor: Actor;
}

export type EventEnvelope<T extends EventType = EventType> = EventEnvelopeBase & {
  readonly type: T;
  readonly v: number;
  readonly payload: T extends KnownEventType ? EventPayloads[T] : unknown;
};

export type KnownEventEnvelope<T extends KnownEventType = KnownEventType> = EventEnvelope<T> & {
  readonly v: 1;
};

export type UnknownEventEnvelope = EventEnvelopeBase & {
  readonly type: string;
  readonly v: number;
  readonly payload: unknown;
};

export interface EventDraft<T extends KnownEventType = KnownEventType> {
  readonly runId: RunId;
  readonly path: Path;
  readonly type: T;
  readonly actor: Actor;
  readonly v?: 1;
  readonly payload: EventPayloads[T];
  readonly ts?: string;
}

export type EventDraftInput = EventDraft;

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isKnownEventType(value: string): value is KnownEventType {
  return KNOWN_EVENT_TYPES.has(value);
}
