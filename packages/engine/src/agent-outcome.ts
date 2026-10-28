import type { FailureClass } from "@devchestra/adapters";
import { DevChestraError, type Path } from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";
import type { AttemptLoop, SingleAttemptResult } from "./agent-attempt.js";
import { consumeNoSubmit, finalizeAccepted } from "./agent-support.js";
import type { ActiveRunState, EngineContext } from "./context.js";
import type { PlanNode } from "./graph-plan.js";
import { type AttemptFailure, decideNextAttempt } from "./plan.js";
import { StopSignal } from "./stop.js";

function mapFailure(failure: FailureClass): AttemptFailure | null {
  switch (failure.kind) {
    case "ok":
      return { kind: "no_submit" };
    case "rate_limit":
      return { kind: "rate_limit" };
    case "quota_window":
      return { kind: "quota" };
    case "credits":
    case "auth":
      return { kind: "auth" };
    case "context_overflow":
      return { kind: "context_overflow" };
    case "crash":
      return { kind: "crash" };
    case "timeout":
      return { kind: "timeout" };
    case "cancelled":
      return { kind: "cancelled" };
    case "cli_missing":
      return null;
  }
}

export type AttemptOutcome = { action: "done" } | { action: "retry" };

export interface OutcomeBudgets {
  validationLimit: number;
  crashLimit: number;
  configHash: string;
  schemaHash: string;
}

/**
 * Classify a finished attempt and carry out its terminal side effects:
 * accepted finalization, cancellation, quota/auth pausing, failure mapping
 * and the next-attempt decision. Returns whether the loop is done; on retry
 * the loop state is advanced in place. Terminal failures throw.
 */
export async function decideAttemptOutcome(
  ctx: EngineContext,
  run: RunRecord,
  node: PlanNode,
  active: ActiveRunState,
  adapterId: string,
  attempt: SingleAttemptResult,
  loop: AttemptLoop,
  budgets: OutcomeBudgets,
): Promise<AttemptOutcome> {
  const { identity, accepted, failure, cancelled, reason, exit } = attempt;
  const workspace = loop.workspace;

  const transitionInterrupted = (transitionReason: string): void => {
    const status = ctx.currentStatus(loop.identity);
    if (status === "running" || status === "validating") {
      ctx.transition(loop.identity, "interrupted", transitionReason);
    }
  };

  if (accepted !== null) {
    await finalizeAccepted(
      ctx,
      run,
      node,
      active,
      {
        runId: run.id,
        path: node.id as Path,
        outputId: accepted.id,
        outputHash: accepted.hash,
        schemaHash: budgets.schemaHash,
        attempt: identity.attempt,
        generation: identity.generation,
        acceptedEventId: 0,
      },
      workspace,
    );
    return { action: "done" };
  }

  if (cancelled) {
    const shutdown = active.reason === "shutdown";
    await ctx.finalize(workspace, identity, "cancelled", {
      reason: "killed",
      exitCode: exit.code,
    });
    ctx.transition(
      identity,
      shutdown ? "interrupted" : "cancelled",
      shutdown ? "shutdown" : "cancelled",
    );
    throw new StopSignal(active.reason ?? "user");
  }

  const view = ctx.store.view.get(run.id).executions[node.id];
  let mapped = mapFailure(failure);
  if (mapped === null) {
    throw new DevChestraError("E_CLI_MISSING", `Adapter '${adapterId}' binary is missing`);
  }
  if (mapped.kind === "no_submit") {
    if (consumeNoSubmit(ctx, identity) === "exhausted") {
      mapped = { kind: "validation_exhausted" };
    }
  }
  const afterValidation = ctx.store.view.get(run.id).executions[node.id];
  if ((afterValidation?.validationAttempts ?? 0) >= budgets.validationLimit) {
    mapped = { kind: "validation_exhausted" };
  }
  if (mapped.kind === "rate_limit" || mapped.kind === "quota" || mapped.kind === "auth") {
    transitionInterrupted(mapped.kind);
    const decision = decideNextAttempt({
      failure: mapped,
      hasSession: loop.sessionId !== undefined,
      sameCwd: loop.sessionCwd === workspace.dir,
      crashAttempts: view?.crashAttempts ?? 0,
      crashLimit: budgets.crashLimit,
      noSubmitAttempts: loop.noSubmitAttempts,
      noSubmitLimit: 1,
      acceptFreshFallback: true,
    });
    if (decision.action === "stop") {
      if (mapped.kind === "quota" || mapped.kind === "auth") {
        ctx.append(run.id, node.id, "run.paused", "engine", {
          reason: mapped.kind === "auth" ? "budget" : "quota",
          detail: `Adapter reported ${mapped.kind}`,
        });
      }
      return { action: "done" };
    }
  }
  const after = ctx.store.view.get(run.id).executions[node.id];
  const decision = decideNextAttempt({
    failure: mapped,
    hasSession: loop.sessionId !== undefined,
    sameCwd: loop.sessionCwd === workspace.dir,
    crashAttempts: after?.crashAttempts ?? 0,
    crashLimit: budgets.crashLimit,
    noSubmitAttempts: loop.noSubmitAttempts,
    noSubmitLimit: 1,
    acceptFreshFallback: true,
  });
  if (decision.action === "fail") {
    // Keep the CLI's own startup diagnostic on the node error (redacted,
    // bounded) instead of forcing transcript inspection for e.g. Pi's
    // credentials_not_configured. Message stays stable for matching.
    const rawDiagnostic = attempt.redact(exit.tail.stderr).trim();
    const diagnostic =
      rawDiagnostic === ""
        ? undefined
        : rawDiagnostic.length <= 2000
          ? rawDiagnostic
          : `${rawDiagnostic.slice(0, 2000)}…[truncated]`;
    const error = new DevChestraError(decision.code, `Agent node failed: ${decision.reason}`, {
      details: {
        reason: decision.reason,
        exitCode: exit.code,
        signal: exit.signal,
        ...(diagnostic === undefined ? {} : { stderr: diagnostic }),
      },
    });
    const stopEvidence = ctx.persistedStop(identity) ?? { reason, exitCode: exit.code };
    await ctx.finalize(workspace, identity, "failed", stopEvidence);
    ctx.failExecution(run, node, identity, error);
    throw error;
  }
  if (decision.action === "stop") return { action: "done" };
  if (mapped.kind === "no_submit") loop.noSubmitAttempts += 1;
  transitionInterrupted(decision.reason);
  const next = ctx.store.executions.beginInvocation({
    runId: run.id,
    path: node.id as Path,
    attempt: identity.attempt,
    mode: decision.action,
    resolvedConfigHash: budgets.configHash,
  });
  loop.identity = next;
  loop.mode = decision.action;
  return { action: "retry" };
}
