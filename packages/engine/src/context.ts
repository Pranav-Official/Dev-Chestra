import { buildChildEnv, type CliId } from "@relay/adapters";
import {
  type Clock,
  type EventDraft,
  type ExecutionIdentity,
  hashJson,
  isRecord,
  isRunWorkspaceBinding,
  type Path,
  RelayError,
  type Result,
  type RunId,
  type RunStatus,
  systemClock,
} from "@relay/core";
import {
  compileExpression,
  type ExpressionExecutor,
  evaluate,
  type NormalizedNode,
  type RenderedTemplate,
  renderTemplate,
} from "@relay/schema";
import { createNodeExpressionExecutor } from "@relay/schema/node";
import type { AcceptedOutput, ExecutionRow, RunRecord, Store } from "@relay/store";
import type { ScratchWorkspace } from "@relay/workspaces";
import type { PlanNode, ScopeSource, WorkflowPlan } from "./graph-plan.js";
import { stripUi } from "./hash-config.js";
import type { LinearChain } from "./sequence.js";
import type { EngineDeps } from "./types.js";

export interface ActiveRunState {
  readonly abort: AbortController;
  reason: "user" | "shutdown" | null;
  readonly tokens: Set<() => void>;
  overrideApprovedBy?: string;
}

/**
 * Resolve a node's workspace mode from the frozen run snapshot. Recovery and
 * accepted-output finalization use this too, so a missing or malformed
 * workspace fails closed instead of silently falling back to scratch.
 */
function workspaceModeFor(run: RunRecord, path: string): "scratch" | "worktree" {
  const snapshot = run.snapshot;
  const graph = isRecord(snapshot) ? snapshot.graph : undefined;
  const nodes = isRecord(graph) ? graph.nodes : undefined;
  const node = Array.isArray(nodes)
    ? nodes.find((candidate) => isRecord(candidate) && candidate.id === path)
    : undefined;
  const workspace = isRecord(node) ? node.workspace : undefined;
  if (!isRecord(workspace)) {
    throw new RelayError(
      "E_WORKFLOW_INVALID",
      `Run snapshot has no workspace for node '${path}'; refusing to default to scratch`,
      { details: { runId: run.id, path } },
    );
  }
  if (workspace.mode === "scratch" || workspace.mode === "worktree") return workspace.mode;
  throw new RelayError(
    "E_WORKFLOW_INVALID",
    `Run snapshot node '${path}' has unsupported workspace mode '${String(workspace.mode)}'`,
    { details: { runId: run.id, path, mode: workspace.mode } },
  );
}

