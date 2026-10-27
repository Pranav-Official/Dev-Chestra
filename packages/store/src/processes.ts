import type { ExecutionIdentity, ExecView, Path, RunId } from "@relay/core";
import { appendEvents } from "./events.js";
import { completeExecution, requireCurrent } from "./executions.js";
import { assertRunActive, loadView } from "./projection.js";
import { now, type Runtime } from "./runtime.js";
import type {
  ActiveProcess,
  CompleteAcceptedAfterRecoveryInput,
  CompleteExecutionResult,
  ProcessRecord,
  RecordProcessStoppedInput,
  RecordSpawnedInput,
  RecordWorkspaceFinalizedInput,
} from "./types.js";
import { fail } from "./util.js";

interface ProcessDbRow {
  run_id: string;
  path: string;
  attempt: number;
  generation: number;
  pid: number | null;
  pid_start: string | null;
  lstart: string | null;
  binary: string | null;
  cwd: string | null;
  started_at: number;
  stopped_at: number | null;
  stop_reason: string | null;
  exit_code: number | null;
}

interface GenerationDbRow {
  stopped_at: number | null;
  stop_reason: string | null;
  exit_code: number | null;
}

function mapProcess(row: ProcessDbRow): ProcessRecord {
  const identity: ExecutionIdentity = {
    runId: row.run_id as RunId,
    path: row.path as Path,
    attempt: row.attempt,
    generation: row.generation,
  };
  return {
    identity,
    pid: row.pid,
    pidStart: row.pid_start ?? row.lstart,
    binary: row.binary,
    cwd: row.cwd,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    stopReason: row.stop_reason,
    exitCode: row.exit_code,
  };
}

export function getProcess(runtime: Runtime, identity: ExecutionIdentity): ProcessRecord | null {
  const row = runtime.db
    .prepare(
      `SELECT * FROM process_generations
        WHERE run_id = ? AND path = ? AND attempt = ? AND generation = ?`,
    )
    .get(identity.runId, identity.path, identity.attempt, identity.generation) as
    | ProcessDbRow
    | undefined;
  return row ? mapProcess(row) : null;
}

export function activeProcesses(runtime: Runtime): ActiveProcess[] {
  const rows = runtime.db
    .prepare(
      `SELECT pg.*, e.status AS exec_status
         FROM process_generations pg
         JOIN executions e
           ON e.run_id = pg.run_id AND e.path = pg.path
          AND e.attempt = pg.attempt AND e.generation = pg.generation
        WHERE e.status IN ('running', 'validating')
          AND pg.pid IS NOT NULL AND pg.stopped_at IS NULL
        ORDER BY pg.started_at ASC`,
    )
    .all() as (ProcessDbRow & { exec_status: string })[];
  return rows.map((row) => ({ ...mapProcess(row), status: row.exec_status }));
}

export function recordSpawned(runtime: Runtime, input: RecordSpawnedInput): ProcessRecord {
  assertRunActive(runtime, input.identity.runId);
  requireCurrent(runtime, input.identity);
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    fail("E_VALIDATION", "pid must be a positive safe integer");
  }
  for (const [name, value] of [
    ["pidStart", input.pidStart],
    ["binary", input.binary],
    ["cwd", input.cwd],
  ] as const) {
    if (value.trim() === "") fail("E_VALIDATION", `${name} must be a non-empty string`);
    if (/[\0\r\n]/.test(value)) {
      fail("E_VALIDATION", `${name} must not contain NUL or newlines`);
    }
  }
  const row = runtime.db
    .prepare(
      `SELECT * FROM process_generations
        WHERE run_id = ? AND path = ? AND attempt = ? AND generation = ?`,
    )
    .get(
      input.identity.runId,
      input.identity.path,
      input.identity.attempt,
      input.identity.generation,
    ) as ProcessDbRow | undefined;
  if (!row) fail("E_CONFLICT", "No process generation was recorded for this invocation");
  if (row.stopped_at !== null) {
    fail("E_CONFLICT", "This process generation is already stopped");
  }
  if (row.pid !== null) {
    const same =
      row.pid === input.pid &&
      (row.pid_start ?? row.lstart) === input.pidStart &&
      row.binary === input.binary &&
      row.cwd === input.cwd;
    if (same) {
      const existing = getProcess(runtime, input.identity);
      if (!existing) fail("E_INTERNAL", "Spawned process disappeared");
      return existing;
    }
    fail("E_CONFLICT", "This process generation already has different spawn evidence");
  }

  runtime.db
    .prepare(
      `UPDATE process_generations
          SET pid = ?, pid_start = ?, lstart = ?, binary = ?, cwd = ?
        WHERE run_id = ? AND path = ? AND attempt = ? AND generation = ?`,
    )
    .run(
      input.pid,
      input.pidStart,
      input.pidStart,
      input.binary,
      input.cwd,
      input.identity.runId,
      input.identity.path,
      input.identity.attempt,
      input.identity.generation,
    );
  appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "node.process.spawned",
      actor: "engine",
      payload: {
        attempt: input.identity.attempt,
        generation: input.identity.generation,
        pid: input.pid,
        pidStart: input.pidStart,
        binary: input.binary,
        cwd: input.cwd,
      },
    } as never,
  ]);
  const process = getProcess(runtime, input.identity);
  if (!process) fail("E_INTERNAL", "Spawned process disappeared");
  return process;
}

