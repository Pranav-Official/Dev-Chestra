import {
  type ExecStatus,
  type ExecutionIdentity,
  type ExecView,
  isCurrentInvocation,
  type Path,
  type RunId,
} from "@devchestra/core";
import { appendEvents } from "./events.js";
import { assertRunActive, loadView } from "./projection.js";
import { now, type Runtime } from "./runtime.js";
import type {
  BeginInvocationInput,
  CompleteExecutionInput,
  CompleteExecutionResult,
  EnsureExecutionInput,
  ExecutionRow,
} from "./types.js";
import { fail, parseJson } from "./util.js";

interface ExecDbRow {
  run_id: string;
  path: string;
  node_id: string;
  status: string;
  attempt: number;
  generation: number;
  kind: string | null;
  validation_attempts: number;
  validation_limit: number;
  crash_attempts: number;
  output_id: string | null;
  cli: string | null;
  session_id: string | null;
  session_cwd: string | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  workspace_dir: string | null;
  branch: string | null;
  error_code: string | null;
  error_message: string | null;
  last_event_id: number;
}

export function getExecution(runtime: Runtime, runId: RunId, path: Path): ExecutionRow | null {
  const row = runtime.db
    .prepare(
      `SELECT run_id, path, node_id, status, attempt, generation, kind,
              validation_attempts, validation_limit, crash_attempts, output_id,
              cli, session_id, session_cwd, model, started_at, ended_at,
              workspace_dir, branch, error_code, error_message, last_event_id
         FROM executions WHERE run_id = ? AND path = ?`,
    )
    .get(runId, path) as ExecDbRow | undefined;
  return row ? mapExecution(row) : null;
}

function mapExecution(row: ExecDbRow): ExecutionRow {
  return {
    runId: row.run_id as RunId,
    path: row.path as Path,
    nodeId: row.node_id,
    status: row.status,
    attempt: row.attempt,
    generation: row.generation,
    kind: row.kind as ExecutionRow["kind"],
    validationAttempts: row.validation_attempts,
    validationLimit: row.validation_limit,
    crashAttempts: row.crash_attempts,
    outputId: row.output_id,
    cli: row.cli,
    sessionId: row.session_id,
    sessionCwd: row.session_cwd,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    workspaceDir: row.workspace_dir,
    branch: row.branch,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    lastEventId: row.last_event_id,
  };
}

export function listExecutions(runtime: Runtime, runId: RunId): ExecutionRow[] {
  const rows = runtime.db
    .prepare(
      `SELECT run_id, path, node_id, status, attempt, generation, kind,
              validation_attempts, validation_limit, crash_attempts, output_id,
              cli, session_id, session_cwd, model, started_at, ended_at,
              workspace_dir, branch, error_code, error_message, last_event_id
         FROM executions WHERE run_id = ? ORDER BY path ASC`,
    )
    .all(runId) as ExecDbRow[];
  return rows.map(mapExecution);
}

export function requireExecution(runtime: Runtime, runId: RunId, path: Path): ExecutionRow {
  const row = getExecution(runtime, runId, path);
  if (!row) fail("E_NOT_FOUND", `Execution ${runId}/${path} does not exist`);
  return row;
}

export function requireCurrent(runtime: Runtime, identity: ExecutionIdentity): ExecutionRow {
  const row = requireExecution(runtime, identity.runId, identity.path);
  if (!isCurrentInvocation(identity, row)) {
    fail(
      "E_CONFLICT",
      `Stale or mismatched invocation for ${identity.runId}/${identity.path}: ` +
        `expected attempt ${row.attempt} generation ${row.generation}, ` +
        `got attempt ${identity.attempt} generation ${identity.generation}`,
      { expected: { attempt: row.attempt, generation: row.generation }, got: identity },
    );
  }
  if (row.generation < 1) fail("E_INTERNAL", "Execution has no process generation");
  return row;
}

export function ensureExecution(runtime: Runtime, input: EnsureExecutionInput): ExecutionRow {
  const existing = getExecution(runtime, input.runId, input.path);
  if (existing) return existing;
  assertRunActive(runtime, input.runId);

  const payload: Record<string, unknown> = {
    from: "pending",
    to: "ready",
    reason: "created",
    attempt: 1,
    generation: 1,
  };
  if (input.kind !== undefined) {
    payload.init = {
      kind: input.kind,
      requireSubmission: input.requireSubmission ?? input.kind === "agent",
    };
  }
  appendEvents(runtime, input.runId, [
    {
      runId: input.runId,
      path: input.path,
      type: "node.state",
      actor: "engine",
      payload,
    } as never,
  ]);

  runtime.db
    .prepare("UPDATE executions SET validation_limit = ? WHERE run_id = ? AND path = ?")
    .run(input.validationLimit ?? 3, input.runId, input.path);

  const row = getExecution(runtime, input.runId, input.path);
  if (!row) fail("E_INTERNAL", "Execution disappeared after its initial event");
  return row;
}

