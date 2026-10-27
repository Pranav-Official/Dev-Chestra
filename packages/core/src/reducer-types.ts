import type { ErrorCode } from "./error.js";
import type {
  GateDecidedPayload,
  JoinResolvedPayload,
  NodeKind,
  RunPauseReason,
  ValidationIssue,
} from "./events.js";
import type { ExecutionIdentity } from "./identity.js";
import type { RunId } from "./ids.js";
import type { Path } from "./path.js";
import type { ExecStatus, RunStatus } from "./transitions.js";

export interface AcceptedResultRef {
  runId: RunId;
  path: Path;
  outputId: string;
  outputHash: string;
  schemaHash: string | null;
  attempt: number;
  generation: number;
  acceptedEventId: number;
}

export interface ProcessSpawnedRef {
  attempt: number;
  generation: number;
  pid: number;
  pidStart: string;
  binary: string;
  cwd: string;
}

export interface ProcessStoppedRef {
  attempt: number;
  generation: number;
  reason: "exited" | "killed" | "grace_timeout" | "crash";
  exitCode: number | null;
}

export interface WorkspaceFinalizedRef {
  attempt: number;
  generation: number;
  dir: string;
  commitSha: string | null;
}

export interface WorkspaceCommittedView {
  sha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface TranscriptRefView {
  file: string;
  bytes: number;
}

export interface RecordedOutputRef {
  attempt: number;
  generation: number;
  outputId: string;
  outputHash: string;
  eventId: number;
}

export interface ExecErrorView {
  code: ErrorCode;
  message: string;
}

export interface ApprovalRequestRef {
  message: string;
  irreversible: boolean;
  criteria: string[] | null;
  requestId: string | null;
  attempt: number | null;
  generation: number | null;
  eventId: number;
}

export interface ApprovalDecisionRef {
  decision: "approve" | "reject";
  by: string;
  note: string | null;
  requestId: string | null;
  attempt: number | null;
  generation: number | null;
  eventId: number;
}

export interface ExecView {
  path: Path;
  nodeId: string;
  status: ExecStatus;
  attempt: number;
  generation: number;
  kind: NodeKind | null;
  gateDecision: GateDecidedPayload | null;
  joinResolution: JoinResolvedPayload | null;
  approvalRequest: ApprovalRequestRef | null;
  approvalDecision: ApprovalDecisionRef | null;
  requiresAcceptedResult: boolean;
  acceptedResult: AcceptedResultRef | null;
  recordedOutput: RecordedOutputRef | null;
  processSpawned: ProcessSpawnedRef | null;
  processStopped: ProcessStoppedRef | null;
  workspaceFinalized: WorkspaceFinalizedRef | null;
  validationAttempts: number;
  crashAttempts: number;
  mode: "fresh" | "resume" | null;
  cli: string | null;
  sessionId: string | null;
  sessionCwd: string | null;
  model: string | null;
  resolvedConfigHash: string | null;
  inputsHash: string | null;
  startedAt: number | null;
  endedAt: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  attemptTokensIn: number;
  attemptTokensOut: number;
  attemptCostUsd: number;
  workspaceDir: string | null;
  branch: string | null;
  workspaceCommitted: WorkspaceCommittedView | null;
  lastValidationErrors: ValidationIssue[];
  lastTranscript: TranscriptRefView | null;
  lastError: ExecErrorView | null;
}

export interface ProviderView {
  blockedUntil: number | null;
  kind: string | null;
  source: string | null;
  reason: string | null;
}

export interface RecView {
  id: string;
  action: string;
  status: "open" | "applied" | "dismissed" | "expired";
}

export interface RunBudgetView {
  usd: number;
  tokens: number;
  activeMs: number;
  supervisorUsd: number;
}

export interface RunErrorView {
  eventId: number;
  ts: string;
  path: Path;
  code: ErrorCode;
  message: string;
  details: unknown;
}

export interface SupervisorView {
  wakes: number;
  interventions: number;
  recs: RecView[];
}

export type EdgeState = "pending" | "active" | "dead";

export interface RunView {
  status: RunStatus;
  runNumber: number;
  executions: Record<string, ExecView>;
  edges: Record<string, EdgeState>;
  providers: Record<string, ProviderView>;
  budget: RunBudgetView;
  activeSince: number | null;
  pausedAt: number | null;
  pausedMs: number;
  pauseReason: RunPauseReason | null;
  pauseDetail: string | null;
  pausePath: Path | null;
  supervisor: SupervisorView;
  errors: RunErrorView[];
  lastEventId: number;
}

export function emptyRunView(): RunView {
  return {
    status: "queued",
    runNumber: 0,
    executions: {},
    edges: {},
    providers: {},
    budget: { usd: 0, tokens: 0, activeMs: 0, supervisorUsd: 0 },
    activeSince: null,
    pausedAt: null,
    pausedMs: 0,
    pauseReason: null,
    pauseDetail: null,
    pausePath: null,
    supervisor: { wakes: 0, interventions: 0, recs: [] },
    errors: [],
    lastEventId: 0,
  };
}

export function acceptedInvocation(ref: AcceptedResultRef): ExecutionIdentity {
  return {
    runId: ref.runId,
    path: ref.path,
    attempt: ref.attempt,
    generation: ref.generation,
  };
}

/**
 * A result is durably complete only when the accepted result has both a
 * process-stop marker and a workspace-finalization marker for the accepted
 * attempt and the original invocation generation. The existence of an output
 * row alone is never completion.
 */
export function isDurablyComplete(exec: ExecView): boolean {
  if (exec.acceptedResult !== null || exec.requiresAcceptedResult) {
    if (exec.requiresAcceptedResult && exec.acceptedResult === null) return false;
    const accepted = exec.acceptedResult;
    if (accepted === null) return false;
    if (accepted.attempt !== exec.attempt) return false;
    if (accepted.generation !== exec.generation) return false;
    const stopped = exec.processStopped;
    if (
      stopped === null ||
      stopped.attempt !== accepted.attempt ||
      stopped.generation !== accepted.generation
    ) {
      return false;
    }
    const finalized = exec.workspaceFinalized;
    return (
      finalized !== null &&
      finalized.attempt === accepted.attempt &&
      finalized.generation === accepted.generation
    );
  }
  if (exec.kind === "shell" || exec.kind === "start" || exec.kind === "end") {
    const recorded = exec.recordedOutput;
    if (
      recorded === null ||
      recorded.attempt !== exec.attempt ||
      recorded.generation !== exec.generation
    ) {
      return false;
    }
    if (exec.kind !== "shell") return true;
    const stopped = exec.processStopped;
    if (
      stopped === null ||
      stopped.attempt !== exec.attempt ||
      stopped.generation !== exec.generation
    ) {
      return false;
    }
    const finalized = exec.workspaceFinalized;
    return (
      finalized !== null &&
      finalized.attempt === exec.attempt &&
      finalized.generation === exec.generation
    );
  }
  return true;
}

export type RecoveryDecision = {
  action: "mark_succeeded" | "interrupt" | "make_ready" | "leave";
  from: ExecStatus;
  to: ExecStatus;
  reason?: "crash";
};

export function recoveryDecision(exec: ExecView): RecoveryDecision {
  if (exec.status === "running" || exec.status === "validating") {
    if ((exec.acceptedResult !== null || exec.kind === "shell") && isDurablyComplete(exec)) {
      return { action: "mark_succeeded", from: exec.status, to: "succeeded" };
    }
    return { action: "interrupt", from: exec.status, to: "interrupted", reason: "crash" };
  }
  if (exec.status === "interrupted") {
    return { action: "make_ready", from: "interrupted", to: "ready" };
  }
  return { action: "leave", from: exec.status, to: exec.status };
}
