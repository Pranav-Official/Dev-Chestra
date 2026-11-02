import { join } from "node:path";
import {
  acquireFileLock,
  getProvider,
  piCredentialScope,
  type ReleaseFileLock,
} from "@devchestra/adapters";
import { type ExecutionIdentity, hashJson, type Path } from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";
import type { ScratchWorkspace } from "@devchestra/workspaces";
import {
  type AttemptLoop,
  type AttemptPrepared,
  runSingleAttempt,
  type SingleAttemptResult,
} from "./agent-attempt.js";
import { decideAttemptOutcome } from "./agent-outcome.js";
import { readCliId, resolveAgentAdapter } from "./agent-preflight.js";
import {
  cancelAgentGeneration,
  countNoSubmit,
  failAgentGeneration,
  finalizeAccepted,
  toStopSignal,
} from "./agent-support.js";
import { type ActiveRunState, type EngineContext, toDevChestraError } from "./context.js";
import type { PlanNode, ScopeSource } from "./graph-plan.js";
import { stripUi } from "./hash-config.js";
import { composeAgentPrompt, renderAgentInputContext, renderSubmitContract } from "./prompt.js";
import { buildScopeData } from "./scope.js";
import { ProcessGroupAliveError, StopSignal } from "./stop.js";

export async function executeAgent(
  ctx: EngineContext,
  run: RunRecord,
  source: ScopeSource,
  node: PlanNode,
  active: ActiveRunState,
): Promise<void> {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  const path = node.id as Path;
  const limits = (node.raw.limits ?? {}) as Record<string, unknown>;
  const validationLimit = Math.max(1, Number(limits.validationRetries ?? 2) + 1);
  const crashLimit = Math.max(0, Number(limits.crashRetries ?? 1));
  const existing = ctx.store.executions.get(run.id, path);
  const execution =
    existing ??
    ctx.store.executions.ensure({
      runId: run.id,
      path,
      nodeId: node.id,
      kind: "agent",
      requireSubmission: true,
      validationLimit,
    });
  if (execution.status === "succeeded") return;

  const initialView = ctx.store.view.get(run.id).executions[node.id];
  if (
    initialView?.acceptedResult !== null &&
    initialView?.acceptedResult !== undefined &&
    !["succeeded", "failed", "cancelled", "rejected"].includes(execution.status)
  ) {
    await finalizeAccepted(ctx, run, node, active, initialView.acceptedResult);
    return;
  }

  // Pre-flight CLI gate before any durable work or workspace acquisition.
  // An unknown or non-opted-in experimental CLI id must fail with E_CLI_MISSING
  // without acquiring a workspace (previously the unknown-CLI throw happened
  // after acquire and outside the release `finally`, leaking the workspace)
  // and without recording a durable attempt. This duplicates the resolution at
  // the top of runAttempts, which is cheap and idempotent (registry reads).
  resolveAgentAdapter(ctx, node);

  const configHash = await hashJson(stripUi(node.raw));
  const mode =
    execution.status === "interrupted" || execution.sessionId !== null ? "resume" : "fresh";
  const identity = ctx.store.executions.beginInvocation({
    runId: run.id,
    path,
    attempt: execution.attempt,
    mode: execution.sessionId === null ? "fresh" : "resume",
    resolvedConfigHash: configHash,
  });

  let workspace: ScratchWorkspace | undefined;
  let releaseCredentialLock: ReleaseFileLock | undefined;
  try {
    workspace = await ctx.acquire(
      run,
      node.id,
      identity.attempt,
      identity.generation,
      active.abort.signal,
    );
    ctx.appendWorkspaceCreated(identity, workspace);

    // Pi runs that share a canonical credential store serialize here, for the
    // whole attempt sequence: Pi's auth.json lock is per supplied path
    // (proper-lockfile realpath:false), so per-run symlinks alone cannot
    // exclude each other and concurrent OAuth refreshes lose updates. The
    // scope matches plan()'s symlink predicate over the same base env, so a
    // null scope means this run touches no shared store and skips the lock.
    const agentCli = readCliId(node.raw.cli);
    const agentAdapter = ctx.deps.adapters.get(getProvider(agentCli).id);
    const credentialScope =
      agentAdapter.id === "pi" ? piCredentialScope(ctx.baseEnv(agentCli), workspace.dir) : null;
    if (credentialScope !== null) {
      try {
        releaseCredentialLock = await acquireFileLock(
          join(credentialScope, "auth.json.devchestra-lock"),
          { signal: active.abort.signal },
        );
      } catch (error) {
        if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
        throw toDevChestraError(error);
      }
    }

    await runAttempts(ctx, run, source, node, active, workspace, {
      identity,
      validationLimit,
      crashLimit,
      configHash,
      initialMode: mode,
    });
  } catch (error) {
    // Outer guard covers acquire/lock/setup only; retry-loop outcomes were
    // already finalized inside runAttempts. Helpers no-op once terminal.
    if (error instanceof ProcessGroupAliveError) throw error;
    const stopSignal = toStopSignal(error, active);
    if (stopSignal !== null) {
      await cancelAgentGeneration(ctx, run, node, workspace, identity, active);
      throw stopSignal;
    }
    const devchestra = toDevChestraError(error);
    try {
      await failAgentGeneration(ctx, run, node, workspace, identity, devchestra);
    } catch (failError) {
      if (failError instanceof ProcessGroupAliveError) throw failError;
      ctx.appendError(run.id, node.id, toDevChestraError(failError, "E_WORKSPACE"));
    }
    throw devchestra;
  } finally {
    if (workspace !== undefined) ctx.release(workspace);
    if (releaseCredentialLock !== undefined) await releaseCredentialLock().catch(() => undefined);
  }
}

