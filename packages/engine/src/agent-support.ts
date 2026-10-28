import { killOrphan, matchesProcess } from "@devchestra/adapters";
import { type AcceptedResultRef, type ExecutionIdentity, DevChestraError } from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";
import type { ScratchWorkspace } from "@devchestra/workspaces";
import { type ActiveRunState, type EngineContext, toDevChestraError } from "./context.js";
import type { PlanNode } from "./graph-plan.js";
import { ProcessGroupAliveError, StopSignal } from "./stop.js";

/**
 * Single cancellation finalization for agent generations.
 *
 * No-op once the invocation is already terminal (avoids double-finalize
 * across the inner attempt catch, the retry-loop catch, and the outer
 * acquire/setup guard). When a workspace exists, finalizes cancelled with
 * existing stop evidence (or killed/null); finalize failures are logged but
 * never replace the StopSignal. Never invents evidence when workspace is
 * undefined — transitions only.
 */
export async function cancelAgentGeneration(
  ctx: EngineContext,
  run: RunRecord,
  node: PlanNode,
  workspace: ScratchWorkspace | undefined,
  identity: ExecutionIdentity,
  active: ActiveRunState,
): Promise<void> {
  const current = ctx.currentStatus(identity);
  if (current !== "running" && current !== "validating") return;
  const shutdown = active.reason === "shutdown";
  if (workspace !== undefined) {
    const evidence = ctx.persistedStop(identity) ?? {
      reason: "killed" as const,
      exitCode: null,
    };
    try {
      await ctx.finalize(workspace, identity, "cancelled", evidence);
    } catch (error) {
      ctx.appendError(run.id, node.id, toDevChestraError(error, "E_WORKSPACE"));
    }
  }
  try {
    ctx.transition(
      identity,
      shutdown ? "interrupted" : "cancelled",
      shutdown ? "shutdown" : "cancelled",
    );
  } catch {
    // Terminal/fencing races: the StopSignal still wins, no masking.
  }
}

export function toStopSignal(error: unknown, active: ActiveRunState): StopSignal | null {
  if (error instanceof StopSignal) return error;
  if (error instanceof DevChestraError && error.code === "E_CANCELLED" && active.abort.signal.aborted) {
    return new StopSignal(active.reason ?? "user");
  }
  return null;
}

export function secretValues(ctx: EngineContext, token: string): string[] {
  const values = new Set<string>([token]);
  for (const [key, value] of Object.entries(ctx.deps.env ?? process.env)) {
    if (value === undefined || value.length < 8) continue;
    if (/(API_KEY|AUTH_TOKEN|_TOKEN|SECRET)$/.test(key)) values.add(value);
  }
  return [...values];
}

export function consumeNoSubmit(
  ctx: EngineContext,
  identity: ExecutionIdentity,
): "consumed" | "exhausted" {
  try {
    ctx.store.submissions.submit({
      identity,
      callId: `engine-no-submit-${identity.attempt}-${identity.generation}`,
      request: { name: "devchestra.engine.no_submit", arguments: { generation: identity.generation } },
      ok: false,
      errors: [{ path: "/", message: "Agent ended without calling submit_result" }],
      errorCode: "E_NO_SUBMIT",
    });
    return "consumed";
  } catch (error) {
    if (error instanceof DevChestraError && error.code === "E_ATTEMPTS_EXHAUSTED") return "exhausted";
    throw error;
  }
}

export function countNoSubmit(
  ctx: EngineContext,
  runId: string,
  path: string,
  attempt: number,
): number {
  return ctx.store.submissions.countNoSubmit({
    runId: runId as never,
    path: path as never,
    attempt,
  });
}

/**
 * Centralized failure finalization for agent setup/planning exceptions.
 *
 * Ensures a terminal run never leaves a genuinely-active execution behind
 * without inventing stop/finalization evidence for a still-live process:
 * - no-op when the invocation is already terminal (avoids double-finalize);
 * - when the recorded pid still matches a live process, logs the original
 *   error, pauses with shutdown, and throws ProcessGroupAliveError instead
 *   of claiming stopped/finalized;
 * - otherwise records a crash stop (if none), finalizes the workspace as
 *   failed (when a workspace exists), and fails the execution with the
 *   ORIGINAL DevChestraError. Cleanup failures are logged but never replace the
 *   original error.
 */
