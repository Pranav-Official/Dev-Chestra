import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type AdapterEvent,
  type CliId,
  type FailureClass,
  getProvider,
  killOrphan,
  runAgent,
} from "@relay/adapters";
import { type ExecutionIdentity, fsSlug, hashJson, type Path, RelayError } from "@relay/core";
import type { RunRecord } from "@relay/store";
import { resolveInside, type ScratchWorkspace } from "@relay/workspaces";
import { consumeNoSubmit, countNoSubmit, finalizeAccepted, secretValues } from "./agent-support.js";
import { type ActiveRunState, type EngineContext, toRelayError } from "./context.js";
import type { PlanNode, ScopeSource } from "./graph-plan.js";
import { stripUi } from "./hash-config.js";
import { type AttemptFailure, decideNextAttempt } from "./plan.js";
import {
  assertAgentPromptSize,
  composeAgentPrompt,
  renderAgentInputContext,
  renderSubmitContract,
} from "./prompt.js";
import { buildScopeData } from "./scope.js";
import type { LinearChain } from "./sequence.js";
import { ProcessGroupAliveError, StopSignal } from "./stop.js";
import { openTranscript, type TranscriptWriter } from "./transcript.js";

const NO_SUBMIT_PROMPT =
  "You ended your turn without calling submit_result. Call it now with your final result.";

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

