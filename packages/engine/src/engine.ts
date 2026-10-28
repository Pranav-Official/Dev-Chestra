import { type CliId, getProvider } from "@relay/adapters";
import type { EventEnvelope, RunId, RunStatus, RunView } from "@relay/core";
import {
  defaultRunWorkspaceSelection,
  err,
  hashJson,
  isRunWorkspaceSelection,
  ok,
  RelayError,
  type Result,
  type RoutingExecutionState,
  type RoutingView,
} from "@relay/core";
import { resolveParams } from "@relay/schema";
import type { CreateRunInput, CreateRunResult, RunRecord } from "@relay/store";
import {
  consumeStaleWakesForWaiting,
  consumeWakesForTerminal,
  hasWaitingApproval,
  isWaiting,
  reconcileApprovalWakes,
  reconcileApprovalWakesForRun,
} from "./approval-wake.js";
import { type ActiveRunState, EngineContext, isTerminal, toRelayError } from "./context.js";
import { executeAgent } from "./exec-agent.js";
import { executeApproval } from "./exec-approval.js";
import { executeDeterministic } from "./exec-deterministic.js";
import { executeGate, executeJoin, skipNode } from "./exec-routing.js";
import { executeShell } from "./exec-shell.js";
import { analyzeWorkflowPlan, type PlanNode, type WorkflowPlan } from "./graph-plan.js";
import { derivePlanRouting, joinRoutingFor } from "./graph-run.js";
import { recoverAll } from "./recovery.js";
import { validateRunOptions } from "./sequence.js";
import { StopSignal } from "./stop.js";
import type {
  Engine,
  EngineDeps,
  LaunchResult,
  ResumeOptions,
  RunOutcome,
  StartRunInput,
} from "./types.js";

interface ActiveEntry {
  readonly state: ActiveRunState;
  readonly done: Promise<RunOutcome>;
}

export class LinearEngine implements Engine {
  readonly #ctx: EngineContext;
  readonly #active = new Map<string, ActiveEntry>();
  #started = false;
  #stopping = false;
  #busUnsub: (() => void) | null = null;

  constructor(deps: EngineDeps) {
    this.#ctx = new EngineContext(deps);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#registerEnvSecrets();
    await recoverAll(this.#ctx);
    reconcileApprovalWakes(
      this.#ctx,
      this.#active,
      (id, opts, resume) => void this.#drive(id, opts as never, resume),
    );
    this.#busUnsub = this.#ctx.store.bus.subscribe((envelope: EventEnvelope) => {
      if (envelope.type !== "approval.resolved") return;
      const runId = envelope.runId as string;
      if (this.#stopping) return;
      const view = this.#ctx.store.view.get(envelope.runId);
      if (view.status !== "running") return;
      if (Object.values(view.executions).some((e) => e.status === "interrupted")) return;
      if (Object.values(view.executions).some((e) => e.status === "waiting_approval")) return;
      if (this.#active.has(runId)) {
        const entry = this.#active.get(runId);
        void entry?.done.finally(() =>
          reconcileApprovalWakesForRun(
            this.#ctx,
            this.#active,
            (id, opts, r) => void this.#drive(id, opts as never, r),
            runId,
          ),
        );
        return;
      }
      void this.#drive(runId, {}, true).catch(() => undefined);
    });
    this.#started = true;
  }

