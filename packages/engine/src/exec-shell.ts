import { containerBaseEnv, resolveForgeCredentials, runCommand } from "@devchestra/adapters";
import { DevChestraError, type Path } from "@devchestra/core";
import type { RunRecord } from "@devchestra/store";
import type { ScratchWorkspace } from "@devchestra/workspaces";
import { type ActiveRunState, type EngineContext, toDevChestraError } from "./context.js";
import type { PlanNode, ScopeSource } from "./graph-plan.js";
import { stripUi } from "./hash-config.js";
import { ProcessGroupAliveError, StopSignal } from "./stop.js";

const TAIL_BYTES = 64 * 1024;

export async function executeShell(
  ctx: EngineContext,
  run: RunRecord,
  source: ScopeSource,
  node: PlanNode,
  active: ActiveRunState,
): Promise<void> {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  const path = node.id as Path;
  const existing = ctx.store.executions.get(run.id, path);
  const execution =
    existing ??
    ctx.store.executions.ensure({
      runId: run.id,
      path,
      nodeId: node.id,
      kind: "shell",
      requireSubmission: false,
    });
  if (execution.status === "succeeded") return;

  const configHash = await ctx.configHash(node);
  const uncertain = execution.status === "interrupted" && active.overrideApprovedBy !== undefined;
  const identity = ctx.store.executions.beginInvocation({
    runId: run.id,
    path,
    attempt: execution.attempt,
    mode: "fresh",
    resolvedConfigHash: configHash,
    ...(uncertain
      ? {
          allowUncertainSideEffectRetry: true,
          approvedBy: active.overrideApprovedBy as string,
        }
      : {}),
  });

  let workspace: ScratchWorkspace | undefined;
  const releaseCredentials: (() => void)[] = [];
  try {
    workspace = await ctx.acquire(
      run,
      node.id,
      identity.attempt,
      identity.generation,
      active.abort.signal,
    );
    ctx.appendWorkspaceCreated(identity, workspace);
    const ancestors = await ctx.chainOutputs(run, source, node.id);
    const scope = {
      start: run.params,
      ...Object.fromEntries(ancestors.map((item) => [item.nodeId, item.output])),
    };
    const rendered = await ctx.render(String(stripUi(node.raw).command ?? ""), scope, true);
    const command = rendered.text;
    const timeoutMs = Math.min(
      Math.max(1, Number(node.raw.timeoutMin ?? 1) * 60_000),
      Math.max(1, ctx.deps.maxNodeTimeoutMs ?? Number.MAX_SAFE_INTEGER),
    );
    if (
      workspace.mode !== "container" &&
      Array.isArray(node.raw.credentials) &&
      node.raw.credentials.length
    )
      throw new DevChestraError("E_VALIDATION", "Node credentials require a container workspace");
    const forge =
      workspace.mode === "container"
        ? resolveForgeCredentials(ctx.deps.dataDir, run.project.path, node.raw.credentials)
        : { env: {}, secrets: [] };
    for (const secret of forge.secrets)
      releaseCredentials.push(ctx.store.security.registerSecret(secret, "forge-token"));
    const result = await runCommand(
      {
        cmd: command,
        shell: true,
        cwd: workspace.dir,
        env:
          workspace.mode === "container"
            ? { ...containerBaseEnv(ctx.baseEnv("fake")), ...forge.env }
            : ctx.baseEnv("fake"),
        ...(workspace.mode === "container"
          ? {
              container: ctx.containerExecution(run, workspace, identity) as NonNullable<
                ReturnType<typeof ctx.containerExecution>
              >,
            }
          : {}),
        timeoutMs,
        maxStdoutBytes: TAIL_BYTES,
        maxStderrBytes: TAIL_BYTES,
      },
      {
        redact: (text) =>
          forge.secrets.reduce((value, secret) => value.split(secret).join("[redacted]"), text),
        generation: identity.generation,
        onSpawn: async (spawn) => {
          ctx.store.executions.recordSpawned({
            identity,
            pid: spawn.pid,
            pidStart: spawn.pidStart,
            binary: spawn.binary,
            cwd: spawn.cwd,
          });
        },
      },
      active.abort.signal,
    );

    if (result.groupStopped !== true) {
      ctx.appendError(
        run.id,
        node.id,
        new DevChestraError(
          "E_WORKSPACE",
          "Shell process group did not stop after the kill grace",
          {
            details: { step: "group_still_alive", pid: result.pid },
          },
        ),
      );
      ctx.append(run.id, "", "run.paused", "engine", {
        reason: "shutdown",
        detail: "A shell process group is still alive; retry after it exits",
      });
      throw new ProcessGroupAliveError("Shell process group is still alive", {
        step: "group_still_alive",
        pid: result.pid,
      });
    }
    const stopReason =
      result.killedBy === "timeout"
        ? "grace_timeout"
        : result.killedBy === "cancel"
          ? "killed"
          : result.signal !== null
            ? "crash"
            : "exited";
    ctx.recordStop(identity, stopReason, result.exitCode);
    const output = {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    };

    if (result.killedBy === "cancel" || active.abort.signal.aborted) {
      const shutdown = active.reason === "shutdown";
      await ctx.finalize(workspace, identity, "cancelled", {
        reason: "killed",
        exitCode: result.exitCode,
      });
      ctx.transition(
        identity,
        shutdown ? "interrupted" : "cancelled",
        shutdown ? "shutdown" : "cancelled",
      );
      throw new StopSignal(active.reason ?? "user");
    }

    ctx.store.outputs.recordDeterministic({ identity, output });

    if (result.exitCode !== 0 && node.raw.allowFailure !== true) {
      const error = new DevChestraError(
        stopReason === "grace_timeout" ? "E_CLI_CRASH" : "E_CLI_CRASH",
        `Shell command failed with exit code ${String(result.exitCode)}`,
        { details: { exitCode: result.exitCode, signal: result.signal } },
      );
      await ctx.finalize(workspace, identity, "failed", {
        reason: stopReason,
        exitCode: result.exitCode,
      });
      ctx.failExecution(run, node, identity, error);
      throw error;
    }

    await ctx.finalize(workspace, identity, "success", {
      reason: stopReason,
      exitCode: result.exitCode,
    });
    ctx.store.executions.complete({ identity });
  } catch (error) {
    if (error instanceof ProcessGroupAliveError) throw error;
    if (error instanceof StopSignal) throw error;
    if (active.abort.signal.aborted) {
      const shutdown = active.reason === "shutdown";
      if (workspace !== undefined) {
        const evidence = ctx.persistedStop(identity) ?? {
          reason: "killed" as const,
          exitCode: null,
        };
        try {
          await ctx.finalize(workspace, identity, "cancelled", evidence);
        } catch {
          // Cancellation still proceeds without new result state.
        }
      }
      if (
        ctx.currentStatus(identity) === "running" ||
        ctx.currentStatus(identity) === "validating"
      ) {
        ctx.transition(
          identity,
          shutdown ? "interrupted" : "cancelled",
          shutdown ? "shutdown" : "cancelled",
        );
      }
      throw new StopSignal(active.reason ?? "user");
    }
    const devchestra = toDevChestraError(error);
    if (workspace !== undefined) {
      const stopped = ctx.persistedStop(identity);
      if (stopped === null) {
        try {
          ctx.recordStop(identity, "crash", null);
        } catch {
          // A boot recovery pass will establish stop evidence.
        }
      }
      const evidence = ctx.persistedStop(identity) ?? { reason: "crash" as const, exitCode: null };
      try {
        await ctx.finalize(workspace, identity, "failed", evidence);
      } catch {
        // Failure evidence may be retried by boot recovery.
      }
    }
    if (ctx.currentStatus(identity) === "running" || ctx.currentStatus(identity) === "validating") {
      ctx.failExecution(run, node, identity, devchestra);
    }
    throw devchestra;
  } finally {
    for (const release of releaseCredentials) release();
    if (workspace !== undefined) ctx.release(workspace);
  }
}