export function toRelayError(
  error: unknown,
  code: "E_INTERNAL" | "E_WORKSPACE" = "E_INTERNAL",
): RelayError {
  if (error instanceof RelayError) return error;
  return new RelayError(code, error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

export function serializeError(error: RelayError): {
  code: RelayError["code"];
  message: string;
  details?: unknown;
} {
  return {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export class EngineContext {
  readonly deps: EngineDeps;
  readonly store: Store;
  readonly clock: Clock;
  readonly #executor = createNodeExpressionExecutor();

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.clock = deps.clock ?? systemClock;
  }

  now(): number {
    return this.clock.now();
  }

  expressionExecutor(): ExpressionExecutor {
    return this.#executor;
  }

  run(runId: string): RunRecord {
    const record = this.store.runs.get(runId as RunId);
    if (record === null) throw new RelayError("E_NOT_FOUND", `Run ${runId} does not exist`);
    return record;
  }

  execution(runId: string, path: string): ExecutionRow {
    const row = this.store.executions.get(runId as RunId, path as Path);
    if (row === null) throw new RelayError("E_NOT_FOUND", `Execution ${runId}/${path} is missing`);
    return row;
  }

  output(runId: string, path: string, attempt: number): AcceptedOutput | null {
    return this.store.outputs.get({ runId: runId as RunId, path: path as Path, attempt });
  }

  configHash(node: PlanNode): Promise<string> {
    return hashJson(stripUi(node.raw));
  }

  workflowHash(snapshot: unknown): Promise<string> {
    return hashJson(snapshot);
  }

  async evaluate(source: string, scope: Readonly<Record<string, unknown>>): Promise<unknown> {
    const compiled = compileExpression(source);
    if (!compiled.ok) throw compiled.error;
    const result = await evaluate(compiled.value, scope, { executor: this.#executor });
    if (!result.ok) throw result.error;
    return result.value;
  }

  async render(
    template: string,
    scope: Readonly<Record<string, unknown>>,
    shell = false,
  ): Promise<RenderedTemplate> {
    const result = await renderTemplate(template, scope, {
      executor: this.#executor,
      shell,
      ...(shell ? { timeoutMs: 2_000 } : {}),
    });
    if (!result.ok) throw result.error;
    return result.value;
  }

  /**
   * Scope data is true ancestors only. In a routing plan a skipped or never-run
   * ancestor resolves to null; a succeeded ancestor with no output is corrupt.
   */
  async chainOutputs(
    run: RunRecord,
    source: ScopeSource | LinearChain,
    nodeId: string,
  ): Promise<Array<{ nodeId: string; output: unknown }>> {
    const outputs: Array<{ nodeId: string; output: unknown }> = [];
    if ("ancestorsOf" in source) {
      for (const id of (source as WorkflowPlan).ancestorsOf(nodeId)) {
        outputs.push({ nodeId: id, output: this.ancestorValue(run, id) });
      }
      return outputs;
    }
    for (const node of (source as LinearChain).nodes) {
      if (node.id === nodeId) break;
      const execution = this.store.executions.get(run.id, node.id as Path);
      const attempt = execution?.attempt ?? 1;
      const output = this.output(run.id, node.id, attempt);
      if (output === null) {
        throw new RelayError(
          "E_INTERNAL",
          `Ancestor '${node.id}' has no output for attempt ${attempt}`,
          { details: { runId: run.id } },
        );
      }
      outputs.push({ nodeId: node.id, output: output.json });
    }
    return outputs;
  }

  ancestorValue(run: RunRecord, nodeId: string): unknown {
    const execution = this.store.executions.get(run.id, nodeId as Path);
    if (execution === null) {
      throw new RelayError("E_INTERNAL", `Ancestor '${nodeId}' has no execution row`, {
        details: { runId: run.id },
      });
    }
    if (execution.status === "skipped") return null;
    if (execution.status === "succeeded") {
      const output = this.output(run.id, nodeId, execution.attempt);
      if (output === null) {
        throw new RelayError(
          "E_INTERNAL",
          `Ancestor '${nodeId}' has no output for attempt ${execution.attempt}`,
          { details: { runId: run.id } },
        );
      }
      return output.json;
    }
    if (
      execution.status === "failed" ||
      execution.status === "rejected" ||
      execution.status === "cancelled"
    ) {
      return null;
    }
    throw new RelayError(
      "E_INTERNAL",
      `Ancestor '${nodeId}' is ${execution.status}; a ready node cannot use an unresolved ancestor`,
      { details: { runId: run.id, status: execution.status } },
    );
  }

  baseEnv(cli: CliId): Record<string, string> {
    return buildChildEnv(cli, {
      base: this.deps.env ?? process.env,
      extraNames: this.deps.extraEnvNames ?? [],
    });
  }

  async prepareRun(run: RunRecord, requireExisting: boolean, signal: AbortSignal): Promise<void> {
    const binding = run.workspace;
    if (binding === null) return;
    if (!isRunWorkspaceBinding(binding)) {
      throw new RelayError(
        "E_WORKFLOW_INVALID",
        `Run ${run.id} has a malformed workspace binding; refusing to execute`,
        { details: { runId: run.id } },
      );
    }
    const prepare = this.deps.workspaces.prepare;
    if (prepare === undefined) {
      throw new RelayError(
        "E_WORKSPACE",
        "Workspace port cannot prepare run-level workspaces; refusing to run",
        { details: { runId: run.id, step: "prepare_unsupported" } },
      );
    }
    const result = await prepare({
      dataDir: this.deps.dataDir,
      projectId: run.project.id,
      runId: run.id,
      projectRoot: binding.projectRoot,
      selection: binding.selection,
      ...(requireExisting ? { requireExisting: true } : {}),
      signal,
    });
    if (!result.ok) throw result.error;
  }

  async acquire(
    run: RunRecord,
    path: string,
    attempt: number,
    generation: number,
    signal: AbortSignal,
    requireExisting = false,
  ): Promise<ScratchWorkspace> {
    const binding = run.workspace;
    if (binding !== null && !isRunWorkspaceBinding(binding)) {
      throw new RelayError(
        "E_WORKFLOW_INVALID",
        `Run ${run.id} has a malformed workspace binding; refusing to execute`,
        { details: { runId: run.id } },
      );
    }
    if (binding !== null && this.deps.workspaces.prepare === undefined) {
      throw new RelayError(
        "E_WORKSPACE",
        "Workspace port cannot prepare run-level workspaces; refusing to acquire",
        { details: { runId: run.id, step: "prepare_unsupported" } },
      );
    }
    // Once the run binding is prepared, acquisition is reuse-only: a missing
    // binding must never be silently rebuilt during a resume.
    const reuseOnly = requireExisting || binding !== null;
    const result = await this.deps.workspaces.acquire({
      dataDir: this.deps.dataDir,
      projectId: run.project.id,
      runId: run.id,
      path,
      attempt,
      generation,
      ...(binding === null ? { mode: workspaceModeFor(run, path) } : { runWorkspace: binding }),
      ...(reuseOnly ? { requireExisting: true } : {}),
      projectRoot: binding === null ? run.project.path : binding.projectRoot,
      signal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  }

  appendWorkspaceCreated(identity: ExecutionIdentity, workspace: ScratchWorkspace): void {
    const baseSha = (workspace as { baseSha?: unknown }).baseSha;
    this.append(identity.runId, identity.path, "workspace.created", "engine", {
      attempt: identity.attempt,
      generation: identity.generation,
      mode: workspace.mode,
      dir: workspace.dir,
      ...(typeof baseSha === "string" ? { baseSha } : {}),
    });
  }

  async finalize(
    workspace: ScratchWorkspace,
    identity: ExecutionIdentity,
    outcome: "success" | "failed" | "cancelled",
    stop: {
      reason: "exited" | "killed" | "grace_timeout" | "crash";
      exitCode?: number | null;
    },
  ): Promise<{ dir: string; commitSha?: string }> {
    const result = await this.deps.workspaces.finalize(workspace, {
      outcome,
      process: {
        attempt: identity.attempt,
        generation: identity.generation,
        stopped: true,
        reason: stop.reason,
        ...(stop.exitCode === undefined ? {} : { exitCode: stop.exitCode }),
      },
    });
    if (!result.ok) throw result.error;
    this.store.executions.recordWorkspaceFinalized({
      identity,
      dir: result.value.dir,
    });
    return { dir: result.value.dir };
  }

  release(workspace: ScratchWorkspace): void {
    this.deps.workspaces.release(workspace);
  }

  recordStop(
    identity: ExecutionIdentity,
    reason: "exited" | "killed" | "grace_timeout" | "crash",
    exitCode?: number | null,
  ): void {
    this.store.executions.recordProcessStopped({
      identity,
      reason,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  }

  persistedStop(
    identity: ExecutionIdentity,
  ): { reason: "exited" | "killed" | "grace_timeout" | "crash"; exitCode: number | null } | null {
    const stopped = this.store.view.get(identity.runId).executions[identity.path]?.processStopped;
    if (stopped === null || stopped === undefined) return null;
    return { reason: stopped.reason, exitCode: stopped.exitCode };
  }

  append(
    runId: string,
    path: string,
    type: string,
    actor: "engine" | "user" | "scheduler" | "system",
    payload: unknown,
  ): void {
    this.store.events.append(runId as RunId, [
      {
        runId: runId as RunId,
        path: path as Path,
        type,
        actor,
        payload,
      } as EventDraft,
    ]);
  }

  currentStatus(identity: ExecutionIdentity): string {
    return this.execution(identity.runId, identity.path).status;
  }

  transition(
    identity: ExecutionIdentity,
    to: "succeeded" | "failed" | "cancelled" | "interrupted",
    reason?: string,
  ): void {
    const from = this.currentStatus(identity);
    this.append(identity.runId, identity.path, "node.state", "engine", {
      from,
      to,
      attempt: identity.attempt,
      generation: identity.generation,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  failExecution(
    run: RunRecord,
    node: PlanNode,
    identity: ExecutionIdentity,
    error: RelayError,
  ): void {
    this.appendError(run.id, node.id, error);
    try {
      this.transition(identity, "failed", error.message);
    } catch {
      // A terminal transition may already have happened; the run still fails below.
    }
  }

  appendError(runId: string, path: string, error: RelayError): void {
    this.append(runId, path, "error.logged", "engine", serializeError(error));
  }

  appendSession(
    identity: ExecutionIdentity,
    cli: string,
    sessionId: string,
    cwd: string,
    model?: string,
  ): void {
    this.append(identity.runId, identity.path, "node.session.captured", "engine", {
      attempt: identity.attempt,
      generation: identity.generation,
      cli,
      sessionId,
      cwd,
      ...(model === undefined ? {} : { model }),
    });
  }

  appendUsage(
    identity: ExecutionIdentity,
    usage: { tokensIn?: number; tokensOut?: number; costUsd?: number },
    costSource: "reported" | "estimated" | "none",
  ): void {
    this.append(identity.runId, identity.path, "node.usage", "engine", {
      attempt: identity.attempt,
      generation: identity.generation,
      ...(usage.tokensIn === undefined ? {} : { tokensIn: usage.tokensIn }),
      ...(usage.tokensOut === undefined ? {} : { tokensOut: usage.tokensOut }),
      ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      costSource,
    });
  }

  appendInputResolved(
    identity: ExecutionIdentity,
    inputsHash: string,
    inputs: Record<string, unknown>,
  ): void {
    const size = Buffer.byteLength(JSON.stringify(inputs), "utf8");
    this.append(identity.runId, identity.path, "node.input.resolved", "engine", {
      attempt: identity.attempt,
      generation: identity.generation,
      inputsHash,
      inputs: size <= 48 * 1024 ? inputs : { truncated: true, bytes: size },
    });
  }

  appendTranscriptRef(identity: ExecutionIdentity, file: string, bytes: number): void {
    this.append(identity.runId, identity.path, "node.transcript.ref", "engine", {
      attempt: identity.attempt,
      generation: identity.generation,
      file,
      bytes,
    });
  }

  completeRun(
    runId: string,
    status: "success" | "failed" | "rejected",
    endPath: string,
    result?: unknown,
    error?: RelayError,
  ): void {
    this.append(runId, endPath, "run.completed", "engine", {
      status,
      endPath,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error: serializeError(error) }),
    });
  }

  failRun(runId: string, error: RelayError): void {
    try {
      const run = this.run(runId);
      if (isTerminal(run.status as RunStatus)) return;
    } catch {
      return;
    }
    try {
      this.store.events.append(runId as RunId, [
        {
          runId: runId as RunId,
          path: "" as Path,
          type: "error.logged",
          actor: "engine",
          payload: serializeError(error),
        } as EventDraft,
        {
          runId: runId as RunId,
          path: "" as Path,
          type: "run.completed",
          actor: "engine",
          payload: { status: "failed", error: serializeError(error) },
        } as EventDraft,
      ]);
    } catch {
      // The run may already be terminal from a racing cancel.
    }
  }

  outcome(runId: string): import("./types.js").RunOutcome {
    const run = this.run(runId);
    const view = this.store.view.get(run.id);
    const lastError = view.errors.at(-1);
    return {
      runId: run.id,
      status: run.status as RunStatus,
      ...(run.result === null || run.result === undefined ? {} : { result: run.result }),
      ...(view.pauseReason === null ? {} : { pausedReason: view.pauseReason }),
      ...(lastError === undefined
        ? {}
        : { error: { code: lastError.code, message: lastError.message } }),
    };
  }
}

export function isTerminal(status: RunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "rejected" || status === "cancelled"
  );
}

export function unwrap<T>(result: Result<T, RelayError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export type { NormalizedNode };
