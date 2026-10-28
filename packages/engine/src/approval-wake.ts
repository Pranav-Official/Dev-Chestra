import type { RunId } from "@devchestra/core";
import type { EngineContext } from "./context.js";

export function reconcileApprovalWakes(
  ctx: EngineContext,
  active: Map<string, unknown>,
  drive: (runId: string, opts: unknown, resume: boolean) => void,
): void {
  const wakes = ctx.store.approvals.listOutstandingWakes();
  const byRun = new Map<string, typeof wakes>();
  for (const w of wakes) {
    const arr = byRun.get(w.runId as string);
    if (arr) arr.push(w);
    else byRun.set(w.runId as string, [w]);
  }
  for (const [runId, runWakes] of byRun) {
    const view = ctx.store.view.get(runId as RunId);
    if (view.status !== "running") continue;
    if (Object.values(view.executions).some((e) => e.status === "interrupted")) continue;
    if (Object.values(view.executions).some((e) => e.status === "waiting_approval")) continue;
    const applicable = runWakes.some(
      (w) =>
        view.executions[w.path]?.status === "succeeded" &&
        view.executions[w.path]?.approvalDecision?.decision !== undefined,
    );
    if (!applicable) continue;
    if (active.has(runId)) continue;
    void drive(runId, {}, true);
  }
}

export function reconcileApprovalWakesForRun(
  ctx: EngineContext,
  active: Map<string, unknown>,
  drive: (runId: string, opts: unknown, resume: boolean) => void,
  runId: string,
): void {
  const wakes = ctx.store.approvals.listOutstandingWakes(runId as RunId);
  if (wakes.length === 0) return;
  const view = ctx.store.view.get(runId as RunId);
  if (view.status !== "running") return;
  if (Object.values(view.executions).some((e) => e.status === "interrupted")) return;
  if (Object.values(view.executions).some((e) => e.status === "waiting_approval")) return;
  const applicable = wakes.some(
    (w) =>
      view.executions[w.path]?.status === "succeeded" &&
      view.executions[w.path]?.approvalDecision?.decision !== undefined,
  );
  if (!applicable) return;
  if (active.has(runId)) return;
  void drive(runId, {}, true);
}

export function consumeWakesForTerminal(ctx: EngineContext, runId: string): void {
  const wakes = ctx.store.approvals.listOutstandingWakes(runId as RunId);
  for (const w of wakes) {
    const ok = ctx.store.approvals.consumeWake(
      { runId: w.runId, path: w.path, attempt: w.attempt, generation: w.generation },
      w.requestId,
    );
    if (!ok) throw new Error(`Failed to consume wake ${w.requestId} for terminal ${runId}`);
  }
}

export function consumeStaleWakesForWaiting(
  ctx: EngineContext,
  runId: string,
  view: ReturnType<EngineContext["store"]["view"]["get"]>,
): void {
  const wakes = ctx.store.approvals.listOutstandingWakes(runId as RunId);
  for (const w of wakes) {
    const exec = view.executions[w.path];
    if (exec?.status === "succeeded" && exec.approvalDecision) {
      const ok = ctx.store.approvals.consumeWake(
        { runId: w.runId, path: w.path, attempt: w.attempt, generation: w.generation },
        w.requestId,
      );
      if (!ok) throw new Error(`Failed to consume stale wake ${w.requestId} for waiting ${runId}`);
    }
  }
}

export function hasWaitingApproval(
  plan: { nodes: readonly { id: string }[] },
  executions: Record<string, { status: string }>,
): boolean {
  return plan.nodes.some((node) => executions[node.id]?.status === "waiting_approval");
}
export function isWaiting(
  plan: { nodes: readonly { id: string }[] },
  executions: Record<string, { status: string }>,
): boolean {
  const waiting = new Set([
    "running",
    "validating",
    "waiting_approval",
    "waiting_quota",
    "interrupted",
  ]);
  return plan.nodes.some((node) => {
    const status = executions[node.id]?.status;
    return status !== undefined && waiting.has(status);
  });
}
