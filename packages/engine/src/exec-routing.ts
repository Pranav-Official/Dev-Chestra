import type { NodeKind, Path } from "@relay/core";
import { RelayError } from "@relay/core";
import { evaluateGate, type GateBranch } from "@relay/schema";
import type { RunRecord } from "@relay/store";
import type { ActiveRunState, EngineContext } from "./context.js";
import { toRelayError } from "./context.js";
import type { PlanNode, WorkflowPlan } from "./graph-plan.js";
import { buildScopeData } from "./scope.js";
import { StopSignal } from "./stop.js";
import type { OutputValidation } from "./types.js";

export interface JoinRouting {
  readonly active: readonly string[];
  readonly skipped: readonly string[];
}

export function planNodeKind(node: PlanNode): NodeKind {
  return node.type;
}

/** Durably skip a node without ever acquiring a workspace or spawning a process. */
export function skipNode(ctx: EngineContext, run: RunRecord, node: PlanNode): void {
  ctx.store.tx(() => {
    const existing = ctx.store.executions.get(run.id, node.id as Path);
    const execution =
      existing ??
      ctx.store.executions.ensure({
        runId: run.id,
        path: node.id as Path,
        nodeId: node.id,
        kind: planNodeKind(node),
        requireSubmission: false,
      });
    if (execution.status === "skipped") return;
    if (execution.status !== "pending" && execution.status !== "ready") {
      throw new RelayError(
        "E_INTERNAL",
        `Cannot skip '${node.id}' from status ${execution.status}`,
        { details: { nodeId: node.id } },
      );
    }
    ctx.append(run.id, node.id, "node.state", "engine", {
      from: execution.status,
      to: "skipped",
      attempt: execution.attempt,
      generation: execution.generation,
      reason: "inactive_branch",
    });
  });
}

export async function executeGate(
  ctx: EngineContext,
  run: RunRecord,
  plan: WorkflowPlan,
  node: PlanNode,
  active: ActiveRunState,
): Promise<void> {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  const existing = ctx.store.executions.get(run.id, node.id as Path);
  const execution =
    existing ??
    ctx.store.executions.ensure({
      runId: run.id,
      path: node.id as Path,
      nodeId: node.id,
      kind: "gate",
      requireSubmission: false,
    });
  if (execution.status === "succeeded") return;
  const configHash = await ctx.configHash(node);
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  const identity = ctx.store.executions.beginInvocation({
    runId: run.id,
    path: node.id as Path,
    attempt: execution.attempt,
    mode: "fresh",
    resolvedConfigHash: configHash,
  });
  try {
    const ancestors = await ctx.chainOutputs(run, plan, node.id);
    const scope = buildScopeData(run.params, ancestors);
    const branches = (plan.gateBranches.get(node.id) ?? []) as readonly GateBranch[];
    const result = await evaluateGate({ branches }, scope, {
      executor: ctx.expressionExecutor(),
      timeoutMs: 250,
    });
    if (!result.ok) throw result.error;
    if (active.abort.signal.aborted) throw interrupt(ctx, identity, active);
    const decision = result.value;
    ctx.store.routing.recordGateDecision({
      identity,
      branch: decision.branch,
      evaluated: decision.evaluated,
    });
    if (decision.branch === null) {
      const error = decision.error;
      throw new RelayError(
        error?.code ?? "E_EXPR",
        error?.message ?? "Gate expression did not evaluate to a boolean",
      );
    }
  } catch (error) {
    if (error instanceof StopSignal) throw error;
    const relay = toRelayError(error);
    ctx.failExecution(run, node, identity, relay);
    throw relay;
  }
}

export async function executeJoin(
  ctx: EngineContext,
  run: RunRecord,
  plan: WorkflowPlan,
  node: PlanNode,
  active: ActiveRunState,
  routing: JoinRouting,
): Promise<void> {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  const existing = ctx.store.executions.get(run.id, node.id as Path);
  const execution =
    existing ??
    ctx.store.executions.ensure({
      runId: run.id,
      path: node.id as Path,
      nodeId: node.id,
      kind: "join",
      requireSubmission: false,
    });
  if (execution.status === "succeeded") return;
  const configHash = await ctx.configHash(node);
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
  const identity = ctx.store.executions.beginInvocation({
    runId: run.id,
    path: node.id as Path,
    attempt: execution.attempt,
    mode: "fresh",
    resolvedConfigHash: configHash,
  });
  try {
    const mode = node.raw.mode === "all" ? "all" : "first";
    if (mode === "first" && routing.active.length > 1) {
      throw new RelayError(
        "E_JOIN_CONFLICT",
        `Join '${node.id}' has ${routing.active.length} active inputs in mode 'first'`,
        { details: { nodeId: node.id, active: routing.active } },
      );
    }
    const output =
      mode === "first"
        ? ctx.ancestorValue(run, sourceForInput(plan, node.id, routing.active[0] ?? ""))
        : Object.fromEntries(
            (plan.joinInputs.get(node.id) ?? []).map((input) => [
              input,
              routing.active.includes(input)
                ? ctx.ancestorValue(run, sourceForInput(plan, node.id, input))
                : null,
            ]),
          );
    if (mode === "first" && output === null) {
      throw new RelayError("E_INTERNAL", `Join '${node.id}' active input has no output`);
    }
    validateJoinOutput(ctx, node, mode, output);
    if (active.abort.signal.aborted) throw interrupt(ctx, identity, active);
    ctx.store.routing.recordJoinResolution({
      identity,
      mode,
      active: [...routing.active],
      skipped: [...routing.skipped],
      output,
    });
  } catch (error) {
    if (error instanceof StopSignal) throw error;
    const relay = toRelayError(error);
    ctx.failExecution(run, node, identity, relay);
    throw relay;
  }
}

function interrupt(
  ctx: EngineContext,
  identity: import("@relay/core").ExecutionIdentity,
  active: ActiveRunState,
): StopSignal {
  const kind = active.reason ?? "user";
  const status = ctx.currentStatus(identity);
  if (status === "running" || status === "validating") {
    ctx.transition(identity, kind === "shutdown" ? "interrupted" : "cancelled", kind);
  }
  return new StopSignal(kind);
}

function sourceForInput(plan: WorkflowPlan, joinId: string, input: string): string {
  const edge = (plan.incoming.get(joinId) ?? []).find((entry) => entry.targetInput === input);
  if (edge === undefined) {
    throw new RelayError("E_INTERNAL", `Join '${joinId}' has no edge for input '${input}'`);
  }
  return edge.from;
}

function validateJoinOutput(
  ctx: EngineContext,
  node: PlanNode,
  mode: "first" | "all",
  output: unknown,
): void {
  const schema = node.raw.output;
  if (schema === undefined) return;
  const validate = ctx.deps.validateOutput;
  if (validate === undefined) {
    throw new RelayError(
      "E_WORKFLOW_INVALID",
      `Join '${node.id}' declares an output schema but no output validator is configured`,
      { details: { nodeId: node.id } },
    );
  }
  let result: OutputValidation;
  try {
    result = validate(schema as Record<string, unknown>, output);
  } catch (error) {
    throw new RelayError("E_OUTPUT_INVALID", `Join '${node.id}' output validation failed`, {
      details: { nodeId: node.id, mode, cause: String(error) },
    });
  }
  if (!result.ok) {
    throw new RelayError("E_OUTPUT_INVALID", `Join '${node.id}' output does not match its schema`, {
      details: { nodeId: node.id, mode, issues: result.issues },
    });
  }
}