interface AttemptState {
  identity: ExecutionIdentity;
  validationLimit: number;
  crashLimit: number;
  configHash: string;
  initialMode: "fresh" | "resume";
}

async function runAttempts(
  ctx: EngineContext,
  run: RunRecord,
  source: ScopeSource,
  node: PlanNode,
  active: ActiveRunState,
  initialWorkspace: ScratchWorkspace,
  state: AttemptState,
): Promise<void> {
  const { adapter } = resolveAgentAdapter(ctx, node);
  const ancestors = await ctx.chainOutputs(run, source, node.id);
  const scope = buildScopeData(run.params, ancestors);
  const rendered = await ctx.render(String(stripUi(node.raw).prompt ?? ""), scope);
  const submitRef = adapter.toolRef("submit_result");
  const contract = renderSubmitContract({ submitRef });
  const inputContext = renderAgentInputContext(scope);
  const basePrompt = composeAgentPrompt(rendered.text, contract, inputContext);
  const prepared: AttemptPrepared = {
    adapter,
    basePrompt,
    contract,
    inputContext,
    scope,
    schemaHash: await hashJson(node.raw.output),
    baseEnv: ctx.baseEnv(adapter.id),
  };
  const loop: AttemptLoop = {
    workspace: initialWorkspace,
    identity: state.identity,
    mode: state.initialMode,
    sessionId: ctx.execution(run.id, node.id).sessionId ?? undefined,
    sessionCwd: ctx.execution(run.id, node.id).sessionCwd ?? undefined,
    noSubmitAttempts: countNoSubmit(ctx, run.id, node.id, state.identity.attempt),
    cumulativeIn: 0,
    cumulativeOut: 0,
    cumulativeCost: 0,
  };

  for (;;) {
    // Single guarded attempt: setup/plan failures and outcome failures share
    // one failure path for the current loop.identity/workspace. attempt is
    // optional because runSingleAttempt may throw before returning (inner
    // cleanup already ran); attempt?.cleanup() is then a safe no-op.
    // The abort check lives INSIDE the try so a cancel landing after a retry
    // finalizes the current generation (loop.identity), not the stale
    // initial outer identity.
    let attempt: SingleAttemptResult | undefined;
    try {
      if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
      attempt = await runSingleAttempt(
        ctx,
        run,
        node,
        active,
        prepared,
        loop,
        state.validationLimit,
      );
      const outcome = await decideAttemptOutcome(
        ctx,
        run,
        node,
        active,
        adapter.id,
        attempt,
        loop,
        {
          validationLimit: state.validationLimit,
          crashLimit: state.crashLimit,
          configHash: state.configHash,
          schemaHash: prepared.schemaHash,
        },
      );
      if (outcome.action === "done") return;
    } catch (error) {
      attempt?.cleanup();
      if (error instanceof ProcessGroupAliveError) throw error;
      const stopSignal = toStopSignal(error, active);
      if (stopSignal !== null) {
        await cancelAgentGeneration(ctx, run, node, loop.workspace, loop.identity, active);
        throw stopSignal;
      }
      // Setup/planning or outcome-classification failure: persist the
      // original error with crash stop + failed workspace so no Running
      // execution survives a Failed run. Live processes are never marked
      // stopped (failAgentGeneration pauses instead).
      const devchestra = toDevChestraError(error);
      await failAgentGeneration(ctx, run, node, loop.workspace, loop.identity, devchestra);
      throw devchestra;
    }
  }
}
