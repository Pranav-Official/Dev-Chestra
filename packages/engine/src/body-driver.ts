import { DevChestraError, type Path, type RoutingView } from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";
import type { ActiveRunState, EngineContext } from "./context.js";
import { skipNode } from "./exec-routing.js";
import type { PlanNode, WorkflowPlan } from "./graph-plan.js";
import { derivePlanRouting } from "./graph-run.js";
import { StopSignal } from "./stop.js";

export type Dispatch = (plan: WorkflowPlan, node: PlanNode, routing: RoutingView) => Promise<void>;

function checkStop(active: ActiveRunState): void {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
}

function canDrive(ctx: EngineContext, run: RunRecord, active: ActiveRunState): boolean {
  const current = ctx.run(run.id);
  return (
    current.status === "running" ||
    (current.status === "paused" &&
      current.pauseReason === "uncertain_side_effect" &&
      active.overrideApprovedBy !== undefined)
  );
}

/**
 * Small shared body driver (loop + foreach). Drives one already-instantiated
 * body plan to completion without copying the loop implementation.
 * Returns true when the body finished, false when the drive must park
 * (approval/quota/pause). Throws on body failure so the caller maps it.
 */
export async function driveBodyPlan(
  ctx: EngineContext,
  run: RunRecord,
  plan: WorkflowPlan,
  active: ActiveRunState,
  dispatch: Dispatch,
): Promise<boolean> {
  for (;;) {
    checkStop(active);
    if (!canDrive(ctx, run, active)) return false;
    const view = ctx.store.view.get(run.id);
    const executions = Object.fromEntries(
      plan.nodes.flatMap((node) => {
        const execution = view.executions[node.id];
        return execution ? [[node.id, execution]] : [];
      }),
    );
    const failed = Object.values(executions).find((item) =>
      ["failed", "rejected", "cancelled"].includes(item.status),
    );
    if (failed) {
      throw new DevChestraError(
        failed.lastError?.code ?? "E_INTERNAL",
        failed.lastError?.message ?? `Body child '${failed.path}' ${failed.status}`,
      );
    }
    const routing = derivePlanRouting(plan, executions);
    if (routing.conflicts.length) {
      throw new DevChestraError(
        "E_JOIN_CONFLICT",
        `Body join '${routing.conflicts[0]}' has multiple active alternatives`,
      );
    }
    if (routing.skipped.length) {
      for (const node of plan.nodes) {
        if (routing.skipped.includes(node.id)) skipNode(ctx, run, node);
      }
      continue;
    }
    const ready = plan.nodes.filter((node) => routing.ready.includes(node.id));
    const next = ready.find((node) => node.type !== "end") ?? ready[0];
    if (next) {
      await dispatch(plan, next, routing);
      continue;
    }
    if (plan.nodes.some((node) => executions[node.id]?.status === "waiting_approval")) return false;
    if (
      plan.ends.every((node) => executions[node.id]?.status === "succeeded") &&
      plan.nodes.every((node) =>
        ["succeeded", "skipped"].includes(executions[node.id]?.status ?? "pending"),
      )
    ) {
      return true;
    }
    // No ready node and not parked: executions are in-flight elsewhere
    // (quota wait, async wake). Park event-driven instead of busy-polling:
    // wake on any run event, with a bounded fallback so a missed event
    // still makes progress.
    await waitForBodyProgress(ctx, run, active);
  }
}

function waitForBodyProgress(
  ctx: EngineContext,
  run: RunRecord,
  active: ActiveRunState,
): Promise<void> {
  let cleanup = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    const done = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(done, 1000);
    const off = ctx.store.bus.subscribe((envelope) => {
      if ((envelope.runId as string) !== (run.id as string)) return;
      if (
        envelope.type.startsWith("node.") ||
        envelope.type.startsWith("approval.") ||
        envelope.type.startsWith("quota.") ||
        envelope.type.startsWith("run.")
      ) {
        clearTimeout(timer);
        done();
      }
    });
    const onAbort = (): void => {
      clearTimeout(timer);
      done();
    };
    cleanup = (): void => {
      off();
      active.abort.signal.removeEventListener("abort", onAbort);
    };
    active.abort.signal.addEventListener("abort", onAbort);
    if (active.abort.signal.aborted) done();
  });
  return promise.finally(() => cleanup());
}

export function bodyPath(controller: string, suffix: string): Path {
  return `${controller}/${suffix}` as Path;
}

export { canDrive as canBodyDrive, checkStop as checkBodyStop };
