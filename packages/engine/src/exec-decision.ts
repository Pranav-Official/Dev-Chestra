import type { DecisionOutput, ExecutionIdentity, Path } from "@relay/core";
import { RelayError } from "@relay/core";
import type { DecisionQuestion, DecisionRequest } from "@relay/decisions";
import { DECISION_PRESETS } from "@relay/decisions";
import {
  DECISION_UNCERTAIN_HANDLE,
  type DecisionMode,
  type DecisionProviderId,
  isDecisionProviderId,
  routeDecision,
} from "@relay/schema";
import type { RunRecord } from "@relay/store";
import { type ActiveRunState, type EngineContext, toRelayError } from "./context.js";
import type { PlanNode, WorkflowPlan } from "./graph-plan.js";
import { buildScopeData } from "./scope.js";
import { StopSignal } from "./stop.js";

interface DecisionConfig {
  provider: DecisionProviderId;
  model?: string;
  stateTemplate: string;
  instructions: string;
  mode: DecisionMode;
  onError: "fail" | "uncertain";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfig(node: PlanNode): DecisionConfig {
  const raw = node.raw;
  if (!isDecisionProviderId(raw.provider)) {
    throw new RelayError(
      "E_WORKFLOW_INVALID",
      `Decision '${node.id}' has an unknown provider ${JSON.stringify(raw.provider)}`,
      { details: { nodeId: node.id } },
    );
  }
  if (typeof raw.state !== "string" || raw.state === "") {
    throw new RelayError("E_WORKFLOW_INVALID", `Decision '${node.id}' has no state template`, {
      details: { nodeId: node.id },
    });
  }
  if (typeof raw.instructions !== "string" || raw.instructions === "") {
    throw new RelayError("E_WORKFLOW_INVALID", `Decision '${node.id}' has no instructions`, {
      details: { nodeId: node.id },
    });
  }
  const mode = raw.mode;
  if (
    !isRecord(mode) ||
    (mode.kind !== "boolean" && mode.kind !== "choice" && mode.kind !== "score")
  ) {
    throw new RelayError("E_WORKFLOW_INVALID", `Decision '${node.id}' has an unknown mode`, {
      details: { nodeId: node.id },
    });
  }
  const onError = raw.onError ?? "fail";
  if (onError !== "fail" && onError !== "uncertain") {
    throw new RelayError(
      "E_WORKFLOW_INVALID",
      `Decision '${node.id}' onError must be 'fail' or 'uncertain'`,
      { details: { nodeId: node.id } },
    );
  }
  return {
    provider: raw.provider,
    ...(typeof raw.model === "string" && raw.model !== "" ? { model: raw.model } : {}),
    stateTemplate: raw.state,
    instructions: raw.instructions,
    mode: mode as unknown as DecisionMode,
    onError,
  };
}

function questionFor(mode: DecisionMode, instructions: string): DecisionQuestion {
  if (mode.kind === "boolean") return { kind: "boolean", instructions };
  if (mode.kind === "choice") {
    return {
      kind: "choice",
      instructions,
      options: mode.options.map((option) => ({
        value: option.value,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    };
  }
  return {
    kind: "score",
    instructions,
    levels: mode.levels.map((level) => ({
      label: level.label,
      ...(level.description === undefined ? {} : { description: level.description }),
    })),
  };
}

function fallbackModel(config: DecisionConfig): string {
  return config.model ?? DECISION_PRESETS[config.provider].bodyModel;
}

function interrupt(
  ctx: EngineContext,
  identity: ExecutionIdentity,
  active: ActiveRunState,
): StopSignal {
  const kind = active.reason ?? "user";
  const status = ctx.currentStatus(identity);
  if (status === "running" || status === "validating") {
    ctx.transition(identity, kind === "shutdown" ? "interrupted" : "cancelled", kind);
  }
  return new StopSignal(kind);
}

/**
 * Whether the plan wires the `uncertain` handle. The outgoing edges are the
 * single source of which handles are wired; falling through silently would run
 * the wrong branch, like gate `branch: null`. Wiring is decided BEFORE
 * committing (F5), never after.
 */
function uncertainWired(plan: WorkflowPlan, node: PlanNode): boolean {
  return (plan.outgoing.get(node.id) ?? []).some(
    (edge) => edge.sourceBranch === DECISION_UNCERTAIN_HANDLE,
  );
}

function unwiredUncertainError(node: PlanNode): RelayError {
  return new RelayError(
    "E_WORKFLOW_INVALID",
    `Decision '${node.id}' routed to 'uncertain' but no edge leaves '${node.id}.uncertain'; wire an uncertain edge or narrow the mode thresholds`,
    { details: { nodeId: node.id, branch: DECISION_UNCERTAIN_HANDLE } },
  );
}

/**
 * Configuration errors (missing/malformed secrets, local validation) always
 * fail the node, even when `onError` is "uncertain": a misconfigured node
 * must fail loudly instead of silently routing uncertain (F7c). Only
 * provider/transport failures after the client's retries route uncertain.
 * The client reports missing secrets as E_PROVIDER with this prefix; local
 * limit violations surface as E_VALIDATION.
 */
function isDecisionConfigError(error: RelayError): boolean {
  if (error.code === "E_VALIDATION") return true;
  return (
    error.code === "E_PROVIDER" &&
    error.message.startsWith("Missing or invalid decision secret(s):")
  );
}

export async function executeDecision(
  ctx: EngineContext,
  run: RunRecord,
  plan: WorkflowPlan,
  node: PlanNode,
  active: ActiveRunState,
): Promise<void> {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  const config = readConfig(node);
  const existing = ctx.store.executions.get(run.id, node.id as Path);
  const execution =
    existing ??
    ctx.store.executions.ensure({
      runId: run.id,
      path: node.id as Path,
      nodeId: node.id,
      kind: "decision",
      requireSubmission: false,
    });
  if (execution.status === "succeeded") return;
  const configHash = await ctx.configHash(node);
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  // Read the persisted answer BEFORE beginInvocation: starting a new
  // generation resets the per-generation projection (decision: null), so a
  // later read would never see the answer a resume must reuse (F5).
  const prior = ctx.store.view.get(run.id).executions[node.id]?.decision;
  const identity = ctx.store.executions.beginInvocation({
    runId: run.id,
    path: node.id as Path,
    attempt: execution.attempt,
    mode: "fresh",
    resolvedConfigHash: configHash,
  });
  try {
    // Recovery: an already-persisted answer is reused without calling the
    // provider again (a resume never re-asks and pays again). The wiring
    // decision is re-derived and, when uncertain is unwired, the same clear
    // E_WORKFLOW_INVALID is reproduced with no provider call (F5).
    // `recordDecision` is idempotent for the same answer, so re-committing
    // also heals a crash between answer and completion.
    if (prior !== null && prior !== undefined) {
      const routing = routeDecision(config.mode, prior.output);
      if (routing.branch === null) {
        throw new RelayError(
          "E_WORKFLOW_INVALID",
          `Decision '${node.id}' has no routable branch for its stored answer`,
          { details: { nodeId: node.id } },
        );
      }
      if (routing.branch === DECISION_UNCERTAIN_HANDLE && !uncertainWired(plan, node)) {
        throw unwiredUncertainError(node);
      }
      ctx.store.routing.recordDecision({
        identity,
        provider: config.provider,
        model: prior.output.model,
        questionIds: ["q0"],
        output: prior.output,
        routing,
      });
      return;
    }

    const service = ctx.deps.decisions;
    if (service === undefined) {
      throw new RelayError(
        "E_PROVIDER",
        `Decision '${node.id}' needs provider '${config.provider}' but no decision service is configured; pass a DecisionService to the engine`,
        { details: { nodeId: node.id, provider: config.provider } },
      );
    }

    const ancestors = await ctx.chainOutputs(run, plan, node.id);
    const scope = buildScopeData(run.params, ancestors);
    const rendered = await ctx.render(config.stateTemplate, scope, false);
    const request: DecisionRequest = {
      provider: config.provider,
      ...(config.model === undefined ? {} : { model: config.model }),
      state: rendered.text,
      question: questionFor(config.mode, config.instructions),
    };

    if (active.abort.signal.aborted) throw interrupt(ctx, identity, active);
    const linked = new AbortController();
    const onAbort = (): void => {
      linked.abort(active.reason ?? "user");
    };
    active.abort.signal.addEventListener("abort", onAbort, { once: true });
    let response: { output: DecisionOutput; usage?: { inputTokens: number; outputTokens: number } };
    try {
      const result = await service.client(config.provider).ask(request, linked.signal);
      if (!result.ok) {
        if (active.abort.signal.aborted) throw interrupt(ctx, identity, active);
        throw result.error;
      }
      response = result.value;
    } finally {
      active.abort.signal.removeEventListener("abort", onAbort);
    }

    // The call returned, so persist the answer before handling the interrupt:
    // an abort that lands here interrupts the run but a resume reuses the
    // stored answer instead of asking (and paying) again (F7a).
    const routing = routeDecision(config.mode, response.output);
    if (routing.branch === null) {
      throw new RelayError(
        "E_WORKFLOW_INVALID",
        `Decision '${node.id}' has no routable branch for the provider answer`,
        { details: { nodeId: node.id } },
      );
    }
    // Unwired `uncertain` is decided BEFORE committing: persist the answer
    // with a failed routing (branch null, like a gate failure, keeping the
    // original reason) and fail with a clear error. A crash between the
    // commit and the throw resumes into the same error with no re-ask (F5).
    const unwiredUncertain =
      routing.branch === DECISION_UNCERTAIN_HANDLE && !uncertainWired(plan, node);
    ctx.store.routing.recordDecision({
      identity,
      provider: config.provider,
      model: response.output.model,
      questionIds: ["q0"],
      output: response.output,
      routing: unwiredUncertain ? { branch: null, reason: routing.reason } : routing,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    });
    if (unwiredUncertain) {
      const invalid = unwiredUncertainError(node);
      ctx.failExecution(run, node, identity, invalid);
      throw invalid;
    }
    if (active.abort.signal.aborted) throw interrupt(ctx, identity, active);
  } catch (error) {
    if (error instanceof StopSignal) throw error;
    // An abort that lands before the provider answered interrupts instead of
    // failing, exactly like the other executors. The provider call is
    // read-only, so a resume simply asks again.
    if (active.abort.signal.aborted) throw interrupt(ctx, identity, active);
    const relay = toRelayError(error);
    // A provider failure after the client's retries routes to `uncertain`
    // with a refusal-style output when the node opts into it. Configuration
    // errors always fail the node instead (F7c). The client already redacted
    // key material from the message, so it is safe to store.
    if (
      config.onError === "uncertain" &&
      (relay.code === "E_PROVIDER" || relay.code === "E_PROVIDER_REFUSED") &&
      !isDecisionConfigError(relay)
    ) {
      const output: DecisionOutput = {
        kind: config.mode.kind,
        value: null,
        confidence: null,
        confidenceSource: null,
        refusal: { reason: relay.message },
        model: fallbackModel(config),
      };
      try {
        // Same wiring-first rule as the answered path: an unwired uncertain
        // persists the error answer with a failed (branch null) routing and
        // fails with the clear error, so a resume never re-asks (F5).
        const unwired = !uncertainWired(plan, node);
        ctx.store.routing.recordDecision({
          identity,
          provider: config.provider,
          model: output.model,
          questionIds: ["q0"],
          output,
          routing: unwired
            ? { branch: null, reason: "error" }
            : { branch: DECISION_UNCERTAIN_HANDLE, reason: "error" },
        });
        if (unwired) {
          const invalid = unwiredUncertainError(node);
          ctx.failExecution(run, node, identity, invalid);
          throw invalid;
        }
        return;
      } catch (nested) {
        if (nested instanceof StopSignal) throw nested;
        const nestedRelay = toRelayError(nested);
        ctx.failExecution(run, node, identity, nestedRelay);
        throw nestedRelay;
      }
    }
    if (ctx.currentStatus(identity) === "running" || ctx.currentStatus(identity) === "validating") {
      ctx.failExecution(run, node, identity, relay);
    }
    throw relay;
  }
}