function stopReason(input: {
  accepted: boolean;
  finishedByGrace: boolean;
  cancelled: boolean;
  failureKind: string;
  signal: string | null;
}): "exited" | "killed" | "grace_timeout" | "crash" {
  if (input.cancelled) return "killed";
  if (input.finishedByGrace) return "grace_timeout";
  if (input.failureKind === "timeout") return input.accepted ? "grace_timeout" : "crash";
  if (input.failureKind === "crash") return "crash";
  if (!input.accepted && input.signal !== null) return "crash";
  return "exited";
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
  let workspace = initialWorkspace;
  const provider = getProvider(node.raw.cli as CliId);
  const adapter = ctx.deps.adapters.get(provider.id);
  if (provider.experimental) {
    const allowed = ctx.deps.allowExperimentalClis ?? [];
    if (!allowed.includes(provider.id as "claude-code" | "codex" | "opencode" | "pi")) {
      throw new RelayError(
        "E_CLI_MISSING",
        `Adapter '${provider.id}' is not enabled in this build. The caller must opt in with an explicit experimental flag after a live contract check.`,
        { details: { cli: provider.id, behaviorVerified: adapter.evidence.behaviorVerified } },
      );
    }
  }
  const ancestors = await ctx.chainOutputs(run, source, node.id);
  const scope = buildScopeData(run.params, ancestors);
  const rendered = await ctx.render(String(stripUi(node.raw).prompt ?? ""), scope);
  const submitRef = adapter.toolRef("submit_result");
  const contract = renderSubmitContract({ submitRef });
  const inputContext = renderAgentInputContext(scope);
  const basePrompt = composeAgentPrompt(rendered.text, contract, inputContext);

  let identity = state.identity;
  let mode: "fresh" | "resume" = state.initialMode;
  let sessionId: string | undefined = ctx.execution(run.id, node.id).sessionId ?? undefined;
  let sessionCwd: string | undefined = ctx.execution(run.id, node.id).sessionCwd ?? undefined;
  let noSubmitAttempts = countNoSubmit(ctx, run.id, node.id, state.identity.attempt);
  let cumulativeIn = 0;
  let cumulativeOut = 0;
  let cumulativeCost = 0;

  const transitionInterrupted = (reason: string): void => {
    const status = ctx.currentStatus(identity);
    if (status === "running" || status === "validating") {
      ctx.transition(identity, "interrupted", reason);
    }
  };

  for (;;) {
    if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
    if (workspace.generation !== identity.generation) {
      const next = await ctx.acquire(
        run,
        node.id,
        identity.attempt,
        identity.generation,
        active.abort.signal,
      );
      ctx.release(workspace);
      ctx.appendWorkspaceCreated(identity, next);
      workspace = next;
    }
    const timeoutMs = Math.min(
      Math.max(1, Number((node.raw.limits as Record<string, unknown>)?.timeoutMin ?? 30) * 60_000),
      Math.max(1, ctx.deps.maxNodeTimeoutMs ?? Number.MAX_SAFE_INTEGER),
    );
    const prompt =
      mode === "resume" && noSubmitAttempts > 0
        ? composeAgentPrompt(NO_SUBMIT_PROMPT, contract, inputContext)
        : basePrompt;
    assertAgentPromptSize(prompt);
    const inputsHash = await hashJson({ prompt, scope });
    ctx.appendInputResolved(identity, inputsHash, { prompt, scope });
    const schemaHash = await hashJson(node.raw.output);
    const issued = ctx.deps.gateway.issue({
      identity,
      outputSchema: node.raw.output as Record<string, unknown>,
      outputSchemaHash: schemaHash,
      validationLimit: state.validationLimit,
      expiresAt: ctx.now() + timeoutMs + 30_000,
    });
    const releaseSecret = ctx.store.security.registerSecret(issued.token, "exec-token");
    const revoke = (): void => {
      issued.revoke();
      releaseSecret();
    };
    active.tokens.add(revoke);

    const execRoot = realpathSync.native(ctx.deps.dataDir);
    // Fake resumes need a stable per-node/attempt directory; real adapters
    // keep the generation-specific exec dir.
    const stableFake = adapter.id === "fake" && run.workspace !== null;
    const execSegment = stableFake
      ? `fake-a${identity.attempt}`
      : `a${identity.attempt}g${identity.generation}`;
    const execResolved = resolveInside(
      execRoot,
      join("exec", run.id, fsSlug(node.id as Path), execSegment),
    );
    if (!execResolved.ok) throw execResolved.error;
    const execDir = execResolved.value;
    mkdirSync(execDir, { recursive: true, mode: 0o700 });
    chmodSync(execDir, 0o700);

    const transcript = openTranscript({
      dataDir: ctx.deps.dataDir,
      projectId: run.project.id,
      runId: run.id,
      path: node.id as Path,
      attempt: identity.attempt,
      generation: identity.generation,
      secrets: secretValues(ctx, issued.token),
    });

    let finishTimer: NodeJS.Timeout | undefined;
    let finishedByGrace = false;
    let spawned: { pid: number; pidStart: string; binary: string } | undefined;
    let lastSession = sessionId;

    const checkAccepted = (): void => {
      const accepted = ctx.store.submissions.accepted(identity);
      if (accepted === null || finishTimer !== undefined || spawned === undefined) return;
      finishTimer = setTimeout(() => {
        finishedByGrace = true;
        void killOrphan(spawned as { pid: number; pidStart: string; binary: string }, {
          graceMs: 5_000,
        }).catch(() => undefined);
      }, ctx.deps.finishGraceMs ?? 60_000);
      finishTimer.unref();
    };

    const hooks = {
      onSpawn: async (spawn: { pid: number; pidStart: string; binary: string; cwd: string }) => {
        spawned = { pid: spawn.pid, pidStart: spawn.pidStart, binary: spawn.binary };
        ctx.store.executions.recordSpawned({
          identity,
          pid: spawn.pid,
          pidStart: spawn.pidStart,
          binary: spawn.binary,
          cwd: spawn.cwd,
        });
      },
      onEvent: async (event: AdapterEvent) => {
        switch (event.t) {
          case "session":
            if (event.sessionId !== lastSession) {
              sessionId = event.sessionId;
              sessionCwd = workspace.dir;
              lastSession = event.sessionId;
              ctx.appendSession(
                identity,
                adapter.id,
                event.sessionId,
                workspace.dir,
                node.raw.model as string | undefined,
              );
            }
            break;
          case "usage": {
            const tokensIn = event.tokensIn ?? 0;
            const tokensOut = event.tokensOut ?? 0;
            const cost = event.costUsd ?? 0;
            const deltaIn = event.cumulative ? Math.max(0, tokensIn - cumulativeIn) : tokensIn;
            const deltaOut = event.cumulative ? Math.max(0, tokensOut - cumulativeOut) : tokensOut;
            const deltaCost = event.cumulative ? Math.max(0, cost - cumulativeCost) : cost;
            cumulativeIn = Math.max(cumulativeIn, tokensIn);
            cumulativeOut = Math.max(cumulativeOut, tokensOut);
            cumulativeCost = Math.max(cumulativeCost, cost);
            ctx.appendUsage(
              identity,
              {
                ...(deltaIn === 0 ? {} : { tokensIn: deltaIn }),
                ...(deltaOut === 0 ? {} : { tokensOut: deltaOut }),
                ...(deltaCost === 0 ? {} : { costUsd: deltaCost }),
              },
              event.costUsd === undefined ? "none" : "reported",
            );
            break;
          }
          case "tool_result":
            checkAccepted();
            break;
          case "turn_end":
            checkAccepted();
            break;
          default:
            break;
        }
      },
      onStderr: (chunk: string) => {
        transcript.write({ ts: new Date().toISOString(), kind: "stderr", text: chunk });
      },
      onTranscript: (entry: { ts: string; kind: string; text: string }) => {
        transcript.write(entry as Parameters<TranscriptWriter["write"]>[0]);
      },
      redact: (text: string) => {
        let value = text;
        for (const secret of secretValues(ctx, issued.token))
          value = value.split(secret).join("[redacted]");
        return value;
      },
    };

    try {
      const fakeCheckpoint =
        adapter.id !== "fake"
          ? undefined
          : stableFake
            ? join(execDir, "fake-checkpoint.json")
            : join(workspace.dir, ".relay/fake-checkpoint.json");
      const effectiveMode =
        adapter.id === "fake" && mode === "resume" && !existsSync(fakeCheckpoint as string)
          ? "fresh"
          : mode;
      const request = {
        mode: effectiveMode,
        ...(effectiveMode === "resume" && sessionId !== undefined ? { sessionId } : {}),
        prompt,
        cwd: workspace.dir,
        ...(node.raw.model === undefined ? {} : { model: node.raw.model as string }),
        permissions: {
          network: (node.raw.permissions as Record<string, unknown>).network === true,
          write: (((node.raw.permissions as Record<string, unknown>).write as string[]) ?? []) as (
            | "workspace"
            | "project"
          )[],
          extraReadDirs: [],
        },
        limits: { timeoutMs },
        mcp: {
          serverName: "relay" as const,
          command: ctx.deps.nodeBin,
          args: [ctx.deps.mcpShimEntry],
          env: {
            RELAY_EXEC_TOKEN: issued.token,
            RELAY_GATEWAY_URL: ctx.deps.gateway.url,
            RELAY_TOOLSET: "agent",
            RELAY_MCP_SHIM_ENTRY: ctx.deps.mcpShimEntry,
          },
        },
        execDir,
        env: ctx.baseEnv(adapter.id),
        ...(fakeCheckpoint === undefined ? {} : { cliOptions: { checkpoint: fakeCheckpoint } }),
      };
      const planned = adapter.plan(request);
      if (!planned.ok) throw planned.error;
      let exit: Awaited<ReturnType<typeof runAgent>>;
      try {
        exit = await runAgent(planned.value, hooks, active.abort.signal, {
          parser: adapter.parser(),
          timeoutMs,
          graceMs: 5_000,
          generation: identity.generation,
        });
      } finally {
        transcript.close();
      }
      if (finishTimer !== undefined) clearTimeout(finishTimer);
      if (exit.groupStopped !== true) {
        revoke();
        active.tokens.delete(revoke);
        ctx.appendError(
          run.id,
          node.id,
          new RelayError("E_WORKSPACE", "Agent process group did not stop after the kill grace", {
            details: { step: "group_still_alive", pid: exit.pid },
          }),
        );
        ctx.append(run.id, "", "run.paused", "engine", {
          reason: "shutdown",
          detail: "An agent process group is still alive; retry after it exits",
        });
        throw new ProcessGroupAliveError("Agent process group is still alive", {
          step: "group_still_alive",
          pid: exit.pid,
        });
      }
      const accepted = ctx.store.submissions.accepted(identity);
      const failure = adapter.classify(exit, exit.tail);
      const cancelled = exit.killedBy === "cancel" || active.abort.signal.aborted;
      const reason = stopReason({
        accepted: accepted !== null,
        finishedByGrace,
        cancelled,
        failureKind: failure.kind,
        signal: exit.signal,
      });
      ctx.recordStop(identity, reason, exit.code);
      ctx.appendTranscriptRef(identity, transcript.file, transcript.bytes());
      revoke();
      active.tokens.delete(revoke);

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
            schemaHash,
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
          hasSession: sessionId !== undefined,
          sameCwd: sessionCwd === workspace.dir,
          crashAttempts: view?.crashAttempts ?? 0,
          crashLimit: state.crashLimit,
          noSubmitAttempts,
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
        hasSession: sessionId !== undefined,
        sameCwd: sessionCwd === workspace.dir,
        crashAttempts: after?.crashAttempts ?? 0,
        crashLimit: state.crashLimit,
        noSubmitAttempts,
        noSubmitLimit: 1,
        acceptFreshFallback: true,
      });
      if (decision.action === "fail") {
        // Keep the CLI's own startup diagnostic on the node error (redacted,
        // bounded) instead of forcing transcript inspection for e.g. Pi's
        // credentials_not_configured. Message stays stable for matching.
        const rawDiagnostic = hooks.redact(exit.tail.stderr).trim();
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
      if (mapped.kind === "no_submit") noSubmitAttempts += 1;
      transitionInterrupted(decision.reason);
      const next = ctx.store.executions.beginInvocation({
        runId: run.id,
        path: node.id as Path,
        attempt: identity.attempt,
        mode: decision.action,
        resolvedConfigHash: state.configHash,
      });
      identity = next;
      mode = decision.action;
    } catch (error) {
      if (finishTimer !== undefined) clearTimeout(finishTimer);
      transcript.close();
      revoke();
      active.tokens.delete(revoke);
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
