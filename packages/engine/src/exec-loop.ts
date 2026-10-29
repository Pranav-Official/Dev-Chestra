import {
  canonicalJson,
  DevChestraError,
  type ExecutionIdentity,
  isRecord,
  type JsonObject,
  type JsonValue,
  type Path,
  type RoutingView,
} from "@devchestra/core";
import { LOOP_STATE_MAX_BYTES } from "@devchestra/schema";
import type { RunRecord } from "@devchestra/store";
import { type ActiveRunState, type EngineContext, toDevChestraError } from "./context.js";
import { skipNode } from "./exec-routing.js";
import { analyzeWorkflowPlan, type PlanNode, type WorkflowPlan } from "./graph-plan.js";
import { derivePlanRouting } from "./graph-run.js";
import { buildScopeData } from "./scope.js";
import { instantiateBody } from "./scoped-plan.js";
import { StopSignal } from "./stop.js";

type Dispatch = (plan: WorkflowPlan, node: PlanNode, routing: RoutingView) => Promise<void>;

function jsonValue(value: unknown, label: string): JsonValue {
  // The expression evaluator returns JSON data. Serialize to bound durable state
  // and detach it from caller-owned objects before handing it to the store.
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch (cause) {
    throw new DevChestraError("E_OUTPUT_INVALID", `${label} must contain JSON values`, { cause });
  }
  if (Buffer.byteLength(serialized) > LOOP_STATE_MAX_BYTES) {
    throw new DevChestraError("E_OUTPUT_INVALID", `${label} exceeds the 16 KiB JSON limit`);
  }
  return JSON.parse(serialized) as JsonValue;
}

function stateObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value))
    throw new DevChestraError("E_OUTPUT_INVALID", `${label} must be a JSON object`);
  return jsonValue(value, label) as JsonObject;
}

function checkStop(active: ActiveRunState): void {
  if (active.abort.signal.aborted) throw new StopSignal(active.reason ?? "user");
}

function canDrive(ctx: EngineContext, run: RunRecord, active: ActiveRunState): boolean {
  const current = ctx.run(run.id);
  return (
    current.status === "running" ||
    (current.status === "paused" &&
      current.pauseReason === "uncertain_side_effect" &&
      active.overrideApprovedBy !== undefined)
  );
}