export async function failAgentGeneration(
  ctx: EngineContext,
  run: RunRecord,
  node: PlanNode,
  workspace: ScratchWorkspace | undefined,
  identity: ExecutionIdentity,
  original: DevChestraError,
): Promise<DevChestraError> {
  const current = ctx.currentStatus(identity);
  if (current !== "running" && current !== "validating") return original;
  const process = ctx.store.executions.getProcess(identity);
  if (
    process !== null &&
    process.pid !== null &&
    process.pidStart !== null &&
    process.binary !== null &&
    process.stoppedAt === null
  ) {
    let alive: boolean;
    try {
      alive = await matchesProcess({
        pid: process.pid,
        pidStart: process.pidStart,
        binary: process.binary,
      });
    } catch (error) {
      // Unknown liveness must fail closed: never fabricate a crash stop or
      // workspace finalization when identity lookup itself fails. Pause for
      // recovery while preserving the original error in the log.
      ctx.appendError(run.id, node.id, original);
      ctx.appendError(run.id, node.id, toDevChestraError(error, "E_WORKSPACE"));
      ctx.append(run.id, "", "run.paused", "engine", {
        reason: "shutdown",
        detail: "Could not verify agent process liveness; human recovery required",
      });
      throw new ProcessGroupAliveError("Agent process liveness is unknown", {
        step: "liveness_unknown",
        pid: process.pid,
      });
    }
    if (alive) {
      ctx.appendError(run.id, node.id, original);
      const blocked = new DevChestraError(
        "E_WORKSPACE",
        "Agent process group is still alive; refusing to finalize failure",
        { details: { step: "group_still_alive", pid: process.pid } },
      );
      ctx.appendError(run.id, node.id, blocked);
      ctx.append(run.id, "", "run.paused", "engine", {
        reason: "shutdown",
        detail: "An agent process group is still alive; retry after it exits",
      });
      throw new ProcessGroupAliveError("Agent process group is still alive", {
        step: "group_still_alive",
        pid: process.pid,
      });
    }
  }
  if (ctx.persistedStop(identity) === null) {
    try {
      ctx.recordStop(identity, "crash", null);
    } catch (error) {
      if (!(error instanceof DevChestraError) || error.code !== "E_CONFLICT") {
        ctx.appendError(run.id, node.id, toDevChestraError(error, "E_WORKSPACE"));
      }
    }
  }
  const evidence = ctx.persistedStop(identity) ?? {
    reason: "crash" as const,
    exitCode: null,
  };
  if (workspace !== undefined) {
    try {
      await ctx.finalize(workspace, identity, "failed", evidence);
    } catch (error) {
      ctx.appendError(run.id, node.id, toDevChestraError(error, "E_WORKSPACE"));
    }
  }
  const after = ctx.currentStatus(identity);
  if (after === "running" || after === "validating") {
    try {
      ctx.failExecution(run, node, identity, original);
    } catch (error) {
      ctx.appendError(run.id, node.id, toDevChestraError(error, "E_WORKSPACE"));
      throw original;
    }
  }
  return original;
}

export async function finalizeAccepted(
  ctx: EngineContext,
  run: RunRecord,
  node: PlanNode,
  active: ActiveRunState,
  accepted: AcceptedResultRef,
  existingWorkspace?: ScratchWorkspace,
): Promise<void> {
  const identity: ExecutionIdentity = {
    runId: accepted.runId,
    path: accepted.path,
    attempt: accepted.attempt,
    generation: accepted.generation,
  };
  const process = ctx.store.executions.getProcess(identity);
  if (
    process !== null &&
    process.pid !== null &&
    process.pidStart !== null &&
    process.binary !== null &&
    process.stoppedAt === null
  ) {
    let orphan: { matched: boolean; killed: boolean };
    try {
      orphan = await killOrphan(
        { pid: process.pid, pidStart: process.pidStart, binary: process.binary },
        { graceMs: 5_000 },
      );
    } catch (error) {
      throw toDevChestraError(error, "E_WORKSPACE");
    }
    if (orphan.matched && !orphan.killed) {
      ctx.appendError(
        run.id,
        node.id,
        new DevChestraError("E_WORKSPACE", "The accepted process group is still alive", {
          details: { step: "group_still_alive", pid: process.pid },
        }),
      );
      ctx.append(run.id, "", "run.paused", "engine", {
        reason: "shutdown",
        detail: "An accepted process group is still alive; retry after it exits",
      });
      throw new DevChestraError("E_WORKSPACE", "Accepted process group is still alive");
    }
  }
  let workspace: ScratchWorkspace;
  if (existingWorkspace !== undefined) {
    workspace = existingWorkspace;
  } else {
    try {
      workspace = await ctx.acquire(
        run,
        node.id,
        identity.attempt,
        identity.generation,
        active.abort.signal,
        true,
      );
    } catch (error) {
      const devchestra = toDevChestraError(error, "E_WORKSPACE");
      ctx.appendError(run.id, node.id, devchestra);
      ctx.append(run.id, "", "run.paused", "engine", {
        reason: "shutdown",
        detail: "The accepted workspace cannot be opened; human recovery required",
      });
      throw devchestra;
    }
  }
  if (existingWorkspace === undefined && !workspace.reused) {
    ctx.appendError(
      run.id,
      node.id,
      new DevChestraError("E_WORKSPACE", "The accepted workspace is missing; refusing to recreate it", {
        details: { step: "workspace_lost", dir: workspace.dir },
      }),
    );
    ctx.append(run.id, "", "run.paused", "engine", {
      reason: "shutdown",
      detail: "An accepted workspace is missing; human recovery required",
    });
    throw new DevChestraError("E_WORKSPACE", "Accepted workspace is missing");
  }
  try {
    const view = ctx.store.view.get(run.id).executions[node.id];
    const existing = view?.processStopped;
    if (existing === null || existing === undefined) {
      ctx.recordStop(identity, "crash", null);
    }
    const stopped = ctx.store.view.get(run.id).executions[node.id]?.processStopped;
    const stop = {
      reason: stopped?.reason ?? ("crash" as const),
      exitCode: stopped?.exitCode ?? null,
    };
    await ctx.finalize(workspace, identity, "success", stop);
    const finalized = ctx.store.view.get(run.id).executions[node.id];
    if (finalized?.status === "interrupted" || finalized?.status === "ready") {
      ctx.store.executions.completeAcceptedAfterRecovery({
        identity,
        processStop: stop,
        workspace: { dir: workspace.dir },
      });
    } else {
      ctx.store.executions.complete({ identity });
    }
  } finally {
    if (existingWorkspace === undefined) ctx.release(workspace);
  }
}
