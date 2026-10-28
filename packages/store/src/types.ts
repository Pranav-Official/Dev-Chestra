import type {
  Clock,
  EventDraft,
  EventEnvelope,
  EventType,
  ExecutionIdentity,
  IdGen,
  JsonObject,
  NodeKind,
  Path,
  RecoveryDecision,
  RunId,
  RunStatus,
  RunView,
  RunWorkspaceBinding,
} from "@relay/core";
import type { SqliteDriver } from "./driver.js";

export interface OpenStoreOptions {
  /** Path to the database file. Tests use a real file under mkdtemp. */
  file: string;
  /** Defaults to better-sqlite3; pass nodeSqliteDriver for the local fallback. */
  driver?: SqliteDriver;
  clock?: Clock;
  idGen?: IdGen;
  /** Registered secret values (in memory only) rejected/redacted before any write. */
  secrets?: readonly string[];
}

export interface EnsureProjectInput {
  id: string;
  name: string;
  path: string;
  kind: "git" | "folder";
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  kind: "git" | "folder";
  addedAt: number;
  nextRunNumber: number;
  missing: boolean;
}

/** Server has already validated the filesystem path; the store only updates metadata. */
export interface RelinkProjectInput {
  projectId: string;
  path: string;
  name?: string;
  kind?: "git" | "folder";
  missing?: boolean;
}

/** Trusted caller-supplied launch metadata. The store never recomputes the fingerprint. */
export interface IdempotencyInput {
  /** Defaults to projectId. A different scope is rejected so keys cannot cross projects. */
  scope?: string;
  key: string;
  fingerprint: string;
}

export interface CreateRunInput {
  projectId: string;
  workflowId: string;
  workflowHash: string;
  /** Normalized workflow snapshot; serialized verbatim. */
  snapshot: unknown;
  /** Original workflow file text. */
  snapshotRaw: string;
  params?: JsonObject;
  budgets?: JsonObject;
  baseSha?: string;
  kind?: "run" | "node_test";
  /** Frozen run-level workspace choice. Omit only for legacy/manual runs. */
  workspace?: RunWorkspaceBinding;
  /** Optional durable idempotency claim, committed atomically with the run. */
  idempotency?: IdempotencyInput;
}

export interface CreateRunResult {
  runId: RunId;
  runNumber: number;
  /** True only when an unexpired idempotency key reused an existing run. */
  duplicate: boolean;
}

export interface EnsureExecutionInput {
  runId: RunId;
  path: Path;
  nodeId: string;
  kind?: NodeKind;
  /** Defaults to true for kind 'agent', false otherwise. */
  requireSubmission?: boolean;
  validationLimit?: number;
}

export interface BeginInvocationInput {
  runId: RunId;
  path: Path;
  attempt: number;
  pid?: number;
  lstart?: string;
  mode?: "fresh" | "resume";
  resolvedConfigHash?: string;
  /** Explicit user approval only; valid for an interrupted shell paused for uncertain side effects. */
  allowUncertainSideEffectRetry?: boolean;
  approvedBy?: string;
}

export interface SubmissionBase {
  identity: ExecutionIdentity;
  /** X-Relay-Call-Id. A transport retry MUST reuse it. */
  callId: string;
  /** Fingerprinted exactly (canonical JSON); never persisted itself. */
  request: unknown;
}

export interface ValidSubmission extends SubmissionBase {
  ok: true;
  output: unknown;
  schemaHash?: string;
}

export interface InvalidSubmission extends SubmissionBase {
  ok: false;
  /** Optional optimistic check; the store owns the durable next counter. */
  validationAttempt?: number;
  errors: readonly { path: string; message: string }[];
  errorCode?: string;
}

export type SubmitInput = ValidSubmission | InvalidSubmission;

export interface Receipt {
  runId: RunId;
  path: Path;
  attempt: number;
  generation: number;
  callId: string;
  requestFingerprint: string;
  ok: boolean;
  validationAttempt: number | null;
  validationAttemptsAfter: number;
  errorCode: string | null;
  errorMessage: string | null;
  outputId: string | null;
  eventId: number;
  createdAt: number;
}

export interface AcceptedOutput {
  id: string;
  runId: RunId;
  path: Path;
  attempt: number;
  generation: number;
  hash: string;
  bytes: number;
  json: unknown;
  createdAt: number;
}

export interface AcceptedSubmissionOutcome {
  kind: "accepted";
  /** True when the same callId+fingerprint was already committed. */
  duplicate: boolean;
  receipt: Receipt;
  output: AcceptedOutput;
  eventId: number;
}

export interface RejectedSubmissionOutcome {
  kind: "rejected";
  duplicate: boolean;
  receipt: Receipt;
  validationAttempt: number;
  validationAttemptsLeft: number;
  eventId: number;
}

