import { join } from "node:path";
import {
  acquireFileLock,
  getProvider,
  piCredentialScope,
  type ReleaseFileLock,
} from "@relay/adapters";
import { type ExecutionIdentity, hashJson, type Path } from "@relay/core";
import type { RunRecord } from "@relay/store";
import type { ScratchWorkspace } from "@relay/workspaces";
import { type AttemptLoop, type AttemptPrepared, runSingleAttempt } from "./agent-attempt.js";
import { decideAttemptOutcome } from "./agent-outcome.js";
import { readCliId, resolveAgentAdapter } from "./agent-preflight.js";
import { countNoSubmit, finalizeAccepted } from "./agent-support.js";
import { type ActiveRunState, type EngineContext, toRelayError } from "./context.js";
import type { PlanNode, ScopeSource } from "./graph-plan.js";
import { stripUi } from "./hash-config.js";
import { composeAgentPrompt, renderAgentInputContext, renderSubmitContract } from "./prompt.js";
import { buildScopeData } from "./scope.js";
import type { LinearChain } from "./sequence.js";
import { ProcessGroupAliveError, StopSignal } from "./stop.js";

export async function executeAgent(
  ctx: EngineContext,
  run: RunRecord,
  source: ScopeSource | LinearChain,
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

  const workspace = await ctx.acquire(
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
  let releaseCredentialLock: ReleaseFileLock | undefined;
  if (credentialScope !== null) {
    try {
      releaseCredentialLock = await acquireFileLock(join(credentialScope, "auth.json.relay-lock"), {
        signal: active.abort.signal,
      });
    } catch (error) {
      if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
      throw toRelayError(error);
    }
  }

  try {
    await runAttempts(ctx, run, source, node, active, workspace, {
      identity,
      validationLimit,
      crashLimit,
      configHash,
      initialMode: mode,
    });
  } finally {
    ctx.release(workspace);
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
  source: ScopeSource | LinearChain,
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
    if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
    const attempt = await runSingleAttempt(
      ctx,
      run,
      node,
      active,
      prepared,
      loop,
      state.validationLimit,
    );

    try {
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
      attempt.cleanup();
      if (error instanceof ProcessGroupAliveError) throw error;
      if (error instanceof StopSignal) {
        const identity = attempt.identity;
        const workspace = loop.workspace;
        const current = ctx.currentStatus(identity);
        if (current === "running" || current === "validating") {
          const shutdown = active.reason === "shutdown";
          const evidence = ctx.persistedStop(identity) ?? {
            reason: "killed" as const,
            exitCode: null,
          };
          try {
            await ctx.finalize(workspace, identity, "cancelled", evidence);
          } catch {
            // Cleanup continues; no result state is created after cancel.
          }
          ctx.transition(
            identity,
            shutdown ? "interrupted" : "cancelled",
            shutdown ? "shutdown" : "cancelled",
          );
        }
        throw error;
      }
      throw toRelayError(error);
    }
  }
}
