import { join } from "node:path";
import {
  acquireFileLock,
  type FailureClass,
  getProvider,
  piCredentialScope,
  type ReleaseFileLock,
} from "@relay/adapters";
import { type ExecutionIdentity, hashJson, type Path, RelayError } from "@relay/core";
import type { RunRecord } from "@relay/store";
import type { ScratchWorkspace } from "@relay/workspaces";
import { type AttemptLoop, type AttemptPrepared, runSingleAttempt } from "./agent-attempt.js";
import { readCliId, resolveAgentAdapter } from "./agent-preflight.js";
import { consumeNoSubmit, countNoSubmit, finalizeAccepted } from "./agent-support.js";
import { type ActiveRunState, type EngineContext, toRelayError } from "./context.js";
import type { PlanNode, ScopeSource } from "./graph-plan.js";
import { stripUi } from "./hash-config.js";
import { type AttemptFailure, decideNextAttempt } from "./plan.js";
import { composeAgentPrompt, renderAgentInputContext, renderSubmitContract } from "./prompt.js";
import { buildScopeData } from "./scope.js";
import type { LinearChain } from "./sequence.js";
import { ProcessGroupAliveError, StopSignal } from "./stop.js";

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

  const transitionInterrupted = (reason: string): void => {
    const status = ctx.currentStatus(loop.identity);
    if (status === "running" || status === "validating") {
      ctx.transition(loop.identity, "interrupted", reason);
    }
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
    const { identity, accepted, failure, cancelled, reason, exit } = attempt;
    const workspace = loop.workspace;

    try {
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
            schemaHash: prepared.schemaHash,
            attempt: identity.attempt,
            generation: identity.generation,
            acceptedEventId: 0,
          },
          workspace,
        );
        return;
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
        throw new RelayError("E_CLI_MISSING", `Adapter '${adapter.id}' binary is missing`);
      }
      if (mapped.kind === "no_submit") {
        if (consumeNoSubmit(ctx, identity) === "exhausted") {
          mapped = { kind: "validation_exhausted" };
        }
      }
      const afterValidation = ctx.store.view.get(run.id).executions[node.id];
      if ((afterValidation?.validationAttempts ?? 0) >= state.validationLimit) {
        mapped = { kind: "validation_exhausted" };
      }
      if (mapped.kind === "rate_limit" || mapped.kind === "quota" || mapped.kind === "auth") {
        transitionInterrupted(mapped.kind);
        const decision = decideNextAttempt({
          failure: mapped,
          hasSession: loop.sessionId !== undefined,
          sameCwd: loop.sessionCwd === workspace.dir,
          crashAttempts: view?.crashAttempts ?? 0,
          crashLimit: state.crashLimit,
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
          return;
        }
      }
      const after = ctx.store.view.get(run.id).executions[node.id];
      const decision = decideNextAttempt({
        failure: mapped,
        hasSession: loop.sessionId !== undefined,
        sameCwd: loop.sessionCwd === workspace.dir,
        crashAttempts: after?.crashAttempts ?? 0,
        crashLimit: state.crashLimit,
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
        const error = new RelayError(decision.code, `Agent node failed: ${decision.reason}`, {
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
      if (decision.action === "stop") return;
      if (mapped.kind === "no_submit") loop.noSubmitAttempts += 1;
      transitionInterrupted(decision.reason);
      const next = ctx.store.executions.beginInvocation({
        runId: run.id,
        path: node.id as Path,
        attempt: identity.attempt,
        mode: decision.action,
        resolvedConfigHash: state.configHash,
      });
      loop.identity = next;
      loop.mode = decision.action;
    } catch (error) {
      attempt.cleanup();
      if (error instanceof ProcessGroupAliveError) throw error;
      if (error instanceof StopSignal) {
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