export interface AlreadyAcceptedOutcome {
  kind: "already_accepted";
  output: AcceptedOutput;
  acceptedEventId: number;
}

export type SubmitOutcome =
  | AcceptedSubmissionOutcome
  | RejectedSubmissionOutcome
  | AlreadyAcceptedOutcome;

export interface ExecutionRow {
  runId: RunId;
  path: Path;
  nodeId: string;
  status: string;
  attempt: number;
  generation: number;
  kind: NodeKind | null;
  validationAttempts: number;
  validationLimit: number;
  crashAttempts: number;
  outputId: string | null;
  cli: string | null;
  sessionId: string | null;
  sessionCwd: string | null;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  workspaceDir: string | null;
  branch: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  lastEventId: number;
}

export interface ProcessRecord {
  identity: ExecutionIdentity;
  pid: number | null;
  pidStart: string | null;
  binary: string | null;
  cwd: string | null;
  startedAt: number;
  stoppedAt: number | null;
  stopReason: string | null;
  exitCode: number | null;
}

export interface ActiveProcess extends ProcessRecord {
  status: string;
}

export interface RecordSpawnedInput {
  identity: ExecutionIdentity;
  pid: number;
  pidStart: string;
  binary: string;
  cwd: string;
}

export interface RecordDeterministicOutputInput {
  identity: ExecutionIdentity;
  output: unknown;
}

export interface RecordDeterministicOutputResult {
  output: AcceptedOutput;
  eventId: number;
  duplicate: boolean;
}

export interface GateEvaluationInput {
  branch: string;
  matched: boolean;
  error?: string;
}

export interface RecordGateDecisionInput {
  identity: ExecutionIdentity;
  /** Null records an evaluation failure; the gate succeeds only for a branch. */
  branch: string | null;
  evaluated: readonly GateEvaluationInput[];
}

export interface RecordJoinResolutionInput {
  identity: ExecutionIdentity;
  mode: "first" | "all";
  /** Declared input names that received an active edge. */
  active: readonly string[];
  /** Declared input names whose inbound edge was dead. */
  skipped: readonly string[];
  /** Already resolved by the caller: first=active input output, all={input:output|null}. */
  output: unknown;
}

export interface RoutingCommitResult {
  /** Null for a failed gate decision, which never writes a success output. */
  output: AcceptedOutput | null;
  decisionEventId: number | null;
  completionEventId: number | null;
  duplicate: boolean;
}

export interface RunRecord {
  archivedAt?: number | null;
  id: RunId;
  project: { id: string; name: string; path: string; kind: "git" | "folder" };
  workflowId: string;
  runNumber: number;
  kind: "run" | "node_test";
  status: string;
  workflowHash: string;
  snapshot: unknown;
  snapshotRaw: string;
  params: JsonObject;
  budgets: JsonObject;
  baseSha: string | null;
  /** Null only for runs created before run-level workspaces existed. */
  workspace: RunWorkspaceBinding | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  pauseReason: string | null;
  costUsd: number;
  tokens: number;
  activeMs: number;
  pausedMs: number;
  supervisorUsd: number;
  result: unknown;
}

/** Lightweight run row for list endpoints; never includes the frozen snapshot. */
export interface RunSummary {
  archivedAt?: number | null;
  workflowName?: string | null;
  id: RunId;
  projectId: string;
  projectName: string;
  projectPath: string;
  projectKind: "git" | "folder";
  workflowId: string;
  workflowHash: string;
  runNumber: number;
  kind: "run" | "node_test";
  status: RunStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  pauseReason: string | null;
  costUsd: number;
  tokens: number;
  activeMs: number;
  pausedMs: number;
}

export interface RunListFilters {
  archived?: boolean;
  projectId?: string;
  workflowId?: string;
  /** One status or a list; empty means no status filter. */
  status?: RunStatus | readonly RunStatus[];
  cursor?: string;
  limit?: number;
}

export interface RunListPage {
  items: RunSummary[];
  nextCursor: string | null;
}

export interface RunSnapshot {
  runId: RunId;
  run: RunRecord;
  view: RunView;
  /** Max events.id included in `view`; captured in the same read transaction. */
  watermark: number;
}

export interface EventPageOptions {
  /** Numeric replay position. Mutually exclusive with `cursor`. */
  after?: number;
  cursor?: string;
  /** Inclusive upper bound; pins a backlog to a snapshot watermark. */
  upTo?: number;
  limit?: number;
  types?: readonly EventType[];
  /** Literal prefix. `%` and `_` are not wildcards. */
  pathPrefix?: string;
}

