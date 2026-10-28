import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type AdapterEvent,
  type AdapterRegistry,
  type FailureClass,
  killOrphan,
  type ResolvedMcpServer,
  type RunRequest,
  runAgent,
} from "@relay/adapters";
import { type ExecutionIdentity, fsSlug, hashJson, type Path, RelayError } from "@relay/core";
import type { McpSelection } from "@relay/schema";
import type { AcceptedOutput, RunRecord } from "@relay/store";
import { resolveInside, type ScratchWorkspace } from "@relay/workspaces";
import { secretValues } from "./agent-support.js";
import { type ActiveRunState, type EngineContext, toRelayError } from "./context.js";
import type { PlanNode } from "./graph-plan.js";
import { assertAgentPromptSize, composeAgentPrompt } from "./prompt.js";
import { ProcessGroupAliveError, StopSignal } from "./stop.js";
import { openTranscript, type TranscriptWriter } from "./transcript.js";

const NO_SUBMIT_PROMPT =
  "You ended your turn without calling submit_result. Call it now with your final result.";

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

const MCP_SCOPES = new Set(["global", "project", "connector"]);

/** Names-only selection from the normalized node; absent or malformed reads as empty. */
function readMcpSelection(node: PlanNode): McpSelection[] {
  const raw = (node.raw as { mcpServers?: unknown }).mcpServers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): McpSelection[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { name, scope } = entry as { name?: unknown; scope?: unknown };
    if (typeof name !== "string" || typeof scope !== "string") return [];
    if (!MCP_SCOPES.has(scope)) return [];
    return [{ name, scope: scope as McpSelection["scope"] }];
  });
}

/**
 * Exact shell toggle from the node. Absent keeps the legacy rule (shell
 * follows `write`); adapters decide what that means.
 */
function readShellPermission(node: PlanNode): boolean | undefined {
  const permissions = node.raw.permissions;
  if (typeof permissions !== "object" || permissions === null) return undefined;
  const shell = (permissions as { shell?: unknown }).shell;
  return typeof shell === "boolean" ? shell : undefined;
}

function mcpLabel(selection: readonly McpSelection[]): string {
  return selection.map((item) => `${item.scope}:${item.name}`).join(", ");
}

function mcpNames(selection: readonly McpSelection[]): Array<{ name: string; scope: string }> {
  return selection.map((item) => ({ name: item.name, scope: item.scope }));
}

interface AttachedMcp {
  extraMcp?: ResolvedMcpServer[];
  knownMcp?: NonNullable<RunRequest["knownMcp"]>;
}

/**
 * Resolve the node's MCP selection right before launch, on every attempt, so
 * a resume re-resolves against the current CLI config. A non-empty selection
 * with no resolver, or a failing resolve, fails the node fast with a
 * names-only error (never a silent skip). An empty selection only fills
 * knownMcp so adapters can switch the rest off, and never fails the node:
 * listing is best-effort and its failure is ignored.
 */
async function resolveAgentMcp(
  ctx: EngineContext,
  run: RunRecord,
  node: PlanNode,
  selection: readonly McpSelection[],
): Promise<AttachedMcp> {
  const resolver = ctx.deps.mcpResolver;
  const cli = String((node.raw as { cli?: unknown }).cli ?? "");
  const projectDir = run.project.path;
  if (selection.length > 0) {
    if (resolver === undefined) {
      throw new RelayError(
        "E_CLI_MISSING",
        `Agent '${node.id}' selects MCP server(s) ${mcpLabel(selection)} but no MCP resolver is configured; cannot start the run.`,
        { details: { nodeId: node.id, cli, servers: mcpNames(selection) } },
      );
    }
    const resolved = await resolver.resolve(cli, projectDir, selection);
    if (!resolved.ok) {
      // The resolver message is secret-free by contract; details are rebuilt
      // names-only so nothing past names can leak into events.
      throw new RelayError(
        resolved.error.code,
        `Agent '${node.id}' cannot use MCP server(s) ${mcpLabel(selection)}: ${resolved.error.message}`,
        { details: { nodeId: node.id, cli, servers: mcpNames(selection) } },
      );
    }
    return { extraMcp: resolved.value.extra, knownMcp: resolved.value.known };
  }
  if (resolver === undefined) return {};
  try {
    const listed = await resolver.list(cli, projectDir);
    return {
      knownMcp: listed.servers.map((server) => ({
        name: server.name,
        scope: server.scope,
        ...(server.connectorId === undefined ? {} : { connectorId: server.connectorId }),
      })),
    };
  } catch {
    return {};
  }
}

/** Mutable retry-loop state shared across attempts of one agent node. */
export interface AttemptLoop {
  workspace: ScratchWorkspace;
  identity: ExecutionIdentity;
  mode: "fresh" | "resume";
  sessionId: string | undefined;
  sessionCwd: string | undefined;
  noSubmitAttempts: number;
  cumulativeIn: number;
  cumulativeOut: number;
  cumulativeCost: number;
}

/** Per-node values fixed for the whole attempt sequence. */
export interface AttemptPrepared {
  adapter: ReturnType<AdapterRegistry["get"]>;
  basePrompt: string;
  contract: string;
  inputContext: string;
  scope: unknown;
  schemaHash: string;
  baseEnv: Record<string, string>;
}

