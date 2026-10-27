import { killOrphan } from "@relay/adapters";
import { type AcceptedResultRef, type ExecutionIdentity, RelayError } from "@relay/core";
import type { RunRecord } from "@relay/store";
import type { ScratchWorkspace } from "@relay/workspaces";
import { type ActiveRunState, type EngineContext, toRelayError } from "./context.js";
import type { PlanNode } from "./graph-plan.js";

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
      request: { name: "relay.engine.no_submit", arguments: { generation: identity.generation } },
      ok: false,
      errors: [{ path: "/", message: "Agent ended without calling submit_result" }],
      errorCode: "E_NO_SUBMIT",
    });
    return "consumed";
  } catch (error) {
    if (error instanceof RelayError && error.code === "E_ATTEMPTS_EXHAUSTED") return "exhausted";
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
      throw toRelayError(error, "E_WORKSPACE");
    }
    if (orphan.matched && !orphan.killed) {
      ctx.appendError(
        run.id,
        node.id,
        new RelayError("E_WORKSPACE", "The accepted process group is still alive", {
          details: { step: "group_still_alive", pid: process.pid },
        }),
      );
      ctx.append(run.id, "", "run.paused", "engine", {
        reason: "shutdown",
        detail: "An accepted process group is still alive; retry after it exits",
      });
      throw new RelayError("E_WORKSPACE", "Accepted process group is still alive");
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
      const relay = toRelayError(error, "E_WORKSPACE");
      ctx.appendError(run.id, node.id, relay);
      ctx.append(run.id, "", "run.paused", "engine", {
        reason: "shutdown",
        detail: "The accepted workspace cannot be opened; human recovery required",
      });
      throw relay;
    }
  }
  if (existingWorkspace === undefined && !workspace.reused) {
    ctx.appendError(
      run.id,
      node.id,
      new RelayError("E_WORKSPACE", "The accepted workspace is missing; refusing to recreate it", {
        details: { step: "workspace_lost", dir: workspace.dir },
      }),
    );
    ctx.append(run.id, "", "run.paused", "engine", {
      reason: "shutdown",
      detail: "An accepted workspace is missing; human recovery required",
    });
    throw new RelayError("E_WORKSPACE", "Accepted workspace is missing");
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