/** Drive one durable controller until it completes or its child graph parks. */
export async function executeLoop(
  ctx: EngineContext,
  run: RunRecord,
  parentPlan: WorkflowPlan,
  node: PlanNode,
  active: ActiveRunState,
  dispatch: Dispatch,
): Promise<void> {
  checkStop(active);
  const path = node.id as Path;
  const execution =
    ctx.store.executions.get(run.id, path) ??
    ctx.store.executions.ensure({
      runId: run.id,
      path,
      nodeId: String(node.raw.id),
      kind: "loop",
      requireSubmission: false,
    });
  if (execution.status === "succeeded") return;
  let identity: ExecutionIdentity = {
    runId: run.id,
    path,
    attempt: execution.attempt,
    generation: execution.generation,
  };
  if (execution.status !== "running") {
    const resolvedConfigHash = await ctx.configHash(node);
    checkStop(active);
    identity = ctx.store.executions.beginInvocation({
      runId: run.id,
      path,
      attempt: execution.attempt,
      mode: "fresh",
      resolvedConfigHash,
    });
  }
  try {
    if (run.workspace === null) {
      throw new DevChestraError(
        "E_WORKSPACE",
        "Loops require a prepared run workspace shared by all rounds",
      );
    }
    const body = analyzeWorkflowPlan({
      schemaVersion: 1,
      id: "loop-body",
      name: "Loop body",
      graph: node.raw.body,
    });
    if (!body.ok) throw body.error;
    let controller = ctx.store.view.get(run.id).executions[path]?.loop;
    if (!controller) {
      const ancestors = await ctx.chainOutputs(run, parentPlan, node.id);
      const parent = stateObject(buildScopeData(run.params, ancestors), "Loop parent inputs");
      const state = stateObject(
        await ctx.evaluate(String(node.raw.initialState ?? "{}"), parent),
        "Initial loop state",
      );
      checkStop(active);
      ctx.store.loops.start({ identity, parent, state });
    }
    for (;;) {
      checkStop(active);
      if (!canDrive(ctx, run, active)) return;
      controller = ctx.store.view.get(run.id).executions[path]?.loop;
      if (!controller) throw new DevChestraError("E_INTERNAL", "Loop controller state is missing");
      const last = controller.rounds.at(-1);
      if (last?.done) {
        ctx.store.tx(() => {
          ctx.store.outputs.recordDeterministic({
            identity,
            output: { result: last.result, iterations: last.iteration },
          });
          ctx.store.executions.complete({ identity });
        });
        return;
      }
      const maxIterations = Number(node.raw.maxIterations);
      if (
        controller.iteration > maxIterations ||
        (last && !last.done && last.iteration >= maxIterations)
      ) {
        throw new DevChestraError(
          "E_LOOP_LIMIT",
          `Loop '${node.id}' did not satisfy its condition within ${maxIterations} rounds`,
        );
      }
      const loop = {
        iteration: controller.iteration,
        maxIterations,
        state: controller.state,
        parent: controller.parent,
      };
      const plan = instantiateBody(body.value, node.id, controller.iteration, { loop });
      const completed = await driveBody(ctx, run, plan, active, dispatch);
      if (!completed) return;
      const end = plan.ends[0];
      if (!end) throw new DevChestraError("E_INTERNAL", "Loop body has no result boundary");
      const ancestors = await ctx.chainOutputs(run, plan, end.id);
      const scope = buildScopeData({}, ancestors);
      const result = jsonValue(await ctx.evaluate(String(node.raw.result), scope), "Loop result");
      const validate = ctx.deps.validateOutput;
      if (!validate)
        throw new DevChestraError("E_WORKFLOW_INVALID", "Loops require an output validator");
      const validation = validate(node.raw.output as Record<string, unknown>, result);
      if (!validation.ok)
        throw new DevChestraError(
          "E_OUTPUT_INVALID",
          `Loop '${node.id}' result does not match its schema`,
          { details: { issues: validation.issues } },
        );
      const decisionScope = { ...scope, result };
      const done = await ctx.evaluate(String(node.raw.until), decisionScope);
      if (typeof done !== "boolean")
        throw new DevChestraError("E_EXPR", "Loop stop condition must evaluate to a boolean");
      const nextState =
        !done && controller.iteration < maxIterations
          ? stateObject(
              await ctx.evaluate(String(node.raw.nextState ?? "loop.state"), decisionScope),
              "Next loop state",
            )
          : undefined;
      checkStop(active);
      ctx.store.loops.decide({
        identity,
        iteration: controller.iteration,
        result,
        done,
        ...(nextState === undefined ? {} : { nextState }),
      });
    }
  } catch (error) {
    if (error instanceof StopSignal) {
      const status = ctx.currentStatus(identity);
      if (status === "running")
        ctx.transition(
          identity,
          error.kind === "shutdown" ? "interrupted" : "cancelled",
          error.kind,
        );
      throw error;
    }
    ctx.failExecution(run, node, identity, toDevChestraError(error));
    throw error;
  }
}

async function driveBody(
  ctx: EngineContext,
  run: RunRecord,
  plan: WorkflowPlan,
  active: ActiveRunState,
  dispatch: Dispatch,
): Promise<boolean> {
  for (;;) {
    checkStop(active);
    if (!canDrive(ctx, run, active)) return false;
    const view = ctx.store.view.get(run.id);
    const executions = Object.fromEntries(
      plan.nodes.flatMap((node) => {
        const execution = view.executions[node.id];
        return execution ? [[node.id, execution]] : [];
      }),
    );
    const failed = Object.values(executions).find((item) =>
      ["failed", "rejected", "cancelled"].includes(item.status),
    );
    if (failed)
      throw new DevChestraError(
        failed.lastError?.code ?? "E_INTERNAL",
        failed.lastError?.message ?? `Loop child '${failed.path}' ${failed.status}`,
      );
    const routing = derivePlanRouting(plan, executions);
    if (routing.conflicts.length)
      throw new DevChestraError(
        "E_JOIN_CONFLICT",
        `Loop body join '${routing.conflicts[0]}' has multiple active alternatives`,
      );
    if (routing.skipped.length) {
      for (const node of plan.nodes)
        if (routing.skipped.includes(node.id)) skipNode(ctx, run, node);
      continue;
    }
    const ready = plan.nodes.filter((node) => routing.ready.includes(node.id));
    const next = ready.find((node) => node.type !== "end") ?? ready[0];
    if (next) {
      await dispatch(plan, next, routing);
      continue;
    }
    if (plan.nodes.some((node) => executions[node.id]?.status === "waiting_approval")) return false;
    if (
      plan.ends.every((node) => executions[node.id]?.status === "succeeded") &&
      plan.nodes.every((node) =>
        ["succeeded", "skipped"].includes(executions[node.id]?.status ?? "pending"),
      )
    )
      return true;
    throw new DevChestraError(
      "E_WORKFLOW_INVALID",
      "Loop body stalled before all active paths completed",
    );
  }
}
