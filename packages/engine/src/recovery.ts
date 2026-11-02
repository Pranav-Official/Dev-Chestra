import { killOrphan } from "@devchestra/adapters";
import {
  DevChestraError,
  type ExecutionIdentity,
  isTerminalExecStatus,
  type Path,
} from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";
import type { ScratchWorkspace } from "@devchestra/workspaces";
import type { EngineContext } from "./context.js";

type StopReason = "exited" | "killed" | "grace_timeout" | "crash";

export async function recoverAll(ctx: EngineContext): Promise<void> {
  const blocked = new Set<string>();
  for (const process of ctx.store.processes.active()) {
    if (process.pid === null || process.pidStart === null || process.binary === null) continue;
    try {
      const result = await killOrphan(
        { pid: process.pid, pidStart: process.pidStart, binary: process.binary },
        { graceMs: 5_000 },
      );
      if (result.matched && !result.killed) {
        blocked.add(processKey(process.identity));
      }
    } catch {
      blocked.add(processKey(process.identity));
    }
  }
  for (const run of ctx.store.runs.listActive()) {
    if (
      ctx.store.executions.list(run.id).some((execution) =>
        blocked.has(
          processKey({
            runId: run.id,
            path: execution.path,
            attempt: execution.attempt,
            generation: execution.generation,
          }),
        ),
      )
    ) {
      ctx.appendError(
        run.id,
        "",
        new DevChestraError(
          "E_WORKSPACE",
          "A recorded agent process is still alive; refusing automatic recovery",
          { details: { step: "orphan_alive" } },
        ),
      );
      continue;
    }
    try {
      await recoverRun(ctx, run);
    } catch (error) {
      ctx.appendError(
        run.id,
        "",
        error instanceof DevChestraError ? error : new DevChestraError("E_INTERNAL", String(error)),
      );
    }
  }
}

function processKey(identity: {
  runId: string;
  path: string;
  attempt: number;
  generation: number;
}): string {
  return `${identity.runId}|${identity.path}|${identity.attempt}|${identity.generation}`;
}

async function recoverRun(ctx: EngineContext, run: RunRecord): Promise<void> {
  // A queued run has no executions to recover. The scheduler starts it when a slot is free.
  for (const execution of ctx.store.executions.list(run.id)) {
    if (execution.status !== "running" && execution.status !== "validating") continue;
    const identity: ExecutionIdentity = {
      runId: run.id,
      path: execution.path,
      attempt: execution.attempt,
      generation: execution.generation,
    };
    const process = ctx.store.executions.getProcess(identity);
    const view = ctx.store.view.get(run.id).executions[execution.path];
    if (view?.processStopped === null || view?.processStopped === undefined) {
      try {
        ctx.recordStop(identity, "crash", process?.exitCode ?? null);
      } catch (error) {
        if (!(error instanceof DevChestraError) || error.code !== "E_CONFLICT") throw error;
      }
    }
  }

  ctx.store.recovery.recover(run.id);
  const view = ctx.store.view.get(run.id);
  for (const execution of Object.values(view.executions)) {
    if (execution.acceptedResult === null) continue;
    if (execution.status === "succeeded" || isTerminalExecStatus(execution.status)) continue;
    const identity: ExecutionIdentity = {
      runId: run.id,
      path: execution.path,
      attempt: execution.acceptedResult.attempt,
      generation: execution.acceptedResult.generation,
    };
    await finalizeAcceptedIdentity(ctx, run, identity);
  }

  const after = ctx.store.view.get(run.id);
  const uncertainShell = Object.values(after.executions).some(
    (execution) => execution.kind === "shell" && execution.status === "interrupted",
  );
  if (
    uncertainShell &&
    after.status === "paused" &&
    after.pauseReason !== "uncertain_side_effect"
  ) {
    ctx.append(run.id, "", "run.resumed", "system", { reason: "recovery" });
    ctx.append(run.id, "", "run.paused", "system", {
      reason: "uncertain_side_effect",
      path: firstShellPath(after.executions) ?? "",
      detail:
        "Interrupted shell may have produced external effects; user approval required to retry",
    });
  }
}

async function finalizeAcceptedIdentity(
  ctx: EngineContext,
  run: RunRecord,
  identity: ExecutionIdentity,
): Promise<void> {
  const view = ctx.store.view.get(run.id).executions[identity.path];
  if (view === undefined) return;
  let stop = view.processStopped;
  if (stop === null) {
    ctx.recordStop(identity, "crash", null);
    stop = {
      attempt: identity.attempt,
      generation: identity.generation,
      reason: "crash",
      exitCode: null,
    };
  }
  const controller = new AbortController();
  let workspace: ScratchWorkspace | undefined;
  try {
    workspace = await ctx.acquire(
      run,
      identity.path,
      identity.attempt,
      identity.generation,
      controller.signal,
      true,
    );
    if (!workspace.reused) {
      throw new DevChestraError(
        "E_WORKSPACE",
        `Workspace for accepted result ${run.id}/${identity.path} is missing; refusing to recreate it`,
        { details: { step: "workspace_lost", dir: workspace.dir } },
      );
    }
    await ctx.finalize(workspace, identity, "success", {
      reason: stop.reason as StopReason,
      exitCode: stop.exitCode,
    });
    ctx.store.executions.completeAcceptedAfterRecovery({
      identity,
      processStop: { reason: stop.reason as StopReason, exitCode: stop.exitCode },
      workspace: { dir: workspace.dir },
    });
  } finally {
    if (workspace !== undefined) ctx.release(workspace);
  }
}

function firstShellPath(
  executions: Record<string, { kind: string | null; path: Path }>,
): Path | null {
  for (const execution of Object.values(executions)) {
    if (execution.kind === "shell") return execution.path;
  }
  return null;
}