export interface EventPage {
  items: EventEnvelope[];
  nextCursor: string | null;
  /** Last returned event id (numeric equivalent for `?after=` clients). */
  nextAfter: number | null;
  /** Current max event id for the run, even when `upTo` is lower. */
  watermark: number;
}

export type OutputKind = "output" | "input" | "map_result" | "loop_carry";

export interface OutputRecord {
  id: string;
  runId: RunId;
  path: Path;
  attempt: number;
  generation: number;
  kind: OutputKind;
  hash: string;
  bytes: number;
  json: unknown;
  createdAt: number;
}

export interface OutputProvenanceQuery {
  runId: RunId;
  path?: Path;
  attempt?: number;
  generation?: number;
  kind?: OutputKind | readonly OutputKind[];
  cursor?: string;
  limit?: number;
}

export interface OutputProvenancePage {
  items: OutputRecord[];
  nextCursor: string | null;
}

export interface ProcessHistory {
  pid: number | null;
  pidStart: string | null;
  binary: string | null;
  cwd: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  stopReason: string | null;
  exitCode: number | null;
  spawnedEventId: number | null;
  stoppedEventId: number | null;
}

export interface ExecutionAttemptHistory {
  attempt: number;
  generation: number;
  mode: "fresh" | "resume" | null;
  startedAt: number | null;
  stoppedAt: number | null;
  stopReason: string | null;
  exitCode: number | null;
  cli: string | null;
  model: string | null;
  sessionId: string | null;
  /** Highest validation attempt seen for this logical attempt (0 = none). */
  validationAttempts: number;
  process: ProcessHistory | null;
}

export interface TranscriptHistory {
  attempt: number;
  generation: number;
  file: string;
  bytes: number;
  eventId: number;
  ts: number;
}

export interface ExecutionHistory {
  runId: RunId;
  path: Path;
  attempts: ExecutionAttemptHistory[];
  /** Newest first. */
  transcripts: TranscriptHistory[];
  latestTranscript: TranscriptHistory | null;
}

export interface RecordProcessStoppedInput {
  identity: ExecutionIdentity;
  reason: "exited" | "killed" | "grace_timeout" | "crash";
  exitCode?: number | null;
}

export interface RecordWorkspaceFinalizedInput {
  identity: ExecutionIdentity;
  dir: string;
  commitSha?: string;
}

export interface CompleteExecutionInput {
  identity: ExecutionIdentity;
}

export interface CompleteExecutionResult {
  status: "succeeded";
  eventId: number;
}

export interface CompleteAcceptedAfterRecoveryInput {
  identity: ExecutionIdentity;
  /** Evidence established at boot: the process no longer exists. */
  processStop: {
    reason: "exited" | "killed" | "grace_timeout" | "crash";
    exitCode?: number | null;
  };
  /** Evidence from an actually completed workspace finalization. */
  workspace: { dir: string; commitSha?: string };
}

export interface RequestApprovalInput {
  identity: ExecutionIdentity;
  message: string;
  irreversible?: boolean;
  criteria?: string[];
}
export interface RequestApprovalResult {
  duplicate: boolean;
  requestId: string;
  requestEventId: number | null;
  waitingEventId: number | null;
}
export interface ResolveApprovalInput {
  identity: ExecutionIdentity;
  requestId: string;
  decision: "approve" | "reject";
  by: string;
  note?: string;
}
export interface ResolveApprovalResult {
  duplicate: boolean;
  resolvedEventId: number | null;
  completionEventId: number | null;
  runCompletedEventId: number | null;
  output: { id: string; hash: string } | null;
}
export interface ApprovalRecord {
  runId: RunId;
  path: Path;
  attempt: number;
  generation: number;
  requestId: string;
  message: string;
  irreversible: boolean;
  criteria: string[] | null;
  requestedEventId: number;
  decision: "approve" | "reject" | null;
  by: string | null;
  note: string | null;
  resolvedEventId: number | null;
  status: string;
}
export interface ApprovalWake {
  runId: RunId;
  path: Path;
  attempt: number;
  generation: number;
  requestId: string;
  decision: "approve" | "reject";
}
export type { ListEventsOptions } from "./projection.js";

export interface RecoveredExecution {
  runId: RunId;
  path: Path;
  from: string;
  to: string;
  decision:
    | RecoveryDecision["action"]
    | "await_accepted_finalization"
    | "pause_uncertain_side_effect";
  applied: boolean;
  pauseReason?: string;
}

export interface RecoveryReport {
  runId: RunId;
  /** Projection was rebuilt from the full event log before decisions. */
  rebuilt: boolean;
  executions: RecoveredExecution[];
}

export type {
  Clock,
  EventDraft,
  EventEnvelope,
  EventType,
  ExecutionIdentity,
  IdGen,
  JsonObject,
  Path,
  RunId,
  RunView,
};