export function beginInvocation(runtime: Runtime, input: BeginInvocationInput): ExecutionIdentity {
  assertRunActive(runtime, input.runId);
  const execution = requireExecution(runtime, input.runId, input.path);
  if (input.attempt !== execution.attempt) {
    fail(
      "E_CONFLICT",
      `Attempt ${input.attempt} is not the current attempt ${execution.attempt} for ${input.path}`,
    );
  }
  if (!["pending", "ready", "interrupted"].includes(execution.status)) {
    fail("E_CONFLICT", `Cannot begin an invocation from status ${execution.status}`);
  }
  const view = loadView(runtime, input.runId);
  if (view.executions[input.path]?.acceptedResult) {
    fail(
      "E_CONFLICT",
      "This attempt already has an accepted result; finalize it instead of starting a new generation",
    );
  }
  const shellUncertain = execution.kind === "shell" && execution.status === "interrupted";
  if (input.approvedBy !== undefined && input.allowUncertainSideEffectRetry !== true) {
    fail("E_VALIDATION", "approvedBy is only valid with allowUncertainSideEffectRetry");
  }
  if (input.allowUncertainSideEffectRetry === true) {
    if (!shellUncertain) {
      fail("E_CONFLICT", "Uncertain-side-effect retry is only valid for an interrupted shell");
    }
    if (input.approvedBy === undefined || input.approvedBy.trim() === "") {
      fail("E_VALIDATION", "An explicit user identifier is required for this retry");
    }
    if (view.status !== "paused" || view.pauseReason !== "uncertain_side_effect") {
      fail("E_CONFLICT", "This run is not paused for an uncertain side effect");
    }
    try {
      runtime.db
        .prepare(
          `INSERT INTO uncertain_retries
             (run_id, path, attempt, generation, approved_by, approved_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.path,
          input.attempt,
          execution.generation,
          input.approvedBy.trim(),
          now(runtime),
        );
    } catch (error) {
      fail("E_CONFLICT", "This uncertain side effect was already approved or retried", {
        cause: error,
      });
    }
    appendEvents(runtime, input.runId, [
      {
        runId: input.runId,
        path: "" as Path,
        type: "run.resumed",
        actor: "user",
        payload: { reason: "retry_uncertain_side_effect" },
      },
    ]);
  } else if (shellUncertain) {
    fail(
      "E_CONFLICT",
      "An interrupted shell is paused for uncertain side effects; explicit user approval is required",
    );
  }

  let from = execution.status as ExecStatus;
  if (from === "pending" || from === "interrupted") {
    appendEvents(runtime, input.runId, [
      {
        runId: input.runId,
        path: input.path,
        type: "node.state",
        actor: "engine",
        payload: {
          from,
          to: "ready",
          reason: "invoked",
          attempt: input.attempt,
          generation: execution.generation,
        },
      },
    ]);
    from = "ready";
  }

  const generation = execution.generation + 1;
  runtime.db
    .prepare(
      `INSERT INTO process_generations
         (run_id, path, attempt, generation, pid, lstart, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.path,
      input.attempt,
      generation,
      input.pid ?? null,
      input.lstart ?? null,
      now(runtime),
    );

  appendEvents(runtime, input.runId, [
    {
      runId: input.runId,
      path: input.path,
      type: "node.attempt.started",
      actor: "engine",
      payload: {
        attempt: input.attempt,
        generation,
        mode: input.mode ?? "fresh",
        resolvedConfigHash: input.resolvedConfigHash ?? "",
      },
    },
    {
      runId: input.runId,
      path: input.path,
      type: "node.state",
      actor: "engine",
      payload: { from, to: "running", attempt: input.attempt, generation },
    },
  ]);

  return { runId: input.runId, path: input.path, attempt: input.attempt, generation };
}

function hasRecordedOutput(runtime: Runtime, identity: ExecutionIdentity): boolean {
  const rows = runtime.db
    .prepare(
      `SELECT payload FROM events
        WHERE run_id = ? AND path = ? AND type = 'node.output.recorded'`,
    )
    .all(identity.runId, identity.path) as { payload: string }[];
  return rows.some((row) => {
    const payload = JSON.parse(row.payload) as { attempt?: number; generation?: number };
    return payload.attempt === identity.attempt && payload.generation === identity.generation;
  });
}

function requireCompletionMarkers(
  execution: ExecView,
  identity: ExecutionIdentity,
  label: string,
): void {
  const stopped = execution.processStopped;
  if (
    !stopped ||
    stopped.attempt !== identity.attempt ||
    stopped.generation !== identity.generation
  ) {
    fail("E_CONFLICT", `Process stop evidence is missing for ${label}`);
  }
  const finalized = execution.workspaceFinalized;
  if (
    !finalized ||
    finalized.attempt !== identity.attempt ||
    finalized.generation !== identity.generation
  ) {
    fail("E_CONFLICT", `Workspace finalization is missing for ${label}`);
  }
}

export function completeExecution(
  runtime: Runtime,
  input: CompleteExecutionInput,
): CompleteExecutionResult {
  assertRunActive(runtime, input.identity.runId);
  requireCurrent(runtime, input.identity);
  const view = loadView(runtime, input.identity.runId);
  const execution = view.executions[input.identity.path] as ExecView | undefined;
  if (!execution) fail("E_NOT_FOUND", `Execution ${input.identity.path} is not in the projection`);
  if (execution.status === "succeeded") {
    const rows = runtime.db
      .prepare(
        `SELECT id, payload FROM events
          WHERE run_id = ? AND path = ? AND type = 'node.state'
          ORDER BY id DESC`,
      )
      .all(input.identity.runId, input.identity.path) as { id: number; payload: string }[];
    for (const row of rows) {
      const payload = parseJson<{
        to?: string;
        attempt?: number;
        generation?: number;
      }>(row.payload);
      if (
        payload.to === "succeeded" &&
        payload.attempt === input.identity.attempt &&
        payload.generation === input.identity.generation
      ) {
        return { status: "succeeded", eventId: row.id };
      }
    }
    fail("E_INTERNAL", "Succeeded execution has no matching completion event");
  }
  const accepted = execution.acceptedResult;
  if (!accepted && !["running", "validating"].includes(execution.status)) {
    fail("E_CONFLICT", `Cannot complete from status ${execution.status}`);
  }
  if (accepted) {
    if (
      accepted.attempt !== input.identity.attempt ||
      accepted.generation !== input.identity.generation
    ) {
      fail("E_CONFLICT", "Accepted result belongs to a different attempt or generation");
    }
    requireCompletionMarkers(execution, input.identity, "the accepted generation");
  } else if (execution.requiresAcceptedResult) {
    fail("E_CONFLICT", "This execution requires an accepted result before success");
  } else {
    const kind = execution.kind;
    if (kind === "shell" || kind === "start" || kind === "end") {
      if (!hasRecordedOutput(runtime, input.identity)) {
        fail("E_CONFLICT", `This ${kind} execution requires a recorded output before success`);
      }
      if (kind === "shell") {
        requireCompletionMarkers(execution, input.identity, "the shell execution");
      }
    }
  }

  let from = execution.status as ExecStatus;
  const advance = (to: ExecStatus, reason: string): void => {
    appendEvents(runtime, input.identity.runId, [
      {
        runId: input.identity.runId,
        path: input.identity.path,
        type: "node.state",
        actor: "engine",
        payload: {
          from,
          to,
          reason,
          attempt: input.identity.attempt,
          generation: input.identity.generation,
        },
      },
    ]);
    from = to;
  };
  // Recovery may leave an accepted attempt interrupted/ready. No new process is
  // started; these are legal state transitions to the same attempt/generation.
  if (accepted) {
    if (from === "interrupted") advance("ready", "recovery_complete");
    if (from === "ready") advance("running", "recovery_complete");
  }
  if (!["running", "validating"].includes(from)) {
    fail("E_CONFLICT", `Cannot complete from status ${from}`);
  }

  const events = appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "node.state",
      actor: "engine",
      payload: {
        from,
        to: "succeeded",
        attempt: input.identity.attempt,
        generation: input.identity.generation,
      },
    },
  ]);
  const event = events[0];
  if (!event) fail("E_INTERNAL", "Completion event was not appended");
  return { status: "succeeded", eventId: event.id };
}