  async stop(options: { graceMs?: number } = {}): Promise<void> {
    this.#stopping = true;
    if (this.#busUnsub) {
      this.#busUnsub();
      this.#busUnsub = null;
    }
    const entries = [...this.#active.values()];
    for (const entry of entries) {
      entry.state.reason = "shutdown";
      for (const revoke of entry.state.tokens) revoke();
      entry.state.tokens.clear();
      entry.state.abort.abort("shutdown");
    }
    await Promise.all(entries.map((entry) => entry.done.catch(() => undefined)));
    void options;
  }

  async launch(input: StartRunInput): Promise<Result<LaunchResult, RelayError>> {
    try {
      if (!this.#started) await this.start();
      if (this.#stopping) {
        throw new RelayError("E_CONFLICT", "Engine is shutting down; no new run was created");
      }
      const planResult = analyzeWorkflowPlan(input.snapshot);
      if (!planResult.ok) return err(planResult.error);
      const plan = planResult.value;
      const options = validateRunOptions({
        snapshot: input.snapshot,
        budgets: input.budgets,
        baseSha: input.baseSha,
        kind: "run",
      });
      if (!options.ok) return err(options.error);
      const params = resolveParams({ params: plan.start.raw.params as never }, input.params ?? {});
      if (!params.ok) {
        return err(
          new RelayError("E_VALIDATION", "Run parameters are invalid", {
            details: { issues: params.errors },
          }),
        );
      }
      this.#assertAdapters(plan);
      const project = this.#ctx.store.projects.get(input.projectId);
      if (project === null) {
        throw new RelayError("E_NOT_FOUND", `Project ${input.projectId} does not exist`);
      }
      const selection = input.workspace ?? defaultRunWorkspaceSelection();
      if (!isRunWorkspaceSelection(selection)) {
        throw new RelayError("E_VALIDATION", "workspace selection is invalid");
      }
      const workflowHash = await hashJson(input.snapshot);
      const createInput: CreateRunInput = {
        projectId: input.projectId,
        workflowId: input.workflowId,
        workflowHash,
        snapshot: input.snapshot,
        snapshotRaw: input.snapshotRaw,
        params: params.value as never,
        ...(input.budgets === undefined ? {} : { budgets: input.budgets }),
        workspace: { selection, projectRoot: project.path },
        ...(input.idempotency === undefined ? {} : { idempotency: input.idempotency }),
      };
      const created: CreateRunResult = this.#ctx.store.runs.create(createInput);
      const duplicate = created.duplicate;
      const completion = duplicate
        ? this.#duplicateCompletion(created.runId)
        : this.#drive(created.runId, {}, false);
      return ok({ runId: created.runId, duplicate, completion });
    } catch (error) {
      return err(toRelayError(error));
    }
  }

  async launchResume(
    runId: string,
    options: ResumeOptions = {},
  ): Promise<Result<LaunchResult, RelayError>> {
    try {
      if (!this.#started) await this.start();
      if (this.#stopping) throw new RelayError("E_CONFLICT", "Engine is shutting down");
      const run = this.#ctx.run(runId);
      if (isTerminal(run.status as RunStatus)) {
        throw new RelayError("E_CONFLICT", `Run ${runId} is already ${run.status}`);
      }
      const active = this.#active.get(runId);
      if (active !== undefined) {
        if (active.state.reason === "shutdown") {
          throw new RelayError("E_CONFLICT", "Run is still shutting down");
        }
        return ok({ runId, duplicate: false, completion: active.done });
      }
      if (run.status === "paused") {
        if (run.pauseReason === "uncertain_side_effect") {
          if (options.allowUncertainSideEffectRetry !== true) {
            throw new RelayError(
              "E_CONFLICT",
              "This run is paused for an uncertain shell side effect; explicit approval is required",
            );
          }
          void options.approvedBy;
        } else if (run.pauseReason === "shutdown") {
          this.#ctx.append(runId, "", "run.resumed", "user", { reason: "shutdown" });
        } else {
          throw new RelayError(
            "E_CONFLICT",
            `Run is paused for ${run.pauseReason ?? "an unsupported reason"}; resolve it before resuming`,
          );
        }
      }
      return ok({ runId, duplicate: false, completion: this.#drive(runId, options, true) });
    } catch (error) {
      return err(toRelayError(error));
    }
  }

  async run(input: StartRunInput): Promise<Result<RunOutcome, RelayError>> {
    const launched = await this.launch(input);
    if (!launched.ok) return err(launched.error);
    return ok(await launched.value.completion);
  }

  async resume(
    runId: string,
    options: ResumeOptions = {},
  ): Promise<Result<RunOutcome, RelayError>> {
    const launched = await this.launchResume(runId, options);
    if (!launched.ok) return err(launched.error);
    return ok(await launched.value.completion);
  }

  async cancel(runId: string): Promise<Result<void, RelayError>> {
    try {
      const run = this.#ctx.run(runId);
      if (run.status === "cancelled") return ok(undefined);
      if (isTerminal(run.status as RunStatus)) {
        throw new RelayError("E_CONFLICT", `Run ${runId} is already ${run.status}`);
      }
      const active = this.#active.get(runId);
      if (active !== undefined) {
        active.state.reason = "user";
        for (const revoke of active.state.tokens) revoke();
        active.state.tokens.clear();
        active.state.abort.abort("user");
        await active.done;
        return ok(undefined);
      }
      this.#ctx.append(runId, "", "run.cancelled", "user", { by: "user" });
      return ok(undefined);
    } catch (error) {
      return err(toRelayError(error));
    }
  }

  subscribe(callback: (event: EventEnvelope) => void): () => void {
    return this.#ctx.store.bus.subscribe(callback);
  }

  view(runId: string): RunView {
    return this.#ctx.store.view.get(runId as RunId);
  }

  async getRun(runId: string): Promise<RunOutcome | null> {
    const record = this.#ctx.store.runs.get(runId as RunId);
    return record === null ? null : this.#ctx.outcome(runId);
  }

  #registerEnvSecrets(): void {
    const env = this.#ctx.deps.env ?? process.env;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value.length < 8) continue;
      if (/(API_KEY|AUTH_TOKEN|_TOKEN|SECRET)$/.test(key)) {
        this.#ctx.store.security.registerSecret(value, key);
      }
    }
  }

  #assertAdapters(plan: WorkflowPlan): void {
    for (const node of plan.nodes) {
      if (node.type !== "agent") continue;
      const cli = node.raw.cli as CliId;
      if (!this.#ctx.deps.adapters.has(cli as never)) {
        throw new RelayError("E_CLI_MISSING", `Adapter '${String(cli)}' is not available`, {
          details: { cli },
        });
      }
      const provider = getProvider(cli);
      if (provider.experimental) {
        const allowed = this.#ctx.deps.allowExperimentalClis ?? [];
        const adapter = this.#ctx.deps.adapters.get(cli as never);
        if (!allowed.includes(provider.id as "claude-code" | "codex" | "opencode" | "pi")) {
          throw new RelayError(
            "E_CLI_MISSING",
            `Adapter '${provider.id}' requires an explicit experimental opt-in only after a live contract check`,
            { details: { cli: provider.id, behaviorVerified: adapter.evidence.behaviorVerified } },
          );
        }
      }
    }
  }

  /**
   * A duplicate id never dispatches. If this process owns the original run,
   * share its completion; otherwise report the durable current outcome without
   * silently resuming a paused/queued run created by an earlier process.
   */
  #duplicateCompletion(runId: string): Promise<RunOutcome> {
    const active = this.#active.get(runId);
    return active !== undefined ? active.done : Promise.resolve(this.#ctx.outcome(runId));
  }

  #drive(runId: string, options: ResumeOptions = {}, resume = false): Promise<RunOutcome> {
    const existing = this.#active.get(runId);
    if (existing !== undefined) return existing.done;
    const state: ActiveRunState = { abort: new AbortController(), reason: null, tokens: new Set() };
    if (options.allowUncertainSideEffectRetry === true) {
      state.overrideApprovedBy = options.approvedBy ?? "user";
    }
    const done = this.#driveInner(runId, state, resume).then(
      (outcome) => outcome,
      (error: unknown) => {
        const run = this.#ctx.store.runs.get(runId as RunId);
        if (run && isTerminal(run.status as RunStatus)) return this.#ctx.outcome(runId);
        this.#ctx.failRun(runId, toRelayError(error));
        return this.#ctx.outcome(runId);
      },
    );
    const entry: ActiveEntry = { state, done };
    this.#active.set(runId, entry);
    return done.finally(() => {
      this.#active.delete(runId);
      if (!this.#stopping) {
        const wakes = this.#ctx.store.approvals.listOutstandingWakes(runId as RunId);
        if (wakes.length === 0) return;
        const view = this.#ctx.store.view.get(runId as RunId);
        if (view.status !== "running") return;
        if (Object.values(view.executions).some((e) => e.status === "interrupted")) return;
        if (Object.values(view.executions).some((e) => e.status === "waiting_approval")) return;
        const applicable = wakes.some(
          (w) =>
            view.executions[w.path]?.status === "succeeded" &&
            view.executions[w.path]?.approvalDecision?.decision !== undefined,
        );
        if (!applicable) return;
        void this.#drive(runId, {}, true).catch(() => undefined);
      }
    });
  }

  async #driveInner(runId: string, active: ActiveRunState, resume: boolean): Promise<RunOutcome> {
    const initial = this.#ctx.run(runId);
    if (initial.workspace !== null) {
      try {
        await this.#ctx.prepareRun(initial, resume, active.abort.signal);
      } catch (error) {
        const relay = toRelayError(error, "E_WORKSPACE");
        this.#ctx.appendError(runId, "", relay);
        this.#ctx.failRun(runId, relay);
        return this.#ctx.outcome(runId);
      }
    }
    const analyzed = analyzeWorkflowPlan(initial.snapshot);
    if (!analyzed.ok) {
      this.#ctx.failRun(runId, analyzed.error);
      return this.#ctx.outcome(runId);
    }
    const plan = analyzed.value;
    for (;;) {
      const run = this.#ctx.run(runId);
      const status = run.status as RunStatus;
      if (isTerminal(status)) {
        if (status === "succeeded" || status === "rejected")
          consumeWakesForTerminal(this.#ctx, runId);
        return this.#ctx.outcome(runId);
      }
      if (status === "waiting_approval") {
        const v = this.#ctx.store.view.get(runId as RunId);
        consumeStaleWakesForWaiting(this.#ctx, runId, v);
        return this.#ctx.outcome(runId);
      }
      if (status === "paused") {
        const view = this.#ctx.store.view.get(runId as RunId);
        const override =
          view.pauseReason === "uncertain_side_effect" && active.overrideApprovedBy !== undefined;
        if (!override) return this.#ctx.outcome(runId);
      }
      const view = this.#ctx.store.view.get(runId as RunId);
      if (Object.values(view.executions).some((e) => e.status === "waiting_approval")) {
        consumeStaleWakesForWaiting(this.#ctx, runId, view);
        return this.#ctx.outcome(runId);
      }
      const completedEnds = plan.ends.filter(
        (node) => view.executions[node.id]?.status === "succeeded",
      );
      if (completedEnds.length > 1) {
        this.#ctx.failRun(
          runId,
          new RelayError(
            "E_WORKFLOW_INVALID",
            "multiple active End nodes; converge or make exclusive",
          ),
        );
        continue;
      }
      if (completedEnds.length === 1) {
        const end = completedEnds[0] as PlanNode;
        const status =
          end.raw.status === "failed"
            ? "failed"
            : end.raw.status === "rejected"
              ? "rejected"
              : "success";
        this.#ctx.completeRun(runId, status, end.id, this.#ctx.ancestorValue(run, end.id));
        continue;
      }
      const routing = derivePlanRouting(plan, executionStates(plan, view.executions));
      if (routing.conflicts.length > 0) {
        const id = routing.conflicts[0] as string;
        this.#ctx.failRun(
          runId,
          new RelayError(
            "E_JOIN_CONFLICT",
            `Join '${id}' has multiple active inputs in mode 'first'`,
            {
              details: { nodeId: id },
            },
          ),
        );
        continue;
      }
      const failed = plan.nodes.find((node) => {
        const state = view.executions[node.id]?.status;
        return state === "failed" || state === "rejected" || state === "cancelled";
      });
      if (failed !== undefined) {
        const execution = view.executions[failed.id];
        const known = execution?.lastError;
        this.#ctx.failRun(
          runId,
          known
            ? new RelayError(known.code, known.message, { details: { nodeId: failed.id } })
            : new RelayError(
                "E_INTERNAL",
                `Node '${failed.id}' ended ${execution?.status ?? "failed"} without an error record`,
                { details: { nodeId: failed.id } },
              ),
        );
        continue;
      }
      if (routing.skipped.length > 0) {
        const ids = new Set(routing.skipped);
        for (const node of plan.nodes) {
          if (ids.has(node.id)) skipNode(this.#ctx, run, node);
        }
        continue;
      }
      const ready = plan.nodes.filter((node) => routing.ready.includes(node.id));
      const readyNonEnd = ready.filter((node) => node.type !== "end");
      if (readyNonEnd.length > 0) {
        const node = readyNonEnd[0] as PlanNode;
        try {
          await this.#execute(run, plan, node, active, routing);
        } catch (error) {
          if (error instanceof StopSignal) {
            if (error.kind === "user") this.#finishUserCancel(runId);
            else this.#finishShutdown(runId);
            return this.#ctx.outcome(runId);
          }
          const relay = toRelayError(error);
          if (ctxStatus(this.#ctx, runId) === "running") this.#ctx.failRun(runId, relay);
        }
        continue;
      }
      const readyEnds = ready.filter((node) => node.type === "end");
      if (readyEnds.length > 1) {
        this.#ctx.failRun(
          runId,
          new RelayError(
            "E_WORKFLOW_INVALID",
            "multiple active End nodes; converge or make exclusive",
            { details: { ends: readyEnds.map((node) => node.id) } },
          ),
        );
        continue;
      }
      if (readyEnds.length === 1) {
        try {
          await this.#execute(run, plan, readyEnds[0] as PlanNode, active, routing);
        } catch (error) {
          if (error instanceof StopSignal) {
            if (error.kind === "user") this.#finishUserCancel(runId);
            else this.#finishShutdown(runId);
            return this.#ctx.outcome(runId);
          }
          const relay = toRelayError(error);
          if (ctxStatus(this.#ctx, runId) === "running") this.#ctx.failRun(runId, relay);
        }
        continue;
      }
      if (hasWaitingApproval(plan, view.executions)) {
        // Durable park: release active slot, do not busy-poll. Wake is via
        // canonical store approval resolution or startup scan for
        // resolved-but-nonterminal runs (not via polling/bus post-commit).
        return this.#ctx.outcome(runId);
      }
      if (isWaiting(plan, view.executions)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      this.#ctx.failRun(
        runId,
        new RelayError("E_INTERNAL", "Routing stalled: no ready node and no active End node", {
          details: { ready: routing.ready, skipped: routing.skipped },
        }),
      );
    }
  }

  async #execute(
    run: RunRecord,
    plan: WorkflowPlan,
    node: PlanNode,
    active: ActiveRunState,
    routing: RoutingView,
  ): Promise<void> {
    if (node.type === "start" || node.type === "end") {
      await executeDeterministic(this.#ctx, run, plan, node, active);
      return;
    }
    if (node.type === "gate") {
      await executeGate(this.#ctx, run, plan, node, active);
      return;
    }
    if (node.type === "join") {
      await executeJoin(this.#ctx, run, plan, node, active, joinRoutingFor(plan, node.id, routing));
      return;
    }
    if (node.type === "approval") {
      await executeApproval(this.#ctx, run, plan, node, active);
      return;
    }
    if (node.type === "shell") {
      await executeShell(this.#ctx, run, plan, node, active);
      return;
    }
    await executeAgent(this.#ctx, run, plan, node, active);
  }

  #finishUserCancel(runId: string): void {
    const run = this.#ctx.run(runId);
    if (!isTerminal(run.status as RunStatus)) {
      this.#ctx.append(runId, "", "run.cancelled", "user", { by: "user" });
    }
  }

  #finishShutdown(runId: string): void {
    const run = this.#ctx.run(runId);
    if (isTerminal(run.status as RunStatus)) return;
    const view = this.#ctx.store.view.get(runId as RunId);
    const uncertain = Object.values(view.executions).some(
      (execution) => execution.kind === "shell" && execution.status === "interrupted",
    );
    if (view.status !== "paused") {
      this.#ctx.append(runId, "", "run.paused", "engine", {
        reason: uncertain ? "uncertain_side_effect" : "shutdown",
        ...(uncertain
          ? { path: "", detail: "Interrupted shell may have produced external effects" }
          : {}),
      });
    }
  }
}

function executionStates(
  plan: WorkflowPlan,
  executions: RunView["executions"],
): Record<string, RoutingExecutionState> {
  const out: Record<string, RoutingExecutionState> = {};
  for (const node of plan.nodes) {
    const execution = executions[node.id];
    if (execution === undefined) continue;
    const ad = execution.approvalDecision;
    out[node.id] = {
      status: execution.status,
      kind: execution.kind,
      gateDecision: execution.gateDecision,
      joinResolution: execution.joinResolution,
      approvalDecision: ad
        ? { decision: ad.decision, ...(ad.requestId ? { requestId: ad.requestId } : {}) }
        : null,
    };
  }
  return out;
}

function ctxStatus(ctx: EngineContext, runId: string): string {
  return ctx.run(runId).status;
}

export function createEngine(deps: EngineDeps): Engine {
  return new LinearEngine(deps);
}