export interface SingleAttemptResult {
  identity: ExecutionIdentity;
  accepted: AcceptedOutput | null;
  failure: FailureClass;
  cancelled: boolean;
  reason: "exited" | "killed" | "grace_timeout" | "crash";
  exit: {
    code: number | null;
    signal: string | null;
    tail: { stdout: string; stderr: string };
  };
  redact: (text: string) => string;
  /**
   * Idempotent attempt cleanup (grace timer, transcript, token revocation).
   * The retry loop re-runs it when outcome classification itself throws,
   * mirroring the previous single-catch structure.
   */
  cleanup: () => void;
}

/**
 * Run one agent attempt: workspace sync, prompt, gateway token, exec dir,
 * transcript, adapter invocation with usage/session event handling, stop
 * evidence and token revocation. Throws terminal transport failures
 * (process-group fencing, cancellation, plan/run errors); classification of
 * the attempt outcome is left to decideAttemptOutcome.
 */
export async function runSingleAttempt(
  ctx: EngineContext,
  run: RunRecord,
  node: PlanNode,
  active: ActiveRunState,
  prepared: AttemptPrepared,
  loop: AttemptLoop,
  validationLimit: number,
): Promise<SingleAttemptResult> {
  const { adapter } = prepared;
  if (loop.workspace.generation !== loop.identity.generation) {
    const next = await ctx.acquire(
      run,
      node.id,
      loop.identity.attempt,
      loop.identity.generation,
      active.abort.signal,
    );
    ctx.release(loop.workspace);
    ctx.appendWorkspaceCreated(loop.identity, next);
    loop.workspace = next;
  }
  const workspace = loop.workspace;
  const identity = loop.identity;
  const timeoutMs = Math.min(
    Math.max(1, Number((node.raw.limits as Record<string, unknown>)?.timeoutMin ?? 30) * 60_000),
    Math.max(1, ctx.deps.maxNodeTimeoutMs ?? Number.MAX_SAFE_INTEGER),
  );
  const prompt =
    loop.mode === "resume" && loop.noSubmitAttempts > 0
      ? composeAgentPrompt(NO_SUBMIT_PROMPT, prepared.contract, prepared.inputContext)
      : prepared.basePrompt;
  assertAgentPromptSize(prompt);
  const selection = readMcpSelection(node);
  const shell = readShellPermission(node);
  const attached = await resolveAgentMcp(ctx, run, node, selection);
  const tools = { shell: shell ?? null, servers: mcpNames(selection) };
  const inputs = { prompt, scope: prepared.scope, tools };
  const inputsHash = await hashJson(inputs);
  ctx.appendInputResolved(identity, inputsHash, inputs);
  const issued = ctx.deps.gateway.issue({
    identity,
    outputSchema: node.raw.output as Record<string, unknown>,
    outputSchemaHash: prepared.schemaHash,
    validationLimit,
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
  let lastSession = loop.sessionId;

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
            loop.sessionId = event.sessionId;
            loop.sessionCwd = workspace.dir;
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
          const deltaIn = event.cumulative ? Math.max(0, tokensIn - loop.cumulativeIn) : tokensIn;
          const deltaOut = event.cumulative
            ? Math.max(0, tokensOut - loop.cumulativeOut)
            : tokensOut;
          const deltaCost = event.cumulative ? Math.max(0, cost - loop.cumulativeCost) : cost;
          loop.cumulativeIn = Math.max(loop.cumulativeIn, tokensIn);
          loop.cumulativeOut = Math.max(loop.cumulativeOut, tokensOut);
          loop.cumulativeCost = Math.max(loop.cumulativeCost, cost);
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

  const cleanup = (): void => {
    if (finishTimer !== undefined) clearTimeout(finishTimer);
    transcript.close();
    revoke();
    active.tokens.delete(revoke);
  };

  try {
    const fakeCheckpoint =
      adapter.id !== "fake"
        ? undefined
        : stableFake
          ? join(execDir, "fake-checkpoint.json")
          : join(workspace.dir, ".relay/fake-checkpoint.json");
    const effectiveMode =
      adapter.id === "fake" && loop.mode === "resume" && !existsSync(fakeCheckpoint as string)
        ? "fresh"
        : loop.mode;
    const baseEnv = prepared.baseEnv;
    const request = {
      mode: effectiveMode,
      ...(effectiveMode === "resume" && loop.sessionId !== undefined
        ? { sessionId: loop.sessionId }
        : {}),
      prompt,
      cwd: workspace.dir,
      ...(node.raw.model === undefined ? {} : { model: node.raw.model as string }),
      permissions: {
        network: (node.raw.permissions as Record<string, unknown>).network === true,
        write: (((node.raw.permissions as Record<string, unknown>).write as string[]) ?? []) as (
          | "workspace"
          | "project"
        )[],
        ...(shell === undefined ? {} : { shell }),
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
      env: baseEnv,
      ...(attached.extraMcp === undefined ? {} : { extraMcp: attached.extraMcp }),
      ...(attached.knownMcp === undefined ? {} : { knownMcp: attached.knownMcp }),
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

    return {
      identity,
      accepted,
      failure,
      cancelled,
      reason,
      exit: { code: exit.code, signal: exit.signal, tail: exit.tail },
      redact: hooks.redact,
      cleanup,
    };
  } catch (error) {
    cleanup();
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
