import { getProvider, isCliId, matchesProcess } from "@devchestra/adapters";
import type { EventEnvelope, RunId, RunStatus, RunView } from "@devchestra/core";
import {
  DevChestraError,
  defaultRunWorkspaceSelection,
  err,
  hashJson,
  isRunWorkspaceSelection,
  ok,
  type Result,
  type RoutingExecutionState,
  type RoutingView,
} from "@devchestra/core";
import { isProdCliId, resolveParams } from "@devchestra/schema";
import type { CreateRunInput, RunRecord } from "@devchestra/store";
import { cliDisabledError } from "./agent-preflight.js";
import {
  consumeStaleWakesForWaiting,
  consumeWakesForTerminal,
  hasWaitingApproval,
  isWaiting,
  reconcileApprovalWakes,
  reconcileApprovalWakesForRun,
} from "./approval-wake.js";
import { type ActiveRunState, EngineContext, isTerminal, toDevChestraError } from "./context.js";
import { executeAgent } from "./exec-agent.js";
import { executeApproval } from "./exec-approval.js";
import { executeDecision } from "./exec-decision.js";
import { executeDeterministic } from "./exec-deterministic.js";
import { executeLoop } from "./exec-loop.js";
import { executeGate, executeJoin, skipNode } from "./exec-routing.js";
import { executeShell } from "./exec-shell.js";
import { analyzeWorkflowPlan, type PlanNode, type WorkflowPlan } from "./graph-plan.js";
import { derivePlanRouting, joinRoutingFor } from "./graph-run.js";
import { assertLoopWorkspaceAvailable } from "./loop-workspace.js";
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

/** Fallback shutdown deadline when neither `stop({ graceMs })` nor `shutdownGraceMs` sets one. */
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

