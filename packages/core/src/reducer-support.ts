import { RelayError } from "./error.js";
import type { EventEnvelope, NodeKind } from "./events.js";
import type { Path } from "./path.js";
import { parsePath } from "./path.js";
import { type ExecView, isDurablyComplete, type RunView } from "./reducer-types.js";
import type { ExecStatus } from "./transitions.js";

export function internal(message: string, details?: unknown): RelayError {
  return new RelayError("E_INTERNAL", message, details === undefined ? {} : { details });
}

export function eventTime(envelope: EventEnvelope): number {
  const time = Date.parse(envelope.ts);
  return Number.isFinite(time) ? time : 0;
}

export function nodeIdForPath(path: Path): string {
  const parsed = parsePath(path);
  if (!parsed.ok) throw internal(`Event path is invalid: ${path}`, parsed.error.toJSON());
  const last = parsed.value.at(-1);
  if (last === undefined) throw internal("Node event cannot use the run-level path");
  return last.node;
}

export function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw internal(`${name} must be a positive integer`, { value });
  }
}

export function withEventId(view: RunView, envelope: EventEnvelope): RunView {
  return { ...view, lastEventId: envelope.id };
}

export function updateExec(
  view: RunView,
  key: string,
  update: (exec: ExecView) => ExecView,
): RunView {
  const current = view.executions[key];
  if (current === undefined) return view;
  const next = update(current);
  if (next === current) return view;
  return { ...view, executions: { ...view.executions, [key]: next } };
}

export function assertIdentity(
  exec: { attempt: number; generation: number },
  type: string,
  payload: { attempt: number; generation: number },
): void {
  positive(payload.attempt, "Attempt");
  positive(payload.generation, "Generation");
  if (payload.attempt !== exec.attempt) {
    throw internal(`${type} is fenced: logical attempt does not match`, {
      type,
      expected: exec.attempt,
      received: payload.attempt,
    });
  }
  if (payload.generation !== exec.generation) {
    throw internal(`${type} is fenced: process generation does not match`, {
      type,
      expected: exec.generation,
      received: payload.generation,
    });
  }
}

export function assertRunCompletionLegal(view: RunView): void {
  const active = new Set<ExecStatus>([
    "pending",
    "ready",
    "running",
    "validating",
    "waiting_approval",
    "waiting_quota",
    "interrupted",
  ]);
  for (const exec of Object.values(view.executions)) {
    if (active.has(exec.status)) {
      throw internal("Run cannot succeed while an execution is still active", {
        path: exec.path,
        status: exec.status,
      });
    }
    if (exec.acceptedResult !== null && exec.status !== "succeeded") {
      throw internal("An accepted result exists but the execution is not succeeded", {
        path: exec.path,
        status: exec.status,
        outputId: exec.acceptedResult.outputId,
      });
    }
    if (exec.status === "succeeded" && !isDurablyComplete(exec)) {
      throw internal(
        exec.kind === "shell"
          ? "Shell execution succeeded without recorded output, process stop and workspace finalization"
          : "Execution succeeded without a durably finalized accepted result",
        { path: exec.path, kind: exec.kind },
      );
    }
  }
}

export function settleActive(view: RunView, at: number): RunView {
  if (view.activeSince === null) return view;
  return {
    ...view,
    budget: {
      ...view.budget,
      activeMs: view.budget.activeMs + Math.max(0, at - view.activeSince),
    },
    activeSince: null,
  };
}

export function newNodeExec(
  path: Path,
  nodeId: string,
  attempt: number,
  generation: number,
  init: { kind: NodeKind; requireSubmission: boolean } | undefined,
): ExecView {
  return {
    path,
    nodeId,
    status: "pending",
    attempt,
    generation,
    kind: init?.kind ?? null,
    gateDecision: null,
    joinResolution: null,
    approvalRequest: null,
    approvalDecision: null,
    requiresAcceptedResult:
      init === undefined ? false : init.requireSubmission || init.kind === "agent",
    acceptedResult: null,
    recordedOutput: null,
    processSpawned: null,
    processStopped: null,
    workspaceFinalized: null,
    validationAttempts: 0,
    crashAttempts: 0,
    mode: null,
    cli: null,
    sessionId: null,
    sessionCwd: null,
    model: null,
    resolvedConfigHash: null,
    inputsHash: null,
    startedAt: null,
    endedAt: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    attemptTokensIn: 0,
    attemptTokensOut: 0,
    attemptCostUsd: 0,
    workspaceDir: null,
    branch: null,
    workspaceCommitted: null,
    lastValidationErrors: [],
    lastTranscript: null,
    lastError: null,
  };
}
