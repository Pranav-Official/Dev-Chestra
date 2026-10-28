import type { Path } from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";
import type { ActiveRunState } from "./context.js";
import { type EngineContext, toDevChestraError } from "./context.js";
import type { PlanNode, ScopeSource } from "./graph-plan.js";
import { buildScopeData } from "./scope.js";
import type { LinearChain } from "./sequence.js";
import { StopSignal } from "./stop.js";

export async function executeDeterministic(
  ctx: EngineContext,
  run: RunRecord,
  source: ScopeSource | LinearChain,
  node: PlanNode,
  active: ActiveRunState,
): Promise<void> {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  const path = node.id as Path;
  const existing = ctx.store.executions.get(run.id, path);
  const kind = node.type === "start" ? "start" : "end";
  const execution =
    existing ??
    ctx.store.executions.ensure({
      runId: run.id,
      path,
      nodeId: node.id,
      kind,
      requireSubmission: false,
    });
  if (execution.status === "succeeded") return;

  const configHash = await ctx.configHash(node);
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  const identity = ctx.store.executions.beginInvocation({
    runId: run.id,
    path,
    attempt: execution.attempt,
    mode: "fresh",
    resolvedConfigHash: configHash,
  });

  try {
    let output: unknown;
    if (node.type === "start") {
      output = { ...run.params };
    } else {
      const ancestors = await ctx.chainOutputs(run, source, node.id);
      const scope = buildScopeData(run.params, ancestors);
      output = await ctx.evaluate(String(node.raw.result ?? ""), scope);
    }
    if (active.abort.signal.aborted) {
      stopDeterministic(ctx, identity, active);
    }
    if (node.type === "end") {
      const status =
        node.raw.status === "failed"
          ? "failed"
          : node.raw.status === "rejected"
            ? "rejected"
            : "success";
      ctx.store.tx(() => {
        ctx.store.outputs.recordDeterministic({ identity, output });
        ctx.store.executions.complete({ identity });
        ctx.completeRun(run.id, status, path, output);
      });
    } else {
      ctx.store.outputs.recordDeterministic({ identity, output });
      ctx.store.executions.complete({ identity });
    }
  } catch (error) {
    if (error instanceof StopSignal) {
      stopDeterministic(ctx, identity, active);
      throw error;
    }
    ctx.failExecution(run, node, identity, toDevChestraError(error));
    throw error;
  }
}

function stopDeterministic(
  ctx: EngineContext,
  identity: import("@devchestra/core").ExecutionIdentity,
  active: ActiveRunState,
): void {
  const kind = active.reason ?? "user";
  const status = ctx.currentStatus(identity);
  if (status === "running" || status === "validating") {
    ctx.transition(identity, kind === "shutdown" ? "interrupted" : "cancelled", kind);
  }
}