export function recordProcessStopped(runtime: Runtime, input: RecordProcessStoppedInput): void {
  assertRunActive(runtime, input.identity.runId);
  requireCurrent(runtime, input.identity);
  const row = runtime.db
    .prepare(
      `SELECT stopped_at, stop_reason, exit_code FROM process_generations
        WHERE run_id = ? AND path = ? AND attempt = ? AND generation = ?`,
    )
    .get(
      input.identity.runId,
      input.identity.path,
      input.identity.attempt,
      input.identity.generation,
    ) as GenerationDbRow | undefined;
  if (!row) fail("E_CONFLICT", "No process generation was recorded for this invocation");

  if (row.stopped_at !== null) {
    const sameExit = (row.exit_code ?? null) === (input.exitCode ?? null);
    if (row.stop_reason === input.reason && sameExit) return;
    fail("E_CONFLICT", "This process generation already stopped with different evidence");
  }

  runtime.db
    .prepare(
      `UPDATE process_generations
          SET stopped_at = ?, stop_reason = ?, exit_code = ?
        WHERE run_id = ? AND path = ? AND attempt = ? AND generation = ?`,
    )
    .run(
      now(runtime),
      input.reason,
      input.exitCode ?? null,
      input.identity.runId,
      input.identity.path,
      input.identity.attempt,
      input.identity.generation,
    );

  appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "node.process.stopped",
      actor: "engine",
      payload: {
        attempt: input.identity.attempt,
        generation: input.identity.generation,
        reason: input.reason,
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      },
    },
  ]);
}

export function recordWorkspaceFinalized(
  runtime: Runtime,
  input: RecordWorkspaceFinalizedInput,
): void {
  assertRunActive(runtime, input.identity.runId);
  requireCurrent(runtime, input.identity);
  const view = loadView(runtime, input.identity.runId);
  const execution = view.executions[input.identity.path] as ExecView | undefined;
  const finalized = execution?.workspaceFinalized ?? null;
  if (finalized) {
    const same =
      finalized.attempt === input.identity.attempt &&
      finalized.generation === input.identity.generation &&
      finalized.dir === input.dir &&
      (finalized.commitSha ?? null) === (input.commitSha ?? null);
    if (same) return;
    fail("E_CONFLICT", "Workspace was already finalized with different evidence");
  }

  appendEvents(runtime, input.identity.runId, [
    {
      runId: input.identity.runId,
      path: input.identity.path,
      type: "node.workspace.finalized",
      actor: "engine",
      payload: {
        attempt: input.identity.attempt,
        generation: input.identity.generation,
        dir: input.dir,
        ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
      },
    },
  ]);
}

export function completeAcceptedAfterRecovery(
  runtime: Runtime,
  input: CompleteAcceptedAfterRecoveryInput,
): CompleteExecutionResult {
  assertRunActive(runtime, input.identity.runId);
  const view = loadView(runtime, input.identity.runId);
  const execution = view.executions[input.identity.path] as ExecView | undefined;
  if (!execution) fail("E_NOT_FOUND", `Execution ${input.identity.path} is not in the projection`);
  const accepted = execution.acceptedResult;
  if (
    !accepted ||
    accepted.attempt !== input.identity.attempt ||
    accepted.generation !== input.identity.generation
  ) {
    fail("E_CONFLICT", "No accepted result matches this attempt and generation");
  }
  requireCurrent(runtime, input.identity);

  const stopped = execution.processStopped;
  if (
    !stopped ||
    stopped.attempt !== input.identity.attempt ||
    stopped.generation !== input.identity.generation
  ) {
    recordProcessStopped(runtime, {
      identity: input.identity,
      reason: input.processStop.reason,
      ...(input.processStop.exitCode === undefined ? {} : { exitCode: input.processStop.exitCode }),
    });
  }
  const finalized = execution.workspaceFinalized;
  if (
    !finalized ||
    finalized.attempt !== input.identity.attempt ||
    finalized.generation !== input.identity.generation
  ) {
    recordWorkspaceFinalized(runtime, {
      identity: input.identity,
      dir: input.workspace.dir,
      ...(input.workspace.commitSha === undefined ? {} : { commitSha: input.workspace.commitSha }),
    });
  }
  return completeExecution(runtime, { identity: input.identity });
}