interface ActiveEntry {
  readonly state: ActiveRunState;
  readonly done: Promise<RunOutcome>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

/** A resume (approval or explicit) that is waiting for an execution slot. */
interface ReadyDrive {
  readonly runId: string;
  readonly options: ResumeOptions;
  readonly resume: boolean;
  readonly waiter: Deferred<RunOutcome>;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export class LinearEngine implements Engine {
  readonly #ctx: EngineContext;
  readonly #active = new Map<string, ActiveEntry>();
  #started = false;
  #stopping = false;
  #busUnsub: (() => void) | null = null;
  /** Root run ids holding an execution slot. A slot covers a top-level run and its child runs. */
  readonly #slots = new Set<string>();
  /** Active drives per slot root. The slot frees when the last of them settles. */
  readonly #slotDrives = new Map<string, number>();
  /** Resumes waiting for a slot, in arrival order. Queued new runs live in the store. */
  #ready: ReadyDrive[] = [];
  /** Completions for queued top-level runs, settled when their drive ends or they are cancelled. */
  readonly #queuedWaiters = new Map<string, Deferred<RunOutcome>>();

  constructor(deps: EngineDeps) {
    this.#ctx = new EngineContext(deps);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#registerEnvSecrets();
    await recoverAll(this.#ctx);
    reconcileApprovalWakes(this.#ctx, this.#active, (id, opts, resume) =>
      this.#requestDriveDetached(id, opts as ResumeOptions, resume),
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
            (id, opts, r) => this.#requestDriveDetached(id, opts as ResumeOptions, r),
            runId,
          ),
        );
        return;
      }
      this.#requestDriveDetached(runId, {}, true);
    });
    this.#started = true;
    this.#pump();
  }

  /** Re-runs queue scheduling, e.g. after the concurrency limit changes. */
  pumpQueue(): void {
    if (this.#started) this.#pump();
  }

  /**
   * Abort every active drive and wait for them to settle, at most `graceMs`.
   * The abort is delivered first so drives finish fast (StopSignal ->
   * paused/shutdown outcome); the race only bounds a drive that never
   * observes the abort (e.g. parked in a poll sleep). After the deadline
   * `stop` returns anyway and late drives settle in the background — their
   * `done` promises never reject, so nothing is left unobserved (TD-014).
   */
  async stop(options: { graceMs?: number } = {}): Promise<void> {
    this.#stopping = true;
    if (this.#busUnsub) {
      this.#busUnsub();
      this.#busUnsub = null;
    }
    // Queued runs stay queued in the store and start on the next engine. Their
    // callers get the current outcome now rather than waiting for a slot.
    const waiting = new Set([...this.#queuedWaiters.keys(), ...this.#ready.map((e) => e.runId)]);
    for (const runId of waiting) this.#settleQueued(runId);
    const entries = [...this.#active.values()];
    for (const entry of entries) {
      entry.state.reason = "shutdown";
      for (const revoke of entry.state.tokens) revoke();
      entry.state.tokens.clear();
      entry.state.abort.abort("shutdown");
    }
    if (entries.length === 0) return;
    const graceMs = Math.max(
      0,
      options.graceMs ?? this.#ctx.deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    );
    const settled = Promise.all(entries.map((entry) => entry.done.catch(() => undefined)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // A timed-out race leaves `settled` pending: keep observing it so a
    // late drive outcome never surfaces as an unhandled rejection.
    void settled.catch(() => undefined);
  }

  async launch(input: StartRunInput): Promise<Result<LaunchResult, DevChestraError>> {
    try {
      if (!this.#started) await this.start();
      if (this.#stopping) {
        throw new DevChestraError("E_CONFLICT", "Engine is shutting down; no new run was created");
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
          new DevChestraError("E_VALIDATION", "Run parameters are invalid", {
            details: { issues: params.errors },
          }),
        );
      }
      this.#assertAdapters(plan);
      // Freeze the transitive child workflow bundle BEFORE any side effect.
      // The scan is recursive: workflow refs inside loop/foreach bodies count.
      const { freezeWorkflowBundle } = await import("./freeze.js");
      const referencesWorkflow = (nodes: readonly PlanNode[]): boolean =>
        nodes.some((node) => {
          if (node.type === "workflow" || node.type === "foreach") return true;
          if (node.type === "loop") {
            const body = analyzeWorkflowPlan({ graph: node.raw.body });
            return body.ok && referencesWorkflow(body.value.nodes);
          }
          return false;
        });
      const needsBundle = referencesWorkflow(plan.nodes);
      let bundle: Record<string, unknown> = {};
      if (needsBundle || input.workflowDependencies !== undefined) {
        const frozen = await freezeWorkflowBundle({
          projectId: input.projectId,
          rootSnapshot: input.snapshot,
          rootWorkflowId: input.workflowId,
          ...(input.workflowDependencies === undefined
            ? {}
            : { dependencies: input.workflowDependencies }),
          ...(this.#ctx.deps.workflowResolver === undefined
            ? {}
            : { resolver: this.#ctx.deps.workflowResolver }),
        });
        bundle = frozen.bundle as Record<string, unknown>;
        this.#assertBundleAdapters(bundle);
      }
      const project = this.#ctx.store.projects.get(input.projectId);
      if (project === null) {
        throw new DevChestraError("E_NOT_FOUND", `Project ${input.projectId} does not exist`);
      }
      const selection = input.workspace ?? defaultRunWorkspaceSelection();
      if (!isRunWorkspaceSelection(selection)) {
        throw new DevChestraError("E_VALIDATION", "workspace selection is invalid");
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
      const created = this.#ctx.store.tx(() => {
        // A provider may have been turned off while the async freeze and hash steps above
        // ran. tx() is a synchronous BEGIN IMMEDIATE and provider-setting writes take the
        // same lock, so checking here makes a disable win over an overlapping launch (even
        // from another process) and nothing is persisted when it does.
        this.#assertAdapters(plan);
        this.#assertBundleAdapters(bundle);
        const delivery = input.delivery;
        if (delivery !== undefined && delivery.deliveryId !== undefined) {
          // Dedupe first: a retry of an accepted delivery returns its run even if the
          // trigger was disarmed afterwards. Disarm and claim share this transaction.
          const claim = this.#ctx.store.webhooks.claimDelivery({
            hookId: delivery.hookId,
            deliveryId: delivery.deliveryId,
            fingerprint: delivery.fingerprint,
          });
          if (claim.kind === "duplicate") return { runId: claim.runId, duplicate: true };
        }
        if (delivery !== undefined) {
          this.#ctx.store.webhooks.assertArmedRevision(delivery.hookId, delivery.armedRevision);
        }
        // Queued, not started: workspace ownership is checked when a slot is granted.
        const made = this.#ctx.store.runs.enqueue(createInput);
        if (!made.duplicate && Object.keys(bundle).length > 0) {
          void this.#ctx.store.workflowCalls.putBundle(made.runId, bundle, workflowHash);
        }
        if (delivery?.deliveryId !== undefined) {
          this.#ctx.store.webhooks.bindDelivery(delivery.hookId, delivery.deliveryId, made.runId);
        }
        return { runId: made.runId, duplicate: made.duplicate };
      });
      const completion = created.duplicate
        ? this.#duplicateCompletion(created.runId)
        : this.#awaitQueued(created.runId);
      if (!created.duplicate) this.#pump();
      return ok({ runId: created.runId, duplicate: created.duplicate, completion });
    } catch (error) {
      return err(toDevChestraError(error));
    }
  }

  async launchResume(
    runId: string,
    options: ResumeOptions = {},
  ): Promise<Result<LaunchResult, DevChestraError>> {
    try {
      if (!this.#started) await this.start();
      if (this.#stopping) throw new DevChestraError("E_CONFLICT", "Engine is shutting down");
      const run = this.#ctx.run(runId);
      if (isTerminal(run.status as RunStatus)) {
        throw new DevChestraError("E_CONFLICT", `Run ${runId} is already ${run.status}`);
      }
      if (options.uncertaintyFence !== undefined) {
        const view = this.#ctx.store.view.get(runId as RunId);
        const fence = options.uncertaintyFence;
        const execution = view.executions[fence.path];
        const interruptedShells = Object.values(view.executions).filter(
          (item) => item.kind === "shell" && item.status === "interrupted",
        );
        if (
          interruptedShells.length !== 1 ||
          view.status !== "paused" ||
          view.pauseReason !== "uncertain_side_effect" ||
          (view.pausePath !== fence.path && view.pausePath !== "" && view.pausePath !== null) ||
          view.lastEventId !== fence.eventId ||
          execution?.attempt !== fence.attempt ||
          execution.generation !== fence.generation ||
          execution.status !== "interrupted"
        ) {
          throw new DevChestraError(
            "E_CONFLICT",
            "The uncertain shell pause has changed; inspect the run again before retrying.",
          );
        }
      }
      const active = this.#active.get(runId);
      if (active !== undefined) {
        if (active.state.reason === "shutdown") {
          throw new DevChestraError("E_CONFLICT", "Run is still shutting down");
        }
        return ok({ runId, duplicate: false, completion: active.done });
      }
      if (run.status === "queued") {
        // Register the waiter before pumping: the pump may start this run immediately.
        const completion = this.#awaitQueued(runId);
        this.#pump();
        return ok({ runId, duplicate: false, completion });
      }
      if (run.status === "paused") {
        if (run.pauseReason === "uncertain_side_effect") {
          if (options.allowUncertainSideEffectRetry !== true) {
            throw new DevChestraError(
              "E_CONFLICT",
              "This run is paused for an uncertain shell side effect; explicit approval is required",
            );
          }
          void options.approvedBy;
        } else if (run.pauseReason === "shutdown") {
          this.#ctx.append(runId, "", "run.resumed", "user", { reason: "shutdown" });
        } else {
          throw new DevChestraError(
            "E_CONFLICT",
            `Run is paused for ${run.pauseReason ?? "an unsupported reason"}; resolve it before resuming`,
          );
        }
      }
      return ok({ runId, duplicate: false, completion: this.#requestDrive(runId, options, true) });
    } catch (error) {
      return err(toDevChestraError(error));
    }
  }

  async run(input: StartRunInput): Promise<Result<RunOutcome, DevChestraError>> {
    const launched = await this.launch(input);
    if (!launched.ok) return err(launched.error);
    return ok(await launched.value.completion);
  }

  async resume(
    runId: string,
    options: ResumeOptions = {},
  ): Promise<Result<RunOutcome, DevChestraError>> {
    const launched = await this.launchResume(runId, options);
    if (!launched.ok) return err(launched.error);
    return ok(await launched.value.completion);
  }

  async cancel(runId: string): Promise<Result<void, DevChestraError>> {
    try {
      const run = this.#ctx.run(runId);
      if (run.status === "cancelled") return ok(undefined);
      if (isTerminal(run.status as RunStatus)) {
        throw new DevChestraError("E_CONFLICT", `Run ${runId} is already ${run.status}`);
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
      // Parked cancel (no active drive: waiting_approval / durable park):
      // cascade to active descendants first (depth-first), then fan out
      // durable node.state -> cancelled per non-terminal execution.
      // Historical run.cancelled reducer semantics are preserved (no store
      // change); never invent processStopped/workspaceFinalized evidence.
      // A genuinely-alive process is never marked stopped/finalized: pause
      // with an error instead of reporting cancelled with no Stop remedy.
      const aliveBlocked: string[] = [];
      for (const child of this.#ctx.store.workflowCalls.listByParent(runId as RunId)) {
        const record = this.#ctx.store.runs.get(child.childRunId as RunId);
        if (!record || ["succeeded", "failed", "rejected", "cancelled"].includes(record.status)) {
          continue;
        }
        const cancelled = await this.cancel(child.childRunId);
        if (!cancelled.ok) {
          this.#ctx.appendError(
            runId,
            child.parentPath,
            new DevChestraError("E_WORKSPACE", "Parked cancel blocked by live child run", {
              details: { childRunId: child.childRunId },
            }),
          );
          aliveBlocked.push(child.parentPath);
        }
      }
      for (const execution of this.#ctx.store.executions.list(runId as RunId)) {
        if (
          execution.status === "succeeded" ||
          execution.status === "failed" ||
          execution.status === "skipped" ||
          execution.status === "rejected" ||
          execution.status === "cancelled"
        ) {
          continue;
        }
        const identity = {
          runId: runId as RunId,
          path: execution.path,
          attempt: execution.attempt,
          generation: execution.generation,
        };
        try {
          const process = this.#ctx.store.executions.getProcess(identity);
          if (
            process !== null &&
            process.pid !== null &&
            process.pidStart !== null &&
            process.binary !== null &&
            process.stoppedAt === null
          ) {
            let alive = false;
            try {
              alive = await matchesProcess({
                pid: process.pid,
                pidStart: process.pidStart,
                binary: process.binary,
              });
            } catch {
              // Unknown liveness fails closed: never fabricate stopped
              // evidence; pause for explicit repair instead of cancelled.
              this.#ctx.appendError(
                runId,
                execution.path,
                new DevChestraError(
                  "E_WORKSPACE",
                  "Cancel found a process with unknown liveness; explicit repair required",
                  { details: { path: execution.path, pid: process.pid } },
                ),
              );
              aliveBlocked.push(execution.path);
              continue;
            }
            if (alive) {
              this.#ctx.appendError(
                runId,
                execution.path,
                new DevChestraError("E_WORKSPACE", "Agent process group is still alive", {
                  details: { step: "group_still_alive", pid: process.pid },
                }),
              );
              aliveBlocked.push(execution.path);
              continue;
            }
          }
        } catch (error) {
          this.#ctx.appendError(runId, execution.path, toDevChestraError(error, "E_WORKSPACE"));
          aliveBlocked.push(execution.path);
          continue;
        }
        try {
          this.#ctx.transition(identity, "cancelled", "cancelled");
        } catch {
          // Terminal races / fencing: run.cancelled below still applies.
        }
      }
      if (aliveBlocked.length > 0) {
        if (this.#ctx.run(runId).status !== "paused") {
          this.#ctx.append(runId, "", "run.paused", "engine", {
            reason: "shutdown",
            detail: `Parked cancel blocked: ${aliveBlocked.length} process group(s) have unresolved liveness; recovery required`,
          });
        }
        return err(
          new DevChestraError("E_WORKSPACE", "Parked cancel blocked by live process group(s)", {
            details: { paths: aliveBlocked },
          }),
        );
      }
      this.#ctx.append(runId, "", "run.cancelled", "user", { by: "user" });
      this.#settleQueued(runId);
      // A parked cancel releases its workspace without a drive ending, so pump here.
      this.#pump();
      return ok(undefined);
    } catch (error) {
      return err(toDevChestraError(error));
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
    // Webhook signing secrets are recoverable by design, so they are redacted the same way.
    for (const secret of this.#ctx.store.webhooks.signingSecrets()) {
      this.#ctx.store.security.registerSecret(secret, "webhook_signing_secret");
    }
  }

  #assertAdapters(plan: WorkflowPlan): void {
    for (const node of plan.nodes) {
      if (node.type === "loop" || node.type === "foreach") {
        if (!this.#ctx.deps.validateOutput) {
          throw new DevChestraError(
            "E_WORKFLOW_INVALID",
            `${node.type === "loop" ? "Loops" : "Foreach nodes"} require an output validator`,
          );
        }
        const body = analyzeWorkflowPlan({ graph: node.raw.body });
        if (!body.ok) throw body.error;
        this.#assertAdapters(body.value);
      }
      // Workflow calls need no live resolver when the frozen bundle covers them:
      // the launch freeze step resolves uncovered ids and fails fast there.
      if (node.type !== "agent") continue;
      const cli: unknown = node.raw.cli;
      if (!isCliId(cli) || !this.#ctx.deps.adapters.has(cli)) {
        throw new DevChestraError("E_CLI_MISSING", `Adapter '${String(cli)}' is not available`, {
          details: { cli },
        });
      }
      if (this.#ctx.deps.isCliEnabled?.(cli) === false) throw cliDisabledError(cli);
      const provider = getProvider(cli);
      if (provider.experimental) {
        const allowed = this.#ctx.deps.allowExperimentalClis ?? [];
        const adapter = this.#ctx.deps.adapters.get(cli);
        if (!(isProdCliId(provider.id) && allowed.includes(provider.id))) {
          throw new DevChestraError(
            "E_CLI_MISSING",
            `Adapter '${provider.id}' requires an explicit experimental opt-in only after a live contract check`,
            { details: { cli: provider.id, behaviorVerified: adapter.evidence.behaviorVerified } },
          );
        }
      }
    }
  }

  /** True when either run is an ancestor of the other via durable child links. */
  #lineageRelated(a: string, b: string): boolean {
    const walkUp = (from: string, target: string): boolean => {
      let current: string | null = from;
      const seen = new Set<string>();
      while (current) {
        if (current === target) return true;
        if (seen.has(current)) return false;
        seen.add(current);
        const link = this.#ctx.store.workflowCalls.getParent(current);
        current = link ? (link.parentRunId as string) : null;
      }
      return false;
    };
    return walkUp(a, b) || walkUp(b, a);
  }

  #assertBundleAdapters(bundle: Record<string, unknown>): void {
    for (const snapshot of Object.values(bundle)) {
      const plan = analyzeWorkflowPlan(snapshot);
      if (!plan.ok) throw plan.error;
      this.#assertAdapters(plan.value);
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

  /**
   * Every top-level start or resume goes through here. The request joins `#ready`
   * behind any earlier waiters and `#pump` starts the oldest one that fits: a
   * lineage that already holds a slot, or any run while a slot is free. The
   * returned promise settles with the drive.
   */
  #requestDrive(runId: string, options: ResumeOptions = {}, resume = false): Promise<RunOutcome> {
    const active = this.#active.get(runId);
    if (active !== undefined) return active.done;
    const waiting = this.#ready.find((entry) => entry.runId === runId);
    if (waiting !== undefined) return waiting.waiter.promise;
    const waiter = deferred<RunOutcome>();
    this.#ready.push({ runId, options, resume, waiter });
    this.#pump();
    return waiter.promise;
  }

  #requestDriveDetached(runId: string, options: ResumeOptions = {}, resume = false): void {
    void this.#requestDrive(runId, options, resume).catch(() => undefined);
  }

  #dispatch(
    runId: string,
    options: ResumeOptions,
    resume: boolean,
    waiter?: Deferred<RunOutcome>,
  ): Promise<RunOutcome> {
    this.#slots.add(this.#rootOf(runId));
    const done = this.#drive(runId, options, resume);
    if (waiter !== undefined) void done.then(waiter.resolve);
    return done;
  }

  /** Starts ready resumes, then queued runs, while slots are free. */
  #pump(): void {
    if (this.#stopping) return;
    let progressed = true;
    while (progressed) {
      progressed = this.#dispatchReady() || this.#dispatchQueued();
    }
  }

  #dispatchReady(): boolean {
    const limit = this.#limit();
    const index = this.#ready.findIndex(
      (entry) => this.#slots.has(this.#rootOf(entry.runId)) || this.#slots.size < limit,
    );
    if (index < 0) return false;
    const [entry] = this.#ready.splice(index, 1);
    if (entry === undefined) return false;
    const active = this.#active.get(entry.runId);
    if (active !== undefined) void active.done.then(entry.waiter.resolve);
    else this.#dispatch(entry.runId, entry.options, entry.resume, entry.waiter);
    return true;
  }

  /**
   * Oldest queued top-level run that fits. Its workspace is checked here, not at
   * enqueue, so queued runs never fail each other with E_LOCKED while waiting.
   */
  #dispatchQueued(): boolean {
    if (this.#slots.size >= this.#limit()) return false;
    const started = this.#ctx.store.runs.listActive().filter((run) => run.status !== "queued");
    for (const run of this.#ctx.store.runs.listQueued()) {
      if (this.#active.has(run.id)) continue;
      try {
        // The check reads only the snapshot above, so a locked workspace opens no write
        // transaction. The run is re-checked inside the transaction before it starts.
        assertLoopWorkspaceAvailable(run, started, (a, b) => this.#lineageRelated(a, b));
        this.#ctx.store.tx(() => {
          assertLoopWorkspaceAvailable(run, started, (a, b) => this.#lineageRelated(a, b));
          this.#ctx.append(run.id, "", "run.started", "engine", {});
        });
      } catch (error) {
        // A workspace still owned by a parked or running lineage keeps the run queued.
        if (error instanceof DevChestraError && error.code === "E_LOCKED") continue;
        this.#ctx.failRun(run.id, toDevChestraError(error, "E_WORKSPACE"));
        this.#settleQueued(run.id);
        continue;
      }
      const waiter = this.#queuedWaiters.get(run.id);
      this.#queuedWaiters.delete(run.id);
      this.#dispatch(run.id, {}, false, waiter);
      return true;
    }
    return false;
  }

  #awaitQueued(runId: string): Promise<RunOutcome> {
    const existing = this.#queuedWaiters.get(runId);
    if (existing !== undefined) return existing.promise;
    const waiter = deferred<RunOutcome>();
    this.#queuedWaiters.set(runId, waiter);
    return waiter.promise;
  }

  /** Settles any completion waiting on this run with its current outcome. */
  #settleQueued(runId: string): void {
    const pending = this.#ready.find((entry) => entry.runId === runId);
    this.#ready = this.#ready.filter((entry) => entry.runId !== runId);
    const waiter = this.#queuedWaiters.get(runId) ?? pending?.waiter;
    this.#queuedWaiters.delete(runId);
    waiter?.resolve(this.#ctx.outcome(runId));
  }

  #limit(): number {
    return this.#ctx.store.executionSettings.get().maxConcurrentRuns;
  }

  /** The top-level ancestor of a run. Its slot covers the whole lineage. */
  #rootOf(runId: string): string {
    const seen = new Set<string>();
    let current = runId;
    for (;;) {
      const link = this.#ctx.store.workflowCalls.getParent(current);
      if (link === null || seen.has(current)) return current;
      seen.add(current);
      current = link.parentRunId as string;
    }
  }

  #releaseSlot(root: string): void {
    const remaining = (this.#slotDrives.get(root) ?? 1) - 1;
    if (remaining > 0) {
      this.#slotDrives.set(root, remaining);
      return;
    }
    this.#slotDrives.delete(root);
    this.#slots.delete(root);
  }

  #drive(runId: string, options: ResumeOptions = {}, resume = false): Promise<RunOutcome> {
    const existing = this.#active.get(runId);
    if (existing !== undefined) return existing.done;
    const root = this.#rootOf(runId);
    this.#slotDrives.set(root, (this.#slotDrives.get(root) ?? 0) + 1);
    this.#slots.add(root);
    const state: ActiveRunState = { abort: new AbortController(), reason: null, tokens: new Set() };
    if (options.allowUncertainSideEffectRetry === true) {
      state.overrideApprovedBy = options.approvedBy ?? "user";
    }
    const done = this.#driveInner(runId, state, resume).then(
      (outcome) => outcome,
      (error: unknown) => {
        const run = this.#ctx.store.runs.get(runId as RunId);
        if (run && isTerminal(run.status as RunStatus)) return this.#ctx.outcome(runId);
        this.#ctx.failRun(runId, toDevChestraError(error));
        return this.#ctx.outcome(runId);
      },
    );
    const entry: ActiveEntry = { state, done };
    this.#active.set(runId, entry);
    return done.finally(() => {
      this.#active.delete(runId);
      this.#releaseSlot(root);
      if (!this.#stopping) this.#wakeIfApplicable(runId);
      this.#pump();
    });
  }

  /** A parked run whose approval was resolved resumes through the scheduler. */
  #wakeIfApplicable(runId: string): void {
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
    this.#requestDriveDetached(runId, {}, true);
  }

  async #driveInner(runId: string, active: ActiveRunState, resume: boolean): Promise<RunOutcome> {
    const initial = this.#ctx.run(runId);
    if (initial.workspace !== null) {
      try {
        await this.#ctx.prepareRun(initial, resume, active.abort.signal);
      } catch (error) {
        const devchestra = toDevChestraError(error, "E_WORKSPACE");
        this.#ctx.appendError(runId, "", devchestra);
        this.#ctx.failRun(runId, devchestra);
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
          new DevChestraError(
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
          new DevChestraError(
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
            ? new DevChestraError(known.code, known.message, { details: { nodeId: failed.id } })
            : new DevChestraError(
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
      // A controller stays running while a body approval parks the drive.
      // Resume its state machine without changing the node's durable status.
      // Workflow controllers park event-driven on child activity (no busy loop).
      const ready = plan.nodes.filter(
        (node) =>
          routing.ready.includes(node.id) ||
          ((node.type === "loop" || node.type === "workflow" || node.type === "foreach") &&
            view.executions[node.id]?.status === "running"),
      );
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
          const devchestra = toDevChestraError(error);
          if (ctxStatus(this.#ctx, runId) === "running") this.#ctx.failRun(runId, devchestra);
        }
        continue;
      }
      const readyEnds = ready.filter((node) => node.type === "end");
      if (readyEnds.length > 1) {
        this.#ctx.failRun(
          runId,
          new DevChestraError(
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
          const devchestra = toDevChestraError(error);
          if (ctxStatus(this.#ctx, runId) === "running") this.#ctx.failRun(runId, devchestra);
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
        new DevChestraError("E_INTERNAL", "Routing stalled: no ready node and no active End node", {
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
    if (node.type === "loop") {
      await executeLoop(this.#ctx, run, plan, node, active, (body, child, routing) =>
        this.#execute(this.#ctx.run(run.id), body, child, active, routing),
      );
      return;
    }
    if (node.type === "workflow") {
      const { executeWorkflow } = await import("./exec-workflow.js");
      await executeWorkflow(this.#ctx, run, plan, node, active, {
        driveChild: (childRunId, opts) => this.#drive(childRunId, {}, opts?.fresh !== true),
        cancelChild: (childRunId) => this.cancel(childRunId).then(() => undefined),
      });
      return;
    }
    if (node.type === "foreach") {
      const { executeForeach } = await import("./exec-foreach.js");
      await executeForeach(this.#ctx, run, plan, node, active, (body, child, routing) =>
        this.#execute(this.#ctx.run(run.id), body, child, active, routing),
      );
      return;
    }
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
    if (node.type === "decision") {
      await executeDecision(this.#ctx, run, plan, node, active);
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
      approvalDecision: ad ? { decision: ad.decision, requestId: ad.requestId } : null,
      decision: execution.decision,
      loop: execution.loop,
      workflow: execution.workflow,
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
